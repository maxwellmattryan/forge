// The release writers (lib/interim.ts): what verify writes into a consumer's manifests once its
// dependency's release is recorded, and the lockfile argv. Table-driven, then each released fixture
// goes through the seeded release-gate script with plain node, so it runs on every platform.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { BLOCK_BEGIN, BLOCK_END, lockfileArgv, npmReleaseSpec, pinCargo, pinCmake, pinNpm, releaseCargo, releaseCmake, releaseNpm } from '../lib/interim.ts';
import { PLUGIN_ROOT } from '../lib/paths.ts';
import { scratchGitConfig } from './helpers.ts';

const SCRIPT = path.join(PLUGIN_ROOT, 'templates', 'release-gate', 'release-gate.mjs');
const SHA = 'a'.repeat(40);
const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const ok = (r: { text: string } | { error: string }): string => {
  if ('error' in r) throw new Error(r.error);
  return r.text;
};
const err = (r: { text: string } | { error: string }): string => {
  assert.ok('error' in r, `expected an error, got ${JSON.stringify(r)}`);
  return r.error;
};
const pin = (name = 'engine-core') => ({ source: 'crates-io', name, git: 'https://example.com/lib.git', rev: SHA });

/** The seeded gate script over `files`, committed in a scratch repo. */
function gate(files: Record<string, string>): { status: number | null; out: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-relwriters-')));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  scratchGitConfig(git);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git('add', '-A');
  git('commit', '-qm', 'manifests');
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

const PKG = 'name = "app"\nversion = "0.1.0"\n';

describe('interim release writers', { concurrency: 4 }, () => {
  test('pinCargo with no pins removes the block', () => {
    const base = `[package]\n${PKG}\n[dependencies]\nengine-core = "1.2.0"\n`;
    const pinned = ok(pinCargo(base, [pin()]));
    assert.ok(pinned.includes(BLOCK_BEGIN));
    assert.equal(ok(pinCargo(pinned, [])), base, 'the block and the blank line before it go');
    assert.equal(ok(pinCargo(base, [])), base, 'no block: unchanged');
    // A block in the middle of the file loses only its own lines.
    const middle = `[package]\n${PKG}\n${BLOCK_BEGIN}\n[patch."crates-io"]\n"x" = { git = "g", rev = "${SHA}" }\n${BLOCK_END}\n\n[dependencies]\nx = "1"\n`;
    assert.equal(ok(pinCargo(middle, [])), `[package]\n${PKG}\n\n[dependencies]\nx = "1"\n`);
    const crlf = base.replace(/\n/g, '\r\n');
    assert.equal(ok(pinCargo(ok(pinCargo(crlf, [pin()])), [])), crlf, 'CRLF kept');
    assert.match(err(pinCargo(`${BLOCK_BEGIN}\n`, [])), /broken or repeated/);
  });

  test('releaseCargo sets the requirement in every dependency table', () => {
    const cases: [string, string, string, string][] = [
      ['string', '[dependencies]\nengine-core = "1.0.0"\n', '1.2.0', '[dependencies]\nengine-core = "1.2.0"\n'],
      ['literal string', "[dependencies]\nengine-core = '1.0'\n", '1.2.0', "[dependencies]\nengine-core = '1.2.0'\n"],
      ['quoted key', '[dependencies]\n"engine-core" = "1"\n', '1.2.0', '[dependencies]\n"engine-core" = "1.2.0"\n'],
      ['= kept', '[dependencies]\nengine-core = "=1.0.0"\n', '1.2.0', '[dependencies]\nengine-core = "=1.2.0"\n'],
      ['^ kept', '[dependencies]\nengine-core = "^1"\n', '1.2.0', '[dependencies]\nengine-core = "^1.2.0"\n'],
      ['~ kept', '[dependencies]\nengine-core = "~1.0"\n', '1.2.0', '[dependencies]\nengine-core = "~1.2.0"\n'],
      ['v and +build stripped', '[dependencies]\nengine-core = "1"\n', 'v1.2.0+build.5', '[dependencies]\nengine-core = "1.2.0"\n'],
      ['prerelease kept', '[dependencies]\nengine-core = "1"\n', '1.2.0-rc.1', '[dependencies]\nengine-core = "1.2.0-rc.1"\n'],
      [
        'inline table',
        '[dependencies]\nengine-core = { version = "1.0", features = ["a", "b"], path = "../e" } # local\n',
        '1.2.0',
        '[dependencies]\nengine-core = { version = "1.2.0", features = ["a", "b"], path = "../e" } # local\n',
      ],
      ['inline table, version later', '[dependencies]\nengine-core = { path = "../e", version = "^1" }\n', '1.2.0', '[dependencies]\nengine-core = { path = "../e", version = "^1.2.0" }\n'],
      ['subtable', '[dependencies.engine-core]\nversion = "1.0"\nfeatures = ["x"]\n', '1.2.0', '[dependencies.engine-core]\nversion = "1.2.0"\nfeatures = ["x"]\n'],
      [
        'every table kind',
        '[dependencies]\nengine-core = "1"\n\n[dev-dependencies]\nengine-core = "1"\n\n[build-dependencies]\nengine-core = { version = "1" }\n\n[workspace.dependencies]\nengine-core = "1"\n\n[target.\'cfg(unix)\'.dependencies]\nengine-core = "1"\n\n[target."cfg(windows)".dev-dependencies.engine-core]\nversion = "1"\n',
        '1.2.0',
        '[dependencies]\nengine-core = "1.2.0"\n\n[dev-dependencies]\nengine-core = "1.2.0"\n\n[build-dependencies]\nengine-core = { version = "1.2.0" }\n\n[workspace.dependencies]\nengine-core = "1.2.0"\n\n[target.\'cfg(unix)\'.dependencies]\nengine-core = "1.2.0"\n\n[target."cfg(windows)".dev-dependencies.engine-core]\nversion = "1.2.0"\n',
      ],
      ['workspace = true skipped', '[dependencies]\nengine-core = { workspace = true }\n\n[workspace.dependencies]\nengine-core = "1"\n', '1.2.0', '[dependencies]\nengine-core = { workspace = true }\n\n[workspace.dependencies]\nengine-core = "1.2.0"\n'],
      ['only workspace = true', '[dependencies]\nengine-core = { workspace = true }\n', '1.2.0', '[dependencies]\nengine-core = { workspace = true }\n'],
      ['other crates and tables untouched', '[package]\nversion = "0.1.0"\n\n[dependencies]\nengine = "1"\nengine-core-x = "1"\n\n[features]\nengine-core = []\n\n[dependencies]\nengine-core = "1"\n', '1.2.0', '[package]\nversion = "0.1.0"\n\n[dependencies]\nengine = "1"\nengine-core-x = "1"\n\n[features]\nengine-core = []\n\n[dependencies]\nengine-core = "1.2.0"\n'],
      ['CRLF kept', '[dependencies]\r\nengine-core = "1"\r\n', '1.2.0', '[dependencies]\r\nengine-core = "1.2.0"\r\n'],
    ];
    for (const [name, text, version, want] of cases) assert.equal(ok(releaseCargo(text, 'engine-core', version)), want, name);
    // The Forge block is skipped: pinCargo removes the crate from it.
    const pinned = ok(pinCargo('[dependencies]\nengine-core = "1"\n', [pin()]));
    assert.equal(ok(releaseCargo(pinned, 'engine-core', '1.2.0')), pinned.replace('engine-core = "1"', 'engine-core = "1.2.0"'), 'the [patch] entry inside the block stays');
  });

  test('releaseCargo refuses what it cannot rewrite', () => {
    const refusals: [string, string, RegExp][] = [
      ['multi-line inline table', '[dependencies]\nengine-core = {\n  version = "1",\n}\n', /multi-line inline table/],
      ['dotted version key', '[dependencies]\nengine-core.version = "1"\n', /dotted key/],
      ['no version', '[dependencies]\nengine-core = { git = "https://example.com/e.git" }\n', /has no version/],
      ['subtable with no version', '[dependencies.engine-core]\npath = "../e"\n\n[features]\n', /dependency table has no version/],
      ['no entry', '[dependencies]\nengine = "1"\n', /Cargo.toml has no dependency on engine-core/],
      ['renamed dependency', '[dependencies]\nlib = { package = "engine-core", version = "1" }\n', /no dependency on engine-core/],
      ['not a string', '[dependencies]\nengine-core = 1\n', /neither a version string nor an inline table/],
    ];
    for (const [name, text, re] of refusals) assert.match(err(releaseCargo(text, 'engine-core', '1.2.0')), re, name);
    for (const bad of ['1.2', '1.2.0-canary.abc', '-Zx', '1.2.0 && x']) assert.match(err(releaseCargo('[dependencies]\nengine-core = "1"\n', 'engine-core', bad)), /not a released version/, bad);
    const t = Date.now();
    releaseCargo(`[dependencies]\nengine-core = { ${'"'.repeat(10_000)} ${'{'.repeat(10_000)}\n[${'a.'.repeat(5_000)}`, 'engine-core', '1.2.0');
    assert.ok(Date.now() - t < 2000, 'a hostile line is parsed in linear time');
  });

  test('releaseCmake replaces the tag, kept as recorded', () => {
    const CMAKE = 'include(FetchContent)\nFetchContent_Declare(\n  engine\n  GIT_REPOSITORY https://example.com/engine.git\n  GIT_TAG v1.0.0\n)\n';
    const pinned = ok(pinCmake(CMAKE, 'Engine', SHA));
    assert.equal(ok(releaseCmake(pinned, 'engine', 'v1.2.0')), CMAKE.replace('v1.0.0', 'v1.2.0'));
    assert.equal(ok(releaseCmake(pinned, 'engine', '1.2.0')), CMAKE.replace('v1.0.0', '1.2.0'));
    assert.match(err(releaseCmake(CMAKE + CMAKE.slice(CMAKE.indexOf('FetchContent_Declare')), 'engine', 'v1.2.0')), /2 FetchContent_Declare\(engine …\) calls; the release needs exactly one/);
    assert.match(err(releaseCmake(CMAKE, 'engine', SHA)), /not a released version/);
    assert.match(err(pinCmake(CMAKE.replace('  GIT_TAG v1.0.0\n', ''), 'engine', SHA)), /0 GIT_TAG arguments; the pin needs exactly one with a value/, 'pin wording kept');
  });

  test('releaseNpm follows the per-section range rule', () => {
    const cases: [unknown, string, string][] = [
      ['^1.0.0', '1.2.0', '^1.2.0'],
      ['~1.0.0', 'v1.2.0', '~1.2.0'],
      ['1.0.0', '1.2.0+b', '1.2.0'],
      ['1.0.0-canary.0123456789ab', '1.2.0', '^1.2.0'],
      [`git+https://example.com/e.git#${SHA}`, '1.2.0', '^1.2.0'],
      ['file:../engine', '1.2.0', '^1.2.0'],
      ['latest', '1.2.0', '^1.2.0'],
      ['>=1.0.0', '1.2.0', '^1.2.0'],
      [7, '1.2.0', '^1.2.0'],
    ];
    for (const [old, version, want] of cases) assert.equal(npmReleaseSpec(old, version), want, String(old));
    const PKG_JSON = '{\n    "name": "app",\n    "dependencies": {\n        "engine": "1.0.0-canary.0123456789ab"\n    },\n    "devDependencies": {\n        "engine": "~1.0.0"\n    }\n}\n';
    assert.equal(ok(releaseNpm(PKG_JSON, 'engine', '1.2.0')), PKG_JSON.replace('1.0.0-canary.0123456789ab', '^1.2.0').replace('~1.0.0', '~1.2.0'), 'per section, indent kept');
    assert.match(err(releaseNpm(PKG_JSON, 'other', '1.2.0')), /no dependency on other/);
    assert.match(err(releaseNpm(PKG_JSON, 'engine', '1.2.0-canary.x')), /not a released version/);
  });

  test('round trip and the gate script', () => {
    const CARGO = `[package]\n${PKG}\n[dependencies]\nengine-core = "1.2.0"\n`;
    const CMAKE = 'include(FetchContent)\nFetchContent_Declare(\n  engine\n  GIT_REPOSITORY https://example.com/engine.git\n  GIT_TAG v1.2.0\n)\n';
    const JSON_PKG = '{\n  "name": "app",\n  "dependencies": {\n    "engine": "^1.2.0"\n  }\n}\n';
    const cargo = ok(releaseCargo(ok(pinCargo(ok(pinCargo(CARGO, [pin()])), [])), 'engine-core', '1.2.0'));
    assert.equal(cargo, CARGO, 'Cargo.toml: byte for byte');
    const cmake = ok(releaseCmake(ok(pinCmake(CMAKE, 'engine', SHA)), 'engine', 'v1.2.0'));
    assert.equal(cmake, CMAKE, 'CMakeLists.txt: byte for byte');
    const npm = ok(releaseNpm(ok(pinNpm(JSON_PKG, 'engine', `git+https://example.com/e.git#${SHA}`)), 'engine', '1.2.0'));
    assert.equal(npm, JSON_PKG, 'package.json: byte for byte');
    // Two crates pinned, one released: the other's pin stays and the gate still fails on it.
    const two = ok(pinCargo(`${CARGO}engine-macros = "1.2.0"\n`, [pin(), pin('engine-macros')]));
    const one = ok(releaseCargo(ok(pinCargo(two, [pin('engine-macros')])), 'engine-core', '1.2.0'));
    assert.ok(one.includes('"engine-macros" = { git') && !one.includes('"engine-core" = { git'));
    assert.equal(gate({ 'Cargo.toml': one }).status, 1, 'the remaining pin still fails the gate');
    const released = { 'Cargo.toml': cargo, 'cmake/CMakeLists.txt': cmake, 'package.json': npm, 'web/package.json': ok(releaseNpm(ok(pinNpm(JSON_PKG, 'engine', '1.2.0-canary.0123456789ab')), 'engine', '1.2.0')) };
    for (const [file, text] of Object.entries(released)) {
      const r = gate({ [file]: text });
      assert.equal(r.status, 0, `${file}: ${r.out}`);
    }
    const all = gate(released);
    assert.equal(all.status, 0, all.out);
  });

  test('lockfileArgv', () => {
    assert.deepEqual(lockfileArgv('cargo', 'engine-core', 'v1.2.0+b'), { argv: ['update', '-p', 'engine-core', '--precise', '1.2.0'] });
    assert.deepEqual(lockfileArgv('npm', '@acme/engine', '1.2.0'), { argv: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'] });
    for (const [eco, name, version] of [
      ['cargo', '-Zunstable', '1.2.0'],
      ['cargo', '--locked', '1.2.0'],
      ['npm', '-g', '1.2.0'],
      ['cargo', 'engine-core', '-Zunstable'],
      ['cargo', 'engine-core', '1.2.0 && x'],
      ['cargo', 'engine-core', '1.2.0-canary.abc'],
      ['cargo', 'engine-core', `1.2.0-${'a'.repeat(120)}`],
      ['cmake', 'engine', '1.2.0'],
    ])
      assert.ok('error' in lockfileArgv(eco, name, version), `${eco} ${name} ${version}`);
  });
});
