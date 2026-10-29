// The POST /api/requests bodies the dashboard's buttons send, and the toast a queued one shows. No DOM access.
import type { RequestType } from './types.ts';

export interface RequestBody {
  type: RequestType;
  job?: string | null;
  text?: string | null;
  args: Record<string, unknown>;
}

export interface RequestInput {
  type: RequestType;
  job?: string | null;
  /** The inbox card's note; null outside a card. */
  note?: string | null;
  needsNote?: boolean;
  /** A button's fixed text, which wins over the note. */
  fixedText?: string | null;
  ref?: string | null;
  /** Extra args (`n` for next, `link` for an issue-link approve), merged after `ref`. */
  args?: Record<string, unknown>;
}

/** The POST /api/requests body a request button sends, or the toast it shows instead. */
export function buildRequest({ type, job = null, note = null, needsNote = false, fixedText = null, ref = null, args }: RequestInput): { body: RequestBody } | { error: string } {
  const text = fixedText ?? note?.trim() ?? null;
  if (needsNote && !text && ['answer', 'revise-spec'].includes(type)) return { error: 'Write something first.' };
  return { body: { type, job: job ?? null, text: text || null, args: { ...(ref ? { ref } : {}), ...(args ?? {}) } } };
}

export function evalRunBody(form: { tags?: string | null; tasks?: string | null; label?: string | null }): RequestBody {
  const val = (v: string | null | undefined) => v?.trim() || null;
  return { type: 'eval-run', args: { tags: val(form.tags), tasks: val(form.tasks), label: val(form.label) } };
}

export const queuedMessage = (type: string, daemon: unknown): string =>
  daemon ? `Queued "${type}". The daemon picks it up.` : `Queued "${type}". Your orchestrator session picks it up (/forge requests).`;
