// Interim strategies through the CLI: `forge job interim` resolves each edge's strategy (job
// override, then config, then local), and `forge job repo interim` sets and clears the override.
// Scratch root + member repos from job-repos-fixture.ts; nothing reaches a network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dependsOn, twoRepo } from './job-repos-fixture.ts';
import { TRUST_ENV, trustDigest } from '../lib/config.ts';
import type { TwoRepo } from './job-repos-fixture.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

async function project(): Promise<TwoRepo> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  return p;
}

async function job(p: TwoRepo, verifyOnly = false): Promise<string> {
  const j = await p.f('job', 'new', '--title', `interim ${Math.random().toString(36).slice(2, 8)}`);
  await p.f('job', 'repo', 'add', ...(verifyOnly ? ['--verify-only'] : []), j.id, 'lib');
  return j.id;
}

const brief = (r: any) => r.edges.map((e: any) => [e.consumer, e.dependency, e.strategy, e.source, e.state]);
const jobJson = (p: TwoRepo, id: string) => JSON.parse(fs.readFileSync(path.join(p.root, '.forge', 'jobs', id, 'job.json'), 'utf8'));

describe('interim strategies: CLI', { concurrency: 4 }, () => {
  test('job interim resolves default, config and job override', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    const id = await job(p);
    const first = await p.f('job', 'interim', id);
    assert.deepEqual(brief(first), [[null, 'lib', 'local', 'config', 'held']]);
    assert.equal(first.edges[0].detail, "the root repo's PR opens as a draft (interim: local)");
    assert.deepEqual(first.edges[0].links, [], 'no dependsOn link');
    p.config((c) => (c.repos[0].release = { interim: 'sequential' }));
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [[null, 'lib', 'sequential', 'config', 'waiting']]);
    assert.equal((await p.f('job', 'interim', id)).edges[0].detail, 'repo lib has no PR yet');
    await p.f('job', 'repo', 'interim', id, 'lib', 'local');
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [[null, 'lib', 'local', 'job', 'held']], 'a job override wins over config');
    const single = await p.f('job', 'new', '--title', 'single repo');
    assert.deepEqual((await p.f('job', 'interim', single.id)).edges, []);
  });

  test('root repo as dependency resolves through release.interim', async () => {
    const p = await project();
    dependsOn(p, 'lib-on-app');
    const id = await job(p);
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [['lib', null, 'local', 'config', 'held']]);
    p.config((c) => {
      c.release = { interim: 'sequential' };
      c.repos[0].release = { interim: 'git-ref' };
    });
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [['lib', null, 'sequential', 'config', 'waiting']], "the root's own release.interim, not a member's");
    assert.deepEqual(await p.f('job', 'repo', 'interim', id, '--root', 'local'), { id, repo: null, interim: 'local' });
    assert.deepEqual(brief(await p.f('job', 'interim', id)), [['lib', null, 'local', 'job', 'held']]);
    const raw = jobJson(p, id);
    assert.deepEqual([raw.interim, raw.repos[0].interim, raw.repos[1].interim], ['local', 'local', null]);
  });

  test('job repo interim sets, clears and refuses', async () => {
    const p = await project();
    dependsOn(p, 'app-on-lib');
    const id = await job(p);
    assert.deepEqual(await p.f('job', 'repo', 'interim', id, 'lib', 'sequential'), { id, repo: 'lib', interim: 'sequential' });
    assert.equal(jobJson(p, id).repos[1].interim, 'sequential');
    assert.deepEqual(await p.f('job', 'repo', 'interim', id, 'lib', 'inherit'), { id, repo: 'lib', interim: null });
    assert.equal(jobJson(p, id).repos[1].interim, null);
    assert.deepEqual(p.events(id).filter((e) => e.type === 'job-repo-interim').map((e) => [e.repo, e.interim]), [['lib', 'sequential'], ['lib', null]]);

    const before = fs.readFileSync(path.join(p.root, '.forge', 'jobs', id, 'job.json'), 'utf8');
    const daemon = await p.raw(['job', 'repo', 'interim', id, 'lib', 'canary'], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) });
    assert.equal(daemon.status, 1, daemon.stdout);
    assert.match(daemon.stderr, /a daemon session may not change; a human runs it in their own session/);
    assert.equal(fs.readFileSync(path.join(p.root, '.forge', 'jobs', id, 'job.json'), 'utf8'), before, 'job.json unchanged');

    const unknown = await p.raw(['job', 'repo', 'interim', id, 'nope', 'local']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /has no repo "nope"/);
    const bogus = await p.raw(['job', 'repo', 'interim', id, 'lib', 'publish']);
    assert.equal(bogus.status, 1);
    assert.match(bogus.stderr, /strategy must be one of canary \| git-ref \| local \| sequential \| inherit/);
    const v = await job(p, true);
    const vo = await p.raw(['job', 'repo', 'interim', v, 'lib', 'local']);
    assert.equal(vo.status, 1);
    assert.match(vo.stderr, /repo lib is verify-only/);
    const set = await p.raw(['job', 'set', id, '--field', 'interim="canary"']);
    assert.equal(set.status, 1, 'job set cannot write the override');

    for (const ecosystem of ['cargo', 'cmake']) {
      p.config((c) => (c.components.find((x: any) => x.name === 'app').dependsOn = [{ component: 'lib', type: 'build', link: { ecosystem, name: 'engine' } }]));
      const r = await p.raw(['job', 'repo', 'interim', id, 'lib', 'canary']);
      assert.equal(r.status, 1, ecosystem);
      assert.match(r.stderr, new RegExp(`canary is npm-only, and the root repo depends on repo lib through the ${ecosystem} link engine`));
    }
    p.config((c) => (c.components.find((x: any) => x.name === 'app').dependsOn = [{ component: 'lib', type: 'build', link: { ecosystem: 'npm', name: 'engine' } }]));
    assert.deepEqual(await p.f('job', 'repo', 'interim', id, 'lib', 'canary'), { id, repo: 'lib', interim: 'canary' }, 'an npm link takes a canary');
  });
});
