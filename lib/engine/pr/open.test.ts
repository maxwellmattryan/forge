// openPr in-process, over the memory GitHub: a scratch repo with an origin, a job worktree with one
// commit, and `--force` in place of a verify run.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addOrigin, jobAt, memoryGitHub, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import type { Config } from '#core/types.ts';
import type { BranchRules } from '#integrations/github/types.ts';
import { createWorktree } from '../workspace/worktree.ts';
import { openPr } from './open.ts';

/** A job at pr whose worktree has one commit ahead of main, with `rules` as main's protection (else the memory default: none). */
function opening(edit: (c: Config) => void, rules?: BranchRules | 'fail') {
  const repo = tempRepo();
  addOrigin(repo);
  const config = defaults();
  config.tracker.kind = 'none';
  config.tracker.github.repo = 'o/r';
  config.worktrees.root = '.wt';
  edit(config);
  const { id } = jobAt(repo.dir, 'pr', { config, title: 'open me' });
  const wt = createWorktree(repo.dir, config, id).path!;
  fs.writeFileSync(path.join(wt, 'work.txt'), 'work\n');
  for (const args of [['add', '-A'], ['commit', '-qm', 'work']]) repo.git('-C', wt, ...args);
  const github = memoryGitHub();
  if (rules === 'fail') github.fail('branchRules', 'gh: Resource not accessible by integration (HTTP 403)');
  else if (rules) github.setBranchRules('main', rules);
  const open = () => openPr(repo.dir, config, github, id, { force: true });
  return { open, github, cleanup: repo.cleanup };
}

const checked: BranchRules = { status: 'read', checks: [{ name: 'test', appId: null }], reviews: 1 };

describe('pr open warns when the base has no required checks', { concurrency: 4 }, () => {
  const rows: [string, (c: Config) => void, BranchRules | 'fail' | undefined, RegExp | null, number][] = [
    ['the key empty, protection with no checks: the warning', () => {}, undefined, /^main has no merge\.requiredChecks and no protection rule with required checks and a required review, so Forge merges on whatever CI has reported; /, 1],
    ['the key set: no warning and no protection read', (c) => (c.merge.requiredChecks = ['test']), checked, null, 0],
    ['protection with a check and a review: no warning', () => {}, checked, null, 1],
    ['protection that cannot be read still opens the PR, with the unavailable text', () => {}, 'fail', /^could not read main's branch protection \(gh: Resource not accessible by integration \(HTTP 403\)\) and merge\.requiredChecks is empty/, 1],
  ];
  for (const [name, edit, rules, want, reads] of rows) {
    test(name, () => {
      const s = opening(edit, rules);
      try {
        const r = s.open();
        assert.ok(r.created && r.number !== null, JSON.stringify(r));
        if (want === null) assert.ok(!('requiredChecksWarning' in r), JSON.stringify(r));
        else assert.match(r.requiredChecksWarning ?? '', want);
        assert.equal(s.github.calls.filter((c) => c.op === 'branchRules').length, reads, 'branchRules calls');
        // The update path (the PR exists) warns the same way.
        const again = s.open();
        assert.deepEqual([again.created, 'requiredChecksWarning' in again], [false, want !== null]);
      } finally {
        s.cleanup();
      }
    });
  }
});
