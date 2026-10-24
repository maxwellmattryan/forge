// mergePr makes at most one merge call, through the GitHub adapter: the in-memory one here, so each
// row is in-process with its own repo and GitHub, and the rows run concurrently. Every row commits
// its PR head in the scenario's temp repo, since the gate recomputes everything from git.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addOrigin, ghPr, memoryGitHub, parkedAt, tempRepo } from '../../../test/helpers.ts';
import { CI_SETTLE_MS, deferredMergeDue, hasCiWorkflows, mergeAction, mergePr, mergeProvenance } from './merge.ts';
import type { MergeResult } from './merge.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { ackRequest, claimRequest, enqueue } from '#core/job/requests.ts';
import { loadJob, logEvent, readEvents, setJob, updateJob } from '#core/job/store.ts';
import { FOREMAN_ACTOR, currentActor } from '#integrations/github/actor.ts';

// defaults(): a non-empty policy.protectedPaths, merge.method squash and merge.auto off.
const config = defaults();
config.tracker.github.repo = 'o/r';
const auto = structuredClone(config);
auto.merge.auto = true;

/** Past the settling window after the scenario's pr-opened event. */
const SETTLED = () => Date.now() + 10 * 60_000;

const ROLLUP = {
  passing: [{ name: 'test', conclusion: 'SUCCESS' }],
  pending: [{ name: 'test', status: 'IN_PROGRESS' }],
  failing: [{ name: 'test', conclusion: 'FAILURE' }],
};

interface ScenarioOpts {
  /** Files committed on a branch off main; the PR head is that commit (else main's own HEAD). */
  files?: Record<string, string>;
  /** The decision event's fields over an eligible APPROVE at the head; null: no decision event. */
  decision?: Record<string, unknown> | null;
  /** A commit after the decided head: the PR's live head moves on, the decision stays. */
  commitAfter?: boolean;
  /**
   * The PR head is the decided head with a merge of main on top. `pushed`: main moved on at the remote
   * (the local remote-tracking ref stays stale); `forged`: a commit nobody pushed, behind a remote-tracking
   * ref moved to it. `at`: the merge commit's committer date.
   */
  merged?: { base: 'pushed' | 'forged'; at?: number };
  /** The push remote no longer answers: the base can't be re-read. */
  remoteGone?: boolean;
  /** The base branch GitHub says the PR targets (else main, the job's). */
  prBase?: string;
}

/** A single-repo job with PR #7 opened, a decision bound to its head, and GitHub's PR #7 at that head. */
function scenario(rollup: keyof typeof ROLLUP, mergeStateStatus = 'CLEAN', opts: ScenarioOpts = {}) {
  const repo = tempRepo();
  addOrigin(repo);
  const rev = (r: string) => repo.git('rev-parse', r).toString().trim();
  const commit = (files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, rel), text);
    }
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'work');
    return rev('HEAD');
  };
  const init = rev('main');
  repo.git('checkout', '-q', '-b', 'feat');
  const decided = commit(opts.files ?? { 'src.txt': 'work\n' });
  let head = opts.commitAfter ? commit({ 'later.txt': 'after the approval\n' }) : decided;
  if (opts.merged) {
    repo.git('checkout', '-q', '-b', 'other', 'main');
    commit({ 'other.txt': 'the base moved on\n' });
    if (opts.merged.base === 'pushed') repo.git('push', '-q', 'origin', 'other:main');
    // Whatever the push left, the clone's remote-tracking ref says the base is still where it was.
    repo.git('update-ref', 'refs/remotes/origin/main', opts.merged.base === 'pushed' ? init : rev('other'));
    repo.git('checkout', '-q', 'feat');
    const date = opts.merged.at === undefined ? undefined : new Date(opts.merged.at).toISOString();
    if (date) process.env.GIT_COMMITTER_DATE = date;
    try {
      repo.git('merge', '-q', '--no-ff', '--no-edit', 'other');
    } finally {
      delete process.env.GIT_COMMITTER_DATE;
    }
    head = rev('HEAD');
  }
  repo.git('checkout', '-q', 'main');
  if (opts.remoteGone) repo.git('remote', 'set-url', '--push', 'origin', path.join(repo.dir, 'no-such-remote.git'));
  const id = parkedAt(repo.dir, 'pr-review', { config, title: 'merge me', pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', pushedSha: head } }).id;
  logEvent(repo.dir, id, 'pr-opened', { number: 7 });
  if (opts.decision !== null) logEvent(repo.dir, id, 'decision', { decision: 'APPROVE', reason: null, autoMerge: true, head: decided, ...opts.decision });
  const github = memoryGitHub();
  github.put(ghPr({ headRefOid: head, statusCheckRollup: ROLLUP[rollup], mergeStateStatus, ...(opts.prBase ? { baseRefName: opts.prBase } : {}) }));
  return {
    root: repo.dir,
    id,
    head,
    rev,
    github,
    merges: () => github.calls.filter((c) => c.op === 'merge'),
    all: () => readEvents(repo.dir, id),
    events: () => readEvents(repo.dir, id).map((e) => e.type),
    cleanup: repo.cleanup,
  };
}

type Scenario = ReturnType<typeof scenario>;

/** A human approved the escalate hits on the flag: the PP1 park, then an approve after the flag's `at`. */
function approveProtected(s: Scenario, file: string): void {
  const blob = s.rev(`${s.head}:${file}`);
  const at = new Date(Date.now() - 60_000).toISOString();
  updateJob(s.root, s.id, (j) => {
    j.protectedPaths = { hits: [{ path: file, rule: 2, glob: 'Dockerfile*', reason: 'infrastructure', blob }], more: 0, at, gate: 'pr', head: s.head, digest: 'd' };
  });
  setJob(s.root, s.id, { state: 'waiting', waitingOn: 'human', reason: `protected paths: ${file}` });
  logEvent(s.root, s.id, 'human', { action: 'approve', actor: { login: 'al', source: 'env' } });
  setJob(s.root, s.id, { state: 'waiting', waitingOn: 'pr-review', reason: null });
}

/** The scenario with `more` arranged after it: events and job changes once the decision is logged. */
const after = (s: Scenario, more: (s: Scenario) => unknown): Scenario => {
  more(s);
  return s;
};

const refusedFor = (reason: string) => (s: Scenario, r: MergeResult | Error) => {
  assert.deepEqual(s.merges(), []);
  assert.ok(!(r instanceof Error), String(r));
  assert.deepEqual([r.action, r.reason], ['refused', reason], JSON.stringify(r));
  assert.ok(s.all().some((e) => e.type === 'pr-merge-refused' && e.reason === reason));
};

const ROWS: { name: string; arrange: () => Scenario; config?: typeof config; opts?: Parameters<typeof mergePr>[4]; check: (s: Scenario, r: MergeResult | Error) => void }[] = [
  {
    name: '(a) passing checks at a settled head: one merge call pinned to the live head',
    arrange: () => scenario('passing'),
    check: (s, r) => {
      assert.deepEqual(s.merges(), [{ op: 'merge', slug: 'o/r', number: 7, method: 'squash', auto: false, matchHead: s.head }]);
      assert.ok(!(r instanceof Error));
      assert.deepEqual([r.merged, r.action], [true, 'merged']);
      const merged = s.all().find((e) => e.type === 'pr-merged');
      assert.ok(merged, s.events().join(' '));
      assert.deepEqual([merged.actor, merged.bypass], [{ login: 'forge-test', source: 'env' }, false]);
      assert.ok(!('scope' in merged) && !('via' in merged), JSON.stringify(merged));
    },
  },
  {
    name: '(b) failing checks: no merge call, refused',
    arrange: () => scenario('failing'),
    check: (s, r) => {
      assert.deepEqual(s.merges(), []);
      assert.equal((r as MergeResult).action, 'refused');
    },
  },
  {
    name: '(c) pending checks on a BLOCKED PR: held by the protected-paths policy, no merge call',
    arrange: () => scenario('pending', 'BLOCKED'),
    check: (s, r) => {
      assert.deepEqual(s.merges(), []);
      assert.equal((r as MergeResult).action, 'deferred');
    },
  },
  {
    name: "(d) a merge GitHub refuses: one call, failed with GitHub's error",
    arrange: () => {
      const s = scenario('passing');
      s.github.fail('merge', 'auto-merge is not allowed');
      return s;
    },
    check: (s, r) => {
      assert.equal(s.merges().length, 1);
      assert.deepEqual([(r as MergeResult).action, (r as MergeResult).error], ['failed', 'auto-merge is not allowed']);
      assert.ok(s.events().includes('pr-merge-failed'));
    },
  },
  { name: 'auto-off: merge.auto off refuses an eligible, passing PR', arrange: () => scenario('passing'), config, check: refusedFor('auto-off') },
  { name: 'decision: no decision event', arrange: () => scenario('passing', 'CLEAN', { decision: null }), check: refusedFor('decision') },
  { name: 'decision: an ESCALATE marked auto-merge eligible', arrange: () => scenario('passing', 'CLEAN', { decision: { decision: 'ESCALATE' } }), check: refusedFor('decision') },
  { name: 'decision: an APPROVE not marked auto-merge eligible', arrange: () => scenario('passing', 'CLEAN', { decision: { autoMerge: false } }), check: refusedFor('decision') },
  {
    name: 'decision: the live head is a commit after the decided head',
    arrange: () => scenario('passing', 'CLEAN', { commitAfter: true }),
    check: (s, r) => {
      refusedFor('decision')(s, r);
      assert.match((r as MergeResult).error ?? '', /is not the commit the approver approved/);
    },
  },
  {
    name: 'decision: a merge of a commit nobody pushed, behind a remote-tracking ref moved to it, is not the approved head',
    arrange: () => scenario('passing', 'CLEAN', { merged: { base: 'forged' } }),
    check: (s, r) => {
      refusedFor('decision')(s, r);
      assert.match((r as MergeResult).error ?? '', /is not the commit the approver approved/);
    },
  },
  {
    name: 'decision: the base is re-read from the remote, so a clean merge of a base that moved on merges whatever the stale ref says',
    arrange: () => scenario('passing', 'CLEAN', { merged: { base: 'pushed' } }),
    opts: { clock: () => Date.now() + 6 * 60_000 },
    check: (s, r) => {
      assert.ok(!(r instanceof Error), String(r));
      assert.deepEqual([r.action, s.merges().length], ['merged', 1]);
      assert.deepEqual(s.merges()[0].matchHead, s.head);
    },
  },
  {
    name: 'decision: a base that cannot be re-read from the remote refuses',
    arrange: () => scenario('passing', 'CLEAN', { remoteGone: true }),
    check: (s, r) => {
      refusedFor('decision')(s, r);
      assert.match((r as MergeResult).error ?? '', /can't be checked against the base/);
    },
  },
  {
    name: "decision: a PR retargeted on GitHub to another branch is not checked against the job's base, so it refuses",
    arrange: () => scenario('passing', 'CLEAN', { prBase: 'release' }),
    check: (s, r) => {
      refusedFor('decision')(s, r);
      assert.match((r as MergeResult).error ?? '', /targets "release" on GitHub, not the job's base "main"/);
    },
  },
  {
    name: 'settling: a base merge committed minutes ago defers even though Forge pushed six minutes ago',
    arrange: () => scenario('passing', 'CLEAN', { merged: { base: 'pushed', at: Date.now() + 3 * 60_000 } }),
    opts: { clock: () => Date.now() + 6 * 60_000 },
    check: (s, r) => {
      assert.deepEqual(s.merges(), []);
      assert.equal((r as MergeResult).action, 'deferred');
      assert.ok(s.all().some((e) => e.type === 'pr-merge-deferred' && e.reason === 'settling'));
    },
  },
  {
    name: 'protected: an escalate hit at the live head with protectedPaths null throws protected_path',
    arrange: () => scenario('passing', 'CLEAN', { files: { Dockerfile: 'FROM scratch\n' } }),
    check: (s, r) => {
      assert.deepEqual(s.merges(), []);
      assert.ok(r instanceof ForgeError && r.code === 'protected_path', String(r));
    },
  },
  {
    name: 'protected: the same hit held by the flag at that blob under a human approval merges',
    arrange: () => {
      const s = scenario('passing', 'CLEAN', { files: { Dockerfile: 'FROM scratch\n' } });
      approveProtected(s, 'Dockerfile');
      return s;
    },
    check: (s, r) => {
      assert.ok(!(r instanceof Error), String(r));
      assert.equal(r.action, 'merged');
      assert.equal(s.merges().length, 1);
    },
  },
  { name: 'floor: a test-config change only a human merges', arrange: () => scenario('passing', 'CLEAN', { files: { 'jest.config.js': 'module.exports = {};\n' } }), check: refusedFor('floor') },
  {
    name: 'settling: one finished SUCCESS check a minute after the push defers',
    arrange: () => scenario('passing'),
    opts: { clock: () => Date.now() + 60_000 },
    check: (s, r) => {
      assert.deepEqual(s.merges(), []);
      assert.equal((r as MergeResult).action, 'deferred');
      assert.ok(s.all().some((e) => e.type === 'pr-merge-deferred' && e.reason === 'settling'));
    },
  },
  { name: 'superseded: a round 2 after the decision with the job still at pr', arrange: () => after(scenario('passing'), (s) => logEvent(s.root, s.id, 'round', { round: 2 })), check: refusedFor('superseded') },
  {
    name: "superseded: a person's rework after the decision with the job still at pr",
    arrange: () => after(scenario('passing'), (s) => logEvent(s.root, s.id, 'human', { action: 'rework', actor: { login: 'al', source: 'env' } })),
    check: refusedFor('superseded'),
  },
  {
    name: "superseded: the foreman's CI rework after the decision",
    arrange: () => after(scenario('passing'), (s) => logEvent(s.root, s.id, 'human', { action: 'rework', actor: FOREMAN_ACTOR, ciHead: s.head })),
    check: refusedFor('superseded'),
  },
  {
    name: 'superseded: the job moved to build after a rework',
    arrange: () =>
      after(scenario('passing'), (s) => {
        logEvent(s.root, s.id, 'human', { action: 'rework', actor: { login: 'al', source: 'env' } });
        setJob(s.root, s.id, { stage: 'build', state: 'running', waitingOn: null });
      }),
    check: refusedFor('superseded'),
  },
  { name: 'superseded: the job cancelled at stage pr', arrange: () => after(scenario('passing'), (s) => setJob(s.root, s.id, { state: 'cancelled', waitingOn: null })), check: refusedFor('superseded') },
  {
    name: 'superseded: the job cancelled, then set back to waiting at pr',
    arrange: () =>
      after(scenario('passing'), (s) => {
        setJob(s.root, s.id, { state: 'cancelled', waitingOn: null });
        setJob(s.root, s.id, { state: 'waiting', waitingOn: 'pr-review' });
      }),
    check: refusedFor('superseded'),
  },
  {
    name: "superseded: a person's rework still waiting in the request inbox",
    arrange: () => after(scenario('passing'), (s) => enqueue(s.root, auto, { type: 'rework', job: s.id, text: 'redo it', from: 'dashboard' })),
    check: (s, r) => {
      refusedFor('superseded')(s, r);
      assert.match((r as MergeResult).error ?? '', /^a rework request for this job is waiting in the request inbox/);
    },
  },
  {
    name: 'superseded: a cancel request a session claimed and has not acked',
    arrange: () =>
      after(scenario('passing'), (s) => {
        const req = enqueue(s.root, auto, { type: 'cancel', job: s.id, from: 'dashboard' });
        claimRequest(s.root, req.id, 'session-1');
      }),
    check: refusedFor('superseded'),
  },
  {
    name: 'superseded: a rework request that was handled and acked merges',
    arrange: () =>
      after(scenario('passing'), (s) => {
        const req = enqueue(s.root, auto, { type: 'rework', job: s.id, from: 'dashboard' });
        ackRequest(s.root, req.id, { status: 'done', result: 'reworked' });
      }),
    check: (s, r) => {
      assert.ok(!(r instanceof Error), String(r));
      assert.deepEqual([r.action, s.merges().length], ['merged', 1]);
    },
  },
  {
    name: 'superseded: a decision recorded after the new round merges',
    arrange: () =>
      after(scenario('passing'), (s) => {
        logEvent(s.root, s.id, 'round', { round: 2 });
        logEvent(s.root, s.id, 'decision', { decision: 'APPROVE', reason: null, autoMerge: true, head: s.head });
      }),
    check: (s, r) => {
      assert.ok(!(r instanceof Error), String(r));
      assert.deepEqual([r.action, s.merges().length], ['merged', 1]);
    },
  },
  {
    name: '--now ignores a superseded decision',
    arrange: () =>
      after(scenario('failing'), (s) => {
        logEvent(s.root, s.id, 'round', { round: 2 });
        setJob(s.root, s.id, { stage: 'build', state: 'running', waitingOn: null });
        enqueue(s.root, auto, { type: 'rework', job: s.id, from: 'dashboard' });
      }),
    opts: { now: { channel: 'terminal', actor: { login: 'alice', source: 'env' } } },
    check: (s, r) => {
      assert.deepEqual(s.merges(), [{ op: 'merge', slug: 'o/r', number: 7, method: 'squash', auto: false, matchHead: s.head }]);
      assert.equal((r as MergeResult).action, 'merged');
      const types = s.events();
      const bypass = types.indexOf('pr-merge-bypass');
      const merged = types.indexOf('pr-merged');
      assert.ok(bypass >= 0 && merged > bypass, types.join(' '));
      assert.equal(s.all()[merged].bypass, true);
    },
  },
  {
    name: "--now outside a daemon, with a person's grant: merge.auto off, no decision, failing checks merge with one plain call",
    arrange: () => scenario('failing', 'CLEAN', { decision: null }),
    config,
    opts: { now: { channel: 'terminal', actor: { login: 'alice', source: 'env' } } },
    check: (s, r) => {
      assert.deepEqual(s.merges(), [{ op: 'merge', slug: 'o/r', number: 7, method: 'squash', auto: false, matchHead: s.head }]);
      assert.equal((r as MergeResult).action, 'merged');
      const all = s.all();
      const bypass = all.findIndex((e) => e.type === 'pr-merge-bypass');
      const merged = all.findIndex((e) => e.type === 'pr-merged');
      assert.ok(bypass >= 0 && merged > bypass, all.map((e) => e.type).join(' '));
      assert.equal(all[merged].bypass, true);
      assert.deepEqual(all[bypass].actor, { login: 'alice', source: 'env' });
      assert.deepEqual(all[merged].actor, { login: 'alice', source: 'env' });
    },
  },
  {
    name: '--now without a grant is refused with no merge call',
    arrange: () => scenario('failing', 'CLEAN', { decision: null }),
    config,
    // A caller that skipped the channel: the type forbids it, the runtime check refuses it.
    opts: { now: true as never },
    check: (s, r) => {
      assert.ok(r instanceof ForgeError && r.code === 'human_only', String(r));
      assert.deepEqual(s.merges(), []);
      assert.ok(!s.all().some((e) => e.type === 'pr-merge-bypass' || e.type === 'pr-merged'));
    },
  },
];

describe('mergePr makes at most one merge call through the adapter', { concurrency: 4 }, () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const s = row.arrange();
      try {
        const r = await mergePr(s.root, row.config ?? auto, s.github, s.id, { clock: SETTLED, ...row.opts }).catch((e: Error) => e);
        row.check(s, r);
      } finally {
        s.cleanup();
      }
    });
  }
});

test('deferredMergeDue: sync continues only a deferral nothing replaced', () => {
  const repo = tempRepo();
  try {
    const decision = { decision: 'APPROVE', reason: null, autoMerge: true, head: 'a'.repeat(40) };
    const deferred = { number: 7, checks: 'pending' };
    const person = { action: 'rework', actor: { login: 'al', source: 'env' } };
    type Step = [string, Record<string, unknown>] | ((root: string, id: string) => void);
    const rows: [string, Step[], unknown, boolean][] = [
      ['a settled deferral after the decision', [['decision', decision], ['pr-merge-deferred', deferred]], 'OPEN', true],
      ['a human rework, then a move to build', [['decision', decision], ['pr-merge-deferred', deferred], ['human', person], (root, id) => setJob(root, id, { stage: 'build', state: 'running', waitingOn: null })], 'OPEN', false],
      ['a round after the deferral', [['decision', decision], ['pr-merge-deferred', deferred], ['round', { round: 2 }]], 'OPEN', false],
      ['a deferral before a newer decision', [['decision', decision], ['pr-merge-deferred', deferred], ['decision', decision]], 'OPEN', false],
      ['a refusal as the last merge event', [['decision', decision], ['pr-merge-deferred', deferred], ['pr-merge-refused', { number: 7, reason: 'decision' }]], 'OPEN', false],
      ['a merged PR', [['decision', decision], ['pr-merge-deferred', deferred]], 'MERGED', false],
      ['a cancelled job', [['decision', decision], ['pr-merge-deferred', deferred], (root, id) => setJob(root, id, { state: 'cancelled', waitingOn: null })], 'OPEN', false],
      [
        'a cancelled job set back to waiting',
        [['decision', decision], ['pr-merge-deferred', deferred], (root, id) => setJob(root, id, { state: 'cancelled', waitingOn: null }), (root, id) => setJob(root, id, { state: 'waiting', waitingOn: 'pr-review' })],
        'OPEN',
        false,
      ],
      ['a rework request waiting in the inbox', [['decision', decision], ['pr-merge-deferred', deferred], (root, id) => void enqueue(root, config, { type: 'rework', job: id, from: 'dashboard' })], 'OPEN', false],
      ['a cancel request waiting in the inbox', [['decision', decision], ['pr-merge-deferred', deferred], (root, id) => void enqueue(root, config, { type: 'cancel', job: id, from: 'dashboard' })], 'OPEN', false],
      [
        'a rework request handled and acked',
        [['decision', decision], ['pr-merge-deferred', deferred], (root, id) => ackRequest(root, enqueue(root, config, { type: 'rework', job: id, from: 'dashboard' }).id, { status: 'done' })],
        'OPEN',
        true,
      ],
      ["another job's rework request", [['decision', decision], ['pr-merge-deferred', deferred], (root) => void enqueue(root, config, { type: 'rework', job: 'some-other-job', from: 'dashboard' })], 'OPEN', true],
    ];
    for (const [name, steps, prState, want] of rows) {
      const id = parkedAt(repo.dir, 'pr-review', { config, title: name }).id;
      logEvent(repo.dir, id, 'pr-opened', { number: 7 });
      for (const step of steps) {
        if (typeof step === 'function') step(repo.dir, id);
        else logEvent(repo.dir, id, step[0], step[1]);
      }
      assert.equal(deferredMergeDue(repo.dir, config, loadJob(repo.dir, id), prState), want, name);
    }
  } finally {
    repo.cleanup();
  }
});

test('mergeProvenance names the daemon scope that ran the merge', () => {
  const repo = tempRepo();
  try {
    const actor = currentActor(repo.dir);
    assert.deepEqual(mergeProvenance(repo.dir, { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: 'other-job' }), { actor, scope: 'other-job' });
    for (const env of [{}, { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '../not-a-scope' }]) {
      const p = mergeProvenance(repo.dir, env);
      assert.deepEqual(p, { actor }, JSON.stringify(env));
      assert.ok(!('scope' in p));
    }
  } finally {
    repo.cleanup();
  }
});

test('mergeAction: direct merge only on settled CI', () => {
  const rows: [string, Parameters<typeof mergeAction>, ReturnType<typeof mergeAction>][] = [
    ['passing, settled', ['passing', { settled: true }], 'merge'],
    ['passing, settling, CLEAN', ['passing', { mergeState: 'CLEAN' }], 'defer'],
    ['passing, settling, BLOCKED', ['passing', { mergeState: 'BLOCKED' }], 'auto'],
    ['passing, settled, UNSTABLE', ['passing', { settled: true, mergeState: 'UNSTABLE' }], 'defer'],
    ['none without CI, settling', ['none', { hasWorkflows: false }], 'defer'],
    ['none without CI, settled', ['none', { hasWorkflows: false, settled: true }], 'merge'],
    ['none with CI, settled', ['none', { hasWorkflows: true, settled: true, mergeState: 'CLEAN' }], 'defer'],
    ['failing', ['failing', { settled: true }], 'refuse'],
    ['failing, now', ['failing', { now: true }], 'merge'],
    ['pending, BLOCKED', ['pending', { settled: true, mergeState: 'BLOCKED' }], 'auto'],
    ['pending, BEHIND', ['pending', { settled: true, mergeState: 'BEHIND' }], 'auto'],
    ['pending, CLEAN', ['pending', { settled: true, mergeState: 'CLEAN' }], 'defer'],
  ];
  for (const [name, args, want] of rows) assert.equal(mergeAction(...args), want, name);
  assert.equal(CI_SETTLE_MS, 5 * 60_000);
});

test('hasCiWorkflows reads every CI system on the base ref', () => {
  const repo = tempRepo();
  try {
    const branch = (name: string, files: string[]) => {
      repo.git('checkout', '-q', '-b', name, 'main');
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(repo.dir, f)), { recursive: true });
        fs.writeFileSync(path.join(repo.dir, f), 'x\n');
      }
      repo.git('add', '-A');
      repo.git('commit', '-qm', name, '--allow-empty');
      repo.git('checkout', '-q', 'main');
    };
    const rows: [string, string[], boolean][] = [
      ['circleci', ['.circleci/config.yml'], true],
      ['buildkite', ['.buildkite/pipeline.yml'], true],
      ['gitlab', ['.gitlab-ci.yml'], true],
      ['jenkins', ['Jenkinsfile'], true],
      ['azure', ['azure-pipelines.yml'], true],
      ['actions', ['.github/workflows/ci.yml'], true],
      ['readme', [], false],
      ['workflows-readme', ['.github/workflows/README.md'], false],
    ];
    for (const [name, files] of rows) branch(name, files);
    for (const [name, , want] of rows) assert.equal(hasCiWorkflows(repo.dir, `refs/heads/${name}`), want, name);
    // The ref wins over the working tree: an uncommitted workflow on disk doesn't count for it.
    fs.mkdirSync(path.join(repo.dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.github', 'workflows', 'ci.yml'), 'x\n');
    assert.equal(hasCiWorkflows(repo.dir, 'refs/heads/readme'), false);
    assert.equal(hasCiWorkflows(repo.dir), true, 'no ref: the working tree');
  } finally {
    repo.cleanup();
  }
});
