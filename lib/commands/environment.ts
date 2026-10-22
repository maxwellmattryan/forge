// `forge environment up|stop|down|list`: a job's environment on demand (lib/environment-lifecycle.ts,
// docs/CONFIG.md "Backing services" › Lifecycle). Forge does the same on its own: teardown when a job
// finishes or is archived, stop on a park, start on resume, verify, run --background and focus.
import { currentFocus } from '../engine/workspace/focus-actions.ts';
import { refuseInboxDrive } from '../daemon-owner.ts';
import { ensureEnvironment, stopEnvironment, teardownEnvironment } from '../engine/environment/lifecycle.ts';
import { liveJob, readEnvironments } from '../engine/environment/record.ts';
import { isActive, loadJob } from '../core/job/store.ts';
import { validJobId } from '../core/job/requests.ts';
import { ForgeError } from '../core/errors.ts';
import { assertSafeRef } from '../core/text.ts';
import { usageError } from './args.ts';
import type { CliContext, Dispatched, HelpGroup } from '../core/types.ts';

const DOCS: [string, string] = ['Backing services', 'docs/CONFIG.md#backing-services'];
const REFUSED: [1, string] = [1, 'an invalid job id or no such job, or the inbox or office daemon session ran it'];

const ENVIRONMENT: HelpGroup = {
  name: 'environment',
  summary: "a job's environment: its background processes, per-job containers and volumes, and job databases",
  commands: [
    {
      command: 'environment up',
      args: '<id>',
      summary:
        "start an active job's environment: run a missing per-job container, start a stopped one, give the job its job databases, and mark it running in the environment record. Forge does this itself on resume, verify, run --background and focus. Starts no background process",
      exits: [[1, 'an invalid job id or no such job, a done or cancelled job, or the inbox or office daemon session ran it'], [5, 'a backing service did not start']],
      docs: DOCS,
      readme: true,
    },
    {
      command: 'environment stop',
      args: '<id>',
      summary:
        "stop a job's environment while keeping it: stop its background processes and docker stop its own per-job containers, keeping volumes, job databases and shared containers, and mark it stopped in the environment record. Forge does this itself when a job parks",
      exits: [REFUSED, [5, 'Docker missing, its daemon stopped or docker stop failed (the record still says stopped)']],
      docs: DOCS,
      readme: true,
    },
    {
      command: 'environment down',
      args: '<id>',
      summary:
        "tear the job's environment down, for any job, done or cancelled too: stop its background processes, remove its per-job containers and volumes, drop its job databases, delete backing.json and backing-db.json and drop it from the environment record; the worktree stays",
      exits: [REFUSED, [5, 'Docker missing, its daemon stopped, a docker or psql command failed, or a shared container is stopped (the records are kept for a retry)']],
      docs: DOCS,
      readme: true,
    },
    {
      command: 'environment list',
      args: '',
      summary: 'the environment record: {maxRunning, focused, jobs: [{id, state, usedAt}]}, running or stopped as Forge last left each one, most recently used first, only for jobs that exist and are active',
      docs: DOCS,
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [ENVIRONMENT];

/** A job id checked before any docker call: it becomes part of container, volume and database names. */
function jobId(v: string | undefined, sub: string): string {
  if (v === undefined) throw usageError(ENVIRONMENT, sub);
  if (!validJobId(v)) throw new ForgeError(`invalid job id ${JSON.stringify(v).slice(0, 80)}`);
  return assertSafeRef(v, 'job id');
}

export function environmentCmd(ctx: CliContext, sub: string | undefined, rest: string[]): Dispatched {
  const { root, config } = ctx;
  if (sub === 'up') {
    if (rest.length !== 1) throw usageError(ENVIRONMENT, 'up');
    const id = jobId(rest[0], 'up');
    refuseInboxDrive(id);
    const job = loadJob(root, id);
    if (!isActive(job)) throw new ForgeError(`job ${id} is ${job.state}; only an active job's environment starts`);
    const r = ensureEnvironment(root, config, job, 'cli');
    return { data: { job: id, ...r }, exitCode: r.ok ? 0 : 5 };
  }
  if (sub === 'stop') {
    if (rest.length !== 1) throw usageError(ENVIRONMENT, 'stop');
    const id = jobId(rest[0], 'stop');
    refuseInboxDrive(id);
    loadJob(root, id);
    const r = stopEnvironment(root, config, id, 'cli');
    return { data: { job: id, ...r }, exitCode: r.ok ? 0 : 5 };
  }
  if (sub === 'down') {
    if (rest.length !== 1) throw usageError(ENVIRONMENT, 'down');
    const id = jobId(rest[0], 'down');
    refuseInboxDrive(id);
    loadJob(root, id);
    const r = teardownEnvironment(root, config, id, 'cli');
    return { data: { job: id, ...r }, exitCode: r.ok ? 0 : 5 };
  }
  if (sub === 'list') {
    if (rest.length) throw usageError(ENVIRONMENT, 'list');
    const jobs = Object.entries(readEnvironments(root).jobs)
      .filter(([id]) => liveJob(root, id))
      .map(([id, e]) => ({ id, state: e.state, usedAt: e.usedAt }))
      .sort((a, b) => (a.usedAt < b.usedAt ? 1 : a.usedAt > b.usedAt ? -1 : a.id < b.id ? -1 : 1));
    return { data: { maxRunning: config.environments?.maxRunning ?? null, focused: currentFocus(root)?.id ?? null, jobs }, exitCode: 0 };
  }
  throw usageError(ENVIRONMENT);
}
