// Release strategy (config schemaVersion 16, issue #189; release.publish in 17, #190): versioning, mechanism + command, registry
// and cadence on the root `release` and each `repos[].release`, and doctor's look-only check that
// the declared mechanism's tool is on this machine.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgeAsync, repoTemplate, tempRepo } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { CONFIG_SCHEMA_VERSION } from '../lib/schema.ts';
import { redactedConfig } from '../lib/config-fields.ts';
import { doctor } from '../lib/doctor.ts';
import { releaseChecks } from '../lib/member-repos.ts';
import { RELEASE_CADENCES, RELEASE_MECHANISMS, RELEASE_PUBLISH, RELEASE_REGISTRIES, RELEASE_VERSIONINGS, commandProgram, releaseMechanismCheck } from '../lib/release-strategy.ts';
import { deepMerge } from '../lib/shape.ts';
import { findOnPath } from '../lib/util.ts';
import * as yaml from '../lib/yaml.ts';

const WIN = process.platform === 'win32';
const POSIX_ONLY = WIN && 'Windows has no executable bit: any regular file with a PATHEXT extension runs';
const LIB = { name: 'lib', remote: 'git@github.com:acme/lib.git', defaultBranch: 'main' };
const ROOT_DEFAULT = { interim: 'local', versioning: null, mechanism: null, command: null, registry: null, cadence: null, publish: null };
const TAG_MSG = (at: string, got: string) => `${at}.command must be a one-line command of at most 1000 characters when mechanism is tag (got ${got})`;
const ONLY_TAG = (at: string) => `${at}.command is only read when mechanism is tag; remove it or set mechanism: tag`;

const problems = (c: Record<string, unknown>) => validateConfig({ ...defaults(), ...c }, process.cwd());
const root = (release: Record<string, unknown>) => problems({ release: { ...defaults().release, ...release } });
const member = (release: unknown) => problems({ repos: [{ ...LIB, release }] });

const scratch = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-')));

/** An executable stub named `name` in `dir` (a .CMD on Windows, spelt as the default PATHEXT does) whose body is `body`; returns its path. */
function stub(dir: string, name: string, body = ''): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, WIN ? `${name}.CMD` : name);
  fs.writeFileSync(file, WIN ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe('release strategy config', { concurrency: 4 }, () => {
  test('a single-repo project declares a strategy in release alone', () => {
    assert.deepEqual(defaults().release, ROOT_DEFAULT);
    assert.deepEqual(root({ versioning: 'semver', mechanism: 'tag', command: 'npm run release', registry: 'none', cadence: 'on-merge' }), []);
  });

  test('every strategy value validates on the root and on members', () => {
    const lists: [string, readonly string[]][] = [
      ['versioning', RELEASE_VERSIONINGS],
      ['mechanism', RELEASE_MECHANISMS],
      ['registry', RELEASE_REGISTRIES],
      ['cadence', RELEASE_CADENCES],
    ];
    for (const [key, values] of lists) {
      for (const v of values) {
        const extra = key === 'mechanism' && v === 'tag' ? { command: 'git tag v1' } : {};
        assert.deepEqual(root({ [key]: v, ...extra }), [], `root ${key} ${v}`);
        assert.deepEqual(member({ interim: 'git-ref', [key]: v, ...extra }), [], `member ${key} ${v}`);
      }
      assert.deepEqual(root({ [key]: null }), [], `root ${key} null`);
      assert.deepEqual(member({ [key]: null }), [], `member ${key} null`);
      const { [key]: _, ...without } = defaults().release as Record<string, unknown>;
      assert.deepEqual(problems({ release: without }), [], `root ${key} absent`);
    }
    assert.deepEqual(member({}), []);
    assert.deepEqual(member(null), []);
    assert.deepEqual(member({ versioning: 'semver' }), [], 'no interim');
    assert.deepEqual(problems({ repos: [LIB] }), [], 'no release at all');
  });

  test('bad strategy values report one message each', () => {
    const cases: [string, unknown, string][] = [
      ['versioning', 'romver', 'must be one of semver | calver (got "romver")'],
      ['mechanism', 'goreleaser', 'must be one of release-please | cargo-release | changesets | tag (got "goreleaser")'],
      ['registry', 'pypi', 'must be one of crates.io | npm | none (got "pypi")'],
      ['cadence', 'nightly', 'must be one of on-merge | scheduled | manual (got "nightly")'],
      ['cadence', 3, 'must be one of on-merge | scheduled | manual (got 3)'],
    ];
    for (const [key, v, msg] of cases) {
      assert.deepEqual(root({ [key]: v }), [`release.${key} ${msg}`], `root ${key}`);
      assert.deepEqual(member({ interim: 'local', [key]: v }), [`repos "lib".release.${key} ${msg}`], `member ${key}`);
      assert.deepEqual(member({ [key]: v }), [`repos "lib".release.${key} ${msg}`], `member without interim ${key}`);
    }
    assert.deepEqual(member({ cadence: 'nightly' }), ['repos "lib".release.cadence must be one of on-merge | scheduled | manual (got "nightly")']);
    assert.deepEqual(problems({ repos: [{ release: { cadence: 'nightly' } }] }).filter((p) => p.includes('release')), ['repos[0].release.cadence must be one of on-merge | scheduled | manual (got "nightly")']);
    assert.deepEqual(root({ versioning: 'x'.repeat(300) }), [`release.versioning must be one of semver | calver (got ${JSON.stringify('x'.repeat(300)).slice(0, 120)})`], 'capped');
    assert.deepEqual(root({ interim: 'bogus', cadence: 'nightly' }), ['release.interim must be one of canary | git-ref | local | sequential (got "bogus")', 'release.cadence must be one of on-merge | scheduled | manual (got "nightly")']);
  });

  test('command is required with tag and refused otherwise', () => {
    const long = 'a'.repeat(1001);
    const bad: [unknown, string][] = [
      [undefined, 'nothing'],
      ['', '""'],
      ['   ', '"   "'],
      [42, '42'],
      [long, JSON.stringify(long).slice(0, 120)],
      ['a\nb', '"a\\nb"'],
      ['a\u0007b', '"a\\u0007b"'],
    ];
    for (const [command, got] of bad) {
      const r: Record<string, unknown> = { mechanism: 'tag' };
      if (command !== undefined) r.command = command;
      assert.deepEqual(problems({ release: { interim: 'local', ...r } }), [TAG_MSG('release', got)], `root ${got}`);
      assert.deepEqual(member(r), [TAG_MSG('repos "lib".release', got)], `member ${got}`);
    }
    assert.deepEqual(root({ mechanism: 'tag', command: 'a'.repeat(1000) }), [], 'exactly 1000 characters');
    assert.deepEqual(root({ mechanism: 'cargo-release', command: 'cargo release' }), [ONLY_TAG('release')]);
    assert.deepEqual(root({ command: 'cargo release' }), [ONLY_TAG('release')]);
    assert.deepEqual(member({ command: 'cargo release' }), [ONLY_TAG('repos "lib".release')]);
    assert.deepEqual(root({ mechanism: 'cargo-release', command: null }), []);
    assert.deepEqual(root({ mechanism: 'tag', command: 'npm run release' }), []);
    assert.deepEqual(member({ mechanism: 'tag', command: 'npm run release' }), []);
  });

  test('release.publish validates', () => {
    assert.equal(defaults().release.publish, null);
    for (const v of [...RELEASE_PUBLISH, null]) {
      assert.deepEqual(root({ publish: v }), [], `root ${v}`);
      assert.deepEqual(member({ publish: v }), [], `member ${v}`);
    }
    for (const [v, got] of [['yes', '"yes"'], [true, 'true'], ['ALLOW', '"ALLOW"']] as [unknown, string][]) {
      assert.deepEqual(root({ publish: v }), [`release.publish must be one of confirm | allow (got ${got})`]);
      assert.deepEqual(member({ publish: v }), [`repos "lib".release.publish must be one of confirm | allow (got ${got})`]);
    }
  });

  test('a v15 config file still loads', () => {
    const dir = scratch();
    try {
      fs.mkdirSync(path.join(dir, '.forge'));
      fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), 'schemaVersion: 15\nrelease:\n  interim: canary\n'); // old-version fixture
      const loaded = loadConfig(dir);
      assert.equal(loaded.migratedFrom, 15);
      assert.equal(loaded.config.schemaVersion, CONFIG_SCHEMA_VERSION);
      assert.equal(loaded.config.release.interim, 'canary');
      assert.equal(loaded.config.release.mechanism, null);
      assert.deepEqual(validateConfig(loaded.config, dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('support bundles hide release.command', () => {
    const release = { interim: 'git-ref', versioning: 'semver', mechanism: 'tag', command: 'npm run release -- --otp 123456', registry: 'npm', cadence: 'manual' };
    const red = redactedConfig({ ...defaults(), release } as any) as any;
    assert.deepEqual(red.release, { ...release, command: '<redacted>' });
    assert.ok(!JSON.stringify(red).includes('123456'));
    assert.equal((redactedConfig(defaults()) as any).release.command, null, 'an unset command stays visibly unset');
  });
});

describe('findOnPath', { concurrency: 4 }, () => {
  test('findOnPath looks only at absolute PATH dirs', async (t) => {
    const dir = scratch();
    try {
      const a = path.join(dir, 'a');
      const tool = stub(a, 'tool');
      const d = path.delimiter;
      assert.equal(findOnPath('tool', { PATH: `${d}${d}${a}` }), tool, 'empty entries are skipped');
      assert.equal(findOnPath('nope', { PATH: a }), null);
      assert.equal(findOnPath('a/tool', { PATH: dir }), null, 'a path is never looked up');
      assert.equal(findOnPath('tool', { Path: a }), tool, 'Windows spells it Path');
      // A relative entry would search the cwd: never followed, even when it holds the tool.
      const rel = path.join('rel-dir', 'bin');
      assert.ok(!path.isAbsolute(rel));
      assert.equal(findOnPath('tool', { PATH: rel }), null, 'relative entries are skipped');
      // A directory with the tool's name is not the tool.
      const b = path.join(dir, 'b');
      fs.mkdirSync(path.join(b, WIN ? 'tool.cmd' : 'tool'), { recursive: true });
      assert.equal(findOnPath('tool', { PATH: `${b}${d}${a}` }), tool, 'directories are skipped');
      // PATHEXT on win32 (stat only, so this runs on any host).
      const w = path.join(dir, 'w');
      fs.mkdirSync(w);
      fs.writeFileSync(path.join(w, 'tool'), '');
      assert.equal(findOnPath('tool', { PATH: w }, 'win32'), null, 'win32 needs an extension');
      // Spelt as the PATHEXT entries are: Linux and case-sensitive macOS volumes compare names exactly.
      const cmd = path.join(w, 'tool.CMD');
      fs.writeFileSync(cmd, '');
      assert.equal(findOnPath('tool', { PATH: w, PATHEXT: '.EXE;.CMD' }, 'win32'), cmd);
      assert.equal(findOnPath('tool', { PATH: w }, 'win32'), cmd, 'default PATHEXT');
      assert.equal(findOnPath('tool.CMD', { PATH: w, PATHEXT: '.EXE' }, 'win32'), cmd, 'a name with an extension is tried as is');
      assert.equal(findOnPath('tool', { PATH: w, PATHEXT: '.EXE' }, 'win32'), null);
      await t.test('a non-executable file is skipped on POSIX', { skip: POSIX_ONLY }, () => {
        const n = path.join(dir, 'n');
        fs.mkdirSync(n);
        fs.writeFileSync(path.join(n, 'tool'), '#!/bin/sh\n', { mode: 0o644 });
        assert.equal(findOnPath('tool', { PATH: n }, 'linux'), null);
        assert.equal(findOnPath('tool', { PATH: `${n}${d}${a}` }, 'linux'), tool);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release mechanism check', { concurrency: 4 }, () => {
  test('release mechanism check finds each tool', () => {
    const dir = scratch();
    try {
      const repo = path.join(dir, 'repo');
      const bin = path.join(repo, 'node_modules', '.bin');
      const tools = path.join(dir, 'tools');
      const check = (release: Record<string, unknown>, PATH: string) => releaseMechanismCheck('release mechanism', repo, release, { PATH }, process.platform);
      // In node_modules/.bin with nothing on PATH.
      const rp = stub(bin, 'release-please');
      const cs = stub(bin, 'changeset');
      const cr = stub(bin, 'cargo-release');
      assert.deepEqual(check({ mechanism: 'release-please' }, ''), { name: 'release mechanism', ok: true, detail: `release-please: release-please at ${rp}` });
      assert.deepEqual(check({ mechanism: 'changesets' }, ''), { name: 'release mechanism', ok: true, detail: `changesets: changeset at ${cs}` });
      // cargo-release is a cargo subcommand: node_modules/.bin is not where it lives.
      assert.deepEqual(check({ mechanism: 'cargo-release' }, ''), { name: 'release mechanism', ok: false, detail: 'cargo-release: cargo-release not found on PATH; install it: cargo install cargo-release' });
      assert.ok(cr);
      fs.rmSync(path.join(repo, 'node_modules'), { recursive: true });
      // On PATH with no node_modules.
      const prp = stub(tools, 'release-please');
      const pcs = stub(tools, 'changeset');
      const pcr = stub(tools, 'cargo-release');
      assert.equal(check({ mechanism: 'release-please' }, tools).detail, `release-please: release-please at ${prp}`);
      assert.equal(check({ mechanism: 'changesets' }, tools).detail, `changesets: changeset at ${pcs}`);
      assert.equal(check({ mechanism: 'cargo-release' }, tools).detail, `cargo-release: cargo-release at ${pcr}`);
      // tag: git and the command's program.
      const git = stub(tools, 'git');
      const mytool = stub(tools, 'mytool');
      assert.deepEqual(check({ mechanism: 'tag', command: 'mytool release' }, tools), { name: 'release mechanism', ok: true, detail: `tag: git at ${git}, mytool at ${mytool}` });
      assert.deepEqual(check({ mechanism: 'tag', command: 'other release' }, tools), { name: 'release mechanism', ok: false, detail: 'tag: other not found on PATH; install it: install other or fix release.command' });
      const noGit = path.join(dir, 'nogit');
      stub(noGit, 'mytool');
      assert.deepEqual(check({ mechanism: 'tag', command: 'mytool' }, noGit), { name: 'release mechanism', ok: false, detail: 'tag: git not found on PATH; install it: install git' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing tool fails, or warns when releases run from CI', () => {
    const dir = scratch();
    try {
      const bin = path.join(dir, 'node_modules', '.bin');
      const base = `release-please: release-please not found in ${bin} or on PATH; install it: npm install --save-dev release-please`;
      for (const cadence of [undefined, null, 'manual']) {
        const c = releaseMechanismCheck('release mechanism', dir, { mechanism: 'release-please', cadence: cadence as any }, { PATH: '' }, process.platform);
        assert.deepEqual(c, { name: 'release mechanism', ok: false, detail: base }, String(cadence));
      }
      for (const cadence of ['on-merge', 'scheduled'] as const) {
        const c = releaseMechanismCheck('release mechanism', dir, { mechanism: 'release-please', cadence }, { PATH: '' }, process.platform);
        assert.deepEqual(c, { name: 'release mechanism', ok: true, warn: true, detail: `${base}; cadence ${cadence} usually releases from CI, so this matters only to release from this machine` });
      }
      const c = releaseMechanismCheck('x', dir, { mechanism: 'changesets', cadence: 'manual' }, { PATH: '' }, process.platform);
      assert.equal(c.detail, `changesets: changeset not found in ${bin} or on PATH; install it: npm install --save-dev @changesets/cli`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tag command first word is parsed, never run', () => {
    const dir = scratch();
    try {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const tools = path.join(dir, 'tools');
      const git = stub(tools, 'git');
      const marker = path.join(dir, 'ran');
      const touch = WIN ? `type nul > "${marker}"` : `touch '${marker}'`;
      const mytool = stub(tools, 'mytool', touch);
      const spaced = stub(tools, 'my tool', touch);
      const check = (command: string, PATH = tools) => releaseMechanismCheck('release mechanism', repo, { mechanism: 'tag', command }, { PATH }, process.platform);

      assert.deepEqual(commandProgram('FOO=1 BAR=2 mytool --x'), { word: 'mytool' });
      assert.equal(check('FOO=1 BAR=2 mytool --x').detail, `tag: git at ${git}, mytool at ${mytool}`);
      assert.deepEqual(commandProgram(`'my tool' x`), { word: 'my tool' });
      assert.equal(check(`'my tool' x`).detail, `tag: git at ${git}, my tool at ${spaced}`);

      const script = path.join(repo, 'scripts', 'release.sh');
      const rel = check('./scripts/release.sh --dry-run');
      assert.deepEqual(rel, { name: 'release mechanism', ok: false, detail: `tag: ./scripts/release.sh not found at ${script}; install it: install ./scripts/release.sh or fix release.command` });
      stub(path.dirname(script), 'release.sh');
      if (WIN) fs.renameSync(`${script}.CMD`, script);
      assert.deepEqual(check('./scripts/release.sh --dry-run'), { name: 'release mechanism', ok: true, detail: `tag: git at ${git}, ./scripts/release.sh at ${script}` });

      for (const command of ['$(which x)', '`x`', 'cd dist && npm publish', 'a | b', 'FOO=1', `'unterminated`, 'eval mytool', 'mytool; rm -rf x', 'mytool > out', '~/bin/release']) {
        const prog = commandProgram(command);
        assert.ok('unknown' in prog, command);
        const c = check(command);
        assert.equal(c.ok, true, command);
        assert.equal(c.warn, true, command);
        assert.match(c.detail, /^tag: cannot tell which program release\.command runs \(.+\); checked git only$/, command);
        const noGit = check(command, path.join(dir, 'empty'));
        assert.equal(noGit.ok, false, `${command}: git missing still fails`);
        assert.match(noGit.detail, /git not found on PATH/);
      }
      assert.match(check(`'unterminated`).detail, /\(unterminated '\)/);
      assert.match(check('FOO=1').detail, /\(no program after the variable assignments\)/);
      assert.match(check('cd dist').detail, /\(cd is a shell builtin\)/);
      // A UNC program on win32 is never stat'd (that would open an SMB connection): cannot tell.
      const winTools = path.join(dir, 'win-tools');
      fs.mkdirSync(winTools);
      fs.writeFileSync(path.join(winTools, 'git.CMD'), '');
      for (const command of ['\\\\host\\share\\release.cmd --x', '//host/share/release.cmd']) {
        const c = releaseMechanismCheck('release mechanism', repo, { mechanism: 'tag', command }, { PATH: winTools }, 'win32');
        assert.equal(c.warn, true, command);
        assert.match(c.detail, /^tag: cannot tell which program release\.command runs \(it names a network path\); checked git only$/, command);
      }
      assert.ok(!fs.existsSync(marker), 'doctor never runs the command or the tool');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a long hostile command is parsed quickly', () => {
    const hostile = `${'A=1 '.repeat(240)}${' "x'.repeat(1)}`;
    const start = Date.now();
    commandProgram(hostile);
    commandProgram(`'${'x'.repeat(10_000)}`);
    commandProgram(`${'$('.repeat(5000)}`);
    // Generous: it guards against catastrophic backtracking, not speed, and a loaded shard must not flake it.
    assert.ok(Date.now() - start < 10_000);
  });
});

/** A config with no gh-backed checks, plus `extra` merged over it. */
const cfg = (extra: Record<string, any> = {}): any => ({ ...deepMerge(defaults(), { tracker: { kind: 'none' }, pr: { enabled: false } }), ...extra });

describe('doctor release checks', { concurrency: 4 }, () => {
  test('doctor adds release checks for root and members', async () => {
    const repo = tempRepo();
    const dir = scratch();
    try {
      const clone = path.join(dir, 'a');
      fs.mkdirSync(clone);
      const tools = path.join(dir, 'tools');
      const cargo = stub(tools, 'cargo-release');
      fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, '.forge', 'local.yml'), yaml.stringify({ repos: { a: { path: clone }, d: { path: path.join(dir, 'missing') } } }));
      const repos = [
        { name: 'a', remote: 'git@github.com:acme/a.git', defaultBranch: 'main', release: { mechanism: 'cargo-release' } },
        { name: 'b', remote: 'git@github.com:acme/b.git', defaultBranch: 'main', release: { mechanism: 'tag', command: 'make release' } },
        { name: 'c', remote: 'git@github.com:acme/c.git', defaultBranch: 'main', release: { interim: 'git-ref' } },
        { name: 'd', remote: 'git@github.com:acme/d.git', defaultBranch: 'main', release: { mechanism: 'changesets', cadence: 'manual' } },
        { name: 'e', remote: 'git@github.com:acme/e.git', defaultBranch: 'main' },
      ];
      const config = cfg({ repos, release: { ...defaults().release, mechanism: 'cargo-release' } });
      const checks = releaseChecks(repo.dir, config, { PATH: tools }, process.platform);
      assert.deepEqual(
        checks.map((c) => c.name),
        ['release mechanism', 'release mechanism a', 'release mechanism b', 'release mechanism d'],
      );
      assert.deepEqual(checks[0], { name: 'release mechanism', ok: true, detail: `cargo-release: cargo-release at ${cargo}` });
      assert.deepEqual(checks[1], { name: 'release mechanism a', ok: true, detail: `cargo-release: cargo-release at ${cargo}` });
      assert.deepEqual(checks[2], { name: 'release mechanism b', ok: true, warn: true, detail: `tag: b's clone is not resolved (see the repo b check); not checked` });
      assert.deepEqual(checks[3], { name: 'release mechanism d', ok: true, warn: true, detail: `changesets: d's clone is not resolved (see the repo d check); not checked` });

      // No mechanism anywhere: no checks.
      assert.deepEqual(releaseChecks(repo.dir, cfg({ repos: [repos[2], repos[4]] }), { PATH: tools }, process.platform), []);
      // A repos problem: no member checks, the root's still runs.
      const broken = cfg({ repos: [...repos, { name: 'f', remote: '-bad', defaultBranch: 'main' }], release: config.release });
      assert.deepEqual(releaseChecks(repo.dir, broken, { PATH: tools }, process.platform).map((c) => c.name), ['release mechanism']);
      // A root release problem: no root check, the members' still run.
      const badRoot = cfg({ repos, release: { ...defaults().release, mechanism: 'tag' } });
      assert.deepEqual(releaseChecks(repo.dir, badRoot, { PATH: tools }, process.platform).map((c) => c.name), ['release mechanism a', 'release mechanism b', 'release mechanism d']);

      // Through doctor: after every repo <name> check.
      const report = await doctor(repo.dir, config, true);
      const names = report.checks.map((c) => c.name);
      const lastRepo = Math.max(...['a', 'b', 'c', 'd', 'e'].map((n) => names.indexOf(`repo ${n}`)));
      const firstRelease = names.indexOf('release mechanism');
      assert.ok(lastRepo >= 0 && firstRelease > lastRepo, names.join(', '));
      assert.deepEqual(names.filter((n) => n.startsWith('release mechanism')), ['release mechanism', 'release mechanism a', 'release mechanism b', 'release mechanism d']);
    } finally {
      repo.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const initialised = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

function setRelease(dir: string, release: Record<string, unknown>): void {
  const file = path.join(dir, '.forge', 'config.yml');
  const raw = yaml.parse(fs.readFileSync(file, 'utf8'));
  raw.release = { ...raw.release, ...release };
  fs.writeFileSync(file, yaml.stringify(raw));
}

describe('forge doctor', { concurrency: 4 }, () => {
  test('forge doctor reports the release mechanism', async () => {
    const repo = initialised();
    const tools = scratch();
    try {
      const raw = yaml.parse(fs.readFileSync(path.join(repo.dir, '.forge', 'config.yml'), 'utf8'));
      assert.deepEqual(raw.release, ROOT_DEFAULT, 'init writes the new keys unset');
      const prog = stub(tools, 'forge-release-stub');
      // A gh that answers nothing, so doctor's latest-release check stays off the network.
      stub(tools, 'gh', 'exit 1');
      // Windows inherits `Path`: unset every spelling (spawn skips undefined) so the child sees one PATH.
      const unset = Object.fromEntries(Object.keys(process.env).filter((k) => k.toUpperCase() === 'PATH').map((k) => [k, undefined]));
      const env = { ...unset, PATH: `${tools}${path.delimiter}${process.env.PATH}` };
      const releaseCheck = async () => {
        const r = await forgeAsync(repo.dir, ['doctor', '--json'], env);
        return JSON.parse(r.stdout).checks.find((c: any) => c.name === 'release mechanism');
      };
      setRelease(repo.dir, { mechanism: 'tag', command: 'forge-release-stub --dry-run' });
      const ok = await releaseCheck();
      assert.equal(ok.ok, true, ok.detail);
      assert.equal(ok.warn, undefined);
      assert.match(ok.detail, /^tag: git at .+, forge-release-stub at /);
      assert.ok(ok.detail.endsWith(prog), ok.detail);
      const missing = `forge-missing-tool-${crypto.randomBytes(4).toString('hex')}`;
      setRelease(repo.dir, { command: missing });
      const bad = await releaseCheck();
      assert.equal(bad.ok, false);
      assert.equal(bad.detail, `tag: ${missing} not found on PATH; install it: install ${missing} or fix release.command`);
    } finally {
      repo.cleanup();
      fs.rmSync(tools, { recursive: true, force: true });
    }
  });
});
