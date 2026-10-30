// `forge backing up|down|stop|status`: a job's backing services on demand (lib/engine/environment/backing.ts, docs/CONFIG.md
// "Backing services"). worktree create and remove do the same bring-up and teardown on their own.
import { backingDown, backingDownShared, backingStatus, backingStop, backingUp } from '#engine/environment/backing.ts';
import { refuseInboxDrive, refuseInboxOrOffice } from '#office/session/permissions/owner.ts';
import { loadJob } from '#core/job/store.ts';
import { validJobId } from '#core/job/requests.ts';
import { databaseCommands } from '#engine/workspace/job-command.ts';
import { ForgeError } from '#core/errors.ts';
import { assertSafeRef } from '#core/text.ts';
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
      summary:
        "bring the job's per-job and the project's shared services up, idempotently: run a missing container, start a stopped one, leave a running one; then give the job its job database on each shared entry with database (cloned from the template database, built in the job's worktree when missing); the result lists each service's action and database, never a password",
      exits: [[1, 'an invalid job id or no such job, or the inbox or office daemon session ran it'], [5, `${DOCKER_FAILED[1]}; for a job database, also a server not ready in 60 s, a failed migrate, seed or psql call, or no worktree`]],
      docs: DOCS,
      common: true,
    },
    {
      command: 'backing down',
      args: '<id> | --shared',
      summary:
        "remove the job's per-job containers and volumes (only those labelled with this checkout and job), drop its job databases and role, and delete backing.json and backing-db.json, for any job, done or cancelled too; --shared removes this checkout's shared containers and keeps their volumes and ports",
      flags: [['--shared', "the project's shared containers instead of a job's"]],
      exits: [[1, 'an invalid job id, or the inbox or office daemon session ran it'], [5, 'Docker missing, its daemon stopped, a docker or psql command failed, or a shared container is stopped (the records are kept for a retry)']],
      docs: DOCS,
      common: true,
    },
    {
      command: 'backing stop',
      args: '<id>',
      summary:
        "docker stop the job's per-job containers (only those labelled with this checkout and job), keeping their volumes, records and every shared container; a missing, stopped or foreign container is listed in skipped with the reason; `backing up` starts them again",
      exits: [[1, 'an invalid job id, or the inbox or office daemon session ran it'], DOCKER_FAILED],
      docs: DOCS,
      common: true,
    },
    {
      command: 'backing status',
      args: '[<id>]',
      summary:
        "with a job: docker (ok, missing or stopped; null when no service is managed) and each service's container, state (unknown when Docker is unreachable), health (healthy, unhealthy or starting while running; null without a healthcheck), ports, job database (name and template) and the FORGE_BACKING_* names its commands see (never values); without: every container labelled with this checkout, with orphan: true for a per-job one whose job is unknown, done or cancelled",
      exits: [[1, 'an invalid job id'], [5, 'Docker missing (code docker_missing) or its daemon stopped (docker_stopped), without a job only']],
      docs: DOCS,
      common: true,
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
    const services = backingUp(root, config, job, undefined, databaseCommands(root, config, job));
    const ok = services.every((s) => s.ok);
    return { data: { job: id, services, ok }, exitCode: ok ? 0 : 5 };
  }
  if (sub === 'down') {
    if (flags.shared === true) {
      if (rest.length) throw usageError(BACKING, 'down');
      refuseInboxOrOffice('run `forge backing down --shared` from a terminal');
      return { data: backingDownShared(root, config), exitCode: 0 };
    }
    if (rest.length !== 1) throw usageError(BACKING, 'down');
    const id = jobId(rest[0], 'down');
    refuseInboxDrive(id);
    const r = backingDown(root, config, id);
    return { data: { job: id, ...r }, exitCode: r.ok ? 0 : 5 };
  }
  if (sub === 'stop') {
    if (rest.length !== 1) throw usageError(BACKING, 'stop');
    const id = jobId(rest[0], 'stop');
    refuseInboxDrive(id);
    const r = backingStop(root, config, id);
    return { data: { job: id, ...r }, exitCode: r.ok ? 0 : 5 };
  }
  if (sub === 'status') {
    if (rest.length > 1) throw usageError(BACKING, 'status');
    if (!rest.length) return { data: backingStatus(root, config), exitCode: 0 };
    return { data: backingStatus(root, config, jobId(rest[0], 'status')), exitCode: 0 };
  }
  throw usageError(BACKING);
}
