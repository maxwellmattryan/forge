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

/**
 * The env file's lines that matter: `prior` kept as the leading lines, then exactly one PATH line
 * for `bin` and exactly one FORGE_MODE line, in that order. Returns the file's bytes.
 */
function assertEnvLines(envFile: string, prior: string[], bin = path.join(ROOT, 'bin')): Buffer {
  const bytes = fs.readFileSync(envFile);
  const lines = bytes.toString('utf8').split('\n');
  assert.deepEqual(lines.slice(0, prior.length), prior, 'prior content kept first');
  const pathLine = `export PATH='${bin}':"$PATH"`;
  const pathAt = lines.flatMap((l, i) => (l === pathLine ? [i] : []));
  const modeAt = lines.flatMap((l, i) => (l === 'export FORGE_MODE=agent' ? [i] : []));
  assert.equal(pathAt.length, 1, `one PATH line: ${JSON.stringify(lines)}`);
  assert.equal(modeAt.length, 1, `one FORGE_MODE line: ${JSON.stringify(lines)}`);
  assert.ok(pathAt[0] < modeAt[0], 'the mode line follows the PATH line');
  return bytes;
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
    const afterFirst = assertEnvLines(envFile, ['export FOO=1']);
    const second = runHook(HOOK, { CLAUDE_ENV_FILE: envFile }, tmp);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '');
    assert.ok(fs.readFileSync(envFile).equals(afterFirst), 'a second run changes nothing');

    const r = whichForge(envFile, decoyDir(tmp), tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), path.join(ROOT, 'bin', 'forge'));

    // The line already there without a trailing newline (something else rewrote the file) counts too.
    const bare = path.join(tmp, 'bare.sh');
    fs.writeFileSync(bare, `export FOO=1\nexport PATH='${path.join(ROOT, 'bin')}':"$PATH"\nexport FORGE_MODE=agent`);
    const bareBefore = fs.readFileSync(bare);
    assert.equal(runHook(HOOK, { CLAUDE_ENV_FILE: bare }, tmp).status, 0);
    assert.ok(fs.readFileSync(bare).equals(bareBefore), 'no duplicate line');

    // A missing env file is created; an unwritable one is reported on stderr, never stdout, exit 0.
    const fresh = path.join(tmp, 'fresh.sh');
    assert.equal(runHook(HOOK, { CLAUDE_ENV_FILE: fresh }, tmp).status, 0);
    assertEnvLines(fresh, []);
    const bad = runHook(HOOK, { CLAUDE_ENV_FILE: path.join(tmp, 'no', 'such', 'dir', 'env.sh') }, tmp);
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /plugin-path hook/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SessionStart hook pins agent output mode', POSIX, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-mode-')));
  try {
    const envFile = path.join(tmp, 'env.sh');
    // A file that already has the PATH line (written by an older hook) gains only the mode line.
    const pathLine = `export PATH='${path.join(ROOT, 'bin')}':"$PATH"`;
    fs.writeFileSync(envFile, pathLine + '\n');
    const first = runHook(HOOK, { CLAUDE_ENV_FILE: envFile }, tmp);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, '');
    // assertEnvLines also holds that the old PATH line was not written twice.
    const afterFirst = assertEnvLines(envFile, [pathLine]);
    const second = runHook(HOOK, { CLAUDE_ENV_FILE: envFile }, tmp);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, '');
    assert.ok(fs.readFileSync(envFile).equals(afterFirst), 'a second run adds nothing');
    const r = spawnSync('/bin/sh', ['-c', '. "$CLAUDE_ENV_FILE"; printf %s "$FORGE_MODE"'], { cwd: tmp, env: { PATH: '/usr/bin:/bin', CLAUDE_ENV_FILE: envFile, FORGE_MODE: 'human' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'agent', 'sourcing the file overrides an inherited FORGE_MODE');
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
