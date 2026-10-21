// Components (config schemaVersion 10): `services` folds into `components`, run and verify pick the
// same commands as before, and validation rejects malformed components and build cycles.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { commandSources } from '../lib/integrity.ts';
import { createJob, jobDir, updateJob } from '../lib/jobs.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import { buildCycles, jobComponent, servicesToComponents } from '../lib/components.ts';
import { commandTemplate, createWorktree } from '../lib/worktree.ts';
import * as yaml from '../lib/yaml.ts';

const SERVICE = { name: 'api', path: 'svc/api', commands: { test: 't' }, owners: ['@a'], notes: 'n' };
const COMPONENT = { ...SERVICE, kind: 'service', dependsOn: [] };

describe('components migration', { concurrency: 4 }, () => {
  test('migration maps services to service components', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 28);
    const { config, from } = migrateConfig({ schemaVersion: 9, services: [structuredClone(SERVICE)] });
    assert.equal(from, 9);
    assert.deepEqual(config, { schemaVersion: 28, components: [COMPONENT], repos: [], downstream: { enabled: true, max: 5, skip: [] } });
    assert.equal('services' in config, false);
    assert.deepEqual(servicesToComponents({ services: [{ name: 'web' }, { name: 'x', path: '' }] }).components, [
      { name: 'web', path: '.', kind: 'service', dependsOn: [] },
      { name: 'x', path: '.', kind: 'service', dependsOn: [] },
    ]);
    // Pure and idempotent; a config that already has components is left alone.
    const once = servicesToComponents({ services: [SERVICE] });
    assert.deepEqual(servicesToComponents(once), once);
    const both = { services: [SERVICE], components: [] };
    assert.equal(servicesToComponents(both), both);
    // A bad entry is kept for validation to name.
    assert.deepEqual(servicesToComponents({ services: ['nope'] }).components, ['nope']);
    // An unversioned config that still says services folds the same way.
    assert.deepEqual(migrateConfig({ services: [structuredClone(SERVICE)] }).config.components, [COMPONENT]);
  });

  test('a v8 services config loads and migrates to components', async () => {
    const repo = tempRepo();
    try {
      const cfg = path.join(repo.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, yaml.stringify({ schemaVersion: 8, tracker: { kind: 'none' }, services: [SERVICE] }));
      const loaded = loadConfig(repo.dir);
      assert.equal(loaded.migratedFrom, 8);
      assert.deepEqual(loaded.config.components, [COMPONENT]);
      assert.equal('services' in loaded.config, false);
      assert.equal('services' in defaults(), false);
      const m = await forgeAsync(repo.dir, ['migrate']);
      assert.equal(m.status, 0, m.stderr);
      assert.deepEqual(JSON.parse(m.stdout).changed, [path.join('.forge', 'config.yml')]);
      const text = fs.readFileSync(cfg, 'utf8');
      assert.match(text, /^schemaVersion: 28$/m);
      assert.match(text, /^components:$/m);
      assert.doesNotMatch(text, /^services:/m);
      assert.deepEqual(yaml.parse(text).components, [COMPONENT]);
    } finally {
      repo.cleanup();
    }
  });
});

/**
 * A scratch repo with `svc/api` committed and `config` written as `.forge/config.yml`; `job(services)`
 * makes a round-1 job with a worktree that names those services.
 */
function scratch(config: Record<string, unknown>) {
  const repo = tempRepo();
  const root = repo.dir;
  fs.mkdirSync(path.join(root, 'svc', 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'svc', 'api', 'README.md'), 'api\n');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', '.gitignore'), 'jobs/\nlocks/\nruntime/\n');
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify({ tracker: { kind: 'none' }, worktrees: { root: `../${path.basename(root)}.wt` }, ...config }));
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'scratch');
  let n = 0;
  return {
    root,
    job(services: string[]) {
      const { config: c } = loadConfig(root);
      const id = createJob(root, c, { title: `job ${++n}` }).id;
      const wt = createWorktree(root, c, id);
      assert.equal(wt.ok, true, JSON.stringify(wt));
      updateJob(root, id, (j) => {
        j.round = 1;
        j.services = services;
      });
      return { id, wt: wt.path as string };
    },
    /** The cwd and output `forge run`'s log recorded. */
    async run(id: string, name: string) {
      const r = await forgeAsync(root, ['run', id, name]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const out = JSON.parse(r.stdout);
      const log = fs.readFileSync(path.join(jobDir(root, id), out.log), 'utf8');
      return { cwd: log.match(/^\(cwd (.*)\)$/m)![1], log };
    },
    cleanup() {
      repo.cleanup();
      fs.rmSync(`${root}.wt`, { recursive: true, force: true });
    },
  };
}

// Prints which template ran and where; the log's `(cwd …)` line says where Forge started it.
const V8 = {
  schemaVersion: 9,
  commands: { test: 'echo TOP-TEST && pwd', lint: 'echo TOP-LINT && pwd' },
  services: [{ name: 'api', path: 'svc/api', commands: { test: 'echo API-TEST && pwd' } }, { name: 'web', path: 'web' }],
};

describe('components in run and verify', { concurrency: 4 }, () => {
  test('a migrated services config runs the same commands from the same path', async () => {
    const x = scratch(V8);
    try {
      const { config } = loadConfig(x.root);
      const one = x.job(['api']);
      const jobOf = (services: string[]) => ({ services }) as any;
      assert.equal(commandTemplate(config, jobOf(['api']), 'test'), 'echo API-TEST && pwd');
      assert.equal(commandTemplate(config, jobOf(['api']), 'lint'), 'echo TOP-LINT && pwd', 'falls back to the top-level command');
      for (const s of [[], ['api', 'web'], ['nope']]) assert.equal(commandTemplate(config, jobOf(s), 'test'), 'echo TOP-TEST && pwd', JSON.stringify(s));

      const apiDir = path.join(one.wt, 'svc', 'api');
      let r = await x.run(one.id, 'test');
      assert.equal(r.cwd, apiDir);
      assert.match(r.log, /API-TEST/);
      // `pwd` prints the MSYS form (/tmp/…) under Git Bash on Windows, so match its trailing segments.
      assert.match(r.log.replaceAll('\\', '/'), /^[^\n(]*\/svc\/api\r?$/m, r.log);
      r = await x.run(one.id, 'lint');
      assert.equal(r.cwd, apiDir, 'a fallback command still runs from the component');
      assert.match(r.log, /TOP-LINT/);
      for (const s of [[], ['api', 'web'], ['nope']]) {
        const j = x.job(s);
        const out = await x.run(j.id, 'test');
        assert.equal(out.cwd, j.wt, JSON.stringify(s));
        assert.match(out.log, /TOP-TEST/);
      }
    } finally {
      x.cleanup();
    }
  });

  test("verify uses the job's single component", async () => {
    const x = scratch({ ...V8, verify: ['test'] });
    try {
      const j = x.job(['api']);
      const r = await forgeAsync(x.root, ['verify', j.id]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const logs = fs.readdirSync(path.join(jobDir(x.root, j.id), 'logs')).filter((f) => f.startsWith('verify-test-'));
      assert.equal(logs.length, 1);
      const log = fs.readFileSync(path.join(jobDir(x.root, j.id), 'logs', logs[0]), 'utf8');
      assert.ok(log.includes(`\n(cwd ${path.join(j.wt, 'svc', 'api')})\n`), log);
      assert.match(log, /API-TEST/);
    } finally {
      x.cleanup();
    }
  });

  test('a component in another repo is not selected', async () => {
    const x = scratch({
      commands: { test: 'echo TOP-TEST && pwd' },
      components: [{ name: 'api', repo: 'other', path: 'svc/api', kind: 'service', commands: { test: 'bash ./other.sh' } }],
    });
    try {
      const { config } = loadConfig(x.root);
      assert.equal(jobComponent(config, { services: ['api'] }), null);
      assert.equal(jobComponent({ components: [{ ...config.components[0], repo: null }] }, { services: ['api'] })?.name, 'api', 'repo: null is the root repo');
      assert.deepEqual(commandSources(config), []);
      assert.deepEqual(commandSources({ commands: config.commands, components: [{ ...config.components[0], repo: null }] }), ['svc/api/other.sh']);
      const j = x.job(['api']);
      const r = await x.run(j.id, 'test');
      assert.equal(r.cwd, j.wt);
      assert.match(r.log, /TOP-TEST/);
    } finally {
      x.cleanup();
    }
  });
});

const lib = (name: string, extra: Record<string, unknown> = {}) => ({ name, path: `libs/${name}`, kind: 'library', ...extra });
const dep = (component: string, type = 'build') => ({ component, type });
/** validateConfig over defaults() with these components, keeping only the components problems. */
const problemsFor = (components: unknown, extra: Record<string, unknown> = {}) =>
  validateConfig({ ...defaults(), ...extra, components }, process.cwd()).filter((p) => /^(components|services)\b/.test(p));

describe('components validation', { concurrency: 4 }, () => {
  test('validation reports each malformed component', () => {
    const valid = [
      { name: 'core', repo: null, path: 'crates/core', kind: 'library', commands: { test: 'cargo test', dev: null }, owners: ['@team-core'], notes: null },
      { name: 'api', path: 'svc/api', kind: 'service', dependsOn: [dep('core'), dep('web', 'runtime'), { backing: 'postgres', type: 'runtime' }] },
      { name: 'web', path: '.', kind: 'app', dependsOn: [dep('core'), dep('api', 'runtime')] },
    ];
    assert.deepEqual(problemsFor(valid), []);
    assert.deepEqual(validateConfig({ ...defaults(), components: valid }, process.cwd()), [], 'the whole config is valid');
    const cases: [string, unknown, RegExp][] = [
      ['non-list components', { core: {} }, /^components must be a list \(got \{"core":\{\}\}\)$/],
      ['non-map entry', ['core'], /^components\[0\] must be a map$/],
      ['missing name', [{ path: 'x', kind: 'library' }], /^components\[0\]\.name must .*\(got nothing\)$/],
      ['name failing SAFE_REF', [lib('a;rm -rf')], /^components\[0\]\.name must .*"a;rm -rf"/],
      ['duplicate name', [lib('a'), lib('a')], /^components "a" is listed more than once$/],
      ['missing path', [{ name: 'a', kind: 'library' }], /^components "a"\.path must be a relative path inside the repo \(got nothing\)$/],
      ['absolute path', [lib('a', { path: '/etc' })], /^components "a"\.path must be a relative path inside the repo \(got "\/etc"\)$/],
      ['../x path', [lib('a', { path: '../x' })], /^components "a"\.path must be a relative path/],
      ['a/../../x path', [lib('a', { path: 'a/../../x' })], /^components "a"\.path must be a relative path/],
      ['bad kind', [lib('a', { kind: 'daemon' })], /^components "a"\.kind must be one of library \| service \| app \(got "daemon"\)$/],
      ['non-list dependsOn', [lib('a', { dependsOn: 'b' })], /^components "a"\.dependsOn must be a list/],
      ['entry with neither target', [lib('a', { dependsOn: [{ type: 'build' }] })], /^components "a"\.dependsOn\[0\] must name exactly one of component or backing$/],
      ['entry with both', [lib('a'), lib('b', { dependsOn: [{ component: 'a', backing: 'pg', type: 'build' }] })], /^components "b"\.dependsOn\[0\] must name exactly one of component or backing$/],
      ['bad type', [lib('a'), lib('b', { dependsOn: [dep('a', 'link')] })], /^components "b"\.dependsOn\[0\]\.type must be one of build \| runtime \(got "link"\)$/],
      ['unknown component target', [lib('a', { dependsOn: [dep('ghost')] })], /^components "a"\.dependsOn\[0\] names unknown component "ghost"$/],
      ['non-string owners entry', [lib('a', { owners: ['@a', 3] })], /^components "a"\.owners must be a list of strings/],
      ['command value that is a number', [lib('a', { commands: { test: 1 } })], /^components "a"\.commands\.test must be a string or null \(got 1\)$/],
      // Beyond AC8's list: the other shape rules.
      ['backslash path', [lib('a', { path: '\\share' })], /^components "a"\.path must/],
      ['drive-letter path', [lib('a', { path: 'C:x' })], /^components "a"\.path must/],
      ['backslash .. segment', [lib('a', { path: 'a\\..\\..\\x' })], /^components "a"\.path must/],
      ['empty path', [lib('a', { path: '' })], /^components "a"\.path must/],
      ['non-string repo', [lib('a', { repo: 3 })], /^components "a"\.repo must be a string or null/],
      ['non-list owners', [lib('a', { owners: '@a' })], /^components "a"\.owners must be a list of strings/],
      ['non-map commands', [lib('a', { commands: ['x'] })], /^components "a"\.commands must be a map/],
      ['non-string notes', [lib('a', { notes: 1 })], /^components "a"\.notes must be a string or null/],
      ['empty target', [lib('a', { dependsOn: [{ backing: '', type: 'runtime' }] })], /^components "a"\.dependsOn\[0\]\.backing must be a non-empty string/],
      ['non-map dependsOn entry', [lib('a', { dependsOn: ['b'] })], /^components "a"\.dependsOn\[0\] must name exactly one/],
      ['runtime self edge', [lib('a', { dependsOn: [dep('a', 'runtime')] })], /^components "a"\.dependsOn\[0\] names unknown component "a"$/],
    ];
    for (const [what, components, re] of cases) {
      const got = problemsFor(components);
      assert.equal(got.length, 1, `${what}: ${JSON.stringify(got)}`);
      assert.match(got[0], re, what);
    }
  });

  test('build dependency cycles are rejected, runtime cycles are not', () => {
    const ring = (type: (i: number) => string) => ['a', 'b', 'c'].map((n, i, all) => lib(n, { dependsOn: [dep(all[(i + 1) % 3], type(i))] }));
    // Listed out of order, so the report's start comes from sorting, not from the list.
    const built = ring(() => 'build');
    assert.deepEqual(problemsFor([built[1], built[2], built[0]]), ['components: build dependency cycle a -> b -> c -> a']);
    assert.deepEqual(problemsFor([lib('a', { dependsOn: [dep('a')] })]), ['components: build dependency cycle a -> a']);
    assert.deepEqual(problemsFor(ring(() => 'runtime')), []);
    assert.deepEqual(problemsFor(ring((i) => (i === 1 ? 'runtime' : 'build'))), []);
    const two = [...built, lib('x', { dependsOn: [dep('y')] }), lib('y', { dependsOn: [dep('x')] })];
    assert.deepEqual(problemsFor(two), ['components: build dependency cycle a -> b -> c -> a', 'components: build dependency cycle x -> y -> x']);
    assert.deepEqual(buildCycles(two), [['a', 'b', 'c'], ['x', 'y']]);
    assert.deepEqual(buildCycles('nope'), []);
  });

  test('config validate rejects cycles and a leftover services key', async () => {
    const repo = tempRepo();
    try {
      const cfg = path.join(repo.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      const write = (c: Record<string, unknown>) => fs.writeFileSync(cfg, yaml.stringify({ schemaVersion: 10, tracker: { kind: 'none' }, ...c }));
      write({ components: [lib('a', { dependsOn: [dep('b')] }), lib('b', { dependsOn: [dep('a')] })] });
      let r = await forgeAsync(repo.dir, ['config', 'validate']);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout + r.stderr, /components: build dependency cycle a -> b -> a/);
      write({ services: [{ name: 'api', path: 'api' }], components: [lib('a')] });
      r = await forgeAsync(repo.dir, ['config', 'validate']);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout + r.stderr, /services was renamed to components in config schemaVersion 10; move its entries under components and delete services/);
      write({ components: [lib('a')] });
      r = await forgeAsync(repo.dir, ['config', 'validate']);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally {
      repo.cleanup();
    }
  });
});
