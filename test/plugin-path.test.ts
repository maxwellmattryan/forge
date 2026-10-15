// hooks/plugin-path.ts: the SessionStart hook that puts the loaded plugin's bin/ first on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'plugin-path.ts');

/** Runs a hook file with `env` added and CLAUDE_ENV_FILE removed unless `env` sets it. */
function runHook(hook: string, env: Record<string, string | undefined>, cwd: string) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.CLAUDE_ENV_FILE;
  return spawnSync(process.execPath, [hook], { cwd, env: { ...base, ...env }, encoding: 'utf8' });
}

/** Sources the env file in /bin/sh with `decoy` first on PATH and prints which forge wins. */
function whichForge(envFile: string, decoy: string, cwd: string) {
  return spawnSync('/bin/sh', ['-c', '. "$CLAUDE_ENV_FILE"; command -v forge'], {
    cwd,
    env: { PATH: `${decoy}${path.delimiter}/usr/bin${path.delimiter}/bin`, CLAUDE_ENV_FILE: envFile },
    encoding: 'utf8',
  });
}

/** A dir holding an executable `forge` that must lose to the plugin's. */
function decoyDir(tmp: string): string {
  const decoy = path.join(tmp, 'decoy');
  fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, 'forge'), '#!/bin/sh\necho decoy\n', { mode: 0o755 });
  return decoy;
}

test("SessionStart hook puts the plugin's bin first", POSIX, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-path-')));
  try {
    const before = fs.readdirSync(tmp);
    const unset = runHook(HOOK, {}, tmp);
    assert.equal(unset.status, 0, unset.stderr);
    assert.equal(unset.stdout, '');
    assert.deepEqual(fs.readdirSync(tmp), before, 'no file is created without CLAUDE_ENV_FILE');
    const empty = runHook(HOOK, { CLAUDE_ENV_FILE: '' }, tmp);
    assert.equal(empty.status, 0);
    assert.equal(empty.stdout, '');
    assert.deepEqual(fs.readdirSync(tmp), before);

    const envFile = path.join(tmp, 'env.sh');
    fs.writeFileSync(envFile, 'export FOO=1');
    const first = runHook(HOOK, { CLAUDE_ENV_FILE: envFile }, tmp);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, '');
    const expected = `export FOO=1\nexport PATH='${path.join(ROOT, 'bin')}':"$PATH"\n`;
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected);
    const second = runHook(HOOK, { CLAUDE_ENV_FILE: envFile }, tmp);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '');
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected, 'a second run changes nothing');

    const r = whichForge(envFile, decoyDir(tmp), tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), path.join(ROOT, 'bin', 'forge'));

    // A missing env file is created; an unwritable one is reported on stderr, never stdout, exit 0.
    const fresh = path.join(tmp, 'fresh.sh');
    assert.equal(runHook(HOOK, { CLAUDE_ENV_FILE: fresh }, tmp).status, 0);
    assert.equal(fs.readFileSync(fresh, 'utf8'), `export PATH='${path.join(ROOT, 'bin')}':"$PATH"\n`);
    const bad = runHook(HOOK, { CLAUDE_ENV_FILE: path.join(tmp, 'no', 'such', 'dir', 'env.sh') }, tmp);
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /plugin-path hook/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hook quotes a hostile plugin path', POSIX, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hostile-')));
  try {
    const plugin = path.join(tmp, "a b'c$(touch pwned)`x`");
    fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(plugin, 'bin'));
    fs.copyFileSync(HOOK, path.join(plugin, 'hooks', 'plugin-path.ts'));
    fs.writeFileSync(path.join(plugin, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(plugin, 'bin', 'forge'), '#!/bin/sh\necho hostile\n', { mode: 0o755 });
    const envFile = path.join(tmp, 'env.sh');
    const r = runHook(path.join(plugin, 'hooks', 'plugin-path.ts'), { CLAUDE_ENV_FILE: envFile }, tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const which = whichForge(envFile, decoyDir(tmp), tmp);
    assert.equal(which.status, 0, which.stderr);
    assert.equal(which.stdout.trim(), path.join(plugin, 'bin', 'forge'));
    const pwned = (fs.readdirSync(tmp, { recursive: true }) as string[]).filter((f) => path.basename(f) === 'pwned');
    assert.deepEqual(pwned, [], 'nothing in the path was executed');
    assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hooks.json registers the SessionStart hook', () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/plugin-path.ts'] }] }]);
  assert.deepEqual(hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/no-ai-attribution.ts'] }] }]);
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart']);
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.doesNotMatch(src, /from '\.{1,2}\//, 'no relative imports: a copy runs anywhere');
});
