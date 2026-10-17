// `forge backing up|down|status`: a job's backing services on demand (lib/backing.ts, docs/CONFIG.md
// "Backing services"). worktree create and remove do the same bring-up and teardown on their own.
import { backingDown, backingDownShared, backingStatus, backingUp } from '../backing.ts';
import { refuseInboxDrive } from '../daemon-owner.ts';
import { loadJob } from '../jobs.ts';
import { validJobId } from '../requests.ts';
import { ForgeError, assertSafeRef } from '../util.ts';
import { usageError } from './args.ts';
import type { CliContext, Dispatched, HelpGroup } from '../types.ts';

const DOCS: [string, string] = ['Backing services', 'docs/CONFIG.md#backing-services'];
const DOCKER_FAILED: [5, string] = [5, "Docker missing, its daemon stopped, a docker command failed, or a same-named container that is not this job's"];

const BACKING: HelpGroup = {
  name: 'backing',
  summary: "a job's databases, caches and queues (backing:), run through the Docker CLI",
  commands: [
    {
      command: 'backing up',
      args: '<id>',
      summary: "bring the job's per-job and the project's shared services up, idempotently: run a missing container, start a stopped one, leave a running one; the result lists each service's action",
      exits: [[1, 'an invalid job id or no such job, or the inbox or office daemon session ran it'], DOCKER_FAILED],
      docs: DOCS,
      readme: true,
    },
    {
      command: 'backing down',
      args: '<id> | --shared',
      summary: "remove the job's per-job containers and volumes (only those labelled with this checkout and job) and its backing.json, for any job, done or cancelled too; --shared removes this checkout's shared containers and keeps their volumes and ports",
      flags: [['--shared', "the project's shared containers instead of a job's"]],
      exits: [[1, 'an invalid job id, or the inbox or office daemon session ran it'], [5, 'Docker missing, its daemon stopped, or a docker command failed (backing.json is kept for a retry)']],
      docs: DOCS,
      readme: true,
    },
    {
      command: 'backing status',
      args: '[<id>]',
      summary:
        "with a job: each service's container, state (unknown when Docker is unreachable), ports and the FORGE_BACKING_* names its commands see (never values); without: every container labelled with this checkout, with orphan: true for a per-job one whose job is unknown, done or cancelled",
      exits: [[1, 'an invalid job id'], [5, 'Docker missing or its daemon stopped (without a job only)']],
      docs: DOCS,
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [BACKING];

/** A job id checked before any docker call: it becomes part of container and volume names. */
function jobId(v: string | undefined, sub: string): string {
  if (v === undefined) throw usageError(BACKING, sub);
  if (!validJobId(v)) throw new ForgeError(`invalid job id ${JSON.stringify(v).slice(0, 80)}`);
  return assertSafeRef(v, 'job id');
}

export function backingCmd(ctx: CliContext, sub: string | undefined, rest: string[], flags: Record<string, any>): Dispatched {
  const { root, config } = ctx;
  if (sub === 'up') {
    if (rest.length !== 1) throw usageError(BACKING, 'up');
    const id = jobId(rest[0], 'up');
    refuseInboxDrive(id);
    const job = loadJob(root, id);
    const services = backingUp(root, config, job);
    const ok = services.every((s) => s.ok);
    return { data: { job: id, services, ok }, exitCode: ok ? 0 : 5 };
  }
  if (sub === 'down') {
    if (flags.shared === true) {
      if (rest.length) throw usageError(BACKING, 'down');
      return { data: backingDownShared(root, config), exitCode: 0 };
    }
    if (rest.length !== 1) throw usageError(BACKING, 'down');
    const id = jobId(rest[0], 'down');
    refuseInboxDrive(id);
    const r = backingDown(root, config, id);
    return { data: { job: id, ...r }, exitCode: r.ok ? 0 : 5 };
  }
  if (sub === 'status') {
    if (rest.length > 1) throw usageError(BACKING, 'status');
    if (!rest.length) return { data: backingStatus(root, config), exitCode: 0 };
    return { data: backingStatus(root, config, jobId(rest[0], 'status')), exitCode: 0 };
  }
  throw usageError(BACKING);
}
