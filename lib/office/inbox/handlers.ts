// The intake runner's per-type plans: for each request type the inbox gets, the fixed `forge` calls that answer
// it, in order, and the one-line ack built from their JSON. Every request value reaches argv only as one
// `--flag=<value>` word, or after `--` for a run's ref, and is checked first; a job id from a child's output must
// pass validJobId before a later call's argv holds it. Acks carry only job ids, counts and Forge's own error text,
// never a tracker title. docs/architecture/daemon.md › Intake runner holds the table.
import { JOB_REQUEST_TYPES, isMandateIdArg, validJobId } from '#core/job/requests.ts';
import { oneLineTitle } from '#core/text.ts';
import type { ForgeRequest } from '#core/types.ts';
import type { ForgeCall } from './children.ts';

/** The request types the runner answers in code; any other type routed to the inbox falls back to the inbox session. */
export const INTAKE_TYPES: readonly string[] = Object.freeze(['sync', 'next', 'run', 'retro', 'eval-run', ...JOB_REQUEST_TYPES]);

/** Whether the runner answers `r`. */
export const handles = (r: Pick<ForgeRequest, 'type'>): boolean => INTAKE_TYPES.includes(r?.type);

/** A handler's answer: the ack, `infra` when a child failed to run (the counted requeue), or `stopped` (the claim goes back). */
export type Outcome = { status: 'done' | 'rejected'; result: string } | { infra: string } | { stopped: true };

/** Runs one `forge <args>` child in the `_inbox` scope. */
export type Call = (args: string[]) => Promise<ForgeCall>;

/** What a handler needs besides its calls. */
export interface HandlerCtx {
  /** Readiness triage, before a `next` claims anything (./triage.ts); false when the request must stop. */
  triage(): Promise<boolean>;
  now(): Date;
}

/** The most `next` takes in one request. */
const MAX_N = 10;
const MAX_REF = 200;
const MAX_EVAL_VALUE = 500;
const REASON_MAX = 200;
/** What checkIssueRef refuses outright: a control character, or a line or paragraph separator. */
const CONTROL = /[\x00-\x1f\x7f\p{Zl}\p{Zp}]/u;
/** An eval run id as startRun writes one; anything else is not echoed into an ack. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const N_REFUSAL = 'args.n must be an integer from 1 to 10';
export const REF_REFUSAL = 'a run request needs args.ref, a tracker ref';
export const MANDATE_REFUSAL = 'args.mandate must be a mandate id';

/** `args.n`: 1 when absent, an integer 1-10, else null. */
export function nOf(args: Record<string, unknown> | undefined): number | null {
  const n = args?.n;
  if (n === undefined) return 1;
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_N ? (n as number) : null;
}

/** A ref the runner may pass after `--`: 1-200 characters, no control character, no leading `-`. checkIssueRef judges the rest. */
export function usableRef(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= MAX_REF && !CONTROL.test(v) && !v.startsWith('-');
}

/** An eval-run tag, task or label value: null when it is no non-empty string (skipped), `false` when it is refused. */
function evalValue(v: unknown): string | null | false {
  if (typeof v !== 'string' || v === '') return null;
  return v.length > MAX_EVAL_VALUE || CONTROL.test(v) ? false : v;
}

/** A call's error as an ack shows it. */
const errOf = (c: ForgeCall): string => c.error ?? (c.code === null ? `killed by ${c.signal ?? 'a signal'}` : `exit ${c.code}`);
/** A call that never answered: it could not start, timed out or died by a signal. */
const infra = (c: ForgeCall): boolean => c.code === null;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
const done = (result: string): Outcome => ({ status: 'done', result });
const rejected = (result: string): Outcome => ({ status: 'rejected', result });

/** A repo budget reason as an ack shows it: one line, at most REASON_MAX characters. */
function budgetReason(v: unknown): string {
  return oneLineTitle(v).slice(0, REASON_MAX) || 'the repo budget holds new work';
}

/**
 * The resume that hands a job the runner created or claimed to its own session, which releases S's lease on it.
 * Returns null on success, else the failure for the ack.
 */
async function handOff(call: Call, id: string, S: string | null, intake: 'next' | 'run' | null): Promise<string | null> {
  const c = await call(['requests', 'add', 'resume', `--job=${id}`, ...(intake ? [`--intake=${intake}`] : []), ...(S ? [`--session=${S}`] : [])]);
  return c.code === 0 ? null : `${id} not handed off: ${errOf(c)}`;
}

/** The ack for the jobs handed off and what stopped or failed on the way; `no ready work` when there is neither. */
function handedOff(ids: string[], problems: string[]): string {
  const head = ids.length ? [`handed off to ${ids.join(', ')}`] : problems.length ? [] : ['no ready work'];
  return [...head, ...problems].join('; ');
}

async function sync(_r: ForgeRequest, call: Call): Promise<Outcome> {
  const c = await call(['sync']);
  if (infra(c)) return { infra: errOf(c) };
  if (c.code !== 0) return rejected(errOf(c));
  const out = obj(c.json);
  const results: unknown[] = Array.isArray(out.results) ? out.results : [];
  const merged = results.map(obj).filter((x) => x.merged === true && validJobId(x.id)).map((x) => x.id as string);
  return done(`synced ${count(out.synced)}; ${count(out.requests)} requests queued${merged.length ? `; merged ${merged.join(',')}` : ''}`);
}

async function next(r: ForgeRequest, call: Call, S: string, ctx: HandlerCtx): Promise<Outcome> {
  const n = nOf(r.args);
  if (n === null) return rejected(N_REFUSAL);
  if (!(await ctx.triage())) return { stopped: true };
  const ids: string[] = [];
  const problems: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await call(['next', '--claim', `--session=${S}`]);
    const first = !ids.length && !problems.length;
    // Nothing done yet: the request runs again. After a hand-off it is acked, so a rerun never takes more than asked.
    if (infra(c) && first) return { infra: errOf(c) };
    if (c.code !== 0) {
      if (first) return rejected(errOf(c));
      problems.push(`next failed: ${errOf(c)}`);
      break;
    }
    const out = obj(c.json);
    if (out.held === true) {
      problems.push(`held: ${budgetReason(obj(out.repoBudget).reason)}`);
      break;
    }
    if (out.id === undefined) break;
    if (!validJobId(out.id)) {
      problems.push('next returned a malformed job id');
      break;
    }
    const failed = await handOff(call, out.id, S, 'next');
    if (failed) problems.push(failed);
    else ids.push(out.id);
  }
  return done(handedOff(ids, problems));
}

async function run(r: ForgeRequest, call: Call, S: string): Promise<Outcome> {
  const ref = r.args?.ref;
  if (!usableRef(ref)) return rejected(REF_REFUSAL);
  const c = await call(['job', 'from-ref', `--session=${S}`, '--', ref]);
  if (infra(c)) return { infra: errOf(c) };
  if (c.code === 4) return done(`held: ${errOf(c)}`);
  if (c.code !== 0) return rejected(errOf(c));
  const id = obj(c.json).id;
  if (!validJobId(id)) return rejected('job from-ref returned a malformed job id');
  const failed = await handOff(call, id, S, 'run');
  return done(handedOff(failed ? [] : [id], failed ? [failed] : []));
}

async function retro(r: ForgeRequest, call: Call, S: string, ctx: HandlerCtx): Promise<Outcome> {
  const m = r.args?.mandate;
  const mandate = m === undefined || m === null ? null : isMandateIdArg(m) ? m : false;
  if (mandate === false) return rejected(MANDATE_REFUSAL);
  const title = mandate ? `Forge retro: mandate ${mandate}` : `Forge retro ${ctx.now().toISOString().slice(0, 10)}`;
  const c = await call(['job', 'new', '--kind=retro', `--title=${title}`, `--session=${S}`]);
  if (infra(c)) return { infra: errOf(c) };
  if (c.code !== 0) return rejected(errOf(c));
  const id = obj(c.json).id;
  if (!validJobId(id)) return rejected('job new returned a malformed job id');
  const problems: string[] = [];
  const p = await call(['retro', 'prepare', id, ...(mandate ? [`--mandate=${mandate}`] : [])]);
  // A failed prepare still hands off: the retro job's own session can prepare it again.
  if (p.code !== 0) problems.push(`retro prepare failed: ${errOf(p)}`);
  const failed = await handOff(call, id, S, null);
  return done(handedOff(failed ? [] : [id], failed ? [failed, ...problems] : problems));
}

async function evalRun(r: ForgeRequest, call: Call): Promise<Outcome> {
  const words: string[] = [];
  for (const k of ['tags', 'tasks', 'label'] as const) {
    const v = evalValue(r.args?.[k]);
    if (v === false) return rejected(`args.${k} must be at most ${MAX_EVAL_VALUE} characters with no control character`);
    if (v !== null) words.push(`--${k}=${v}`);
  }
  const c = await call(['eval', 'start', ...words]);
  if (infra(c)) return { infra: errOf(c) };
  if (c.code !== 0) return rejected(errOf(c));
  const out = obj(c.json);
  const runId = typeof out.id === 'string' && RUN_ID.test(out.id) ? out.id : 'unknown';
  const tasks: unknown[] = Array.isArray(out.tasks) ? out.tasks : [];
  let handed = 0;
  const problems: string[] = [];
  for (const job of tasks.map((t) => obj(t).job)) {
    if (!validJobId(job)) {
      problems.push('eval start returned a malformed job id');
      continue;
    }
    const failed = await handOff(call, job, null, null);
    if (failed) problems.push(failed);
    else handed++;
  }
  return done([`eval run ${runId}: handed off ${handed} jobs`, ...problems].join('; '));
}

/** A job request routed to the inbox (requestScope found its job malformed or without a job.json). Nothing runs. */
async function jobRequest(r: ForgeRequest): Promise<Outcome> {
  return rejected(validJobId(r.job) ? `unknown job ${r.job}` : 'malformed job');
}

type Handler = (r: ForgeRequest, call: Call, S: string, ctx: HandlerCtx) => Promise<Outcome>;

const HANDLERS: Record<string, Handler> = {
  sync,
  next,
  run,
  retro,
  'eval-run': evalRun,
  ...Object.fromEntries(JOB_REQUEST_TYPES.map((t) => [t, jobRequest])),
};

/** Answers one request the runner handles (`handles(r)`). Never throws for a request's own values. */
export function handle(r: ForgeRequest, call: Call, S: string, ctx: HandlerCtx): Promise<Outcome> {
  const h = Object.hasOwn(HANDLERS, r.type) ? HANDLERS[r.type] : null;
  return h ? h(r, call, S, ctx) : Promise.resolve(rejected(`the intake runner does not handle ${oneLineTitle(String(r.type)).slice(0, 40)} requests`));
}
