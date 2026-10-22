import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { envFor } from '../lib/job-command.ts';
import { sessionEnv } from '../lib/daemon.ts';
import { TRUST_ENV, trustDigest } from '../lib/core/config/load.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const job = { id: 'j1', branch: 'forge/j1', base: 'main' } as any;
const markers = (env) => Object.keys(env).filter((k) => k.startsWith('FORGE_DAEMON'));

test('command env drops the daemon markers and keeps everything else', () => {
  const base = { FORGE_DAEMON: '', FORGE_DAEMON_TRUST: 'a'.repeat(64), FORGE_DAEMON_SCOPE: 'j1', FORGE_DAEMON_ANYTHING: 'x', FORGE_DAEMONISH: 'kept', UNRELATED: 'yes' };
  const copy = structuredClone(base);
  const env = envFor(job, '/wt/j1', 4100, base);
  assert.deepEqual(markers(env).sort(), ['FORGE_DAEMONISH'], 'only names that are the marker or start with FORGE_DAEMON_ are dropped');
  assert.equal(env.UNRELATED, 'yes');
  assert.equal(env.FORGE_JOB, 'j1');
  assert.equal(env.FORGE_WORKTREE, '/wt/j1');
  assert.equal(env.PORT, '4100');
  assert.equal(env.FORGE_PORT, '4100');
  assert.deepEqual(base, copy, 'base is not changed');
  assert.equal(envFor(job, '/wt/j1', null, base).PORT, '');
});

test("command env drops an outer job's port, endpoint and backing variables", () => {
  const base = { FORGE_PORT_DASHBOARD: '4101', FORGE_ENDPOINT_DASHBOARD: 'http://localhost:4101', FORGE_BACKING_POSTGRES_URL: 'postgres://x', FORGE_PORTAL: 'kept', UNRELATED: 'yes' };
  const env = envFor(job, '/wt/j1', 4100, base);
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('FORGE_')).sort(), ['FORGE_JOB', 'FORGE_PORT', 'FORGE_PORTAL', 'FORGE_WORKTREE']);
  assert.equal(env.UNRELATED, 'yes');
});

test("command env keeps the daemon's git pins", () => {
  const base = sessionEnv({ PATH: '/usr/bin', FORGE_DAEMON_SCOPE: 'x', [TRUST_ENV]: 'b'.repeat(64) });
  const env = envFor(job, '/wt/j1', null, base);
  assert.deepEqual(markers(env), []);
  const count = Number(base.GIT_CONFIG_COUNT);
  assert.ok(count >= 2);
  assert.equal(env.GIT_CONFIG_COUNT, base.GIT_CONFIG_COUNT);
  for (let i = 0; i < count; i++) {
    assert.equal(env[`GIT_CONFIG_KEY_${i}`], base[`GIT_CONFIG_KEY_${i}`]);
    assert.equal(env[`GIT_CONFIG_VALUE_${i}`], base[`GIT_CONFIG_VALUE_${i}`]);
  }
  const pins = Array.from({ length: count }, (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`);
  assert.ok(pins.includes(`core.hooksPath=${os.devNull}`) && pins.includes('core.fsmonitor=false'));
  assert.equal(env.GIT_EDITOR, base.GIT_EDITOR);
  assert.equal(env.PATH, base.PATH);
});

test('verify and run commands under a daemon session see no daemon markers', async () => {
  const repo = tempRepo();
  const other = tempRepo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cmdenv-')));
  const out = (name) => path.join(tmp, `${name}.json`);
  const read = (name) => JSON.parse(fs.readFileSync(out(name), 'utf8'));
  /** @param {NodeJS.ProcessEnv} env @param {string[]} args */
  const cli = (env, ...args) => {
    try {
      const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, FORGE_ROOT: repo.dir, ...env } });
      return { ok: true, out: stdout.trim() };
    } catch (e) {
      return { ok: false, out: `${e.stdout}${e.stderr}` };
    }
  };
  const human = (...args) => JSON.parse(cli({}, ...args).out);
  const dump = (name) => `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.env))" ${JSON.stringify(out(name))}`;
  try {
    const otherAnswers = path.join(tmp, 'other-answers.json');
    fs.writeFileSync(otherAnswers, JSON.stringify({ commands: { test: 'true' } }));
    execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', otherAnswers], { cwd: other.dir, stdio: 'pipe', env: { ...process.env, FORGE_ROOT: other.dir } });

    const answers = path.join(tmp, 'answers.json');
    const check = `${dump('verify')} && FORGE_ROOT=${JSON.stringify(other.dir)} ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} status`;
    fs.writeFileSync(answers, JSON.stringify({ commands: { check, fg: dump('run'), bg: dump('background') }, verify: ['check'], worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
    human('init', 'write', '--answers', answers);
    human('tracker', 'create', '--title', 'Env');
    const { id } = human('next', '--claim', '--session', 's1');
    human('worktree', 'create', id);
    human('job', 'round', id);
    // Taken after every human step that writes config, as the supervisor does at spawn.
    const daemon = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(repo.dir), FORGE_DAEMON_SCOPE: id };
    const clean = (name) => {
      const env = read(name);
      assert.equal(env.FORGE_JOB, id, `${name}: FORGE_JOB is set`);
      assert.deepEqual(markers(env), [], `${name}: no daemon marker reaches the command`);
    };

    const v = cli(daemon, 'verify', id);
    assert.equal(v.ok, true, v.out);
    assert.equal(JSON.parse(v.out).ok, true, 'the nested forge status against another repo is not judged by the daemon trust check');
    clean('verify');

    assert.equal(cli(daemon, 'run', id, 'fg').ok, true);
    clean('run');

    assert.equal(cli(daemon, 'run', id, 'bg', '--background').ok, true);
    // Retries the parse too: the file can exist before its write finishes.
    const deadline = Date.now() + 10_000;
    let bg = null;
    while (!bg && Date.now() < deadline) {
      try {
        bg = read('background');
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(bg, 'the background command wrote its env within 10 s');
    clean('background');

    const cfgFile = path.join(repo.dir, '.forge', 'config.yml');
    fs.appendFileSync(cfgFile, '# changed\n');
    fs.rmSync(out('verify'));
    const refused = cli(daemon, 'verify', id);
    assert.equal(refused.ok, false);
    assert.match(refused.out, /changed since a human started the daemon/);
    assert.equal(fs.existsSync(out('verify')), false, 'the outer call is refused before any step runs');
  } finally {
    repo.cleanup();
    other.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(`${other.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
