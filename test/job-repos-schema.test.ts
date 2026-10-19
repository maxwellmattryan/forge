// Job repos (job schemaVersion 12): the schema, migration and normaliser. Pure data, no sh, so unlike
// job-repos.test.ts this file also runs on CI's Windows leg.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, loadJob, setJob, updateJob } from '../lib/jobs.ts';
import { JOB_SCHEMA_VERSION, normalizeJob } from '../lib/schema.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const PR = { number: 7, url: 'https://github.com/o/app/pull/7', state: 'OPEN', isDraft: false, lastSyncedAt: '2026-10-01T00:00:00.000Z', pushedSha: 'a'.repeat(40) };

describe('job repos: schema', { concurrency: 4 }, () => {
  test('v11 jobs in every stage migrate to one root repo and keep every field', () => {
    assert.equal(JOB_SCHEMA_VERSION, 14);
    const repo = tempRepo();
    cleanups.push(repo.cleanup);
    const config = defaults();
    const stages: [string, Record<string, unknown>][] = [
      ['backlog', {}],
      ['build', { worktree: '/tmp/x.worktrees/j', port: 4100 }],
      ['review', { worktree: '/tmp/x.worktrees/j', round: 2 }],
      ['pr', { worktree: '/tmp/x.worktrees/j', pr: PR }],
      ['done', { state: 'done', pr: { ...PR, state: 'MERGED' } }],
    ];
    for (const [stage, extra] of stages) {
      const job = createJob(repo.dir, config, { title: `v11 ${stage}` });
      const file = path.join(jobDir(repo.dir, job.id), 'job.json');
      // What a v11 Forge wrote: its normalised job, without repos.
      const { repos: _r, interim: _i, ports: _p, ...v11 } = { ...JSON.parse(fs.readFileSync(file, 'utf8')), stage, ...extra, schemaVersion: 11 };
      fs.writeFileSync(file, JSON.stringify(v11));
      const loaded = loadJob(repo.dir, job.id);
      assert.equal(loaded.schemaVersion, 14, stage);
      const { repos, schemaVersion: _v, interim, ports, ...rest } = loaded;
      assert.equal(interim, null, `${stage}: v13 adds no override`);
      assert.deepEqual(ports, {}, `${stage}: v14 adds no ports until the next worktree create`);
      const { schemaVersion: _w, ...before } = v11;
      assert.deepEqual(rest, before, `${stage}: every v11 field is unchanged`);
      assert.deepEqual(repos, [{ repo: null, worktree: v11.worktree, branch: v11.branch, base: v11.base, pr: v11.pr, verifyOnly: false, interim: null }], stage);
      // Written back as v14 and read again, it is the same job.
      updateJob(repo.dir, job.id, () => {});
      const { updatedAt: _a, ...again } = loadJob(repo.dir, job.id);
      const { updatedAt: _b, ...first } = loaded;
      assert.deepEqual(again, first, `${stage}: a v14 file reads back unchanged`);
    }
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 15 })._unsupported, true, 'a newer file is still refused');
  });

  test('repos[0] mirrors the top-level fields and member branches are derived', () => {
    const repo = tempRepo();
    cleanups.push(repo.cleanup);
    const job = createJob(repo.dir, defaults(), { title: 'mirror' });
    setJob(repo.dir, job.id, { fields: { worktree: '/w/one', base: 'develop', pr: PR } });
    setJob(repo.dir, job.id, { fields: { 'pr.pushedSha': 'b'.repeat(40) } });
    let j = loadJob(repo.dir, job.id);
    assert.deepEqual(j.repos[0], { repo: null, worktree: '/w/one', branch: j.branch, base: 'develop', pr: { ...PR, pushedSha: 'b'.repeat(40) }, verifyOnly: false, interim: null });
    const file = path.join(jobDir(repo.dir, job.id), 'job.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.repos = [
      { repo: 'evil', worktree: '/elsewhere', branch: 'main', base: 'x', pr: null, verifyOnly: true },
      { repo: 'lib', worktree: '/w/lib', branch: 'main', base: 'main', pr: null, verifyOnly: false },
      { repo: 'docs', worktree: null, branch: 'main', base: 'main', pr: null, verifyOnly: true },
    ];
    fs.writeFileSync(file, JSON.stringify(raw));
    j = loadJob(repo.dir, job.id);
    assert.deepEqual(j.repos[0], { repo: null, worktree: '/w/one', branch: j.branch, base: 'develop', pr: { ...PR, pushedSha: 'b'.repeat(40) }, verifyOnly: false, interim: null }, 'a hand-edited repos[0] is overwritten');
    assert.equal(j.repos[1].branch, j.branch, "a member's branch is always the job's");
    assert.equal(j.repos[2].branch, null, 'a verify-only member has none');
    setJob(repo.dir, job.id, { fields: { worktree: null } });
    assert.equal(loadJob(repo.dir, job.id).repos[0].worktree, null);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).repos[0].worktree, null, 'serializeJob writes the mirror too');
  });

  test('malformed member entries are dropped or nulled', () => {
    const base = { id: 'x', schemaVersion: 12, branch: 'forge/x', base: 'main' };
    const good = { repo: 'lib', worktree: '/w/lib', base: 'main', pr: null, verifyOnly: false };
    const repos = (list: unknown) => normalizeJob({ ...base, repos: [{}, ...(list as unknown[])] }).repos;
    assert.deepEqual(repos([{ repo: '--upload-pack=x' }, { repo: '../x' }, { repo: 'a/b' }, { repo: null }, { repo: 7 }, 'str', null, [], good, { ...good, worktree: '/other' }]).map((r) => r.repo), [null, 'lib'], 'bad names, a null repo after index 0 and duplicates are dropped');
    const [, m] = repos([{ repo: 'lib', worktree: 'a\0b', base: '-main', pr: { number: -1 }, verifyOnly: 'yes' }]);
    assert.deepEqual(m, { repo: 'lib', worktree: null, branch: 'forge/x', base: null, pr: null, verifyOnly: false, interim: null });
    for (const pr of [{ number: 1.5 }, { number: '7' }, 'x', [], { number: 2 ** 60 }]) assert.equal(repos([{ repo: 'lib', pr }])[1].pr, null, JSON.stringify(pr));
    assert.deepEqual(repos([{ repo: 'lib', pr: { number: 3, url: 'javascript:alert(1)' } }])[1].pr, { number: 3, url: null });
    assert.deepEqual(repos([{ repo: 'lib', pr: { number: 3, url: 'http://github.com/o/l/pull/3' } }])[1].pr, { number: 3, url: null }, 'https only');
    const kept = { number: 3, url: 'https://github.com/o/l/pull/3', state: 'OPEN', isDraft: false, openedAt: 'a', lastSyncedAt: 'b', pushedSha: 'c'.repeat(40), headOid: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', checks: { state: 'none', passing: 0, failing: 0, pending: 0 }, mergedAt: null };
    assert.deepEqual(repos([{ repo: 'lib', pr: { ...kept, junk: '<x>', __proto__x: 1 } }])[1].pr, kept, 'only the keys Forge writes for a member PR are kept');
    for (const r of [undefined, null, 'x', {}, 5]) assert.equal(normalizeJob({ ...base, repos: r }).repos.length, 1, String(r));
  });

  test('v12 job gains interim null and repos[0] mirrors the root override', () => {
    const v12 = { id: 'x', schemaVersion: 12, branch: 'forge/x', base: 'main', repos: [{}, { repo: 'lib', worktree: null, base: 'main', pr: null, verifyOnly: false }] };
    const j = normalizeJob(v12);
    assert.equal(j.schemaVersion, 14);
    assert.equal(j.interim, null);
    assert.deepEqual(j.repos.map((r) => r.interim), [null, null]);
    const set = normalizeJob({ ...v12, schemaVersion: 13, interim: 'sequential', repos: [{ interim: 'canary' }, { ...v12.repos[1], interim: 'git-ref' }] });
    assert.deepEqual([set.interim, set.repos[0].interim, set.repos[1].interim], ['sequential', 'sequential', 'git-ref'], 'repos[0] mirrors the top-level override, never its own stored value');
    const bogus = normalizeJob({ ...v12, schemaVersion: 13, interim: 'bogus', repos: [{}, { ...v12.repos[1], interim: 'bogus' }] });
    assert.deepEqual([bogus.interim, bogus.repos[0].interim, bogus.repos[1].interim], [null, null, null], 'an invalid stored value normalises to null');
    for (const v of [7, {}, ['canary'], 'LOCAL', 'publish']) assert.equal(normalizeJob({ ...v12, schemaVersion: 13, interim: v }).interim, null, JSON.stringify(v));
  });
});
