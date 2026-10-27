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
    { kind: 'build', argv: phase('wait-build'), manual: false, publish: false, check: null },
    { kind: 'pr', argv: phase('pr'), manual: false, publish: true, check: null },
    { kind: 'merge', argv: null, manual: true, publish: true, check: 'pr-merged' },
    { kind: 'tag', argv: phase('wait-tag'), manual: false, publish: false, check: null },
    { kind: 'land', argv: phase('land'), manual: false, publish: true, check: null },
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
    assert.match(merge.manual!, /release\/v1\.1\.0.*"Create a merge commit".*head is the one the pr step printed as checked/);

    const rollback = rollbackFor(input, steps, null);
    assert.equal(rollback.length, 4, 'one line per publish step');
    assert.match(rollback[0], /next patch.*`v1\.1\.0`.*revert the landing on develop/, 'land');
    assert.match(rollback[1], /^`gh release delete v1\.1\.0 --cleanup-tag`, then undo the merge on main with a hotfix PR.*Never move a published tag/, 'merge');
    assert.match(rollback[2], /close the release PR from release\/v1\.1\.0/, 'pr');
    assert.equal(rollback[3], '`git push origin --delete release/v1.1.0`, then `git branch -D release/v1.1.0`', 'start');
  }

  // A member's steps carry its label and its own notes file.
  const member = stepsFor({ repo: 'lib', dir: '/lib', base: 'main', remote: 'origin', strategy: { mechanism: 'script', script: 'release.mjs' }, manifest: null, bump: { ...bump, notes: '/n/notes-lib.md' } });
  assert.deepEqual(member.map((x) => x.id), want.map((w) => `lib/${w.kind}`));
  assert.deepEqual(member[1].argv, ['node', 'release.mjs', '--phase', 'start', '1.1.0', '--notes-file', '/n/notes-lib.md']);
});
