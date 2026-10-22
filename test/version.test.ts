import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { forgeAsync, tempRepo } from './helpers.ts';
import { DEPRECATED_CONFIG_KEYS, deprecationChecks } from '../lib/core/config/deprecations.ts';
import type { DeprecatedKey } from '../lib/core/config/deprecations.ts';
import { detectInstall } from '../lib/engine/ops/update.ts';
import { latestReleaseCheck, readCommitFile, releaseRepo, versionInfo } from '../lib/engine/ops/version.ts';

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

// ---- forge doctor: the latest-release row and deprecated config keys.

/**
 * A `gh` that logs its argv (one argument per line) and then runs `body`. The PATH puts it before
 * any real gh, so no test ever reaches GitHub.
 */
function stubGh(dir: string, body: string): { env: NodeJS.ProcessEnv; log: string } {
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'gh-argv.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n${body}\n`, { mode: 0o755 });
  return { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, log };
}

const ghPrints = (json: string) => `printf '%s\\n' '${json}'`;

/** An unknown install (no git, no plugin layout) whose plugin.json names `repository`. */
function releaseRoot(dir: string, version: string, repository: unknown = 'https://github.com/acme/forge.git/'): string {
  const root = path.join(dir, 'install');
  writeJson(path.join(root, 'package.json'), { name: 'forge', version });
  writeJson(path.join(root, '.claude-plugin', 'plugin.json'), { name: 'forge', version, repository });
  return root;
}

test('latest release: behind, equal, ahead', POSIX, () => {
  const s = scratch();
  try {
    const root = releaseRoot(s.dir, '1.2.3');
    const behind = latestReleaseCheck({ root, env: stubGh(s.dir, ghPrints('{"tagName":"v99.0.0"}')).env });
    assert.equal(behind?.name, 'forge release');
    assert.equal(behind?.ok, true);
    assert.equal(behind?.warn, true);
    assert.match(behind?.detail ?? '', /v99\.0\.0/);
    assert.match(behind?.detail ?? '', /forge update/);
    assert.equal(behind?.detail, '1.2.3 is behind the latest release v99.0.0: run forge update');

    const equal = latestReleaseCheck({ root, env: stubGh(s.dir, ghPrints('{"tagName":"v1.2.3"}')).env });
    assert.deepEqual(equal, { name: 'forge release', ok: true, detail: '1.2.3 is the latest release' });
    assert.deepEqual(latestReleaseCheck({ root, env: stubGh(s.dir, ghPrints('{"tagName":"1.2.3"}')).env }), equal, 'the v is optional');

    const ahead = latestReleaseCheck({ root, env: stubGh(s.dir, ghPrints('{"tagName":"v0.0.1"}')).env });
    assert.deepEqual(ahead, { name: 'forge release', ok: true, detail: '1.2.3 is newer than the latest release v0.0.1' });
    assert.equal(latestReleaseCheck({ root, env: stubGh(s.dir, ghPrints('{"tagName":"v1.10.0"}')).env })?.warn, true, 'compared as numbers, not strings');
  } finally {
    s.cleanup();
  }
});

test('latest release: skipped silently', POSIX, () => {
  const s = scratch();
  try {
    const root = releaseRoot(s.dir, '1.2.3');
    const empty = path.join(s.dir, 'empty-bin');
    fs.mkdirSync(empty);
    assert.equal(latestReleaseCheck({ root, env: { ...process.env, PATH: empty } }), null, 'no gh on PATH');
    assert.equal(latestReleaseCheck({ root, env: stubGh(s.dir, 'echo "HTTP 404: release not found" >&2; exit 1').env }), null, 'gh exits 1');
    assert.equal(latestReleaseCheck({ root, env: stubGh(s.dir, "echo 'not json'").env }), null, 'non-JSON');
    assert.equal(latestReleaseCheck({ root, env: stubGh(s.dir, ghPrints('{"name":"x"}')).env }), null, 'no tagName');
    for (const tag of ['v1.2', 'v1.2.3-rc.1', 'v1.2.3\\nrelease=true', '<b>v9.9.9</b>']) {
      assert.equal(latestReleaseCheck({ root, env: stubGh(s.dir, ghPrints(`{"tagName":"${tag}"}`)).env }), null, tag);
    }
    // exec: sleep itself is the child, so the timeout's SIGTERM ends it and closes stdout.
    const slow = stubGh(s.dir, 'exec sleep 5');
    const t0 = Date.now();
    assert.equal(latestReleaseCheck({ root, env: slow.env, timeoutMs: 300 }), null, 'timeout');
    assert.ok(Date.now() - t0 < 1300, `returned after ${Date.now() - t0} ms`);
    assert.equal(latestReleaseCheck({ root: releaseRoot(s.dir, '1.2'), env: stubGh(s.dir, ghPrints('{"tagName":"v9.0.0"}')).env }), null, 'running version not X.Y.Z');
  } finally {
    s.cleanup();
  }
});

test('latest release: repo is validated before it reaches gh', POSIX, () => {
  const s = scratch();
  try {
    const argv = (root: string): string[] | null => {
      const stub = stubGh(s.dir, ghPrints('{"tagName":"v1.2.3"}'));
      fs.rmSync(stub.log, { force: true });
      latestReleaseCheck({ root, env: stub.env });
      return fs.existsSync(stub.log) ? fs.readFileSync(stub.log, 'utf8').trimEnd().split('\n') : null;
    };
    const expected = (repo: string) => ['release', 'view', '--repo', repo, '--json', 'tagName'];

    // From the install's plugin.json: repository (a string or {url}), then homepage.
    assert.deepEqual(argv(releaseRoot(s.dir, '1.2.3', 'https://github.com/acme/forge')), expected('acme/forge'));
    assert.deepEqual(argv(releaseRoot(s.dir, '1.2.3', 'https://github.com/acme/forge.git/')), expected('acme/forge'));
    assert.deepEqual(argv(releaseRoot(s.dir, '1.2.3', { type: 'git', url: 'https://github.com/acme/my.repo.git' })), expected('acme/my.repo'));
    const homepageOnly = releaseRoot(s.dir, '1.2.3', undefined);
    writeJson(path.join(homepageOnly, '.claude-plugin', 'plugin.json'), { name: 'forge', homepage: 'https://github.com/acme/home/' });
    assert.deepEqual(argv(homepageOnly), expected('acme/home'));

    // From known_marketplaces.json for a plugin install.
    const { root: pluginRoot, pluginsDir } = pluginLayout(s.dir, { version: 2, plugins: {} });
    const marketplace = (source: unknown) => writeJson(path.join(pluginsDir, 'known_marketplaces.json'), { forge: { source } });
    marketplace({ source: 'github', repo: 'acme/market' });
    assert.deepEqual(argv(pluginRoot), expected('acme/market'));

    const hostile = ['-x/y', '--upload-pack=evil/x', 'https://gitlab.com/a/b', 'a/b/c', 'a b/c'];
    for (const repo of hostile) {
      marketplace({ source: 'github', repo });
      assert.equal(argv(pluginRoot), null, `marketplace repo ${JSON.stringify(repo)} never reaches gh`);
      const url = repo.startsWith('https://') ? repo : `https://github.com/${repo}`;
      assert.equal(argv(releaseRoot(s.dir, '1.2.3', url)), null, `plugin.json ${JSON.stringify(url)} never reaches gh`);
    }
    marketplace({ source: 'github', repo: 42 });
    assert.equal(argv(pluginRoot), null, 'a non-string repo');

    // A long hostile URL is rejected in linear time.
    const long = releaseRoot(s.dir, '1.2.3', `https://github.com/a/${'b.git'.repeat(2000)}/x`);
    const t0 = Date.now();
    assert.equal(releaseRepo(long, detectInstall(long)), null);
    assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  } finally {
    s.cleanup();
  }
});

test('forge doctor reports a newer release', POSIX, async () => {
  const repo = tempRepo();
  const s = scratch();
  try {
    const stub = stubGh(s.dir, ghPrints('{"tagName":"v99.0.0"}'));
    const r = await forgeAsync(repo.dir, ['doctor'], { PATH: stub.env.PATH });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    const row = report.checks.find((c: { name: string }) => c.name === 'forge release');
    assert.ok(row, r.stdout);
    assert.equal(row.ok, true);
    assert.equal(row.warn, true);
    assert.match(row.detail, /behind the latest release v99\.0\.0: run forge update/);
    assert.equal(report.ok, report.checks.every((c: { ok: boolean }) => c.ok), 'ok comes from failing checks only');
    // Doctor's own `gh auth status` comes first; the release call is the last one.
    assert.deepEqual(fs.readFileSync(stub.log, 'utf8').trimEnd().split('\n').slice(-6), ['release', 'view', '--repo', 'maxwellmattryan/forge', '--json', 'tagName']);
  } finally {
    repo.cleanup();
    s.cleanup();
  }
});

/** What the registry promises: semver releases, a minor's notice, and a docs entry. */
function registryProblems(registry: readonly DeprecatedKey[], docs: string): string[] {
  const problems: string[] = [];
  const section = /^## Deprecated keys\n([\s\S]*?)(?=^## )/m.exec(docs)?.[1];
  if (section === undefined) return ['docs/CONFIG.md has no "## Deprecated keys" section'];
  const ver = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  for (const d of registry) {
    const since = ver(d.since);
    const removeIn = ver(d.removeIn);
    if (!since) problems.push(`${d.key}: since ${d.since} is not X.Y.Z`);
    if (!removeIn) problems.push(`${d.key}: removeIn ${d.removeIn} is not X.Y.Z`);
    if (since && removeIn && !(removeIn[0] > since[0] || (removeIn[0] === since[0] && removeIn[1] > since[1]))) problems.push(`${d.key}: removeIn ${d.removeIn} is not at least one minor after ${d.since}`);
    if (!section.includes(`\`${d.key}\``)) problems.push(`${d.key}: not listed in docs/CONFIG.md "Deprecated keys"`);
  }
  if (!registry.length && !section.includes('None today.')) problems.push('an empty registry reads "None today."');
  return problems;
}

test('deprecated config keys', () => {
  assert.deepEqual(DEPRECATED_CONFIG_KEYS, [], 'empty today');
  const docs = fs.readFileSync(path.join(REPO, 'docs', 'CONFIG.md'), 'utf8');
  assert.deepEqual(registryProblems(DEPRECATED_CONFIG_KEYS, docs), []);

  const old: DeprecatedKey = { key: 'pipeline.oldKnob', since: '0.18.0', removeIn: '0.19.0', replacement: 'pipeline.newKnob', note: '' };
  const gone: DeprecatedKey = { key: 'daemon.legacy', since: '0.18.0', removeIn: '1.0.0', replacement: null, note: 'delete it; the daemon always does this now' };
  const yaml = 'pipeline:\n  oldKnob: true\ndaemon:\n  legacy: false\nreview:\n  blockOn: [blocker]\n';
  assert.deepEqual(deprecationChecks(yaml, [old, gone]), [
    { name: 'deprecated config key pipeline.oldKnob', ok: true, warn: true, detail: 'deprecated in 0.18.0, removed in 0.19.0; use pipeline.newKnob' },
    { name: 'deprecated config key daemon.legacy', ok: true, warn: true, detail: 'deprecated in 0.18.0, removed in 1.0.0; delete it; the daemon always does this now' },
  ]);
  assert.deepEqual(deprecationChecks('pipeline:\n  plan: auto\n', [old, gone]), [], 'absent keys');
  assert.deepEqual(deprecationChecks(yaml, []), [], 'an empty registry');
  assert.deepEqual(deprecationChecks(yaml), [], 'the real registry');
  assert.deepEqual(deprecationChecks('pipeline: [unclosed\n  : :\n\t- x', [old]), [], 'unparsable YAML');
  assert.deepEqual(deprecationChecks('', [old]), [], 'an empty file');

  // The shape check catches each broken entry.
  const listed = '## Deprecated keys\n\n`pipeline.oldKnob`\n\n## Next\n';
  assert.deepEqual(registryProblems([old], listed), []);
  assert.equal(registryProblems([{ ...old, since: '0.18' }], listed).length, 1);
  assert.equal(registryProblems([{ ...old, removeIn: '0.18.5' }], listed).length, 1);
  assert.equal(registryProblems([old], '## Deprecated keys\n\nNone today.\n\n## Next\n').length, 1);
  assert.equal(registryProblems([], '# nothing\n').length, 1);
});
