// What a configured command's child sees through the real CLI (docs/CONFIG.md "Daemon" and "Secret
// references"): a declared secret only through its sink, no credentials and no login profile under
// the daemon, and the eval check on the same environment. Every planted value is built at runtime
// (test/secret-fixtures.ts), and nothing here changes process.env, so the tests run side by side.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, evalTaskYml, forgeAsync, repoTemplate } from '../../helpers.ts';
import { base64Of, token } from '../../secret-fixtures.ts';
import { TRUST_ENV, trustDigest } from '#core/config/trust.ts';
import { findOnPath } from '#core/os/process.ts';

// Writes the child's whole environment to $CMDENV_OUT, read in node so no shell expansion is involved.
const DUMP = `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.env.CMDENV_OUT, JSON.stringify(process.env))'`;

const DB_VALUE = token.bearer('cmdenv-db');
const GH_VALUE = token.github('cmdenv');
const NPM_VALUE = token.bearer('cmdenv-npm');
const AWS_VALUE = base64Of('cmdenv-aws');

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '..', `answers-${path.basename(dir)}.json`);
  fs.writeFileSync(
    answers,
    JSON.stringify({
      commands: { dump: DUMP },
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

/** A copy of the template with one job on component `app`, its worktree created, in round 1. */
async function scratch() {
  const r = template();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cmdenv-'));
  const forge = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const res = await forgeAsync(r.dir, args, env);
    assert.equal(res.status, 0, `forge ${args.join(' ')} exited ${res.status}: ${res.stderr}${res.stdout}`);
    return JSON.parse(res.stdout);
  };
  const job = await forge(['job', 'new', '--title', 'env dump', '--services', 'app']);
  await forge(['worktree', 'create', job.id]);
  await forge(['job', 'round', job.id]);
  let n = 0;
  /** Runs `args` with `env` plus a fresh $CMDENV_OUT, and returns the child's environment. */
  const dump = async (args: string[], env: NodeJS.ProcessEnv = {}): Promise<Record<string, string>> => {
    const file = path.join(out, `dump-${n++}.json`);
    await forge(args, { ...env, CMDENV_OUT: file });
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  // Taken after the last config write, as a human starting the daemon would.
  const daemon = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(r.dir), FORGE_DAEMON_SCOPE: job.id };
  const cleanup = () => {
    r.cleanup();
    fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  };
  return { root: r.dir, id: job.id as string, forge, dump, daemon, out, cleanup };
}

const planted = { CMDENV_DB_SRC: DB_VALUE, GH_TOKEN: GH_VALUE, NPM_TOKEN: NPM_VALUE, AWS_SECRET_ACCESS_KEY: AWS_VALUE, AWS_REGION: 'eu-west-1' };

describe('the command environment through the CLI', { concurrency: 4 }, () => {
  test('a declared secret reaches a command only through its sink', async () => {
    const s = await scratch();
    try {
      for (const mode of [{}, s.daemon]) {
        const label = Object.keys(mode).length ? 'daemon' : 'interactive';
        for (const args of [['run', s.id, 'dump'], ['verify', s.id]]) {
          const env = await s.dump(args, { ...planted, ...mode });
          assert.equal(env.DB_PASSWORD, DB_VALUE, `${label} ${args[0]}: the sink sets DB_PASSWORD`);
          assert.equal(env.CMDENV_DB_SRC, undefined, `${label} ${args[0]}: the source variable is gone`);
        }
      }
    } finally {
      s.cleanup();
    }
  });

  test('under the daemon forge run and verify children get no credentials', async () => {
    const s = await scratch();
    try {
      for (const args of [['run', s.id, 'dump'], ['verify', s.id]]) {
        const env = await s.dump(args, { ...planted, ...s.daemon });
        for (const k of ['GH_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'FORGE_DAEMON', TRUST_ENV, 'FORGE_DAEMON_SCOPE']) assert.equal(env[k], undefined, `${args[0]}: ${k} is gone`);
        assert.equal(env.AWS_REGION, 'eu-west-1', `${args[0]}: AWS_REGION is kept`);
        assert.equal(env.FORGE_JOB, s.id, `${args[0]}: FORGE_JOB`);
        const human = await s.dump(args, planted);
        assert.equal(human.GH_TOKEN, GH_VALUE, `${args[0]}: outside the daemon GH_TOKEN is kept`);
      }
    } finally {
      s.cleanup();
    }
  });

  const zsh = findOnPath('zsh');
  test('under the daemon a planted ZDOTDIR/.zshenv is not sourced', { skip: process.platform === 'win32' || !zsh ? 'needs zsh off Windows' : false }, async () => {
    const s = await scratch();
    try {
      const zdot = path.join(s.out, 'zdot');
      const marker = path.join(s.out, 'zshenv-ran');
      fs.mkdirSync(zdot);
      fs.writeFileSync(path.join(zdot, '.zshenv'), `: > ${JSON.stringify(marker)}\n`);
      // The component's sink needs its secret's source to render.
      const env = { SHELL: zsh!, ZDOTDIR: zdot, CMDENV_DB_SRC: DB_VALUE };
      await s.dump(['run', s.id, 'dump'], { ...env, ...s.daemon });
      assert.equal(fs.existsSync(marker), false, 'the daemon run sourced no .zshenv');
      await s.dump(['run', s.id, 'dump'], env);
      assert.equal(fs.existsSync(marker), true, 'the control: outside the daemon the login zsh sources it');
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
