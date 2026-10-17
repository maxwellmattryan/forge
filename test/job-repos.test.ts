// Job repos (job schemaVersion 12): one job changing member repos beside the root repo, each with
// its own worktree, verify evidence and branch. Scratch repos only; see job-repos-fixture.ts.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { twoRepo } from './job-repos-fixture.ts';
import type { TwoRepo } from './job-repos-fixture.ts';
import { TRUST_ENV, defaults, loadConfig, trustDigest } from '../lib/config.ts';
import { loadStepInput } from '../lib/step.ts';
import { verifiedHead } from '../lib/worktree.ts';
import { token } from './secret-fixtures.ts';
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

/** A job with member `lib` (verify-only when asked) and its worktrees created. */
async function withLib(p: TwoRepo, opts: { verifyOnly?: boolean; create?: boolean } = {}) {
  const j = await p.f('job', 'new', '--title', `lib job ${Math.random().toString(36).slice(2, 8)}`);
  await p.f('job', 'repo', 'add', ...(opts.verifyOnly ? ['--verify-only'] : []), j.id, 'lib');
  const created = opts.create === false ? null : await p.f('worktree', 'create', j.id);
  const libWt = path.join(p.parent, 'lib.worktrees', j.id);
  return { id: j.id as string, created, libWt, rootWt: path.join(p.parent, 'app.worktrees', j.id) };
}

const head = (p: TwoRepo, cwd: string) => p.git(cwd, 'rev-parse', 'HEAD').trim();

describe('job repos: worktrees', { concurrency: 4 }, () => {
  test('worktree create makes one worktree per job repo, idempotently', async () => {
    const p = await project();
    const { id, created, libWt, rootWt } = await withLib(p);
    assert.equal(created.path, rootWt);
    assert.equal(created.ok, true);
    assert.deepEqual(created.repos, [{ repo: 'lib', path: libWt, created: true, ok: true }]);
    assert.equal(p.git(libWt, 'symbolic-ref', '--short', 'HEAD').trim(), `forge/${id}`);
    assert.equal(loadJob(p.root, id).repos[1].worktree, libWt);
    assert.deepEqual(p.events(id).filter((e) => e.type === 'repo-worktree').map((e) => [e.repo, e.path, e.verifyOnly]), [['lib', libWt, false]]);
    assert.equal(loadStepInput(p.root, loadConfig(p.root).config, id).worktreeExists, true);
    const again = await p.f('worktree', 'create', id);
    assert.equal(again.created, false);
    assert.deepEqual(again.repos, [{ repo: 'lib', path: libWt, created: false, ok: true }]);
    // One member worktree deleted by hand: only that one comes back.
    fs.rmSync(libWt, { recursive: true, force: true });
    assert.equal(loadStepInput(p.root, loadConfig(p.root).config, id).worktreeExists, false, 'step sends the job back to I3');
    const third = await p.f('worktree', 'create', id);
    assert.equal(third.created, false, 'the root worktree is kept');
    assert.deepEqual(third.repos, [{ repo: 'lib', path: libWt, created: true, ok: true }]);
    assert.ok(fs.existsSync(path.join(libWt, 'README.md')));

    const v = await withLib(p, { verifyOnly: true });
    assert.deepEqual(v.created.repos, [{ repo: 'lib', path: v.libWt, created: true, ok: true }]);
    assert.throws(() => p.git(v.libWt, 'symbolic-ref', '-q', 'HEAD'), 'a verify-only member is detached');
    assert.equal(head(p, v.libWt), p.git(p.lib, 'rev-parse', 'origin/main').trim());
    assert.equal(p.git(p.lib, 'branch', '--list', `forge/${v.id}`).trim(), '', 'and gets no branch');
    assert.equal(await p.f('worktree', 'path', v.id, '--repo', 'lib'), v.libWt);
  });

  test('a member worktree failure names the repo and keeps the rest', async () => {
    const p = await project();
    const { id, rootWt } = await withLib(p, { create: false });
    fs.renameSync(p.lib, path.join(p.parent, 'lib-moved'));
    const r = await p.raw(['worktree', 'create', id]);
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.path, rootWt);
    assert.ok(fs.existsSync(rootWt), 'the root worktree stays');
    assert.equal(out.repos[0].repo, 'lib');
    assert.equal(out.repos[0].ok, false);
    assert.match(out.repos[0].error, /^repo lib: .*missing clone/);
    fs.renameSync(path.join(p.parent, 'lib-moved'), p.lib);
    const again = await p.f('worktree', 'create', id);
    assert.equal(again.created, false);
    assert.deepEqual(again.repos.map((x: any) => [x.repo, x.created, x.ok]), [['lib', true, true]]);
  });

  test('worktree remove covers every job repo', async () => {
    const p = await project();
    const a = await withLib(p);
    const branch = `forge/${a.id}`;
    const only = await p.f('worktree', 'remove', a.id, '--repo', 'lib');
    assert.deepEqual(only.repos, [{ repo: 'lib', removed: a.libWt }]);
    assert.ok(!fs.existsSync(a.libWt) && fs.existsSync(a.rootWt), '--repo removes only that member');
    assert.equal(loadJob(p.root, a.id).repos[1].worktree, null);
    assert.equal(await p.f('worktree', 'path', a.id, '--repo', 'lib'), '');
    await p.f('worktree', 'create', a.id);
    const all = await p.f('worktree', 'remove', a.id, '--delete-branch');
    assert.equal(all.removed, a.rootWt);
    assert.deepEqual(all.repos, [{ repo: 'lib', removed: a.libWt }]);
    assert.ok(!fs.existsSync(a.libWt) && !fs.existsSync(a.rootWt));
    assert.equal(p.git(p.root, 'branch', '--list', branch).trim(), '');
    assert.equal(p.git(p.lib, 'branch', '--list', branch).trim(), '');
    assert.deepEqual(p.events(a.id).filter((e) => e.type === 'repo-worktree-removed').map((e) => e.repo), ['lib', 'lib']);
  });

  test('job repo remove needs the member worktree gone', async () => {
    const p = await project();
    const { id } = await withLib(p);
    let r = await p.raw(['job', 'repo', 'remove', id, 'lib']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`still has its worktree; run: forge worktree remove ${id} --repo lib`));
    await p.f('worktree', 'remove', id, '--repo', 'lib');
    updateJob(p.root, id, (j) => (j.repos[1].pr = { number: 9, url: 'https://github.com/o/lib/pull/9', state: 'OPEN', isDraft: false, lastSyncedAt: PR.lastSyncedAt }));
    r = await p.raw(['job', 'repo', 'remove', id, 'lib']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has PR #9/);
    updateJob(p.root, id, (j) => (j.repos[1].pr = null));
    const done = await p.f('job', 'repo', 'remove', id, 'lib');
    assert.equal(done.repos.length, 1);
    assert.deepEqual(p.events(id).filter((e) => e.type === 'job-repo-removed').map((e) => e.repo), ['lib']);
    r = await p.raw(['job', 'repo', 'remove', id, 'lib']);
    assert.equal(r.status, 1, 'an unknown name');
  });
});

describe('job repos: run, git and verify', { concurrency: 4 }, () => {
  test('forge git commit --repo commits in the member worktree only', async () => {
    const p = await project();
    const { id, libWt, rootWt } = await withLib(p);
    const rootHead = head(p, rootWt);
    fs.writeFileSync(path.join(libWt, 'lib.txt'), 'lib\n');
    const c = await p.f('git', 'commit', id, '--repo', 'lib', '--message', 'feat: lib');
    assert.equal(c.branch, `forge/${id}`);
    assert.equal(c.sha, head(p, libWt));
    assert.deepEqual(c.files, ['lib.txt']);
    assert.equal(head(p, rootWt), rootHead, 'the root worktree is untouched');
    const fail = async (args: string[], re: RegExp) => {
      const r = await p.raw(args);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}`);
      assert.match(r.stderr, re);
    };
    fs.writeFileSync(path.join(libWt, 'more.txt'), 'x\n');
    await fail(['git', 'commit', id, '--repo', 'lib', '--message', `key ${token.github('commit-msg')}`], /possible secret in the commit message/);
    await fail(['git', 'commit', id, '--repo', 'lib', '--message', 'm', '--', '../outside.txt'], /outside/);
    const v = await withLib(p, { verifyOnly: true });
    fs.writeFileSync(path.join(v.libWt, 'x.txt'), 'x\n');
    await fail(['git', 'commit', v.id, '--repo', 'lib', '--message', 'm'], /repo lib is verify-only/);
    await fail(['git', 'add', v.id, '--repo', 'lib', '--', 'x.txt'], /repo lib is verify-only/);
    updateJob(p.root, id, (j) => (j.repos[1].worktree = p.lib));
    await fail(['git', 'commit', id, '--repo', 'lib', '--message', 'm'], /is not this job's worktree/);
    assert.equal(p.git(p.lib, 'log', '--oneline').trim().split('\n').length, 1, 'nothing was committed in the clone');
  });

  test('forge run --repo runs the member component\'s command', async () => {
    const p = await project();
    const { id, libWt } = await withLib(p);
    const r = await p.f('run', id, 'where', '--repo', 'lib');
    assert.equal(r.ok, true);
    assert.match(r.tail, new RegExp(`WT=${libWt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} BR=forge/${id} BASE=main`));
    assert.match(r.log, /^logs\/lib-where-/);
    const fail = async (args: string[], re: RegExp) => {
      const x = await p.raw(args);
      assert.equal(x.status, 1, x.stdout);
      assert.match(x.stderr, re);
    };
    await fail(['run', id, 'build', '--repo', 'lib'], /no component of repo lib defines a "build" command/);
    await fail(['run', id, 'where', '--repo', 'lib', '--background'], /--repo takes no --background/);
    p.config((c) => c.components.push({ name: 'lib2', repo: 'lib', path: '.', kind: 'library', commands: { where: 'true' } }));
    await fail(['run', id, 'where', '--repo', 'lib'], /several components of repo lib define "where" \(lib, lib2\)/);
    const v = await withLib(p, { verifyOnly: true });
    p.config((c) => c.components.pop());
    assert.match((await p.f('run', v.id, 'where', '--repo', 'lib')).tail, /BR= BASE=main/, 'a verify-only member has no branch');
  });

  test('verify records evidence for every repo HEAD', async () => {
    const p = await project();
    const { id, libWt, rootWt } = await withLib(p);
    const libSha = p.commit(libWt, { 'src/lib.ts': 'export const x = 1;\n' }, 'feat: lib');
    await p.f('job', 'round', id);
    const pass = await p.f('verify', id);
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.repos, [{ repo: 'lib', sha: libSha, ok: true, failure: null }]);
    let run = loadJob(p.root, id).verifyRuns.at(-1)!;
    assert.equal(run.sha, head(p, rootWt));
    assert.deepEqual(run.repos, [{ repo: 'lib', sha: libSha, ok: true, failure: null }]);
    let report = fs.readFileSync(path.join(p.root, pass.file), 'utf8');
    assert.match(report, /^VERIFY: PASS/);
    assert.ok(report.includes(`# Repo lib · ${libSha.slice(0, 12)}`), report);
    assert.match(report.slice(report.indexOf('# Repo lib')), /## test: ok/);
    assert.equal(verifiedHead(p.root, id).verified, true);

    const failSha = p.commit(libWt, { FAIL: '1\n' }, 'break lib');
    let r = await p.raw(['verify', id]);
    assert.equal(r.status, 1);
    run = loadJob(p.root, id).verifyRuns.at(-1)!;
    assert.deepEqual([run.ok, run.failure, run.repos], [false, 'test', [{ repo: 'lib', sha: failSha, ok: false, failure: 'test' }]]);
    report = fs.readFileSync(path.join(p.root, JSON.parse(r.stdout).file), 'utf8');
    assert.match(report, /^VERIFY: FAIL/);
    assert.match(report, /## test: FAILED/);

    p.git(libWt, 'rm', '-q', 'FAIL');
    p.git(libWt, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'fix lib');
    fs.writeFileSync(path.join(libWt, 'stray.txt'), 'x\n');
    r = await p.raw(['verify', id]);
    assert.equal(r.status, 1);
    assert.equal(loadJob(p.root, id).verifyRuns.at(-1)!.failure, 'worktree-clean');
    fs.rmSync(path.join(libWt, 'stray.txt'));

    p.commit(libWt, { 'src/key.ts': `export const k = '${token.anthropic('member-verify')}';\n` }, 'add key');
    r = await p.raw(['verify', id]);
    assert.equal(r.status, 1);
    assert.equal(loadJob(p.root, id).verifyRuns.at(-1)!.failure, 'secrets');
  });

  test('a member commit after verify unverifies the job', async () => {
    const p = await project();
    const { id, libWt } = await withLib(p);
    p.commit(libWt, { 'a.txt': 'a\n' });
    await p.f('job', 'round', id);
    await p.f('verify', id);
    assert.equal(verifiedHead(p.root, id).verified, true);
    p.commit(libWt, { 'b.txt': 'b\n' });
    assert.equal(verifiedHead(p.root, id).verified, false, 'a new member commit');
    await p.f('verify', id);
    assert.equal(verifiedHead(p.root, id).verified, true);
    const bin = path.join(p.parent, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await p.f('worktree', 'remove', id, '--repo', 'lib');
    assert.equal(verifiedHead(p.root, id).verified, false, 'a missing member worktree');
    const r = await p.raw(['pr', 'open', id], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /not verified/);
  });

  test('a single-repo job keeps its worktree result and verify records', async () => {
    const p = await project();
    const j = await p.f('job', 'new', '--title', 'single');
    const created = await p.f('worktree', 'create', j.id);
    assert.deepEqual(Object.keys(created).sort(), ['created', 'ok', 'path', 'port', 'setup']);
    assert.deepEqual(Object.keys(await p.f('worktree', 'create', j.id)).sort(), ['created', 'path']);
    p.commit(created.path, { 'a.txt': 'a\n' });
    await p.f('job', 'round', j.id);
    const v = await p.f('verify', j.id);
    assert.deepEqual(Object.keys(v).sort(), ['attempt', 'failure', 'file', 'integrity', 'ok', 'protected', 'round', 'secrets', 'sha', 'steps'].filter((k) => k !== 'failure' || 'failure' in v).sort());
    assert.deepEqual(Object.keys(loadJob(p.root, j.id).verifyRuns.at(-1)!).sort(), ['at', 'attempt', 'failure', 'file', 'ok', 'round', 'sha']);
    assert.doesNotMatch(fs.readFileSync(path.join(p.root, v.file), 'utf8'), /# Repo /);
    assert.deepEqual(Object.keys(verifiedHead(p.root, j.id)).sort(), ['head', 'last', 'verified']);
    const removed = await p.f('worktree', 'remove', j.id);
    assert.deepEqual(Object.keys(removed), ['removed']);
  });
});
