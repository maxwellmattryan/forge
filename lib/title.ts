// Short, deterministic job titles from free text (POST /api/jobs). The job id is a slug of the
// title, so it has to stay short: the first sentence, minus markdown and polite filler.

const FILLER = /^(please|pls|can you|could you|would you|i want to|i'd like to|we need to|we should|let's|lets)\b[\s,:]*/i;
const MAX_WORDS = 8;
const MAX_CHARS = 60;
const MAX_TITLE = 120;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Control characters out, whitespace collapsed, capped at 120: null when nothing is left. */
export function normalizeTitle(s: string): string | null {
  const out = String(s ?? '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
    .trim();
  return out || null;
}

/** One line without its markdown block markers, links or emphasis. */
function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`~]+/g, '')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .trim();
}

/**
 * The first sentence of the first line with words in it, without markdown, a leading `/forge` or
 * filler ("please", "can you", …), at most 8 words and 60 characters, no trailing punctuation,
 * first letter capitalised. Null when nothing alphanumeric is left.
 */
export function deriveTitle(text: string): string | null {
  const line = String(text ?? '')
    .split(/\r?\n|\r/)
    .map(plainLine)
    .find((l) => /[\p{L}\p{N}]/u.test(l));
  if (!line) return null;
  let s = line.replace(/^\/forge(?::forge)?(?=\s|$)\s*/i, '');
  for (let i = 0; i < 3 && FILLER.test(s); i++) s = s.replace(FILLER, '');
  s = s.replace(/^[^\p{L}\p{N}]+/u, '').split(/[.!?]+(?:\s|$)/)[0];
  s = s.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS).join(' ');
  if (s.length > MAX_CHARS) {
    const cut = s.slice(0, MAX_CHARS + 1);
    const space = cut.lastIndexOf(' ');
    s = space > 0 ? cut.slice(0, space) : s.slice(0, MAX_CHARS);
  }
  s = s.replace(/[^\p{L}\p{N}]+$/u, '');
  if (!/[\p{L}\p{N}]/u.test(s)) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
