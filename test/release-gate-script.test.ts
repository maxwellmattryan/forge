// The seeded release-gate script (templates/release-gate/release-gate.mjs), run with plain node in
// scratch git repos whose manifests the interim pin writers produced. No sh: it runs on Windows too.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { canaryVersion, pinCargo, pinCmake, pinNpm } from '../lib/interim.ts';
import { PLUGIN_ROOT } from '../lib/paths.ts';
import { scratchGitConfig } from './helpers.ts';

const SCRIPT = path.join(PLUGIN_ROOT, 'templates', 'release-gate', 'release-gate.mjs');
const SHA = 'a'.repeat(40);
const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-')));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  scratchGitConfig(git);
  const put = (files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
  };
  const commit = (files: Record<string, string>) => {
    put(files);
    git('add', '-A');
    git('commit', '-qm', 'manifests', '--allow-empty');
  };
  const gate = (script = SCRIPT) => {
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { dir, git, put, commit, gate };
}

const ok = (r: { text: string } | { error: string }): string => {
  if ('error' in r) throw new Error(r.error);
  return r.text;
};

const CARGO = '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nlib = "1.2.0"\n';
const PKG = '{\n  "name": "app",\n  "dependencies": {\n    "lib": "^1.2.0"\n  }\n}\n';
const CMAKE = 'cmake_minimum_required(VERSION 3.24)\ninclude(FetchContent)\nFetchContent_Declare(\n  lib\n  GIT_REPOSITORY https://example.com/lib.git\n  GIT_TAG v1.2.0\n)\n';

const pinned = () => ({
  'Cargo.toml': ok(pinCargo(CARGO, [{ source: 'crates-io', name: 'lib', git: 'https://example.com/lib.git', rev: SHA }])),
  'package.json': ok(pinNpm(PKG, 'lib', `git+https://example.com/lib.git#${SHA}`)),
  'cmake/CMakeLists.txt': ok(pinCmake(CMAKE, 'lib', SHA)),
  'web/package.json': ok(pinNpm(PKG, 'lib', canaryVersion('1.2.0', SHA)!)),
});

describe('the seeded release gate script', { concurrency: 4 }, () => {
  test('fails on a git-ref or canary pin, per ecosystem', () => {
    for (const [file, text] of Object.entries(pinned())) {
      const r = repo();
      r.commit({ [file]: text });
      const out = r.gate();
      assert.equal(out.status, 1, `${file}: ${out.stdout}${out.stderr}`);
      const eco = file.endsWith('Cargo.toml') ? 'cargo' : file.endsWith('package.json') ? 'npm' : 'cmake';
      const line = out.stdout.split('\n').find((l) => l.startsWith(`${file}:`));
      assert.ok(line, out.stdout);
      assert.match(line!, new RegExp(`^${file.replace(/[.]/g, '\\.')}:\\d+: ${eco}: `));
      assert.match(out.stdout, /release gate: 1 interim references; replace them with released versions before merging\n$/);
    }
    const r = repo();
    r.commit(pinned());
    const out = r.gate();
    assert.equal(out.status, 1);
    const lines = out.stdout.trim().split('\n');
    assert.deepEqual(lines.slice(0, -1).map((l) => l.split(': ').slice(0, 3).join(': ')).sort(), [
      `Cargo.toml:${CARGO.split('\n').length + 1}: cargo: a Forge interim [patch] block`,
      'cmake/CMakeLists.txt:6: cmake: a GIT_TAG pinned to a commit',
      'package.json:4: npm: a git dependency pinned to a commit',
      'web/package.json:4: npm: a canary pre-release',
    ]);
    assert.equal(lines.at(-1), 'release gate: 4 interim references; replace them with released versions before merging');
    assert.match(out.stdout, new RegExp(`package\\.json:4: npm: a git dependency pinned to a commit: "lib": "git\\+https://example\\.com/lib\\.git#${SHA}"`));
  });

  test('passes once every dependency is a released version', () => {
    const r = repo();
    r.commit(pinned());
    assert.equal(r.gate().status, 1);
    r.commit({ 'Cargo.toml': CARGO, 'package.json': PKG, 'cmake/CMakeLists.txt': CMAKE, 'web/package.json': PKG });
    const out = r.gate();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(out.stdout, 'release gate: no interim references in 4 manifests\n');
  });

  test('scans tracked files only', () => {
    const r = repo();
    r.commit({ 'package.json': PKG, '.gitignore': 'ignored/\n', 'node_modules/dep/package.json': pinned()['package.json'] });
    r.put({ 'untracked/Cargo.toml': pinned()['Cargo.toml'], 'ignored/package.json': pinned()['package.json'] });
    const out = r.gate();
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(out.stdout, 'release gate: no interim references in 1 manifests\n');
  });

  test('fails closed when it cannot check', () => {
    const r = repo();
    r.commit({ 'package.json': '{ "name": "app", ' });
    const bad = r.gate();
    assert.equal(bad.status, 2);
    assert.equal(bad.stderr, 'release gate: cannot check: package.json is not valid JSON\n');
    r.commit({ 'package.json': '[1, 2]\n' });
    const arr = r.gate();
    assert.equal(arr.status, 2);
    assert.match(arr.stderr, /^release gate: cannot check: package\.json is not a JSON object\n$/);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-nogit-')));
    dirs.push(outside);
    const none = spawnSync(process.execPath, [SCRIPT], { cwd: outside, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(outside) } });
    assert.equal(none.status, 2, none.stdout + none.stderr);
    assert.match(none.stderr, /^release gate: cannot check: git ls-files exited /);
  });

  test('patterns are editable in the seeded file', () => {
    const r = repo();
    r.commit({ 'package.json': pinned()['package.json'] });
    assert.equal(r.gate().status, 1);
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const edited = src.replace(/\n {2}\{\n {4}\/\/ edit to match your project: a git dependency at a commit[\s\S]*?\n {2}\},/, '');
    assert.notEqual(edited, src, 'the npm rule was found and removed');
    const copy = path.join(r.dir, '..', `${path.basename(r.dir)}-gate.mjs`);
    fs.writeFileSync(copy, edited);
    dirs.push(copy);
    const out = r.gate(copy);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(out.stdout, 'release gate: no interim references in 0 manifests\n');
  });

  test('a long hostile line stays linear', () => {
    const r = repo();
    const long = `  GIT_TAG ${'a'.repeat(10_000)}\n`;
    const pkg = JSON.stringify({ dependencies: { x: `git+${'#'.repeat(10_000)}`, y: `${'-canary'.repeat(2000)}` } });
    r.commit({ 'CMakeLists.txt': long, 'package.json': pkg });
    const t = Date.now();
    const out = r.gate();
    assert.ok(Date.now() - t < 5000, 'no catastrophic backtracking');
    assert.equal(out.status, 0, out.stdout + out.stderr);
  });
});
