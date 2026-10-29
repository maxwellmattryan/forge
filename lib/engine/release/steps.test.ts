// The mechanism table: what stepsFor and rollbackFor give one repo's strategy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { type RepoInput, rollbackFor, stepsFor } from './steps.ts';

test("the script mechanism's steps and rollback", () => {
  const notes = '/repo/.forge/runtime/release/notes-root.md';
  const bump = { from: '1.0.0', to: '1.1.0', bump: 'minor' as const, inferred: 'minor' as const, reasons: ['1 of 1 commits are not fixes'], notes };
  const s = 'scripts/release.ts';
  const phase = (name: string, ...rest: string[]) => ['node', s, '--phase', name, '1.1.0', ...rest];
  const want = [
    { kind: 'preflight', argv: null, manual: false, publish: false, check: 'ready' },
    { kind: 'start', argv: phase('start', '--notes-file', notes), manual: false, publish: true, check: null },
    { kind: 'merge', argv: null, manual: true, publish: true, check: 'pr-merged' },
    { kind: 'tag', argv: phase('wait-tag'), manual: false, publish: false, check: null },
  ];
  for (const registry of [null, 'none', 'npm', 'crates.io'] as const) {
    const input: RepoInput = {
      repo: null,
      dir: '/repo',
      base: 'develop',
      remote: 'origin',
      strategy: { mechanism: 'script', script: s, registry },
      manifest: null,
      bump,
    };
    const steps = stepsFor(input);
    assert.deepEqual(
      steps.map((x) => ({ kind: x.kind, argv: x.argv, manual: x.manual !== null, publish: x.publish, check: x.check })),
      want,
      `registry ${registry}: no registry step`,
    );
    assert.deepEqual(steps.map((x) => x.id), want.map((w) => `(root)/${w.kind}`));
    assert.ok(steps.every((x) => x.shell === null && x.repo === null));
    const merge = steps.find((x) => x.kind === 'merge')!;
    // The merge names the branch and the repo's base, never a fixed main.
    assert.match(merge.manual!, /release\/v1\.1\.0 into develop\b/);
    assert.doesNotMatch(merge.manual!, /\bmain\b/);

    const rollback = rollbackFor(input, steps, null);
    assert.equal(rollback.length, 2, 'one line per publish step');
    assert.match(rollback[0], /next patch release.*Never move or reuse a published tag/, 'merge');
    assert.equal(rollback[1], 'close the release PR, then `git push origin --delete release/v1.1.0` and `git branch -D release/v1.1.0`', 'start');
  }

  // A member's steps carry its label, its own notes file and its own base.
  const member = stepsFor({ repo: 'lib', dir: '/lib', base: 'trunk', remote: 'origin', strategy: { mechanism: 'script', script: 'release.mjs' }, manifest: null, bump: { ...bump, notes: '/n/notes-lib.md' } });
  assert.deepEqual(member.map((x) => x.id), want.map((w) => `lib/${w.kind}`));
  assert.deepEqual(member[1].argv, ['node', 'release.mjs', '--phase', 'start', '1.1.0', '--notes-file', '/n/notes-lib.md']);
  assert.match(member[2].manual!, /release\/v1\.1\.0 into trunk\b/);
});
