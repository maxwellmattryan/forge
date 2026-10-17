// Checkout steps: what `forge focus` does to fixed paths and with configured commands so tools that
// read one place (a DAW's plug-in folder) follow the focused job. The steps come only from the main
// checkout's config. The record in .forge/runtime/checkout.json is agent-writable, so it only ever
// steers undo for targets and command pairs the current config names, and the aside path is always
// derived, never read from it. worktree.ts imports this module, so it must never import worktree.ts:
// callers inject the command runner.
import fs from 'node:fs';
import path from 'node:path';
import { resolveTarget } from './checkout-config.ts';
import { worktreeRoot } from './config.ts';
import { containedWorktree } from './editor.ts';
import { readSmallJson } from './focus.ts';
import { jobDir, logEvent } from './jobs.ts';
import { paths } from './paths.ts';
import { validJobId } from './requests.ts';
import type { CheckoutStep, CheckoutStepResult, Config, Job } from './types.ts';
import { ForgeError, withLockAsync, writeJsonAtomic } from './util.ts';

/** What a step needs from `forge run`'s result (lib/worktree.ts CommandResult). */
export interface StepRun {
  ok: boolean;
  exit: number | null;
  log: string;
}

/** Runs a configured command for a job exactly as `forge run` does, with `label` naming its log file. */
export type StepRunner = (id: string, name: string, label: string) => Promise<StepRun>;

type Phase = 'apply' | 'undo' | 'rollback';
type EntryState = 'pending' | 'applied';
export interface LinkEntry {
  step: number;
  kind: 'link';
  to: string;
  source: string;
  aside: boolean;
  state: EntryState;
}
export interface RunEntry {
  step: number;
  kind: 'run';
  run: string;
  undo: string | null;
  state: EntryState;
}
export type CheckoutEntry = LinkEntry | RunEntry;
export interface CheckoutRecord {
  v: 1;
  job: string;
  entries: CheckoutEntry[];
}

/** The report a failed switch carries; the message names the failing step. */
export interface CheckoutReport {
  undone: CheckoutStepResult[];
  applied: CheckoutStepResult[];
  job?: string;
}

/** A checkout step failed and focus was left where it was: the server answers 409. */
export class CheckoutError extends ForgeError {
  declare report: CheckoutReport;
  constructor(message: string, report: CheckoutReport) {
    super(message, 'failed');
    this.report = report;
  }
}

export const ASIDE_SUFFIX = '.forge-aside';
export const checkoutFile = (root: string): string => path.join(paths(root).runtime, 'checkout.json');
const checkoutLock = (root: string): string => path.join(paths(root).locks, 'checkout');

/** Every focus switch and checkout undo runs under this lock; a concurrent one fails fast. */
export function withCheckoutLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withLockAsync(checkoutLock(root), fn, { timeoutMs: 2000, staleMs: 10 * 60_000 });
}

const isLink = (s: CheckoutStep): s is { link: string; to: string } => typeof (s as any)?.link === 'string';
const isRun = (s: CheckoutStep): s is { run: string; undo?: string | null } => typeof (s as any)?.run === 'string';
const absString = (v: unknown): v is string => typeof v === 'string' && path.isAbsolute(v) && !v.includes('\0');
const name = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 200;

function validEntry(e: unknown): e is CheckoutEntry {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const x = e as Record<string, unknown>;
  if (!Number.isInteger(x.step) || (x.step as number) < 0) return false;
  if (x.state !== 'pending' && x.state !== 'applied') return false;
  if (x.kind === 'link') return absString(x.to) && absString(x.source) && typeof x.aside === 'boolean';
  if (x.kind === 'run') return name(x.run) && (x.undo === null || name(x.undo));
  return false;
}

/** The stored record, or null when there is none, it is a link, FIFO or too big, or its shape is wrong. */
export function readCheckoutRecord(root: string): CheckoutRecord | null {
  const v = readSmallJson(checkoutFile(root));
  if (!v || v.v !== 1 || !validJobId(v.job) || !Array.isArray(v.entries) || !v.entries.every(validEntry)) return null;
  return { v: 1, job: v.job, entries: v.entries as CheckoutEntry[] };
}

const lexists = (p: string): fs.Stats | null => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

const jobExists = (root: string, id: string): boolean => validJobId(id) && fs.existsSync(path.join(jobDir(root, id), 'job.json'));

function event(root: string, id: string, phase: Phase, r: CheckoutStepResult): void {
  // Paths stay in the result: the event log is shown and bundled more widely than the reply.
  if (jobExists(root, id)) logEvent(root, id, 'checkout', { phase, step: r.step, kind: r.kind, ok: r.ok });
}

async function runStep(run: StepRunner, id: string, command: string, label: string, step: number): Promise<CheckoutStepResult> {
  try {
    const r = await run(id, command, label);
    return { step, kind: 'run', ok: r.ok, command, log: r.log, ...(r.ok ? {} : { error: r.exit === null ? 'did not exit' : `exit ${r.exit}` }) };
  } catch (e) {
    return { step, kind: 'run', ok: false, command, error: (e as Error).message };
  }
}

/**
 * Where Forge links a configured step's source for `id`: `<resolved worktrees root>/<id>/<link>`,
 * the path containedWorktree accepts. Undo unlinks only a symlink that points exactly here.
 */
function expectedSource(root: string, config: Config, id: string, link: string): string {
  const base = worktreeRoot(root, config);
  let real: string;
  try {
    real = fs.realpathSync(base);
  } catch {
    real = path.resolve(base);
  }
  return path.join(real, id, link);
}

function undoLink(root: string, config: Config, id: string, e: LinkEntry): CheckoutStepResult {
  const r: CheckoutStepResult = { step: e.step, kind: 'link', ok: true, to: e.to };
  const step = (config.checkout ?? []).find((s) => isLink(s) && typeof s.to === 'string' && resolveTarget(s.to) === e.to);
  if (!step || !isLink(step) || e.source !== expectedSource(root, config, id, step.link))
    return { ...r, ok: false, error: 'no configured checkout step links this path for this job; left in place' };
  try {
    const st = lexists(e.to);
    if (st?.isSymbolicLink() && fs.readlinkSync(e.to) === e.source) fs.unlinkSync(e.to);
    // A pending entry may never have touched `to`: what is there is still the user's, not a change.
    else if (st && e.state === 'applied') return { ...r, ok: false, error: 'changed since focus; left in place' };
    const aside = e.to + ASIDE_SUFFIX;
    if (e.aside && !lexists(e.to) && lexists(aside)) fs.renameSync(aside, e.to);
    return r;
  } catch (err) {
    return { ...r, ok: false, error: (err as Error).message };
  }
}

async function undoRun(config: Config, id: string, e: RunEntry, run: StepRunner): Promise<CheckoutStepResult> {
  const step = (config.checkout ?? []).find((s) => isRun(s) && s.run === e.run && (s.undo ?? null) === e.undo);
  if (!step) return { step: e.step, kind: 'run', ok: false, command: e.undo ?? e.run, error: 'not a configured run and undo pair; nothing run' };
  if (e.undo === null) return { step: e.step, kind: 'run', ok: true };
  return runStep(run, id, e.undo, `checkout-undo-${e.undo}`, e.step);
}

/** Undoes entries in reverse, best effort: every one is attempted, and each logs an event. */
async function undoEntries(root: string, config: Config, id: string, entries: CheckoutEntry[], phase: Phase, run: StepRunner): Promise<CheckoutStepResult[]> {
  const results: CheckoutStepResult[] = [];
  for (const e of [...entries].reverse()) {
    const r = e.kind === 'link' ? undoLink(root, config, id, e) : await undoRun(config, id, e, run);
    event(root, id, phase, r);
    results.push(r);
  }
  return results;
}

/**
 * Undoes the recorded checkout and removes the record, even when steps failed. Null when there is
 * no record. The caller holds the checkout lock.
 */
export async function undoCheckout(root: string, config: Config, run: StepRunner): Promise<{ job: string; results: CheckoutStepResult[] } | null> {
  const record = readCheckoutRecord(root);
  if (!record) return null;
  const results = await undoEntries(root, config, record.job, record.entries, 'undo', run);
  fs.rmSync(checkoutFile(root), { force: true });
  return { job: record.job, results };
}

/** Why a link step can't be applied, or null; checked before anything is recorded or moved. */
function linkProblem(contained: string | null, step: { link: string }, to: string): string | null {
  if (!contained) return "the job has no worktree of its own under the worktrees root";
  const source = path.join(contained, step.link);
  if (!lexists(source)) return `source ${step.link} does not exist in the job's worktree`;
  let real: string;
  try {
    real = fs.realpathSync(source);
  } catch {
    return `source ${step.link} does not resolve`;
  }
  const rel = path.relative(contained, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return `source ${step.link} resolves outside the job's worktree`;
  try {
    if (!fs.statSync(path.dirname(to)).isDirectory()) throw new Error();
  } catch {
    return `the parent directory of ${to} does not exist`;
  }
  if (lexists(to + ASIDE_SUFFIX)) return `${to}${ASIDE_SUFFIX} already exists; move it away first`;
  return null;
}

/**
 * Applies the job's steps in config order, recording each entry as pending before it touches
 * anything and as applied after. On a failure the entries recorded so far are undone in reverse
 * and the record is removed. A run step whose command failed is not undone: it applied nothing.
 * The caller holds the checkout lock.
 */
export async function applyCheckout(
  root: string,
  config: Config,
  job: Pick<Job, 'id' | 'worktree'>,
  run: StepRunner,
): Promise<{ ok: boolean; results: CheckoutStepResult[]; failed?: CheckoutStepResult; rolledBack?: CheckoutStepResult[] }> {
  const steps = config.checkout ?? [];
  const record: CheckoutRecord = { v: 1, job: job.id, entries: [] };
  const save = () => writeJsonAtomic(checkoutFile(root), record);
  const results: CheckoutStepResult[] = [];
  const contained = steps.some(isLink) ? containedWorktree(root, config, job) : null;
  for (const [i, step] of steps.entries()) {
    let r: CheckoutStepResult;
    if (isLink(step)) {
      const to = resolveTarget(step.to);
      r = { step: i, kind: 'link', ok: false, to };
      const problem = linkProblem(contained, step, to);
      if (problem) r.error = problem;
      else {
        const entry: LinkEntry = { step: i, kind: 'link', to, source: path.join(contained!, step.link), aside: Boolean(lexists(to)), state: 'pending' };
        record.entries.push(entry);
        save();
        try {
          if (entry.aside) fs.renameSync(to, to + ASIDE_SUFFIX);
          fs.symlinkSync(entry.source, to);
          entry.state = 'applied';
          save();
          r.ok = true;
        } catch (e) {
          r.error = (e as Error).message;
        }
      }
    } else if (isRun(step)) {
      const entry: RunEntry = { step: i, kind: 'run', run: step.run, undo: step.undo ?? null, state: 'pending' };
      record.entries.push(entry);
      save();
      r = await runStep(run, job.id, step.run, `checkout-${step.run}`, i);
      if (r.ok) entry.state = 'applied';
      else record.entries.pop();
      save();
    } else {
      r = { step: i, kind: 'run', ok: false, error: 'not a valid checkout step (forge config validate)' };
    }
    event(root, job.id, 'apply', r);
    results.push(r);
    if (!r.ok) {
      const rolledBack = await undoEntries(root, config, job.id, record.entries, 'rollback', run);
      fs.rmSync(checkoutFile(root), { force: true });
      return { ok: false, results, failed: r, rolledBack };
    }
  }
  return { ok: true, results };
}

/** The failing step as one line: `checkout[1] run install-plugin failed (exit 2); log: logs/…`. */
export function failureLine(r: CheckoutStepResult): string {
  if (r.kind === 'run') return `checkout[${r.step}] run ${r.command ?? ''} failed (${r.error ?? 'failed'})${r.log ? `; log: ${r.log}` : ''}`;
  return `checkout[${r.step}] link ${r.to ?? ''} failed: ${r.error ?? 'failed'}`;
}
