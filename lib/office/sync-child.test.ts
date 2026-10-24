// syncChildEnv, and a tracked core.hooksPath hook against a real `git fetch` under that env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scratchGitConfig } from '../../test/helpers.ts';
import { SYNC_PINS } from '#integrations/git/runner.ts';
import { syncChildEnv } from './sync-child.ts';

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync('git', args, { cwd, env, stdio: 'pipe', encoding: 'utf8' });

function repo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  scratchGitConfig((...a: string[]) => git(dir, a));
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'init']);
}

test('the sync child runs git with the pins', (t) => {
  const env = syncChildEnv('/r', {
    PATH: '/bin',
    FORGE_DAEMON: '1',
    FORGE_DAEMON_SCOPE: 'j1',
    FORGE_DAEMON_TRUST: 'x',
    FORGE_DAEMON_WRITE_ROOTS: '{}',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Caller',
  });
  assert.equal(env.FORGE_ROOT, '/r');
  assert.equal(env.FORGE_MODE, 'agent');
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('FORGE_DAEMON')), []);
  assert.equal(env.GIT_CONFIG_COUNT, String(1 + SYNC_PINS.length));
  assert.deepEqual([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0], ['user.name', 'Caller'], "the caller's entry stays first");
  const pinned = SYNC_PINS.map((_, i) => [env[`GIT_CONFIG_KEY_${i + 1}`], env[`GIT_CONFIG_VALUE_${i + 1}`]]);
  assert.deepEqual(pinned, SYNC_PINS.map(([k, v]) => [k, v]));
  assert.ok(!pinned.some(([k]) => k === 'credential.helper'), 'credential.helper is never pinned');
  for (const k of ['core.hooksPath', 'core.fsmonitor', 'core.pager', 'diff.external', 'gpg.program']) assert.ok(pinned.some(([key]) => key === k), k);

  if (process.platform === 'win32') return t.diagnostic('the hook half skips on Windows');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sync-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const origin = path.join(base, 'origin');
  repo(origin);
  /** A checkout with a tracked .githooks/reference-transaction hook and core.hooksPath on it. */
  const checkout = (name: string) => {
    const dir = path.join(base, name);
    repo(dir);
    fs.mkdirSync(path.join(dir, '.githooks'));
    fs.writeFileSync(path.join(dir, '.githooks', 'reference-transaction'), '#!/bin/sh\necho ran > "$PWD/hook-ran"\n', { mode: 0o755 });
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'hooks']);
    git(dir, ['config', 'core.hooksPath', '.githooks']);
    git(dir, ['remote', 'add', 'origin', origin]);
    return dir;
  };
  const pinnedDir = checkout('pinned');
  git(pinnedDir, ['fetch', '-q', 'origin'], syncChildEnv(pinnedDir, process.env));
  assert.equal(fs.existsSync(path.join(pinnedDir, 'hook-ran')), false, 'the hook never runs under the pins');
  const bareDir = checkout('bare');
  git(bareDir, ['fetch', '-q', 'origin']);
  assert.equal(fs.existsSync(path.join(bareDir, 'hook-ran')), true, 'the hook runs without them');
});
