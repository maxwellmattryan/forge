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
export const pct = (x: number | null | undefined): string => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const tokensShort = (n: number | null | undefined): string => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const dur = (ms: number | null | undefined): string => {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s}s`;
};
/** Chip colours per tone, shared by toneChip and chips that need extra attributes. */
export const TONE_CLASS: Record<string, string> = {
  ok: 'bg-ok/15 text-ok',
  bad: 'bg-bad/15 text-bad',
  warn: 'bg-warn/15 text-warn',
  info: 'bg-info/15 text-info',
  accent: 'bg-accent/15 text-accent',
  muted: 'bg-raised text-muted',
};
export const toneChip = (tone: string, text: unknown): string => `<span class="chip ${TONE_CLASS[tone]}">${esc(text)}</span>`;
/** fetch that throws the response text (or status text) on a non-2xx and parses JSON bodies. */
export async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const type = res.headers.get('content-type') ?? '';
  return type.includes('json') ? res.json() : (res.text() as Promise<T>);
}
