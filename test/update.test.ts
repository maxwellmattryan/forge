import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { DAEMON_REFUSAL, detectInstall, updateForge } from '../lib/update.ts';
import { SUPPORT_URL, WINDOWS_UPDATE_REFUSAL } from '../lib/platform.ts';
import { ForgeError } from '../lib/util.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const BIN = path.join(REPO, 'bin', 'forge');
const POSIX = { skip: process.platform === 'win32' && 'stub executables and PATH lookup are POSIX-only' };

// The dashboard check resolves cwd through mainRoot(), which honours FORGE_ROOT first: the tests
// pick their cwd themselves, and must never see the real repo's running dashboard.
delete process.env.FORGE_ROOT;
delete process.env.FORGE_DAEMON;

function scratch(): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-')));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

const STUB_CLAUDE = `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'marketplace' && process.env.STUB_MKT_FAIL) {
  process.stderr.write('boom: marketplace unreachable\\n');
  process.exit(3);
}
if (args[0] === 'plugin' && args[1] === 'update' && process.env.STUB_INSTALLED) {
  const j = JSON.parse(fs.readFileSync(process.env.STUB_INSTALLED, 'utf8'));
  // A project-scope entry first: the user-scope one must still win.
  j.plugins[args[2]] = [{ scope: 'project', installPath: '/nonexistent/forge', version: '9.9.9' }, { scope: 'user', installPath: process.env.STUB_INSTALL_PATH, version: '0.2.0' }];
  fs.writeFileSync(process.env.STUB_INSTALLED, JSON.stringify(j));
}
`;

// CommonJS on purpose: the new install's package.json has no "type".
const STUB_FORGE = `const fs = require('fs');
fs.appendFileSync(process.env.STUB_FORGE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
process.stdout.write(process.argv.includes('--background') ? '{"url":"http://127.0.0.1:7401","pid":1,"started":true}\\n' : '{"stopped":true}\\n');
`;

/** A stub `claude` on its own PATH dir that logs every argv as one JSON line. */
function stubClaude(base: string) {
  const dir = path.join(base, 'stub-bin');
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(base, 'stub-claude.mjs');
  fs.writeFileSync(js, STUB_CLAUDE);
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`);
  fs.chmodSync(bin, 0o755);
  const log = path.join(base, 'claude.log');
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, log, calls };
}

/** `<base>/plugins/cache/<marketplace>/<name>/<version>` plus installed_plugins.json, as Claude Code lays it out. */
function pluginInstall(base: string, { marketplace = 'forge', name = 'forge', version = '0.1.0' } = {}) {
  const pluginsDir = path.join(base, 'plugins');
  const root = path.join(pluginsDir, 'cache', marketplace, name, version);
  writeJson(path.join(root, 'package.json'), { name: '@maxwellmattryan/forge', version });
  const installed = path.join(pluginsDir, 'installed_plugins.json');
  writeJson(installed, { version: 2, plugins: { [`${name}@${marketplace}`]: [{ scope: 'user', installPath: root, version }] } });
  return { pluginsDir, root, installed };
}

/** A new install dir whose bin/forge is a stub that logs argv and cwd. */
function newInstall(dir: string, version: string) {
  writeJson(path.join(dir, 'package.json'), { version });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'forge'), STUB_FORGE);
  return dir;
}

function stubEnv(stub: { dir: string; log: string }, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [stub.dir, '/usr/bin', '/bin'].join(path.delimiter), STUB_LOG: stub.log, ...extra };
  delete env.FORGE_ROOT;
  delete env.FORGE_DAEMON;
  return env;
}

function cli(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) {
  const env = { ...(opts.env ?? process.env) };
  delete env.FORGE_ROOT;
  if (!opts.env) delete env.FORGE_DAEMON;
  return spawnSync(process.execPath, [BIN, ...args], { cwd: opts.cwd, env, encoding: 'utf8' });
}

/** A bare remote, a seed clone that pushes to it, and fresh clones tracking main. */
function gitFixture(base: string) {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(base, 'seed');
  git(base, 'clone', '-q', remote, seed);
  const bump = (version: string) => {
    writeJson(path.join(seed, 'package.json'), { name: '@maxwellmattryan/forge', version });
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', `v${version}`);
    git(seed, 'push', '-q', 'origin', 'main');
  };
  bump('0.1.0');
  const clone = (name: string) => {
    const dir = path.join(base, name);
    git(base, 'clone', '-q', remote, dir);
    return dir;
  };
  const head = (cwd: string) => git(cwd, 'rev-parse', 'HEAD');
  return { git, remote, seed, bump, clone, head };
}

test('AC1: update --check runs outside a git repo', () => {
  const s = scratch();
  try {
    const r = cli(['update', '--check'], { cwd: s.dir });
    assert.doesNotMatch(r.stderr, /not inside a git repository/);
    const out = JSON.parse(r.stdout);
    assert.equal(out.version, JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version);
    assert.ok(['plugin', 'git', 'unknown'].includes(out.kind), out.kind);
    assert.ok(Array.isArray(out.commands));
    assert.equal(out.dashboard, undefined, 'no repo at cwd, so no dashboard key');
  } finally {
    s.cleanup();
  }
});

test('AC2: refuses in a daemon session', POSIX, async () => {
  const s = scratch();
  try {
    const stub = stubClaude(s.dir);
    const env = { ...stubEnv(stub), FORGE_DAEMON: '1' };
    for (const args of [['update'], ['update', '--check']]) {
      const r = cli(args, { cwd: s.dir, env });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /daemon/);
      assert.equal(r.stdout, '');
    }
    const { root } = pluginInstall(s.dir);
    await assert.rejects(updateForge({ root, cwd: s.dir, env }), /daemon session/);
    await assert.rejects(updateForge({ root, cwd: s.dir, env, check: true }), /daemon session/);
    assert.deepEqual(stub.calls(), []);
  } finally {
    s.cleanup();
  }
});

test('forge update is refused on native Windows', async () => {
  const s = scratch();
  try {
    // No git or claude on PATH: a refusal that ran detection or any subprocess would fail differently.
    const env = { PATH: path.join(s.dir, 'empty-bin') };
    for (const check of [false, true]) {
      await assert.rejects(updateForge({ root: s.dir, cwd: s.dir, env, check, platform: 'win32' }), (e: unknown) => {
        assert.ok(e instanceof ForgeError, String(e));
        assert.equal(e.message, WINDOWS_UPDATE_REFUSAL);
        assert.ok(e.message.includes(SUPPORT_URL));
        assert.equal(e.code, 'failed');
        assert.equal(e.exitCode, 1);
        return true;
      }, `check: ${check}`);
    }
    // The daemon refusal still comes first.
    await assert.rejects(updateForge({ root: s.dir, cwd: s.dir, env: { ...env, FORGE_DAEMON: '1' }, platform: 'win32' }), (e: unknown) => {
      assert.equal((e as Error).message, DAEMON_REFUSAL);
      return true;
    });
    // Off Windows the same call gets past the refusal to detection.
    const other = await updateForge({ root: s.dir, cwd: s.dir, env, check: true, platform: 'linux' }).then(
      () => null,
      (e: Error) => e.message,
    );
    assert.notEqual(other, WINDOWS_UPDATE_REFUSAL);
  } finally {
    s.cleanup();
  }
});

test('AC3: detects a plugin cache install and --check runs nothing', POSIX, async () => {
  const s = scratch();
  try {
    const stub = stubClaude(s.dir);
    const { root } = pluginInstall(s.dir);
    // Claude Code's cache dirs can hold a .git: plugin detection must still win.
    execFileSync('git', ['init', '-q', root]);
    const info = detectInstall(root);
    assert.equal(info.kind, 'plugin');
    assert.equal(info.plugin, 'forge@forge');
    const out: any = await updateForge({ root, cwd: s.dir, env: stubEnv(stub), check: true });
    assert.equal(out.kind, 'plugin');
    assert.equal(out.plugin, 'forge@forge');
    assert.equal(out.version, '0.1.0');
    assert.equal(out.root, root);
    assert.deepEqual(out.commands, ['claude plugin marketplace update forge', 'claude plugin update forge@forge']);
    assert.equal(out.blocked, undefined);
    assert.deepEqual(stub.calls(), []);
  } finally {
    s.cleanup();
  }
});

test('AC3: a marketplace clone takes its plugin name from plugin.json', () => {
  const s = scratch();
  try {
    const pluginsDir = path.join(s.dir, 'plugins');
    writeJson(path.join(pluginsDir, 'known_marketplaces.json'), { forge: { installLocation: path.join(pluginsDir, 'marketplaces', 'forge') } });
    const root = path.join(pluginsDir, 'marketplaces', 'forge');
    writeJson(path.join(root, 'package.json'), { version: '0.3.0' });
    writeJson(path.join(root, '.claude-plugin', 'plugin.json'), { name: 'forge' });
    const info = detectInstall(root);
    assert.equal(info.kind, 'plugin');
    assert.equal(info.plugin, 'forge@forge');
    assert.equal(info.version, '0.3.0');
  } finally {
    s.cleanup();
  }
});

test('AC4: plugin update runs marketplace then plugin update and reads the new version from installed_plugins.json', POSIX, async () => {
  const s = scratch();
  try {
    const stub = stubClaude(s.dir);
    const { root, installed } = pluginInstall(s.dir);
    const next = newInstall(path.join(s.dir, 'plugins', 'cache', 'forge', 'forge', '0.2.0'), '0.2.0');
    const out: any = await updateForge({ root, cwd: s.dir, env: stubEnv(stub, { STUB_INSTALLED: installed, STUB_INSTALL_PATH: next }) });
    assert.deepEqual(stub.calls(), [
      ['plugin', 'marketplace', 'update', 'forge'],
      ['plugin', 'update', 'forge@forge'],
    ]);
    assert.equal(out.kind, 'plugin');
    assert.equal(out.from, '0.1.0');
    assert.equal(out.to, '0.2.0');
    assert.equal(out.updated, true);
    assert.equal(out.newRoot, next);
    assert.ok(out.next.length > 0);
    assert.ok(out.next.some((h: string) => /new Claude Code session/.test(h)), out.next.join('\n'));
    assert.ok(out.next.some((h: string) => /forge migrate/.test(h)));
    assert.equal(out.dashboard, undefined);
  } finally {
    s.cleanup();
  }
});

test('AC5: a failing step stops the update', POSIX, async () => {
  const s = scratch();
  try {
    const stub = stubClaude(s.dir);
    const { root, installed } = pluginInstall(s.dir);
    await assert.rejects(
      updateForge({ root, cwd: s.dir, env: stubEnv(stub, { STUB_MKT_FAIL: '1', STUB_INSTALLED: installed }) }),
      (e: Error) => {
        assert.match(e.message, /"claude plugin marketplace update forge" failed \(exit 3\)/);
        assert.match(e.message, /boom: marketplace unreachable/);
        return true;
      },
    );
    assert.deepEqual(stub.calls(), [['plugin', 'marketplace', 'update', 'forge']]);

    const empty = path.join(s.dir, 'empty-bin');
    fs.mkdirSync(empty);
    const env = { ...stubEnv(stub), PATH: empty };
    await assert.rejects(updateForge({ root, cwd: s.dir, env }), (e: Error) => {
      assert.match(e.message, /claude is not on PATH/);
      assert.match(e.message, /\/plugin marketplace update forge/);
      assert.match(e.message, /\/plugin update forge@forge/);
      return true;
    });
  } finally {
    s.cleanup();
  }
});

test('AC6: names that could be options are refused', POSIX, async () => {
  const s = scratch();
  try {
    const stub = stubClaude(s.dir);
    const { root } = pluginInstall(s.dir, { marketplace: '-x' });
    const env = stubEnv(stub);
    const out: any = await updateForge({ root, cwd: s.dir, env, check: true });
    assert.equal(out.kind, 'unknown');
    assert.ok(out.blocked, 'blocked is set');
    assert.deepEqual(out.commands, []);
    await assert.rejects(updateForge({ root, cwd: s.dir, env }), /not safe/);

    // A marketplace clone's plugin.json name is checked the same way.
    const pluginsDir = path.join(s.dir, 'plugins');
    writeJson(path.join(pluginsDir, 'known_marketplaces.json'), {});
    const mkt = path.join(pluginsDir, 'marketplaces', 'forge');
    writeJson(path.join(mkt, 'package.json'), { version: '0.1.0' });
    writeJson(path.join(mkt, '.claude-plugin', 'plugin.json'), { name: '--plugin-dir=/tmp/evil' });
    assert.equal(detectInstall(mkt).kind, 'unknown');
    await assert.rejects(updateForge({ root: mkt, cwd: s.dir, env }), /not safe/);
    assert.deepEqual(stub.calls(), []);
  } finally {
    s.cleanup();
  }
});

test('AC7: git clone fast-forwards to its upstream', async () => {
  const s = scratch();
  try {
    const g = gitFixture(s.dir);
    const clone = g.clone('clone');
    const check: any = await updateForge({ root: clone, cwd: s.dir, check: true });
    assert.equal(check.kind, 'git');
    assert.equal(check.branch, 'main');
    assert.equal(check.upstream, 'origin/main');
    assert.deepEqual(check.commands, [`git -C ${clone} pull --ff-only`]);
    assert.equal(check.blocked, undefined);

    g.bump('0.2.0');
    const out: any = await updateForge({ root: clone, cwd: s.dir });
    assert.equal(out.kind, 'git');
    assert.equal(out.from, '0.1.0');
    assert.equal(out.to, '0.2.0');
    assert.equal(out.updated, true);
    assert.notEqual(out.head.from, out.head.to);
    assert.equal(out.newRoot, undefined);
    assert.equal(g.head(clone), g.git(g.remote, 'rev-parse', 'main'));
    assert.ok(!out.next.some((h: string) => /new Claude Code session/.test(h)), 'no plugin hint for a clone');

    const again: any = await updateForge({ root: clone, cwd: s.dir });
    assert.equal(again.updated, false);
    assert.deepEqual(again.next, []);
  } finally {
    s.cleanup();
  }
});

test('AC8: git refusals leave the checkout untouched', async () => {
  const s = scratch();
  try {
    const g = gitFixture(s.dir);
    const dirty = g.clone('dirty');
    const detached = g.clone('detached');
    const noUpstream = g.clone('no-upstream');
    const diverged = g.clone('diverged');
    g.bump('0.2.0');

    const pkg = path.join(dirty, 'package.json');
    fs.writeFileSync(pkg, 'local edit\n');
    let before = g.head(dirty);
    const check: any = await updateForge({ root: dirty, cwd: s.dir, check: true });
    assert.match(check.blocked, /uncommitted changes in .*; commit or stash them, then run forge update again/);
    await assert.rejects(updateForge({ root: dirty, cwd: s.dir }), /uncommitted changes in /);
    assert.equal(fs.readFileSync(pkg, 'utf8'), 'local edit\n');
    assert.equal(g.head(dirty), before);

    g.git(detached, 'checkout', '-q', '--detach');
    before = g.head(detached);
    await assert.rejects(updateForge({ root: detached, cwd: s.dir }), /detached/);
    assert.equal(g.head(detached), before);

    g.git(noUpstream, 'checkout', '-q', '-b', 'local');
    before = g.head(noUpstream);
    await assert.rejects(updateForge({ root: noUpstream, cwd: s.dir }), /no upstream/);
    assert.equal(g.head(noUpstream), before);

    fs.writeFileSync(path.join(diverged, 'local.txt'), 'mine\n');
    g.git(diverged, 'add', '-A');
    g.git(diverged, 'commit', '-qm', 'local work');
    before = g.head(diverged);
    await assert.rejects(updateForge({ root: diverged, cwd: s.dir }), (e: Error) => {
      assert.match(e.message, /pull --ff-only" failed \(exit \d+\)/);
      assert.match(e.message, /fast-forward/i);
      return true;
    });
    assert.equal(g.head(diverged), before);
    assert.equal(g.git(diverged, 'status', '--porcelain'), '');
  } finally {
    s.cleanup();
  }
});

test('AC9: unknown install fails with manual instructions', async () => {
  const s = scratch();
  try {
    const root = path.join(s.dir, 'forge');
    writeJson(path.join(root, 'package.json'), { version: '0.1.0' });
    assert.equal(detectInstall(root).kind, 'unknown');
    const check: any = await updateForge({ root, cwd: s.dir, check: true });
    assert.equal(check.kind, 'unknown');
    assert.ok(check.blocked);
    await assert.rejects(updateForge({ root, cwd: s.dir }), (e: Error) => {
      assert.match(e.message, /\/plugin update forge@forge/);
      assert.match(e.message, /git pull/);
      return true;
    });
  } finally {
    s.cleanup();
  }
});

test("AC10: restarts this repo's dashboard on the new code unless --keep-dash", POSIX, async () => {
  const s = scratch();
  const repo = tempRepo();
  try {
    const stub = stubClaude(s.dir);
    const { root, installed } = pluginInstall(s.dir);
    writeJson(path.join(repo.dir, '.forge', 'runtime', 'dashboard.json'), { pid: process.pid, url: 'http://127.0.0.1:7400' });
    const next = newInstall(path.join(s.dir, 'plugins', 'cache', 'forge', 'forge', '0.2.0'), '0.2.0');
    const forgeLog = path.join(s.dir, 'forge.log');
    const forgeCalls = () => (fs.existsSync(forgeLog) ? fs.readFileSync(forgeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    const env = (installPath: string) => stubEnv(stub, { STUB_INSTALLED: installed, STUB_INSTALL_PATH: installPath, STUB_FORGE_LOG: forgeLog });

    const check: any = await updateForge({ root, cwd: repo.dir, env: env(next), check: true });
    assert.deepEqual(check.dashboard, { running: true, url: 'http://127.0.0.1:7400' });

    const out: any = await updateForge({ root, cwd: repo.dir, env: env(next) });
    assert.equal(out.updated, true);
    assert.deepEqual(forgeCalls(), [
      { argv: ['dash', '--stop'], cwd: repo.dir },
      { argv: ['dash', '--background'], cwd: repo.dir },
    ]);
    assert.deepEqual(out.dashboard, { restarted: true, url: 'http://127.0.0.1:7401' });
    assert.equal(out.warnings, undefined);
    fs.rmSync(forgeLog);

    const kept: any = await updateForge({ root, cwd: repo.dir, env: env(next), keepDash: true });
    assert.equal(kept.updated, true);
    assert.deepEqual(forgeCalls(), []);
    assert.deepEqual(kept.dashboard, { running: true, stale: true, url: 'http://127.0.0.1:7400' });
    assert.ok(kept.next.some((h: string) => h.includes('forge dash --stop && forge dash --background') && h.includes(repo.dir)), kept.next.join('\n'));

    const same = newInstall(path.join(s.dir, 'plugins', 'cache', 'forge', 'forge', 'same'), '0.1.0');
    const unchanged: any = await updateForge({ root, cwd: repo.dir, env: env(same) });
    assert.equal(unchanged.updated, false);
    assert.deepEqual(forgeCalls(), []);
    assert.equal(unchanged.dashboard, undefined);
    assert.deepEqual(unchanged.next, []);

    // A restart that fails leaves the update standing: a warning and a stale dashboard.
    fs.writeFileSync(path.join(next, 'bin', 'forge'), 'process.stderr.write("no dash here\\n"); process.exit(4);\n');
    const failed: any = await updateForge({ root, cwd: repo.dir, env: env(next) });
    assert.equal(failed.updated, true);
    assert.deepEqual(failed.dashboard, { running: true, stale: true, url: 'http://127.0.0.1:7400' });
    assert.ok(failed.warnings.some((w: string) => /forge dash --stop" \(exit 4\): no dash here/.test(w)), failed.warnings.join('\n'));
  } finally {
    repo.cleanup();
    s.cleanup();
  }
});

test('AC11: warns about a shadowing global npm copy', POSIX, async () => {
  const s = scratch();
  try {
    const stub = stubClaude(s.dir);
    const { root } = pluginInstall(s.dir);
    const npmCopy = path.join(s.dir, 'lib', 'node_modules', '@maxwellmattryan', 'forge', 'bin', 'forge');
    fs.mkdirSync(path.dirname(npmCopy), { recursive: true });
    fs.writeFileSync(npmCopy, '#!/usr/bin/env node\n');
    fs.chmodSync(npmCopy, 0o755);
    const globalBin = path.join(s.dir, 'global-bin');
    fs.mkdirSync(globalBin);
    fs.symlinkSync(npmCopy, path.join(globalBin, 'forge'));

    const shadowed: any = await updateForge({ root, cwd: s.dir, check: true, env: { ...stubEnv(stub), PATH: [globalBin, stub.dir].join(path.delimiter) } });
    assert.equal(shadowed.warnings.length, 1);
    assert.ok(shadowed.warnings[0].includes(path.join(globalBin, 'forge')));
    assert.match(shadowed.warnings[0], /npm uninstall -g @maxwellmattryan\/forge/);
    assert.ok(fs.existsSync(npmCopy), 'nothing is deleted');

    const own = path.join(root, 'bin', 'forge');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, '#!/usr/bin/env node\n');
    fs.chmodSync(own, 0o755);
    const clean: any = await updateForge({ root, cwd: s.dir, check: true, env: { ...stubEnv(stub), PATH: [path.dirname(own), globalBin].join(path.delimiter) } });
    assert.equal(clean.warnings, undefined);
  } finally {
    s.cleanup();
  }
});

test('AC12: help lists update', () => {
  const s = scratch();
  try {
    const r = cli(['help'], { cwd: s.dir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /forge update \[--check\] \[--keep-dash\]/);
    const update = cli(['help', 'update'], { cwd: s.dir });
    assert.equal(update.status, 0);
    assert.match(update.stdout, /native Windows/, 'exit 1 covers native Windows');
  } finally {
    s.cleanup();
  }
  const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8');
  assert.match(read('README.md'), /\| `forge update/);
  assert.match(read('docs/ARCHITECTURE.md'), /^## Updating$/m);
  const skill = read('skills/forge/SKILL.md');
  assert.match(skill.match(/^argument-hint:.*$/m)?.[0] ?? '', /\bupdate\b/);
  assert.match(skill, /^\| `update` \|/m);
});
