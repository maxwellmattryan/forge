// The release bump: once a dependency's release is recorded, verify rewrites the consumer's
// manifests to the released version, refreshes a tracked lockfile with a fixed argv, commits, and
// logs `interim-bumped`. Scratch repos from job-repos-fixture.ts; cargo and npm are sh stubs in a
// temp bin/ that record their argv, and the fake gh never reaches GitHub.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BLOCK_BEGIN, lockfileArgv } from '../lib/interim.ts';
import { findOnPath } from '../lib/util.ts';
import { prProject, ready, twoRepo } from './job-repos-fixture.ts';
import type { PrProject } from './job-repos-fixture.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const STUBS = process.platform === 'win32' ? 'stub lockfile tools are POSIX shell scripts' : false;
const GH = process.platform === 'win32' ? 'spawns a fake gh, a sh script' : false;
const LINKS = process.platform === 'win32' ? 'symlinks need privileges on native Windows' : false;

// Each records `<cwd> <argv>`, fails with <tool>-fail, writes a stray file with <tool>-touch, and
// otherwise rewrites its lockfile in the cwd deterministically.
const stub = (tool: string, lock: string) => `#!/bin/sh
echo "$PWD $*" >> "$STUB_DIR/${tool}.log"
if [ -f "$STUB_DIR/${tool}-fail" ]; then echo "${tool}: resolution failed" >&2; exit 1; fi
if [ -f "$STUB_DIR/${tool}-touch" ]; then echo x > stray.txt; fi
printf 'refreshed by stub ${tool}: %s\\n' "$*" > ${lock}
`;

type Link = Record<string, unknown>;

/** The two-repo project, root `app` consuming member `lib` through `links`, lib on `strategy`, and stub cargo/npm. */
async function project(links: Link[], strategy: string, opts: { gh?: boolean } = {}) {
  let p: PrProject;
  if (opts.gh) p = await prProject(cleanups);
  else {
    const t = await twoRepo();
    cleanups.push(t.cleanup);
    p = { ...t, env: {}, gh: '', calls: () => [], pr: async () => ({ status: 1, stdout: '', stderr: '' }), heads: () => '', fake: () => {}, body: () => '' } as PrProject;
  }
  p.config((c) => {
    c.components = [
      { name: 'app', path: '.', kind: 'app', dependsOn: links.map((link) => ({ component: 'lib', type: 'build', link })) },
      { name: 'lib', repo: 'lib', path: '.', kind: 'library' },
    ];
    c.repos[0].release = { interim: strategy };
  });
  const stubs = path.join(p.parent, 'stubs');
  fs.mkdirSync(path.join(stubs, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stubs, 'bin', 'cargo'), stub('cargo', 'Cargo.lock'), { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'bin', 'npm'), stub('npm', 'package-lock.json'), { mode: 0o755 });
  const env = { ...p.env, PATH: `${path.join(stubs, 'bin')}${path.delimiter}${p.env.PATH ?? process.env.PATH}`, STUB_DIR: stubs };
  const log = (tool: string) => {
    try {
      return fs.readFileSync(path.join(stubs, `${tool}.log`), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const flag = (name: string, on: boolean) => (on ? fs.writeFileSync(path.join(stubs, name), '') : fs.rmSync(path.join(stubs, name), { force: true }));
  const verify = async (id: string, extra: NodeJS.ProcessEnv = env) => {
    const r = await p.raw(['verify', id], extra);
    const out = JSON.parse(r.stdout);
    return { status: r.status, out, report: fs.readFileSync(path.join(p.root, out.file), 'utf8') };
  };
  const jobFile = (id: string) => path.join(p.root, '.forge', 'jobs', id, 'job.json');
  /** Writes a PR record straight into job.json (null: the root's), as pr open and pr sync would. */
  const recordPr = (id: string, repo: string | null, state: string, extra: Record<string, unknown> = {}) => {
    const job = JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
    const pr = { number: repo === null ? 11 : 7, url: null, state, isDraft: false, ...extra };
    if (repo === null) job.pr = pr;
    else job.repos.find((r: any) => r.repo === repo).pr = pr;
    fs.writeFileSync(jobFile(id), JSON.stringify(job, null, 2));
  };
  const appendEvent = (id: string, e: Record<string, unknown>) =>
    fs.appendFileSync(path.join(p.root, '.forge', 'jobs', id, 'events.jsonl'), JSON.stringify({ v: 2, ts: new Date().toISOString(), ...e }) + '\n');
  const release = (id: string, version: string) => p.f('job', 'interim', 'release', id, 'lib', version);
  const head = (cwd: string) => p.git(cwd, 'rev-parse', 'HEAD').trim();
  const show = (cwd: string, file: string) => p.git(cwd, 'show', `HEAD:${file}`);
  const bumped = (id: string) => p.events(id).filter((e) => e.type === 'interim-bumped');
  return { p, env, stubs, log, flag, verify, recordPr, appendEvent, release, head, show, bumped };
}

const CARGO = '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nengine-core = "1.0.0"\n';
const CMAKE = 'cmake_minimum_required(VERSION 3.24)\ninclude(FetchContent)\nFetchContent_Declare(\n  engine\n  GIT_REPOSITORY https://example.com/engine.git\n  GIT_TAG v1.0.0\n)\n';
const PKG = '{\n  "name": "app",\n  "dependencies": {\n    "engine": "^1.0.0"\n  }\n}\n';
const LOCK = '{\n  "lockfileVersion": 3\n}\n';
const interimStep = (out: any) => out.steps.find((s: any) => s.name === 'interim');

describe('interim release bump', { concurrency: 4 }, () => {
  test('bumps canary, cmake and local consumers', async () => {
    // cmake on git-ref: the GIT_TAG becomes the recorded version text, once the tag exists in lib.
    const c = await project([{ ecosystem: 'cmake', name: 'engine' }], 'git-ref');
    const j = await ready(c.p);
    c.p.commit(j.rootWt, { 'CMakeLists.txt': CMAKE });
    assert.equal((await c.verify(j.id)).status, 0);
    assert.ok(c.show(j.rootWt, 'CMakeLists.txt').includes(c.head(j.libWt)), 'pinned first');
    c.recordPr(j.id, 'lib', 'MERGED');
    await c.release(j.id, 'v1.3.0');
    const noTag = await c.verify(j.id);
    assert.equal(noTag.out.failure.name, 'interim');
    assert.match(noTag.report, /the root repo on repo lib \(release v1\.3\.0\): tag v1\.3\.0 is not in repo lib; fetch its tags, or record the version as the tag names it/);
    c.p.git(j.libWt, 'tag', 'v1.2.0');
    await c.release(j.id, 'v1.2.0');
    const r = await c.verify(j.id);
    assert.equal(r.status, 0, r.report);
    assert.equal(c.show(j.rootWt, 'CMakeLists.txt'), CMAKE.replace('v1.0.0', 'v1.2.0'));
    assert.equal(c.p.git(j.rootWt, 'log', '-1', '--format=%B').trim(), `forge: release bump for job ${j.id}\n\nlib: release v1.2.0`);
    assert.deepEqual(interimStep(r.out), { name: 'interim', ok: true, exit: null, reason: `release bump committed in the root repo (${c.head(j.rootWt).slice(0, 12)})` });
    assert.deepEqual(c.bumped(j.id).map((e) => [e.repo, e.dependency, e.version, e.sha]), [[null, 'lib', 'v1.2.0', c.head(j.rootWt)]]);
    const st = await c.p.f('job', 'interim', j.id);
    assert.deepEqual([st.edges[0].state, st.gates[0].gate], ['released', 'released']);
    assert.equal(st.edges[0].release, 'v1.2.0');
    // Nothing left to write: no commit, and no second bumped event.
    const again = await c.verify(j.id);
    assert.equal(again.status, 0);
    assert.equal(interimStep(again.out).reason, undefined);
    assert.equal(c.bumped(j.id).length, 1);

    // local with an npm link: the spec moves to the release, the gate opens once verify bumped it.
    const l = await project([{ ecosystem: 'npm', name: 'engine' }], 'local');
    const lj = await ready(l.p);
    l.p.commit(lj.rootWt, { 'package.json': PKG });
    const plain = await l.verify(lj.id);
    assert.equal(interimStep(plain.out), undefined, 'no interim step before a release');
    l.recordPr(lj.id, 'lib', 'MERGED');
    assert.deepEqual((await l.release(lj.id, '1.2.0')).bump, [null]);
    assert.equal((await l.p.f('job', 'interim', lj.id)).gates[0].gate, 'bump-due');
    const lr = await l.verify(lj.id);
    assert.equal(lr.status, 0, lr.report);
    assert.equal(l.show(lj.rootWt, 'package.json'), PKG.replace('^1.0.0', '^1.2.0'));
    assert.equal((await l.p.f('job', 'interim', lj.id)).gates[0].gate, 'released');

    // canary: the canary pin becomes ^<release>; with a tracked package-lock.json, npm refreshes it.
    const k = await project([{ ecosystem: 'npm', name: 'engine' }], 'canary');
    const kj = await ready(k.p, { libFiles: { 'package.json': '{\n  "name": "engine",\n  "version": "1.0.0"\n}\n' } });
    const lockfile = process.platform !== 'win32';
    k.p.commit(kj.rootWt, { 'package.json': PKG, ...(lockfile ? { 'package-lock.json': LOCK } : {}) });
    assert.equal((await k.verify(kj.id)).status, 0);
    assert.match(k.show(kj.rootWt, 'package.json'), /"engine": "1\.0\.0-canary\.[0-9a-g]{12,13}"/);
    k.recordPr(kj.id, 'lib', 'MERGED');
    await k.release(kj.id, '1.2.0');
    const kr = await k.verify(kj.id);
    assert.equal(kr.status, 0, kr.report);
    assert.equal(k.show(kj.rootWt, 'package.json'), PKG.replace('^1.0.0', '^1.2.0'));
    // The npm lockfile refresh runs the stub, a sh script: POSIX only.
    if (lockfile) {
      assert.deepEqual(k.log('npm'), [`${fs.realpathSync(kj.rootWt)} install --package-lock-only --ignore-scripts --no-audit --no-fund`]);
      assert.equal(k.show(kj.rootWt, 'package-lock.json'), 'refreshed by stub npm: install --package-lock-only --ignore-scripts --no-audit --no-fund\n');
      assert.deepEqual(k.p.git(kj.rootWt, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['package-lock.json', 'package.json'], 'one commit holds both');
    }
    assert.equal(k.p.git(kj.rootWt, 'status', '--porcelain'), '');
  });

  test('a failing lockfile refresh is a clean verify failure', { skip: STUBS }, async () => {
    const c = await project([{ ecosystem: 'cargo', name: 'engine-core' }], 'git-ref');
    const j = await ready(c.p);
    c.p.commit(j.rootWt, { 'Cargo.toml': CARGO, 'Cargo.lock': '# lock v1\n' });
    assert.equal((await c.verify(j.id)).status, 0);
    assert.deepEqual(c.log('cargo'), [], 'a pin refreshes no lockfile');
    c.recordPr(j.id, 'lib', 'MERGED');
    await c.release(j.id, '1.2.0');
    const pinned = c.head(j.rootWt);
    const clean = (what: string) => {
      assert.equal(c.head(j.rootWt), pinned, `${what}: nothing committed`);
      assert.equal(c.p.git(j.rootWt, 'status', '--porcelain', '--', 'Cargo.toml', 'Cargo.lock'), '', `${what}: the manifests are back at HEAD`);
      assert.deepEqual(c.bumped(j.id), [], `${what}: no interim-bumped`);
    };
    c.flag('cargo-fail', true);
    let r = await c.verify(j.id);
    assert.equal(r.status, 1);
    assert.equal(r.out.failure.name, 'interim');
    assert.match(r.report, /the root repo on repo lib \(release 1\.2\.0\): cargo exited 1: cargo: resolution failed/);
    clean('exit 1');
    c.flag('cargo-fail', false);
    // A tool that changes another path.
    c.flag('cargo-touch', true);
    r = await c.verify(j.id);
    assert.equal(interimStep(r.out).ok, false, 'the stray file also leaves the worktree dirty, which verify reports first');
    assert.match(r.report, /cargo changed "stray\.txt", which is neither a written manifest nor its lockfile/);
    fs.rmSync(path.join(j.rootWt, 'stray.txt'));
    clean('stray path');
    c.flag('cargo-touch', false);
    // No cargo on PATH at all: git, sh and node only.
    const bare = [...new Set([path.dirname(findOnPath('git')!), '/bin', '/usr/bin', path.dirname(process.execPath)])].join(path.delimiter);
    if (findOnPath('cargo', { PATH: bare }) === null) {
      r = await c.verify(j.id, { ...c.env, PATH: bare });
      assert.equal(r.out.failure.name, 'interim');
      assert.match(r.report, /the root repo on repo lib \(release 1\.2\.0\): cargo not found on PATH; it refreshes Cargo\.lock/);
      clean('missing tool');
    }
    const argv = `${fs.realpathSync(j.rootWt)} update -p engine-core --precise 1.2.0`;
    assert.ok(c.log('cargo').every((l) => l === argv), c.log('cargo').join('\n'));
    // Then it goes through: Cargo.toml without the Forge block, and the refreshed lock, in one commit.
    r = await c.verify(j.id);
    assert.equal(r.status, 0, r.report);
    assert.equal(c.show(j.rootWt, 'Cargo.toml'), CARGO.replace('"1.0.0"', '"1.2.0"'));
    assert.equal(c.show(j.rootWt, 'Cargo.lock'), 'refreshed by stub cargo: update -p engine-core --precise 1.2.0\n');
    assert.equal(c.bumped(j.id).length, 1);
  });

  test('forged release records are refused', async () => {
    const c = await project([{ ecosystem: 'cargo', name: 'engine-core' }], 'git-ref');
    const j = await ready(c.p);
    c.p.commit(j.rootWt, { 'Cargo.toml': CARGO, 'Cargo.lock': '# lock v1\n' });
    assert.equal((await c.verify(j.id)).status, 0);
    c.recordPr(j.id, 'lib', 'MERGED');
    const pinned = c.show(j.rootWt, 'Cargo.toml');
    for (const version of ['-Zunstable', '1.2.0 && x', '1.2.0-canary.abc', `1.2.0-${'a'.repeat(115)}`]) c.appendEvent(j.id, { type: 'interim-released', repo: 'lib', version });
    const r = await c.verify(j.id);
    assert.equal(r.status, 0, r.report);
    assert.equal(c.show(j.rootWt, 'Cargo.toml'), pinned, 'still the pin: no bump');
    assert.ok(pinned.includes(BLOCK_BEGIN));
    assert.deepEqual(c.log('cargo'), [], 'no argv carries a forged version');
    assert.equal((await c.p.f('job', 'interim', j.id)).gates[0].gate, 'ci');
    // A well-formed record for a dependency whose recorded PR is not merged writes nothing.
    c.recordPr(j.id, 'lib', 'OPEN');
    c.appendEvent(j.id, { type: 'interim-released', repo: 'lib', version: '1.2.0' });
    const before = c.head(j.rootWt);
    const forged = await c.verify(j.id);
    assert.equal(forged.status, 1);
    assert.equal(forged.out.failure.name, 'interim');
    assert.match(forged.report, /repo lib's PR is not merged, yet a release 1\.2\.0 is recorded/);
    assert.equal(c.head(j.rootWt), before);
    assert.equal(c.p.git(j.rootWt, 'status', '--porcelain'), '');
    assert.deepEqual(c.log('cargo'), []);
    const st = await c.p.f('job', 'interim', j.id);
    assert.deepEqual([st.edges[0].state, st.edges[0].detail], ['blocked', "repo lib's PR is not merged, yet a release 1.2.0 is recorded"]);
    // An option-shaped link name or version never reaches the lockfile argv.
    for (const [name, version] of [['-Zx', '1.2.0'], ['engine-core', '-Zx'], ['--offline', '1.2.0']]) assert.ok('error' in lockfileArgv('cargo', name, version), `${name} ${version}`);
  });

  test("a forged bumped event can't push or ready an unbumped consumer", { skip: GH }, async () => {
    const c = await project([{ ecosystem: 'cargo', name: 'engine-core' }], 'git-ref', { gh: true });
    const j = await ready(c.p);
    c.p.commit(j.rootWt, { 'Cargo.toml': CARGO });
    assert.equal((await c.verify(j.id)).status, 0);
    c.recordPr(j.id, 'lib', 'MERGED');
    c.recordPr(j.id, null, 'OPEN', { isDraft: true });
    await c.release(j.id, '1.2.0');
    c.appendEvent(j.id, { type: 'interim-bumped', repo: null, dependency: 'lib', version: '1.2.0', sha: c.head(j.rootWt) });
    const st = await c.p.f('job', 'interim', j.id);
    assert.equal(st.gates[0].gate, 'released', 'the forged event opens the pure gate');
    assert.equal(st.edges[0].state, 'stale', 'but git says otherwise');
    assert.match(st.edges[0].detail, /^Cargo\.toml in the root repo does not name the released version 1\.2\.0 of repo lib; run: forge verify /);
    const open = await c.p.raw(['pr', 'open', j.id, '--json'], c.env);
    assert.equal(open.status, 1, open.stdout);
    const err = JSON.parse(open.stdout).error;
    assert.equal(err.code, 'interim_stale');
    assert.match(err.message, /does not name the released version 1\.2\.0 of repo lib; the checked commits don't name the released version/);
    assert.equal(c.p.heads(c.p.rootBare), 'main', 'nothing pushed');
    const readyR = await c.p.raw(['pr', 'ready', j.id, '--root', '--json'], c.env);
    assert.equal(readyR.status, 1, readyR.stdout);
    const rerr = JSON.parse(readyR.stdout).error;
    assert.equal(rerr.code, 'release_gate');
    assert.equal(rerr.message, `the root repo's manifests don't name repo lib's released version 1.2.0 yet; run: forge verify ${j.id}, then forge pr open ${j.id}`);
    assert.deepEqual(c.p.calls().filter((l) => l.startsWith('pr ready') || l.startsWith('pr create')), []);
  });

  test('symlinked manifest or lockfile is refused', { skip: LINKS || STUBS }, async () => {
    // A symlinked Cargo.toml: neither the pin nor the bump writes through it.
    const s = await project([{ ecosystem: 'cargo', name: 'engine-core' }], 'git-ref');
    const sj = await ready(s.p);
    s.p.commit(sj.rootWt, { 'real/Cargo.toml': CARGO });
    fs.symlinkSync(path.join('real', 'Cargo.toml'), path.join(sj.rootWt, 'Cargo.toml'));
    s.p.git(sj.rootWt, 'add', 'Cargo.toml');
    s.p.git(sj.rootWt, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'link');
    const sr = await s.verify(sj.id);
    assert.equal(sr.out.failure.name, 'interim');
    assert.ok(fs.lstatSync(path.join(sj.rootWt, 'Cargo.toml')).isSymbolicLink(), 'still a link');
    assert.equal(fs.readFileSync(path.join(sj.rootWt, 'real', 'Cargo.toml'), 'utf8'), CARGO, 'its target untouched');

    // A symlinked Cargo.lock: the bump stops before cargo runs, and the manifest goes back.
    const c = await project([{ ecosystem: 'cargo', name: 'engine-core' }], 'git-ref');
    const j = await ready(c.p);
    c.p.config((cfg) => (cfg.aiAttribution = 'forbid'));
    c.p.commit(j.rootWt, { 'Cargo.toml': CARGO, 'locks/real.lock': '# lock v1\n' });
    fs.symlinkSync(path.join('locks', 'real.lock'), path.join(j.rootWt, 'Cargo.lock'));
    c.p.git(j.rootWt, 'add', 'Cargo.lock');
    c.p.git(j.rootWt, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'lock link');
    assert.equal((await c.verify(j.id)).status, 0);
    c.recordPr(j.id, 'lib', 'MERGED');
    await c.release(j.id, '1.2.0');
    const before = c.head(j.rootWt);
    const r = await c.verify(j.id);
    assert.equal(r.out.failure.name, 'interim');
    assert.match(r.report, /the root repo on repo lib \(release 1\.2\.0\): Cargo\.lock is not a regular file; Forge won't refresh it/);
    assert.equal(c.head(j.rootWt), before);
    assert.equal(c.p.git(j.rootWt, 'status', '--porcelain'), '', 'Cargo.toml restored');
    assert.equal(fs.readFileSync(path.join(j.rootWt, 'locks', 'real.lock'), 'utf8'), '# lock v1\n');
    assert.deepEqual(c.log('cargo'), []);

    // A regular lockfile, and a builder-set commit template carrying a trailer: the bump commit has neither.
    fs.rmSync(path.join(j.rootWt, 'Cargo.lock'));
    c.p.commit(j.rootWt, { 'Cargo.lock': '# lock v1\n' }, 'regular lock');
    const template = path.join(c.p.parent, 'template.txt');
    fs.writeFileSync(template, `\n\n${['Co', 'Authored', 'By'].join('-')}: Claude <noreply@anthropic.com>\n`);
    execFileSync('git', ['config', 'commit.template', template], { cwd: j.rootWt });
    const ok = await c.verify(j.id);
    assert.equal(ok.status, 0, ok.report);
    assert.equal(c.p.git(j.rootWt, 'log', '-1', '--format=%B').trim(), `forge: release bump for job ${j.id}\n\nlib: release 1.2.0`);
  });
});
