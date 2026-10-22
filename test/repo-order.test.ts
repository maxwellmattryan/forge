// The merge order of a multi-repo job's PRs and its sibling line: pure, no repo or gh needed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { jobRepoOrder, nextMergeable, siblingLine } from '../lib/engine/project/repo-order.ts';
import type { RepoKey } from '../lib/engine/project/repo-order.ts';

const repo = (name: string, verifyOnly = false) => ({ repo: name, worktree: null, branch: null, base: 'main', pr: null, verifyOnly });
const job = (...members: ReturnType<typeof repo>[]) => ({ repos: [{ ...repo('x'), repo: null }, ...members] }) as any;
const repos = (...names: string[]) => names.map((name) => ({ name, remote: `git@github.com:o/${name}.git`, defaultBranch: 'main' }));
const comp = (name: string, r: string | null, ...deps: [string, 'build' | 'runtime'][]) => ({ name, repo: r, kind: 'service', path: '.', dependsOn: deps.map(([component, type]) => ({ component, type })) });
const plain = (o: ReturnType<typeof jobRepoOrder>) => ({ order: o.order, deps: Object.fromEntries([...o.deps].map(([k, v]) => [String(k), v])), relaxed: o.relaxed, cycle: o.cycle });

describe('jobRepoOrder', () => {
  test('root as consumer: app depends on lib', () => {
    const o = jobRepoOrder({ repos: repos('lib'), components: [comp('app', null, ['lib', 'build']), comp('lib', 'lib')] } as any, job(repo('lib')));
    assert.deepEqual(plain(o), { order: ['lib', null], deps: { null: ['lib'], lib: [] }, relaxed: false, cycle: null });
  });

  test('root as dependency: lib depends on app', () => {
    const o = jobRepoOrder({ repos: repos('lib'), components: [comp('app', null), comp('lib', 'lib', ['app', 'runtime'])] } as any, job(repo('lib')));
    assert.deepEqual(plain(o), { order: [null, 'lib'], deps: { null: [], lib: [null] }, relaxed: false, cycle: null });
  });

  test('unrelated repos keep job.repos order', () => {
    const o = jobRepoOrder({ repos: repos('b', 'a'), components: [comp('app', null), comp('a', 'a'), comp('b', 'b')] } as any, job(repo('b'), repo('a')));
    assert.deepEqual(o.order, [null, 'b', 'a']);
    assert.equal(o.cycle, null);
  });

  test('a dependency through a repo outside the job counts', () => {
    const config = { repos: repos('mid', 'lib'), components: [comp('app', null, ['mid', 'build']), comp('mid', 'mid', ['lib', 'build']), comp('lib', 'lib')] } as any;
    const o = jobRepoOrder(config, job(repo('lib')));
    assert.deepEqual(plain(o), { order: ['lib', null], deps: { null: ['lib'], lib: [] }, relaxed: false, cycle: null });
  });

  test('verify-only members are left out', () => {
    const config = { repos: repos('lib', 'docs'), components: [comp('app', null, ['lib', 'build'], ['docs', 'build']), comp('lib', 'lib'), comp('docs', 'docs')] } as any;
    const o = jobRepoOrder(config, job(repo('docs', true), repo('lib')));
    assert.deepEqual(o.order, ['lib', null]);
    assert.ok(!o.deps.has('docs'));
  });

  test('a runtime-only cycle falls back to build edges', () => {
    const config = { repos: repos('lib'), components: [comp('app', null, ['lib', 'runtime']), comp('lib', 'lib', ['app', 'build'])] } as any;
    const o = jobRepoOrder(config, job(repo('lib')));
    assert.deepEqual(plain(o), { order: [null, 'lib'], deps: { null: [], lib: [null] }, relaxed: true, cycle: null });
  });

  test('a build cycle falls back to job.repos order and reports it', () => {
    const config = { repos: repos('lib', 'other'), components: [comp('app', null, ['lib', 'build']), comp('lib', 'lib', ['app', 'build']), comp('other', 'other')] } as any;
    const o = jobRepoOrder(config, job(repo('lib'), repo('other')));
    assert.deepEqual([o.order, o.relaxed, o.cycle], [[null, 'lib', 'other'], true, [null, 'lib']]);
  });

  test('malformed components are ignored and nothing throws', () => {
    const j = job(repo('lib'));
    for (const components of [undefined, null, 'x', 7, {}, [null, 'x', { name: 'app' }]])
      assert.deepEqual(jobRepoOrder({ repos: repos('lib'), components } as any, j).order, [null, 'lib'], String(components));
    // An unknown repo or an unknown component is no edge.
    const config = { repos: repos('lib'), components: [comp('app', null, ['ghost', 'build'], ['far', 'build']), comp('far', 'nowhere'), comp('lib', 'lib', ['app', 'nope' as any])] } as any;
    assert.deepEqual(plain(jobRepoOrder(config, j)), { order: [null, 'lib'], deps: { null: [], lib: [] }, relaxed: false, cycle: null });
    assert.deepEqual(jobRepoOrder({ repos: 'x', components: 'y' } as any, { repos: 'z' } as any).order, [null]);
  });
});

describe('siblingLine', () => {
  test('graph order, the cycle variant, and fewer than two refs', () => {
    const refs = [{ slug: 'o/lib', number: 7 }, { slug: 'o/app', number: 11 }];
    assert.equal(siblingLine('j1', refs, false), 'Part of job j1: o/lib#7 then o/app#11');
    assert.equal(siblingLine('j1', refs, true), "Part of job j1: o/lib#7, o/app#11 (no merge order: the components' dependsOn form a cycle)");
    assert.equal(siblingLine('j1', refs.slice(0, 1), false), null);
    assert.equal(siblingLine('j1', [], false), null);
  });

  test('a ref whose slug or number is unsafe is left out', () => {
    const bad = ['o/lib)[x](http://e)', '@o/lib', 'o/lib/extra', 'o', 'o/lib\n#1', ''];
    for (const slug of bad) assert.equal(siblingLine('j', [{ slug, number: 1 }, { slug: 'o/app', number: 2 }], false), null, slug);
    assert.equal(siblingLine('j', [{ slug: 'o/a', number: 0 }, { slug: 'o/b', number: 2 }], false), null);
    assert.equal(siblingLine('j', [{ slug: 'o/a', number: 1.5 }, { slug: 'o/b', number: 2 }, { slug: 'o/c', number: 3 }], false), 'Part of job j: o/b#2 then o/c#3');
  });
});

test('nextMergeable', () => {
  const order: RepoKey[] = ['lib', null];
  const deps = new Map<RepoKey, RepoKey[]>([['lib', []], [null, ['lib']]]);
  assert.equal(nextMergeable(order, deps, new Map([['lib', 'OPEN'], [null, 'OPEN']])), 'lib');
  assert.equal(nextMergeable(order, deps, new Map<RepoKey, any>([['lib', 'MERGED'], [null, 'OPEN']])), null);
  assert.equal(nextMergeable(order, deps, new Map<RepoKey, any>([['lib', 'MERGED'], [null, 'MERGED']])), undefined);
  assert.equal(nextMergeable([null, 'lib'], new Map<RepoKey, RepoKey[]>([['lib', [null]], [null, []]]), new Map<RepoKey, any>([[null, null], ['lib', 'OPEN']])), null);
});
