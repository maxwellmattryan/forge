// The drawer's Repos table and the job card's member PR chips (dashboard/src/lib/repos.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobRepoRows, memberPrs } from '../dashboard/src/lib/repos.ts';
import { prChipModel } from '../dashboard/src/lib/job-state.ts';

const root = { repo: null, worktree: '/w/app', branch: 'forge/x', base: 'main', pr: { number: 11, url: 'https://github.com/o/app/pull/11', state: 'OPEN' as const, isDraft: false, lastSyncedAt: 't' }, verifyOnly: false };
const lib = { repo: 'lib', worktree: '/w/lib', branch: 'forge/x', base: 'main', pr: { number: 7, url: 'https://github.com/o/lib/pull/7', state: 'MERGED' as const, isDraft: false, lastSyncedAt: 't' }, verifyOnly: false };
const docs = { repo: 'docs', worktree: null, branch: null, base: 'release/1.x', pr: null, verifyOnly: true };

test('repo rows and member PR chips', () => {
  assert.deepEqual(jobRepoRows({ repos: [root] }, 'app'), [], 'a single-repo job has no table');
  assert.deepEqual(jobRepoRows({}, 'app'), []);
  const rows = jobRepoRows({ repos: [root, lib, docs] }, 'app');
  assert.deepEqual(
    rows.map((r) => [r.name, r.root, r.branch, r.verifyOnly, r.base, r.worktree, r.prNumber, r.prUrl]),
    [
      ['app', true, 'forge/x', false, 'main', '/w/app', 11, 'https://github.com/o/app/pull/11'],
      ['lib', false, 'forge/x', false, 'main', '/w/lib', 7, 'https://github.com/o/lib/pull/7'],
      ['docs', false, null, true, 'release/1.x', null, null, null],
    ],
  );
  const evil = jobRepoRows({ repos: [root, { ...lib, pr: { ...lib.pr, url: 'javascript:alert(1)' } }] }, 'app');
  assert.equal(evil[1].prUrl, null, 'a javascript: url is never a link');
  assert.equal(evil[1].prNumber, 7);
  assert.equal(prChipModel(lib.pr, 'lib')?.text, 'lib#7');
  assert.equal(prChipModel(lib.pr, 'lib')?.tone, 'ok');
  assert.equal(prChipModel(root.pr)?.text, '#11', 'the root chip is unchanged');
  assert.deepEqual(memberPrs({ repos: [root, lib, docs] }).map((m) => [m.repo, m.pr.number]), [['lib', 7]]);
  assert.deepEqual(memberPrs({ repos: [root] }), []);
});
