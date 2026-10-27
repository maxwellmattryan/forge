// hooks/plugin-path.ts as Claude Code runs it: node on the file with CLAUDE_ENV_FILE set, then the env
// file sourced by /bin/sh the way Claude Code does before each Bash command. POSIX-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = path.resolve(import.meta.dirname, '..', '..', '..');
const HOOK = path.join(PLUGIN, 'hooks', 'plugin-path.ts');
const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const OURS = `export PATH=${q(path.join(PLUGIN, 'bin'))}:"$PATH"`;
const MODE = 'export FORGE_MODE=agent';
const posix = process.platform === 'win32' ? { skip: 'POSIX shells only' } : {};

function scratch(t: any) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-path-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // Another install's bin/ with its own `forge`, as an older plugin version leaves in a resumed session's file.
  const other = path.join(base, 'old-install', 'bin');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'forge'), '#!/bin/sh\necho old\n', { mode: 0o755 });
  return { file: path.join(base, 'env.sh'), otherLine: `export PATH=${q(other)}:"$PATH"` };
}

function hook(file: string | null) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  if (file) env.CLAUDE_ENV_FILE = file;
  return spawnSync(process.execPath, [HOOK], { env, encoding: 'utf8' });
}

/** Where `forge` resolves once the env file is sourced, and the FORGE_MODE it leaves. */
function sourced(file: string) {
  const r = spawnSync('/bin/sh', ['-c', '. "$CLAUDE_ENV_FILE"; command -v forge; echo "$FORGE_MODE"'], {
    env: { PATH: '/usr/bin:/bin', CLAUDE_ENV_FILE: file, FORGE_MODE: 'human' },
    encoding: 'utf8',
  });
  const [forge, mode] = r.stdout.trim().split('\n');
  return { forge, mode };
}

test('a fresh env file gets the PATH and FORGE_MODE lines, and a rerun changes no byte', posix, (t) => {
  const { file } = scratch(t);
  fs.writeFileSync(file, 'export FOO=1');
  const r = hook(file);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(file, 'utf8'), `export FOO=1\n${OURS}\n${MODE}\n`);
  assert.deepEqual(sourced(file), { forge: path.join(PLUGIN, 'bin', 'forge'), mode: 'agent' });
  const before = fs.readFileSync(file);
  assert.equal(hook(file).status, 0);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("a resume moves our PATH line after another install's, once, keeping the other lines", posix, (t) => {
  const { file, otherLine } = scratch(t);
  // The inbox session that stalled: our line first, then an older install's prepended after it.
  fs.writeFileSync(file, `${OURS}\n${MODE}\n${otherLine}\n`);
  assert.equal(sourced(file).forge.endsWith(path.join('old-install', 'bin', 'forge')), true);
  assert.equal(hook(file).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), `${MODE}\n${otherLine}\n${OURS}\n`);
  assert.equal(sourced(file).forge, path.join(PLUGIN, 'bin', 'forge'));
  const before = fs.readFileSync(file);
  assert.equal(hook(file).status, 0);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a rewrite keeps the env file mode, and a new file is private', posix, (t) => {
  const { file, otherLine } = scratch(t);
  fs.writeFileSync(file, `${OURS}\n${MODE}\n${otherLine}\n`, { mode: 0o640 });
  fs.chmodSync(file, 0o640);
  assert.equal(hook(file).status, 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  const fresh = path.join(path.dirname(file), 'fresh.sh');
  assert.equal(hook(fresh).status, 0);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
});

test('a file with our PATH line last but no FORGE_MODE gains only that line', posix, (t) => {
  const { file, otherLine } = scratch(t);
  fs.writeFileSync(file, `${otherLine}\n${OURS}\n`);
  assert.equal(hook(file).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), `${otherLine}\n${OURS}\n${MODE}\n`);
});

test('no CLAUDE_ENV_FILE writes nothing; an unwritable one never breaks session start', posix, (t) => {
  const { file } = scratch(t);
  const none = hook(null);
  assert.equal(none.status, 0);
  assert.equal(none.stdout, '');
  const bad = hook(path.join(path.dirname(file), 'no', 'such', 'dir', 'env.sh'));
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /plugin-path hook/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['old-install']);
});
