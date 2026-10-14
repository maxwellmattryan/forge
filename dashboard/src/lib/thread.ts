// A job's Thread in the drawer: its requests as a conversation, and the issue-link gate's
// candidates. Plain functions, so node:test can pin them.
import type { ForgeRequest } from './types.ts';

/** Who sent a request: the dashboard (you), the CLI, or a Forge daemon session hand-off. */
export type ThreadFrom = 'you' | 'cli' | 'forge';
export type ThreadStatus = 'queued' | 'handling' | 'done' | 'rejected';

export interface ThreadItem {
  id: string;
  from: ThreadFrom;
  type: ForgeRequest['type'];
  text: string | null;
  status: ThreadStatus;
  at: string;
  /** The session's ack `result`: its reply. */
  result: string | null;
}

const STATUS: Record<ForgeRequest['status'], ThreadStatus> = { pending: 'queued', 'in-progress': 'handling', done: 'done', rejected: 'rejected' };

const fromOf = (from: unknown): ThreadFrom => (from === 'dashboard' ? 'you' : String(from ?? '').startsWith('daemon:') ? 'forge' : 'cli');

/** The conversation, oldest first: request ids start with their creation time. */
export function threadItems(requests: ForgeRequest[] | null | undefined): ThreadItem[] {
  return (requests ?? [])
    .filter((r) => r && typeof r.id === 'string')
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      from: fromOf(r.from),
      type: r.type,
      text: typeof r.text === 'string' && r.text ? r.text : null,
      status: STATUS[r.status] ?? 'queued',
      at: r.createdAt,
      result: typeof r.result === 'string' && r.result ? r.result : null,
    }));
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
