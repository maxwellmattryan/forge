// lib/commands/render/{pr,worktree,verify,backing}.ts: git, PR and service commands in human mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backingStatus } from '../lib/cli/commands/render/backing.ts';
import { prMerge, prOpen, prSync } from '../lib/cli/commands/render/pr.ts';
import { verify } from '../lib/cli/commands/render/verify.ts';
import { worktreeCreate, worktreeRemove } from '../lib/cli/commands/render/worktree.ts';
import { HOSTILE, assertSafe, hasLines, plain } from './render-helpers.ts';

const URL = 'https://github.com/o/r/pull/12';

test('pr open: opened, already open, no PR, repos and deferred', () => {
  assert.equal(plain(prOpen, { number: 12, url: URL, created: true }), `opened PR #12 ${URL}`);
  assert.equal(plain(prOpen, { number: 12, url: URL, created: false, unlinked: true }), `PR #12 already open ${URL} (unlinked)`);
  assert.equal(plain(prOpen, { number: null, url: null, created: false }), 'no PR (pr.enabled is off or nothing to push)');
  const out = plain(prOpen, { number: 12, url: URL, created: true, repos: [{ repo: 'o/lib', number: 4, url: 'https://github.com/o/lib/pull/4', created: true }], deferred: [{ repo: 'o/app', reason: 'waits on o/lib' }] });
  hasLines(out, 'Repos', '  ✓ o/lib #4 https://github.com/o/lib/pull/4', 'Deferred', '  {"repo":"o/app","reason":"waits on o/lib"}');
});

test('pr sync: fields, integrate, reopened, no PR', () => {
  const pr = { number: 12, url: URL, state: 'OPEN', isDraft: false, lastSyncedAt: 'x', checks: { state: 'failing', passing: 1, failing: 1, pending: 0 }, behindBy: 3, conflicts: true, unresolvedThreads: 2, reviewDecision: 'CHANGES_REQUESTED' };
  hasLines(plain(prSync, { id: 'j', pr, integrate: true, reopen: true }), '#12 OPEN', 'checks     failing', 'behind     3', 'conflicts  true', 'threads    2', 'review     CHANGES_REQUESTED', '→ moved to integrate', 'reopened');
  assert.equal(plain(prSync, { id: 'j', pr: null }), 'j: no PR');
});

test('pr merge: every action, plus parts', () => {
  const m = (o: Record<string, unknown>) => plain(prMerge, { merged: false, checks: 'passing', ...o });
  assert.equal(m({ action: 'merged', merged: true }), '✓ merged');
  assert.equal(m({ action: 'already-merged', merged: true }), '✓ already merged');
  assert.equal(m({ action: 'auto', autoMerge: true }), 'auto-merge on: GitHub merges when checks pass');
  assert.equal(m({ action: 'deferred', checks: 'pending', mergeState: 'BLOCKED' }), 'deferred: checks pending, merge state BLOCKED');
  assert.equal(m({ action: 'refused', error: 'o/lib#4 is not merged', reason: 'order' }), '✗ refused: o/lib#4 is not merged (order)');
  assert.equal(m({ action: 'refused', error: 'checks are failing' }), '✗ refused: checks are failing');
  assert.equal(m({ action: 'failed', error: 'gh: merge failed\nbranch protection' }), '✗ failed: gh: merge failed\n          branch protection');
  const parts = [
    { repo: 'o/lib', number: 4, action: 'merged', checks: 'passing' },
    { repo: null, number: 12, action: 'refused', checks: 'failing', error: 'checks fail' },
  ];
  hasLines(m({ action: 'refused', error: 'checks fail', parts }), 'Parts', '  repo   number  action   checks   error', '  o/lib  #4      merged   passing  -', '  -      #12     refused  failing  checks fail');
  assert.equal(m({ action: 'teleported' }), null);
});

test('worktree create: created with a failed setup step, and existing', () => {
  const out = plain(worktreeCreate, {
    path: '/w/j',
    created: true,
    port: 4100,
    ports: { web: 4100 },
    base: 'main',
    stackedOn: 'forge/dep',
    backing: [{ name: 'db', isolation: 'job', action: 'created', ok: true }, { name: 'cache', isolation: 'job', action: 'none', ok: false, error: 'docker is not running' }],
    setup: [{ cmd: 'npm ci', ok: true, tail: 'added 10 packages' }, { cmd: 'npm run build', ok: false, tail: 'error TS2304\nfound 1 error\n' }],
    ok: false,
    repos: [{ repo: 'o/lib', path: '/w/lib', created: true, ok: true }, { repo: 'o/app', path: null, created: false, ok: false, error: 'no clone' }],
  });
  hasLines(out, 'created /w/j', 'stacked on  forge/dep', 'ports       web 4100', '  ✓ npm ci', '  ✗ npm run build', '    error TS2304', '    found 1 error', '  ✗ cache  none', '    docker is not running', '  ✗ o/app  -', '    no clone');
  hasLines(plain(worktreeCreate, { path: '/w/j', created: false, port: null, ports: {} }), 'exists /w/j', 'stacked on  -', 'ports       -');
});

test('worktree remove: with repos and backing, and nothing', () => {
  const out = plain(worktreeRemove, { removed: '/w/j', repos: [{ repo: 'o/lib', removed: '/w/lib' }, { repo: 'o/app', removed: null, error: 'dirty' }], backing: { removed: ['db', 'cache'], volumes: ['dbdata'], ok: false, error: 'docker rm failed' } });
  hasLines(out, 'removed /w/j', '  ✗ o/app  -', '    dirty', '  removed: db, cache', '  volumes: dbdata', '  ✗ docker rm failed');
  assert.equal(plain(worktreeRemove, { removed: null }), 'nothing to remove');
  const reposOnly = plain(worktreeRemove, { removed: null, repos: [{ repo: 'o/lib', removed: '/w/lib' }] });
  hasLines(reposOnly, '  ✓ o/lib  /w/lib');
  assert.ok(!reposOnly!.includes('nothing to remove'), 'repos alone are something removed');
});

const SHA = '0123456789abcdef0123456789abcdef01234567';
const gates = { integrity: { mode: 'warn', ok: true, base: 'abc', findings: 0, blocking: 0, deletedTests: [], renamedTests: [], skipMarkers: [], testCount: { before: 1, after: 1, delta: 0 }, configEdits: [], linkOverrides: [], more: 0 }, secrets: { mode: 'block', ok: true, count: 0, allowed: 0, findings: [], more: 0 }, protected: { ok: true, refused: [], escalated: [], more: 0 } };
const GATES = [
  'Gates',
  '  integrity  ✓ {"mode":"warn","base":"abc","findings":0,"blocking":0,"deletedTests":[],"renamedTests":[],"skipMarkers":[],"testCount":{"before":1,"after":1,"delta":0},"configEdits":[],"linkOverrides":[],"more":0}',
  '  secrets    ✓ {"mode":"block","count":0,"allowed":0,"findings":[],"more":0}',
  '  protected  ✓ {"refused":[],"escalated":[],"more":0}',
  '  budget     -',
];

test('verify: passed (golden)', () => {
  const out = plain(verify, { ok: true, round: 2, attempt: 1, sha: SHA, file: '.forge/jobs/j/verify/round-2.md', steps: [{ name: 'build', ok: true, durationMs: 420 }, { name: 'test', ok: true, durationMs: 12_345 }, { name: 'worktree-clean', ok: true }], failure: undefined, ...gates });
  assert.equal(out, ['✓ verify passed · round 2 attempt 1 · 0123456', '', 'Steps', '  ✓ build  420ms', '  ✓ test  12.3s', '  ✓ worktree-clean', '', ...GATES, '', 'file .forge/jobs/j/verify/round-2.md'].join('\n'));
});

test('verify: failed with a tail and log, a skipped step, repos and downstream', () => {
  const failure = { name: 'test', ok: false, exit: 1, tail: 'not ok 3 - adds\n  expected 2\n', log: 'logs/test.log' };
  const out = plain(verify, {
    ok: false,
    round: 1,
    attempt: 2,
    sha: SHA,
    file: 'verify/round-1.md',
    steps: [{ name: 'lint', ok: true, skipped: true, reason: 'no lint command' }, { name: 'test', ok: false, exit: 1, log: 'logs/test.log' }],
    failure,
    ...gates,
    budget: { stopped: true, reason: 'tokens over', exceeded: [] },
    repos: [{ repo: 'o/lib', sha: 'x', ok: false, failure: 'test failed\nsee log' }],
    downstream: [{ repo: 'o/app', ok: true, failure: null }],
  });
  assert.equal(out!.split('\n')[0], '✗ verify failed · round 1 attempt 2 · 0123456');
  hasLines(
    out,
    '  - lint  skipped: no lint command',
    '  ✗ test  exit 1',
    '    not ok 3 - adds',
    '      expected 2',
    '    log logs/test.log',
    '  budget     ✗ {"stopped":true,"reason":"tokens over","exceeded":[]}',
    '  ✗ o/lib',
    '    test failed',
    '    see log',
    'Downstream',
    '  ✓ o/app',
  );
});

test('backing status: with a job, without one, empty', () => {
  const services = [
    { name: 'db', isolation: 'job', container: 'forge-j-db', state: 'running', host: '127.0.0.1', ports: { 5432: 55432 }, env: ['DATABASE_URL', 'PGHOST'] },
    { name: 'search', isolation: 'external', container: null, state: 'external', host: null, ports: {}, env: [] },
  ];
  hasLines(plain(backingStatus, { job: 'j', services }), 'db      job        running   127.0.0.1  5432→55432  DATABASE_URL,PGHOST', 'search  external   external  -          -           -');
  const containers = [
    { name: 'forge-j-db', job: 'j', backing: 'db', isolation: 'job', state: 'running', orphan: false },
    { name: 'forge-old-db', job: null, backing: 'db', isolation: 'job', state: 'stopped', orphan: true },
  ];
  hasLines(plain(backingStatus, { containers }), 'forge-j-db    j    db       running  -', 'forge-old-db  -    db       stopped  orphan');
  assert.equal(plain(backingStatus, { containers: [] }), 'no backing containers');
  assert.equal(plain(backingStatus, { job: 'j', services: [] }), 'no backing services for j');
});

test('pr, worktree, verify and backing: sanitizes untrusted text', () => {
  assertSafe(plain(prOpen, { number: 1, url: HOSTILE, created: true, repos: [{ repo: HOSTILE, number: 2, url: HOSTILE, created: true }], deferred: [HOSTILE] }));
  assertSafe(plain(prSync, { id: 'j', pr: { number: 1, url: HOSTILE, state: HOSTILE, reviewDecision: HOSTILE, checks: { state: HOSTILE } } }));
  assertSafe(plain(prMerge, { action: 'refused', merged: false, checks: undefined, error: HOSTILE, reason: HOSTILE, parts: [{ repo: HOSTILE, number: 1, action: 'failed', checks: HOSTILE, error: HOSTILE }] }));
  assertSafe(plain(prMerge, { action: 'deferred', merged: false, checks: HOSTILE, mergeState: HOSTILE }));
  assertSafe(plain(worktreeCreate, { path: HOSTILE, created: true, port: 1, ports: { [HOSTILE]: 1 }, base: HOSTILE, stackedOn: HOSTILE, setup: [{ cmd: HOSTILE, ok: false, tail: HOSTILE }], backing: [{ name: HOSTILE, action: 'none', ok: false, error: HOSTILE }], ok: false, repos: [{ repo: HOSTILE, path: HOSTILE, ok: false, error: HOSTILE }] }));
  assertSafe(plain(worktreeRemove, { removed: HOSTILE, repos: [{ repo: HOSTILE, removed: HOSTILE, error: HOSTILE }], backing: { removed: [HOSTILE], volumes: [HOSTILE], ok: false, error: HOSTILE } }));
  assertSafe(
    plain(verify, {
      ok: false,
      round: 1,
      attempt: 1,
      sha: HOSTILE,
      file: HOSTILE,
      steps: [{ name: HOSTILE, ok: false, exit: 1 }, { name: 'x', ok: true, skipped: true, reason: HOSTILE }],
      failure: { name: HOSTILE, ok: false, tail: HOSTILE, log: HOSTILE },
      integrity: { mode: 'warn', ok: false, error: HOSTILE },
      secrets: { ok: false, error: HOSTILE },
      protected: { ok: false, refused: [HOSTILE] },
      repos: [{ repo: HOSTILE, ok: false, failure: HOSTILE }],
      downstream: [{ repo: HOSTILE, ok: false, failure: HOSTILE }],
    }),
  );
  assertSafe(plain(backingStatus, { job: HOSTILE, services: [{ name: HOSTILE, isolation: HOSTILE, state: HOSTILE, host: HOSTILE, ports: { [HOSTILE]: 1 }, env: [HOSTILE] }] }));
  assertSafe(plain(backingStatus, { containers: [{ name: HOSTILE, job: HOSTILE, backing: HOSTILE, state: HOSTILE, orphan: true }] }));
});
