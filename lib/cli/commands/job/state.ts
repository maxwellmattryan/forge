// `forge job set|effort|note|refresh-request|budget`: a job's stage, state, fields, effort, notes, request and budget limits.
import { budgetCmd } from '#engine/metrics/budget.ts';
import { inInboxOrOffice } from '#office/owner.ts';
import { checkOfficeSetFor } from '#office/foreman/policy.ts';
import { inChat, inOffice } from '#core/job/requests.ts';
import { chatSetRefusal } from '#office/chat/authority.ts';
import { refreshDependencyWait, validateDependsOn } from '#engine/pipeline/moves/deps.ts';
import { moveJob } from '#engine/pipeline/moves/apply.ts';
import { builderNoteRefusal, writeApprovalNotes } from '#engine/pipeline/moves/approval-notes.ts';
import { loadJob, logEvent, logHumanEvent, setJobEffort } from '#core/job/store.ts';
import { checkFieldKey, checkJobFields, reopensShelved } from '#core/job/fields.ts';
import { EFFORTS } from '#core/job/schema.ts';
import { refreshRequest } from '#engine/trackers/request-refresh.ts';
import { ForgeError } from '#core/errors.ts';
import { coerce } from '#core/text.ts';
import type { Config } from '#core/types.ts';
import { aliasClash, bodyFrom, deprecatedAlias, list, oneOf, requireJob, str, usageError } from '../args.ts';
import { confirmHuman, jobBudgetOp, reopenShelvedOp } from '../human.ts';
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
  const deprecated: string[] = [];
  const kvs = flags.field === undefined || flags.field === true ? [] : ([] as unknown[]).concat(flags.field).map(String);
  const top = (kv: string) => kv.slice(0, kv.indexOf('=')).split('.')[0];
  // `services` is the old name of `components`, kept for one release.
  if (kvs.some((kv) => top(kv) === 'services') && kvs.some((kv) => top(kv) === 'components')) throw aliasClash('--field services', '--field components');
  for (const kv of kvs) {
    const eq = kv.indexOf('=');
    if (eq < 1) throw new ForgeError(`--field expects key=value, got "${kv}"`, 'usage');
    let key = kv.slice(0, eq);
    if (key.split('.')[0] === 'services') {
      key = `components${key.slice('services'.length)}`;
      if (!deprecated.length) deprecated.push(deprecatedAlias('--field services', '--field components'));
    }
    // Checked before coerce, so `owner={}` gets the lock message rather than a JSON error.
    checkFieldKey(key);
    fields[key] = coerce(kv.slice(eq + 1), key);
  }
  const before = loadJob(root, jobId);
  const waitingOn = flags['waiting-on'] === undefined ? undefined : flags['waiting-on'] === 'none' ? null : flags['waiting-on'];
  const change = { stage: flags.stage, state: flags.state, waitingOn, reason: flags.reason, fields };
  // Any other move of a gated job would decide its gate: a chat only carries out the decision recorded there.
  const chatRefusal = inChat() ? chatSetRefusal(root, config, before, change, note) : null;
  if (chatRefusal) throw new ForgeError(chatRefusal, 1);
  // setJob checks again inside its lock; checked here too so the office check and
  // validateDependsOn only see fields that pass, and `dependsOn={}` gets the array message.
  checkJobFields(fields, before);
  if (inOffice()) checkOfficeSetFor(root, before, change);
  if ('dependsOn' in fields) fields.dependsOn = validateDependsOn(root, jobId, fields.dependsOn);
  // A job cancelled or set done while shelved goes back to work only through a person, who types its
  // id back at this terminal; setJob refuses the move without the grant whoever writes it.
  const grant = reopensShelved(before, flags.state) ? await confirmHuman(root, reopenShelvedOp(jobId)) : undefined;
  // A failed teardown is never rolled back: the result says so and any later teardown path retries.
  // The inbox and office sessions only stop it, as `forge environment down` is refused there.
  const { job, gate, environment } = await moveJob(
    root,
    config,
    jobId,
    { stage: flags.stage, state: flags.state, waitingOn, reason: flags.reason, note, fields, fence: epochFence(flags), grant },
    {
      environment: inInboxOrOffice() ? 'stop' : 'teardown',
      afterWrite: 'dependsOn' in fields ? (j) => (refreshDependencyWait(root, j.id), loadJob(root, j.id)) : undefined,
    },
  );
  return {
    id: job.id,
    stage: job.stage,
    state: job.state,
    waitingOn: job.waitingOn,
    ...(gate ? { gateRequest: gate.id } : {}),
    ...(environment ? { environment } : {}),
    ...(deprecated.length ? { deprecated } : {}),
  };
}

export function refreshRequestCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  return refreshRequest(root, config, requireJob(root, id).id, 'cli');
}

export function note(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const jobId = requireJob(root, id).id;
  if (flags.for === undefined) {
    logEvent(root, jobId, 'note', { text: rest.slice(1).join(' ') || bodyFrom(flags, root, config) });
    return { ok: true };
  }
  oneOf(str(flags.for, '--for'), ['builder'] as const, 'for');
  // Refused before the body is read and before anything is written.
  const refusal = builderNoteRefusal(jobId, 'forge job note --for builder');
  if (refusal) throw new ForgeError(refusal, 1);
  const text = rest.slice(1).join(' ') || bodyFrom(flags, root, config);
  if (!text.trim()) throw usageError(JOB, 'note');
  logHumanEvent(root, jobId, 'builder-note', { note: text });
  return { ok: true, approvalNotes: writeApprovalNotes(root, jobId) };
}

export async function budget(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const jobId = requireJob(root, rest[0]).id;
  const set = list(flags.set);
  const ack = Boolean(flags.ack);
  // --set and --ack are human-only operations: a person types the job id back at this terminal.
  const grant = set.length || ack ? await confirmHuman(root, jobBudgetOp(jobId, { set: set.length > 0, ack })) : undefined;
  return budgetCmd(root, config, jobId, { set, ack, grant });
}
