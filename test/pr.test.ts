import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { mergeAction, hasCiWorkflows, mergePr } from '../lib/pr.ts';
import { defaults } from '../lib/config.ts';
import { createJob, setJob, readEvents } from '../lib/jobs.ts';

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
  "pr view") printf '{"number":7,"url":"https://github.com/o/r/pull/7","state":"%s","isDraft":false,"headRefOid":"abc123","mergeable":"MERGEABLE","mergeStateStatus":"%s","reviewDecision":"","statusCheckRollup":%s,"mergedAt":null,"closedAt":null,"headRefName":"forge/x","baseRefName":"main"}' "$FAKE_PR_STATE" "$FAKE_MERGE_STATE" "$FAKE_ROLLUP" ;;
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
  /** @param {{state?:string, checks?:keyof typeof ROLLUP, mergeState?:string, fail?:boolean}} s */
  const scenario = ({ state = 'OPEN', checks = 'passing', mergeState = 'CLEAN', fail = false } = {}) => {
    const job = createJob(repo.dir, config, { title: `job ${++n}`, ref: `job-${n}` });
    setJob(repo.dir, job.id, { fields: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } });
    fs.writeFileSync(log, '');
    Object.assign(process.env, {
      PATH: `${bin}${path.delimiter}${saved.PATH}`,
      FAKE_GH_LOG: log,
      FAKE_PR_STATE: state,
      FAKE_MERGE_STATE: mergeState,
      FAKE_ROLLUP: JSON.stringify(ROLLUP[checks]),
      FAKE_MERGE_FAIL: fail ? '1' : '',
    });
    return job.id;
  };
  const merges = () => fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('pr merge'));
  const events = (id) => readEvents(repo.dir, id).map((e) => e.type);
  const done = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(bin, { recursive: true, force: true });
    repo.cleanup();
  };
  return { repo, config, bin, scenario, merges, events, done };
}

test('mergePr: one merge call chosen by CI state, never a fallback', { skip: process.platform === 'win32' }, () => {
  const h = ghHarness();
  try {
    const root = h.repo.dir;

    let id = h.scenario({ checks: 'passing' });
    assert.deepEqual(mergePr(root, h.config, id), { merged: true, autoMerge: false, action: 'merged', checks: 'passing' });
    assert.deepEqual(h.merges(), ['pr merge 7 -R o/r --squash --match-head-commit abc123']);
    assert.ok(h.events(id).includes('pr-synced'), 'syncs before deciding');

    id = h.scenario({ checks: 'pending', mergeState: 'BLOCKED' });
    assert.equal(mergePr(root, h.config, id).action, 'auto');
    assert.deepEqual(h.merges(), ['pr merge 7 -R o/r --squash --auto --match-head-commit abc123']);
    assert.ok(h.events(id).includes('pr-auto-merge'));

    // Unprotected repo, CI still running: `gh pr merge --auto` would merge at once here.
    id = h.scenario({ checks: 'pending', mergeState: 'UNSTABLE' });
    assert.deepEqual(mergePr(root, h.config, id), { merged: false, autoMerge: false, action: 'deferred', checks: 'pending', mergeState: 'UNSTABLE' });
    assert.deepEqual(h.merges(), [], 'deferred makes no merge call');
    assert.ok(h.events(id).includes('pr-merge-deferred'));

    id = h.scenario({ checks: 'pending', mergeState: 'BLOCKED', fail: true });
    const failed = mergePr(root, h.config, id);
    assert.equal(failed.action, 'failed');
    assert.match(failed.error, /auto-merge is not allowed/);
    assert.equal(h.merges().length, 1, 'a failed --auto never falls back to a direct merge');
    const failedEv = readEvents(root, id).find((e) => e.type === 'pr-merge-failed');
    assert.equal(failedEv.number, 7);
    assert.match(failedEv.error as any, /auto-merge is not allowed/);

    id = h.scenario({ checks: 'passing', fail: true });
    assert.equal(mergePr(root, h.config, id).action, 'failed');
    assert.ok(h.events(id).includes('pr-merge-failed'));
    assert.deepEqual(h.merges(), ['pr merge 7 -R o/r --squash --match-head-commit abc123'], 'a failed direct merge never falls back to --auto');

    id = h.scenario({ checks: 'failing' });
    const refused = mergePr(root, h.config, id);
    assert.equal(refused.action, 'refused');
    assert.equal(refused.checks, 'failing');
    assert.deepEqual(h.merges(), []);
    assert.ok(h.events(id).includes('pr-merge-refused'));
    assert.ok(!h.events(id).includes('pr-merged'));

    id = h.scenario({ checks: 'none' });
    assert.equal(mergePr(root, h.config, id).action, 'merged', 'no checks and no workflows: nothing to wait for');
    const wf = path.join(root, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'ci.yml'), 'on: push\n');
    id = h.scenario({ checks: 'none', mergeState: 'BLOCKED' });
    assert.equal(mergePr(root, h.config, id).action, 'auto', 'workflows exist but have not reported yet');
    id = h.scenario({ checks: 'none', mergeState: 'CLEAN' });
    assert.equal(mergePr(root, h.config, id).action, 'deferred', 'unregistered workflows on an unprotected repo');
    assert.deepEqual(h.merges(), []);
    fs.rmSync(path.join(root, '.github'), { recursive: true });

    id = h.scenario({ checks: 'failing' });
    assert.equal(mergePr(root, h.config, id, { now: true }).action, 'merged');
    assert.deepEqual(h.merges(), ['pr merge 7 -R o/r --squash --match-head-commit abc123']);
    const ev = readEvents(root, id);
    const bypassEv = ev.find((e) => e.type === 'pr-merge-bypass');
    assert.equal(bypassEv.number, 7);
    assert.equal(bypassEv.checks, 'failing');
    assert.equal(ev.find((e) => e.type === 'pr-merged').bypass, true);
    const types = ev.map((e) => e.type);
    assert.ok(types.indexOf('pr-merge-bypass') < types.indexOf('pr-merged'), 'override logged before the merge');

    id = h.scenario({ checks: 'passing' });
    mergePr(root, h.config, id, { now: true });
    assert.equal(readEvents(root, id).find((e) => e.type === 'pr-merged').bypass, false, '--now on green CI is not a bypass');

    id = h.scenario({ state: 'MERGED', checks: 'passing' });
    assert.deepEqual(mergePr(root, h.config, id), { merged: true, action: 'already-merged', checks: 'passing' });
    assert.deepEqual(h.merges(), []);
    assert.ok(!h.events(id).includes('pr-merged'));

    id = h.scenario({ state: 'CLOSED' });
    assert.throws(() => mergePr(root, h.config, id), /PR #7 is closed; reopen it before merging/);
    assert.deepEqual(h.merges(), []);
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

    const id = h.scenario({ checks: 'failing' });
    const r = forge('pr', 'merge', id);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(r.stdout).action, 'refused');
    assert.deepEqual(h.merges(), []);

    const swallowed = forge('pr', 'merge', '--now', id);
    assert.notEqual(swallowed.status, 0);
    assert.deepEqual(h.merges(), [], '`--now <id>` errors instead of bypassing');

    const later = h.scenario({ checks: 'pending', mergeState: 'UNSTABLE' });
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
