// GET /api/project (issue #175): the config-derived graph only, loopback Hosts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoTemplate } from './helpers.ts';
import { startServer } from '../lib/server/start.ts';
import * as yaml from '#core/format/yaml.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  const r = spawnSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: dir } });
  if (r.status !== 0) throw new Error(r.stderr);
  fs.rmSync(answers);
});

const COMPONENTS = [
  { name: 'web', path: 'web', kind: 'app', commands: { test: 'npm test' }, owners: ['@web-team'], notes: 'the storefront', dependsOn: [{ component: 'api', type: 'runtime' }] },
  { name: 'api', path: 'api', kind: 'service', repo: 'acme/backend', owners: ['@api-team'], dependsOn: [{ backing: '<img src=x onerror=alert(1)>', type: 'runtime' }] },
];

function hit(port: number, p: string, host: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve() {
  const repo = template();
  const cfg = path.join(repo.dir, '.forge', 'config.yml');
  const config = yaml.parse(fs.readFileSync(cfg, 'utf8'));
  fs.writeFileSync(cfg, yaml.stringify({ ...config, components: COMPONENTS }));
  const srv = await startServer(repo.dir, { port: 0 });
  const port = Number(new URL(srv.url).port);
  return {
    port,
    cleanup: async () => {
      await srv.close();
      repo.cleanup();
    },
  };
}

test('GET /api/project serves the compact graph and nothing else', async () => {
  const s = await serve();
  try {
    const r = await hit(s.port, '/api/project', `127.0.0.1:${s.port}`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.deepEqual(Object.keys(body).sort(), ['backing', 'components', 'edges', 'problems']);
    assert.deepEqual(body.components, [
      { name: 'api', repo: 'acme/backend', kind: 'service', path: 'api' },
      { name: 'web', repo: null, kind: 'app', path: 'web' },
    ]);
    for (const c of body.components) assert.deepEqual(Object.keys(c), ['name', 'repo', 'kind', 'path']);
    assert.deepEqual(body.backing, ['<img src=x onerror=alert(1)>']);
    assert.deepEqual(body.edges, [
      { from: 'api', to: '<img src=x onerror=alert(1)>', target: 'backing', type: 'runtime' },
      { from: 'web', to: 'api', target: 'component', type: 'runtime' },
    ]);
    assert.equal(body.problems, 0);
    for (const word of ['commands', 'owners', 'notes', 'npm test', '@web-team', '@api-team', 'storefront']) assert.ok(!r.text.includes(word), `the response leaks ${word}`);
  } finally {
    await s.cleanup();
  }
});

test('GET /api/project refuses a foreign Host', async () => {
  const s = await serve();
  try {
    const r = await hit(s.port, '/api/project', 'evil.example.com');
    assert.equal(r.status, 421);
    assert.ok(!r.text.includes('acme/backend'));
  } finally {
    await s.cleanup();
  }
});
