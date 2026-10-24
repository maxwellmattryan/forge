// writeManifest, the one writer of a consumer's manifest during an interim refresh: it keeps the
// manifest's mode, replaces a link at the manifest instead of following it, refuses a link planted
// at its temp name and leaves no temp file behind when the write fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeManifest } from './interim-apply.ts';

const POSIX = process.platform !== 'win32';

/** A scratch dir holding a worktree `wt/` and room for files outside it. */
function scratch(t: { after: (fn: () => void) => void }): { dir: string; wt: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-manifest-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
  return { dir, wt };
}

const temps = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).sort();
const mode = (file: string) => fs.statSync(file).mode & 0o777;

test("writeManifest keeps the manifest's mode", (t) => {
  const { dir, wt } = scratch(t);
  const cmake = path.join(wt, 'CMakeLists.txt');
  fs.writeFileSync(cmake, 'old\n');
  fs.chmodSync(cmake, 0o640);
  writeManifest(wt, 'CMakeLists.txt', 'new\n');
  assert.equal(fs.readFileSync(cmake, 'utf8'), 'new\n');
  if (POSIX) assert.equal(mode(cmake), 0o640, 'the mode is kept');
  assert.deepEqual(temps(wt), [], 'no temp file is left');

  writeManifest(wt, 'Cargo.toml', 'fresh\n');
  assert.equal(fs.readFileSync(path.join(wt, 'Cargo.toml'), 'utf8'), 'fresh\n');
  if (POSIX) assert.equal(mode(path.join(wt, 'Cargo.toml')), 0o600, 'a new manifest is owner-only');

  if (POSIX) {
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, 'outside\n');
    fs.chmodSync(outside, 0o644);
    const pkg = path.join(wt, 'package.json');
    fs.symlinkSync(outside, pkg);
    writeManifest(wt, 'package.json', '{}\n');
    assert.ok(fs.lstatSync(pkg).isFile(), 'the link is replaced by a regular file');
    assert.equal(fs.readFileSync(pkg, 'utf8'), '{}\n');
    assert.equal(mode(pkg), 0o600, "a link's target mode is never copied");
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n', 'the link target is unchanged');
    assert.equal(mode(outside), 0o644);
  }
  assert.deepEqual(temps(wt), []);
});

test('writeManifest never follows a planted temp name and cleans up a failed rename', (t) => {
  const { dir, wt } = scratch(t);
  if (POSIX) {
    const outside = path.join(dir, 'outside');
    fs.writeFileSync(outside, 'keep me\n');
    const cargo = path.join(wt, 'Cargo.toml');
    fs.writeFileSync(cargo, 'original\n');
    const planted = path.join(wt, 'Cargo.toml.fixed.tmp');
    fs.symlinkSync(outside, planted);
    assert.throws(() => writeManifest(wt, 'Cargo.toml', 'pinned\n', () => 'fixed'), (e: any) => e.code === 'EEXIST');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me\n', 'the link target is untouched');
    assert.equal(fs.readFileSync(cargo, 'utf8'), 'original\n', 'the manifest is unchanged');
    assert.ok(fs.lstatSync(planted).isSymbolicLink(), 'the planted link is left in place');
    assert.equal(fs.readlinkSync(planted), outside);
    assert.deepEqual(temps(wt), ['Cargo.toml.fixed.tmp'], 'no other temp file is left');
    fs.rmSync(planted);
  }

  const pkg = path.join(wt, 'package.json');
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'inside'), 'x');
  assert.throws(() => writeManifest(wt, 'package.json', '{}'));
  assert.deepEqual(temps(wt), [], 'the failed rename leaves no temp file');
  assert.equal(fs.readFileSync(path.join(pkg, 'inside'), 'utf8'), 'x', 'the directory is intact');
});
