// bin/forge's start-up cache: V8's code cache everywhere, plus stripped lib/ modules on Node 22.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'forge');
const POSIX = { skip: process.platform === 'win32' ? 'POSIX permissions' : false };
// Node 24+ caches type-stripped modules itself, so bin/forge registers no strip hook there.
const STRIPS = Number(process.versions.node.split('.')[0]) < 24;
const STRIP = { skip: process.platform === 'win32' ? 'POSIX permissions' : STRIPS ? false : 'Node 24+ needs no strip cache' };
const PLANTED = 'served from the strip cache';

/** `forge help` with only this test's cache settings: the suite's own compile cache and hooks are dropped. */
function forge(env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const base = { ...process.env };
  for (const k of ['NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_OPTIONS', 'FORGE_CACHE_DIR', 'FORGE_DEBUG']) delete base[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, 'help'], { cwd: ROOT, encoding: 'utf8', env: { ...base, ...env } }, (err, stdout, stderr) => {
      const code = err ? (err as any).code : 0;
      resolve({ status: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}

function scratch(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cache-test-')));
}

const stripDir = (cache: string) => path.join(cache, 'strip', process.version);

/** A stand-in for lib/cli.ts in the strip cache, under the key the real file's content gives. */
function plant(cache: string) {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'cli.ts'), 'utf8');
  fs.mkdirSync(stripDir(cache), { recursive: true, mode: 0o700 });
  const file = path.join(stripDir(cache), `${createHash('sha256').update(src).digest('hex')}.js`);
  fs.writeFileSync(file, `export async function main() { process.stdout.write(${JSON.stringify(PLANTED)}); }\nexport function reportError() { return 1; }\n`);
}

describe('start-up cache', { concurrency: 4 }, () => {
  let reference: Promise<string>;
  const expected = () => (reference ??= forge({ NODE_DISABLE_COMPILE_CACHE: '1' }).then((r) => r.stdout));

  test('fills a private cache dir and prints exactly what an uncached start prints', POSIX, async () => {
    const dir = scratch();
    try {
      const cache = path.join(dir, 'cache');
      const first = await forge({ FORGE_CACHE_DIR: cache });
      assert.equal(first.status, 0);
      assert.equal(first.stderr, '', 'no ExperimentalWarning or other noise');
      assert.equal(first.stdout, await expected());
      assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
      assert.ok(fs.readdirSync(path.join(cache, 'v8')).length > 0, 'V8 code cache written');
      if (STRIPS) {
        const entries = fs.readdirSync(stripDir(cache));
        assert.ok(entries.includes(`${createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'lib', 'cli.ts'), 'utf8')).digest('hex')}.js`));
        assert.ok(entries.every((f) => /^[0-9a-f]{64}\.js$/.test(f)), 'no temp files left behind');
      } else {
        assert.ok(!fs.existsSync(path.join(cache, 'strip')));
      }
      const second = await forge({ FORGE_CACHE_DIR: cache });
      assert.deepEqual(second, first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Beside the code it caches, so a sandbox that can write the temp dir but not the plugin can't plant a module.
  test('defaults to .cache in the plugin root, ignored by git', POSIX, async () => {
    const r = await forge({});
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, await expected());
    const cache = path.join(ROOT, '.cache');
    assert.equal(fs.readFileSync(path.join(cache, '.gitignore'), 'utf8'), '*\n');
    assert.equal(fs.existsSync(stripDir(cache)), STRIPS);
    const status = await new Promise<string>((resolve) => execFile('git', ['status', '--porcelain', '--ignored=no', '--', '.cache'], { cwd: ROOT, encoding: 'utf8' }, (_e, out) => resolve(out)));
    assert.equal(status, '');
  });

  test('a cached module is what runs', STRIP, async () => {
    const dir = scratch();
    try {
      plant(path.join(dir, 'cache'));
      fs.chmodSync(path.join(dir, 'cache'), 0o700);
      assert.equal((await forge({ FORGE_CACHE_DIR: path.join(dir, 'cache') })).stdout, PLANTED);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The cache holds code the CLI runs, so a dir someone else could write is never read.
  test('a cache dir others can write, or a symlink, is ignored', STRIP, async () => {
    const dir = scratch();
    try {
      const open = path.join(dir, 'open');
      plant(open);
      fs.chmodSync(open, 0o777);
      const real = path.join(dir, 'real');
      plant(real);
      fs.chmodSync(real, 0o700);
      fs.symlinkSync(real, path.join(dir, 'link'));
      const shared = path.join(dir, 'shared');
      fs.mkdirSync(shared);
      plant(path.join(shared, 'cache'));
      fs.chmodSync(path.join(shared, 'cache'), 0o700);
      fs.chmodSync(shared, 0o777);
      for (const cache of [open, path.join(dir, 'link'), path.join(shared, 'cache')]) {
        const r = await forge({ FORGE_CACHE_DIR: cache });
        assert.equal(r.stderr, '', cache);
        assert.equal(r.stdout, await expected(), cache);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('NODE_DISABLE_COMPILE_CACHE turns it off, and a read-only dir just runs uncached', POSIX, async () => {
    const dir = scratch();
    try {
      const off = path.join(dir, 'off');
      const r = await forge({ FORGE_CACHE_DIR: off, NODE_DISABLE_COMPILE_CACHE: '1' });
      assert.equal(r.stdout, await expected());
      assert.ok(!fs.existsSync(off));

      const ro = path.join(dir, 'ro');
      fs.mkdirSync(ro, { mode: 0o500 });
      const s = await forge({ FORGE_CACHE_DIR: ro });
      assert.equal(s.status, 0);
      assert.equal(s.stderr, '');
      assert.equal(s.stdout, await expected());
      assert.deepEqual(fs.readdirSync(ro), []);
    } finally {
      fs.chmodSync(path.join(dir, 'ro'), 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
