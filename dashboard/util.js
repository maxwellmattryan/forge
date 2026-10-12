// @ts-check
// Shared dashboard helpers. No DOM access at import time, so node:test can import them.
/** @param {unknown} v */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** @param {unknown} n */
export const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
/** @param {unknown} n */
export const usd = (n) => (n == null ? '—' : `$${Number(n) < 1 ? Number(n).toFixed(3) : Number(n).toFixed(2)}`);
/** @param {string|null|undefined} iso */
export const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
/** Chip colours per tone, shared by toneChip and chips that need extra attributes. */
export const TONE_CLASS = /** @type {Record<string, string>} */ ({
  ok: 'bg-ok/15 text-ok',
  bad: 'bg-bad/15 text-bad',
  warn: 'bg-warn/15 text-warn',
  info: 'bg-info/15 text-info',
  accent: 'bg-accent/15 text-accent',
  muted: 'bg-raised text-muted',
});
/** @param {string} tone @param {unknown} text */
export const toneChip = (tone, text) => `<span class="chip ${TONE_CLASS[tone]}">${esc(text)}</span>`;
