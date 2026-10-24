// The Thread's typing: a message, or a reply, that arrives while the drawer is open types out behind a caret, as if its
// sender wrote it there. Parts already there when the Thread opens show whole. Pure, so node:test can pin it.

/** A character's share of the typing, and the bounds on a whole part's: a short reply still types, a long one never drags. */
export const TYPE_MS_PER_CHAR = 18;
export const TYPE_MIN_MS = 400;
export const TYPE_MAX_MS = 2400;

/** How long a part of `length` characters takes to type. */
export const typingMs = (length: number): number => Math.min(TYPE_MAX_MS, Math.max(TYPE_MIN_MS, length * TYPE_MS_PER_CHAR));

/** One part typing: when it starts (epoch ms) and how long it takes. */
export interface Typing {
  start: number;
  ms: number;
}

/** What `text` shows `now`: nothing before the part starts, all of it once done, and never half a surrogate pair. */
export function typedText(text: string, part: Typing, now: number): string {
  const elapsed = now - part.start;
  if (elapsed <= 0) return '';
  if (elapsed >= part.ms) return text;
  let n = Math.ceil((text.length * elapsed) / part.ms);
  const code = text.charCodeAt(n - 1);
  if (code >= 0xd800 && code <= 0xdbff) n++;
  return text.slice(0, n);
}

/**
 * When each new part types, given the parts seen so far: a message's text starts `now`, and its reply starts once that
 * text is typed (or `now`, when only the reply is new). `parts` maps `<id>:text` and `<id>:result` to their text.
 */
export function scheduleTyping(parts: ReadonlyMap<string, string>, fresh: readonly string[], now: number): Record<string, Typing> {
  const out: Record<string, Typing> = {};
  for (const key of fresh) {
    const text = parts.get(key) ?? '';
    const [id, which] = splitKey(key);
    const lead = which === 'result' ? out[`${id}:text`] : undefined;
    const start = lead ? lead.start + lead.ms : now;
    out[key] = { start, ms: typingMs(text.length) };
  }
  return out;
}

const splitKey = (key: string): [string, string] => {
  const at = key.lastIndexOf(':');
  return [key.slice(0, at), key.slice(at + 1)];
};
