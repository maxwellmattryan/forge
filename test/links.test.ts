// Local links (config schemaVersion 12): the `link` shape on dependsOn edges, its validation, link
// resolution against the job's repos, and the pure renderers. No sh and no toolchains;
// the CLI and toolchain tests are links-cli and links-toolchains.
import { after, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, scratchGitConfig, tempRepo } from './helpers.ts';
import { defaults, validateConfig } from '../lib/config.ts';
import { memberWorktreePath } from '../lib/job-repos.ts';
import { applyLinks, cargoShim, cmakeArgs, cmakeShim, declaredLinks, linkLeakPaths, npmShim, pathPrelude, renderCargoConfig, resolveLinks, restoreLockfiles, sameMode, snapshotLockfiles, writeIfChanged } from '../lib/links.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import type { Config, Job } from '../lib/types.ts';
import * as yaml from '../lib/yaml.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const REPOS = [{ name: 'engine', remote: 'https://example.com/engine.git', defaultBranch: 'main' }];
const COMPONENTS = [
  {
    name: 'app',
    path: '.',
    kind: 'app',
    dependsOn: [
      { component: 'engine-core', type: 'build', link: { ecosystem: 'cargo', name: 'engine-core' } },
      { component: 'engine-core', type: 'build', link: { ecosystem: 'cmake', name: 'engine', path: 'cpp' } },
      { component: 'engine-js', type: 'build', link: { ecosystem: 'npm', name: '@acme/engine' } },
      { component: 'engine-core', type: 'build', link: { ecosystem: 'cargo', name: 'engine-macros', source: 'https://github.com/acme/engine', path: 'macros' } },
    ],
  },
  { name: 'engine-core', repo: 'engine', path: 'core', kind: 'library' },
  { name: 'engine-js', repo: 'engine', path: 'js', kind: 'library' },
  { name: 'engine-tool', repo: 'engine', path: '.', kind: 'app', dependsOn: [{ component: 'shared', type: 'build', link: { ecosystem: 'npm', name: 'shared' } }] },
  { name: 'shared', path: 'shared', kind: 'library' },
];

describe('links: config shape', { concurrency: 4 }, () => {
  test('a v11 config migrates to v12 unchanged', async () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 24);
    const v11 = { schemaVersion: 11, repos: structuredClone(REPOS), components: structuredClone(COMPONENTS) };
    const { config, from } = migrateConfig(structuredClone(v11));
    assert.equal(from, 11);
    assert.deepEqual(config, { ...v11, schemaVersion: 24, downstream: { enabled: true, max: 5, skip: [] } });
    const repo = tempRepo();
    cleanups.push(repo.cleanup);
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, yaml.stringify({ ...v11, tracker: { kind: 'none' } }));
    const m = await forgeAsync(repo.dir, ['migrate']);
    assert.equal(m.status, 0, m.stderr);
    const text = fs.readFileSync(cfg, 'utf8');
    assert.match(text, /^schemaVersion: 24$/m);
    assert.deepEqual(yaml.parse(text).components, COMPONENTS);
  });

  test('valid links validate', () => {
    assert.deepEqual(validateConfig({ ...defaults(), repos: REPOS, components: COMPONENTS }, process.cwd()), []);
    // crates-io, a registry name and every git url scheme are sources.
    for (const source of ['crates-io', 'my-registry', 'https://github.com/a/b', 'ssh://git@host/a/b.git', 'git://host/a/b', null]) {
      const c = structuredClone(COMPONENTS);
      (c[0].dependsOn as any[])[0].link.source = source;
      assert.deepEqual(validateConfig({ ...defaults(), repos: REPOS, components: c }, process.cwd()), [], String(source));
    }
    assert.equal(declaredLinks({ components: COMPONENTS } as Config).length, 5);
  });

  test('link validation problems', () => {
    const problemsFor = (edit: (c: any[]) => void) => {
      const c: any[] = structuredClone(COMPONENTS);
      edit(c);
      return validateConfig({ ...defaults(), repos: REPOS, components: c }, process.cwd());
    };
    const link = (c: any[], i = 0) => c[0].dependsOn[i].link;
    const long = 'a'.repeat(2001);
    const cases: [string, (c: any[]) => void, RegExp][] = [
      ['not a map', (c) => (c[0].dependsOn[0].link = 'cargo'), /dependsOn\[0\]\.link must be a map with ecosystem cargo \| cmake \| npm \(got "cargo"\)$/],
      ['unknown ecosystem', (c) => (link(c).ecosystem = 'pip'), /dependsOn\[0\]\.link must be a map with ecosystem cargo \| cmake \| npm/],
      ['on a backing edge', (c) => c[0].dependsOn.push({ backing: 'pg', type: 'runtime', link: { ecosystem: 'cargo', name: 'pg' } }), /dependsOn\[4\]\.link is only for a component edge, not a backing one$/],
      ['bad cargo name', (c) => (link(c).name = 'engine core'), /dependsOn\[0\]\.link\.name must be a crate name/],
      ['bad cmake name', (c) => (link(c, 1).name = 'eng;ine'), /dependsOn\[1\]\.link\.name must be a FetchContent name/],
      ['bad npm name', (c) => (link(c, 2).name = '@Acme/Engine'), /dependsOn\[2\]\.link\.name must be an npm package name/],
      ['too long npm name', (c) => (link(c, 2).name = 'a'.repeat(215)), /dependsOn\[2\]\.link\.name must be an npm package name/],
      ['source on cmake', (c) => (link(c, 1).source = 'crates-io'), /dependsOn\[1\]\.link\.source is only for a cargo link/],
      ['source with a quote', (c) => (link(c).source = 'https://x/"a'), /dependsOn\[0\]\.link\.source must be crates-io, a registry name or an https:\/\/, ssh:\/\/ or git:\/\/ url/],
      ['source with a space', (c) => (link(c).source = 'https://x/a b'), /link\.source must be crates-io/],
      ['source file url', (c) => (link(c).source = 'file:///tmp/x'), /link\.source must be crates-io/],
      ['source too long', (c) => (link(c).source = `https://x/${long}`), /link\.source must be crates-io/],
      ['path outside', (c) => (link(c).path = '../x'), /dependsOn\[0\]\.link\.path must be a relative path inside the dependency's repo \(got "\.\.\/x"\)$/],
      ['absolute path', (c) => (link(c).path = '/abs'), /link\.path must be a relative path inside/],
      ['same repo', (c) => c[0].dependsOn.push({ component: 'shared', type: 'build', link: { ecosystem: 'npm', name: 'shared' } }), /dependsOn\[4\]\.link joins two components of the root repo; a link points a consumer at another repo's worktree$/],
      [
        'conflicting dirs',
        (c) => c[0].dependsOn.push({ component: 'engine-js', type: 'build', link: { ecosystem: 'cargo', name: 'engine-core' } }),
        /dependsOn\[4\]\.link gives the root repo the cargo link "engine-core" again with another dependency dir than components "app"\.dependsOn\[0\]\.link$/,
      ],
    ];
    for (const [what, edit, re] of cases) {
      const problems = problemsFor(edit);
      assert.equal(problems.length, 1, `${what}: ${JSON.stringify(problems)}`);
      assert.match(problems[0], re, what);
    }
    // The same crate under another source, or again with the same dir, is no conflict.
    assert.deepEqual(problemsFor((c) => c[0].dependsOn.push({ component: 'engine-js', type: 'build', link: { ecosystem: 'cargo', name: 'engine-core', source: 'other' } })), []);
    assert.deepEqual(problemsFor((c) => c[0].dependsOn.push({ component: 'engine-core', type: 'runtime', link: { ecosystem: 'cargo', name: 'engine-core', path: 'core/' } })), []);
  });
});

/**
 * A root repo and a member clone `engine` (remote set, never fetched), with `config` in memory and
 * the job's worktrees as plain directories: resolution reads only paths and the clone check.
 */
function scratch() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-links-')));
  cleanups.push(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'app');
  const engine = path.join(parent, 'engine');
  for (const dir of [root, engine]) {
    fs.mkdirSync(dir, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    scratchGitConfig(git);
  }
  execFileSync('git', ['remote', 'add', 'origin', REPOS[0].remote], { cwd: engine });
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'local.yml'), 'repos:\n  engine:\n    path: ../engine\n');
  const config = { ...defaults(), repos: structuredClone(REPOS), components: structuredClone(COMPONENTS) } as unknown as Config;
  const id = 'j1';
  const rootWt = path.join(parent, 'app.worktrees', id);
  const engineWt = memberWorktreePath(root, config, 'engine', id);
  for (const d of ['shared', '.']) fs.mkdirSync(path.join(rootWt, d), { recursive: true });
  for (const d of ['core', 'js', 'macros']) fs.mkdirSync(path.join(engineWt, d), { recursive: true });
  const job = (edit: (j: any) => void = () => {}): Pick<Job, 'id' | 'worktree' | 'repos'> => {
    const j: any = {
      id,
      worktree: rootWt,
      repos: [
        { repo: null, worktree: rootWt, branch: `forge/${id}`, base: 'main', pr: null, verifyOnly: false },
        { repo: 'engine', worktree: engineWt, branch: `forge/${id}`, base: 'main', pr: null, verifyOnly: false },
      ],
    };
    edit(j);
    return j;
  };
  return { parent, root, engine, config, id, rootWt, engineWt, job };
}

const brief = (links: ReturnType<typeof resolveLinks>) => links.map((l) => [l.consumerRepo, l.ecosystem, l.name, l.active, l.dir, l.reason]);

describe('links: resolution', { concurrency: 4 }, () => {
  test('resolution: active and inactive reasons', () => {
    const s = scratch();
    const all = resolveLinks(s.root, s.config, s.job());
    assert.deepEqual(Object.keys(all[0]), ['consumer', 'consumerRepo', 'dependency', 'dependencyRepo', 'ecosystem', 'name', 'source', 'dir', 'active', 'reason']);
    // Sorted by consumer repo (root first), ecosystem, name; the cmake `cpp` dir is missing.
    assert.deepEqual(brief(all), [
      [null, 'cargo', 'engine-core', true, path.join(s.engineWt, 'core'), null],
      [null, 'cargo', 'engine-macros', true, path.join(s.engineWt, 'macros'), null],
      [null, 'cmake', 'engine', false, null, "cpp does not exist in repo engine's worktree"],
      [null, 'npm', '@acme/engine', true, path.join(s.engineWt, 'js'), null],
      ['engine', 'npm', 'shared', true, path.join(s.rootWt, 'shared'), null],
    ]);
    assert.deepEqual(
      all.map((l) => l.source),
      ['crates-io', 'https://github.com/acme/engine', null, null, null],
    );
    fs.mkdirSync(path.join(s.engineWt, 'cpp'));
    assert.equal(resolveLinks(s.root, s.config, s.job()).find((l) => l.ecosystem === 'cmake')!.active, true);
    // The member is not on the job: every link touching it is inactive, the root as consumer or dependency.
    const off = resolveLinks(s.root, s.config, s.job((j) => j.repos.pop()));
    assert.ok(off.every((l) => !l.active && l.dir === null && l.reason === 'repo engine is not on the job'));
    const none = resolveLinks(s.root, s.config, s.job((j) => (j.repos[1].worktree = null)));
    assert.ok(none.every((l) => l.reason === `repo engine has no worktree yet; run: forge worktree create ${s.id}`));
    const noRoot = resolveLinks(s.root, s.config, s.job((j) => (j.worktree = null)));
    assert.ok(noRoot.every((l) => l.reason === `repo app has no worktree yet; run: forge worktree create ${s.id}`));
    // No declarations, no links.
    assert.deepEqual(resolveLinks(s.root, { ...s.config, components: [] }, s.job()), []);
  });

  test('resolution: forged worktree is never used', () => {
    const s = scratch();
    const elsewhere = path.join(s.parent, 'evil');
    for (const d of ['core', 'js', 'shared', 'macros', 'cpp']) fs.mkdirSync(path.join(elsewhere, d), { recursive: true });
    const member = resolveLinks(s.root, s.config, s.job((j) => (j.repos[1].worktree = elsewhere)));
    assert.ok(member.every((l) => !l.active && l.reason === "repo engine's stored worktree is not the path Forge computes"), JSON.stringify(member));
    const rootForged = resolveLinks(s.root, s.config, s.job((j) => (j.worktree = elsewhere)));
    assert.ok(rootForged.every((l) => !l.active && l.reason === "repo app's stored worktree is not the path Forge computes"), JSON.stringify(rootForged));
    // The same directory spelled another way is not the computed path either.
    const dotted = resolveLinks(s.root, s.config, s.job((j) => (j.repos[1].worktree = `${path.dirname(s.engineWt)}${path.sep}.${path.sep}${s.id}`)));
    assert.ok(dotted.every((l) => !l.active));
    for (const r of [member, rootForged, dotted]) assert.doesNotMatch(JSON.stringify(r), /evil/);
    // A symlinked link dir that leads out of the worktree is not a dir of the worktree.
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(elsewhere, 'cpp'), path.join(s.engineWt, 'cpp'));
      const cm = resolveLinks(s.root, s.config, s.job()).find((l) => l.ecosystem === 'cmake')!;
      assert.equal(cm.active, false);
      assert.equal(cm.dir, null);
    }
  });

  test('applyLinks renders into the job dir and only rewrites changed files', () => {
    const s = scratch();
    const dir = path.join(s.root, '.forge', 'jobs', s.id, 'links', '_root');
    const applied = applyLinks(s.root, s.config, s.job(), null, 'linux')!;
    assert.deepEqual(applied.labels, ['cargo:engine-core', 'cargo:engine-macros', 'npm:@acme/engine']);
    assert.equal(applied.binDir, path.join(dir, 'bin'));
    assert.deepEqual(applied.lockfiles, ['cargo', 'npm']);
    assert.equal(applied.worktree, s.rootWt);
    assert.equal(applied.env.FORGE_CARGO_CONFIG, path.join(dir, 'cargo-links.toml'));
    assert.equal(applied.env.FORGE_CMAKE_ARGS, "'-UFETCHCONTENT_SOURCE_DIR_ENGINE'");
    assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')).sort(), ['cargo', 'cmake', 'npm']);
    const toml = path.join(dir, 'cargo-links.toml');
    const before = fs.statSync(toml).mtimeMs;
    fs.writeFileSync(path.join(dir, 'bin', 'planted'), 'x');
    const again = applyLinks(s.root, s.config, s.job(), null, 'linux')!;
    assert.deepEqual(again, applied);
    assert.equal(fs.statSync(toml).mtimeMs, before, 'unchanged content is not rewritten');
    assert.equal(fs.existsSync(path.join(dir, 'bin', 'planted')), false, 'a file no longer needed is deleted');
    // The member leaves: no cargo or npm link is active, the cmake shim still clears its cache entry.
    const off = applyLinks(s.root, s.config, s.job((j) => j.repos.pop()), null, 'linux')!;
    assert.deepEqual(off.labels, []);
    assert.deepEqual(fs.readdirSync(dir), ['bin']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')), ['cmake']);
    // Windows: no shims and no bin dir, the env vars still.
    const win = applyLinks(s.root, s.config, s.job(), null, 'win32')!;
    assert.equal(win.binDir, null);
    assert.deepEqual(fs.readdirSync(dir), ['cargo-links.toml']);
    assert.ok(win.env.FORGE_CARGO_CONFIG);
    // A repo with no declared links gets nothing, and its dir is removed.
    assert.equal(applyLinks(s.root, { ...s.config, components: [] }, s.job(), null), null);
    assert.equal(fs.existsSync(dir), false);
  });

  test('sameMode compares only the permission bits the platform keeps', () => {
    // Windows reports 0o666 (or 0o444 when read-only) whatever chmod was given.
    assert.equal(sameMode(0o100666, 0o644, 'win32'), true);
    assert.equal(sameMode(0o100666, 0o755, 'win32'), true);
    assert.equal(sameMode(0o100444, 0o644, 'win32'), false);
    assert.equal(sameMode(0o100644, 0o644, 'linux'), true);
    assert.equal(sameMode(0o100666, 0o644, 'linux'), false);
    assert.equal(sameMode(0o100644, 0o755, 'darwin'), false);
  });

  test('lockfile snapshot restores changed and missing files only', () => {
    const repo = tempRepo();
    cleanups.push(repo.cleanup);
    fs.mkdirSync(path.join(repo.dir, 'sub'));
    for (const f of ['Cargo.lock', 'sub/Cargo.lock', 'package-lock.json']) fs.writeFileSync(path.join(repo.dir, f), `v1 ${f}\n`);
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'locks');
    // An uncommitted edit made before the run is what the snapshot keeps.
    fs.writeFileSync(path.join(repo.dir, 'Cargo.lock'), 'builder edit\n');
    const snap = snapshotLockfiles(repo.dir, ['cargo']);
    assert.deepEqual(snap.files.map((f) => f.rel).sort(), ['Cargo.lock', 'sub/Cargo.lock']);
    fs.writeFileSync(path.join(repo.dir, 'Cargo.lock'), 'rewritten by cargo\n');
    fs.rmSync(path.join(repo.dir, 'sub', 'Cargo.lock'));
    fs.writeFileSync(path.join(repo.dir, 'package-lock.json'), 'not snapshotted\n');
    assert.deepEqual(restoreLockfiles(snap).sort(), ['Cargo.lock', 'sub/Cargo.lock']);
    assert.equal(fs.readFileSync(path.join(repo.dir, 'Cargo.lock'), 'utf8'), 'builder edit\n');
    assert.equal(fs.readFileSync(path.join(repo.dir, 'sub', 'Cargo.lock'), 'utf8'), 'v1 sub/Cargo.lock\n');
    assert.deepEqual(restoreLockfiles(snap), [], 'nothing changed since');
  });

  test('linkLeakPaths names the worktrees roots and the job dirs', () => {
    const s = scratch();
    const leaks = linkLeakPaths(s.root, s.config);
    for (const p of [path.join(s.parent, 'app.worktrees'), path.join(s.parent, 'engine.worktrees'), path.join(s.root, '.forge', 'jobs')]) assert.ok(leaks.includes(p), p);
    // A member whose clone does not resolve is skipped.
    fs.rmSync(path.join(s.root, '.forge', 'local.yml'));
    assert.equal(linkLeakPaths(s.root, s.config).some((p) => p.includes('engine.worktrees')), false);
  });
});

describe('links: renderers', { concurrency: 4 }, () => {
  test('render cargo', () => {
    const odd = '/tmp/a "quoted" \\dir with space';
    assert.equal(
      renderCargoConfig('j1', [
        { source: 'crates-io', name: 'engine-core', dir: '/w/engine/core' },
        { source: 'https://github.com/acme/engine', name: 'engine-macros', dir: odd },
        { source: null, name: 'aaa', dir: '/w/aaa' },
        { source: 'crates-io', name: 'engine-core', dir: '/ignored/duplicate' },
      ]),
      [
        '# Written by Forge for job j1: never commit this',
        '',
        '[patch."crates-io"]',
        '"aaa" = { path = "/w/aaa" }',
        '"engine-core" = { path = "/w/engine/core" }',
        '',
        '[patch."https://github.com/acme/engine"]',
        '"engine-macros" = { path = "/tmp/a \\"quoted\\" \\\\dir with space" }',
        '',
      ].join('\n'),
    );
  });

  test('render cmake', () => {
    assert.deepEqual(
      cmakeArgs([
        { name: 'engine', dir: '/w/engine' },
        { name: 'gone.lib', dir: null },
        { name: 'Abc+x', dir: "/w/it's here" },
      ]),
      ["-DFETCHCONTENT_SOURCE_DIR_ABC+X=/w/it's here", '-DFETCHCONTENT_SOURCE_DIR_ENGINE=/w/engine', '-UFETCHCONTENT_SOURCE_DIR_GONE.LIB'],
    );
    const shim = cmakeShim('j1', '/b', ['-DFETCHCONTENT_SOURCE_DIR_ENGINE=/w/a b', '-UFETCHCONTENT_SOURCE_DIR_X']);
    assert.match(shim, /--build\|--install\|--open\|-E\|-P\|--workflow\|--find-package\|--help\|-h\|--version\|--system-information\) exec "\$real" "\$@" ;;/);
    assert.match(shim, /\nexec "\$real" '-DFETCHCONTENT_SOURCE_DIR_ENGINE=\/w\/a b' '-UFETCHCONTENT_SOURCE_DIR_X' "\$@"\n$/);
  });

  test('render shims quote paths', () => {
    const bin = "/tmp/it's a dir/links/_root/bin";
    const file = "/tmp/it's a dir/links/_root/cargo-links.toml";
    const qBin = `'/tmp/it'\\''s a dir/links/_root/bin'`;
    const qFile = `'/tmp/it'\\''s a dir/links/_root/cargo-links.toml'`;
    const cargo = cargoShim('j1', bin, file);
    assert.ok(cargo.startsWith('#!/bin/sh\n# Written by Forge for job j1: never commit this\n'));
    assert.ok(cargo.includes(`self=${qBin}\n`));
    assert.ok(cargo.includes(`+*) tc=$1; shift; exec "$real" "$tc" --config ${qFile} "$@" ;;`));
    assert.ok(cargo.endsWith(`exec "$real" --config ${qFile} "$@"\n`));
    assert.ok(cargo.includes("echo 'forge links: cargo not found on PATH' >&2; exit 127"));
    assert.ok(cargo.includes('set -f'), 'a PATH entry never globs');
    const npm = npmShim('j1', bin, ['/w/b dir', "/w/a'x"]);
    assert.ok(npm.includes(`self=${qBin}\n`));
    assert.ok(npm.includes(`install|i|in|add|ci|clean-install|ic|install-clean|update|up|upgrade)`));
    assert.ok(npm.includes(`exec "$real" install --no-save --no-audit --no-fund --install-links=false '/w/b dir' '/w/a'\\''x' ;;`));
    assert.equal(pathPrelude(bin), `PATH=${qBin}:"$PATH"; export PATH\n`);
  });
});

describe('links: writeIfChanged', () => {
  test('the temp file is random, opened exclusively, and a planted entry at its name is never followed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-write-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-write-outside-'));
    cleanups.push(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });
    const file = path.join(dir, 'config.json');
    const target = path.join(outside, 'target');
    fs.writeFileSync(target, 'orig\n');
    const names: string[] = [];
    const flags: unknown[] = [];
    const real = fs.openSync;
    // A hostile checkout that guesses the temp name plants a symlink there just before the open.
    const spy = mock.method(fs, 'openSync', function (this: unknown, p: fs.PathLike, f?: unknown, m?: unknown) {
      if (typeof p === 'string' && p.endsWith('.tmp')) {
        names.push(path.basename(p));
        flags.push(f);
        if (names.length === 1) fs.symlinkSync(target, p);
      }
      return real.call(fs, p as string, f as fs.OpenMode, m as fs.Mode);
    });
    try {
      assert.throws(() => writeIfChanged(file, 'secret\n', 0o600), { code: 'EEXIST' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'orig\n', 'the planted symlink target is untouched');
      assert.equal(fs.existsSync(file), false);
      fs.unlinkSync(path.join(dir, names[0]));
      writeIfChanged(file, 'secret\n', 0o600);
    } finally {
      spy.mock.restore();
    }
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1], 'the temp name is not derived from pid and time');
    for (const n of names) assert.match(n, /^config\.json\.[0-9a-f]{16}\.tmp$/);
    assert.deepEqual(flags, ['wx', 'wx']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'secret\n');
    assert.ok(sameMode(fs.statSync(file).mode, 0o600));
    assert.deepEqual(fs.readdirSync(dir), ['config.json'], 'no temp file is left behind');
  });
});
