// What a configured command's child sees through the real CLI (docs/CONFIG.md "Command environment"
// and "Secret references"): the allowlist plus commandEnv.inherit in and out of the daemon, a declared
// secret only through its sink, the login profile only under commandEnv.loginShell, and the eval check
// on the same environment. Every planted value is built at runtime (test/secret-fixtures.ts), and
// nothing here changes process.env, so the tests run side by side.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, evalTaskYml, forgeAsync, repoTemplate, waitFor } from '../../helpers.ts';
import { base64Of, token } from '../../secret-fixtures.ts';
import { TRUST_ENV, trustDigest } from '#core/config/trust.ts';
import { findOnPath } from '#core/os/process.ts';
import { sanitizePath } from '#engine/guard/command-env.ts';
import * as yaml from '#core/format/yaml.ts';

// Writes the child's whole environment to $CMDENV_OUT, read in node so no shell expansion is involved.
const DUMP = `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.env.CMDENV_OUT, JSON.stringify(process.env))'`;

const DB_VALUE = token.bearer('cmdenv-db');
const GH_VALUE = token.github('cmdenv');
const NPM_VALUE = token.bearer('cmdenv-npm');
const AWS_VALUE = base64Of('cmdenv-aws');
const CORP_VALUE = base64Of('cmdenv-corp');

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '..', `answers-${path.basename(dir)}.json`);
  fs.writeFileSync(
    answers,
    JSON.stringify({
      commands: { dump: DUMP, bgdump: DUMP },
      commandEnv: { inherit: ['CMDENV_OUT', 'JAVA_*'] },
      verify: ['dump'],
      worktrees: { root: '../{repo}.wt' },
      secrets: { DB: { env: 'CMDENV_DB_SRC' } },
      components: [{ name: 'app', path: '.', kind: 'service', config: [{ env: { DB_PASSWORD: '{secret.DB}' } }] }],
    }),
  );
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  const task = path.join(dir, '.forge', 'evals', 'envcheck');
  fs.mkdirSync(path.join(task, 'check', 'files'), { recursive: true });
  fs.writeFileSync(path.join(task, 'check', 'files', 'check.txt'), 'check\n');
  fs.writeFileSync(path.join(task, 'task.yml'), evalTaskYml('envcheck', DUMP));
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A copy of the template with one job on component `app`, its worktree created, in round 1. */
async function scratch() {
  const r = template();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cmdenv-'));
  const forge = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const res = await forgeAsync(r.dir, args, env);
    assert.equal(res.status, 0, `forge ${args.join(' ')} exited ${res.status}: ${res.stderr}${res.stdout}`);
    return JSON.parse(res.stdout);
  };
  const job = await forge(['job', 'new', '--title', 'env dump', '--components', 'app']);
  await forge(['worktree', 'create', job.id]);
  await forge(['job', 'round', job.id]);
  let n = 0;
  /**
   * Runs `args` with `env` plus a fresh $CMDENV_OUT, and returns the child's environment. A
   * background command is still running when the CLI returns, so its file is polled.
   */
  const dump = async (args: string[], env: NodeJS.ProcessEnv = {}): Promise<Record<string, string>> => {
    const file = path.join(out, `dump-${n++}.json`);
    const res = await forge(args, { ...env, CMDENV_OUT: file });
    const text = await waitFor(() => {
      try {
        const t = fs.readFileSync(file, 'utf8');
        return t.endsWith('}') ? t : null;
      } catch {
        return null;
      }
    }, { what: `${args.join(' ')}'s dump` });
    // A live background process would be reused by the next --background call instead of started.
    if (typeof res.pid === 'number') await waitFor(() => !alive(res.pid), { what: `${args.join(' ')} to exit` });
    return JSON.parse(text);
  };
  // Taken after the last config write, as a human starting the daemon would.
  const daemon = () => ({ FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(r.dir), FORGE_DAEMON_SCOPE: job.id });
  const cleanup = () => {
    r.cleanup();
    fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  };
  return { root: r.dir, id: job.id as string, forge, dump, daemon, out, cleanup };
}

/** Rewrites the scratch's config.yml with `commandEnv` set to `value`. */
function setCommandEnv(root: string, value: Record<string, unknown>): void {
  const file = path.join(root, '.forge', 'config.yml');
  const config = yaml.parse(fs.readFileSync(file, 'utf8'));
  config.commandEnv = value;
  fs.writeFileSync(file, yaml.stringify(config));
}

const planted = {
  CMDENV_DB_SRC: DB_VALUE,
  GH_TOKEN: GH_VALUE,
  NPM_TOKEN: NPM_VALUE,
  AWS_SECRET_ACCESS_KEY: AWS_VALUE,
  CORP_SESSION_BLOB: CORP_VALUE,
  JAVA_HOME: '/opt/jdk-cmdenv',
};

const commands = (id: string) => [['run', id, 'dump'], ['verify', id], ['run', id, 'bgdump', '--background']];

describe('the command environment through the CLI', { concurrency: 4 }, () => {
  test('a declared secret reaches a command only through its sink', async () => {
    const s = await scratch();
    try {
      for (const mode of [{}, s.daemon()]) {
        const label = Object.keys(mode).length ? 'daemon' : 'interactive';
        for (const args of commands(s.id)) {
          const env = await s.dump(args, { ...planted, ...mode });
          assert.equal(env.DB_PASSWORD, DB_VALUE, `${label} ${args.join(' ')}: the sink sets DB_PASSWORD`);
          assert.equal(env.CMDENV_DB_SRC, undefined, `${label} ${args.join(' ')}: the source variable is gone`);
        }
      }
    } finally {
      s.cleanup();
    }
  });

  test('forge run, verify and run --background children get only the allowlist in both modes', async () => {
    const s = await scratch();
    try {
      const marker = path.join(s.out, 'marker-bin');
      fs.mkdirSync(marker);
      const captured = [marker, '.', process.env.PATH ?? ''].join(path.delimiter);
      const pins = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'forge.cmdenvtest', GIT_CONFIG_VALUE_0: 'pinned', GIT_EDITOR: 'true' };
      for (const mode of [{}, s.daemon()]) {
        const label = Object.keys(mode).length ? 'daemon' : 'interactive';
        for (const args of commands(s.id)) {
          const what = `${label} ${args.join(' ')}`;
          const env = await s.dump(args, { ...planted, ...pins, ...mode, FORGE_COMMAND_PATH: captured });
          for (const k of ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'CORP_SESSION_BLOB', 'CMDENV_DB_SRC', 'FORGE_COMMAND_PATH']) assert.equal(env[k], undefined, `${what}: ${k} is gone`);
          assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('FORGE_DAEMON')), [], `${what}: no FORGE_DAEMON*`);
          assert.equal(env.DB_PASSWORD, DB_VALUE, `${what}: the sink's value`);
          assert.equal(env.JAVA_HOME, planted.JAVA_HOME, `${what}: JAVA_HOME through commandEnv.inherit`);
          for (const [k, v] of Object.entries(pins)) assert.equal(env[k], v, `${what}: ${k}`);
          assert.equal(env.FORGE_JOB, s.id, `${what}: FORGE_JOB`);
          assert.equal(env.PATH, sanitizePath(captured), `${what}: the captured PATH, sanitised`);
        }
      }
    } finally {
      s.cleanup();
    }
  });

  const zsh = findOnPath('zsh');
  test('a login profile is sourced only under commandEnv.loginShell', { skip: process.platform === 'win32' || !zsh ? 'needs zsh off Windows' : false }, async () => {
    const s = await scratch();
    try {
      const zdot = path.join(s.out, 'zdot');
      const marker = path.join(s.out, 'zshenv-ran');
      fs.mkdirSync(zdot);
      fs.writeFileSync(path.join(zdot, '.zshenv'), `: > ${JSON.stringify(marker)}\n`);
      // ZDOTDIR is inherited, so only the shell decides whether .zshenv runs. The sink needs its source.
      setCommandEnv(s.root, { inherit: ['CMDENV_OUT', 'ZDOTDIR'] });
      const env = { SHELL: zsh!, ZDOTDIR: zdot, CMDENV_DB_SRC: DB_VALUE };
      await s.dump(['run', s.id, 'dump'], { ...env, ...s.daemon() });
      assert.equal(fs.existsSync(marker), false, 'the daemon run sourced no .zshenv');
      await s.dump(['run', s.id, 'dump'], env);
      assert.equal(fs.existsSync(marker), false, 'the interactive run sourced no .zshenv');
      setCommandEnv(s.root, { inherit: ['CMDENV_OUT', 'ZDOTDIR'], loginShell: true });
      await s.dump(['run', s.id, 'dump'], env);
      assert.equal(fs.existsSync(marker), true, 'the control: with commandEnv.loginShell the login zsh sources it');
    } finally {
      s.cleanup();
    }
  });

  test('the eval check runs with the command environment', async () => {
    const s = await scratch();
    try {
      const run = await s.forge(['eval', 'start', '--tasks', 'envcheck']);
      const evalJob: string = run.tasks[0].job;
      const env = await s.dump(['eval', 'grade', evalJob], { CMDENV_DB_SRC: DB_VALUE, FORGE_DAEMON_ANYTHING: 'x', FORGE_BACKING_OUTER_URL: 'postgres://outer' });
      assert.equal(env.FORGE_JOB, evalJob);
      for (const k of ['CMDENV_DB_SRC', 'FORGE_DAEMON_ANYTHING', 'FORGE_BACKING_OUTER_URL']) assert.equal(env[k], undefined, `${k} is gone`);
    } finally {
      s.cleanup();
    }
  });
});
