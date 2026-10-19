// Per-component job ports (issue #195): one stable port per service or app component, stored in
// job.ports beside job.port, never colliding with other jobs' ports or backing ports.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as b from '../lib/backing.ts';
import { loadConfig } from '../lib/config.ts';
import { createJob, jobDir, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { allocatePorts, portBearing } from '../lib/ports.ts';
import { JOB_SCHEMA_VERSION, cleanPorts, normalizeJob } from '../lib/schema.ts';
import { createWorktree } from '../lib/worktree.ts';
import * as yaml from '../lib/yaml.ts';
import { forgeAsync, repoTemplate } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, verify: ['test'], worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

const COMPONENTS = [
  { name: 'api', path: 'api', kind: 'service' },
  { name: 'web', path: 'web', kind: 'app' },
  { name: 'core', path: 'core', kind: 'library' },
];

/** A scratch repo whose config is edited by `edit`; cleanup removes its worktrees too. */
function scratch(edit: (c: any) => void = () => {}) {
  const r = template();
  const file = path.join(r.dir, '.forge', 'config.yml');
  const c = yaml.parse(fs.readFileSync(file, 'utf8'));
  edit(c);
  fs.writeFileSync(file, yaml.stringify(c));
  const config = loadConfig(r.dir).config;
  cleanups.push(() => (r.cleanup(), fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true })));
  return { dir: r.dir, config, jobFile: (id: string) => path.join(jobDir(r.dir, id), 'job.json') };
}

const inRange = (config: { ports: { base: number; span: number } }, p: number) => p >= config.ports.base && p < config.ports.base + config.ports.span;

describe('job ports', { concurrency: 4 }, () => {
  test('one stable port per service or app component', async () => {
    const s = scratch((c) => (c.components = structuredClone(COMPONENTS)));
    const a = createJob(s.dir, s.config, { title: 'A' }).id;
    const first = createWorktree(s.dir, s.config, a);
    assert.ok(first.created && first.ok);
    const ports = loadJob(s.dir, a).ports;
    assert.deepEqual(Object.keys(ports), ['api', 'web'], 'a library gets no port');
    assert.notEqual(ports.api, ports.web);
    for (const p of Object.values(ports)) assert.ok(inRange(s.config, p), String(p));
    assert.equal(loadJob(s.dir, a).port, ports.api, 'job.port is the first entry');
    assert.deepEqual(first.ports, ports);
    assert.equal(first.port, ports.api);
    const ev = readEvents(s.dir, a).find((e) => e.type === 'worktree')!;
    assert.deepEqual({ port: ev.port, ports: ev.ports }, { port: ports.api, ports });

    const again = createWorktree(s.dir, s.config, a);
    assert.equal(again.created, false);
    assert.deepEqual(again.ports, ports, 'a second create reports the same ports');
    assert.equal(again.port, ports.api);
    assert.deepEqual(loadJob(s.dir, a).ports, ports);

    // The CLI carries both too.
    const shown = JSON.parse((await forgeAsync(s.dir, ['job', 'show', a])).stdout);
    assert.deepEqual({ port: shown.port, ports: shown.ports }, { port: ports.api, ports });

    const bJob = createJob(s.dir, s.config, { title: 'B', services: ['web'] }).id;
    const second = createWorktree(s.dir, s.config, bJob);
    assert.ok(second.created);
    const other = loadJob(s.dir, bJob).ports;
    assert.deepEqual(Object.keys(other), ['web', 'api'], "the job's own component comes first");
    assert.equal(loadJob(s.dir, bJob).port, other.web);
    const all = [ports.api, ports.web, other.api, other.web];
    assert.equal(new Set(all).size, 4, `four distinct ports: ${all.join(', ')}`);

    // An entry keeps its port while it is free; a stale key is dropped; a taken one moves.
    setJob(s.dir, a, { fields: { ports: { api: ports.api, web: other.web, ghost: ports.web } } });
    fs.rmSync(first.path, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'prune'], { cwd: s.dir, stdio: 'pipe' });
    const moved = createWorktree(s.dir, s.config, a);
    assert.ok(moved.created);
    const reconciled = loadJob(s.dir, a).ports;
    assert.equal(reconciled.api, ports.api, 'a free port is kept');
    assert.notEqual(reconciled.web, other.web, 'a port another job holds is not kept');
    assert.deepEqual(Object.keys(reconciled), ['api', 'web'], 'a key naming no entry is dropped');
  });

  test('no components: a single dev port', () => {
    const s = scratch();
    assert.deepEqual(portBearing(s.config, { services: [] }), ['dev']);
    assert.deepEqual(portBearing({ components: [{ name: 'core', path: '.', kind: 'library' }] } as any, { services: [] }), ['dev'], 'only libraries');
    const id = createJob(s.dir, s.config, { title: 'Solo' }).id;
    const res = createWorktree(s.dir, s.config, id);
    assert.ok(res.created);
    const job = loadJob(s.dir, id);
    assert.deepEqual(job.ports, { dev: s.config.ports.base });
    assert.equal(job.port, s.config.ports.base);
  });

  test('a v13 job keeps its port', () => {
    const s = scratch();
    const id = createJob(s.dir, s.config, { title: 'Old' }).id;
    const want = s.config.ports.base + 3;
    const raw = JSON.parse(fs.readFileSync(s.jobFile(id), 'utf8'));
    delete raw.ports;
    fs.writeFileSync(s.jobFile(id), JSON.stringify({ ...raw, schemaVersion: 13, port: want }));
    const loaded = loadJob(s.dir, id);
    assert.equal(loaded.schemaVersion, 14);
    assert.deepEqual(loaded.ports, {}, 'read as not allocated');
    assert.equal(loaded.port, want);
    assert.ok(createWorktree(s.dir, s.config, id).created);
    assert.deepEqual(loadJob(s.dir, id).ports, { dev: want }, 'port becomes the first entry');
    assert.equal(loadJob(s.dir, id).port, want);
    // Taken by then: the job moves instead.
    const other = createJob(s.dir, s.config, { title: 'Other' }).id;
    fs.writeFileSync(s.jobFile(other), JSON.stringify({ ...JSON.parse(fs.readFileSync(s.jobFile(other), 'utf8')), schemaVersion: 13, port: want, ports: undefined }));
    assert.ok(createWorktree(s.dir, s.config, other).created);
    assert.notEqual(loadJob(s.dir, other).port, want);
    assert.equal(loadJob(s.dir, other).port, loadJob(s.dir, other).ports.dev);
  });

  test('job schema 14', () => {
    assert.equal(JOB_SCHEMA_VERSION, 14);
    const v13 = { id: 'x', schemaVersion: 13, port: 4103 };
    const j = normalizeJob(v13);
    assert.equal(j.schemaVersion, 14);
    assert.deepEqual(j.ports, {});
    assert.equal(j.port, 4103);
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 15 })._unsupported, true);
    assert.deepEqual(normalizeJob({ ...v13, schemaVersion: 14, ports: { api: 4100, web: 4101 } }).ports, { api: 4100, web: 4101 });
    for (const hostile of [null, 'x', 7, [4100], { api: '4100' }, { api: 0 }, { api: 70000 }, { api: 4100.5 }, { api: 4100, web: 4100 }, { api: '$(id)' }])
      assert.deepEqual(normalizeJob({ ...v13, schemaVersion: 14, ports: hostile }).ports, {}, JSON.stringify(hostile));
    assert.deepEqual(cleanPorts({ dev: 1, max: 65535 }), { dev: 1, max: 65535 });
  });

  test('job ports and backing ports never collide', () => {
    const PG = { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432] };
    const s = scratch((c) => {
      c.components = structuredClone(COMPONENTS);
      c.backing = [PG];
    });
    const base = s.config.ports.base;
    const a = createJob(s.dir, s.config, { title: 'A' }).id;
    setJob(s.dir, a, { fields: { port: base, ports: { api: base, web: base + 1 } } });
    const bJob = createJob(s.dir, s.config, { title: 'B' }).id;
    const rec = b.allocateBacking(s.dir, s.config, { id: bJob, port: base + 2, ports: { api: base + 2, web: base + 3 } });
    assert.equal(rec.job.ports.postgres['5432'], base + 4, "past A's ports and B's own");
    setJob(s.dir, bJob, { fields: { port: base + 2, ports: { api: base + 2, web: base + 3 } } });
    // A's backing record (forged, as a session could) is taken for every later job port.
    fs.writeFileSync(path.join(jobDir(s.dir, a), 'backing.json'), JSON.stringify({ v: 1, ports: { postgres: { 5432: base + 5 } } }));
    const c = createJob(s.dir, s.config, { title: 'C' }).id;
    const got = allocatePorts(s.dir, s.config, loadJob(s.dir, c));
    assert.deepEqual(got, { api: base + 6, web: base + 7 }, 'skips every job port and every backing port');
    assert.deepEqual(loadJob(s.dir, c).ports, {}, 'allocatePorts records nothing itself');
  });

  test('no free port', async () => {
    const s = scratch((c) => (c.ports = { base: 4300, span: 1 }));
    const a = createJob(s.dir, s.config, { title: 'A' }).id;
    assert.ok(createWorktree(s.dir, s.config, a).created);
    assert.equal(loadJob(s.dir, a).port, 4300);
    const bJob = createJob(s.dir, s.config, { title: 'B' }).id;
    const before = fs.readFileSync(s.jobFile(bJob), 'utf8');
    const r = await forgeAsync(s.dir, ['worktree', 'create', bJob]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no free port in 4300-4300 for .* \(1 needed\): raise ports\.span in \.forge\/config\.yml or finish jobs holding ports/);
    assert.equal(fs.readFileSync(s.jobFile(bJob), 'utf8'), before, 'job.json is unchanged');
    // Two components need two ports: one short is still none.
    const two = scratch((c) => {
      c.ports = { base: 4300, span: 1 };
      c.components = structuredClone(COMPONENTS);
    });
    const id = createJob(two.dir, two.config, { title: 'Two' }).id;
    assert.throws(() => createWorktree(two.dir, two.config, id), /no free port in 4300-4300 for .* \(2 needed\)/);
    assert.deepEqual(loadJob(two.dir, id).ports, {});
  });
});
