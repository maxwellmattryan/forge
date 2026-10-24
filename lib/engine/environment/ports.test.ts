// Ports across registered projects: two projects with one ports.base (their roots share the basename
// `app`) never hand out the same host port, for job ports or backing ports.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobAt } from '../../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { setJob } from '#core/job/store.ts';
import { addProject } from '../project/machine-index.ts';
import { allocateBacking } from './backing.ts';
import { allocatePorts } from './ports.ts';

const made: string[] = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const scratch = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ports-')));
  made.push(d);
  return d;
};

/** A root named `app` with ports 4100-4119 and, optionally, a shared and a per-job backing entry. */
function appRoot(backing = false): string {
  const root = path.join(scratch(), 'app');
  fs.mkdirSync(path.join(root, '.forge', 'runtime'), { recursive: true });
  const entries = backing ? '\nbacking:\n  - { name: pg, isolation: per-job, image: "postgres:16", ports: [5432] }\n  - { name: redis, isolation: shared, image: "redis:7", ports: [6379] }\n' : '';
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), `ports:\n  base: 4100\n  span: 20\n${entries}`);
  return root;
}

describe('ports are unique across registered projects', () => {
  it("a job's ports in B skip A's active job ports and A's per-job and shared backing ports", () => {
    const home = path.join(scratch(), 'home');
    const a = appRoot();
    const b = appRoot();
    const ja = jobAt(a, 'build');
    setJob(a, ja.id, { owned: { port: 4100 }, fields: { ports: { dev: 4100, web: 4101 } } });
    fs.writeFileSync(path.join(a, '.forge', 'jobs', ja.id, 'backing.json'), JSON.stringify({ v: 1, ports: { pg: { 5432: 4102 } } }));
    fs.writeFileSync(path.join(a, '.forge', 'runtime', 'backing.json'), JSON.stringify({ v: 1, ports: { redis: { 6379: 4103 } } }));
    addProject(home, a, { name: 'a' });
    addProject(home, b, { name: 'b' });
    const jb = jobAt(b, 'build');
    assert.deepEqual(allocatePorts(b, loadConfig(b).config, jb, home), { dev: 4104 });
    // Unregistered, A's ports are not seen: the machine index is what makes them visible.
    assert.deepEqual(allocatePorts(b, loadConfig(b).config, jb, path.join(scratch(), 'empty-home')), { dev: 4100 });
  });

  it("allocateBacking in B skips A's job ports", () => {
    const home = path.join(scratch(), 'home');
    const a = appRoot();
    const b = appRoot(true);
    const ja = jobAt(a, 'build');
    setJob(a, ja.id, { owned: { port: 4100 }, fields: { ports: { dev: 4100, api: 4101 } } });
    addProject(home, a, { name: 'a' });
    addProject(home, b, { name: 'b' });
    const jb = jobAt(b, 'build');
    const got = allocateBacking(b, loadConfig(b).config, { id: jb.id }, home);
    assert.deepEqual([got.job.ports, got.shared.ports], [{ pg: { 5432: 4102 } }, { redis: { 6379: 4103 } }]);
  });
});
