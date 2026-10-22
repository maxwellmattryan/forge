// forge release plan's model (issue #190): order, the mechanism step table, release.md with its
// rollback, cycles and the plan hash. Pure: git and member clones are injected, and the run test
// fakes spawn, so nothing here runs a tool or touches a remote.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults } from '../lib/config.ts';
import { type GitReader, type RepoInput, type ReleaseStep, planHash, planRelease, readManifestPackage, releaseFiles, renderReleaseMd, stepsFor, writeReleasePlan } from '../lib/release-plan.ts';
import { releaseStatus, releasedVersionFrom, runRelease } from '../lib/release-run.ts';
import type { Config } from '../lib/types.ts';

// A suite run from a daemon session inherits its marker; this file runs no CLI, so it drops it itself.
delete process.env.FORGE_DAEMON;

const scratch = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-plan-')));
const noGit: GitReader = () => ({ ok: true, stdout: '' });

interface Project {
  root: string;
  lib: string;
  cleanup: () => void;
}

function project(): Project {
  const root = scratch();
  const lib = path.join(root, 'lib-clone');
  fs.mkdirSync(lib);
  return { root, lib, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** defaults() with a root strategy, an optional member `lib` and the root's `app` component depending on lib's. */
function config(rootRelease: Record<string, unknown> | null, libRelease?: Record<string, unknown> | null, edge: 'build' | 'runtime' | 'cycle-build' | 'cycle-runtime' | 'lib-on-app' = 'build'): Config {
  const c = defaults();
  c.release = { ...c.release, ...(rootRelease ?? {}) };
  if (libRelease === undefined) return c;
  c.repos = [{ name: 'lib', remote: 'git@github.com:acme/lib.git', defaultBranch: 'main', ...(libRelease ? { release: libRelease } : {}) } as Config['repos'][number]];
  const type = edge.endsWith('runtime') ? 'runtime' : 'build';
  const lib: any = { name: 'lib', repo: 'lib', path: '.', kind: 'library' };
  const app: any = { name: 'app', repo: null, path: '.', kind: 'service' };
  if (edge === 'lib-on-app') lib.dependsOn = [{ component: 'app', type: 'build' }];
  else app.dependsOn = [{ component: 'lib', type }];
  // A repo cycle without a component cycle (validation refuses those): app -> lib -> tool, app and tool both in the root.
  if (edge.startsWith('cycle')) {
    app.dependsOn = [{ component: 'lib', type: 'build' }];
    lib.dependsOn = [{ component: 'tool', type }];
  }
  c.components = [lib, app, { name: 'tool', repo: null, path: 'tool', kind: 'library' }] as Config['components'];
  return c;
}

const opts = (p: Project) => ({ git: noGit, clone: (name: string) => (name === 'lib' ? { dir: p.lib } : { detail: 'unknown' }) });
const pkg = (dir: string, name: string, version = '1.0.0') => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));

describe('release plan', { concurrency: 4 }, () => {
  test('a two-repo plan orders the library first', () => {
    const p = project();
    try {
      const plan = planRelease(p.root, config({ mechanism: 'tag', command: 'git tag v1' }, { mechanism: 'changesets' }), { kind: 'all' }, opts(p));
      assert.deepEqual(plan.order, ['lib', '(root)']);
      assert.equal(plan.relaxed, false);
      assert.deepEqual(plan.repos.map((r) => r.dir), [p.lib, p.root]);
      assert.equal(plan.repos[0].steps[0].id, 'lib/preflight');
      const flipped = planRelease(p.root, config({ mechanism: 'tag', command: 'git tag v1' }, { mechanism: 'changesets' }, 'lib-on-app'), { kind: 'all' }, opts(p));
      assert.deepEqual(flipped.order, ['(root)', 'lib']);
    } finally {
      p.cleanup();
    }
  });

  test('releasedVersionFrom reads the checked version', () => {
    // The levels: a registry version, then <link>@<v>, then a bare version tag.
    assert.equal(releasedVersionFrom([{ ok: true, tags: ['v1.0.0', 'engine@2.0.0'] }, { ok: true, version: '3.0.0' }], ['engine']), '3.0.0');
    assert.equal(releasedVersionFrom([{ ok: true, tags: ['v1.0.0', 'engine@2.0.0', 'other@4.0.0'] }], ['engine']), '2.0.0');
    assert.equal(releasedVersionFrom([{ ok: true, tags: ['v1.0.0', 'nightly'] }], ['engine']), 'v1.0.0');
    assert.equal(releasedVersionFrom([{ ok: true, tags: ['engine@2.0.0', 'engine@2.0.1'] }], ['engine']), null);
    assert.equal(releasedVersionFrom([{ ok: true, tags: ['v1.0.0-canary.abc', 'engine@-Z'] }], ['engine']), null);
    assert.equal(releasedVersionFrom(undefined, []), null);
  });

  test('steps per mechanism', () => {
    const input = (strategy: Record<string, unknown>, manifest: RepoInput['manifest'] = { name: 'pkg', version: '1.0.0' }): RepoInput => ({
      repo: null,
      dir: path.join(os.tmpdir(), 'r'),
      base: 'main',
      remote: 'origin',
      strategy: strategy as unknown as RepoInput['strategy'],
      manifest,
    });
    const step = (kind: string, argv: string[] | null, publish: boolean, check: ReleaseStep['check'], extra: Partial<ReleaseStep> = {}) => ({ id: `(root)/${kind}`, repo: null, kind, argv, shell: null, manual: null, publish, check, ...extra });
    const preflight = step('preflight', null, false, 'ready');
    const npmPublish = step('publish', ['npm', 'publish'], true, 'registry');
    const cargoPublish = step('publish', ['cargo', 'publish'], true, 'registry');
    const tagRelease = step('release', null, true, 'tag-pushed', { shell: 'git tag v1 && git push origin v1' });
    const cargoRelease = (check: ReleaseStep['check']) => [
      step('publish', ['cargo', 'release', 'publish', '--execute', '--no-confirm'], true, check),
      step('tag', ['cargo', 'release', 'tag', '--execute', '--no-confirm'], false, 'tagged'),
      step('push', ['cargo', 'release', 'push', '--execute', '--no-confirm'], true, 'tag-pushed'),
    ];
    const rp = [
      step('merge', null, true, 'remote-tagged', { manual: "Merge (root)'s open release-please PR on GitHub; its workflow tags the release." }),
      step('sync', ['git', 'merge', '--ff-only', 'origin/main'], false, 'at-remote'),
    ];
    const tag = { mechanism: 'tag', command: 'git tag v1 && git push origin v1' };
    const rows: [string, Record<string, unknown>, unknown[]][] = [
      ['tag, no registry', tag, [preflight, tagRelease]],
      ['tag, registry none', { ...tag, registry: 'none' }, [preflight, tagRelease]],
      ['tag, npm', { ...tag, registry: 'npm' }, [preflight, tagRelease, npmPublish]],
      ['tag, crates.io', { ...tag, registry: 'crates.io' }, [preflight, tagRelease, cargoPublish]],
      ['cargo-release', { mechanism: 'cargo-release' }, [preflight, ...cargoRelease('registry')]],
      ['cargo-release, crates.io', { mechanism: 'cargo-release', registry: 'crates.io' }, [preflight, ...cargoRelease('registry')]],
      ['cargo-release, registry none', { mechanism: 'cargo-release', registry: 'none' }, [preflight, ...cargoRelease(null)]],
      [
        'changesets',
        { mechanism: 'changesets', registry: 'npm' },
        [
          preflight,
          step('version', ['changeset', 'version'], false, null),
          step('stage', ['git', 'add', '--all'], false, null),
          step('commit', ['git', 'commit', '--message', 'Version packages'], false, 'clean'),
          step('publish', ['changeset', 'publish'], true, 'tagged'),
          step('push', ['git', 'push', '--follow-tags', 'origin', 'HEAD:refs/heads/main'], true, 'tag-pushed'),
        ],
      ],
      ['release-please, no registry', { mechanism: 'release-please' }, [preflight, ...rp]],
      ['release-please, npm', { mechanism: 'release-please', registry: 'npm' }, [preflight, ...rp, npmPublish]],
      ['release-please, crates.io', { mechanism: 'release-please', registry: 'crates.io' }, [preflight, ...rp, cargoPublish]],
    ];
    for (const [name, strategy, want] of rows) {
      const got = stepsFor(input(strategy));
      for (const s of got) assert.ok(s.title.length > 0, `${name}: ${s.id} has a title`);
      assert.deepEqual(got.map(({ title: _t, ...s }) => s), want, name);
    }
    const noPkg = stepsFor(input({ mechanism: 'tag', command: 'git tag v1', registry: 'npm' }, { reason: 'package.json is private' }));
    assert.deepEqual(noPkg.at(-1), { ...npmPublish, title: noPkg.at(-1)!.title, check: null, note: 'no registry check: package.json is private; check by hand' });
  });

  test('manifests name the root package, or say why there is none', () => {
    const d = scratch();
    try {
      assert.deepEqual(readManifestPackage(d, 'npm'), { reason: 'no package.json at the clone root' });
      pkg(d, '@acme/lib', '2.1.0-rc.1');
      assert.deepEqual(readManifestPackage(d, 'npm'), { name: '@acme/lib', version: '2.1.0-rc.1' });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['a'] }));
      assert.match((readManifestPackage(d, 'npm') as { reason: string }).reason, /private/);
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: '--registry=evil', version: '1.0.0' }));
      assert.deepEqual(readManifestPackage(d, 'npm'), { reason: 'package.json has no valid name' });
      for (const name of ['-v', '@-x/y', '-'])
        fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0' })), assert.deepEqual(readManifestPackage(d, 'npm'), { reason: 'package.json has no valid name' }, name);
      fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname = "--offline"\nversion = "1.0.0"\n');
      assert.deepEqual(readManifestPackage(d, 'cargo'), { reason: 'Cargo.toml has no valid [package] name' });
      fs.writeFileSync(path.join(d, 'Cargo.toml'), '[workspace.package]\nversion = "9.9.9"\n[package]\nname = "bbx_core" # the core\nversion = "0.4.1"\n[dependencies]\nname = "x"\n');
      assert.deepEqual(readManifestPackage(d, 'cargo'), { name: 'bbx_core', version: '0.4.1' });
      fs.writeFileSync(path.join(d, 'Cargo.toml'), '[workspace]\nmembers = ["a"]\n');
      assert.deepEqual(readManifestPackage(d, 'cargo'), { reason: 'Cargo.toml is a workspace with no root package' });
      fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname = "a"\nversion.workspace = true\n');
      assert.deepEqual(readManifestPackage(d, 'cargo'), { reason: 'the [package] version comes from the workspace' });
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('release.md renders steps and reverse-order rollback', () => {
    const p = project();
    try {
      pkg(p.lib, 'acme-lib', '1.2.3');
      fs.writeFileSync(path.join(p.root, 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n');
      const c = config({ mechanism: 'release-please', registry: 'crates.io', cadence: 'on-merge' }, { mechanism: 'changesets', registry: 'npm' });
      c.repos.push({ name: 'docs', remote: 'git@github.com:acme/docs.git', defaultBranch: 'main' } as Config['repos'][number]);
      const plan = planRelease(p.root, c, { kind: 'all' }, { git: noGit, clone: (n) => (n === 'lib' ? { dir: p.lib } : { detail: 'missing clone at ../docs' }) });
      const md = renderReleaseMd(plan, c);
      const lines = md.split('\n');
      assert.equal(lines[0], '# Release plan');
      assert.match(lines[2], new RegExp(`^Selection: every repo · planned \\S+ · plan ${plan.hash.slice(0, 12)}$`));
      assert.equal(lines[3], 'Order: lib, (root) (dependencies first)');
      const headings = lines.filter((l) => l.startsWith('#'));
      assert.deepEqual(headings, ['# Release plan', '## 1. lib (changesets → npm)', '## 2. (root) (release-please → crates.io)', '## Not released', '## Rollback', '### (root)', '### lib']);
      assert.ok(md.includes('Directory: `' + p.lib + '` · version 1.2.3 · cadence undeclared'));
      assert.ok(md.includes('> Cadence on-merge usually releases from CI; steps CI already did are skipped by their checks.'));
      assert.ok(md.includes('5. `lib/publish` · **publish** — '));
      assert.ok(md.includes('   ```sh\n   git push --follow-tags origin HEAD:refs/heads/main\n   ```'));
      assert.ok(md.includes("   ```sh\n   Merge (root)'s open release-please PR on GitHub; its workflow tags the release.\n   ```"));
      assert.ok(md.includes('- `docs`: clone: missing clone at ../docs'));
      assert.ok(md.includes('- `(root)`: no release.mechanism') === false, 'the root releases');
      const rollback = md.slice(md.indexOf('## Rollback'));
      const rootRb = rollback.slice(rollback.indexOf('### (root)'), rollback.indexOf('### lib'));
      const libRb = rollback.slice(rollback.indexOf('### lib'));
      assert.ok(rootRb.indexOf('cargo yank --version <version> app') < rootRb.indexOf("revert the release PR's merge commit on main in a new PR"), 'reverse step order: the publish before the merge');
      assert.ok(rootRb.includes('crates.io never deletes a version; a yank stops new lockfiles from picking it'));
      assert.ok(libRb.includes('`git push origin --delete refs/tags/<tag>`, then `git tag --delete <tag>`, and delete its GitHub Release if one was made: `gh release delete <tag>`'));
      assert.ok(libRb.includes('`git revert --no-edit <release commit>`, then `git push origin HEAD:refs/heads/main`'));
      assert.ok(libRb.includes('`npm deprecate acme-lib@<version> "<reason>"`; `npm unpublish acme-lib@<version>` only works within 72 hours of publishing and when no other public package depends on it'));
      assert.ok(libRb.indexOf('git push origin --delete') < libRb.indexOf('npm deprecate'), 'the push before the publish');
    } finally {
      p.cleanup();
    }
  });

  test('config text stays fenced', () => {
    const p = project();
    try {
      const command = 'echo ``` <script>alert(1)</script> `x` # Heading && git tag v1';
      const c = config({ mechanism: 'tag', command });
      const md = renderReleaseMd(planRelease(p.root, c, { kind: 'all' }, opts(p)), c);
      assert.ok(md.includes(`   \`\`\`\`sh\n   ${command}\n   \`\`\`\``), 'a fence longer than the command\'s backtick runs');
      const outside = md.split(/^ {3}````sh\n[\s\S]*?^ {3}````$/m).join('');
      assert.ok(!outside.includes('<script>'), 'no command text outside its fence');
      assert.deepEqual(outside.split('\n').filter((l) => l.startsWith('#')), ['# Release plan', '## 1. (root) (tag → no registry)', '## Rollback', '### (root)']);
    } finally {
      p.cleanup();
    }
  });

  test('cycles: build refuses, runtime relaxes', () => {
    const p = project();
    try {
      const strategies = [{ mechanism: 'tag', command: 'git tag v1' }, { mechanism: 'changesets' }] as const;
      assert.throws(() => planRelease(p.root, config(strategies[0], strategies[1], 'cycle-build'), { kind: 'all' }, opts(p)), {
        message: "the components' dependsOn form a cycle between (root), lib; a release needs an order",
      });
      const c = config(strategies[0], strategies[1], 'cycle-runtime');
      const plan = planRelease(p.root, c, { kind: 'all' }, opts(p));
      assert.equal(plan.relaxed, true);
      assert.deepEqual(plan.order, ['lib', '(root)']);
      assert.ok(renderReleaseMd(plan, c).includes('Order: lib, (root) (dependencies first) · runtime edges ignored: they formed a cycle'));
    } finally {
      p.cleanup();
    }
  });

  test('--job plans merged dependencies of an interim edge', () => {
    const p = project();
    try {
      const strategies = [{ mechanism: 'tag', command: 'git tag v1' }, { mechanism: 'changesets' }] as const;
      const writeJob = (rootState: string, libState: string) => {
        const dir = path.join(p.root, '.forge', 'jobs', 'j1');
        fs.mkdirSync(dir, { recursive: true });
        const job = { id: 'j1', pr: { number: 11, state: rootState }, repos: [{ repo: null }, { repo: 'lib', base: 'main', pr: { number: 7, state: libState } }] };
        fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
      };
      const c = config(strategies[0], strategies[1]);
      // The root consumes lib: its unmerged PR waits on lib's release, so it is skipped, not refused.
      writeJob('OPEN', 'MERGED');
      const plan = planRelease(p.root, c, { kind: 'job', job: 'j1' }, opts(p));
      assert.deepEqual(plan.order, ['lib']);
      assert.deepEqual(plan.skipped, [{ repo: null, label: '(root)', reason: "PR not merged: it waits on its dependencies' release" }]);
      // An unmerged dependency (no consumer) is still refused.
      writeJob('MERGED', 'OPEN');
      assert.throws(() => planRelease(p.root, c, { kind: 'job', job: 'j1' }, opts(p)), { message: 'forge release plan --job j1: lib have no merged PR; run forge pr sync j1 first' });
      writeJob('OPEN', 'OPEN');
      assert.throws(() => planRelease(p.root, c, { kind: 'job', job: 'j1' }, opts(p)), { message: 'forge release plan --job j1: lib have no merged PR; run forge pr sync j1 first' });
      // Every unmerged PR a consumer (lib and the root on each other), and none merged: nothing to plan.
      writeJob('OPEN', 'OPEN');
      assert.throws(() => planRelease(p.root, config(strategies[0], strategies[1], 'cycle-build'), { kind: 'job', job: 'j1' }, opts(p)), { message: 'forge release plan --job j1: no PR of the job is merged yet' });
      writeJob('MERGED', 'MERGED');
      assert.deepEqual(planRelease(p.root, c, { kind: 'job', job: 'j1' }, opts(p)).order, ['lib', '(root)']);
    } finally {
      p.cleanup();
    }
  });

  test('plan hash', () => {
    const p = project();
    try {
      pkg(p.root, 'app');
      const hash = (c: Config, git: GitReader = noGit) => planRelease(p.root, c, { kind: 'all' }, { ...opts(p), git }).hash;
      const base = { mechanism: 'tag', command: 'git tag v1', registry: 'npm' };
      const h = hash(config(base, { mechanism: 'changesets' }));
      assert.match(h, /^[0-9a-f]{64}$/);
      assert.equal(hash(config(base, { mechanism: 'changesets' })), h, 'stable across re-plans');
      let head = 0;
      const moving: GitReader = (_d, args) => ({ ok: true, stdout: args[0] === 'rev-parse' ? `${++head}`.repeat(40) : '' });
      assert.equal(hash(config(base, { mechanism: 'changesets' }), moving), h, 'HEAD is not part of it');
      pkg(p.root, 'app', '1.0.1');
      assert.equal(hash(config(base, { mechanism: 'changesets' })), h, 'manifest versions are not part of it');
      assert.notEqual(hash(config({ ...base, registry: 'crates.io' }, { mechanism: 'changesets' })), h, 'a release key');
      assert.notEqual(hash(config({ ...base, command: 'git tag v2' }, { mechanism: 'changesets' })), h, 'release.command');
      assert.notEqual(hash(config(base, { mechanism: 'changesets', registry: 'none' })), h, "a member's release key");
      assert.notEqual(hash(config(base, { mechanism: 'changesets' }, 'lib-on-app')), h, 'the order');
    } finally {
      p.cleanup();
    }
  });

  test('a planted selection is refused before git runs', async () => {
    const p = project();
    try {
      fs.mkdirSync(path.join(p.root, '.forge'));
      pkg(p.root, 'app');
      const c = config({ mechanism: 'tag', command: 'git tag v1' });
      writeReleasePlan(p.root, c, { kind: 'all' }, opts(p));
      const files = releaseFiles(p.root);
      const good = JSON.parse(fs.readFileSync(files.json, 'utf8'));
      const calls: string[][] = [];
      const git: GitReader = (_d, args) => (calls.push(args), { ok: true, stdout: '' });
      // A self-consistent hash: the selection is what an attacker who can write .forge/runtime/ controls.
      const plant = (selection: unknown) => {
        const planted = { ...good, selection };
        planted.hash = planHash(planted);
        fs.writeFileSync(files.json, JSON.stringify(planted));
      };
      const cases: [unknown, RegExp][] = [
        [{ kind: 'since', tag: '--output=x' }, /selection\.tag "--output=x" is not a safe tag name.*re-run forge release plan/],
        [{ kind: 'since', tag: '-x' }, /is not a safe tag name/],
        [{ kind: 'job', job: '../../x' }, /selection\.job "\.\.\/\.\.\/x" is not a valid job id; re-run forge release plan/],
        [{ kind: 'job', job: '-x' }, /is not a valid job id/],
      ];
      for (const [selection, err] of cases) {
        plant(selection);
        assert.throws(() => releaseStatus(p.root, c, { ...opts(p), git }), err);
        if (process.platform !== 'win32') await assert.rejects(runRelease(p.root, c, { ...opts(p), git, interactive: false, confirm: async () => false, echo: () => {} }), err);
      }
      assert.deepEqual(calls, [], 'no git command ran');
      for (const d of [p.root, p.lib, process.cwd()]) assert.deepEqual(fs.readdirSync(d).filter((f) => f.startsWith('--output')), [], d);
      assert.equal(fs.existsSync(files.state), false);
    } finally {
      p.cleanup();
    }
  });

  test('plan --force discards an unreadable state.json', () => {
    const p = project();
    try {
      fs.mkdirSync(path.join(p.root, '.forge'));
      pkg(p.root, 'app');
      const c = config({ mechanism: 'tag', command: 'git tag v1' });
      writeReleasePlan(p.root, c, { kind: 'all' }, opts(p));
      const files = releaseFiles(p.root);
      for (const bad of ['{not json', JSON.stringify({ version: 99 })]) {
        fs.writeFileSync(files.state, bad);
        assert.throws(() => writeReleasePlan(p.root, c, { kind: 'all' }, opts(p)), /re-run forge release plan --force/);
        assert.ok(fs.existsSync(files.state), 'without --force it stays');
        const lines: string[] = [];
        writeReleasePlan(p.root, c, { kind: 'all' }, { ...opts(p), force: true, log: (l) => lines.push(l) });
        assert.equal(fs.existsSync(files.state), false);
        assert.deepEqual(lines, [`forge release plan: --force discarded an unreadable ${files.state}`]);
      }
    } finally {
      p.cleanup();
    }
  });

  test('two takeovers of one stale lock: exactly one wins', { timeout: 60_000 }, async () => {
    const p = project();
    try {
      const lock = path.join(p.root, '.forge', 'locks', 'release');
      fs.mkdirSync(lock, { recursive: true });
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: dead, startedAt: new Date().toISOString() }));
      const go = path.join(p.root, 'go');
      const mod = new URL('../lib/release-run.ts', import.meta.url).href;
      // Each child waits for the go file, takes the lock once and holds it until its stdin closes, so
      // neither sees the other's lock as a dead owner's.
      const script = `import fs from 'node:fs';
const { takeReleaseLock } = await import(${JSON.stringify(mod)});
process.stdout.write('ready\\n');
while (!fs.existsSync(${JSON.stringify(go)})) {}
let out;
try { takeReleaseLock(${JSON.stringify(p.root)}); out = 'won'; } catch (e) { out = e.code === 'owned' ? 'owned' : 'error ' + e.message; }
process.stdout.write(out + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));`;
      const kids = [0, 1].map(() => spawnChild(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] }));
      const lines = kids.map((k) => {
        let buf = '';
        const want = (n: number) => new Promise<string[]>((resolve, reject) => {
          const check = () => {
            const l = buf.split('\n').filter(Boolean);
            if (l.length >= n) resolve(l);
          };
          k.stdout!.on('data', (d) => ((buf += d), check()));
          k.on('exit', (code) => reject(new Error(`child exited ${code}: ${buf}`)));
          check();
        });
        return want;
      });
      await Promise.all(lines.map((w) => w(1)));
      fs.writeFileSync(go, '');
      const results = (await Promise.all(lines.map((w) => w(2)))).map((l) => l[1]).sort();
      for (const k of kids) k.stdin!.end();
      await Promise.all(kids.map((k) => new Promise((r) => (k.exitCode !== null ? r(null) : k.on('exit', r)))));
      assert.deepEqual(results, ['owned', 'won']);
      const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      assert.ok(kids.some((k) => k.pid === owner.pid), 'the winner owns the lock');
      assert.deepEqual(fs.readdirSync(path.dirname(lock)).filter((f) => f.startsWith('release.')), [], 'no dir left aside');
    } finally {
      p.cleanup();
    }
  });

  test('confirm answers', { skip: process.platform === 'win32' ? 'forge release run refuses native Windows' : false }, async () => {
    const p = project();
    try {
      fs.mkdirSync(path.join(p.root, '.forge'));
      const c = config({ mechanism: 'tag', command: 'git tag v1' });
      let tagged = false;
      const git: GitReader = (_dir, args) => {
        const a = args.join(' ');
        if (a === 'symbolic-ref --quiet --short HEAD') return { ok: true, stdout: 'main\n' };
        if (a === 'rev-parse --verify --quiet HEAD^{commit}' || a === 'rev-parse --verify --quiet refs/remotes/origin/main^{commit}') return { ok: true, stdout: 'a'.repeat(40) };
        if (a === 'tag --points-at HEAD') return { ok: true, stdout: tagged ? 'v1\n' : '' };
        if (a === 'ls-remote origin refs/heads/main') return { ok: true, stdout: `${'a'.repeat(40)}\trefs/heads/main\n` };
        if (a === 'rev-parse --verify --quiet refs/tags/v1') return { ok: tagged, stdout: tagged ? 'b'.repeat(40) : '' };
        if (a === 'ls-remote --tags origin refs/tags/v1') return { ok: true, stdout: tagged ? `${'b'.repeat(40)}\trefs/tags/v1\n` : '' };
        return { ok: true, stdout: '' };
      };
      const calls: string[][] = [];
      const spawn = ((cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
          tagged = true;
          child.stdout.emit('data', Buffer.from('tagged\n'));
          child.emit('close', 0);
        });
        return child;
      }) as any;
      const clone = () => ({ detail: 'none' });
      writeReleasePlan(p.root, c, { kind: 'all' }, { git, clone });
      const prompts: string[] = [];
      const run = (answer: boolean, interactive = true) =>
        runRelease(p.root, c, { interactive, git, clone, spawn, echo: () => {}, confirm: async (q) => (prompts.push(q), answer) });
      const none = await run(true, false);
      assert.equal(none.data.stopped?.reason, 'needs_confirmation');
      assert.equal(prompts.length, 0, 'no TTY: nothing is asked');
      const no = await run(false);
      assert.equal(no.exitCode, 1);
      assert.deepEqual(no.data.stopped && { step: no.data.stopped.step, reason: no.data.stopped.reason }, { step: '(root)/release', reason: 'declined' });
      assert.equal(prompts[0], `Publish step (root)/release in ${p.root}:\n  git tag v1\nRun it? [y/N] `);
      assert.equal(calls.length, 0, '"n" runs nothing');
      const yes = await run(true);
      assert.equal(yes.exitCode, 0);
      assert.deepEqual(yes.data.ran, ['(root)/release']);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(1), ['-lc', 'git tag v1']);
      assert.equal(yes.data.done, yes.data.total);
    } finally {
      p.cleanup();
    }
  });
});
