// The held push's pure parts: which changes are CI config (folded as the escalate floor folds them),
// the reasons a person approves at, and the approval match; plus pushCiChanges over a real repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import type { JobEvent } from '#core/types.ts';
import type { DiffEntry } from './protected.ts';
import { PUSH_HELD_PREFIX, ciEntries, ciHoldReason, isCiHit, pushCiChanges, pushHoldApproved, secretsHoldReason, securityHoldReason } from './push-hold.ts';

const BLOB = 'b'.repeat(40);
const entry = (p: string, mode = '100644'): DiffEntry => ({ path: p, status: 'M', oldMode: mode, newMode: mode, oldBlob: BLOB, newBlob: BLOB });

test('which changes are CI config', () => {
  const rows: [string, DiffEntry, boolean][] = [
    ['a workflow', entry('.github/workflows/ci.yml'), true],
    ['a workflow in another case', entry('.GitHub/Workflows/CI.yml'), true],
    ['a buildkite pipeline', entry('.buildkite/pipeline.yml'), true],
    ['azure pipelines', entry('azure-pipelines.yml'), true],
    ['GitLab CI', entry('.gitlab-ci.yml'), true],
    ['a Jenkinsfile in upper case', entry('JENKINSFILE'), true],
    ['a CircleCI config', entry('.circleci/config.yml'), true],
    ["Forge's CI dir", entry('.forge/ci/check.yml'), true],
    ['a symlink at .github', entry('.github', '120000'), true],
    ['a gitlink at .circleci', entry('.circleci', '160000'), true],
    ['a plain file named .github', entry('.github'), false],
    ['source', entry('src/app.ts'), false],
    ['a Makefile (build config, not a CI runner)', entry('Makefile'), false],
    ['a workflow-looking file outside .github', entry('docs/.github/workflows/ci.yml'), false],
  ];
  for (const [name, e, want] of rows) assert.equal(ciEntries([e]).length === 1, want, name);
  // A protected-paths hit has no mode: a CI leading dir counts, and so does a member repo's CI path.
  for (const [p, want] of [['lib:.circleci/config.yml', true], ['lib:.github', true], ['lib:src/app.ts', false], ['db/migrations/0001.sql', false], ['.GitHub/Workflows/CI.yml', true]] as const) assert.equal(isCiHit(p), want, p);

  // The reason: at most 3 shell-safe paths, the rest counted, and a digest over every (path, blob).
  const reason = ciHoldReason([
    { path: '.github/workflows/b.yml', blob: BLOB },
    { path: '.github/workflows/a.yml', blob: BLOB },
    { path: "-rf/.github/workflows/x'$(id).yml", blob: BLOB },
    { path: 'lib:.circleci/config.yml', blob: null },
    { path: `.github/workflows/${'x'.repeat(10_000)}.yml`, blob: BLOB },
  ]);
  assert.match(reason, /^push held: CI config changes: \.github\/workflows\/a\.yml, \.github\/workflows\/b\.yml, lib:\.circleci\/config\.yml, \+2 more \[ci [0-9a-f]{16}\]$/);
  assert.match(reason, /^[A-Za-z0-9 ._:/@=,+\-[\]"]*$/, 'inside SAFE_ELEMENT');
  const longest = ciHoldReason(['a', 'b', 'c', 'd'].map((c) => ({ path: `.github/workflows/${c.repeat(100 - 22)}.yml`, blob: BLOB })));
  assert.match(longest, /^push held: [A-Za-z0-9 ._:/@=,+\-[\]"]{1,400}$/, "three of the longest printed paths still fit PR13's reason class");
  const one = (blob: string | null) => ciHoldReason([{ path: '.github/workflows/ci.yml', blob }]);
  assert.notEqual(one(BLOB), one('c'.repeat(40)), 'a new blob is a new digest');
  assert.notEqual(one(BLOB), one(null), 'a delete is a new digest');
  assert.equal(one(BLOB), ciHoldReason([{ path: '.github/workflows/ci.yml', blob: BLOB }]), 'the same content is the same reason');
});

test('the security and secrets reasons', () => {
  assert.equal(securityHoldReason({ verdicts: { 1: { security: 'PASS' } } } as any), null);
  assert.equal(securityHoldReason({ verdicts: { 1: { code: 'CHANGES' } } } as any), null, 'no security lens, no hold');
  assert.equal(securityHoldReason({ verdicts: { 1: { security: 'PASS' }, 2: { security: 'CHANGES' } } } as any), 'push held: the security review of round 2 is CHANGES');
  assert.equal(securityHoldReason({ verdicts: { 3: { security: 'MALFORMED' } } } as any), 'push held: the security review of round 3 is not PASS');
  const head = 'a'.repeat(40);
  const finding = (fingerprint: string) => ({ fingerprint }) as any;
  assert.equal(secretsHoldReason({ findings: [finding('sha256:1')] }, 'block', head), null, 'block mode refuses before the push');
  assert.equal(secretsHoldReason({ findings: [] }, 'warn', head), null);
  assert.equal(secretsHoldReason({ findings: [], error: 'base gone' }, 'warn', head), `push held: the secret scan could not finish [head ${'a'.repeat(12)}]`);
  const two = secretsHoldReason({ findings: [finding('sha256:1'), finding('sha256:2')] }, 'warn', head)!;
  assert.match(two, /^push held: the secret scan reported 2 possible secrets \[fp [0-9a-f]{16}\]$/);
  assert.notEqual(two, secretsHoldReason({ findings: [finding('sha256:1'), finding('sha256:3')] }, 'warn', head), 'new findings, a new reason');
  // A member's scan joins the root's: its findings count and are bound to its repo, a scan that could not finish to its repo and head.
  const lib = (scan: { findings: any[]; error?: string }, repo = 'lib', at = 'b'.repeat(40)) => ({ repo, head: at, scan });
  const withLib = secretsHoldReason({ findings: [] }, 'warn', head, [lib({ findings: [finding('sha256:1')] })])!;
  assert.match(withLib, /^push held: the secret scan reported 1 possible secrets \[fp [0-9a-f]{16}\]$/);
  assert.notEqual(withLib, secretsHoldReason({ findings: [finding('sha256:1')] }, 'warn', head), 'the same fingerprint in another repo is another reason');
  assert.notEqual(withLib, secretsHoldReason({ findings: [] }, 'warn', head, [lib({ findings: [finding('sha256:1')] }, 'docs')]), 'and in another member');
  assert.equal(secretsHoldReason({ findings: [] }, 'block', head, [lib({ findings: [finding('sha256:1')] })]), null, 'block mode refuses before the push');
  assert.equal(secretsHoldReason({ findings: [] }, 'warn', head, [lib({ findings: [] })]), null);
  const unfinished = secretsHoldReason({ findings: [] }, 'warn', head, [lib({ findings: [], error: 'base gone' })])!;
  assert.match(unfinished, /^push held: the secret scan could not finish in 1 repo \[heads [0-9a-f]{16}\]$/);
  assert.notEqual(unfinished, secretsHoldReason({ findings: [] }, 'warn', head, [lib({ findings: [], error: 'base gone' }, 'lib', 'c'.repeat(40))]), 'a new head, a new reason');
  assert.match(secretsHoldReason({ findings: [], error: 'x' }, 'warn', head, [lib({ findings: [], error: 'x' })])!, / in 2 repos \[heads /, 'the root and a member');
});

test("a held push is approved only by a person's approve at exactly its reason", () => {
  const reason = `${PUSH_HELD_PREFIX}CI config changes: .github/workflows/ci.yml [ci 0123456789abcdef]`;
  const park = (r: string): JobEvent => ({ v: 1, ts: 't1', type: 'transition', from: { stage: 'pr', state: 'running', waitingOn: null }, to: { stage: 'pr', state: 'waiting', waitingOn: 'human' }, reason: r });
  const approve = (actor: unknown = { login: 'al', source: 'env' }): JobEvent => ({ v: 1, ts: 't2', type: 'human', action: 'approve', actor }) as JobEvent;
  assert.equal(pushHoldApproved([park(reason), approve()], reason), true);
  assert.equal(pushHoldApproved([park(reason), approve({ login: null, source: 'foreman' })], reason), false, "the Foreman's");
  assert.equal(pushHoldApproved([park(reason.replace('0123', 'ffff')), approve()], reason), false, 'another digest');
  assert.equal(pushHoldApproved([approve(), park(reason)], reason), false, 'before the park');
});

test('pushCiChanges reads the branch against the merge base and what Forge last pushed', () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const write = (p: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(repo.dir, p)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, p), body);
    };
    const commit = (msg: string) => {
      repo.git('add', '-A');
      repo.git('commit', '-qm', msg);
      return repo.git('rev-parse', 'HEAD').toString().trim();
    };
    repo.git('checkout', '-qb', 'forge/j');
    write('.circleci/config.yml', 'a\n');
    write('src/app.ts', 'x\n');
    const first = commit('ci');
    const base = { base: 'main' };
    assert.deepEqual(pushCiChanges(repo.dir, config, base, first, null, 'lib').map((c) => c.path), ['lib:.circleci/config.yml'], 'a member repo is prefixed');
    assert.deepEqual(pushCiChanges(repo.dir, config, base, first, first), [], 'nothing changed since the push');
    write('src/app.ts', 'y\n');
    const second = commit('code');
    assert.deepEqual(pushCiChanges(repo.dir, config, base, second, first), [], 'a code change after the push holds nothing');
    write('.circleci/config.yml', 'b\n');
    const third = commit('ci again');
    assert.deepEqual(pushCiChanges(repo.dir, config, base, third, first).map((c) => c.path), ['.circleci/config.yml'], 'a CI change after the push');
    assert.deepEqual(pushCiChanges(repo.dir, config, base, third, 'f'.repeat(40)).map((c) => c.path), ['.circleci/config.yml'], 'an unknown pushed sha counts as nothing pushed');
    assert.throws(() => pushCiChanges(repo.dir, config, { base: 'no-such-branch' }, third, null), 'a base git cannot resolve throws');
    assert.throws(() => pushCiChanges(repo.dir, config, base, 'HEAD', null), /not a commit id/);
  } finally {
    repo.cleanup();
  }
});
