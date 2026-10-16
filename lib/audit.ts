// The audit trail export: who did what to a job, and when its gates opened and closed.
// `forge job audit` reads one job, `forge audit` every job plus the repo-level log. Rows are
// derived from events.jsonl on read; nothing here writes.
import { hasLiveJob, listArchived, readArchived } from './archive.ts';
import { listJobs, loadJob, parseEventLines, readEvents, repoAuditFile } from './jobs.ts';
import type { AuditRow, JobAudit, JobEvent, LoadedJob, RepoAudit, TransitionSide } from './types.ts';
import { ForgeError, readText, safeText } from './util.ts';

const PR_EVENTS = new Set(['pr-opened', 'pr-merged', 'pr-auto-merge']);

const side = (s: unknown): Partial<TransitionSide> => (s && typeof s === 'object' ? (s as TransitionSide) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const pr = (n: unknown) => (typeof n === 'number' || typeof n === 'string' ? `#${n}` : null);

/** A short per-type summary for the `detail` column: one line, at most 200 characters. */
function detail(e: JobEvent): string | null {
  const join = (v: unknown) => (Array.isArray(v) ? v.map(String).join(',') : null);
  let d: string | null;
  switch (e.type) {
    case 'budget-set':
      d = `${String(e.key)}=${String(e.value)}`;
      break;
    case 'budget-ack':
      d = join(e.keys);
      break;
    case 'repo-budget-ack':
      d = str(e.period);
      break;
    case 'budget-override':
      d = str(e.month);
      break;
    case 'linked':
      d = [str(e.tracker), str(e.ref)].filter(Boolean).join(':') || null;
      break;
    case 'issue-link':
      d = e.none ? `none${str(e.reason) ? `: ${e.reason}` : ''}` : null;
      break;
    case 'claimed':
      d = str(e.session);
      break;
    case 'dependencies-overridden':
      d = join(e.unmet);
      break;
    case 'pr-merged':
      d = [pr(e.number), str(e.method)].filter(Boolean).join(' ') || null;
      break;
    case 'pr-merge-bypass':
      d = [pr(e.number), str(e.checks) && `checks ${e.checks}`].filter(Boolean).join(' ') || null;
      break;
    case 'pr-opened':
    case 'pr-auto-merge':
    case 'pr-merge-failed':
      d = pr(e.number);
      break;
    case 'daemon-permission':
      d = [str(e.tool), str(e.decision)].filter(Boolean).join(' ') || null;
      break;
    case 'daemon-mode':
      d = str(e.mode);
      break;
    case 'archived':
      d = str(e.trigger);
      break;
    case 'config-set':
      d = `${String(e.key)}: ${JSON.stringify(e.previous ?? null)} -> ${JSON.stringify(e.value ?? null)}`;
      break;
    default:
      d = null;
  }
  return d === null ? null : safeText(d, 200) || null;
}

/** The audit rows one event yields: its actor row, gate rows for a transition, or a PR row. */
export function eventRows(e: JobEvent, job: string | null): AuditRow[] {
  const row = (action: string, note: string | null, det: string | null = null): AuditRow => ({ ts: e.ts, job, actor: e.actor ?? null, action, note, detail: det });
  if (e.type === 'transition') {
    const from = side(e.from);
    const to = side(e.to);
    const rows: AuditRow[] = [];
    const reason = str(e.reason);
    // A waiting job that moves to another gate leaves one and enters the next; a reason update on the same gate is neither.
    const same = from.state === 'waiting' && to.state === 'waiting' && from.waitingOn === to.waitingOn;
    if (from.state === 'waiting' && !same) rows.push(row(`gate-cleared:${from.waitingOn ?? 'unknown'}`, reason));
    if (to.state === 'waiting' && !same) rows.push(row(`gate:${to.waitingOn ?? 'unknown'}`, reason));
    return rows;
  }
  if (e.actor === undefined && !PR_EVENTS.has(e.type)) return [];
  const action = e.type === 'human' && typeof e.action === 'string' ? e.action : e.type;
  return [row(action, typeof e.note === 'string' ? e.note : null, detail(e))];
}

function rowsOf(events: JobEvent[], job: string | null): AuditRow[] {
  return events.flatMap((e) => (typeof e.ts === 'string' ? eventRows(e, job) : []));
}

function prOf(job: LoadedJob, events: JobEvent[]): JobAudit['pr'] {
  const merged = events.findLast((e) => e.type === 'pr-merged');
  return {
    number: typeof job.pr?.number === 'number' ? job.pr.number : null,
    mergeMethod: merged && typeof merged.method === 'string' ? merged.method : null,
    merged: Boolean(merged) || job.pr?.state === 'MERGED',
  };
}

/** `forge job audit <id>`: one job's rows in time order, from its archive record once it has no live dir. */
export function jobAudit(root: string, id: string): JobAudit {
  if (!hasLiveJob(root, id)) {
    const a = readArchived(root, id);
    if (a) return { id: a.id, title: a.job.title, pr: prOf(a.job, a.events), rows: rowsOf(a.events, a.id) };
  }
  const job = loadJob(root, id);
  const events = readEvents(root, job.id);
  return { id: job.id, title: job.title, pr: prOf(job, events), rows: rowsOf(events, job.id) };
}

/** The jobs `forge audit` reads: the live ones, then archived ones (listArchived skips an id that is still live). */
export function auditJobIds(root: string): string[] {
  return [...new Set([...listJobs(root).map((j) => j.id), ...listArchived(root).map((a) => a.id)])];
}

/** Rows from .forge/runtime/audit.jsonl: human actions with no job, such as `forge config set`. */
export function repoAuditRows(root: string): AuditRow[] {
  return rowsOf(parseEventLines(readText(repoAuditFile(root))), null);
}

/** `forge audit`: every job's rows and the repo's, in [since, until), sorted by time then job id. */
export function auditAll(root: string, since: string, until: string): RepoAudit & { prs: Record<string, JobAudit['pr']> } {
  const from = Date.parse(since);
  const to = Date.parse(until);
  const prs: Record<string, JobAudit['pr']> = {};
  const all: AuditRow[] = [];
  for (const id of auditJobIds(root)) {
    let a: JobAudit;
    try {
      a = jobAudit(root, id);
    } catch {
      // A job written by a newer Forge, or removed mid-read, is not this export's to fail on.
      continue;
    }
    prs[a.id] = a.pr;
    all.push(...a.rows);
  }
  all.push(...repoAuditRows(root));
  const rows = all
    .map((r, i) => ({ r, i, t: Date.parse(r.ts) }))
    .filter((x) => x.t >= from && x.t < to)
    .sort((a, b) => a.t - b.t || (a.r.job ?? '').localeCompare(b.r.job ?? '') || a.i - b.i)
    .map((x) => x.r);
  return { since, until, rows, prs };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `YYYY-MM-DD` (UTC midnight) or a full ISO timestamp with its zone, as an ISO string. */
export function parseAuditDate(s: unknown, flag: string): string {
  const v = typeof s === 'string' ? s.trim() : '';
  const t = DAY.test(v) ? Date.parse(`${v}T00:00:00Z`) : ISO.test(v) ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new ForgeError(`${flag} needs a date: YYYY-MM-DD or a full ISO timestamp (got ${JSON.stringify(String(s ?? '')).slice(0, 60)})`, 'usage');
  return new Date(t).toISOString();
}

export const CSV_HEADER = ['ts', 'job', 'actor', 'source', 'action', 'note', 'detail', 'pr', 'merge_method'] as const;

/**
 * One RFC 4180 field. A cell a spreadsheet would read as a formula gets a leading `'` first, so a
 * note such as `=HYPERLINK(…)` stays text.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV with CRLF line ends; `prOf` gives each row's job PR number and merge method. */
export function toCsv(rows: AuditRow[], prOf: (job: string | null) => { number: number | null; mergeMethod: string | null } | null): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    const p = prOf(r.job);
    lines.push([r.ts, r.job, r.actor?.login, r.actor?.source, r.action, r.note, r.detail, p?.number, p?.mergeMethod].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
