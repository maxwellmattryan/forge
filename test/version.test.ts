import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { readCommitFile, versionInfo } from '../lib/version.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const BIN = path.join(REPO, 'bin', 'forge');
const POSIX = { skip: process.platform === 'win32' && 'stub executables, git archive and PATH lookup are POSIX-only' };

const SHA_A = 'a'.repeat(40);
const SHA_B = '0123456789abcdef0123456789abcdef01234567';

function scratch(): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-version-')));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

/** The two files every install has: enough for detectInstall to read a version and a name. */
function installFiles(root: string, version = '1.2.3'): void {
  writeJson(path.join(root, 'package.json'), { name: 'forge', version });
  writeJson(path.join(root, '.claude-plugin', 'plugin.json'), { name: 'forge', version });
}

/** `<tmp>/plugins/cache/forge/forge/1.2.3` with `installed_plugins.json` beside `cache/`. */
function pluginLayout(tmp: string, entries: unknown): { root: string; pluginsDir: string } {
  const pluginsDir = path.join(tmp, 'plugins');
  const root = path.join(pluginsDir, 'cache', 'forge', 'forge', '1.2.3');
  installFiles(root);
  if (typeof entries === 'string') fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), entries);
  else writeJson(path.join(pluginsDir, 'installed_plugins.json'), entries);
  return { root, pluginsDir };
}

const cli = (args: string[], cwd = os.tmpdir()) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: '' } });

test('plain forge version is unchanged', () => {
  const r = cli(['version']);
  assert.equal(r.status, 0, r.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(r.stdout, `${JSON.stringify({ version: pkg.version })}\n`);
});

test('--json in a clone', POSIX, () => {
  const r = cli(['version', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(v).sort(), ['commit', 'installedAs', 'node', 'version']);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(v.version, pkg.version);
  assert.equal(v.commit, execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.equal(v.installedAs, 'clone');
  assert.equal(v.node, process.versions.node);
});

test('COMMIT file contract', POSIX, () => {
  const repo = tempRepo();
  try {
    installFiles(repo.dir);
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'install');
    const head = repo.git('rev-parse', 'HEAD').toString().trim();
    const file = path.join(repo.dir, 'COMMIT');

    fs.writeFileSync(file, `${SHA_A}\n`);
    assert.equal(readCommitFile(repo.dir), SHA_A);
    assert.deepEqual(versionInfo(repo.dir), { version: '1.2.3', commit: SHA_A, installedAs: 'clone', node: process.versions.node });
    fs.writeFileSync(file, SHA_A);
    assert.equal(versionInfo(repo.dir).commit, SHA_A, 'the trailing newline is optional');

    const ignored: [string, string][] = [
      ['the placeholder', '$Format:%H$\n'],
      ['39 hex characters', `${'a'.repeat(39)}\n`],
      ['uppercase hex', `${SHA_A.toUpperCase()}\n`],
      ['two lines', `${SHA_A}\n${SHA_B}\n`],
      ['trailing text', `${SHA_A} main\n`],
      ['a blank line after', `${SHA_A}\n\n`],
      ['over 64 bytes', `${SHA_A}\n${' '.repeat(30)}`],
    ];
    for (const [what, content] of ignored) {
      fs.writeFileSync(file, content);
      assert.equal(readCommitFile(repo.dir), null, what);
      assert.equal(versionInfo(repo.dir).commit, head, `${what} falls through to git`);
    }
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.equal(readCommitFile(repo.dir), null, 'a directory');
    assert.equal(versionInfo(repo.dir).commit, head);
    fs.rmSync(file, { recursive: true });
    const target = path.join(repo.dir, 'elsewhere');
    fs.writeFileSync(target, `${SHA_A}\n`);
    fs.symlinkSync(target, file);
    assert.equal(readCommitFile(repo.dir), null, 'a symlink');
  } finally {
    repo.cleanup();
  }

  // Over the plugin record, too.
  const s = scratch();
  try {
    const { root } = pluginLayout(s.dir, { version: 2, plugins: { 'forge@forge': [{ installPath: path.join(s.dir, 'plugins', 'cache', 'forge', 'forge', '1.2.3'), gitCommitSha: SHA_B }] } });
    fs.writeFileSync(path.join(root, 'COMMIT'), `${SHA_A}\n`);
    assert.equal(versionInfo(root).commit, SHA_A);
  } finally {
    s.cleanup();
  }
});

test('plugin install reads gitCommitSha', POSIX, () => {
  const s = scratch();
  try {
    const root = path.join(s.dir, 'plugins', 'cache', 'forge', 'forge', '1.2.3');
    const record = (entries: unknown) => ({ version: 2, plugins: { 'forge@forge': entries } });
    pluginLayout(s.dir, record([{ scope: 'user', installPath: path.join(s.dir, 'plugins', 'cache', 'forge', 'forge', '0.9.0'), gitCommitSha: SHA_A }, { scope: 'user', installPath: root, gitCommitSha: SHA_B }]));
    assert.deepEqual(versionInfo(root), { version: '1.2.3', commit: SHA_B, installedAs: 'plugin', node: process.versions.node });
    fs.writeFileSync(path.join(root, 'COMMIT'), '$Format:%H$\n');
    assert.equal(versionInfo(root).commit, SHA_B, 'the placeholder falls through to the record');

    const missing: [string, unknown][] = [
      ['no entry', { version: 2, plugins: {} }],
      ['no plugins key', { version: 2 }],
      ['another installPath', record([{ installPath: path.join(s.dir, 'elsewhere'), gitCommitSha: SHA_B }])],
      ['a short sha', record([{ installPath: root, gitCommitSha: 'abc123' }])],
      ['a non-string sha', record([{ installPath: root, gitCommitSha: 42 }])],
      ['entries that are not objects', record(['x', null, 3])],
      ['malformed JSON', '{"plugins":'],
    ];
    for (const [what, data] of missing) {
      pluginLayout(s.dir, data);
      const v = versionInfo(root);
      assert.equal(v.installedAs, 'plugin', what);
      assert.equal(v.commit, null, what);
    }
  } finally {
    s.cleanup();
  }
});

test('unknown install has no commit', () => {
  const s = scratch();
  try {
    installFiles(s.dir);
    assert.deepEqual(versionInfo(s.dir), { version: '1.2.3', commit: null, installedAs: 'unknown', node: process.versions.node });
  } finally {
    s.cleanup();
  }
});

test('git archive stamps COMMIT', POSIX, () => {
  assert.equal(fs.readFileSync(path.join(REPO, 'COMMIT'), 'utf8'), '$Format:%H$\n');
  assert.ok(fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8').split('\n').includes('COMMIT export-subst'));

  const repo = tempRepo();
  const out = scratch();
  try {
    installFiles(repo.dir);
    fs.copyFileSync(path.join(REPO, 'COMMIT'), path.join(repo.dir, 'COMMIT'));
    fs.copyFileSync(path.join(REPO, '.gitattributes'), path.join(repo.dir, '.gitattributes'));
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'stamp');
    const head = repo.git('rev-parse', 'HEAD').toString().trim();
    const tar = path.join(out.dir, 'forge.tar');
    repo.git('archive', '--format=tar', '-o', tar, 'HEAD');
    const extracted = path.join(out.dir, 'forge');
    fs.mkdirSync(extracted);
    execFileSync('tar', ['-xf', tar, '-C', extracted]);
    assert.equal(fs.readFileSync(path.join(extracted, 'COMMIT'), 'utf8'), `${head}\n`);
    assert.deepEqual(versionInfo(extracted), { version: '1.2.3', commit: head, installedAs: 'unknown', node: process.versions.node });
  } finally {
    repo.cleanup();
    out.cleanup();
  }
});
