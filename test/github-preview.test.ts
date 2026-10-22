// GitHub hover previews: the URL parse, the gh argv, folding GraphQL answers, the cache, and GET /api/github/preview's
// guards. gh never runs: the server takes a fake runner through its ghRun seam.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempRepo } from './helpers.ts';
import { createPreviewer, excerpt, foldPreview, ghArgs, parseGitHubUrl, targetKey, toResponse } from '../lib/integrations/github/preview.ts';
import type { GhResult, GhRunner, GitHubTarget } from '../lib/integrations/github/preview.ts';
import { startServer } from '../lib/server.ts';
import { FIXTURE_DIST } from './dist.ts';

const PR = {
  repository: {
    nameWithOwner: 'acme/widgets',
    issueOrPullRequest: {
      __typename: 'PullRequest',
      number: 12,
      title: 'Add <b>bold</b> widgets',
      url: 'https://github.com/acme/widgets/pull/12',
      state: 'OPEN',
      isDraft: false,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      bodyText: 'Line one\n\n  line   two',
      author: { login: 'octo' },
      baseRefName: 'main',
      headRefName: 'feat/bold',
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      reviewDecision: 'CHANGES_REQUESTED',
      comments: { totalCount: 4 },
      labels: { nodes: [{ name: 'ui' }, { name: '' }, { name: 'bug' }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] },
    },
  },
};
const ok = (data: unknown): GhResult => ({ code: 0, stdout: JSON.stringify({ data }), stderr: '' });
const pull: GitHubTarget = { kind: 'pull', owner: 'acme', name: 'widgets', number: 12 };

describe('parseGitHubUrl', () => {
  test('repositories, pull requests, issues and commits, sub-pages folded onto their page', () => {
    assert.deepEqual(parseGitHubUrl('https://github.com/acme/widgets'), { kind: 'repo', owner: 'acme', name: 'widgets' });
    assert.deepEqual(parseGitHubUrl('https://www.github.com/acme/widgets.git/'), { kind: 'repo', owner: 'acme', name: 'widgets' });
    assert.deepEqual(parseGitHubUrl('https://github.com/acme/widgets/pull/12/files#diff-1'), pull);
    assert.deepEqual(parseGitHubUrl('https://github.com/acme/widgets/issues/7#issuecomment-9'), { kind: 'issue', owner: 'acme', name: 'widgets', number: 7 });
    assert.deepEqual(parseGitHubUrl('https://github.com/acme/widgets/commit/ABCDEF1'), { kind: 'commit', owner: 'acme', name: 'widgets', sha: 'abcdef1' });
  });

  test('anything else is not previewed', () => {
    for (const u of [
      'http://github.com/acme/widgets',
      'https://gitlab.com/acme/widgets',
      'https://github.com.evil.example/acme/widgets',
      'https://user:pw@github.com/acme/widgets',
      'https://github.com:8443/acme/widgets',
      'https://github.com/acme',
      'https://github.com/settings/tokens',
      'https://github.com/orgs/acme',
      'https://github.com/acme/widgets/tree/main',
      'https://github.com/acme/widgets/pull/0',
      'https://github.com/acme/widgets/pull/99999999999',
      'https://github.com/acme/widgets/issues/abc',
      'https://github.com/acme/widgets/commit/xyz',
      'https://github.com/-acme/widgets',
      'https://github.com/acme/..',
      'not a url',
      '',
    ]) {
      assert.equal(parseGitHubUrl(u), null, u);
    }
  });

  test('the cache key ignores case', () => {
    assert.equal(targetKey({ kind: 'pull', owner: 'Acme', name: 'Widgets', number: 3 }), 'pull:acme/widgets#3');
    assert.equal(targetKey({ kind: 'repo', owner: 'Acme', name: 'Widgets' }), 'repo:acme/widgets');
    assert.equal(targetKey({ kind: 'commit', owner: 'a', name: 'b', sha: 'abc1234' }), 'commit:a/b@abc1234');
  });
});

test('ghArgs passes owner and name as raw strings and the number as a number', () => {
  const args = ghArgs({ kind: 'issue', owner: 'acme', name: '123', number: 5 });
  assert.deepEqual(args.slice(0, 6), ['api', 'graphql', '-f', 'owner=acme', '-f', 'name=123']);
  assert.ok(args.includes('number=5') && args[args.indexOf('number=5') - 1] === '-F');
  assert.ok(ghArgs({ kind: 'commit', owner: 'a', name: 'b', sha: 'abc1234' }).includes('rev=abc1234'));
  assert.ok(ghArgs({ kind: 'repo', owner: 'a', name: 'b' }).every((a) => !a.startsWith('number=')));
});

describe('foldPreview', () => {
  test('a pull request', () => {
    assert.deepEqual(foldPreview(pull, PR), {
      kind: 'pull',
      repo: 'acme/widgets',
      number: 12,
      url: 'https://github.com/acme/widgets/pull/12',
      title: 'Add <b>bold</b> widgets',
      state: 'open',
      author: 'octo',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      base: 'main',
      head: 'feat/bold',
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      comments: 4,
      review: 'changes_requested',
      checks: 'failure',
      labels: ['ui', 'bug'],
      excerpt: 'Line one line two',
    });
  });

  test('pull states: draft, merged and closed win over open', () => {
    const at = (patch: object) => (foldPreview(pull, { repository: { ...PR.repository, issueOrPullRequest: { ...PR.repository.issueOrPullRequest, ...patch } } }) as { state: string }).state;
    assert.equal(at({ isDraft: true }), 'draft');
    assert.equal(at({ state: 'MERGED', isDraft: true }), 'merged');
    assert.equal(at({ state: 'CLOSED' }), 'closed');
  });

  test('an issue URL that is a pull request previews the pull request', () => {
    assert.equal(foldPreview({ kind: 'issue', owner: 'acme', name: 'widgets', number: 12 }, PR)?.kind, 'pull');
  });

  test('an issue keeps why it closed', () => {
    const t: GitHubTarget = { kind: 'issue', owner: 'acme', name: 'widgets', number: 7 };
    const issue = (state: string, stateReason: string | null) => foldPreview(t, { repository: { nameWithOwner: 'acme/widgets', issueOrPullRequest: { __typename: 'Issue', number: 7, title: 'x', url: 'u', state, stateReason, assignees: { nodes: [{ login: 'a' }] } } } });
    assert.equal((issue('OPEN', null) as any).state, 'open');
    assert.equal((issue('CLOSED', 'COMPLETED') as any).state, 'closed');
    assert.equal((issue('CLOSED', 'NOT_PLANNED') as any).state, 'not_planned');
    assert.equal((issue('CLOSED', 'DUPLICATE') as any).state, 'duplicate');
    assert.deepEqual((issue('OPEN', null) as any).assignees, ['a']);
    assert.deepEqual((issue('OPEN', null) as any).labels, []);
  });

  test('a repository and a commit, with missing fields filled safely', () => {
    const repo = foldPreview({ kind: 'repo', owner: 'acme', name: 'widgets' }, { repository: { nameWithOwner: 'acme/widgets', stargazerCount: 1200, isArchived: true, primaryLanguage: null } });
    assert.deepEqual(repo, { kind: 'repo', repo: 'acme/widgets', url: 'https://github.com/acme/widgets', description: null, private: false, archived: true, fork: false, stars: 1200, forks: 0, language: null, defaultBranch: null, openIssues: 0, openPulls: 0, license: null, pushedAt: null });
    const commit = foldPreview({ kind: 'commit', owner: 'acme', name: 'widgets', sha: 'abc1234' }, { repository: { nameWithOwner: 'acme/widgets', object: { __typename: 'Commit', oid: 'abc1234ff', messageHeadline: 'Fix', author: { name: 'Ann', user: null }, statusCheckRollup: { state: 'PENDING' } } } });
    assert.equal(commit?.kind === 'commit' && commit.author, 'Ann');
    assert.equal(commit?.kind === 'commit' && commit.checks, 'pending');
    assert.equal(foldPreview({ kind: 'commit', owner: 'a', name: 'b', sha: 'abc1234' }, { repository: { object: { __typename: 'Tree' } } }), null);
  });

  test('no repository or no item is null', () => {
    assert.equal(foldPreview(pull, { repository: null }), null);
    assert.equal(foldPreview(pull, { repository: { issueOrPullRequest: null } }), null);
    assert.equal(foldPreview(pull, undefined), null);
  });
});

test('excerpt flattens whitespace and cuts on a code point', () => {
  assert.equal(excerpt(null), '');
  const long = '😀'.repeat(400);
  const cut = excerpt(long);
  assert.equal(Array.from(cut).length, 280);
  assert.ok(cut.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(cut), 'no lone surrogate before the ellipsis');
});

describe('toResponse', () => {
  test('a preview, a NOT_FOUND exit, gh missing, and gh failing before GitHub', () => {
    assert.ok('preview' in toResponse(pull, ok(PR)));
    const nf = toResponse(pull, { code: 1, stdout: JSON.stringify({ data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }), stderr: 'gh: Could not resolve' });
    assert.deepEqual(nf, { error: 'not_found', message: 'Could not resolve' });
    assert.equal((toResponse(pull, { code: null, stdout: '', stderr: '', missing: true }) as any).error, 'gh_missing');
    assert.deepEqual(toResponse(pull, { code: 4, stdout: '', stderr: 'gh auth login required\n' }), { error: 'failed', message: 'gh auth login required' });
    assert.equal((toResponse(pull, ok({ repository: { issueOrPullRequest: null } })) as any).error, 'not_found');
  });
});

describe('createPreviewer', () => {
  test('one gh call per page while fresh, shared by concurrent asks, refetched once stale', async () => {
    let calls = 0;
    let clock = 0;
    const run: GhRunner = async () => (calls++, ok(PR));
    const preview = createPreviewer({ run, ttlMs: 100, now: () => clock });
    const [a, b] = await Promise.all([preview(pull), preview({ ...pull, owner: 'ACME' })]);
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
    clock = 50;
    await preview(pull);
    assert.equal(calls, 1);
    clock = 200;
    await preview(pull);
    assert.equal(calls, 2);
  });

  test('errors live shorter, a throwing runner is a failure, and the cache is bounded', async () => {
    let calls = 0;
    let clock = 0;
    const run: GhRunner = async (args) => {
      calls++;
      if (args.includes('number=13')) throw new Error('boom');
      return { code: 1, stdout: '', stderr: 'offline' };
    };
    const preview = createPreviewer({ run, ttlMs: 1000, errorTtlMs: 10, max: 2, now: () => clock });
    assert.deepEqual(await preview(pull), { error: 'failed', message: 'offline' });
    clock = 20;
    await preview(pull);
    assert.equal(calls, 2, 'an error is retried after errorTtlMs');
    assert.deepEqual(await preview({ ...pull, number: 13 }), { error: 'failed', message: 'boom' });
    await preview({ ...pull, number: 14 });
    await preview({ ...pull, number: 15 });
    const before = calls;
    clock = 25;
    await preview({ ...pull, number: 12 });
    assert.equal(calls, before + 1, 'the oldest entry was evicted');
  });
});

/** A GET against the server, with optional headers. */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      })
      .on('error', reject);
  });
}

test('GET /api/github/preview takes the token and a same-origin Origin, refuses non-GitHub URLs, and never shells out for them', async () => {
  const repo = tempRepo();
  const seen: string[][] = [];
  const ghRun: GhRunner = async (args) => (seen.push(args), ok(PR));
  const { url, close } = await startServer(repo.dir, { port: 0, ghRun, distDir: FIXTURE_DIST });
  const port = Number(new URL(url).port);
  try {
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await get(port, '/')).text)?.[1] ?? '';
    const q = (u: string) => `/api/github/preview?url=${encodeURIComponent(u)}`;
    const target = q('https://github.com/acme/widgets/pull/12');
    assert.equal((await get(port, target)).status, 403, 'no token');
    assert.equal((await get(port, target, { 'x-forge-token': 'nope' })).status, 403);
    assert.equal((await get(port, target, { 'x-forge-token': token, origin: 'http://evil.example' })).status, 403);
    assert.equal(seen.length, 0);
    const bad = await get(port, q('https://example.com/x'), { 'x-forge-token': token });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.text).error, /not a GitHub/);
    assert.equal((await get(port, '/api/github/preview', { 'x-forge-token': token })).status, 400);
    assert.equal(seen.length, 0, 'a refused URL never reaches gh');
    const good = await get(port, target, { 'x-forge-token': token, origin: `http://127.0.0.1:${port}` });
    assert.equal(good.status, 200);
    const body = JSON.parse(good.text);
    assert.equal(body.preview.kind, 'pull');
    assert.equal(body.preview.title, 'Add <b>bold</b> widgets', 'GitHub text passes through as data; the dashboard escapes it');
    await get(port, target, { 'x-forge-token': token });
    assert.equal(seen.length, 1, 'the second ask is served from the cache');
  } finally {
    await close();
    repo.cleanup();
  }
});
