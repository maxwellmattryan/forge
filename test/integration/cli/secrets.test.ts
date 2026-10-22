// Secret references through the CLI: `forge secrets list|check`, the doctor check, and the issue's
// acceptance end to end on one scratch repo, where a declared secret reaches the component's process
// through an env sink and never the builder brief, a log or an event. That the server never serves a
// known value is test/integration/server/secrets.test.ts. Commands run through sh.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeBin, forgeAsync, repoTemplate } from '../../helpers.ts';
import { renderBrief, roleBrief } from '../../../lib/engine/pipeline/brief.ts';
import { defaults, loadConfig } from '../../../lib/core/config/load.ts';
import { secretsCheck } from '../../../lib/engine/ops/doctor.ts';
import { createJob, jobDir, updateJob } from '../../../lib/core/job/store.ts';
import { knownRecordValues } from '../../../lib/engine/guard/known-secrets.ts';
import { loadStepInput } from '../../../lib/engine/pipeline/step.ts';
import { createWorktree } from '../../../lib/engine/workspace/worktree.ts';
import * as yaml from '../../../lib/core/format/yaml.ts';

const NODE = JSON.stringify(process.execPath);

const template = repoTemplate((dir) => {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', '.gitignore'), 'jobs/\nlocks/\nruntime/\n');
});

function scratch(secrets: unknown) {
  const repo = template();
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, secrets }));
  return repo;
}

describe('secret references', { concurrency: 4 }, () => {
  test('secrets list and check', async () => {
    const value = `v-${crypto.randomBytes(8).toString('hex')}`;
    const repo = scratch({ GOOD: { env: 'FORGE_TEST_SECRET_GOOD' }, MISSING: { env: 'FORGE_TEST_SECRET_MISSING' }, API: { op: 'op://v/i/f' } });
    try {
      const env = { FORGE_TEST_SECRET_GOOD: value, FORGE_TEST_SECRET_MISSING: undefined };
      const list = await forgeAsync(repo.dir, ['secrets', 'list'], env);
      assert.equal(list.status, 0, list.stderr);
      assert.deepEqual(JSON.parse(list.stdout), { secrets: [{ name: 'GOOD', source: 'env' }, { name: 'MISSING', source: 'env' }, { name: 'API', source: 'op' }] });
      const ok = await forgeAsync(repo.dir, ['secrets', 'check', 'GOOD'], env);
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(JSON.parse(ok.stdout), { secrets: [{ name: 'GOOD', source: 'env', ok: true }] });
      const all = await forgeAsync(repo.dir, ['secrets', 'check', 'GOOD', 'MISSING'], env);
      assert.equal(all.status, 1);
      // The message itself is test/secret-refs.test.ts › "fails closed without the value in the error".
      const missing = JSON.parse(all.stdout).secrets[1];
      assert.deepEqual({ ...missing, error: typeof missing.error }, { name: 'MISSING', source: 'env', ok: false, error: 'string' });
      for (const r of [list, ok, all]) {
        assert.doesNotMatch(r.stdout + r.stderr, new RegExp(value));
        assert.doesNotMatch(r.stdout, /length|"len"/);
      }
      const unknown = await forgeAsync(repo.dir, ['secrets', 'check', 'NOPE'], env);
      assert.equal(unknown.status, 2);
      assert.match(unknown.stderr, /not a declared secret: "NOPE"/);
    } finally {
      repo.cleanup();
    }
  });

  test('doctor never reads a value', async () => {
    const repo = scratch({ API: { op: 'op://v/i/f' }, UNSET: { env: 'FORGE_TEST_SECRET_UNSET' }, KC: { keychain: { service: 'svc' } } });
    try {
      const tools = ['op', 'security', 'secret-tool'].map((tool) => fakeBin(tool, `echo value-from-${tool}`));
      const env = { PATH: [...tools.map((t) => t.dir), process.env.PATH].join(path.delimiter), FORGE_TEST_SECRET_UNSET: undefined };
      const config = { ...defaults(), secrets: { API: { op: 'op://v/i/f' }, UNSET: { env: 'FORGE_TEST_SECRET_UNSET' }, KC: { keychain: { service: 'svc' } } } } as any;
      const c = secretsCheck(repo.dir, config, { env, platform: 'win32' })!;
      assert.equal(c.name, 'secrets');
      assert.equal(c.ok, true);
      assert.equal(c.warn, true);
      assert.match(c.detail, /^3 declared; /);
      assert.match(c.detail, /UNSET \(env\): FORGE_TEST_SECRET_UNSET is not set/);
      assert.match(c.detail, /KC \(keychain\): not supported on win32/);
      assert.equal(secretsCheck(repo.dir, defaults()), null);
      const r = await forgeAsync(repo.dir, ['doctor'], env);
      const report = JSON.parse(r.stdout);
      const check = report.checks.find((x: any) => x.name === 'secrets');
      assert.match(check.detail, /^3 declared/);
      assert.doesNotMatch(r.stdout, /value-from-/);
      for (const t of tools) assert.deepEqual(t.calls(), [], `${path.basename(t.bin)} was not run`);
    } finally {
      repo.cleanup();
    }
  });
});

const listFiles = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()) : []);

/** Points the api component's sinks at `sinks`, with DB_PASS declared from an env var. */
function configure(root: string, sinks: unknown[]) {
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
}

const apiRepo = repoTemplate((root) => {
  fs.mkdirSync(path.join(root, 'api'));
  // Writes what it was given to an ignored file, and prints it, the way a careless script would.
  fs.writeFileSync(path.join(root, 'api', 'use.cjs'), "require('fs').writeFileSync('seen.txt', process.env.DB_PASS); console.log('connecting with ' + process.env.DB_PASS);\n");
  fs.writeFileSync(path.join(root, 'api', 'tracked.env'), 'X=1\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'api/seen.txt\n');
  fs.mkdirSync(path.join(root, '.forge'));
  fs.writeFileSync(path.join(root, '.forge', '.gitignore'), 'jobs/\nlocks/\nruntime/\n');
  configure(root, [{ env: { DB_PASS: '{secret.DB_PASS}' } }]);
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'api'], { cwd: root, stdio: 'pipe' });
});

test('a secret reaches the process but not the brief, logs or /api/state', async () => {
  const repo = apiRepo();
  const root = repo.dir;
  const value = `db-${crypto.randomBytes(12).toString('hex')}`;
  try {
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
    // The sink recorded the value as known, which is what keeps it off every server route
    // (test/integration/server/secrets.test.ts › "known values never leave the server").
    assert.ok(knownRecordValues(root, id).includes(value), 'the sink value is in the known-secrets record');

    // The same secret into a tracked path is refused, and the tracked file is untouched.
    configure(root, [{ 'env-file': 'tracked.env', values: { DB_PASS: '{secret.DB_PASS}' } }]);
    const refused = await forgeAsync(root, ['run', id, 'test'], { FORGE_E2E_DB_PASS: value });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /config sink path api\/tracked\.env must be git-ignored and untracked/);
    assert.ok(!(refused.stdout + refused.stderr).includes(value));
    assert.equal(fs.readFileSync(path.join(wt.path, 'api', 'tracked.env'), 'utf8'), 'X=1\n');
  } finally {
    repo.cleanup();
    fs.rmSync(`${root}.wt`, { recursive: true, force: true });
  }
});
