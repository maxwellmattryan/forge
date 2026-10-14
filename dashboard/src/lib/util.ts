// Shared dashboard helpers. No DOM access (api touches fetch only when called), so node:test can import them.
// Toasts live in toast.svelte.ts now that components render them.
export const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c]);
export const num = (n: unknown): string => (n == null ? '—' : Number(n).toLocaleString());
export const usd = (n: unknown): string => (n == null ? '—' : `$${Number(n) < 1 ? Number(n).toFixed(3) : Number(n).toFixed(2)}`);
export const ago = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
/** A log line's local wall-clock time, HH:MM:SS; '' when the line has none or it does not parse. */
export const clock = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
export const pct = (x: number | null | undefined): string => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const tokensShort = (n: number | null | undefined): string => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const dur = (ms: number | null | undefined): string => {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s}s`;
};
/** The .chip modifier per tone (outline and text in the tone colour, no fill), shared by toneChip and chips that need extra attributes. */
export const TONE_CLASS: Record<string, string> = {
  ok: 'ok',
  bad: 'bad',
  warn: 'warn',
  info: 'info',
  ink: 'ink',
  muted: 'muted',
  live: 'live',
  rev: 'rev',
};
export const toneChip = (tone: string, text: unknown): string => `<span class="chip ${TONE_CLASS[tone]}">${esc(text)}</span>`;
/** fetch that throws the response text (or status text) on a non-2xx and parses JSON bodies. */
export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const type = res.headers.get('content-type') ?? '';
  return type.includes('json') ? res.json() : (res.text() as Promise<T>);
}
/** The `error` of a JSON error body, else the raw text: for replies that may be ApiError or text/plain. */
export function errorText(raw: string): string {
  try {
    const body = JSON.parse(raw);
    if (body && typeof body.error === 'string') return body.error;
  } catch {}
  return raw;
}
