// lib/commands/render/job.ts: `forge job list|show|step|claim|note` in human mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobClaim, jobList, jobNote, jobShow, jobStep } from '../lib/commands/render/job.ts';
import { HOSTILE, assertSafe, plain } from './render-helpers.ts';
import type { StepSpawn } from '../lib/types.ts';

const listRow = (o: Record<string, unknown>) => ({ id: 'j', title: 'T', stage: 'build', state: 'running', waitingOn: null, round: 0, pr: null, owner: null, effort: null, ...o });

test('job list: a table, state coloured and waiting shown', () => {
  const rows = [listRow({ id: 'add-login', title: 'Add login', round: 2, pr: 12, owner: 'abcdef1234567', effort: 'high' }), listRow({ id: 'fix-bug', title: 'Fix\nthe bug', stage: 'spec', state: 'waiting', waitingOn: 'spec' })];
  assert.equal(
    plain(jobList, rows),
    ['id         stage  state         round  pr   owner     effort  title', 'add-login  build  running       r2     #12  abcdef12  high    Add login', 'fix-bug    spec   waiting:spec  -      -    -         -       Fix the bug'].join('\n'),
  );
});

test('job list: no rows, with and without --all', () => {
  assert.equal(plain(jobList, []), 'no active jobs');
  assert.equal(plain(jobList, [], { all: true }), 'no jobs');
  assert.equal(plain(jobList, [{ id: 'x' }]), null);
});

const compact = (o: Record<string, unknown> = {}) => ({
  id: 'add-login',
  title: 'Add login',
  kind: 'feature',
  stage: 'review',
  state: 'running',
  waitingOn: null,
  reason: null,
  round: 2,
  maxRounds: 3,
  reviewers: ['code', 'security'],
  lastVerdicts: { code: 'PASS', security: 'CHANGES' },
  verify: null,
  verified: { round: 2, attempt: 1, ok: true, sha: '0123456789abcdef0123456789abcdef01234567' },
  decision: null,
  branch: 'forge/add-login',
  base: 'main',
  worktree: '/w/add-login',
  port: 4100,
  ports: { web: 4100, api: 4101 },
  pr: { number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', checks: 'passing', behindBy: 0, conflicts: false, unresolvedThreads: 1 },
  issues: [],
  noIssue: null,
  effort: 'high',
  owner: 'abcdef1234567',
  progress: { done: 3, total: 5 },
  tokens: 1234567,
  estCostUsd: 4.2,
  ...o,
});

test('job show: with a PR', () => {
  assert.equal(
    plain(jobShow, compact()),
    [
      'add-login  Add login',
      '',
      'Stage',
      '  stage   review',
      '  state   running',
      '  reason  -',
      '  kind    feature',
      '  effort  high',
      '  owner   abcdef1234567',
      '',
      'Rounds',
      '  round      2 of 3',
      '  reviewers  code, security',
      '  verdicts   code PASS, security CHANGES',
      '  verified   ✓ round 2 attempt 1 0123456',
      '  decision   -',
      '',
      'PR',
      '  #12 OPEN https://github.com/o/r/pull/12',
      '  checks     passing',
      '  behind     0',
      '  conflicts  false',
      '  threads    1',
      '',
      'Tasks',
      '  3/5 done',
      '',
      'Paths',
      '  worktree  /w/add-login',
      '  branch    forge/add-login',
      '  base      main',
      '  ports     web 4100, api 4101',
      '',
      'Usage',
      '  tokens  1,234,567',
      '  cost    $4.2',
    ].join('\n'),
  );
});

test('job show: no PR, waiting with a reason, zero tasks', () => {
  const out = plain(jobShow, compact({ state: 'waiting', waitingOn: 'spec', reason: 'spec ready for review', pr: null, progress: { done: 0, total: 0 }, verified: { round: 1, attempt: 2, ok: false, sha: 'fedcba9876' }, lastVerdicts: null, ports: {} }));
  assert.ok(out!.includes('\nStage\n  stage   review\n  state   waiting:spec\n  reason  spec ready for review\n'), out!);
  assert.ok(out!.includes('\n  verdicts   -\n  verified   ✗ round 1 attempt 2 fedcba9\n'), out!);
  assert.ok(out!.includes('\n\nPR\n  none\n\nTasks\n  none\n\n'), out!);
  assert.ok(out!.includes('\n  ports     -\n'), out!);
});

test('job show: --full and other shapes fall back', () => {
  assert.equal(plain(jobShow, { id: 'x', title: 'y', stage: 'build' }), null);
  assert.equal(plain(jobShow, null), null);
});

const spawn = (o: Partial<StepSpawn> = {}): StepSpawn => ({
  id: 'add-login',
  rule: 'RV4',
  action: 'spawn',
  role: 'reviewer',
  agent: 'forge:reviewer',
  lens: 'code',
  model: 'sonnet',
  round: 2,
  output: '.forge/jobs/add-login/review/round-2/code.md',
  start: ['job', 'agent'],
  startShell: 'job agent',
  brief: 'SECRET BRIEF TEXT',
  effort: 'medium',
  ...o,
});

test('job step: spawn, with more lenses', () => {
  const out = plain(jobStep, spawn({ spawns: [spawn({ lens: 'tests' }), spawn({ lens: 'docs' })] }));
  assert.equal(out, ['spawn · rule RV4', 'agent     forge:reviewer', 'role      reviewer/code', 'model     sonnet', 'effort    medium', 'round     2', 'output    .forge/jobs/add-login/review/round-2/code.md', 'parallel  +2 more lenses'].join('\n'));
  assert.ok(!out!.includes('SECRET BRIEF'));
  assert.equal(plain(jobStep, spawn({ role: 'builder', lens: undefined, effort: null, output: undefined })), ['spawn · rule RV4', 'agent   forge:reviewer', 'role    builder', 'model   sonnet', 'effort  -', 'round   2', 'output  -'].join('\n'));
});

test('job step: run', () => {
  assert.equal(plain(jobStep, { id: 'j', rule: 'V1', action: 'run', command: ['verify', 'j'], shell: 'verify j', why: 'the build is committed', tell: 'verifying j' }), ['run · rule V1', 'command  forge verify j', 'why      the build is committed', 'tell     verifying j'].join('\n'));
});

test('job step: wait', () => {
  assert.equal(plain(jobStep, { id: 'j', rule: 'W2', action: 'wait', waitingOn: 'agents', running: ['reviewer:code', 'reviewer:tests'] }), ['wait · rule W2', 'waiting on  agents', 'running     reviewer:code, reviewer:tests', 'tell        -'].join('\n'));
});

test('job step: procedure', () => {
  assert.equal(plain(jobStep, { id: 'j', rule: 'P1', action: 'procedure', reference: 'reference/split.md', why: 'the plan splits' }), ['procedure · rule P1', 'reference  reference/split.md', 'why        the plan splits'].join('\n'));
});

test('job step: done', () => {
  assert.equal(plain(jobStep, { id: 'j', rule: 'D1', action: 'done', state: 'done', tell: 'j is merged' }), ['done · rule D1', 'state  done', 'tell   j is merged'].join('\n'));
  assert.equal(plain(jobStep, { id: 'j', rule: 'X', action: 'dance' }), null);
});

const lease = { driver: 'abcdef1234567', epoch: 2, since: 'x', renewedAt: 'y', expiresAt: 'z' };

test('job claim: plain, overridden dependencies, repo budget', () => {
  assert.equal(plain(jobClaim, { id: 'j', lease, epoch: 2 }), 'claimed j for session abcdef12 at epoch 2, lease until z');
  assert.equal(plain(jobClaim, { id: 'j', lease, epoch: 2, dependenciesOverridden: ['a', 'b'] }), 'claimed j for session abcdef12 at epoch 2, lease until z\noverrode dependencies: a, b');
  assert.equal(plain(jobClaim, { id: 'j', lease, epoch: 2, repoBudget: { held: false, reason: 'repo at 90% of its monthly budget' } }), 'claimed j for session abcdef12 at epoch 2, lease until z\n! repo budget: repo at 90% of its monthly budget');
});

test('job note', () => {
  assert.equal(plain(jobNote, { ok: true }), 'note added');
  assert.equal(plain(jobNote, { ok: true, extra: 1 }), null);
});

test('job: sanitizes untrusted text', () => {
  assertSafe(plain(jobList, [listRow({ id: HOSTILE, title: HOSTILE, stage: HOSTILE, state: 'waiting', waitingOn: HOSTILE, owner: HOSTILE, effort: HOSTILE })]));
  const pr = { number: 12, url: HOSTILE, state: HOSTILE, checks: HOSTILE, behindBy: 0, conflicts: false, unresolvedThreads: 0 };
  assertSafe(plain(jobShow, compact({ id: HOSTILE, title: HOSTILE, reason: HOSTILE, kind: HOSTILE, owner: HOSTILE, reviewers: [HOSTILE], lastVerdicts: { [HOSTILE]: HOSTILE }, decision: HOSTILE, worktree: HOSTILE, branch: HOSTILE, ports: { [HOSTILE]: 1 }, pr })));
  assertSafe(plain(jobStep, spawn({ agent: HOSTILE, role: HOSTILE, lens: HOSTILE, model: HOSTILE, output: HOSTILE })));
  assertSafe(plain(jobStep, { id: 'j', rule: HOSTILE, action: 'run', command: [], shell: HOSTILE, why: HOSTILE, tell: HOSTILE }));
  assertSafe(plain(jobStep, { id: 'j', rule: 'W', action: 'wait', waitingOn: HOSTILE, running: [HOSTILE], tell: HOSTILE }));
  assertSafe(plain(jobStep, { id: 'j', rule: 'P', action: 'procedure', reference: HOSTILE, why: HOSTILE }));
  assertSafe(plain(jobClaim, { id: HOSTILE, lease: { ...lease, driver: HOSTILE, expiresAt: HOSTILE }, dependenciesOverridden: [HOSTILE], repoBudget: { held: false, reason: HOSTILE } }));
});
