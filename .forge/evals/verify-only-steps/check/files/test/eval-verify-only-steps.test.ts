// Hidden check for the eval task verify-only-steps: `forge verify <id> --only <step>[,<step>]`.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, scratch, type Scratch } from './eval-check-harness.ts';

let s: Scratch;
let logDir: string;
let log: string;
let id: string;
// Commands run through $SHELL -lc; a plain sh keeps the user's login profile out of the grade.
const env = { SHELL: '/bin/sh' };

const ran = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const reset = () => fs.rmSync(log, { force: true });

before(async () => {
  logDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eval-only-')));
  log = path.join(logDir, 'ran.log');
  const step = (name: string) => `echo ${name} >> '${log}'`;
  s = scratch({ tracker: { kind: 'none' }, commands: { build: step('build'), lint: step('lint'), test: step('test') }, verify: ['build', 'lint', 'test'] });
  const job = await s.forge(['job', 'new', '--title', 'Only some steps'], env);
  assert.equal(job.status, 0, job.stderr);
  id = json(job).id;
  const wt = await s.forge(['worktree', 'create', id], env);
  assert.equal(wt.status, 0, wt.stderr);
  reset();
});

after(() => {
  s?.cleanup();
  if (logDir) fs.rmSync(logDir, { recursive: true, force: true });
});

const shown = async () => {
  const r = await s.forge(['job', 'show', id], env);
  assert.equal(r.status, 0, r.stderr);
  return json(r);
};

test('an unknown --only name is a usage error that lists the configured steps, and nothing runs', async () => {
  reset();
  const r = await s.forge(['verify', id, '--only', 'test,nope'], env);
  assert.equal(r.status, 2, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /nope/);
  for (const name of ['build', 'lint', 'test']) assert.match(r.stderr, new RegExp(`\\b${name}\\b`), `the error names configured step ${name}`);
  assert.deepEqual(ran(), [], 'no step ran');
  const job = await shown();
  assert.equal(job.verified, null, 'a refused run records no verify');
});

test('--only test runs only test, says it was partial, and leaves the head unverified', async () => {
  reset();
  const r = await s.forge(['verify', id, '--only', 'test'], env);
  assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const out = json(r);
  assert.deepEqual(ran(), ['test']);
  assert.equal(out.ok, true);
  assert.equal(out.partial, true);
  assert.deepEqual(out.only, ['test']);
  const names = out.steps.map((x: { name: string }) => x.name);
  assert.ok(names.includes('test'), `steps lists test: ${names}`);
  assert.ok(!names.includes('build') && !names.includes('lint'), `steps lists no unnamed configured step: ${names}`);
  const job = await shown();
  assert.equal(job.verified, null, 'a partial run is not a verified head');
  assert.equal(job.verify, null, 'a partial run sets no round result');
});

test('--only keeps configured order and accepts several names', async () => {
  reset();
  const r = await s.forge(['verify', id, '--only', 'test,build'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = json(r);
  assert.deepEqual(ran(), ['build', 'test']);
  assert.equal(out.partial, true);
  const names = out.steps.map((x: { name: string }) => x.name).filter((n: string) => ['build', 'lint', 'test'].includes(n));
  assert.deepEqual(names, ['build', 'test']);
  assert.equal((await shown()).verified, null);
});

test('a later full verify runs every step and verifies the head', async () => {
  reset();
  const r = await s.forge(['verify', id], env);
  assert.equal(r.status, 0, r.stderr);
  const out = json(r);
  assert.deepEqual(ran(), ['build', 'lint', 'test']);
  assert.ok(out.partial === undefined || out.partial === false, `a full run is not partial: ${out.partial}`);
  const wt = (await shown()).worktree;
  const head = s.git('-C', wt, 'rev-parse', 'HEAD').trim();
  const job = await shown();
  assert.equal(job.verify, 'PASS');
  assert.equal(job.verified?.ok, true);
  assert.equal(job.verified?.sha, head);
});
