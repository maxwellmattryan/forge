// The environment, placeholders and shell of a configured command Forge runs for a job. Apart from
// worktree.ts so environment-lifecycle.ts can build a job's template database without loading it.
import path from 'node:path';
import { backingEnv } from '../environment/backing.ts';
import type { DatabaseOpts } from '../environment/backing.ts';
import { jobComponent } from '#core/config/components.ts';
import { isOwnWorktreePath, worktreeRoot } from '#core/config/load.ts';
import { commandPort, endpointEnv, endpointPlaceholders, jobEndpoints } from '../environment/endpoints.ts';
import { exists } from '#core/paths.ts';
import { posixShell } from '#core/os/platform.ts';
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

// The daemon's trust check guards the session's own `forge` calls; a configured command that
// calls `forge` (a test suite on scratch repos) must behave as it does for a human.
const DAEMON_MARKER = /^FORGE_DAEMON(_|$)/;
// An outer job's per-component and backing variables would otherwise reach a nested job's
// commands (the suite run by `forge verify` driving scratch jobs) beside that job's own.
const JOB_VARS = /^FORGE_(PORT|ENDPOINT|BACKING)_/;

/** A configured command's environment: `base` without the daemon markers or an outer job's variables (git pins kept), plus the job's variables. */
export function envFor(job: Job, dir: string, port: number | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) if (DAEMON_MARKER.test(k) || JOB_VARS.test(k)) delete env[k];
  return Object.assign(env, { FORGE_JOB: job.id, FORGE_WORKTREE: dir, PORT: port ? String(port) : '', FORGE_PORT: port ? String(port) : '' });
}

/** envFor plus the job's FORGE_BACKING_* and FORGE_PORT_* / FORGE_ENDPOINT_* variables: what every configured command Forge runs for a job sees. */
export function jobEnv(root: string, config: Config, job: Job, dir: string, port: number | null): NodeJS.ProcessEnv {
  return { ...envFor(job, dir, port), ...backingEnv(root, config, job), ...endpointEnv(jobEndpoints(root, config, job)) };
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
      const res = shell(fill(cmd, vars(root, config, job, worktree, port, cmd)), worktree, { ...jobEnv(root, config, job, worktree, port), ...envOverride });
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

export function shell(cmd: string, cwd: string, env: NodeJS.ProcessEnv): ShellResult {
  const res = run(posixShell(), ['-lc', cmd], { cwd, env, allowFail: true });
  return { ok: res.ok, status: res.status, output: joinOutput(res.stdout, res.stderr) };
}
