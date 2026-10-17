// writeManifest, the interim pin writer: a random-named temp file opened exclusive and no-follow,
// renamed over the manifest, and removed whenever anything after its creation fails.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeManifest } from '../lib/interim-apply.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function scratch(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-manifest-')));
  dirs.push(d);
  fs.mkdirSync(path.join(d, 'wt'));
  return d;
}

const forgeTemps = (dir: string) => fs.readdirSync(dir).filter((f) => /\.forge-.*\.tmp$/.test(f));

describe('interim manifest writes', () => {
  test('a symlink planted at the temp path is never followed', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, () => {
    const d = scratch();
    const wt = path.join(d, 'wt');
    const outside = path.join(d, 'outside.txt');
    fs.writeFileSync(outside, 'keep me\n');
    fs.writeFileSync(path.join(wt, 'Cargo.toml'), 'original\n');
    const planted = path.join(wt, '.Cargo.toml.forge-fixed.tmp');
    fs.symlinkSync(outside, planted);
    assert.throws(() => writeManifest(wt, 'Cargo.toml', 'pinned\n', () => 'fixed'), (e: any) => e.code === 'EEXIST' || e.code === 'ELOOP');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me\n');
    assert.equal(fs.readFileSync(path.join(wt, 'Cargo.toml'), 'utf8'), 'original\n');
    assert.ok(fs.lstatSync(planted).isSymbolicLink(), 'the planted link is not Forge\'s to remove');
    assert.deepEqual(forgeTemps(wt), ['.Cargo.toml.forge-fixed.tmp'], 'no temp file of Forge\'s is left');
  });

  test('a failed rename leaves no temp file', () => {
    const d = scratch();
    const wt = path.join(d, 'wt');
    fs.mkdirSync(path.join(wt, 'package.json'));
    fs.writeFileSync(path.join(wt, 'package.json', 'inner'), 'x');
    assert.throws(() => writeManifest(wt, 'package.json', '{}\n'));
    assert.deepEqual(forgeTemps(wt), []);
    assert.ok(fs.statSync(path.join(wt, 'package.json')).isDirectory());
  });

  test('the manifest keeps its mode', () => {
    const d = scratch();
    const wt = path.join(d, 'wt');
    const file = path.join(wt, 'CMakeLists.txt');
    fs.writeFileSync(file, 'old\n');
    fs.chmodSync(file, 0o640);
    writeManifest(wt, 'CMakeLists.txt', 'new\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(forgeTemps(wt), []);
  });
});
