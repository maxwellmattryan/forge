// `forge job set|effort|note|refresh-request|budget`: a job's stage, state, fields, effort, notes, request and budget limits.
import { budgetCmd } from '#engine/metrics/budget.ts';
import { inInboxOrOffice } from '#office/owner.ts';
import { checkOfficeSetFor } from '#office/foreman.ts';
import { inOffice } from '#core/job/requests.ts';
import { refreshDependencyWait, validateDependsOn } from '#engine/pipeline/moves/deps.ts';
import { moveJob } from '#engine/pipeline/moves/apply.ts';
import { loadJob, logEvent, setJobEffort } from '#core/job/store.ts';
import { checkFieldKey, checkJobFields } from '#core/job/fields.ts';
import { EFFORTS } from '#core/job/schema.ts';
import { refreshRequest } from '#engine/trackers/request-refresh.ts';
import { ForgeError } from '#core/errors.ts';
import { coerce } from '#core/text.ts';
import type { Config } from '#core/types.ts';
import { bodyFrom, list, oneOf, requireJob, str, usageError } from '../args.ts';
import { confirmHuman, jobBudgetOp } from '../human.ts';
import { JOB } from './help.ts';
import { epochFence } from './lease.ts';

// Effort is the human's control over how much a job costs: a session misled by request text must
// not raise its own job's, or another's, past what the human chose.
export const EFFORT_DAEMON_REFUSAL =
  "forge job effort sets how hard a job's sessions and agents think, which a daemon session may not change; a human sets it from the dashboard or their own session";
export const refuseEffortInDaemon = () => {
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(EFFORT_DAEMON_REFUSAL);
};

export function effort(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  refuseEffortInDaemon();
  const jobId = requireJob(root, id).id;
  const level = rest[1];
  if ((level !== undefined) === (flags.inherit === true) || rest.length > 2) throw usageError(JOB, 'effort');
  return setJobEffort(root, jobId, level === undefined ? null : oneOf(level, EFFORTS, 'effort'), 'cli');
}

export async function set(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const jobId = requireJob(root, id).id;
  const note = str(flags.note, '--note');
  const fields: Record<string, any> = {};
  for (const kv of flags.field === undefined || flags.field === true ? [] : ([] as unknown[]).concat(flags.field).map(String)) {
    const eq = kv.indexOf('=');
    if (eq < 1) throw new ForgeError(`--field expects key=value, got "${kv}"`, 'usage');
    const key = kv.slice(0, eq);
    // Checked before coerce, so `owner={}` gets the lock message rather than a JSON error.
    checkFieldKey(key);
    fields[key] = coerce(kv.slice(eq + 1), key);
  }
  const before = loadJob(root, jobId);
  // setJob checks again inside its lock; checked here too so the office check and
  // validateDependsOn only see fields that pass, and `dependsOn={}` gets the array message.
  checkJobFields(fields, before);
  const waitingOn = flags['waiting-on'] === undefined ? undefined : flags['waiting-on'] === 'none' ? null : flags['waiting-on'];
  if (inOffice()) checkOfficeSetFor(root, before, { stage: flags.stage, state: flags.state, waitingOn, reason: flags.reason, fields });
  if ('dependsOn' in fields) fields.dependsOn = validateDependsOn(root, jobId, fields.dependsOn);
  // A failed teardown is never rolled back: the result says so and any later teardown path retries.
  // The inbox and office sessions only stop it, as `forge environment down` is refused there.
  const { job, gate, environment } = await moveJob(
    root,
    config,
    jobId,
    { stage: flags.stage, state: flags.state, waitingOn, reason: flags.reason, note, fields, fence: epochFence(flags) },
    {
      environment: inInboxOrOffice() ? 'stop' : 'teardown',
      afterWrite: 'dependsOn' in fields ? (j) => (refreshDependencyWait(root, j.id), loadJob(root, j.id)) : undefined,
    },
  );
  return { id: job.id, stage: job.stage, state: job.state, waitingOn: job.waitingOn, ...(gate ? { gateRequest: gate.id } : {}), ...(environment ? { environment } : {}) };
}

export function refreshRequestCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  return refreshRequest(root, config, requireJob(root, id).id, 'cli');
}

export function note(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  logEvent(root, requireJob(root, id).id, 'note', { text: rest.slice(1).join(' ') || bodyFrom(flags, root, config) });
  return { ok: true };
}

export async function budget(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const jobId = requireJob(root, rest[0]).id;
  const set = list(flags.set);
  const ack = Boolean(flags.ack);
  // --set and --ack are human-only operations: a person types the job id back at this terminal.
  const grant = set.length || ack ? await confirmHuman(root, jobBudgetOp(jobId, { set: set.length > 0, ack })) : undefined;
  return budgetCmd(root, config, jobId, { set, ack, grant });
}
