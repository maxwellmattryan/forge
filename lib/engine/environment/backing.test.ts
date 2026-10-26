// Backing containers and volumes are named per root: two checkouts named `app` with one job id never
// share a container, and a container or volume under the name from before #400, labelled as this
// root's, is reused rather than stranded. Docker is a recording in-memory fake (no docker runs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import type { Config } from '#core/types.ts';
import type { DockerResult, DockerRunner } from '#integrations/docker/types.ts';
import { backingUp } from './backing.ts';
import { rootLabel } from './backing-names.ts';

const made: string[] = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A root named `app` in its own parent, with job j1's directory. */
function appRoot(): string {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-backing-')));
  made.push(parent);
  const root = path.join(parent, 'app');
  fs.mkdirSync(path.join(root, '.forge', 'jobs', 'j1'), { recursive: true });
  return root;
}

function config(): Config {
  return {
    ...defaults(),
    backing: [
      { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], volumes: ['/var/lib/postgresql/data'] },
      { name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379], volumes: ['/data'] },
    ],
  } as Config;
}

type Labels = Record<string, string>;

/** An in-memory Docker: containers and volumes by name, every call recorded. */
function fakeDocker() {
  const containers = new Map<string, { running: boolean; labels: Labels }>();
  const volumes = new Map<string, Labels>();
  const calls: string[][] = [];
  const ok = (stdout = ''): DockerResult => ({ ok: true, stdout, stderr: '', status: 0 });
  const none = (): DockerResult => ({ ok: false, stdout: '', stderr: 'Error: No such object', status: 1 });
  const labelsOf = (args: string[]): Labels =>
    Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === '--label' ? [a.split('=') as [string, string]] : [])));
  const runner: DockerRunner = (args) => {
    calls.push(args);
    const last = args[args.length - 1]!;
    if (args[0] === 'version') return ok('27.0.0');
    if (args[0] === 'inspect') {
      const c = containers.get(last);
      return c ? ok(`${c.running} null ${JSON.stringify(c.labels)}`) : none();
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const v = volumes.get(last);
      return v ? ok(JSON.stringify(v)) : none();
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      volumes.set(last, labelsOf(args));
      return ok(last);
    }
    if (args[0] === 'run') {
      containers.set(args[args.indexOf('--name') + 1]!, { running: true, labels: labelsOf(args) });
      return ok('id');
    }
    if (args[0] === 'start') {
      containers.get(last)!.running = true;
      return ok(last);
    }
    return ok();
  };
  const of = (sub: string) => calls.filter((c) => c[0] === sub || `${c[0]} ${c[1]}` === sub);
  return { runner, containers, volumes, calls, of };
}

const labels = (root: string, backing: string, job: string | null): Labels => ({
  'forge.root': rootLabel(root),
  'forge.backing': backing,
  'forge.isolation': job ? 'per-job' : 'shared',
  ...(job ? { 'forge.job': job } : {}),
});

describe('backing names per root', () => {
  it('two roots named app with job j1 get four distinct containers and distinct volumes', () => {
    const d = fakeDocker();
    const a = appRoot();
    const b = appRoot();
    for (const root of [a, b]) assert.ok(backingUp(root, config(), { id: 'j1' }, d.runner).every((r) => r.ok));
    const names = d.of('run').map((c) => c[c.indexOf('--name') + 1]);
    assert.deepEqual(names, [`forge-j1-${rootLabel(a)}-postgres`, `forge-app-${rootLabel(a)}-redis`, `forge-j1-${rootLabel(b)}-postgres`, `forge-app-${rootLabel(b)}-redis`]);
    const vols = d.of('volume create').map((c) => c[c.length - 1]);
    assert.equal(new Set(vols).size, 4);
    assert.deepEqual(vols, names.map((n) => `${n}-0`));
  });

  it('a stopped container under the old name with this root and job is started, never run again', () => {
    const d = fakeDocker();
    const a = appRoot();
    d.containers.set('forge-j1-postgres', { running: false, labels: labels(a, 'postgres', 'j1') });
    d.containers.set('forge-app-redis', { running: false, labels: labels(a, 'redis', null) });
    d.volumes.set('forge-j1-postgres-0', labels(a, 'postgres', 'j1'));
    d.volumes.set('forge-app-redis-0', labels(a, 'redis', null));
    const up = backingUp(a, config(), { id: 'j1' }, d.runner);
    assert.deepEqual(up.map((r) => [r.name, r.action, r.ok]), [['postgres', 'started', true], ['redis', 'started', true]]);
    assert.deepEqual(d.of('start').map((c) => c[1]), ['forge-j1-postgres', 'forge-app-redis']);
    assert.deepEqual([d.of('run'), d.of('volume create')], [[], []]);
  });

  it('an old-named volume with this root and job keeps its data under a new container', () => {
    const d = fakeDocker();
    const a = appRoot();
    d.volumes.set('forge-app-redis-0', labels(a, 'redis', null));
    backingUp(a, config(), { id: 'j1' }, d.runner);
    const redis = d.of('run').find((c) => c.includes(`forge-app-${rootLabel(a)}-redis`))!;
    assert.ok(redis.includes('forge-app-redis-0:/data'), redis.join(' '));
    assert.deepEqual(d.of('volume create').map((c) => c[c.length - 1]), [`forge-j1-${rootLabel(a)}-postgres-0`]);
  });

  it("old-named ones with another root's labels are ignored and the qualified ones are created", () => {
    const d = fakeDocker();
    const a = appRoot();
    const b = appRoot();
    d.containers.set('forge-j1-postgres', { running: false, labels: labels(b, 'postgres', 'j1') });
    d.volumes.set('forge-j1-postgres-0', labels(b, 'postgres', 'j1'));
    d.containers.set('forge-app-redis', { running: true, labels: labels(b, 'redis', null) });
    assert.ok(backingUp(a, config(), { id: 'j1' }, d.runner).every((r) => r.ok && r.action === 'created'));
    assert.deepEqual(d.of('start'), []);
    assert.deepEqual(d.of('run').map((c) => c[c.indexOf('--name') + 1]), [`forge-j1-${rootLabel(a)}-postgres`, `forge-app-${rootLabel(a)}-redis`]);
    const pg = d.of('run')[0]!;
    assert.ok(pg.includes(`forge-j1-${rootLabel(a)}-postgres-0:/var/lib/postgresql/data`), pg.join(' '));
    assert.equal(d.containers.get('forge-j1-postgres')!.running, false);
  });
});
