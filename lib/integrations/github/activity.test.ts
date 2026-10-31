import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DIFF_BYTES, parseBranchHistory, safePath } from './activity.ts';
import { createGhGitHub, parseOpenPrRecord } from './pull-requests.ts';
import type { RunResult } from '#core/os/process.ts';

const SHA = 'a'.repeat(40);

/** A gh runner that records every argv and answers `stdout`. */
function recorder(stdout = '[]') {
  const calls: string[][] = [];
  const run = (_cwd: string | undefined, args: string[]): RunResult => {
    calls.push(args);
    return { ok: true, stdout, stderr: '', status: 0 } as RunResult;
  };
  return { calls, github: createGhGitHub(run as Parameters<typeof createGhGitHub>[0]) };
}

test('parsers drop hostile values', () => {
  const long = 'a/'.repeat(151);
  const pr = parseOpenPrRecord({
    number: 9,
    url: 'http://github.com/o/r/pull/9',
    state: 'OPEN',
    isCrossRepository: true,
    headRefName: '-evil',
    baseRefName: 'main\nx',
    headRefOid: 'not-a-sha',
    author: { login: 'bad\u001b[31mlogin' },
    createdAt: '2026-10-30T12:00:00Z; rm -rf',
    changedFiles: 9,
    files: [
      { path: 'lib/ok.ts' },
      { path: 'lib/\u001b[2Jclear.ts' },
      { path: 'lib/c1\u009b.ts' },
      { path: 'lib/del\u007f.ts' },
      { path: '/etc/passwd' },
      { path: 'lib/../../x' },
      { path: long },
      { path: 'lib/ok.ts' },
      { path: '' },
    ],
    commits: [{ oid: 'zz', committedDate: 'yesterday', authors: [{ login: 'ok-user' }, { login: 'x y\u0000' }] }],
  });
  assert.equal(pr.url, null);
  assert.equal(pr.headRefName, null);
  assert.equal(pr.baseRefName, null);
  assert.equal(pr.headOid, null);
  assert.equal(pr.author, null);
  assert.equal(pr.createdAt, null);
  assert.deepEqual(pr.files, ['lib/ok.ts']);
  assert.equal(pr.dropped, 7);
  assert.equal(pr.filesComplete, true);
  assert.deepEqual(pr.commits, [{ oid: null, committedAt: null, authors: ['ok-user'] }]);
  assert.equal(parseOpenPrRecord({ number: 1, changedFiles: 200, files: [{ path: 'a' }] }).filesComplete, false);
  assert.equal(parseOpenPrRecord({ number: 1, files: [{ path: 'a' }] }).filesComplete, false);

  const history = parseBranchHistory({
    repository: {
      ref: {
        target: {
          history: {
            pageInfo: { hasNextPage: true },
            nodes: [
              { oid: SHA, committedDate: '2026-10-30T12:00:00Z', author: { user: { login: 'dev' } }, associatedPullRequests: { nodes: [{ number: 4, headRefName: 'forge/a', isCrossRepository: false }] } },
              { oid: 'nope', committedDate: 'x', author: { user: { login: '<script>' } }, associatedPullRequests: { nodes: [{ number: 0, headRefName: 'ok' }] } },
              { oid: SHA, committedDate: '2026-10-30T12:00:00Z', author: null, associatedPullRequests: { nodes: [{ number: 5, headRefName: '--upload-pack=x' }] } },
            ],
          },
        },
      },
    },
  });
  assert.equal(history.complete, false);
  assert.deepEqual(history.commits, [
    { oid: SHA, committedAt: '2026-10-30T12:00:00Z', author: 'dev', pr: { number: 4, headRefName: 'forge/a', isCrossRepository: false } },
    { oid: null, committedAt: null, author: null, pr: null },
    // A PR not marked same-repo counts as a fork.
    { oid: SHA, committedAt: '2026-10-30T12:00:00Z', author: null, pr: { number: 5, headRefName: null, isCrossRepository: true } },
  ]);
  for (const bad of ['', 'a\tb', 'a\u0085b', '/abs', 'C:/x', '..', 'a/../b', 'x'.repeat(301), 42, null]) assert.equal(safePath(bad), null, JSON.stringify(bad));
  for (const ok of ['a', 'lib/a b.ts', 'dir/', 'x'.repeat(300), 'ünï/cødé.ts']) assert.equal(safePath(ok), ok);
});

test('reads refuse bad arguments before gh', () => {
  const { calls, github } = recorder();
  const refusals: [string, () => unknown][] = [
    ['prDiff number 0', () => github.prDiff('/r', 'o/r', 0)],
    ['prDiff number 1.5', () => github.prDiff('/r', 'o/r', 1.5)],
    ['prDiff number -3', () => github.prDiff('/r', 'o/r', -3)],
    ['prDiff slug', () => github.prDiff('/r', '-R x/y', 1)],
    ['commitDiff sha', () => github.commitDiff('/r', 'o/r', 'HEAD')],
    ['commitDiff short sha', () => github.commitDiff('/r', 'o/r', 'abc123')],
    ['commitDiff slug', () => github.commitDiff('/r', 'o/r/../x', SHA)],
    ['branchHistory branch', () => github.branchHistory('/r', 'o/r', '--all', '2026-10-30T00:00:00Z')],
    ['branchHistory since', () => github.branchHistory('/r', 'o/r', 'main', 'yesterday')],
    ['openPrs base', () => github.openPrs('/r', 'o/r', '-x', 50)],
    ['openPrs limit', () => github.openPrs('/r', 'o/r', 'main', 0)],
    ['openPrs slug', () => github.openPrs('/r', 'o r', 'main', 50)],
  ];
  for (const [name, fn] of refusals) assert.throws(fn, (e: any) => e.code === 'external', name);
  assert.deepEqual(calls, []);

  github.branchHistory('/r', 'o/r', 'feat/x', '2026-10-30T00:00:00Z');
  const args = calls[0];
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
  assert.ok(args.includes('ref=refs/heads/feat/x') && args[args.indexOf('ref=refs/heads/feat/x') - 1] === '-f');
  assert.ok(args.includes('since=2026-10-30T00:00:00Z'));
  const query = args.find((a) => a.startsWith('query='));
  assert.ok(query && !query.includes('feat/x'));

  github.prDiff('/r', 'o/r', 12);
  github.commitDiff('/r', 'o/r', SHA);
  github.openPrs('/r', 'o/r', 'main', 50);
  assert.deepEqual(calls[1], ['pr', 'diff', '12', '-R', 'o/r', '--color', 'never']);
  assert.deepEqual(calls[2], ['api', '-H', 'Accept: application/vnd.github.diff', `repos/o/r/commits/${SHA}`]);
  assert.deepEqual(calls[3].slice(0, 9), ['pr', 'list', '-R', 'o/r', '--state', 'open', '--base', 'main', '--limit']);
});

test('a diff over the cap throws external', () => {
  const { github } = recorder('x'.repeat(MAX_DIFF_BYTES + 1));
  assert.throws(() => github.prDiff('/r', 'o/r', 1), (e: any) => e.code === 'external');
  assert.throws(() => github.commitDiff('/r', 'o/r', SHA), (e: any) => e.code === 'external');
});
