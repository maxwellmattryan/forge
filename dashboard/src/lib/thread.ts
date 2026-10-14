// A job's Thread in the drawer: its requests as a conversation, and the issue-link gate's
// candidates. Plain functions, so node:test can pin them.
import type { ForgeRequest } from './types.ts';

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
  | { kind: 'verb'; verb: 'approve' | 'revise' | 'rework' | 'answer' | 'cancel' | 'sync' | 'eval' | 'retro' };

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
}

/** The job's own request (request.md), shown as the conversation's first message. */
export interface ThreadOpening {
  text: string | null;
  at: string | null;
  /** The job came from a tracker item, so the text is the issue's, not yours. */
  tracker: boolean;
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

/** The conversation, oldest first: the job's request, then its requests (ids start with their creation time). */
export function threadItems(requests: ForgeRequest[] | null | undefined, opening: ThreadOpening | null = null): ThreadItem[] {
  const out: ThreadItem[] = [];
  if (opening?.text) out.push({ id: 'request', from: opening.tracker ? 'tracker' : 'you', action: { kind: opening.tracker ? 'imported' : 'request' }, text: opening.text, status: null, at: opening.at, result: null });
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
      }),
    );
  return [...out, ...rest];
}

/** lib/issue-link.ts REF, duplicated: the dashboard never imports engine modules. */
export const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_TITLE = 200;
const MAX_CANDIDATES = 5;

export interface Candidate {
  ref: string;
  title: string;
  url: string | null;
}

/** A typed ref without its `#`, or null when it isn't one the server accepts. */
export function cleanRef(raw: string): string | null {
  const ref = raw.trim().replace(/^#/, '');
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
