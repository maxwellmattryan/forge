// A job's Thread in the drawer: its requests as a conversation, the secret scanner's notes, and the
// issue-link gate's candidates. Plain functions, so node:test can pin them.
import type { ForgeRequest, Job, JobDetail, JobEvent } from './types.ts';

/** Who said it: you (the dashboard), the CLI, a Forge daemon session hand-off, or the tracker the job came from. */
export type ThreadFrom = 'you' | 'cli' | 'forge' | 'tracker';
export type ThreadStatus = 'queued' | 'handling' | 'done' | 'rejected';

/**
 * What a message asks for, as a discriminator the component turns into words: the raw request type
 * and args (`resume`, `args.link`, `args.n`) are never shown as they are.
 */
export type ThreadAction =
  | { kind: 'request' }
  | { kind: 'imported' }
  | { kind: 'started' }
  | { kind: 'handoff' }
  | { kind: 'resumed' }
  | { kind: 'link'; ref: string }
  | { kind: 'link-new' }
  | { kind: 'link-none' }
  | { kind: 'next'; n: number }
  | { kind: 'run'; ref: string }
  | { kind: 'verb'; verb: 'approve' | 'revise' | 'rework' | 'answer' | 'cancel' | 'sync' | 'eval' | 'retro' }
  | { kind: 'secret' };

/** Where the scanner ran (lib/engine/guard/secrets.ts logSecrets); an unknown gate is `other`. */
export type SecretGate = 'verify' | 'commit' | 'pr' | 'agent-end' | 'other';

/** One masked finding of a `secret-found` event: never the value, only its masked excerpt and fingerprint. */
export interface SecretLine {
  kind: string;
  path: string;
  line: number | null;
  excerpt: string;
  fingerprint: string | null;
}

/** A `secret-found` event as the Thread shows it. */
export interface ThreadSecret {
  gate: SecretGate;
  role: string | null;
  blocked: boolean;
  count: number;
  findings: SecretLine[];
  more: number;
  /** The scan's own error line when it could not finish; null otherwise. */
  error: string | null;
}

export interface ThreadItem {
  id: string;
  from: ThreadFrom;
  action: ThreadAction;
  text: string | null;
  /** Null for the opening message, which is the job's request rather than a queued request. */
  status: ThreadStatus | null;
  at: string | null;
  /** The session's ack `result`: its reply. */
  result: string | null;
  /** A note from the secret scanner; null for requests. */
  secret: ThreadSecret | null;
}

/** The job's own request (request.md), shown as the conversation's first message. */
export interface ThreadOpening {
  text: string | null;
  at: string | null;
  /** The job came from a tracker item, so the text is the issue's, not yours. */
  tracker: boolean;
}

/**
 * The opening message from GET /api/jobs/:id. It trusts `requestFromTracker`, never `job.issues`:
 * `forge job link` and `--create` add issues while request.md still holds your own words.
 */
export function threadOpening(d: Pick<JobDetail, 'request' | 'requestFromTracker'> & { job: Pick<Job, 'createdAt'> }): ThreadOpening {
  return { text: d.request ?? null, at: d.job.createdAt ?? null, tracker: d.requestFromTracker === true };
}

const STATUS: Record<ForgeRequest['status'], ThreadStatus> = { pending: 'queued', 'in-progress': 'handling', done: 'done', rejected: 'rejected' };

const fromOf = (from: unknown): ThreadFrom => (from === 'dashboard' ? 'you' : String(from ?? '').startsWith('daemon:') ? 'forge' : 'cli');

const VERB: Partial<Record<ForgeRequest['type'], Extract<ThreadAction, { kind: 'verb' }>['verb']>> = {
  approve: 'approve',
  'revise-spec': 'revise',
  rework: 'rework',
  answer: 'answer',
  cancel: 'cancel',
  sync: 'sync',
  'eval-run': 'eval',
  retro: 'retro',
};

/** What a request asks for, from its type and the args the dashboard and the CLI send. */
export function threadAction(r: Pick<ForgeRequest, 'type' | 'args' | 'from'>): ThreadAction {
  const args = r.args && typeof r.args === 'object' ? r.args : {};
  if (r.type === 'approve' && typeof args.link === 'string') {
    if (args.link === 'new') return { kind: 'link-new' };
    if (args.link === 'none') return { kind: 'link-none' };
    return { kind: 'link', ref: args.link.replace(/^#/, '') };
  }
  if (r.type === 'resume') {
    if (args.intake === 'new') return { kind: 'started' };
    if (args.intake === 'run' || args.intake === 'next') return { kind: 'handoff' };
    return { kind: 'resumed' };
  }
  if (r.type === 'next') return { kind: 'next', n: Number.isInteger(args.n) && (args.n as number) > 0 ? (args.n as number) : 1 };
  if (r.type === 'run') return { kind: 'run', ref: String(args.ref ?? '') };
  return { kind: 'verb', verb: VERB[r.type] ?? 'approve' };
}

/** The conversation, oldest first: the job's request, then its requests (ids start with their creation time), with the secret scanner's notes merged in by time. */
export function threadItems(requests: ForgeRequest[] | null | undefined, opening: ThreadOpening | null = null, events: JobEvent[] | null | undefined = []): ThreadItem[] {
  const out: ThreadItem[] = [];
  if (opening?.text) out.push({ id: 'request', from: opening.tracker ? 'tracker' : 'you', action: { kind: opening.tracker ? 'imported' : 'request' }, text: opening.text, status: null, at: opening.at, result: null, secret: null });
  const rest = (requests ?? [])
    .filter((r) => r && typeof r.id === 'string')
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (r): ThreadItem => ({
        id: r.id,
        from: fromOf(r.from),
        action: threadAction(r),
        text: typeof r.text === 'string' && r.text ? r.text : null,
        status: STATUS[r.status] ?? 'queued',
        at: r.createdAt,
        result: typeof r.result === 'string' && r.result ? r.result : null,
        secret: null,
      }),
    );
  // Merged by time; on a tie the request comes first.
  const merged = [...out, ...rest];
  for (const note of secretItems(events)) {
    const at = note.at ?? '';
    const i = merged.findIndex((m) => (m.at ?? '') > at);
    merged.splice(i < 0 ? merged.length : i, 0, note);
  }
  return merged;
}

const GATES: Record<string, SecretGate> = { verify: 'verify', commit: 'commit', pr: 'pr', 'agent-end': 'agent-end' };
const KIND = /^[a-z0-9-]{1,40}$/;
const ROLE = /^[a-z0-9:-]{1,60}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const MAX_PATH = 500;
const MAX_EXCERPT = 24;
const MAX_FINDINGS = 10;
const MAX_ERROR = 300;
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * `secret-found` events as Forge's notes, read defensively: events.jsonl is a file in the job dir, so a
 * finding with a bad kind, a non-string path or an over-long excerpt is dropped, and at most 10 are kept.
 */
export function secretItems(events: JobEvent[] | null | undefined): ThreadItem[] {
  const out: ThreadItem[] = [];
  (events ?? []).forEach((e, index) => {
    if (!e || e.type !== 'secret-found' || typeof e.ts !== 'string') return;
    const findings: SecretLine[] = [];
    for (const raw of Array.isArray(e.findings) ? e.findings : []) {
      if (findings.length === MAX_FINDINGS) break;
      if (!raw || typeof raw !== 'object') continue;
      const f = raw as Record<string, unknown>;
      if (typeof f.kind !== 'string' || !KIND.test(f.kind) || typeof f.path !== 'string' || typeof f.excerpt !== 'string' || f.excerpt.length > MAX_EXCERPT) continue;
      findings.push({
        kind: f.kind,
        path: f.path.length > MAX_PATH ? `${f.path.slice(0, MAX_PATH - 1)}…` : f.path,
        line: typeof f.line === 'number' && Number.isInteger(f.line) && f.line > 0 ? f.line : null,
        excerpt: f.excerpt,
        fingerprint: typeof f.fingerprint === 'string' && FINGERPRINT.test(f.fingerprint) ? f.fingerprint : null,
      });
    }
    const secret: ThreadSecret = {
      gate: GATES[String(e.gate)] ?? 'other',
      role: typeof e.role === 'string' && ROLE.test(e.role) ? e.role : null,
      blocked: e.blocked === true,
      count: Math.max(count(e.count) ?? 0, findings.length),
      findings,
      more: count(e.more) ?? 0,
      error: scanError(e.error),
    };
    out.push({ id: `secret:${e.ts}:${index}`, from: 'forge', action: { kind: 'secret' }, text: null, status: null, at: e.ts, result: null, secret });
  });
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** A scan error from events.jsonl: a string only, control characters turned into single spaces (a multi-line git error stays readable), at most 300 chars. */
function scanError(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const text = v.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, MAX_ERROR);
  return text || null;
}

/** One finding as a line of plain text: `kind · path:line · excerpt · sha256:<first 12 hex>`. */
export function secretLine(f: SecretLine): string {
  const place = f.line === null ? f.path : `${f.path}:${f.line}`;
  return [f.kind, place, f.excerpt, ...(f.fingerprint ? [f.fingerprint.slice(0, 'sha256:'.length + 12)] : [])].join(' · ');
}

/** What a reader has seen of one message: it changes when the message's status changes or its result arrives. */
export const threadMark = (item: Pick<ThreadItem, 'id' | 'status' | 'result'>): string => `${item.id}|${item.status ?? '-'}|${item.result ? 'r' : ''}`;
export const threadMarks = (items: Pick<ThreadItem, 'id' | 'status' | 'result'>[]): string[] => items.map(threadMark);

/**
 * The Thread tab's unread count: marks not in `seen`, so a new request, a new result and a status change each count once
 * per message (a status change and a result together still count one). Nothing is unread before a baseline exists.
 */
export function unreadCount(marks: string[], seen: string[] | null): number {
  if (!seen) return 0;
  const read = new Set(seen);
  return marks.filter((m) => !read.has(m)).length;
}

/** lib/core/job/issue-link.ts REF, duplicated: the dashboard never imports engine modules. */
export const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_TITLE = 200;
const MAX_CANDIDATES = 5;

export interface Candidate {
  ref: string;
  title: string;
  url: string | null;
}

/** lib/core/job/issue-ref.ts QUALIFIED, duplicated for the same reason: `owner/repo#12`, `group/sub/project#12`. */
const SEG = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';
const QUALIFIED = new RegExp(`^${SEG}(?:/${SEG}){1,4}#[1-9][0-9]{0,9}$`);

/** A typed ref (a leading `#` dropped unless it is qualified), or null when it isn't one the server accepts. */
export function cleanRef(raw: string): string | null {
  const typed = raw.trim();
  if (typed.length <= 200 && QUALIFIED.test(typed) && !typed.includes('..')) return typed;
  const ref = typed.replace(/^#/, '');
  return REF.test(ref) ? ref : null;
}

/**
 * issue-candidates.json, read defensively: it is a file in the job dir, so anything malformed is
 * dropped (bad refs, non-string or over-long titles, non-string urls) and at most 5 are kept.
 */
export function parseCandidates(text: string): Candidate[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const items = data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : [];
  const out: Candidate[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const { ref, title, url } = raw as Record<string, unknown>;
    if (typeof ref !== 'string' || !REF.test(ref)) continue;
    if (typeof title !== 'string' || title.length > MAX_TITLE) continue;
    if (url !== undefined && url !== null && typeof url !== 'string') continue;
    out.push({ ref, title, url: typeof url === 'string' ? url : null });
    if (out.length === MAX_CANDIDATES) break;
  }
  return out;
}
