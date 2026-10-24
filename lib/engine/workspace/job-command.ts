// The environment, placeholders and shell of a configured command Forge runs for a job, with the
// shell's async twin verify runs steps through: the env builds on commandEnv and the argv comes from
// commandShell (lib/engine/guard/command-env.ts). Apart from run.ts and worktree.ts so
// environment-lifecycle.ts can build a job's template database without loading them.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { backingEnv } from '../environment/backing.ts';
import type { DatabaseOpts } from '../environment/backing.ts';
import { jobComponent } from '#core/config/components.ts';
import { isOwnWorktreePath, worktreeRoot } from '#core/config/load.ts';
import { commandPort, endpointEnv, endpointPlaceholders, jobEndpoints } from '../environment/endpoints.ts';
import { exists } from '#core/paths.ts';
import { commandEnv, commandShell, loginShell } from '../guard/command-env.ts';
import type { CommandEnvSource } from '../guard/command-env.ts';
import type { Config, Job } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { run } from '#core/os/process.ts';
import { assertSafeRef, fill } from '#core/text.ts';

// Placeholders fill a shell command, and job.json can be edited outside the CLI, so these are
// checked here at the sink rather than trusted from createJob.
export function checkRefs(job: Job): void {
  assertSafeRef(job.id, 'job.id');
  assertSafeRef(job.branch, 'job.branch');
  assertSafeRef(job.base, 'job.base');
}

// `{worktree}` is filled unquoted, and job.json's `worktree` is agent-writable: it is trusted only
// when it is literally the path Forge computes for the job, whatever characters the repo path holds.
// Checked only for a template that uses it, so other commands run whatever the stored value is.
function assertOwnWorktree(root: string, config: Config, job: Job, dir: string, template: string): void {
  if (!template.includes('{worktree}') || isOwnWorktreePath(root, config, job.id, dir)) return;
  throw new ForgeError(`job.worktree ${JSON.stringify(dir).slice(0, 120)} is not this job's worktree: {worktree} is filled only with ${JSON.stringify(path.join(worktreeRoot(root, config), job.id)).slice(0, 120)}`);
}

// `{args}` is empty here: only `forge run … -- <args>` fills it (fillCommand), so verify, setup,
// background servers and regenerate never take arguments that could narrow what they run.
export function vars(root: string, config: Config, job: Job, dir: string, port: number | null, template: string): Record<string, string | number> {
  checkRefs(job);
  assertOwnWorktree(root, config, job, dir, template);
  return { ...endpointPlaceholders(jobEndpoints(root, config, job), { shell: true }), job: job.id, port: port ?? '', worktree: dir, root, branch: job.branch!, base: job.base!, args: '' };
}

/**
 * A configured command's environment, the same in and out of the daemon: commandEnv's allowlist of
 * `base` (plus commandEnv.inherit, the git pins included, never an internal variable or a declared
 * secret source), plus the job's variables.
 */
export function envFor(config: CommandEnvSource, job: Job, dir: string, port: number | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.assign(commandEnv(config, base), { FORGE_JOB: job.id, FORGE_WORKTREE: dir, PORT: port ? String(port) : '', FORGE_PORT: port ? String(port) : '' });
}

/** envFor plus the job's FORGE_BACKING_* and FORGE_PORT_* / FORGE_ENDPOINT_* variables: what every configured command Forge runs for a job sees. */
export function jobEnv(root: string, config: Config, job: Job, dir: string, port: number | null): NodeJS.ProcessEnv {
  return { ...envFor(config, job, dir, port), ...backingEnv(root, config, job), ...endpointEnv(jobEndpoints(root, config, job)) };
}

/**
 * How backingUp builds a template database for the job: in the worktree path Forge computes for it
 * (never job.worktree, which the session can write), null when that directory is missing, with the
 * job's usual placeholders and env plus `envOverride` (the template's url).
 */
export function databaseCommands(root: string, config: Config, job: Job): DatabaseOpts {
  const dir = path.join(worktreeRoot(root, config), job.id);
  const worktree = exists(dir) ? dir : null;
  const port = commandPort(config, job, jobComponent(config, job));
  return {
    worktree,
    runCommand: (cmd, envOverride) => {
      if (!worktree) return { ok: false, output: `job ${job.id} has no worktree` };
      const res = shell(fill(cmd, vars(root, config, job, worktree, port, cmd)), worktree, { ...jobEnv(root, config, job, worktree, port), ...envOverride }, { login: loginShell(config) });
      return { ok: res.ok, output: res.output };
    },
  };
}

export interface ShellResult {
  ok: boolean;
  status: number | null;
  output: string;
}

export const joinOutput = (stdout: string, stderr: string): string => `${stdout}${stderr ? `\n${stderr}` : ''}`;

/** What shell() and shellAsync() pass to commandShell: `login` is loginShell(config). */
export interface ShellOptions {
  login?: boolean;
}

/** Runs `cmd` under commandShell, which resolves the shell from this process's own environment, never `env`. */
export function shell(cmd: string, cwd: string, env: NodeJS.ProcessEnv, opts: ShellOptions = {}): ShellResult {
  const sh = commandShell(cmd, { login: opts.login });
  const res = run(sh.file, sh.args, { cwd, env, allowFail: true });
  return { ok: res.ok, status: res.status, output: joinOutput(res.stdout, res.stderr) };
}

/** run()'s spawnSync limit per stream, kept for the async path. */
export const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * shell() without blocking, so verify can run a group's steps at once. Past MAX_OUTPUT on either
 * stream the child is killed and the step fails, as spawnSync's ENOBUFS does; a spawn error is a
 * failure with no exit code.
 */
export function shellAsync(cmd: string, cwd: string, env: NodeJS.ProcessEnv, opts: ShellOptions = {}): Promise<ShellResult> {
  // Outside the Promise, so a refused shell throws here as it does in shell().
  const sh = commandShell(cmd, { login: opts.login });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(sh.file, sh.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ ok: false, status: null, output: joinOutput('', (e as Error).message) });
    }
    const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let overflow: string | null = null;
    for (const k of ['stdout', 'stderr'] as const) {
      child[k]!.on('data', (chunk: Buffer) => {
        if (overflow) return;
        sizes[k] += chunk.length;
        if (sizes[k] <= MAX_OUTPUT) return void chunks[k].push(chunk);
        overflow = `spawn ${sh.file} ENOBUFS: ${k} passed ${MAX_OUTPUT / 1024 / 1024} MiB, so the command was stopped`;
        chunks.stdout = [];
        chunks.stderr = [];
        child.kill('SIGTERM');
        // A grandchild holding the pipes open would otherwise delay close until it exits.
        child.stdout!.destroy();
        child.stderr!.destroy();
      });
    }
    child.on('error', (e) => finish({ ok: false, status: null, output: joinOutput('', e.message) }));
    child.on('close', (code) => {
      if (overflow) return finish({ ok: false, status: null, output: joinOutput('', overflow) });
      const stdout = Buffer.concat(chunks.stdout).toString('utf8');
      const stderr = Buffer.concat(chunks.stderr).toString('utf8');
      finish({ ok: code === 0, status: code, output: joinOutput(stdout, stderr) });
    });
  });
}
