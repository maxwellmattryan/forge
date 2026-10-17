// `forge job interim release`: a human records that the dependency of a local or sequential edge was
// released, which clears its consumers' release gate. Scratch repos from job-repos-fixture.ts; no
// gh call and no network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dependsOn, twoRepo } from './job-repos-fixture.ts';
import type { TwoRepo } from './job-repos-fixture.ts';
import { TRUST_ENV, trustDigest } from '../lib/config.ts';
import { RELEASE_DAEMON_REFUSAL } from '../lib/interim-apply.ts';
import { isReleaseVersion, releaseGates, releasedVersion } from '../lib/interim.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

/** The two-repo project, `app` (root) on `lib`, and a job with lib as a member. */
async function setup(edge: 'app-on-lib' | 'lib-on-app' = 'app-on-lib') {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  dependsOn(p, edge);
  const j = await p.f('job', 'new', '--title', `release ${Math.random().toString(36).slice(2, 8)}`);
  await p.f('job', 'repo', 'add', j.id, 'lib');
  return { p, id: j.id as string };
}

const jobFile = (p: TwoRepo, id: string) => path.join(p.root, '.forge', 'jobs', id, 'job.json');
/** Writes a PR record straight into job.json (null: the root's), as pr open and pr sync would. */
function recordPr(p: TwoRepo, id: string, repo: string | null, state: string, extra: Record<string, unknown> = {}): void {
  const job = JSON.parse(fs.readFileSync(jobFile(p, id), 'utf8'));
  const pr = { number: repo === null ? 11 : 7, url: null, state, isDraft: false, ...extra };
  if (repo === null) job.pr = pr;
  else job.repos.find((r: any) => r.repo === repo).pr = pr;
  fs.writeFileSync(jobFile(p, id), JSON.stringify(job, null, 2));
}
const released = (p: TwoRepo, id: string) => p.events(id).filter((e) => e.type === 'interim-released');
const appendEvent = (p: TwoRepo, id: string, e: Record<string, unknown>) =>
  fs.appendFileSync(path.join(p.root, '.forge', 'jobs', id, 'events.jsonl'), JSON.stringify({ v: 2, ts: new Date().toISOString(), ...e }) + '\n');

describe('interim release', { concurrency: 4 }, () => {
  test('release is human-only', async () => {
    const { p, id } = await setup();
    recordPr(p, id, 'lib', 'MERGED');
    const r = await p.raw(['job', 'interim', 'release', id, 'lib', '1.2.0'], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) });
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stderr.includes(RELEASE_DAEMON_REFUSAL), r.stderr);
    assert.equal(RELEASE_DAEMON_REFUSAL, "forge job interim release records a dependency's release, which a daemon session may not do; a human runs it in their own session");
    // Refused before the job is read: a job that does not exist gets the same answer.
    const none = await p.raw(['job', 'interim', 'release', 'no-such-job', 'lib', '1.2.0'], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) });
    assert.ok(none.stderr.includes(RELEASE_DAEMON_REFUSAL), none.stderr);
    assert.deepEqual(released(p, id), []);
  });

  test('release refusals', async () => {
    const { p, id } = await setup();
    const refused = async (args: string[], re: RegExp) => {
      const r = await p.raw(['job', 'interim', 'release', ...args]);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}`);
      assert.match(r.stderr, re, args.join(' '));
    };
    await refused(['no-such-job', 'lib', '1.2.0'], /no-such-job/);
    await refused([id, 'other', '1.2.0'], /has no repo "other"/);
    await refused([id, '--root', '1.2.0'], /the root repo is not the dependency of a local or sequential edge .*no edge depends on it/);
    await refused([id, 'lib', '1.2.0'], /repo lib's PR is not merged \(recorded state none\); a release comes from a merged change; run: forge pr sync /);
    recordPr(p, id, 'lib', 'OPEN');
    await refused([id, 'lib', '1.2.0'], /repo lib's PR is not merged \(recorded state OPEN\)/);
    recordPr(p, id, 'lib', 'MERGED');
    for (const bad of ['1.2', '01.2.0', 'latest', `1.2.0-${'x'.repeat(130)}`, '1.2.0 ']) await refused([id, 'lib', bad], /is not a semver version/);
    for (const canary of ['1.2.0-canary.abc123', '1.2.0-CANARY', '1.2.0+canary']) await refused([id, 'lib', canary], /is a canary; a release gate clears only on a released version/);
    p.config((c) => (c.repos[0].release = { interim: 'git-ref' }));
    await refused([id, 'lib', '1.2.0'], /repo lib is not the dependency of a local or sequential edge .*its edges are git-ref; the release-gate check guards those/);
    p.config((c) => (c.repos[0].release = { interim: 'local' }));
    const job = JSON.parse(fs.readFileSync(jobFile(p, id), 'utf8'));
    for (const state of ['done', 'cancelled']) {
      fs.writeFileSync(jobFile(p, id), JSON.stringify({ ...job, state }, null, 2));
      await refused([id, 'lib', '1.2.0'], new RegExp(`job ${id} is ${state}`));
    }
    fs.writeFileSync(jobFile(p, id), JSON.stringify(job, null, 2));
    const usage = await p.raw(['job', 'interim', 'release', id, 'lib']);
    assert.equal(usage.status, 2, 'a missing version is a usage error');
    assert.deepEqual(released(p, id), [], 'no refusal writes an event');
  });

  test('release records once and opens the gate', async () => {
    const { p, id } = await setup();
    let interim = await p.f('job', 'interim', id);
    assert.deepEqual(interim.gates, [{ consumer: null, dependency: 'lib', strategy: 'local', gate: 'held' }]);
    recordPr(p, id, 'lib', 'MERGED');
    assert.deepEqual(await p.f('job', 'interim', 'release', id, 'lib', '1.2.0'), { id, repo: 'lib', version: '1.2.0', recorded: true, clear: [null] });
    assert.deepEqual(released(p, id).map((e) => [e.repo, e.version]), [['lib', '1.2.0']]);
    assert.deepEqual(await p.f('job', 'interim', 'release', id, 'lib', '1.2.0'), { id, repo: 'lib', version: '1.2.0', recorded: false, clear: [null] });
    assert.equal(released(p, id).length, 1, 'the same version again logs nothing');
    interim = await p.f('job', 'interim', id);
    assert.deepEqual(interim.gates, [{ consumer: null, dependency: 'lib', strategy: 'local', gate: 'released', version: '1.2.0' }]);
    assert.equal((await p.f('job', 'interim', 'release', id, 'lib', 'v1.3.0')).recorded, true, 'a later version is logged');
    assert.equal((await p.f('job', 'interim', id)).gates[0].version, 'v1.3.0', 'the latest wins');
  });

  test('--root in either position', async () => {
    const { p, id } = await setup('lib-on-app');
    p.config((c) => (c.release = { interim: 'sequential' }));
    recordPr(p, id, null, 'MERGED');
    assert.deepEqual(await p.f('job', 'interim', 'release', id, '--root', '2.0.0'), { id, repo: null, version: '2.0.0', recorded: true, clear: ['lib'] });
    assert.deepEqual(await p.f('job', 'interim', 'release', id, '2.0.1', '--root'), { id, repo: null, version: '2.0.1', recorded: true, clear: ['lib'] });
    assert.deepEqual(released(p, id).map((e) => [e.repo, e.version]), [[null, '2.0.0'], [null, '2.0.1']]);
    assert.deepEqual((await p.f('job', 'interim', id)).gates, [{ consumer: 'lib', dependency: null, strategy: 'sequential', gate: 'released', version: '2.0.1' }]);
    const extra = await p.raw(['job', 'interim', 'release', id, 'lib', '2.0.0', '--root']);
    assert.equal(extra.status, 2, 'a name and --root together is a usage error');
  });

  test('a malformed event is ignored', async () => {
    const { p, id } = await setup();
    for (const e of [
      { type: 'interim-released', repo: 'lib', version: '1.2.0-canary.abc' },
      { type: 'interim-released', repo: 'lib', version: 'not a version' },
      { type: 'interim-released', repo: 'lib', version: 12 },
      { type: 'interim-released', repo: '../x', version: '1.2.0' },
      { type: 'interim-released', version: '1.2.0' },
      { type: 'interim-released', repo: 'lib', version: `1.2.0+${'a'.repeat(118)}` },
    ])
      appendEvent(p, id, e);
    assert.deepEqual((await p.f('job', 'interim', id)).gates, [{ consumer: null, dependency: 'lib', strategy: 'local', gate: 'held' }]);
    appendEvent(p, id, { type: 'interim-released', repo: 'lib', version: '1.2.0' });
    assert.equal((await p.f('job', 'interim', id)).gates[0].gate, 'released', 'a well-formed one counts, as documented');
  });

  test('gate helpers', () => {
    assert.equal(isReleaseVersion('1.2.0'), true);
    assert.equal(isReleaseVersion('v1.2.0-rc.1+build.5'), true);
    assert.equal(isReleaseVersion('1.2.0-Canary'), false);
    assert.equal(isReleaseVersion(`1.${'9'.repeat(10_000)}.0`), false, 'a long hostile value is refused fast');
    const events = [
      { type: 'interim-released', repo: 'lib', version: '1.0.0' },
      { type: 'interim-released', repo: null, version: '2.0.0' },
      { type: 'interim-released', repo: 'lib', version: 'bad' },
    ];
    assert.equal(releasedVersion(events, 'lib'), '1.0.0');
    assert.equal(releasedVersion(events, null), '2.0.0');
    assert.equal(releasedVersion(events, 'other'), null);
    assert.deepEqual(
      releaseGates(
        [
          { consumer: null, dependency: 'lib', strategy: 'git-ref' },
          { consumer: null, dependency: 'lib', strategy: 'canary' },
          { consumer: 'lib', dependency: null, strategy: 'sequential' },
          { consumer: 'web', dependency: 'other', strategy: 'local' },
        ],
        events,
      ).map((g) => [g.gate, g.version]),
      [['ci', undefined], ['ci', undefined], ['released', '2.0.0'], ['held', undefined]],
    );
  });
});
