// The issue's acceptance, end to end on one scratch repo: a declared secret reaches the component's
// process through an env sink, and never the builder brief, a log, an event or /api/state. Commands
// run through sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, tempRepo } from './helpers.ts';
import { renderBrief, roleBrief } from '../lib/brief.ts';
import { loadConfig } from '../lib/config.ts';
import { createJob, jobDir, updateJob } from '../lib/jobs.ts';
import { startServer } from '../lib/server.ts';
import { loadStepInput } from '../lib/step.ts';
import { createWorktree } from '../lib/worktree.ts';
import * as yaml from '../lib/yaml.ts';

const NODE = JSON.stringify(process.execPath);

function get(port: number, p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end();
  });
}

const listFiles = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()) : []);

test('a secret reaches the process but not the brief, logs or /api/state', async () => {
  const repo = tempRepo();
  const root = repo.dir;
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projects-'));
  const value = `db-${crypto.randomBytes(12).toString('hex')}`;
  try {
    fs.mkdirSync(path.join(root, 'api'));
    // Writes what it was given to an ignored file, and prints it, the way a careless script would.
    fs.writeFileSync(path.join(root, 'api', 'use.cjs'), "require('fs').writeFileSync('seen.txt', process.env.DB_PASS); console.log('connecting with ' + process.env.DB_PASS);\n");
    fs.writeFileSync(path.join(root, 'api', 'tracked.env'), 'X=1\n');
    fs.writeFileSync(path.join(root, '.gitignore'), 'api/seen.txt\n');
    fs.mkdirSync(path.join(root, '.forge'));
    fs.writeFileSync(path.join(root, '.forge', '.gitignore'), 'jobs/\nlocks/\nruntime/\n');
    const config = (sinks: unknown[]) =>
      fs.writeFileSync(
        path.join(root, '.forge', 'config.yml'),
        yaml.stringify({
          tracker: { kind: 'none' },
          pr: { enabled: false },
          worktrees: { root: '../{repo}.wt' },
          secrets: { DB_PASS: { env: 'FORGE_E2E_DB_PASS' } },
          components: [{ name: 'api', path: 'api', kind: 'service', commands: { test: `${NODE} use.cjs` }, config: sinks }],
        }),
      );
    config([{ env: { DB_PASS: '{secret.DB_PASS}' } }]);
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'api'], { cwd: root });
    const c = loadConfig(root).config;
    const id = createJob(root, c, { title: 'e2e' }).id;
    const wt = createWorktree(root, c, id);
    assert.equal(wt.ok, true, JSON.stringify(wt));
    updateJob(root, id, (j) => {
      j.round = 1;
      j.stage = 'build';
      j.services = ['api'];
    });

    const r = await forgeAsync(root, ['run', id, 'test'], { FORGE_E2E_DB_PASS: value });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(JSON.parse(r.stdout).config.secrets, ['DB_PASS']);
    assert.equal(fs.readFileSync(path.join(wt.path, 'api', 'seen.txt'), 'utf8'), value, 'the process got the value');

    const b = renderBrief(loadStepInput(root, c, id), roleBrief(loadStepInput(root, c, id), 'builder'));
    assert.match(b, /^Secrets: DB_PASS \(env\) · /m);
    assert.ok(!b.includes(value) && !b.includes('FORGE_E2E_DB_PASS'));

    const dir = jobDir(root, id);
    const logs = listFiles(path.join(dir, 'logs'));
    assert.ok(logs.length > 0);
    for (const f of logs) assert.ok(!fs.readFileSync(path.join(dir, 'logs', f), 'utf8').includes(value), `logs/${f}`);
    assert.ok(!fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes(value));
    assert.ok(!(r.stdout + r.stderr).includes(value));

    const srv = await startServer(root, { port: 0, projectsDir: projects });
    try {
      const state = await get(Number(new URL(srv.url).port), '/api/state');
      assert.ok(state.includes(id), 'the job is in the state');
      assert.ok(!state.includes(value));
    } finally {
      await srv.close();
    }

    // The same secret into a tracked path is refused, and the tracked file is untouched.
    config([{ 'env-file': 'tracked.env', values: { DB_PASS: '{secret.DB_PASS}' } }]);
    const refused = await forgeAsync(root, ['run', id, 'test'], { FORGE_E2E_DB_PASS: value });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /config sink path api\/tracked\.env must be git-ignored and untracked/);
    assert.ok(!(refused.stdout + refused.stderr).includes(value));
    assert.equal(fs.readFileSync(path.join(wt.path, 'api', 'tracked.env'), 'utf8'), 'X=1\n');
  } finally {
    repo.cleanup();
    fs.rmSync(`${root}.wt`, { recursive: true, force: true });
    fs.rmSync(projects, { recursive: true, force: true });
  }
});
