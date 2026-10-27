// Directives: the director loop's record, one `directive` event per choice the office session makes
// (start, resume, note, skip) and per enforcement the Office pass applies (pause, close, stall, park,
// cancel, release), plus the retro a mandate's close queues (retro, by the pass or the owner). Each goes
// to the repo audit log (`.forge/runtime/audit.jsonl`), and one that names a job to that job's events
// too, so `forge audit` and `forge job audit` show them with no file of their own.
// docs/architecture/foreman.md › Director loop.
import { logEvent, logRepoEvent, parseEventLines, repoAuditFile } from '#core/job/store.ts';
import { validJobId } from '#core/job/requests.ts';
import { readRegularText } from '#core/os/fs.ts';
import { DIRECTIVE_ACTIONS } from '#api/constants.ts';
import { cleanReason, isMandateId } from './contract.ts';
import type { Directive, DirectiveAction, EventActor } from '#core/types.ts';

// The Office page reads directives too, so the shapes are /api shapes (lib/api/repo.ts).
export type { Directive, DirectiveAction } from '#api/types.ts';

/** The audit log is append-only and never rotated here: past this it is read no further, rather than whole. */
const AUDIT_MAX_BYTES = 32 * 1024 * 1024;
const ISSUE_MAX = 200;

const isAction = (v: unknown): v is DirectiveAction => (DIRECTIVE_ACTIONS as readonly unknown[]).includes(v);
const cleanIssue = (v: unknown): string | null => (typeof v === 'string' && v && v.length <= ISSUE_MAX && !/[\x00-\x1f\x7f]/.test(v) ? v : null);

/**
 * Logs one directive: the repo audit event, and the same event on the job when `job` is set. The reason
 * is one line of at most 200 characters (cleanReason); an empty one is logged as the action.
 */
export function logDirective(root: string, d: { mandate: string; action: DirectiveAction; issue?: string | null; job?: string | null; reason: string; actor: EventActor }): void {
  const job = d.job && validJobId(d.job) ? d.job : null;
  const data = { mandate: d.mandate, action: d.action, issue: cleanIssue(d.issue), job, reason: cleanReason(d.reason) ?? d.action, actor: d.actor };
  logRepoEvent(root, 'directive', data);
  if (job) logEvent(root, job, 'directive', data);
}

/**
 * The directives in the repo audit log, oldest first: only well-formed `directive` events (a mandate id
 * and a known action), for one mandate when `mandate` is given, the last `limit` when it is.
 */
export function readDirectives(root: string, opts: { mandate?: string; limit?: number } = {}): Directive[] {
  const text = readRegularText(repoAuditFile(root), AUDIT_MAX_BYTES);
  if (text === null) return [];
  const out: Directive[] = [];
  for (const e of parseEventLines(text)) {
    if (e.type !== 'directive' || typeof e.ts !== 'string' || !isMandateId(e.mandate) || !isAction(e.action)) continue;
    if (opts.mandate !== undefined && e.mandate !== opts.mandate) continue;
    out.push({
      ts: e.ts,
      mandate: e.mandate,
      action: e.action,
      issue: cleanIssue(e.issue),
      job: validJobId(e.job) ? e.job : null,
      reason: cleanReason(e.reason) ?? e.action,
      actor: (e.actor as EventActor | undefined) ?? null,
    });
  }
  return opts.limit === undefined ? out : out.slice(-opts.limit);
}
