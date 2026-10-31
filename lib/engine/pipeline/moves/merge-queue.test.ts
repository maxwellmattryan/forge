// The merge queue: the pure ranking as a table (every row checked over every order of its entries), the token sum
// and the ready predicate; then over jobs and reports on disk, the loader, the report refresh, the hold step PR20
// reads, sync's deferred merge that asks it first, and sync's release of the jobs it no longer holds.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo, withLease } from '../../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { listRequests } from '#core/job/requests.ts';
import { loadJob, logEvent, setJob, updateJob } from '#core/job/store.ts';
import { paths } from '#core/paths.ts';
import { OVERLAP_SCHEMA_VERSION } from '#core/versions/overlap.ts';
import type { Config, Job, JobEvent, JobUsage, MergeQueue } from '#core/types.ts';
import type { GitHub } from '#integrations/github/types.ts';
import { continueQueued, mergeHold, mergeQueue, queueReady, rankMergeQueue, refreshQueueReport, releaseOverlapWaits, workTokens } from './merge-queue.ts';
import type { QueueCandidate, RankInput } from './merge-queue.ts';

const c = (job: string, over: Partial<QueueCandidate> = {}): QueueCandidate => ({ job, pr: job.charCodeAt(0), tokens: 0, ready: true, openedAt: null, issue: null, dependsOn: [], ...over });

/** A row's expectation, compactly: each group as [job, ahead, reason] triples; merge-now and unchecked as [job, reason]. */
interface Want {
  groups: [string, string | null, string][][];
  mergeNow?: [string, string][];
  unchecked?: [string, string][];
}

const compact = (q: MergeQueue): Want => ({
  groups: q.groups.map((g) => g.map((e) => [e.job, e.ahead, e.reasons.join(' | ')] as [string, string | null, string])),
  mergeNow: q.mergeNow.map((e) => [e.job, e.reasons.join(' | ')] as [string, string]),
  unchecked: q.unchecked.map((e) => [e.job, e.reasons.join(' | ')] as [string, string]),
});

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

const MERGE_NOW = 'overlaps no other open PR of this mandate';
const HOSTILE = '../x\u001b[31m';

describe('rankMergeQueue', () => {
  const rows: { name: string; input: Omit<RankInput, 'hold'>; want: Want }[] = [
    {
      name: 'more work ranks first',
      input: { entries: [c('b', { tokens: 300000 }), c('a', { tokens: 900000 })], links: [['a', 'b']], checked: ['a', 'b'] },
      want: { groups: [[['a', null, 'ahead of b: a spent 900000 input+output tokens, b 300000'], ['b', 'a', 'behind a: a spent 900000 input+output tokens, b 300000']]] },
    },
    {
      name: 'no overlap is merge-now',
      input: { entries: [c('a', { tokens: 2 }), c('b', { tokens: 1 }), c('m', { tokens: 5000000 })], links: [['b', 'a']], checked: ['a', 'b', 'm'] },
      want: {
        groups: [[['a', null, 'ahead of b: a spent 2 input+output tokens, b 1'], ['b', 'a', 'behind a: a spent 2 input+output tokens, b 1']]],
        mergeNow: [['m', MERGE_NOW]],
      },
    },
    {
      name: 'no report is unchecked',
      input: { entries: [c('m'), c('u', { tokens: 7 })], links: [], checked: ['m'] },
      want: { groups: [], mergeNow: [['m', MERGE_NOW]], unchecked: [['u', 'no overlap report yet: forge overlap u']] },
    },
    {
      name: 'dependency beats readiness and tokens',
      input: { entries: [c('a', { ready: false, tokens: 10 }), c('b', { tokens: 999, dependsOn: ['a'] })], links: [['a', 'b']], checked: ['a', 'b'] },
      want: { groups: [[['a', null, 'ahead of b: b depends on a'], ['b', null, 'behind a: b depends on a']]] },
    },
    {
      name: 'dependsOn links a group',
      input: { entries: [c('b', { dependsOn: ['a'], tokens: 5 }), c('a', { tokens: 1 })], links: [], checked: [] },
      want: { groups: [[['a', null, 'ahead of b: b depends on a'], ['b', 'a', 'behind a: b depends on a']]] },
    },
    {
      name: 'ready before in review',
      input: { entries: [c('a', { tokens: 10 }), c('b', { ready: false, tokens: 99 })], links: [['a', 'b']], checked: ['a', 'b'] },
      want: { groups: [[['a', null, 'ahead of b: a is ready to merge and b is not'], ['b', 'a', 'behind a: a is ready to merge and b is not']]] },
    },
    {
      name: 'tie: PR age',
      input: { entries: [c('a', { tokens: 50, openedAt: '2026-10-02T00:00:00Z' }), c('b', { tokens: 50, openedAt: '2026-10-01T00:00:00Z' })], links: [['a', 'b']], checked: [] },
      want: { groups: [[['b', null, "ahead of a: same tokens (50); b's PR is older"], ['a', 'b', "behind b: same tokens (50); b's PR is older"]]] },
    },
    {
      name: 'tie: PR age, a missing time sorts last',
      input: { entries: [c('a', { tokens: 50, openedAt: 'not a time' }), c('b', { tokens: 50, openedAt: '2026-10-01T00:00:00Z' })], links: [['a', 'b']], checked: [] },
      want: { groups: [[['b', null, "ahead of a: same tokens (50); b's PR is older"], ['a', 'b', "behind b: same tokens (50); b's PR is older"]]] },
    },
    {
      name: 'tie: issue',
      input: { entries: [c('a', { tokens: 50, issue: 12 }), c('b', { tokens: 50, issue: 7 }), c('d', { tokens: 50 })], links: [['a', 'b'], ['b', 'd']], checked: [] },
      want: {
        groups: [[
          ['b', null, 'ahead of a: same tokens (50) and PR age; b has the lower issue number'],
          ['a', 'b', 'behind b: same tokens (50) and PR age; b has the lower issue number'],
          ['d', 'b', 'behind a: same tokens (50) and PR age; a has the lower issue number'],
        ]],
      },
    },
    {
      name: 'tie: job id',
      input: { entries: [c('b', { tokens: 50 }), c('a', { tokens: 50 })], links: [['b', 'a']], checked: [] },
      want: { groups: [[['a', null, 'ahead of b: same tokens (50), PR age and issue; a sorts first by job id'], ['b', 'a', 'behind a: same tokens (50), PR age and issue; a sorts first by job id']]] },
    },
    {
      name: 'transitive group',
      input: { entries: [c('a', { tokens: 1 }), c('b', { tokens: 2 }), c('c', { tokens: 3 }), c('d', { tokens: 5 }), c('e', { tokens: 4 })], links: [['a', 'b'], ['c', 'b'], ['e', 'd']], checked: [] },
      want: {
        groups: [
          [
            ['c', null, 'ahead of b: c spent 3 input+output tokens, b 2'],
            ['b', 'c', 'behind c: c spent 3 input+output tokens, b 2'],
            ['a', 'c', 'behind b: b spent 2 input+output tokens, a 1'],
          ],
          [['d', null, 'ahead of e: d spent 5 input+output tokens, e 4'], ['e', 'd', 'behind d: d spent 5 input+output tokens, e 4']],
        ],
      },
    },
    {
      name: 'unknown counterpart ignored',
      input: { entries: [c('a', { tokens: 2, dependsOn: [HOSTILE] }), c('b', { tokens: 1 }), c('m')], links: [['a', HOSTILE], [HOSTILE, 'm'], ['a', 'b']], checked: ['a', 'b', 'm'] },
      want: { groups: [[['a', null, 'ahead of b: a spent 2 input+output tokens, b 1'], ['b', 'a', 'behind a: a spent 2 input+output tokens, b 1']]], mergeNow: [['m', MERGE_NOW]] },
    },
    {
      name: 'ahead skips entries that are not ready',
      input: { entries: [c('a', { ready: false }), c('b', { dependsOn: ['a'] }), c('d', { dependsOn: ['b'] })], links: [], checked: [] },
      want: { groups: [[['a', null, 'ahead of b: b depends on a'], ['b', null, 'behind a: b depends on a'], ['d', 'b', 'behind b: d depends on b']]] },
    },
    {
      name: 'a dependency cycle takes the best of the rest',
      input: { entries: [c('a', { tokens: 1, dependsOn: ['b'] }), c('b', { tokens: 2, dependsOn: ['a'] })], links: [], checked: [] },
      want: { groups: [[['b', null, 'ahead of a: b spent 2 input+output tokens, a 1'], ['a', 'b', 'behind b: b spent 2 input+output tokens, a 1']]] },
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const first = rankMergeQueue({ ...row.input, hold: true });
      assert.deepEqual(compact(first), { mergeNow: [], unchecked: [], ...row.want });
      assert.equal(first.hold, true);
      for (const g of first.groups) assert.equal(g[0].ahead, null, `a group's first entry is never held: ${g[0].job}`);
      for (const e of [...first.groups.flat(), ...first.mergeNow, ...first.unchecked]) assert.equal(e.pr, e.job.charCodeAt(0));
      assert.ok(!JSON.stringify(first).includes('../x') && !JSON.stringify(first).includes('\u001b'), 'no counterpart text reaches the output');
      for (const entries of permutations(row.input.entries))
        assert.deepEqual(rankMergeQueue({ entries, links: [...row.input.links].reverse().map(([x, y]) => [y, x]), checked: [...row.input.checked].reverse(), hold: true }), first, entries.map((e) => e.job).join(','));
    });
  }
  test('an empty queue', () => {
    assert.deepEqual(rankMergeQueue({ entries: [], links: [], checked: [], hold: false }), { hold: false, groups: [], mergeNow: [], unchecked: [] });
  });
});

const bucket = (over: Record<string, unknown>) => ({ tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolUses: 0, durationMs: 0, runs: 1, estCostUsd: 0, ...over });
const usage = (byRole: Record<string, unknown>) => ({ totalTokens: 0, byRole, byModel: {}, estCostUsd: 0, exact: true }) as unknown as JobUsage;

describe('workTokens', () => {
  const rows: [string, JobUsage | null | undefined, number][] = [
    ['no usage is 0', undefined, 0],
    ['input + output over every role', usage({ builder: bucket({ input: 100, output: 20 }), 'reviewer:code': bucket({ input: 5, output: 1 }) }), 126],
    ['cache reads and writes are left out', usage({ builder: bucket({ input: 10, output: 1, cacheRead: 1_000_000, cacheWrite: 50_000, tokens: 1_050_011 }) }), 11],
    ['a missing field counts as 0', usage({ builder: { output: 7 } }), 7],
    ['a negative field counts as 0', usage({ builder: bucket({ input: -500, output: 3 }) }), 3],
    ['a non-finite field counts as 0', usage({ builder: bucket({ input: Number.NaN, output: Number.POSITIVE_INFINITY }), planner: bucket({ input: 4 }) }), 4],
    ['a role that is not a bucket counts as 0', usage({ builder: 'lots', planner: null, spec: bucket({ input: 2 }) }), 2],
  ];
  for (const [name, u, want] of rows) test(name, () => assert.equal(workTokens(u), want));
});

const SHA = 'a'.repeat(40);
const ev = (type: string, data: Record<string, unknown> = {}): JobEvent => ({ v: 1, ts: '2026-10-01T10:00:00.000Z', type, ...data }) as JobEvent;
const ELIGIBLE = ev('decision', { decision: 'APPROVE', autoMerge: true, head: SHA });
const OPENED = ev('pr-opened', { number: 1 });

describe('queueReady', () => {
  type J = Pick<Job, 'stage' | 'state' | 'waitingOn' | 'pr'>;
  const ready: J = { stage: 'pr', state: 'running', waitingOn: null, pr: { number: 1, url: 'u', state: 'OPEN', isDraft: false, lastSyncedAt: 't', checks: { state: 'passing' } as any, changesRequested: 0 } };
  const pr = (over: Record<string, unknown>) => ({ ...ready, pr: { ...ready.pr!, ...over } }) as J;
  const rows: [string, J, JobEvent[], boolean][] = [
    ['checks passing with an eligible decision', ready, [ELIGIBLE, OPENED], true],
    ['checks none', pr({ checks: { state: 'none' } }), [ELIGIBLE, OPENED], true],
    ['changes requested absent', pr({ changesRequested: undefined }), [ELIGIBLE, OPENED], true],
    ['waiting on pr-review', { ...ready, state: 'waiting', waitingOn: 'pr-review' }, [ELIGIBLE, OPENED], true],
    ['waiting on overlap', { ...ready, state: 'waiting', waitingOn: 'overlap' }, [ELIGIBLE, OPENED], true],
    ['a refusal before the last push', ready, [ELIGIBLE, OPENED, ev('pr-merge-refused'), ev('pr-updated')], true],
    ['a deferral after the last push', ready, [ELIGIBLE, OPENED, ev('pr-merge-deferred')], true],
    ['stage not pr', { ...ready, stage: 'decide' }, [ELIGIBLE, OPENED], false],
    ['a draft', pr({ isDraft: true }), [ELIGIBLE, OPENED], false],
    ['checks pending', pr({ checks: { state: 'pending' } }), [ELIGIBLE, OPENED], false],
    ['checks failing', pr({ checks: { state: 'failing' } }), [ELIGIBLE, OPENED], false],
    ['no checks recorded', pr({ checks: undefined }), [ELIGIBLE, OPENED], false],
    ['changes requested', pr({ changesRequested: 1 }), [ELIGIBLE, OPENED], false],
    ['parked on escalation', { ...ready, state: 'waiting', waitingOn: 'escalation' }, [ELIGIBLE, OPENED], false],
    ['parked on human', { ...ready, state: 'waiting', waitingOn: 'human' }, [ELIGIBLE, OPENED], false],
    ['failed', { ...ready, state: 'failed' }, [ELIGIBLE, OPENED], false],
    ['PR closed', pr({ state: 'CLOSED' }), [ELIGIBLE, OPENED], false],
    ['no PR', { ...ready, pr: null }, [ELIGIBLE, OPENED], false],
    ['no decision', ready, [OPENED], false],
    ['a decision not marked eligible', ready, [ev('decision', { decision: 'APPROVE', autoMerge: false, head: SHA }), OPENED], false],
    ['an ESCALATE', ready, [ev('decision', { decision: 'ESCALATE', autoMerge: true, head: SHA }), OPENED], false],
    ['a refused merge after the last push', ready, [ELIGIBLE, OPENED, ev('pr-merge-refused')], false],
    ['a failed merge after the last update', ready, [ELIGIBLE, OPENED, ev('pr-updated'), ev('pr-merge-deferred'), ev('pr-merge-failed')], false],
  ];
  for (const [name, job, events, want] of rows) test(name, () => assert.equal(queueReady(job, events), want));
});

/** A repo whose jobs and reports the loaders read. */
function queueRepo(edit: (c: Config) => void = () => {}) {
  const repo = tempRepo();
  const config = defaults();
  config.tracker.kind = 'none';
  edit(config);
  let n = 10;
  /** A job of `mandate` at pr with an open PR (ready unless `ready` is false), `tokens` of input. */
  const add = (mandate: string | null, opts: { tokens?: number; ready?: boolean; stage?: 'pr' | 'done'; pr?: boolean; waitingOn?: 'overlap' | 'escalation' } = {}) => {
    const number = n++;
    const pr = opts.pr === false ? undefined : { number, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', isDraft: false, lastSyncedAt: 't', openedAt: '2026-10-01T10:00:00.000Z', checks: { state: opts.ready === false ? 'failing' : 'passing' }, changesRequested: 0 };
    const at = { config, create: { mandate }, pr, ...(opts.waitingOn ? { state: 'waiting' as const, waitingOn: opts.waitingOn, reason: 'r' } : {}) };
    const j = jobAt(repo.dir, opts.stage ?? 'pr', at);
    updateJob(repo.dir, j.id, (x) => {
      x.usage.byRole = { builder: bucket({ input: opts.tokens ?? 0 }) } as any;
    });
    logEvent(repo.dir, j.id, 'decision', { decision: 'APPROVE', autoMerge: true, head: SHA });
    logEvent(repo.dir, j.id, 'pr-opened', { number });
    return j.id;
  };
  /** Job `id`'s cached overlap report naming `refs` as job counterparts. */
  const report = (id: string, refs: string[], version = OVERLAP_SCHEMA_VERSION) => {
    const file = path.join(paths(repo.dir).overlap, 'jobs', `${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const counterparts = refs.map((ref) => ({ kind: 'job', ref, source: 'diff', human: false, stage: 'pr', url: null, files: ['a.ts'], sharedHunks: [] }));
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: version, checkedAt: '2026-10-01T10:00:00.000Z', subject: { kind: 'job', ref: id, source: 'diff', files: 1 }, base: 'main', recentHours: 24, counterparts, idle: false, timing: { kind: 'now', refs: [] }, reasons: [], gaps: [] }));
  };
  return { root: repo.dir, config, add, report, cleanup: repo.cleanup };
}

test("mergeQueue reads the mandate's jobs and reports", () => {
  const s = queueRepo();
  try {
    const a = s.add('m1', { tokens: 900 });
    const b = s.add('m1', { tokens: 300 });
    const unchecked = s.add('m1', { tokens: 5 });
    const alone = s.add('m1', { tokens: 1 });
    const other = s.add('m2', { tokens: 99999 });
    s.add('m1', { pr: false });
    s.add('m1', { stage: 'done' });
    s.add(null);
    // Only a's side names b; b's own report is from a newer Forge and reads as missing.
    s.report(a, [b, other]);
    s.report(b, [], OVERLAP_SCHEMA_VERSION + 1);
    s.report(unchecked, [a], OVERLAP_SCHEMA_VERSION + 1);
    s.report(alone, [HOSTILE, other, 'no-such-job']);
    s.report(other, [a]);
    const q = mergeQueue(s.root, s.config, 'm1');
    assert.deepEqual(compact(q), {
      groups: [[[a, null, `ahead of ${b}: ${a} spent 900 input+output tokens, ${b} 300`], [b, a, `behind ${a}: ${a} spent 900 input+output tokens, ${b} 300`]]],
      mergeNow: [[alone, MERGE_NOW]],
      unchecked: [[unchecked, `no overlap report yet: forge overlap ${unchecked}`]],
    });
    assert.equal(q.hold, false);
    assert.deepEqual(q.groups[0].map((e) => [e.pr, e.tokens, e.ready]), [[10, 900, true], [11, 300, true]]);
    assert.ok(!JSON.stringify(q).includes('../x') && !JSON.stringify(q).includes('\u001b') && !JSON.stringify(q).includes('no-such-job'), 'no report ref reaches the output');
    assert.equal(mergeQueue(s.root, { ...s.config, merge: { ...s.config.merge, auto: true } }, 'm1').hold, true);
    assert.deepEqual(mergeQueue(s.root, s.config, 'none-here'), { hold: false, groups: [], mergeNow: [], unchecked: [] });
  } finally {
    s.cleanup();
  }
});

const shipMerge = (c: Config) => Object.assign(c.foreman, { enabled: true, ship: 'merge' });

describe('mergeHold', () => {
  test('names the ready PR ranked ahead, and nothing otherwise', () => {
    const s = queueRepo(shipMerge);
    try {
      const a = s.add('m1', { tokens: 900 });
      const b = s.add('m1', { tokens: 300 });
      s.report(b, [a]);
      const job = loadJob(s.root, b);
      assert.equal(mergeHold(s.root, s.config, job), a);
      assert.equal(mergeHold(s.root, s.config, loadJob(s.root, a)), null, 'the top entry is never held');
      assert.equal(mergeHold(s.root, s.config, { ...job, mandate: null }), null, 'no mandate');
      assert.equal(mergeHold(s.root, s.config, { ...job, stage: 'decide' }), null, 'off stage pr');
      assert.equal(mergeHold(s.root, s.config, { ...job, pr: { ...job.pr!, state: 'MERGED' } }), null, 'no open PR');
      assert.equal(mergeHold(s.root, s.config, { ...job, pr: null }), null, 'no PR');
      assert.equal(mergeHold(s.root, { ...s.config, foreman: { ...s.config.foreman, ship: 'propose' } }, job), null, 'autoMerge false');
    } finally {
      s.cleanup();
    }
  });
});

describe('releaseOverlapWaits', () => {
  /** a ranked first and ready; b behind it, waiting on overlap; daemon on so the release queues a resume. */
  const held = () => {
    const s = queueRepo((c) => {
      shipMerge(c);
      c.daemon.enabled = true;
    });
    const a = s.add('m1', { tokens: 900 });
    const b = s.add('m1', { tokens: 300, waitingOn: 'overlap' });
    s.report(a, [b]);
    const resumes = () => listRequests(s.root, { status: 'pending' }).filter((r) => r.type === 'resume' && r.job === b);
    return { ...s, a, b, resumes };
  };
  const released = (s: ReturnType<typeof held>) => {
    const j = loadJob(s.root, s.b);
    assert.deepEqual([j.stage, j.state, j.waitingOn, j.reason], ['pr', 'running', null, 'forge sync: the merge queue no longer holds it']);
    assert.equal(s.resumes().length, 1);
    assert.equal(s.resumes()[0].from, 'sync');
  };

  test('a job still held stays as it is', async () => {
    const s = held();
    try {
      assert.equal(mergeHold(s.root, s.config, loadJob(s.root, s.b)), s.a);
      assert.deepEqual(await releaseOverlapWaits(s.root, s.config), []);
      assert.deepEqual([loadJob(s.root, s.b).state, loadJob(s.root, s.b).waitingOn], ['waiting', 'overlap']);
      assert.equal(s.resumes().length, 0);
    } finally {
      s.cleanup();
    }
  });
  test('once the PR ahead merged, it runs again with one resume', async () => {
    const s = held();
    try {
      setJob(s.root, s.a, { stage: 'done', state: 'done', owned: { pr: { ...loadJob(s.root, s.a).pr, state: 'MERGED' } } });
      assert.deepEqual(await releaseOverlapWaits(s.root, s.config), [{ id: s.b, mergeQueueReleased: true }]);
      released(s);
      assert.deepEqual(await releaseOverlapWaits(s.root, s.config), [], 'released once');
      assert.equal(s.resumes().length, 1);
    } finally {
      s.cleanup();
    }
  });
  test('a PR ahead whose checks fail frees it at once', async () => {
    const s = held();
    try {
      setJob(s.root, s.a, { owned: { pr: { ...loadJob(s.root, s.a).pr, checks: { state: 'failing' } } } });
      assert.deepEqual(await releaseOverlapWaits(s.root, s.config), [{ id: s.b, mergeQueueReleased: true }]);
      released(s);
    } finally {
      s.cleanup();
    }
  });
  test('a PR ahead parked on escalation frees it at once', async () => {
    const s = held();
    try {
      setJob(s.root, s.a, { state: 'waiting', waitingOn: 'escalation', reason: 'r' });
      assert.deepEqual(await releaseOverlapWaits(s.root, s.config), [{ id: s.b, mergeQueueReleased: true }]);
      released(s);
    } finally {
      s.cleanup();
    }
  });
  test('a job with a live lease is left alone', async () => {
    const s = held();
    try {
      setJob(s.root, s.a, { state: 'failed', reason: 'r' });
      withLease(s.root, s.b, 'S-live');
      assert.deepEqual(await releaseOverlapWaits(s.root, s.config), []);
      assert.equal(loadJob(s.root, s.b).waitingOn, 'overlap');
    } finally {
      s.cleanup();
    }
  });
});

/** A GitHub on which every call throws, counting the calls. */
function throwingGitHub(): { github: GitHub; calls: () => number } {
  let calls = 0;
  const github = new Proxy({} as GitHub, {
    get: (_t, k) =>
      k === 'then'
        ? undefined
        : () => {
            calls++;
            throw new Error(`no GitHub call expected: ${String(k)}`);
          },
  });
  return { github, calls: () => calls };
}

test('continueQueued', async () => {
  const s = queueRepo(shipMerge);
  try {
    const a = s.add('m1', { tokens: 900 });
    const b = s.add('m1', { tokens: 300 });
    s.report(a, [b]);
    const held = throwingGitHub();
    assert.deepEqual(await continueQueued(s.root, s.config, held.github, b), { mergeHeld: a });
    assert.equal(held.calls(), 0, 'no GitHub call while held');
    // Not held: continueMerge's own result, whatever mergePr made of the GitHub it got.
    const free = throwingGitHub();
    const r = await continueQueued(s.root, s.config, free.github, a);
    assert.ok(!('mergeHeld' in r), JSON.stringify(r));
    assert.ok('merge' in r || 'error' in r, JSON.stringify(r));
  } finally {
    s.cleanup();
  }
});

describe('refreshQueueReport', () => {
  const rows: [string, string | null, 'ok' | 'throws', boolean][] = [
    ['a mandate job is checked', 'm1', 'ok', true],
    ['a job outside a mandate is not', null, 'ok', false],
    ['an overlap failure is swallowed', 'm1', 'throws', true],
  ];
  for (const [name, mandate, mode, called] of rows) {
    test(name, () => {
      const s = queueRepo();
      try {
        const id = s.add(mandate);
        const seen: unknown[] = [];
        const check = ((_root: string, _config: Config, _gh: GitHub, subject: unknown) => {
          seen.push(subject);
          if (mode === 'throws') throw new Error('git broke');
          return {} as any;
        }) as Parameters<typeof refreshQueueReport>[4];
        assert.doesNotThrow(() => refreshQueueReport(s.root, s.config, throwingGitHub().github, id, check));
        assert.deepEqual(seen, called ? [{ job: id }] : []);
      } finally {
        s.cleanup();
      }
    });
  }
  test('an unknown job is swallowed too', () => {
    const s = queueRepo();
    try {
      assert.doesNotThrow(() => refreshQueueReport(s.root, s.config, throwingGitHub().github, 'no-such-job'));
    } finally {
      s.cleanup();
    }
  });
});
