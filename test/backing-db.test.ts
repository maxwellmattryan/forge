// Job databases (issue #194): a shared Postgres entry with `database` driven through the in-memory
// fake docker (test/fixtures/fake-docker.mjs), whose psql model takes the exact statements
// lib/backing-db.ts sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as b from '../lib/backing.ts';
import type { DockerRunner } from '../lib/backing.ts';
import { JOB_DB_NAME, TEMPLATE_ROLE, dbRecordFile, jobDbName, readDbRecord, scramVerifier, templateName } from '../lib/backing-db.ts';
import { PG_IDENT } from '../lib/backing-config.ts';
import { loadConfig } from '../lib/config.ts';
import { createJob, loadJob, readEvents } from '../lib/jobs.ts';
import { loadStepInput, step } from '../lib/step.ts';
import { createWorktree, databaseCommands, removeWorktree } from '../lib/worktree.ts';
import { emptyState, handle } from './fixtures/fake-docker.mjs';
import { repoTemplate } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
// Built at runtime: literals shaped like credentials would trip the secret scan on commit.
const ADMIN_PW = ['adm1n', 'pg', 'value'].join('-');
const DB_URL = ['postgres://{user}', '{password}@{host}:{port}/{database}'].join(':');
const LOG = '$FORGE_WORKTREE/db.log';
// Each writes the url it sees to db.log and to its output (so a stored tail would show it unredacted).
const MIGRATE = `[ ! -f {root}/fail-migrate ] && echo migrate $FORGE_BACKING_PG_URL >> ${LOG} && echo $FORGE_BACKING_PG_URL`;
const SEED = `echo seed $FORGE_BACKING_PG_URL >> ${LOG}`;
const SETUP = `echo setup $FORGE_BACKING_PG_URL >> ${LOG}; echo $FORGE_BACKING_PG_URL`;
const PG = {
  name: 'pg',
  isolation: 'shared',
  image: 'postgres:16',
  ports: [5432],
  env: { POSTGRES_PASSWORD: ADMIN_PW },
  volumes: ['/var/lib/postgresql/data'],
  url: DB_URL,
  database: { engine: 'postgres', migrate: MIGRATE, seed: SEED, inputs: ['db/**'] },
};

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, verify: ['test'], worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  fs.mkdirSync(path.join(dir, 'db'));
  fs.writeFileSync(path.join(dir, 'db', '001.sql'), 'create table t(x int);\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'db.log\nfail-migrate\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

function scratch(backing: unknown[], setup: string[] = []) {
  const r = template();
  const file = path.join(r.dir, '.forge', 'config.yml');
  let text = fs.readFileSync(file, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify(backing)}`);
  if (setup.length) text = text.replace(/^ {2}setup: \[\]$/m, `  setup: ${JSON.stringify(setup)}`);
  fs.writeFileSync(file, text);
  const config = loadConfig(r.dir).config;
  assert.deepEqual(config.backing, backing);
  return { dir: r.dir, config, cleanup: () => (r.cleanup(), fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true })) };
}

/** The in-memory docker, recording argv and stdin of every call. */
function fake() {
  const state = emptyState();
  const calls: { args: string[]; input?: string }[] = [];
  const runner: DockerRunner = (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = handle(state, args, opts?.input);
    return { ok: r.status === 0, ...r };
  };
  const execs = () => calls.filter((c) => c.args[0] === 'exec');
  return { state, calls, runner, execs };
}

async function withRunner<T>(runner: DockerRunner, fn: () => T | Promise<T>): Promise<T> {
  const prev = b.setDockerRunner(runner);
  try {
    return await fn();
  } finally {
    b.setDockerRunner(prev);
  }
}

const server = (s: { dir: string; config: any }) => `forge-${b.projectSlug(s.dir, s.config)}-pg`;
const dbLog = (dir: string) => (fs.existsSync(path.join(dir, 'db.log')) ? fs.readFileSync(path.join(dir, 'db.log'), 'utf8').trim().split('\n') : []);
/** `postgres://user:pw@host:port/db` taken apart. */
function parseUrl(u: string) {
  const m = /^postgres:\/\/([^:]+):([^@]+)@127\.0\.0\.1:(\d+)\/(\w+)$/.exec(u);
  assert.ok(m, u);
  return { user: m[1], password: m[2], port: Number(m[3]), database: m[4] };
}
/** Whether `verifier` is the SCRAM-SHA-256 verifier of `password`. */
function verifies(verifier: string, password: string): boolean {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (!m) return false;
  const salted = crypto.pbkdf2Sync(password, Buffer.from(m[2], 'base64'), Number(m[1]), 32, 'sha256');
  const stored = crypto.createHash('sha256').update(crypto.createHmac('sha256', salted).update('Client Key').digest()).digest('base64');
  return stored === m[3] && crypto.createHmac('sha256', salted).update('Server Key').digest('base64') === m[4];
}

test('scram verifier matches RFC 7677', () => {
  const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const v = scramVerifier('pencil', salt, 4096);
  const m = /^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$([^:]+):(.+)$/.exec(v);
  assert.ok(m, v);
  const storedKey = Buffer.from(m[1], 'base64');
  const serverKey = Buffer.from(m[2], 'base64');
  const auth = [
    'n=user,r=rOprNGfwEbeRWgbNEkqO',
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096',
    'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
  ].join(',');
  // RFC 7677 §3's published v= and p= values, joined at runtime: the secret scan reads any long base64 literal as a credential.
  const rfcV = ['6rriTRBi23WpRR/wtup+', 'mMhUZUn/dB5nLTJRsjl95G4='].join('');
  const rfcP = ['dHzbZapWIk4jUhN+Ute9', 'ytag9zjfMHgsqmmiz7AndVQ='].join('');
  assert.equal(crypto.createHmac('sha256', serverKey).update(auth).digest('base64'), rfcV, 'v= of the RFC example');
  // The example's ClientProof recovers ClientKey, whose hash is StoredKey.
  const proof = Buffer.from(rfcP, 'base64');
  const signature = crypto.createHmac('sha256', storedKey).update(auth).digest();
  const clientKey = Buffer.from(proof.map((x, i) => x ^ signature[i]));
  assert.deepEqual(crypto.createHash('sha256').update(clientKey).digest(), storedKey);
  assert.notEqual(scramVerifier('pencil'), scramVerifier('pencil'), 'a fresh salt each time');
});

test('identifiers are derived, capped and distinct', async () => {
  const ids = ['12-add-db', '12_add_db', '12.add.db', '12-ADD-db', 'x'.repeat(200), '---', 'a"; DROP ROLE postgres; --'];
  const names = ids.map(jobDbName);
  for (const n of names) {
    assert.match(n, JOB_DB_NAME);
    assert.ok(n.length <= 57, n);
  }
  assert.equal(new Set(names).size, ids.length, 'ids differing only in punctuation or case get different names');
  assert.equal(jobDbName('12-add-db'), jobDbName('12-add-db'), 'stable');
  assert.match(jobDbName('---'), /^forge_j_job_[0-9a-f]{8}$/);

  const s = scratch([PG]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Quoted' }).id;
    const res = await withRunner(f.runner, () => createWorktree(s.dir, s.config, id));
    assert.equal(res.ok, true, JSON.stringify(res));
    const psql = f.execs().filter((c) => c.args.includes('psql'));
    assert.ok(psql.length > 0);
    for (const c of psql) {
      assert.equal(c.args[1], '-i', 'SQL goes on stdin');
      assert.ok(c.input && c.input.trim().length > 0);
      assert.ok(!c.args.some((a) => /\b(SELECT|CREATE|ALTER|DROP|REVOKE)\b/.test(a)), `no SQL in argv: ${c.args.join(' ')}`);
    }
    for (const { s: stmt } of f.state.sql) {
      // Every forge_ name sits inside "…" (an identifier) or '…' (a catalog lookup), and every quoted identifier passed the check.
      // (The prune lookup's pattern is a fixed literal, not a name.)
      for (const m of stmt.replace("'^forge_tpl_[0-9a-f]{12}$'", '').matchAll(/(.)(forge_\w+)/g)) assert.ok(m[1] === '"' || m[1] === "'", `${m[2]} is quoted in ${stmt}`);
      for (const m of stmt.matchAll(/"([^"]*)"/g)) assert.match(m[1], PG_IDENT, stmt);
    }
  } finally {
    s.cleanup();
  }
});

test('two jobs get separate databases and credentials from one template', async () => {
  const s = scratch([PG], [SETUP]);
  const f = fake();
  try {
    const a = createJob(s.dir, s.config, { title: 'Job A' }).id;
    const bId = createJob(s.dir, s.config, { title: 'Job B' }).id;
    const [ra, rb] = await withRunner(f.runner, () => [createWorktree(s.dir, s.config, a), createWorktree(s.dir, s.config, bId)]);
    assert.ok(ra.created && rb.created && ra.ok && rb.ok, JSON.stringify([ra, rb]));
    const pg = f.state.pg[server(s)];
    const [da, db] = [a, bId].map(jobDbName);
    const t = templateName(s.config.backing[0], ra.path);
    assert.deepEqual(ra.created && ra.backing?.[0].database, { name: da, template: t, action: 'created', template_action: 'built' });
    assert.deepEqual(rb.created && rb.backing?.[0].database, { name: db, template: t, action: 'created', template_action: 'reused' });
    assert.deepEqual(
      ra.created && ra.backing?.[0].build?.map((x) => [x.cmd, x.ok]),
      [
        [MIGRATE, true],
        [SEED, true],
      ],
    );
    assert.equal(rb.created && rb.backing?.[0].build, undefined, 'no build when the template is reused');
    const logs = [dbLog(ra.path), dbLog(rb.path)];
    assert.equal(logs.flat().filter((l) => l.startsWith('migrate ')).length, 1, 'migrate ran once');
    assert.equal(logs.flat().filter((l) => l.startsWith('seed ')).length, 1, 'seed ran once');
    const urls = logs.map((l) => parseUrl(l.find((x) => x.startsWith('setup '))!.slice('setup '.length)));
    assert.deepEqual([urls[0].user, urls[0].database], [da, da]);
    assert.deepEqual([urls[1].user, urls[1].database], [db, db]);
    assert.notEqual(urls[0].password, urls[1].password);
    assert.equal(urls[0].password, readDbRecord(s.dir, a, s.config).databases.pg.password);
    assert.equal(urls[1].port, b.readSharedRecord(s.dir, s.config).ports.pg['5432']);
    for (const [d, url] of [
      [da, urls[0]],
      [db, urls[1]],
    ] as const) {
      assert.deepEqual(pg.dbs[d], { owner: d, isTemplate: false, allowConn: true, clonedFrom: t, connectRevoked: true });
      assert.equal(pg.roles[d].login, true);
      assert.deepEqual(pg.roles[d].memberOf, [TEMPLATE_ROLE]);
      assert.ok(verifies(pg.roles[d].verifier, url.password), 'the role holds the verifier of its own password');
    }
    assert.notEqual(pg.roles[da].verifier, pg.roles[db].verifier);
    assert.deepEqual(pg.dbs[t], { owner: 'postgres', isTemplate: true, allowConn: false, clonedFrom: null, connectRevoked: false }, 'the template belongs to the superuser and takes no connections');
    assert.deepEqual(pg.roles[TEMPLATE_ROLE], { login: false, verifier: null, memberOf: [] }, 'forge_tpl loses its login after the build');
  } finally {
    s.cleanup();
  }
});

test('template build order, failure and retry', async () => {
  const s = scratch([PG], ['touch setup-ran']);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Order' }).id;
    fs.writeFileSync(path.join(s.dir, 'fail-migrate'), '');
    const failed = await withRunner(f.runner, () => createWorktree(s.dir, s.config, id));
    assert.ok(failed.created);
    assert.equal(failed.ok, false);
    const [entry] = (failed.created && failed.backing) || [];
    assert.equal(entry.ok, false);
    assert.match(entry.error!, /^template forge_tpl_[0-9a-f]{12}: migrate failed/);
    assert.deepEqual(
      entry.build?.map((x) => [x.cmd, x.ok]),
      [[MIGRATE, false]],
      'seed skipped',
    );
    assert.deepEqual(entry.database, { name: jobDbName(id), template: templateName(s.config.backing[0], failed.path), action: 'none', template_action: 'none' });
    assert.deepEqual(failed.created && failed.setup, []);
    assert.ok(!fs.existsSync(path.join(failed.path, 'setup-ran')), 'setup skipped');
    const pg = f.state.pg[server(s)];
    assert.deepEqual(Object.keys(pg.dbs), ['postgres'], 'the half-built template is dropped');
    assert.equal(pg.roles[TEMPLATE_ROLE].login, false);
    assert.ok(!fs.existsSync(dbRecordFile(s.dir, id)));
    assert.deepEqual(
      readEvents(s.dir, id)
        .filter((e) => e.type === 'worktree-setup-failed')
        .map((e) => e.backing),
      ['pg'],
    );
    assert.equal(step(loadStepInput(s.dir, s.config, id)).rule, 'I4');

    // A later create builds it afresh, migrate before seed, as forge_tpl against the template.
    fs.rmSync(path.join(s.dir, 'fail-migrate'));
    await withRunner(f.runner, () => removeWorktree(s.dir, id, { force: true }));
    const ok = await withRunner(f.runner, () => createWorktree(s.dir, s.config, id));
    assert.ok(ok.created && ok.ok, JSON.stringify(ok));
    const t = templateName(s.config.backing[0], ok.path);
    assert.equal(ok.created && ok.backing?.[0].database?.template_action, 'built');
    const lines = dbLog(ok.path);
    assert.deepEqual(
      lines.map((l) => l.split(' ')[0]),
      ['migrate', 'seed'],
    );
    for (const l of lines) {
      const u = parseUrl(l.split(' ')[1]);
      assert.deepEqual([u.user, u.database], [TEMPLATE_ROLE, t]);
    }
    assert.ok(fs.existsSync(path.join(ok.path, 'setup-ran')));
    assert.equal(f.state.pg[server(s)].dbs[t].isTemplate, true);

    // A leftover partial build under the template's name is dropped and built again.
    const other = createJob(s.dir, s.config, { title: 'Leftover' }).id;
    f.state.pg[server(s)].dbs[t].isTemplate = false;
    const again = await withRunner(f.runner, () => createWorktree(s.dir, s.config, other));
    assert.ok(again.created && again.ok, JSON.stringify(again));
    assert.equal(again.created && again.backing?.[0].database?.template_action, 'built');
    assert.equal(f.state.pg[server(s)].dbs[t].isTemplate, true);
  } finally {
    s.cleanup();
  }
});

test('template hash follows inputs and prunes stale templates', async () => {
  const s = scratch([PG]);
  const f = fake();
  try {
    const a = createJob(s.dir, s.config, { title: 'Hash A' }).id;
    const ra = await withRunner(f.runner, () => createWorktree(s.dir, s.config, a));
    assert.ok(ra.created && ra.ok, JSON.stringify(ra));
    const e = s.config.backing[0];
    const t1 = templateName(e, ra.path);
    assert.equal(ra.backing?.[0].database?.template, t1);
    fs.writeFileSync(path.join(ra.path, 'notes.txt'), 'unmatched\n');
    assert.equal(templateName(e, ra.path), t1, 'an unmatched file leaves the name alone');
    fs.writeFileSync(path.join(ra.path, 'db', '002.sql'), 'alter table t add y int;\n');
    const t2 = templateName(e, ra.path);
    assert.notEqual(t2, t1, 'a new untracked input changes it');
    fs.writeFileSync(path.join(ra.path, 'db', '001.sql'), 'create table t(x bigint);\n');
    assert.notEqual(templateName(e, ra.path), t2, 'an edited input changes it');
    fs.rmSync(path.join(ra.path, 'db', '002.sql'));
    fs.writeFileSync(path.join(ra.path, 'db', '001.sql'), 'create table t(x int);\n');
    assert.equal(templateName(e, ra.path), t1, 'back to the same content, back to the same name');
    for (const changed of [
      { ...e, image: 'postgres:17' },
      { ...e, database: { ...e.database!, migrate: 'true' } },
      { ...e, database: { ...e.database!, seed: 'true' } },
      { ...e, database: { ...e.database!, inputs: ['db/*.sql'] } },
    ])
      assert.notEqual(templateName(changed, ra.path), t1, JSON.stringify(changed).slice(0, 80));

    // A stale template no record names, and one another job's record names.
    const pg = f.state.pg[server(s)];
    const stale = 'forge_tpl_aaaaaaaaaaaa';
    const named = 'forge_tpl_bbbbbbbbbbbb';
    for (const d of [stale, named]) pg.dbs[d] = { owner: 'postgres', isTemplate: true, allowConn: false, clonedFrom: null, connectRevoked: false };
    const c = createJob(s.dir, s.config, { title: 'Hash C' }).id;
    fs.writeFileSync(dbRecordFile(s.dir, c), JSON.stringify({ v: 1, databases: { pg: { template: named, password: 'p'.repeat(32) } } }));

    // Job B builds a new template (its seed differs), which prunes only the stale one.
    const bId = createJob(s.dir, s.config, { title: 'Hash B' }).id;
    const config2 = { ...s.config, backing: [{ ...e, database: { ...e.database!, seed: `${SEED}; true` } }] };
    const rb = await withRunner(f.runner, () => createWorktree(s.dir, config2, bId));
    assert.ok(rb.created && rb.ok, JSON.stringify(rb));
    const t3 = rb.backing?.[0].database?.template;
    assert.notEqual(t3, t1);
    assert.equal(rb.backing?.[0].database?.template_action, 'built');
    assert.deepEqual(Object.keys(pg.dbs).filter((d) => d.startsWith('forge_tpl_')).sort(), [t1, named, t3].sort(), "A's template and the one C's record names are kept");
  } finally {
    s.cleanup();
  }
});

test('passwords reach only the record and command env', async () => {
  const s = scratch([PG], [SETUP]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Secret' }).id;
    const created = await withRunner(f.runner, () => createWorktree(s.dir, s.config, id));
    assert.ok(created.created && created.ok, JSON.stringify(created));
    const jobPw = readDbRecord(s.dir, id, s.config).databases.pg.password;
    const tplPw = parseUrl(dbLog(created.path)[0].split(' ')[1]).password;
    assert.match(jobPw, /^[A-Za-z0-9_-]{32}$/);
    assert.match(tplPw, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(jobPw, tplPw);
    const job = loadJob(s.dir, id);
    const up = await withRunner(f.runner, () => b.backingUp(s.dir, s.config, job, f.runner, databaseCommands(s.dir, s.config, job)));
    assert.equal(up[0].database?.action, 'kept');
    const status = b.backingStatus(s.dir, s.config, id, f.runner);
    const brief = step(loadStepInput(s.dir, s.config, id));
    const events = fs.readFileSync(path.join(s.dir, '.forge', 'jobs', id, 'events.jsonl'), 'utf8');
    const outputs = { created, up, status, brief, events };
    // Tails Forge stores show the url with the password redacted.
    assert.ok(created.created && created.setup[0].tail.includes(':[redacted]@'), created.created ? created.setup[0].tail : '');
    assert.ok(created.created && created.backing?.[0].build?.[0].tail.includes(':[redacted]@'));
    const down = b.backingDown(s.dir, s.config, id, f.runner);
    assert.deepEqual(down.databases, [jobDbName(id)]);
    for (const pw of [jobPw, tplPw]) {
      for (const c of f.calls) {
        assert.ok(!c.args.join(' ').includes(pw), `argv: ${c.args.join(' ')}`);
        assert.ok(!(c.input ?? '').includes(pw), 'stdin carries only a verifier');
      }
      for (const [k, v] of Object.entries({ ...outputs, down })) assert.ok(!JSON.stringify(v).includes(pw), `${k} holds a password`);
    }
    for (const c of f.calls.filter((x) => /PASSWORD '/.test(x.input ?? ''))) assert.match(c.input!, /PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+'/);
    assert.ok(!JSON.stringify(status).includes('postgres://'), 'status lists env names, never values');
  } finally {
    s.cleanup();
  }
});

test('record is 0600 and a forged record steers nothing', async () => {
  const s = scratch([PG]);
  const f = fake();
  try {
    const a = createJob(s.dir, s.config, { title: 'Forge A' }).id;
    const bId = createJob(s.dir, s.config, { title: 'Forge B' }).id;
    const [ra, rb] = await withRunner(f.runner, () => [createWorktree(s.dir, s.config, a), createWorktree(s.dir, s.config, bId)]);
    assert.ok(ra.ok && rb.ok);
    const file = dbRecordFile(s.dir, a);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(good), ['v', 'databases']);
    const t = good.databases.pg.template;
    const valid = 'v'.repeat(32);
    const forged: unknown[] = [
      { v: 1, databases: { pg: { template: t, password: `${"x'; DROP ROLE postgres; --".padEnd(32, 'y')}` } } },
      { v: 1, databases: { pg: { template: t, password: 'short' } } },
      { v: 1, databases: { pg: { template: 'forge_tpl_ZZ', password: valid } } },
      { v: 1, databases: { pg: { template: `${t}"; DROP DATABASE postgres; --`, password: valid } } },
      { v: 1, databases: { other: { template: t, password: valid } } },
      { v: 1, databases: { ['__proto__']: { template: t, password: valid } } },
      'not json',
    ];
    for (const rec of forged) {
      fs.writeFileSync(file, typeof rec === 'string' ? rec : JSON.stringify(rec));
      assert.deepEqual(readDbRecord(s.dir, a, s.config).databases, {}, JSON.stringify(rec));
      assert.equal(b.backingEnv(s.dir, s.config, { id: a }).FORGE_BACKING_PG_URL, undefined, 'no url without a valid record');
    }
    // A symlink to another job's record is not followed.
    fs.rmSync(file);
    fs.symlinkSync(dbRecordFile(s.dir, bId), file);
    assert.deepEqual(readDbRecord(s.dir, a, s.config).databases, {});
    fs.rmSync(file);

    // A rerun with a forged record keeps the database, gives the role a new password and rewrites the record.
    fs.writeFileSync(file, JSON.stringify(forged[0]));
    const before = f.state.sql.length;
    const job = loadJob(s.dir, a);
    const [up] = b.backingUp(s.dir, s.config, job, f.runner, databaseCommands(s.dir, s.config, job));
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.equal(up.database?.action, 'kept');
    const rewritten = readDbRecord(s.dir, a, s.config).databases.pg;
    assert.match(rewritten.password, /^[A-Za-z0-9_-]{32}$/);
    assert.ok(verifies(f.state.pg[server(s)].roles[jobDbName(a)].verifier, rewritten.password));
    assert.ok(!f.state.sql.slice(before).some((x: any) => x.s.includes('DROP ROLE postgres')), 'nothing from the forged record reached SQL');

    // Teardown with a record that names B's database drops only A's.
    fs.writeFileSync(file, JSON.stringify({ v: 1, name: jobDbName(bId), databases: { pg: { template: t, password: valid, name: jobDbName(bId), database: jobDbName(bId) } } }));
    const down = b.backingDown(s.dir, s.config, a, f.runner);
    assert.deepEqual(down.databases, [jobDbName(a)]);
    const pg = f.state.pg[server(s)];
    assert.ok(!pg.dbs[jobDbName(a)] && !pg.roles[jobDbName(a)]);
    assert.ok(pg.dbs[jobDbName(bId)] && pg.roles[jobDbName(bId)], "B's database and role are untouched");
    assert.ok(pg.dbs[t], 'the template is untouched');
  } finally {
    s.cleanup();
  }
});

test('teardown drops only this job\'s database and retries', async () => {
  const s = scratch([PG]);
  const f = fake();
  try {
    const a = createJob(s.dir, s.config, { title: 'Down A' }).id;
    const bId = createJob(s.dir, s.config, { title: 'Down B' }).id;
    const [ra, rb] = await withRunner(f.runner, () => [createWorktree(s.dir, s.config, a), createWorktree(s.dir, s.config, bId)]);
    assert.ok(ra.ok && rb.ok);
    const pg = () => f.state.pg[server(s)];

    // Docker down: reported, the record kept for a retry.
    f.state.daemon = 'down';
    const failed = await withRunner(f.runner, () => removeWorktree(s.dir, a, { force: true }));
    assert.ok(failed.removed, 'the worktree still goes');
    assert.equal(failed.backing?.ok, false);
    assert.match(failed.backing!.error!, /daemon is not reachable/);
    assert.ok(fs.existsSync(dbRecordFile(s.dir, a)), 'kept for a retry');
    f.state.daemon = 'up';

    // A stopped shared container: nothing reachable now, so the record stays too.
    f.state.containers[server(s)].running = false;
    const stopped = b.backingDown(s.dir, s.config, a, f.runner);
    assert.equal(stopped.ok, false);
    assert.match(stopped.error!, /is stopped/);
    assert.ok(fs.existsSync(dbRecordFile(s.dir, a)));
    f.state.containers[server(s)].running = true;

    // So is a failing psql call.
    f.state.failExec = '^DROP DATABASE';
    const psqlFails = b.backingDown(s.dir, s.config, a, f.runner);
    assert.equal(psqlFails.ok, false);
    assert.match(psqlFails.error!, /^docker exec failed: .*injected failure/);
    assert.ok(fs.existsSync(dbRecordFile(s.dir, a)));
    f.state.failExec = null;

    const retried = await withRunner(f.runner, () => removeWorktree(s.dir, a, { force: true }));
    assert.deepEqual(retried.backing, { removed: [], volumes: [], databases: [jobDbName(a)], ok: true });
    assert.ok(!fs.existsSync(dbRecordFile(s.dir, a)));
    assert.ok(!pg().dbs[jobDbName(a)] && !pg().roles[jobDbName(a)]);
    assert.ok(pg().dbs[jobDbName(bId)], "the other job's database is left alone");

    // The shared container is gone: nothing left to reach, so the record goes and ok stays true.
    delete f.state.containers[server(s)];
    const gone = await withRunner(f.runner, () => removeWorktree(s.dir, bId, { force: true }));
    assert.deepEqual(gone.backing, { removed: [], volumes: [], databases: [], ok: true });
    assert.ok(!fs.existsSync(dbRecordFile(s.dir, bId)));
  } finally {
    s.cleanup();
  }
});

test('no database key means no exec', async () => {
  const shared = { name: 'pg', isolation: 'shared', image: 'postgres:16', ports: [5432], url: 'postgres://app@{host}:{port}/app' };
  const s = scratch([shared]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Plain' }).id;
    const res = await withRunner(f.runner, () => createWorktree(s.dir, s.config, id));
    assert.ok(res.created && res.ok);
    assert.deepEqual(res.backing, [{ name: 'pg', isolation: 'shared', action: 'created', ok: true }], 'no database key in the result');
    const status = b.backingStatus(s.dir, s.config, id, f.runner);
    assert.equal('database' in status.services[0], false);
    assert.ok(status.services[0].env.includes('FORGE_BACKING_PG_URL'));
    assert.deepEqual(b.backingDown(s.dir, s.config, id, f.runner), { removed: [], volumes: [], ok: true });
    assert.equal(b.hasJobBacking(s.dir, s.config, id), false);
    assert.equal(f.execs().length, 0, 'no docker exec call');
  } finally {
    s.cleanup();
  }
});

test('the server not accepting connections fails the entry', async () => {
  const s = scratch([PG]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Slow' }).id;
    const job = loadJob(s.dir, id);
    // Bring the container up without a worktree: the entry says why, and no SQL runs.
    const [noWt] = b.backingUp(s.dir, s.config, job, f.runner, databaseCommands(s.dir, s.config, job));
    assert.equal(noWt.ok, false);
    assert.equal(noWt.error, `job ${id} has no worktree: run forge worktree create ${id}`);
    assert.equal(f.execs().length, 0);
    fs.mkdirSync(path.join(path.dirname(s.dir), `${path.basename(s.dir)}.wt`, id), { recursive: true });
    f.state.notReadyFor[server(s)] = 1_000;
    const [slow] = b.backingUp(s.dir, s.config, job, f.runner, { ...databaseCommands(s.dir, s.config, job), readyTimeoutMs: 300 });
    assert.equal(slow.ok, false);
    assert.match(slow.error!, /did not accept connections within 0 s$/);
    assert.ok(f.execs().every((c) => c.args.includes('pg_isready')), 'only the ready check ran');
  } finally {
    s.cleanup();
  }
});
