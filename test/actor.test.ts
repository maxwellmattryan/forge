// Who did a human action: the resolution order, the gh cache, sanitising, laziness in the real CLI,
// and the events that carry the actor.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { ACTOR_CACHE_TTL_MS, currentActor, resolveActor } from '../lib/actor.ts';
import type { ActorDeps } from '../lib/actor.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, readEvents, setJob } from '../lib/jobs.ts';
import { EVENT_SCHEMA_VERSION, normalizeEvent, sanitizeLogin } from '../lib/schema.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const DAY = ACTOR_CACHE_TTL_MS;
const T0 = Date.parse('2026-10-16T12:00:00Z');

const repo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-actor-')));
}

/** Injected deps that record every gh call; each source answers with `vals`. */
function deps(vals: { env?: NodeJS.ProcessEnv; gh?: string | null; git?: string | null; os?: string | null; cacheFile?: string | null; now?: number } = {}) {
  const calls = { gh: 0, git: 0, os: 0 };
  const d: ActorDeps = {
    env: vals.env ?? {},
    gh: () => (calls.gh++, vals.gh ?? null),
    gitEmail: () => (calls.git++, vals.git ?? null),
    osUser: () => (calls.os++, vals.os ?? null),
    cacheFile: vals.cacheFile ?? null,
    now: () => vals.now ?? T0,
  };
  return { d, calls };
}

// First in the file: currentActor memoises per process, so it must run before anything resolves an actor.
test('currentActor falls back to the repo git email when gh has no login', () => {
  const r = repo();
  const keys = ['HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'FORGE_ACTOR', 'FORGE_DAEMON'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const home = tmpDir();
  for (const k of keys) delete process.env[k];
  // An empty home and gh config dir leave gh, if installed, logged out, so the git email answers.
  process.env.HOME = home;
  process.env.GH_CONFIG_DIR = path.join(home, 'gh');
  try {
    assert.equal(currentActor(r.dir).source, 'git');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolution order', () => {
  const all = { gh: 'octo', git: 'me@example.com', os: 'maxine' };
  // Daemon sessions are the dashboard's person, even with FORGE_ACTOR set.
  assert.deepEqual(resolveActor(deps({ ...all, env: { FORGE_DAEMON: '1', FORGE_ACTOR: 'spoof' } }).d), { login: 'maxine', source: 'dashboard' });
  assert.deepEqual(resolveActor(deps({ env: { FORGE_DAEMON: '1' } }).d), { login: null, source: 'dashboard' });
  const env = deps({ ...all, env: { FORGE_ACTOR: 'alice' } });
  assert.deepEqual(resolveActor(env.d), { login: 'alice', source: 'env' });
  assert.equal(env.calls.gh, 0, 'FORGE_ACTOR wins without asking gh');
  assert.deepEqual(resolveActor(deps({ ...all, env: { FORGE_ACTOR: '' } }).d), { login: 'octo', source: 'gh' });
  assert.deepEqual(resolveActor(deps({ ...all, gh: null }).d), { login: 'me@example.com', source: 'git' });
  assert.deepEqual(resolveActor(deps({ ...all, gh: null, git: null }).d), { login: 'maxine', source: 'os' });
  assert.deepEqual(resolveActor(deps({}).d), { login: null, source: 'unknown' });
});

test('gh cache keyed by host with a day TTL', () => {
  const dir = tmpDir();
  const cacheFile = path.join(dir, 'runtime', 'actor.json');
  const read = () => JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  try {
    // A failed gh call writes nothing.
    const fail = deps({ gh: null, git: 'g@x', cacheFile });
    assert.equal(resolveActor(fail.d).source, 'git');
    assert.equal(fs.existsSync(cacheFile), false, 'a failure is not cached');

    const first = deps({ gh: 'octo', cacheFile });
    assert.deepEqual(resolveActor(first.d), { login: 'octo', source: 'gh' });
    assert.equal(first.calls.gh, 1);
    assert.deepEqual(read(), { 'github.com': { login: 'octo', at: T0 } });

    const fresh = deps({ gh: 'other', cacheFile, now: T0 + DAY - 1 });
    assert.deepEqual(resolveActor(fresh.d), { login: 'octo', source: 'gh' });
    assert.equal(fresh.calls.gh, 0, 'a fresh entry skips gh');

    const stale = deps({ gh: 'renamed', cacheFile, now: T0 + DAY });
    assert.deepEqual(resolveActor(stale.d), { login: 'renamed', source: 'gh' });
    assert.equal(stale.calls.gh, 1, 'a day-old entry asks gh again');

    const ghe = deps({ gh: 'enterprise-me', cacheFile, env: { GH_HOST: 'ghe.example.com' }, now: T0 + DAY });
    assert.deepEqual(resolveActor(ghe.d), { login: 'enterprise-me', source: 'gh' });
    assert.equal(ghe.calls.gh, 1, 'another host is another entry');
    assert.deepEqual(Object.keys(read()).sort(), ['ghe.example.com', 'github.com']);

    // A broken cache file is ignored, never fatal.
    fs.writeFileSync(cacheFile, '{not json');
    const broken = deps({ gh: 'octo', cacheFile });
    assert.deepEqual(resolveActor(broken.d), { login: 'octo', source: 'gh' });
    assert.equal(broken.calls.gh, 1);
    // An entry from the future is not fresh.
    fs.writeFileSync(cacheFile, JSON.stringify({ 'github.com': { login: 'later', at: T0 + DAY * 10 } }));
    assert.deepEqual(resolveActor(deps({ gh: 'now', cacheFile }).d), { login: 'now', source: 'gh' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitises logins', () => {
  assert.equal(sanitizeLogin('  al ice\t<script>  '), 'al icescript');
  assert.equal(sanitizeLogin('a    b'), 'a b');
  assert.equal(sanitizeLogin('`@everyone` [x](y)'), '@everyone xy');
  assert.equal(sanitizeLogin('x'.repeat(500)).length, 100);
  assert.equal(sanitizeLogin('=cmd|"/c calc"!A0'), 'cmdc calcA0', 'no formula or shell characters survive');
  for (const empty of ['', '   ', '<>`', null, 3, undefined]) assert.equal(sanitizeLogin(empty), '');

  // An env value that sanitises to nothing falls through to the next source, as does gh's.
  assert.deepEqual(resolveActor(deps({ env: { FORGE_ACTOR: '<>`' }, gh: 'octo' }).d), { login: 'octo', source: 'gh' });
  assert.deepEqual(resolveActor(deps({ env: { FORGE_ACTOR: 'a<b>' } }).d), { login: 'ab', source: 'env' });
  assert.deepEqual(resolveActor(deps({ gh: '\n<>\n', git: 'g@x' }).d), { login: 'g@x', source: 'git' });
  assert.deepEqual(resolveActor(deps({ gh: 'oc`to\n' }).d), { login: 'octo', source: 'gh' });
  assert.deepEqual(resolveActor(deps({ gh: null, git: null, os: '</>' }).d), { login: null, source: 'unknown' });

  // A poisoned cache entry is sanitised, and one that sanitises to nothing asks gh.
  const dir = tmpDir();
  const cacheFile = path.join(dir, 'actor.json');
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ 'github.com': { login: '<img src=x onerror=alert(1)>', at: T0 } }));
    assert.deepEqual(resolveActor(deps({ gh: 'fresh', cacheFile }).d), { login: 'img srcx onerroralert1', source: 'gh' });
    fs.writeFileSync(cacheFile, JSON.stringify({ 'github.com': { login: '```', at: T0 } }));
    const empty = deps({ gh: 'fresh', cacheFile });
    assert.deepEqual(resolveActor(empty.d), { login: 'fresh', source: 'gh' });
    assert.equal(empty.calls.gh, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // And on read: an event's login is sanitised whatever wrote it.
  assert.deepEqual(normalizeEvent({ v: 2, ts: 't', type: 'human', action: 'approve', actor: { login: '@team\n## Pwned', source: 'env' } })!.actor, { login: '@team Pwned', source: 'env' });
});

/** A `gh` on PATH that logs its argv and prints a login. */
function ghStub(): { bin: string; log: string; cleanup: () => void; calls: () => string[] } {
  const bin = tmpDir();
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${log}"\necho stub-login\n`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { bin, log, calls, cleanup: () => fs.rmSync(bin, { recursive: true, force: true }) };
}

describe('the CLI', { concurrency: 4 }, () => {
  test('no gh call without a human action', { skip: process.platform === 'win32' && 'POSIX shell stub' }, async () => {
    const r = repo();
    const gh = ghStub();
    const env = (actor: string) => ({ PATH: `${gh.bin}${path.delimiter}${process.env.PATH}`, FORGE_ACTOR: actor });
    try {
      const id = createJob(r.dir, defaults(), { title: 'Lazy' }).id;
      assert.equal((await forgeAsync(r.dir, ['job', 'show', id], env(''))).status, 0);
      assert.deepEqual(gh.calls(), [], 'a read never resolves an actor');
      assert.equal((await forgeAsync(r.dir, ['job', 'human', id, 'rework', '--note', 'x'], env('alice'))).status, 0);
      assert.deepEqual(gh.calls(), [], 'FORGE_ACTOR set: gh is never called');
      const refused = await forgeAsync(r.dir, ['job', 'human', id, 'not-an-action'], env(''));
      assert.notEqual(refused.status, 0);
      assert.deepEqual(gh.calls(), [], 'a refused human action resolves nobody');
      const ok = await forgeAsync(r.dir, ['job', 'human', id, 'rework', '--note', 'y'], env(''));
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(gh.calls(), ['api user --jq .login']);
      assert.deepEqual(readEvents(r.dir, id).at(-1)!.actor, { login: 'stub-login', source: 'gh' });
      // The cache answers the next one.
      assert.equal((await forgeAsync(r.dir, ['job', 'human', id, 'rework', '--note', 'z'], env(''))).status, 0);
      assert.deepEqual(gh.calls(), ['api user --jq .login']);
    } finally {
      gh.cleanup();
      r.cleanup();
    }
  });

  test('job human stamps the actor', async () => {
    const r = repo();
    try {
      const id = createJob(r.dir, defaults(), { title: 'Stamp' }).id;
      const res = await forgeAsync(r.dir, ['job', 'human', id, 'approve', '--note', 'x'], { FORGE_ACTOR: 'alice' });
      assert.equal(res.status, 0, res.stderr);
      const line = fs.readFileSync(path.join(jobDir(r.dir, id), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
      assert.deepEqual({ ...line, ts: undefined }, { v: EVENT_SCHEMA_VERSION, ts: undefined, type: 'human', action: 'approve', note: 'x', actor: { login: 'alice', source: 'env' } });
    } finally {
      r.cleanup();
    }
  });

  test('human-action events carry the actor', async () => {
    const r = repo();
    const cli = (...args: string[]) => forgeAsync(r.dir, args, { FORGE_ACTOR: 'bob' });
    const BOB = { login: 'bob', source: 'env' };
    const of = (id: string, type: string) => readEvents(r.dir, id).filter((e) => e.type === type);
    try {
      const id = createJob(r.dir, defaults(), { title: 'Carry' }).id;
      assert.equal((await cli('job', 'budget', id, '--set', 'usd=5')).status, 0);
      assert.deepEqual(of(id, 'budget-set').map((e) => e.actor), [BOB]);
      assert.equal((await cli('job', 'link', id, '--none', '--reason', 'tiny')).status, 0);
      assert.deepEqual(of(id, 'issue-link').map((e) => e.actor), [BOB]);

      // A plain claim is the pipeline's; a forced takeover past an unmet dependency is a person's.
      const dep = createJob(r.dir, defaults(), { title: 'Dep' }).id;
      assert.equal((await cli('job', 'claim', dep, '--session', 's1')).status, 0);
      assert.equal(of(dep, 'claimed').at(-1)!.actor, undefined, 'no actor without --force');
      const blocked = createJob(r.dir, defaults(), { title: 'Blocked' }).id;
      setJob(r.dir, blocked, { fields: { dependsOn: [dep] } });
      assert.equal((await cli('job', 'claim', blocked, '--session', 's2')).status, 4);
      const forced = await cli('job', 'claim', blocked, '--session', 's2', '--force');
      assert.equal(forced.status, 0, forced.stderr);
      assert.deepEqual(of(blocked, 'claimed').at(-1)!.actor, BOB);
      assert.deepEqual(of(blocked, 'dependencies-overridden').map((e) => [e.unmet, e.actor]), [[[dep], BOB]]);
    } finally {
      r.cleanup();
    }
  });
});
