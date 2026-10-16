import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { findPr, mergeAction, hasCiWorkflows, mergePr, syncPr, syncTransition } from '../lib/pr.ts';
import { defaults } from '../lib/config.ts';
import { claimJob, createJob, loadJob, setJob, readEvents, updateJob } from '../lib/jobs.ts';
import { listRequests } from '../lib/requests.ts';
import { syncAll } from '../lib/commands/tracker.ts';
import type { Job, JobPr } from '../lib/types.ts';

test('mergeAction: direct merge only when CI passed or the repo has none', () => {
  const B = { mergeState: 'BLOCKED' };
  const rows: any = [
    ['passing', {}, 'merge'],
    ['passing', { hasWorkflows: true }, 'merge'],
    ['passing', { mergeState: 'UNSTABLE' }, 'merge'],
    ['failing', {}, 'refuse'],
    ['failing', { hasWorkflows: true, ...B }, 'refuse'],
    ['none', { hasWorkflows: false }, 'merge'],
    // Waiting on CI: --auto only where GitHub enforces requirements, else defer.
    ['pending', B, 'auto'],
    ['pending', { mergeState: 'BEHIND' }, 'auto'],
    ['pending', { mergeState: 'blocked' }, 'auto'],
    ['pending', { hasWorkflows: true, ...B }, 'auto'],
    ['none', { hasWorkflows: true, ...B }, 'auto'],
    [undefined, B, 'auto'],
    ['weird', B, 'auto'],
    ['pending', {}, 'defer'],
    ['pending', { mergeState: 'UNSTABLE' }, 'defer'],
    ['pending', { mergeState: 'CLEAN' }, 'defer'],
    ['pending', { mergeState: 'HAS_HOOKS' }, 'defer'],
    ['pending', { mergeState: 'UNKNOWN' }, 'defer'],
    ['none', { hasWorkflows: true, mergeState: 'CLEAN' }, 'defer'],
    [undefined, {}, 'defer'],
    ['weird', { hasWorkflows: false }, 'defer'],
    ['failing', { now: true }, 'merge'],
    ['pending', { now: true }, 'merge'],
    ['none', { now: true, hasWorkflows: true }, 'merge'],
    [undefined, { now: true }, 'merge'],
  ];
  for (const [state, opts, want] of rows) assert.equal(mergeAction(state, opts), want, `${state} ${JSON.stringify(opts)}`);
  assert.equal(mergeAction('none'), 'merge', 'options default to no workflows, no override');
});

test('hasCiWorkflows: reads the ref, falls back to the working tree', () => {
  const bare = tempRepo();
  const ci = tempRepo();
  try {
    assert.equal(hasCiWorkflows(bare.dir, 'HEAD'), false);
    assert.equal(hasCiWorkflows(bare.dir, 'origin/main'), false);
    assert.equal(hasCiWorkflows(bare.dir), false);

    const wf = path.join(ci.dir, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'README.md'), 'not a workflow\n');
    ci.git('add', '-A');
    ci.git('commit', '-qm', 'docs only');
    assert.equal(hasCiWorkflows(ci.dir, 'HEAD'), false, 'non-yaml files are not workflows');

    fs.writeFileSync(path.join(wf, 'ci.yaml'), 'on: push\n');
    assert.equal(hasCiWorkflows(ci.dir, 'HEAD'), false, 'the ref wins over an uncommitted file');
    assert.equal(hasCiWorkflows(ci.dir, 'origin/main'), true, 'a missing ref falls back to the working tree');
    ci.git('add', '-A');
    ci.git('commit', '-qm', 'ci');
    assert.equal(hasCiWorkflows(ci.dir, 'HEAD'), true);
  } finally {
    bare.cleanup();
    ci.cleanup();
  }
});

// A stand-in `gh` on PATH: answers `pr view` from env, records every call, and can fail `pr merge`.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr view") printf '{"number":7,"url":"https://github.com/o/r/pull/7","state":"%s","isDraft":false,"headRefOid":"%s","mergeable":"%s","mergeStateStatus":"%s","reviewDecision":"","statusCheckRollup":%s,"mergedAt":null,"closedAt":null,"headRefName":"%s","baseRefName":"%s"}' "$FAKE_PR_STATE" "\${FAKE_HEAD_OID:-abc123}" "\${FAKE_MERGEABLE:-MERGEABLE}" "$FAKE_MERGE_STATE" "$FAKE_ROLLUP" "\${FAKE_HEAD_REF:-forge/x}" "\${FAKE_BASE_REF:-main}" ;;
  "pr list") printf '[{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":false,"isCrossRepository":false,"headRefName":"%s","baseRefName":"%s"}]' "\${FAKE_HEAD_REF:-forge/x}" "\${FAKE_BASE_REF:-main}" ;;
  "repo view") echo o/r ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{}}}}' ;;
  "pr merge") if [ -n "$FAKE_MERGE_FAIL" ]; then echo "auto-merge is not allowed" >&2; exit 1; fi ;;
esac
`;

const ROLLUP = {
  passing: [{ conclusion: 'SUCCESS' }],
  pending: [{ status: 'IN_PROGRESS' }],
  failing: [{ conclusion: 'FAILURE' }],
  none: [],
};

function ghHarness() {
  const repo = tempRepo();
  const bin = path.join(repo.dir, '..', `fakebin-${path.basename(repo.dir)}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const log = path.join(bin, 'calls.log');
  const saved = { ...process.env };
  const config = defaults();
  config.tracker.github.repo = 'o/r';
  let n = 0;
  // mergeable/head are what gh reports; pushedSha, at and owner are the job's own state.
  const scenario = ({
    state = 'OPEN',
    checks = 'passing' as keyof typeof ROLLUP,
    mergeState = 'CLEAN',
    fail = false,
    mergeable = '',
    head = '',
    pushedSha = undefined as string | undefined,
    at = undefined as { stage: string; state: string; waitingOn?: string } | undefined,
    owner = undefined as string | undefined,
  } = {}) => {
    const job = createJob(repo.dir, config, { title: `job ${++n}`, ref: `job-${n}` });
    setJob(repo.dir, job.id, { fields: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', ...(pushedSha !== undefined ? { pushedSha } : {}) } } });
    if (at) setJob(repo.dir, job.id, at);
    if (owner) claimJob(repo.dir, job.id, owner);
    fs.writeFileSync(log, '');
    Object.assign(process.env, {
      PATH: `${bin}${path.delimiter}${saved.PATH}`,
      FAKE_GH_LOG: log,
      FAKE_PR_STATE: state,
      FAKE_MERGE_STATE: mergeState,
      FAKE_ROLLUP: JSON.stringify(ROLLUP[checks]),
      FAKE_MERGE_FAIL: fail ? '1' : '',
      FAKE_MERGEABLE: mergeable,
      FAKE_HEAD_OID: head,
    });
    return job.id;
  };
  // The PR branch n commits behind its base, as syncPr's rev-list sees it (null: no remote refs).
  // There is no remote, so the fetch fails and these local refs stand.
  let tips: string[] | null = null;
  const behind = (by: number | null) => {
    const refs = ['refs/remotes/origin/main', 'refs/remotes/origin/forge/x'];
    if (by === null) {
      for (const r of refs) spawnSync('git', ['update-ref', '-d', r], { cwd: repo.dir });
      return;
    }
    if (!tips) {
      repo.git('commit', '-q', '--allow-empty', '-m', 'base 1');
      repo.git('commit', '-q', '--allow-empty', '-m', 'base 2');
      tips = ['HEAD', 'HEAD~1', 'HEAD~2'].map((r) => String(repo.git('rev-parse', r)).trim());
    }
    repo.git('update-ref', refs[0], tips[0]);
    repo.git('update-ref', refs[1], tips[by]);
  };
  const merges = () => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('pr merge'));
  const events = (id) => readEvents(repo.dir, id).map((e) => e.type);
  const done = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(bin, { recursive: true, force: true });
    repo.cleanup();
  };
  return { repo, config, bin, scenario, behind, merges, events, done };
}

test('mergePr: one merge call chosen by CI state, never a fallback', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  // Each PR here is the head forge pr open pushed and checked for protected paths.
  const scenario: typeof h.scenario = (o = {}) => h.scenario({ pushedSha: 'abc123', ...o });
  // --auto is only queued without a protected-paths policy (see the test after this one).
  const open = structuredClone(h.config);
  open.policy.protectedPaths = [];
  try {
    const root = h.repo.dir;

    let id = scenario({ checks: 'passing' });
    assert.deepEqual(mergePr(root, h.config, id), { merged: true, autoMerge: false, action: 'merged', checks: 'passing' });
    assert.deepEqual(h.merges(), ['pr merge 7 -R o/r --squash --match-head-commit abc123']);
    assert.ok(h.events(id).includes('pr-synced'), 'syncs before deciding');

    id = scenario({ checks: 'pending', mergeState: 'BLOCKED' });
    assert.equal(mergePr(root, open, id).action, 'auto');
    assert.deepEqual(h.merges(), ['pr merge 7 -R o/r --squash --auto --match-head-commit abc123']);
    assert.ok(h.events(id).includes('pr-auto-merge'));

    // Unprotected repo, CI still running: `gh pr merge --auto` would merge at once here.
    id = scenario({ checks: 'pending', mergeState: 'UNSTABLE' });
    assert.deepEqual(mergePr(root, h.config, id), { merged: false, autoMerge: false, action: 'deferred', checks: 'pending', mergeState: 'UNSTABLE' });
    assert.deepEqual(h.merges(), [], 'deferred makes no merge call');
    assert.ok(h.events(id).includes('pr-merge-deferred'));

    id = scenario({ checks: 'pending', mergeState: 'BLOCKED', fail: true });
    const failed = mergePr(root, open, id);
    assert.equal(failed.action, 'failed');
    assert.match(failed.error, /auto-merge is not allowed/);
    assert.equal(h.merges().length, 1, 'a failed --auto never falls back to a direct merge');
    const failedEv = readEvents(root, id).find((e) => e.type === 'pr-merge-failed');
    assert.equal(failedEv.number, 7);
    assert.match(failedEv.error as any, /auto-merge is not allowed/);

    id = scenario({ checks: 'passing', fail: true });
    assert.equal(mergePr(root, h.config, id).action, 'failed');
    assert.ok(h.events(id).includes('pr-merge-failed'));
    assert.deepEqual(h.merges(), ['pr merge 7 -R o/r --squash --match-head-commit abc123'], 'a failed direct merge never falls back to --auto');

    id = scenario({ checks: 'failing' });
    const refused = mergePr(root, h.config, id);
    assert.equal(refused.action, 'refused');
    assert.equal(refused.checks, 'failing');
    assert.deepEqual(h.merges(), []);
    assert.ok(h.events(id).includes('pr-merge-refused'));
    assert.ok(!h.events(id).includes('pr-merged'));

    id = scenario({ checks: 'none' });
    assert.equal(mergePr(root, h.config, id).action, 'merged', 'no checks and no workflows: nothing to wait for');
    assert.equal(readEvents(root, id).find((e) => e.type === 'pr-merged').actor, undefined, "a merge without --now is the approver's, not a person's");
    const wf = path.join(root, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'ci.yml'), 'on: push\n');
    id = scenario({ checks: 'none', mergeState: 'BLOCKED' });
    assert.equal(mergePr(root, open, id).action, 'auto', 'workflows exist but have not reported yet');
    id = scenario({ checks: 'none', mergeState: 'CLEAN' });
    assert.equal(mergePr(root, h.config, id).action, 'deferred', 'unregistered workflows on an unprotected repo');
    assert.deepEqual(h.merges(), []);
    fs.rmSync(path.join(root, '.github'), { recursive: true });

    id = scenario({ checks: 'failing' });
    assert.equal(mergePr(root, h.config, id, { now: true }).action, 'merged');
    assert.deepEqual(h.merges(), ['pr merge 7 -R o/r --squash --match-head-commit abc123']);
    const ev = readEvents(root, id);
    const bypassEv = ev.find((e) => e.type === 'pr-merge-bypass');
    assert.equal(bypassEv.number, 7);
    assert.equal(bypassEv.checks, 'failing');
    assert.equal(ev.find((e) => e.type === 'pr-merged').bypass, true);
    const types = ev.map((e) => e.type);
    assert.ok(types.indexOf('pr-merge-bypass') < types.indexOf('pr-merged'), 'override logged before the merge');
    // --now is a person's call: the bypass and its merge say who made it.
    const TEST_ACTOR = { login: 'forge-test', source: 'env' };
    assert.deepEqual(bypassEv.actor, TEST_ACTOR);
    assert.deepEqual(ev.find((e) => e.type === 'pr-merged').actor, TEST_ACTOR);

    id = scenario({ checks: 'passing' });
    mergePr(root, h.config, id, { now: true });
    assert.equal(readEvents(root, id).find((e) => e.type === 'pr-merged').bypass, false, '--now on green CI is not a bypass');

    id = scenario({ state: 'MERGED', checks: 'passing' });
    assert.deepEqual(mergePr(root, h.config, id), { merged: true, action: 'already-merged', checks: 'passing' });
    assert.deepEqual(h.merges(), []);
    assert.ok(!h.events(id).includes('pr-merged'));

    id = scenario({ state: 'CLOSED' });
    assert.throws(() => mergePr(root, h.config, id), /PR #7 is closed; reopen it before merging/);
    assert.deepEqual(h.merges(), []);
  } finally {
    h.done();
  }
});

test('mergePr never queues --auto under a protected-paths policy', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    let id = h.scenario({ checks: 'pending', mergeState: 'BLOCKED', pushedSha: 'abc123' });
    assert.deepEqual(mergePr(root, h.config, id), { merged: false, autoMerge: false, action: 'deferred', checks: 'pending', mergeState: 'BLOCKED' });
    assert.deepEqual(h.merges(), [], 'GitHub never gets a queued merge it could land on a later head');
    assert.equal(readEvents(root, id).find((e) => e.type === 'pr-merge-deferred')?.reason, 'protected');
    // Once CI passes, the retry merges directly, pinned to the head pr open checked.
    id = h.scenario({ checks: 'passing', pushedSha: 'abc123' });
    assert.equal(mergePr(root, h.config, id).action, 'merged');
    assert.deepEqual(h.merges(), ['pr merge 7 -R o/r --squash --match-head-commit abc123']);
  } finally {
    h.done();
  }
});

test('mergePr refuses a PR head forge pr open did not check', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  const [checked, pushed] = ['a'.repeat(40), 'b'.repeat(40)];
  try {
    const root = h.repo.dir;
    // Pushed after the last pr open, by plain git or a stale session.
    let id = h.scenario({ checks: 'passing', head: pushed, pushedSha: checked });
    assert.throws(() => mergePr(root, h.config, id), (e: any) => e.code === 'protected_path' && /forge pr open checked/.test(e.message));
    assert.deepEqual(h.merges(), [], 'no merge call');
    const ev = readEvents(root, id).find((e) => e.type === 'pr-merge-refused');
    assert.deepEqual([ev?.head, ev?.pushedSha, ev?.reason], [pushed, checked, 'protected']);
    // No pushedSha recorded: nothing was checked either.
    id = h.scenario({ checks: 'passing', head: pushed });
    assert.throws(() => mergePr(root, h.config, id), (e: any) => e.code === 'protected_path');
    // A human's --now overrides it, and the merge stays pinned to the head it saw.
    id = h.scenario({ checks: 'passing', head: pushed, pushedSha: checked });
    assert.equal(mergePr(root, h.config, id, { now: true }).action, 'merged');
    assert.deepEqual(h.merges(), [`pr merge 7 -R o/r --squash --match-head-commit ${pushed}`]);
    // The checked head merges, and with the policy off the head check doesn't apply.
    id = h.scenario({ checks: 'passing', head: checked, pushedSha: checked });
    assert.equal(mergePr(root, h.config, id).action, 'merged');
    h.config.policy.protectedPaths = [];
    id = h.scenario({ checks: 'passing', head: pushed, pushedSha: checked });
    assert.equal(mergePr(root, h.config, id).action, 'merged');
  } finally {
    h.done();
  }
});

test('forge pr merge: refused exits 1, --now must not swallow the id', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
    const answers = path.join(h.bin, 'answers.json');
    fs.writeFileSync(answers, JSON.stringify({ worktrees: { root: `../${path.basename(root)}.wt` } }));
    const forge = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: root } });
    assert.equal(forge('init', 'write', '--answers', answers).status, 0);

    // pushedSha is the head the stub reports: the PR forge pr open pushed and checked.
    const id = h.scenario({ checks: 'failing', pushedSha: 'abc123' });
    const r = forge('pr', 'merge', id);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(r.stdout).action, 'refused');
    assert.deepEqual(h.merges(), []);

    const swallowed = forge('pr', 'merge', '--now', id);
    assert.notEqual(swallowed.status, 0);
    assert.deepEqual(h.merges(), [], '`--now <id>` errors instead of bypassing');

    const later = h.scenario({ checks: 'pending', mergeState: 'UNSTABLE', pushedSha: 'abc123' });
    forge('job', 'set', later, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    const deferred = forge('pr', 'merge', later);
    assert.equal(deferred.status, 0, deferred.stderr);
    assert.equal(JSON.parse(deferred.stdout).action, 'deferred');
    const synced = JSON.parse(forge('sync').stdout);
    const row = (jobId) => synced.results.find((r) => r.id === jobId);
    assert.equal(row(later)?.mergeDeferred, true, 'sync surfaces a deferred merge for retry');
    assert.equal(row(id)?.mergeDeferred, false, 'a refused merge is not retried by sync');

    const bypass = forge('pr', 'merge', id, '--now');
    assert.equal(bypass.status, 0, bypass.stderr);
    assert.equal(JSON.parse(bypass.stdout).action, 'merged');
    assert.ok(h.events(id).includes('pr-merge-bypass'));
  } finally {
    fs.rmSync(path.join(h.repo.dir, '..', `${path.basename(h.repo.dir)}.wt`), { recursive: true, force: true });
    h.done();
  }
});

test('findPr refuses to adopt a PR with an unsafe ref name', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    const identity = (id: string) => {
      const j = loadJob(root, id);
      return { branch: j.branch, base: j.base, pr: j.pr };
    };
    const cases = [
      ['headRefName', { FAKE_HEAD_REF: 'x;id' }, 'x;id'],
      ['baseRefName', { FAKE_BASE_REF: 'main$(id)' }, 'main$(id)'],
    ] as const;
    for (const [field, env, value] of cases) {
      for (const linked of [true, false]) {
        const id = h.scenario();
        // Unlinked, the PR is found by branch (`gh pr list`) and would be adopted.
        if (!linked) setJob(root, id, { fields: { pr: null } });
        Object.assign(process.env, { FAKE_HEAD_REF: '', FAKE_BASE_REF: '' }, env);
        const before = identity(id);
        assert.throws(() => findPr(root, h.config, id), new RegExp(`unsafe ${field}`));
        assert.deepEqual(identity(id), before, `${field} linked=${linked}: branch, base and pr unchanged`);
        const evs = readEvents(root, id);
        const refused = evs.filter((e) => e.type === 'pr-adopt-refused');
        assert.deepEqual(refused.map((e) => [e.number, e.field]), [[7, field]]);
        assert.ok(!evs.some((e) => e.type === 'pr-adopted'));
        assert.ok(!JSON.stringify(refused).includes(value), 'the raw value is never logged');
      }
    }
    Object.assign(process.env, { FAKE_HEAD_REF: '', FAKE_BASE_REF: '' });
    const id = h.scenario();
    setJob(root, id, { fields: { pr: null } });
    assert.equal(findPr(root, h.config, id).headRefName, 'forge/x', 'safe refs are still adopted');
    assert.equal(loadJob(root, id).branch, 'forge/x');
    assert.ok(h.events(id).includes('pr-adopted'));
  } finally {
    h.done();
  }
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const PARKED = { stage: 'pr', state: 'waiting', waitingOn: 'pr-review' };
const lastSynced = (root: string, id: string) => readEvents(root, id).filter((e) => e.type === 'pr-synced').at(-1)!;
const where = (root: string, id: string) => {
  const j = loadJob(root, id);
  return [j.stage, j.state, j.waitingOn];
};

test('syncPr routes a conflicting PR to integrate under pr.conflicts: fix', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    h.config.pr.conflicts = 'fix';
    const id = h.scenario({ mergeable: 'CONFLICTING', head: SHA_A, pushedSha: SHA_A, at: PARKED });
    const r = syncPr(root, h.config, id);
    assert.equal(r.integrate, true);
    assert.equal(r.pr?.integrateFor, SHA_A);
    const j = loadJob(root, id);
    assert.deepEqual([j.stage, j.state, j.waitingOn], ['integrate', 'running', null]);
    assert.equal(j.pr?.integrateFor, SHA_A);
    assert.equal(j.owner, null, 'sync claims nothing');
    assert.equal(j.reason, 'forge sync: PR #7 conflicts with its base (pr.conflicts: fix)');
    assert.equal(lastSynced(root, id).integrate, true);
  } finally {
    h.done();
  }
});

test('syncPr keeps the conflicts gate under ask and defers under defer', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    h.config.pr.conflicts = 'ask';
    let id = h.scenario({ mergeable: 'CONFLICTING', head: SHA_A, pushedSha: SHA_A, at: PARKED });
    let r = syncPr(root, h.config, id);
    assert.deepEqual(where(root, id), ['pr', 'waiting', 'conflicts']);
    assert.ok(!('integrate' in r), 'no integrate key on the result');
    assert.ok(!('integrateFor' in (loadJob(root, id).pr ?? {})));
    assert.ok(!('integrate' in lastSynced(root, id)), 'no integrate key on the event');

    h.config.pr.conflicts = 'defer';
    id = h.scenario({ mergeable: 'CONFLICTING', head: SHA_A, pushedSha: SHA_A, at: PARKED });
    const notes = () => readEvents(root, id).filter((e) => e.type === 'note').map((e) => e.text);
    r = syncPr(root, h.config, id);
    assert.ok(!('integrate' in r));
    assert.deepEqual(where(root, id), ['pr', 'waiting', 'pr-review']);
    assert.deepEqual(notes(), ['conflicts with base deferred by pr.conflicts']);
    syncPr(root, h.config, id);
    assert.deepEqual(where(root, id), ['pr', 'waiting', 'pr-review']);
    assert.deepEqual(notes(), ['conflicts with base deferred by pr.conflicts'], 'the same conflict adds no second note');
  } finally {
    h.done();
  }
});

test('syncPr routes a PR that is only behind under every policy', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    for (const policy of ['ask', 'fix', 'defer'] as const) {
      h.config.pr.conflicts = policy;
      h.behind(2);
      let id = h.scenario({ head: SHA_A, pushedSha: SHA_A, at: PARKED });
      const r = syncPr(root, h.config, id);
      assert.equal(r.integrate, true, policy);
      assert.equal(r.pr?.behindBy, 2);
      assert.deepEqual(where(root, id), ['integrate', 'running', null], policy);
      assert.equal(loadJob(root, id).reason, 'forge sync: PR #7 is 2 commits behind its base');
      for (const by of [0, null]) {
        h.behind(by);
        id = h.scenario({ head: SHA_A, pushedSha: SHA_A, at: PARKED });
        const s = syncPr(root, h.config, id);
        assert.equal(s.pr?.behindBy, by, `${policy} behindBy ${by}`);
        assert.ok(!('integrate' in s));
        assert.deepEqual(where(root, id), ['pr', 'waiting', 'pr-review'], `${policy} behindBy ${by}`);
      }
    }
  } finally {
    h.done();
  }
});

test('syncPr never routes a head Forge did not push', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    h.config.pr.conflicts = 'fix';
    const heads = [
      ['a foreign push', { head: SHA_A, pushedSha: SHA_B }],
      ['no pushedSha', { head: SHA_A }],
      ['a non-sha head', { head: 'abc123', pushedSha: 'abc123' }],
    ] as const;
    for (const [what, hd] of heads) {
      h.behind(null);
      let id = h.scenario({ ...hd, mergeable: 'CONFLICTING', at: PARKED });
      let r = syncPr(root, h.config, id);
      assert.ok(!('integrate' in r), what);
      assert.deepEqual(where(root, id), ['pr', 'waiting', 'conflicts'], `${what}: conflicting under fix`);
      assert.equal(loadJob(root, id).pr?.humanDelta, undefined, `${what}: no humanDelta while open`);
      h.behind(2);
      id = h.scenario({ ...hd, at: PARKED });
      r = syncPr(root, h.config, id);
      assert.ok(!('integrate' in r), what);
      assert.deepEqual(where(root, id), ['pr', 'waiting', 'pr-review'], `${what}: behind only`);
      assert.ok(!('integrateFor' in (loadJob(root, id).pr ?? {})));
      assert.equal(loadJob(root, id).pr?.humanDelta, undefined);
    }
  } finally {
    h.done();
  }
});

test('syncPr respects a live claim and never routes a running or finished job', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    h.config.pr.conflicts = 'fix';
    let id = h.scenario({ mergeable: 'CONFLICTING', head: SHA_A, pushedSha: SHA_A, at: PARKED, owner: 'session-1' });
    const owner = loadJob(root, id).owner;
    assert.ok(!('integrate' in syncPr(root, h.config, id)));
    assert.deepEqual(where(root, id), ['pr', 'waiting', 'conflicts'], 'a live owner blocks routing');
    assert.deepEqual(loadJob(root, id).owner, owner, 'the owner is unchanged');

    h.behind(2);
    id = h.scenario({ head: SHA_A, pushedSha: SHA_A, at: PARKED, owner: 'session-1' });
    assert.ok(!('integrate' in syncPr(root, h.config, id)));
    assert.deepEqual(where(root, id), ['pr', 'waiting', 'pr-review'], 'behind only, live owner');

    id = h.scenario({ head: SHA_A, pushedSha: SHA_A, at: PARKED, owner: 'session-1' });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    updateJob(root, id, (j) => Object.assign(j.owner!, { since: old, heartbeat: old }));
    const stale = loadJob(root, id).owner;
    assert.equal(syncPr(root, h.config, id).integrate, true, 'a stale owner does not block');
    assert.deepEqual(where(root, id), ['integrate', 'running', null]);
    assert.deepEqual(loadJob(root, id).owner, stale, 'sync claims nothing, even from a stale owner');

    for (const state of ['running', 'failed', 'cancelled']) {
      id = h.scenario({ head: SHA_A, pushedSha: SHA_A, at: { stage: 'pr', state } });
      const r = syncPr(root, h.config, id);
      assert.ok(!('integrate' in r), state);
      assert.equal(loadJob(root, id).stage, 'pr', `${state}: never moved to integrate`);
      assert.ok(!('integrateFor' in (loadJob(root, id).pr ?? {})));
    }
    assert.equal(loadJob(root, id).state, 'waiting', 'the park still applies to any non-running state, as before');
  } finally {
    h.done();
  }
});

test('syncPr routes a head once and a new head clears integrateFor', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    h.behind(2);
    const id = h.scenario({ head: SHA_A, pushedSha: SHA_A, at: PARKED });
    assert.equal(syncPr(root, h.config, id).integrate, true);
    assert.equal(loadJob(root, id).pr?.integrateFor, SHA_A);

    // The integration came back to pr on the same head (say it failed): the head was routed already.
    setJob(root, id, PARKED);
    assert.ok(!('integrate' in syncPr(root, h.config, id)));
    assert.deepEqual(where(root, id), ['pr', 'waiting', 'pr-review']);
    assert.equal(loadJob(root, id).pr?.integrateFor, SHA_A, 'the routed head is kept');

    // Forge pushed a new head, which is still behind: routed again.
    setJob(root, id, { fields: { 'pr.pushedSha': SHA_B } });
    process.env.FAKE_HEAD_OID = SHA_B;
    assert.equal(syncPr(root, h.config, id).integrate, true);
    assert.equal(loadJob(root, id).pr?.integrateFor, SHA_B);

    // A head nobody routed (a human push) removes the key.
    setJob(root, id, PARKED);
    process.env.FAKE_HEAD_OID = SHA_C;
    assert.ok(!('integrate' in syncPr(root, h.config, id)));
    assert.ok(!('integrateFor' in (loadJob(root, id).pr ?? {})));
  } finally {
    h.done();
  }
});

test('syncTransition matrix', () => {
  const cfg = (conflicts: 'ask' | 'fix' | 'defer') => ({ pr: { ...defaults().pr, conflicts } });
  const base = { number: 7, url: 'u', state: 'OPEN', isDraft: false, lastSyncedAt: 't' } as JobPr;
  type J = Pick<Job, 'stage' | 'state' | 'waitingOn' | 'pr'>;
  const at = (j: Partial<J> = {}, prev: Partial<JobPr> = {}): J => ({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', ...j, pr: { ...base, pushedSha: SHA_A, ...prev } } as J);
  const gh = (o: Partial<JobPr> = {}) => ({ headOid: SHA_A, mergeable: 'MERGEABLE', behindBy: 0, ...o });
  const CONFLICT = { mergeable: 'CONFLICTING', behindBy: 1 };
  const BEHIND = { behindBy: 3 };
  const fixR = { stage: 'integrate', state: 'running', waitingOn: null, reason: 'forge sync: PR #7 conflicts with its base (pr.conflicts: fix)' };
  const behindR = { stage: 'integrate', state: 'running', waitingOn: null, reason: 'forge sync: PR #7 is 3 commits behind its base' };
  const conflictsPark = { state: 'waiting', waitingOn: 'conflicts' };
  const reviewPark = { state: 'waiting', waitingOn: 'pr-review' };
  const deferNote = { state: 'waiting', waitingOn: 'pr-review', note: 'conflicts with base deferred by pr.conflicts' };
  // [name, policy, job, gh fields, route, ownerLive, want change, integrate, integrateFor, ownerLive calls]
  const rows: [string, 'ask' | 'fix' | 'defer', J, Partial<JobPr>, boolean, boolean, object, boolean, string | null, number][] = [
    ['ask conflicting parks on conflicts', 'ask', at(), CONFLICT, true, false, conflictsPark, false, null, 0],
    ['fix conflicting routes', 'fix', at(), CONFLICT, true, false, fixR, true, SHA_A, 1],
    ['defer conflicting defers with a note', 'defer', at(), CONFLICT, true, false, deferNote, false, null, 0],
    ['defer, conflict already seen: no note', 'defer', at({}, { conflicts: true }), CONFLICT, true, false, reviewPark, false, null, 0],
    ['ask behind routes', 'ask', at(), BEHIND, true, false, behindR, true, SHA_A, 1],
    ['fix behind routes', 'fix', at(), BEHIND, true, false, behindR, true, SHA_A, 1],
    ['defer behind routes', 'defer', at(), BEHIND, true, false, behindR, true, SHA_A, 1],
    ['one commit behind reads singular', 'ask', at(), { behindBy: 1 }, true, false, { ...behindR, reason: 'forge sync: PR #7 is 1 commit behind its base' }, true, SHA_A, 1],
    ['ask neither parks on review', 'ask', at(), {}, true, false, reviewPark, false, null, 0],
    ['fix neither parks on review', 'fix', at(), {}, true, false, reviewPark, false, null, 0],
    ['defer neither parks on review', 'defer', at(), {}, true, false, reviewPark, false, null, 0],
    ['behindBy null is not behind', 'fix', at(), { behindBy: null }, true, false, reviewPark, false, null, 0],
    ['from conflicts, fix routes', 'fix', at({ waitingOn: 'conflicts' }), CONFLICT, true, false, fixR, true, SHA_A, 1],
    ['foreign head', 'fix', at({}, { pushedSha: SHA_B }), CONFLICT, true, false, conflictsPark, false, null, 0],
    ['no pushedSha', 'fix', at({}, { pushedSha: undefined }), BEHIND, true, false, reviewPark, false, null, 0],
    ['non-sha head', 'fix', at({}, { pushedSha: 'abc123' }), { ...BEHIND, headOid: 'abc123' }, true, false, reviewPark, false, null, 0],
    ['repeated head', 'fix', at({}, { integrateFor: SHA_A }), CONFLICT, true, false, conflictsPark, false, SHA_A, 0],
    ['live owner', 'fix', at(), CONFLICT, true, true, conflictsPark, false, null, 1],
    ['live owner, behind', 'ask', at(), BEHIND, true, true, reviewPark, false, null, 1],
    ['route: false', 'fix', at(), CONFLICT, false, false, conflictsPark, false, null, 0],
    ['running', 'fix', at({ state: 'running', waitingOn: null }), CONFLICT, true, false, {}, false, null, 0],
    ['failed', 'fix', at({ state: 'failed', waitingOn: null }), CONFLICT, true, false, conflictsPark, false, null, 0],
    ['blocked', 'ask', at({ state: 'blocked', waitingOn: null }), BEHIND, true, false, reviewPark, false, null, 0],
    ['waiting on escalation', 'ask', at({ waitingOn: 'escalation' }), BEHIND, true, false, reviewPark, false, null, 0],
    ['done at pr', 'fix', at({ state: 'done', waitingOn: null }), CONFLICT, true, false, conflictsPark, false, null, 0],
    ['cancelled at pr', 'ask', at({ state: 'cancelled', waitingOn: null }), BEHIND, true, false, reviewPark, false, null, 0],
    ['another stage', 'fix', at({ stage: 'integrate', state: 'running', waitingOn: null }, { integrateFor: SHA_A }), CONFLICT, true, false, {}, false, SHA_A, 0],
    ['a new head drops integrateFor', 'ask', at({}, { integrateFor: SHA_B }), {}, true, false, reviewPark, false, null, 0],
    ['merged', 'fix', at({}, { integrateFor: SHA_A }), { ...BEHIND, state: 'MERGED' }, true, false, { stage: 'done', state: 'done', reason: 'PR merged' }, false, SHA_A, 0],
    ['closed', 'fix', at(), { ...CONFLICT, state: 'CLOSED' }, true, false, { state: 'cancelled', reason: 'PR closed without merging' }, false, null, 0],
  ];
  for (const [name, policy, j, fields, route, live, change, integrate, integrateFor, calls] of rows) {
    let n = 0;
    const merged = { ...j.pr!, ...gh(fields) } as JobPr;
    const t = syncTransition(j, merged, cfg(policy), { route, ownerLive: () => (n++, live) });
    assert.deepEqual(t, { change, integrate, integrateFor }, name);
    assert.equal(n, calls, `${name}: ownerLive calls`);
  }
});

test('mergePr syncs without routing', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    h.config.pr.conflicts = 'fix';
    const id = h.scenario({ mergeable: 'CONFLICTING', head: SHA_A, pushedSha: SHA_A, at: PARKED, checks: 'failing' });
    mergePr(root, h.config, id);
    assert.deepEqual(where(root, id), ['pr', 'waiting', 'conflicts']);
    assert.ok(!('integrateFor' in (loadJob(root, id).pr ?? {})));
    assert.ok(!('integrate' in lastSynced(root, id)));
  } finally {
    h.done();
  }
});

test('a routed job is handed to the daemon once', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    const resumes = (id: string) => listRequests(root, { status: 'pending' }).filter((r) => r.job === id);
    h.config.daemon.enabled = true;
    h.behind(2);
    const id = h.scenario({ head: SHA_A, pushedSha: SHA_A, at: PARKED });
    assert.equal(syncPr(root, h.config, id).integrate, true);
    const [req, ...more] = resumes(id);
    assert.equal(more.length, 0);
    assert.deepEqual([req.type, req.job, req.from, req.text], ['resume', id, 'sync', 'forge sync moved this job to integrate']);

    // Routed again on a new head while that request is still pending: no second request.
    setJob(root, id, { ...PARKED, fields: { 'pr.pushedSha': SHA_B } });
    process.env.FAKE_HEAD_OID = SHA_B;
    assert.equal(syncPr(root, h.config, id).integrate, true);
    assert.equal(resumes(id).length, 1);

    const foreign = h.scenario({ head: SHA_A, pushedSha: SHA_B, at: PARKED });
    assert.ok(!('integrate' in syncPr(root, h.config, foreign)));
    assert.equal(resumes(foreign).length, 0, 'a job that was not routed gets none');

    h.config.daemon.enabled = false;
    const off = h.scenario({ head: SHA_A, pushedSha: SHA_A, at: PARKED });
    assert.equal(syncPr(root, h.config, off).integrate, true);
    assert.equal(resumes(off).length, 0, 'daemon off: nothing queued');
  } finally {
    h.done();
  }
});

test('forge sync lists routed jobs under integrating', { skip: process.platform === 'win32' }, async () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;
    h.config.tracker.kind = 'local';
    h.behind(2);
    const id = h.scenario({ head: SHA_A, pushedSha: SHA_A, at: PARKED });
    const first = await syncAll(root, h.config);
    assert.deepEqual(first.integrating, [id]);
    assert.deepEqual(Object.keys(first).sort(), ['integrating', 'requests', 'results', 'synced']);
    assert.equal(first.synced, 1);
    assert.equal((first.results[0] as any).behindBy, 2);
    const second = await syncAll(root, h.config);
    assert.deepEqual(second.integrating, [], 'a job already at integrate is not routed again');
    assert.equal(second.requests, 0);
  } finally {
    h.done();
  }
});
