// Components (config schemaVersion 9): `services` folds into `components`, run and verify pick the
// same commands as before, and validation rejects malformed components and build cycles.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { defaults, loadConfig } from '../lib/config.ts';
import { commandSources } from '../lib/integrity.ts';
import { createJob, jobDir, updateJob } from '../lib/jobs.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import { jobComponent, servicesToComponents } from '../lib/components.ts';
import { commandTemplate, createWorktree } from '../lib/worktree.ts';
import * as yaml from '../lib/yaml.ts';

const SERVICE = { name: 'api', path: 'svc/api', commands: { test: 't' }, owners: ['@a'], notes: 'n' };
const COMPONENT = { ...SERVICE, kind: 'service', dependsOn: [] };

describe('components migration', { concurrency: 4 }, () => {
  test('migration maps services to service components', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 9);
    const { config, from } = migrateConfig({ schemaVersion: 8, services: [structuredClone(SERVICE)] });
    assert.equal(from, 8);
    assert.deepEqual(config, { schemaVersion: 9, components: [COMPONENT] });
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
      assert.deepEqual(JSON.parse(m.stdout).changed, ['.forge/config.yml']);
      const text = fs.readFileSync(cfg, 'utf8');
      assert.match(text, /^schemaVersion: 9$/m);
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
  schemaVersion: 8,
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
      assert.ok(r.log.includes(`\n${fs.realpathSync(apiDir)}\n`), r.log);
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
