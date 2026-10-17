// Job repos (job schemaVersion 12): one job changing member repos beside the root repo, each with
// its own worktree, verify evidence and branch. Scratch repos only; see job-repos-fixture.ts.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { twoRepo } from './job-repos-fixture.ts';
import type { TwoRepo } from './job-repos-fixture.ts';
import { TRUST_ENV, defaults, trustDigest } from '../lib/config.ts';
import { createJob, jobDir, loadJob, setJob, updateJob } from '../lib/jobs.ts';
import { JOB_SCHEMA_VERSION, normalizeJob } from '../lib/schema.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
async function project(): Promise<TwoRepo> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  return p;
}

const PR = { number: 7, url: 'https://github.com/o/app/pull/7', state: 'OPEN', isDraft: false, lastSyncedAt: '2026-10-01T00:00:00.000Z', pushedSha: 'a'.repeat(40) };

describe('job repos: schema', { concurrency: 4 }, () => {
  test('v11 jobs in every stage migrate to one root repo and keep every field', () => {
    assert.equal(JOB_SCHEMA_VERSION, 12);
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
      const { repos: _r, ...v11 } = { ...JSON.parse(fs.readFileSync(file, 'utf8')), stage, ...extra, schemaVersion: 11 };
      fs.writeFileSync(file, JSON.stringify(v11));
      const loaded = loadJob(repo.dir, job.id);
      assert.equal(loaded.schemaVersion, 12, stage);
      const { repos, schemaVersion: _v, ...rest } = loaded;
      const { schemaVersion: _w, ...before } = v11;
      assert.deepEqual(rest, before, `${stage}: every v11 field is unchanged`);
      assert.deepEqual(repos, [{ repo: null, worktree: v11.worktree, branch: v11.branch, base: v11.base, pr: v11.pr, verifyOnly: false }], stage);
      // Written back as v12 and read again, it is the same job.
      updateJob(repo.dir, job.id, () => {});
      const { updatedAt: _a, ...again } = loadJob(repo.dir, job.id);
      const { updatedAt: _b, ...first } = loaded;
      assert.deepEqual(again, first, `${stage}: a v12 file reads back unchanged`);
    }
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 13 })._unsupported, true, 'a newer file is still refused');
  });

  test('repos[0] mirrors the top-level fields and member branches are derived', () => {
    const repo = tempRepo();
    cleanups.push(repo.cleanup);
    const job = createJob(repo.dir, defaults(), { title: 'mirror' });
    setJob(repo.dir, job.id, { fields: { worktree: '/w/one', base: 'develop', pr: PR } });
    setJob(repo.dir, job.id, { fields: { 'pr.pushedSha': 'b'.repeat(40) } });
    let j = loadJob(repo.dir, job.id);
    assert.deepEqual(j.repos[0], { repo: null, worktree: '/w/one', branch: j.branch, base: 'develop', pr: { ...PR, pushedSha: 'b'.repeat(40) }, verifyOnly: false });
    const file = path.join(jobDir(repo.dir, job.id), 'job.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.repos = [
      { repo: 'evil', worktree: '/elsewhere', branch: 'main', base: 'x', pr: null, verifyOnly: true },
      { repo: 'lib', worktree: '/w/lib', branch: 'main', base: 'main', pr: null, verifyOnly: false },
      { repo: 'docs', worktree: null, branch: 'main', base: 'main', pr: null, verifyOnly: true },
    ];
    fs.writeFileSync(file, JSON.stringify(raw));
    j = loadJob(repo.dir, job.id);
    assert.deepEqual(j.repos[0], { repo: null, worktree: '/w/one', branch: j.branch, base: 'develop', pr: { ...PR, pushedSha: 'b'.repeat(40) }, verifyOnly: false }, 'a hand-edited repos[0] is overwritten');
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
    assert.deepEqual(m, { repo: 'lib', worktree: null, branch: 'forge/x', base: null, pr: null, verifyOnly: false });
    for (const pr of [{ number: 1.5 }, { number: '7' }, 'x', [], { number: 2 ** 60 }]) assert.equal(repos([{ repo: 'lib', pr }])[1].pr, null, JSON.stringify(pr));
    assert.deepEqual(repos([{ repo: 'lib', pr: { number: 3, url: 'javascript:alert(1)' } }])[1].pr, { number: 3, url: null });
    assert.deepEqual(repos([{ repo: 'lib', pr: { number: 3, url: 'http://github.com/o/l/pull/3' } }])[1].pr, { number: 3, url: null }, 'https only');
    for (const r of [undefined, null, 'x', {}, 5]) assert.equal(normalizeJob({ ...base, repos: r }).repos.length, 1, String(r));
  });
});

describe('job repos: forge job repo', { concurrency: 4 }, () => {
  test('job repo add validates against config and local.yml', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'two repos');
    const added = await p.f('job', 'repo', 'add', j.id, 'lib');
    assert.equal(added.id, j.id);
    assert.deepEqual(added.repos[1], { repo: 'lib', worktree: null, branch: `forge/${j.id}`, base: 'main', pr: null, verifyOnly: false });
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'job-repo-added').map((e) => [e.repo, e.verifyOnly]), [['lib', false]]);
    const fail = async (args: string[], re: RegExp) => {
      const r = await p.raw(args);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr + r.stdout, re);
    };
    await fail(['job', 'repo', 'add', j.id, 'lib'], /already has repo lib/);
    await fail(['job', 'repo', 'add', j.id, 'nope'], /repo "nope" is not a repos entry/);
    // No local.yml path: doctor's detail, with its fix.
    p.config((c) => c.repos.push({ name: 'docs', remote: 'https://example.com/docs.git', defaultBranch: 'main' }));
    await fail(['job', 'repo', 'add', j.id, 'docs'], /repo docs: no path in \.forge\/local\.yml; clone it: git clone/);
    // A wrong remote.
    p.config((c) => (c.repos[0].remote = 'https://example.com/other.git'));
    const k = await p.f('job', 'new', '--title', 'wrong remote');
    await fail(['job', 'repo', 'add', k.id, 'lib'], /remote "origin" is .*expected https:\/\/example\.com\/other\.git; run: git -C/);
    p.config((c) => (c.repos[0].remote = p.libBare));
    // A done job and one at stage pr.
    await p.f('job', 'set', k.id, '--stage', 'pr');
    await fail(['job', 'repo', 'add', k.id, 'lib'], /at stage pr/);
    await p.f('job', 'set', k.id, '--stage', 'done', '--state', 'done');
    await fail(['job', 'repo', 'add', k.id, 'lib'], /at stage done/);
    await fail(['job', 'repo', 'add', 'no-such-job', 'lib'], /no job "no-such-job"/);
    const v = await p.f('job', 'new', '--title', 'verify only');
    const vo = await p.f('job', 'repo', 'add', '--verify-only', v.id, 'lib');
    assert.deepEqual(vo.repos[1], { repo: 'lib', worktree: null, branch: null, base: 'main', pr: null, verifyOnly: true });
  });

  test('repos is writable only by a human through forge job repo', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'locked');
    const daemon = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) };
    for (const args of [['job', 'repo', 'add', j.id, 'lib'], ['job', 'repo', 'remove', j.id, 'lib']]) {
      const r = await p.raw(args, daemon);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr + r.stdout, /daemon session may not change/);
    }
    for (const field of ['repos=[]', 'repos.1.verifyOnly=false']) {
      const r = await p.raw(['job', 'set', j.id, '--field', field]);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr + r.stdout, /--field repos is not settable; use forge job repo add\|remove/);
    }
    assert.equal(loadJob(p.root, j.id).repos.length, 1);
  });
});
