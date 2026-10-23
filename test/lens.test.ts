import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLens, lensFromReviewFile, lensRepoAllowed, reviewFileName, splitLens } from '#core/job/lens.ts';

test('qualified lens names and review file names', () => {
  assert.equal(reviewFileName('lib.v2:realtime'), 'lib.v2.realtime.md');
  assert.equal(lensFromReviewFile('lib.v2.realtime.md'), 'lib.v2:realtime');
  assert.equal(reviewFileName('lib:realtime'), 'lib.realtime.md');
  assert.equal(lensFromReviewFile('lib.realtime.md'), 'lib:realtime');
  for (const plain of ['code', '2fa', 'a-b']) {
    assert.equal(reviewFileName(plain), `${plain}.md`);
    assert.equal(lensFromReviewFile(`${plain}.md`), plain);
  }
  // Anything that is not a qualified lens keeps today's mapping.
  assert.equal(reviewFileName('lib:Bad'), 'lib:Bad.md');
  for (const bad of ['lib:Bad', '-x:code', 'a:b:c', ':code', 'lib:', 'Code', 'a b', '../x', '', 'lib:code\n']) {
    assert.equal(isLens(bad), false, bad);
    assert.equal(splitLens(bad), null, bad);
  }
  assert.deepEqual(splitLens('code'), { repo: null, name: 'code' });
  assert.deepEqual(splitLens('Lib_2.x:real-time'), { repo: 'Lib_2.x', name: 'real-time' });
  for (const file of ['code.txt', 'Code.md', '.md', '-x.code.md', 'lib.Bad.md', 'README']) assert.equal(lensFromReviewFile(file), null, file);
  // A repo name is at most 100 characters, as REPO_NAME says.
  assert.equal(isLens(`${'a'.repeat(100)}:code`), true);
  assert.equal(isLens(`${'a'.repeat(101)}:code`), false);
});

test('lensRepoAllowed: only reviewed members', () => {
  const job = {
    repos: [
      { repo: null, worktree: null, branch: null, base: 'main', pr: null, verifyOnly: false },
      { repo: 'lib', worktree: null, branch: null, base: 'main', pr: null, verifyOnly: false },
      { repo: 'docs', worktree: null, branch: null, base: 'main', pr: null, verifyOnly: true },
    ],
  } as any;
  assert.equal(lensRepoAllowed(job, 'code'), true);
  assert.equal(lensRepoAllowed(job, 'lib:realtime'), true);
  assert.equal(lensRepoAllowed(job, 'docs:realtime'), false, 'a verify-only member is not reviewed');
  assert.equal(lensRepoAllowed(job, 'nope:code'), false);
  assert.equal(lensRepoAllowed(job, 'bad name'), false);
  assert.equal(lensRepoAllowed({ repos: [] } as any, 'lib:code'), false);
});
