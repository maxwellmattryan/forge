// The git-ref interim strategy: verify pins the consumer's manifest (Cargo.toml, a CMake
// FetchContent GIT_TAG, package.json) at the dependency's HEAD and commits it, `pr open` refuses a
// stale pin and pushes the dependency first. Scratch repos with bare remotes and the fake `gh`.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LIB_COMMANDS, prProject, ready } from './job-repos-fixture.ts';
import type { PrProject } from './job-repos-fixture.ts';
import { BLOCK_BEGIN, BLOCK_END } from '../lib/interim.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

type Link = Record<string, unknown>;

/** The two-repo project with the root's `app` depending on `lib` through `links`, or the reverse, and git-ref for the dependency. */
async function project(links: Link[], opts: { reverse?: boolean } = {}): Promise<PrProject> {
  const p = await prProject(cleanups);
  p.config((c) => {
    const edges = links.map((link) => ({ component: opts.reverse ? 'app' : 'lib', type: 'build', link }));
    c.components = [
      { name: 'app', path: '.', kind: 'app', dependsOn: opts.reverse ? [] : edges },
      { name: 'lib', repo: 'lib', path: '.', kind: 'library', commands: { ...LIB_COMMANDS }, dependsOn: opts.reverse ? edges : [] },
    ];
    if (opts.reverse) c.release = { interim: 'git-ref' };
    else c.repos[0].release = { interim: 'git-ref' };
  });
  return p;
}

const CARGO = '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nengine-core = "1"\n';
const CMAKE = 'cmake_minimum_required(VERSION 3.24)\ninclude(FetchContent)\nFetchContent_Declare(\n  engine\n  GIT_REPOSITORY https://example.com/engine.git\n  GIT_TAG v1.0.0\n)\n';
const PKG = '{\n  "name": "app",\n  "dependencies": {\n    "engine": "^1.0.0"\n  }\n}\n';

const head = (p: PrProject, cwd: string) => p.git(cwd, 'rev-parse', 'HEAD').trim();
const show = (p: PrProject, cwd: string, file: string) => p.git(cwd, 'show', `HEAD:${file}`);
const count = (p: PrProject, cwd: string) => Number(p.git(cwd, 'rev-list', '--count', 'HEAD').trim());
async function verify(p: PrProject, id: string) {
  const r = await p.raw(['verify', id]);
  return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}

describe('interim strategies: git-ref', { concurrency: 4 }, () => {
  test('git-ref pins a cargo dependency and refreshes when it moves', async () => {
    const p = await project([{ ecosystem: 'cargo', name: 'engine-core' }]);
    const j = await ready(p);
    p.commit(j.rootWt, { 'Cargo.toml': CARGO }, 'feat: depend on engine-core');
    const before = count(p, j.rootWt);
    const first = await verify(p, j.id);
    assert.equal(first.status, 0, JSON.stringify(first.out.failure));
    const lib1 = head(p, j.libWt);
    const pinned = `${CARGO}\n${BLOCK_BEGIN}\n[patch."crates-io"]\n"engine-core" = { git = ${JSON.stringify(`file://${p.libBare}`)}, rev = "${lib1}" }\n${BLOCK_END}\n`;
    assert.equal(show(p, j.rootWt, 'Cargo.toml'), pinned);
    assert.equal(count(p, j.rootWt), before + 1, 'one pin commit');
    const msg = p.git(j.rootWt, 'log', '-1', '--format=%B').trim();
    assert.equal(msg, `forge: interim pins for job ${j.id}\n\nlib: git-ref ${lib1.slice(0, 12)}`);
    assert.doesNotMatch(msg, /Co-Authored|Generated with/i);
    assert.equal(first.out.sha, head(p, j.rootWt), 'the run records the post-pin HEAD');
    assert.deepEqual(first.out.steps.find((s: any) => s.name === 'interim'), { name: 'interim', ok: true, exit: null, reason: `pins committed in the root repo (${first.out.sha.slice(0, 12)})` });
    assert.equal(p.git(j.rootWt, 'status', '--porcelain'), '');

    p.commit(j.libWt, { 'more.txt': 'more\n' }, 'feat: lib moves');
    const second = await verify(p, j.id);
    assert.equal(second.status, 0);
    const lib2 = head(p, j.libWt);
    assert.equal(show(p, j.rootWt, 'Cargo.toml'), pinned.replace(lib1, lib2), 'the rev follows lib');
    assert.equal(count(p, j.rootWt), before + 2, 'a second pin commit');
    const third = await verify(p, j.id);
    assert.equal(third.status, 0);
    assert.equal(count(p, j.rootWt), before + 2, 'nothing changed, nothing committed');
    assert.equal(third.out.steps.find((s: any) => s.name === 'interim').reason, undefined);
    const st = await p.f('job', 'interim', j.id);
    assert.deepEqual(st.edges.map((e: any) => [e.strategy, e.state, e.detail]), [['git-ref', 'ready', `pins repo lib at ${lib2.slice(0, 12)}`]]);
  });

  test('git-ref refuses a foreign patch table', async () => {
    const p = await project([{ ecosystem: 'cargo', name: 'engine-core' }]);
    const j = await ready(p);
    p.commit(j.rootWt, { 'Cargo.toml': `${CARGO}\n[patch.crates-io]\nengine-core = { path = "../engine" }\n` });
    const before = head(p, j.rootWt);
    const r = await verify(p, j.id);
    assert.equal(r.status, 1);
    assert.equal(r.out.failure.name, 'interim');
    assert.deepEqual(r.out.steps.map((s: any) => s.name), ['secrets', 'protected', 'interim'], 'no configured step ran');
    assert.deepEqual(r.out.repos.map((m: any) => [m.repo, m.ok]), [['lib', true]]);
    assert.equal(head(p, j.rootWt), before, 'nothing committed');
    const report = fs.readFileSync(path.join(p.root, r.out.file), 'utf8');
    assert.match(report, /## interim: FAILED/);
    assert.match(report, /Cargo.toml has \[patch\."crates-io"\] outside the Forge block/);
    assert.doesNotMatch(report, /verify-lib-test|## test:/, "lib's configured steps did not run either");
  });

  test('git-ref pins a cmake FetchContent GIT_TAG', async () => {
    const p = await project([{ ecosystem: 'cmake', name: 'Engine' }]);
    const j = await ready(p);
    p.commit(j.rootWt, { 'CMakeLists.txt': CMAKE });
    const r = await verify(p, j.id);
    assert.equal(r.status, 0, JSON.stringify(r.out.failure));
    assert.equal(show(p, j.rootWt, 'CMakeLists.txt'), CMAKE.replace('v1.0.0', head(p, j.libWt)));
  });

  test('git-ref refuses an ambiguous FetchContent_Declare', async () => {
    const p = await project([{ ecosystem: 'cmake', name: 'engine' }]);
    const j = await ready(p);
    p.commit(j.rootWt, { 'CMakeLists.txt': CMAKE + CMAKE.slice(CMAKE.indexOf('FetchContent_Declare')) });
    let r = await verify(p, j.id);
    assert.equal(r.out.failure.name, 'interim');
    assert.match(fs.readFileSync(path.join(p.root, r.out.file), 'utf8'), /has 2 FetchContent_Declare\(engine …\) calls/);
    p.commit(j.rootWt, { 'CMakeLists.txt': CMAKE.replace('  GIT_TAG v1.0.0\n', '') });
    r = await verify(p, j.id);
    assert.equal(r.out.failure.name, 'interim');
    assert.match(fs.readFileSync(path.join(p.root, r.out.file), 'utf8'), /has 0 GIT_TAG arguments/);
  });

  test('git-ref pins an npm dependency at the repo root', async () => {
    const p = await project([{ ecosystem: 'npm', name: 'engine' }]);
    const j = await ready(p);
    p.commit(j.rootWt, { 'package.json': PKG });
    const r = await verify(p, j.id);
    assert.equal(r.status, 0, JSON.stringify(r.out.failure));
    assert.equal(show(p, j.rootWt, 'package.json'), PKG.replace('^1.0.0', `git+file://${p.libBare}#${head(p, j.libWt)}`));
    // A package below lib's root can't be a git dependency: the edge is blocked.
    p.config((c) => (c.components[0].dependsOn[0].link.path = 'pkg'));
    const st = await p.f('job', 'interim', j.id);
    assert.deepEqual(st.edges.map((e: any) => e.state), ['blocked']);
    assert.match(st.edges[0].detail, /npm installs a git dependency only from its repo's root, and engine is at pkg/);
    const blocked = await verify(p, j.id);
    assert.equal(blocked.out.failure.name, 'interim');
  });

  test('git-ref never pins a remote in the home directory', async () => {
    const p = await project([{ ecosystem: 'npm', name: 'engine' }]);
    const j = await ready(p);
    p.commit(j.rootWt, { 'package.json': PKG });
    // lib's bare remote sits under p.parent: as HOME, that is a local home path.
    const r = await p.raw(['job', 'interim', j.id], { HOME: p.parent });
    assert.equal(r.status, 0, r.stderr);
    const st = JSON.parse(r.stdout);
    assert.deepEqual(st.edges.map((e: any) => e.state), ['blocked']);
    assert.match(st.edges[0].detail, /remote is a path in your home directory, which a pushed manifest must not name/);
  });

  test('integrity accepts pins and still flags local overrides', async () => {
    const p = await project([
      { ecosystem: 'cargo', name: 'engine-core' },
      { ecosystem: 'cmake', name: 'engine' },
      { ecosystem: 'npm', name: 'engine' },
    ]);
    const j = await ready(p);
    p.commit(j.rootWt, { 'Cargo.toml': CARGO, 'CMakeLists.txt': CMAKE, 'package.json': PKG });
    const r = await verify(p, j.id);
    assert.equal(r.status, 0, JSON.stringify(r.out.failure));
    assert.ok(show(p, j.rootWt, 'Cargo.toml').includes(BLOCK_BEGIN) && show(p, j.rootWt, 'package.json').includes('git+file://'));
    assert.deepEqual(r.out.integrity.linkOverrides, [], 'a pin is no link override');
    p.commit(j.rootWt, { 'deps.cmake': `set(FETCHCONTENT_SOURCE_DIR_ENGINE ${j.libWt})\n` });
    const flagged = await verify(p, j.id);
    assert.ok(flagged.out.integrity.linkOverrides.some((o: string) => o.startsWith('deps.cmake:1 (R')), JSON.stringify(flagged.out.integrity.linkOverrides));
    assert.ok(flagged.out.integrity.linkOverrides.every((o: string) => o.startsWith('deps.cmake')), 'the pins still are not');
  });

  test('pr open refuses a stale pin', async () => {
    const p = await project([{ ecosystem: 'cargo', name: 'engine-core' }]);
    const j = await ready(p);
    p.commit(j.rootWt, { 'Cargo.toml': CARGO });
    assert.equal((await verify(p, j.id)).status, 0);
    // lib moves without a verify; --force skips the verified-HEAD check, never the pin check.
    p.commit(j.libWt, { 'later.txt': 'x\n' });
    let r = await p.raw(['pr', 'open', j.id, '--force', '--json'], p.env);
    assert.equal(r.status, 1, r.stdout);
    let err = JSON.parse(r.stdout).error;
    assert.equal(err.code, 'interim_stale');
    assert.equal(err.hint, `forge verify ${j.id}`);
    assert.match(err.message, /Cargo.toml in the root repo does not pin repo lib at/);
    // A hand-edited rev is just as stale.
    assert.equal((await verify(p, j.id)).status, 0);
    const text = fs.readFileSync(path.join(j.rootWt, 'Cargo.toml'), 'utf8');
    p.commit(j.rootWt, { 'Cargo.toml': text.replace(/rev = "[0-9a-f]{40}"/, `rev = "${'1'.repeat(40)}"`) }, 'fix: pin');
    r = await p.raw(['pr', 'open', j.id, '--force', '--json'], p.env);
    err = JSON.parse(r.stdout).error;
    assert.equal(err.code, 'interim_stale');
    assert.equal(p.heads(p.rootBare), 'main', 'no root branch was pushed');
    assert.equal(p.heads(p.libBare), 'main', 'no member branch was pushed');
    assert.ok(!p.calls().some((c) => c.startsWith('pr create')));
  });

  test('git-ref pushes the dependency first and pins the scrubbed sha', async () => {
    const p = await project([{ ecosystem: 'cargo', name: 'app-core' }], { reverse: true });
    const j = await ready(p);
    const trailer = `${['Co', 'Authored', 'By'].join('-')}: Claude <noreply@anthropic.com>`;
    p.commit(j.rootWt, { 'core.rs': 'pub fn f() {}\n' }, `feat: core\n\n${trailer}`);
    p.commit(j.libWt, { 'Cargo.toml': '[package]\nname = "lib"\nversion = "0.1.0"\n\n[dependencies]\napp-core = "1"\n' });
    const r = await verify(p, j.id);
    assert.equal(r.status, 0, JSON.stringify(r.out.failure));
    const rootHead = head(p, j.rootWt);
    assert.doesNotMatch(p.git(j.rootWt, 'log', '--format=%B', 'main..HEAD'), /Authored/, 'verify scrubbed the dependency before pinning');
    assert.match(show(p, j.libWt, 'Cargo.toml'), new RegExp(`"app-core" = \\{ git = "file://${p.rootBare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}", rev = "${rootHead}" \\}`));
    // lib's push is rejected: the root's branch, pushed first, is already there.
    const hook = path.join(p.libBare, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failed = await p.raw(['pr', 'open', j.id], p.env);
    assert.equal(failed.status, 5, failed.stderr);
    assert.ok(p.heads(p.rootBare).split('\n').includes(j.branch), 'the root went first');
    assert.ok(!p.heads(p.libBare).split('\n').includes(j.branch));
    fs.rmSync(hook);
    const ok = await p.raw(['pr', 'open', j.id], p.env);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(p.git(p.rootBare, 'rev-parse', j.branch).trim(), rootHead, 'pr open pushed exactly the pinned sha');
  });
});
