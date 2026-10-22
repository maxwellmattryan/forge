// Endpoint placeholders and env (issue #195): `{endpoint.<c>}`, `{backing.<n>.port|url}`, `{port}`,
// FORGE_PORT_<C> and FORGE_ENDPOINT_<C> in every configured command Forge runs, and the config
// validation behind them. Backing services go through the fake docker (test/fixtures/fake-docker.mjs).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as b from '../lib/backing.ts';
import type { DockerRunner } from '../lib/backing.ts';
import { loadConfig, validateConfig, defaults } from '../lib/core/config/load.ts';
import { commandPort, endpointEnv, endpointPlaceholders, envName, jobEndpoints, placeholderProblems } from '../lib/endpoints.ts';
import { createJob, jobDir, loadJob } from '../lib/core/job/store.ts';
import { fill } from '../lib/core/text.ts';
import { createWorktree } from '../lib/worktree.ts';
import * as yaml from '../lib/core/format/yaml.ts';
import { emptyState, handle } from './fixtures/fake-docker.mjs';
import { twoRepo } from './job-repos-fixture.ts';
import { forgeAsync, repoTemplate } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

// Built at runtime: a literal that looks like a credential would trip the secret scan on commit.
const SECRET = ['s3cr3t', 'pg', 'value'].join('-');
const PG = { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], url: `postgres://postgres:${SECRET}@{host}:{port}/app` };
const QUEUE = { name: 'queue', isolation: 'external', url: 'amqp://mq.internal:5672' };

// One in-memory docker for the file: every container name carries its job id, so tests never meet.
const state = emptyState();
const runner: DockerRunner = (args) => {
  const r = handle(state, args);
  return { ok: r.status === 0, ...r };
};
b.setDockerRunner(runner);

/** `env | grep` of the endpoint variables plus the filled placeholders, written to `<file>` beside the worktree (so verify's clean check passes). */
const probe = (file: string) => `( env | grep -E '^(FORGE_PORT|FORGE_ENDPOINT|PORT=|FORGE_PORT=)' | sort; echo "P={port} A={endpoint.api} L={endpoint.lib} PP={backing.postgres.port}" ) > "$FORGE_WORKTREE/../${file}"`;
const lines = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n');
const varsIn = (file: string) => Object.fromEntries(lines(file).filter((l) => l.includes('=') && !l.startsWith('P=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const lastLine = (file: string) => lines(file).at(-1)!;

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, verify: ['test'], worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

function scratch(edit: (c: any) => void) {
  const r = template();
  const file = path.join(r.dir, '.forge', 'config.yml');
  const c = yaml.parse(fs.readFileSync(file, 'utf8'));
  edit(c);
  fs.writeFileSync(file, yaml.stringify(c));
  cleanups.push(() => (r.cleanup(), fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true })));
  return { dir: r.dir, config: loadConfig(r.dir).config };
}

describe('endpoints', { concurrency: 4 }, () => {
  test('placeholders resolve in forge run', async () => {
    const s = scratch((c) => {
      c.components = [
        { name: 'api', path: '.', kind: 'service' },
        { name: 'web', path: '.', kind: 'app' },
      ];
      c.backing = [PG, QUEUE];
      c.commands.probe = 'echo {endpoint.api} {endpoint.web} {backing.postgres.port} {backing.postgres.url} {port}';
      c.commands.queue = 'echo {backing.queue.url}';
    });
    const id = createJob(s.dir, s.config, { title: 'Run' }).id;
    const created = createWorktree(s.dir, s.config, id);
    assert.ok(created.created && created.ok, JSON.stringify(created));
    const job = loadJob(s.dir, id);
    const { api, web } = job.ports;
    const pp = b.readJobRecord(s.dir, id, s.config).ports.postgres['5432'];
    const url = `postgres://postgres:${SECRET}@127.0.0.1:${pp}/app`;

    const ep = jobEndpoints(s.dir, s.config, job);
    assert.deepEqual(ep, {
      components: [
        { name: 'api', port: api, url: `http://localhost:${api}` },
        { name: 'web', port: web, url: `http://localhost:${web}` },
      ],
      backing: [
        { name: 'postgres', port: pp, hasUrl: true },
        { name: 'queue', port: null, hasUrl: true },
      ],
    });
    assert.deepEqual(endpointPlaceholders(ep, { shell: true }), { 'endpoint.api': `http://localhost:${api}`, 'endpoint.web': `http://localhost:${web}`, 'backing.postgres.port': String(pp), 'backing.postgres.url': '"$FORGE_BACKING_POSTGRES_URL"', 'backing.queue.url': '"$FORGE_BACKING_QUEUE_URL"' });
    assert.deepEqual(endpointPlaceholders(ep, { shell: false }), { 'endpoint.api': `http://localhost:${api}`, 'endpoint.web': `http://localhost:${web}`, 'backing.postgres.port': String(pp) }, 'no url reference outside a shell');
    assert.deepEqual(endpointEnv(ep), { FORGE_PORT_API: String(api), FORGE_ENDPOINT_API: `http://localhost:${api}`, FORGE_PORT_WEB: String(web), FORGE_ENDPOINT_WEB: `http://localhost:${web}` });

    const r = await forgeAsync(s.dir, ['run', id, 'probe']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.cmd, `echo http://localhost:${api} http://localhost:${web} ${pp} "$FORGE_BACKING_POSTGRES_URL" ${api}`);
    assert.equal(out.tail.trim(), `http://localhost:${api} http://localhost:${web} ${pp} ${url} ${api}`, 'the command saw the url from its environment');
    const log = fs.readFileSync(path.join(jobDir(s.dir, id), out.log), 'utf8');
    assert.ok(log.startsWith(`$ ${out.cmd}\n`), 'the log records the filled command');
    assert.ok(!out.cmd.includes(SECRET), 'the command text never holds the url');
    assert.ok(!log.split('\n')[0].includes(SECRET), 'the logged command never holds the url');
    const q = JSON.parse((await forgeAsync(s.dir, ['run', id, 'queue'])).stdout);
    assert.equal(q.cmd, 'echo "$FORGE_BACKING_QUEUE_URL"');
    assert.equal(q.tail.trim(), QUEUE.url);
  });

  test('setup, verify, background and member commands get the endpoints', async () => {
    const p = await twoRepo();
    cleanups.push(p.cleanup);
    p.config((c) => {
      c.components = [
        { name: 'api', path: '.', kind: 'service' },
        { name: 'lib', repo: 'lib', path: '.', kind: 'service', commands: { probe: probe('member.out'), test: 'true' } },
        { name: 'docs', path: '.', kind: 'library' },
      ];
      c.commands.probe = probe('run.out');
      c.commands.test = 'true';
      c.commands.dev = `${probe('dev.out')}; sleep 30`;
      c.worktrees.setup = [probe('setup.out')];
      c.verify = ['probe', 'test'];
    });
    const j = await p.f('job', 'new', '--title', `endpoints ${Math.random().toString(36).slice(2, 8)}`);
    await p.f('job', 'repo', 'add', j.id, 'lib');
    const created = await p.f('worktree', 'create', j.id);
    assert.equal(created.ok, true, JSON.stringify(created));
    const { api, lib } = created.ports;
    assert.ok(api && lib && api !== lib, JSON.stringify(created.ports));
    assert.equal(created.port, api);
    const rootWt = created.path;
    const libWt = created.repos[0].path;
    const want = { FORGE_PORT_API: String(api), FORGE_ENDPOINT_API: `http://localhost:${api}`, FORGE_PORT_LIB: String(lib), FORGE_ENDPOINT_LIB: `http://localhost:${lib}` };
    const root = `P=${api} A=http://localhost:${api} L=http://localhost:${lib} PP={backing.postgres.port}`;

    const setup = path.join(rootWt, '..', 'setup.out');
    assert.deepEqual(varsIn(setup), { ...want, PORT: String(api), FORGE_PORT: String(api) }, 'setup');
    assert.equal(lastLine(setup), root, 'setup placeholders');

    await p.f('run', j.id, 'probe');
    const run = path.join(rootWt, '..', 'run.out');
    assert.deepEqual(varsIn(run), { ...want, PORT: String(api), FORGE_PORT: String(api) }, 'forge run');
    assert.equal(lastLine(run), root);

    await p.f('run', j.id, 'probe', '--repo', 'lib');
    const member = path.join(libWt, '..', 'member.out');
    assert.deepEqual(varsIn(member), { ...want, PORT: String(lib), FORGE_PORT: String(lib) }, "a member command's port is its component's");
    assert.equal(lastLine(member), root.replace(`P=${api}`, `P=${lib}`));

    fs.rmSync(run);
    fs.rmSync(member);
    await p.f('job', 'round', j.id);
    const v = await p.f('verify', j.id);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.deepEqual(varsIn(run), { ...want, PORT: String(api), FORGE_PORT: String(api) }, 'verify root step');
    assert.equal(lastLine(run), root);
    assert.deepEqual(varsIn(member), { ...want, PORT: String(lib), FORGE_PORT: String(lib) }, 'verify member step');

    const bg = await p.f('run', j.id, 'dev', '--background');
    try {
      assert.equal(bg.port, api);
      const dev = path.join(rootWt, '..', 'dev.out');
      // The redirect creates the file before the subshell has written it.
      for (let i = 0; i < 100 && !(fs.existsSync(dev) && fs.readFileSync(dev, 'utf8').includes('\nP=')); i++) await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(varsIn(dev), { ...want, PORT: String(api), FORGE_PORT: String(api) }, 'background');
      assert.equal(lastLine(dev), root);
    } finally {
      await p.f('stop', j.id);
    }
  });

  test('validation names unknown endpoint and backing placeholders', async () => {
    const NOPORTS = { name: 'cache', isolation: 'per-job', image: 'redis:7' };
    const cfg = {
      components: [
        { name: 'api', path: '.', kind: 'service' },
        { name: 'docs', path: 'docs', kind: 'library' },
        { name: 'api-v1', path: 'v1', kind: 'service' },
        { name: 'api_v1', path: 'v1b', kind: 'app', commands: { dev: 'x {endpoint.api} {backing.cache.port}' } },
      ],
      backing: [PG, QUEUE, NOPORTS],
      commands: { dev: 'serve {endpoint.docs}', a: 'echo {backing.nope.url}', b: 'echo {backing.queue.port} {backing.queue.url}', c: 'echo {backing.postgres}', ok: 'echo {endpoint.api} {backing.postgres.port} {backing.postgres.url} {port} {args}' },
      worktrees: { setup: ['echo {endpoint.web}'] },
    };
    const problems = placeholderProblems(cfg);
    assert.deepEqual(problems, [
      'commands.dev uses {endpoint.docs}, which is not a service or app component',
      'commands.a uses {backing.nope.url}, which names no backing entry',
      'commands.b uses {backing.queue.port}, but backing "queue" is external and has no host port',
      'commands.c uses {backing.postgres}; a backing placeholder is {backing.<name>.url} or {backing.<name>.port}',
      'components "api_v1".commands.dev uses {backing.cache.port}, but backing "cache" is managed with no ports and has no host port',
      'worktrees.setup[0] uses {endpoint.web}, which is not a service or app component',
      'components "api-v1" and "api_v1" share the environment name FORGE_PORT_API_V1',
    ]);
    assert.ok(!problems.join('\n').includes(SECRET) && !problems.join('\n').includes('amqp'), 'never a url');
    assert.deepEqual(placeholderProblems({}), []);
    assert.deepEqual(placeholderProblems({ components: 'x', backing: 7, commands: null, worktrees: { setup: 'no' } }), [], 'other shapes are other validators\' problems');
    assert.deepEqual(placeholderProblems({ components: [{ name: 'api', path: '.', kind: 'service' }, { name: 'api', path: 'b', kind: 'app' }] }), [], 'a repeated name is not a collision');
    assert.equal(envName('api-v1.beta/x'), 'API_V1_BETA_X');
    const all = validateConfig({ ...defaults(), ...cfg }, process.cwd());
    for (const m of problems) assert.ok(all.includes(m), m);

    // Through the CLI, and the unknown placeholders stay literal in a command.
    const s = scratch((c) => {
      c.components = [{ name: 'api', path: '.', kind: 'service' }];
      c.backing = [QUEUE];
      c.commands.probe = 'echo "[{endpoint.x}]" "[{backing.nope.port}]" "[{backing.queue.port}]" {backing.queue.url}';
    });
    const v = await forgeAsync(s.dir, ['config', 'validate']);
    assert.equal(v.status, 1);
    const out = JSON.parse(v.stdout);
    assert.deepEqual(out.problems, [
      'commands.probe uses {endpoint.x}, which is not a service or app component',
      'commands.probe uses {backing.nope.port}, which names no backing entry',
      'commands.probe uses {backing.queue.port}, but backing "queue" is external and has no host port',
    ]);
    assert.ok(!v.stdout.includes('amqp'), 'never a url');
    const id = createJob(s.dir, s.config, { title: 'Literal' }).id;
    assert.ok(createWorktree(s.dir, s.config, id).created);
    const r = await forgeAsync(s.dir, ['run', id, 'probe']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const ran = JSON.parse(r.stdout);
    assert.equal(ran.cmd, 'echo "[{endpoint.x}]" "[{backing.nope.port}]" "[{backing.queue.port}]" "$FORGE_BACKING_QUEUE_URL"');
    assert.equal(ran.tail.trim(), `[{endpoint.x}] [{backing.nope.port}] [{backing.queue.port}] ${QUEUE.url}`);
  });

  test('commandPort: the {port} rule', () => {
    const config = { ...defaults(), components: [{ name: 'api', path: '.', kind: 'service' }, { name: 'web', path: 'w', kind: 'app' }, { name: 'lib', repo: 'lib', path: '.', kind: 'service' }, { name: 'core', repo: 'lib', path: 'c', kind: 'library' }] } as any;
    const [api, web, lib, core] = config.components;
    const job = { port: 4100, ports: { api: 4100, web: 4101, lib: 4102 }, services: [] as string[] };
    assert.equal(commandPort(config, job, null), 4100, 'no component: job.port');
    assert.equal(commandPort(config, job, web), 4101, "the job's component's port");
    assert.equal(commandPort(config, job, lib), 4102, "a member component's port");
    assert.equal(commandPort(config, job, core), null, 'a member library has none');
    assert.equal(commandPort(config, job, api), 4100);
    assert.equal(commandPort(config, { ...job, ports: {} }, api), 4100, 'a v13 job: port stands for the first entry');
    assert.equal(commandPort(config, { ...job, ports: {} }, web), 4100, 'a v13 job: a root component falls back to job.port');
    assert.equal(commandPort(config, { ...job, ports: {} }, lib), null, 'a v13 job: a member component has none yet');
    assert.equal(commandPort(config, { port: 70000, ports: {}, services: [] }, null), null, 'an out-of-range port is not filled');
  });

  test('fill takes dotted keys and leaves {args} rules alone', () => {
    assert.equal(fill('a {endpoint.api} b {backing.pg-1.port} c {x}', { 'endpoint.api': 'http://localhost:1', 'backing.pg-1.port': 2 }), 'a http://localhost:1 b 2 c {x}');
    assert.equal(fill('{args} {args}', { args: "'q'" }), "'q' 'q'");
    assert.equal(fill('{args}', {}), '{args}', 'unknown stays literal');
    assert.equal(fill('{toString} {constructor}', {}), '{toString} {constructor}', 'only own keys fill');
    assert.equal(fill('{a.b}', { a: 'x' }), '{a.b}', 'a dotted key is not its prefix');
  });
});
