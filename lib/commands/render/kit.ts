// Shared pieces of the hand-written human-mode renderers (docs/CLI.md "Output mode").
// Every string that comes from a result goes through sanitize here, and every line a section holds
// is indented, so untrusted text can't drive the terminal or forge a column-0 line of Forge's own.
import { paint, sanitize } from '../../core/format/ansi.ts';
import type { Paint, Style } from '../../core/format/ansi.ts';
import { isMap } from '../../core/shape.ts';
import { line, pad } from '../render.ts';
import type { Seg } from '../render.ts';

export type { Paint, Seg };
export { line, paint };

/** What a renderer is told: colour, the clock for relative ages, and whether `--all` was given. */
export interface RenderOpts {
  color: boolean;
  now: number;
  all?: boolean;
}

/** A hand-written renderer: text for a result it recognises, null for any other shape. */
export type Renderer = (data: unknown, opts: RenderOpts) => string | null;

/** A value a renderer prints: strings are sanitised here, a Seg's text is already safe. */
export type Val = string | number | boolean | null | undefined | Seg | Seg[];

const isSeg = (v: unknown): v is Seg => isMap(v) && typeof v.text === 'string';

/** Untrusted text on one line: sanitised, newlines turned into spaces, `-` for null. */
export function txt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '-';
  return sanitize(String(v)).replace(/\n/g, ' ');
}

/** Untrusted text whose later lines start `indent` columns in, as renderError's hanging does. */
export function hang(text: string, indent: number): string {
  return sanitize(text).split('\n').join('\n' + ' '.repeat(indent));
}

/** Untrusted text as a block nested `indent` columns under the line before it. */
export function under(text: string, indent = 2): string {
  return sanitize(text.replace(/^(?:[ \t]*\n)+/, '').trimEnd())
    .split('\n')
    .map((l) => (l.trim() ? ' '.repeat(indent) + l.trimEnd() : ''))
    .join('\n');
}

function segs(v: Val): Seg[] {
  if (Array.isArray(v)) return v;
  if (isSeg(v)) return [v];
  if (v === null || v === undefined || v === '') return [{ text: '-' }];
  return [{ text: typeof v === 'string' ? sanitize(v) : String(v) }];
}

const plainLen = (s: Seg[]): number => s.reduce((n, x) => n + x.text.length, 0);

/** Aligned `label  value` lines; a multi-line value's later lines start under the value column. */
export function fields(pairs: [string, Val][], p: Paint): string[] {
  const w = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => {
    const value = segs(v).map((s) => ({ ...s, text: s.text.split('\n').join('\n' + ' '.repeat(w + 2)) }));
    return line([{ text: k, style: p.bold }, pad(k, w + 2), ...value]);
  });
}

/** A table: bold headers, columns two spaces apart, every cell on one line. */
export function table(head: string[], rows: Val[][], p: Paint): string {
  const body = rows.map((r) => r.map((c) => segs(c).map((s) => ({ ...s, text: s.text.replace(/\n/g, ' ') }))));
  const header = head.map((h): Seg[] => [{ text: h, style: p.bold }]);
  const widths = head.map((_, i) => Math.max(plainLen(header[i]), ...body.map((b) => plainLen(b[i] ?? []))));
  const gap = (c: Seg[], w: number): Seg => ({ text: ' '.repeat(Math.max(0, w - plainLen(c))) });
  const fmt = (cells: Seg[][]): string => line(cells.flatMap((c, i) => (i === cells.length - 1 ? c : [...c, gap(c, widths[i] + 2)])));
  return [header, ...body].map(fmt).join('\n');
}

/** A heading in bold on its own line, its body two spaces in; null when the body is empty. */
export function section(title: string, lines: (string | null | undefined | false)[], p: Paint): string | null {
  const kept = lines.filter((l): l is string => typeof l === 'string');
  if (!kept.length) return null;
  const body = kept.flatMap((l) => l.split('\n')).map((l) => (l ? `  ${l}` : ''));
  return [p.bold(title), ...body].join('\n');
}

/** A result's parts, one blank line apart, leaving out the empty ones. */
export function blocks(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((x): x is string => typeof x === 'string' && x !== '').join('\n\n');
}

/** ✓ green for ok, ✗ red for failed, ! yellow for a warning, - plain for skipped. */
export function mark(kind: boolean | 'warn' | 'skip', p: Paint): Seg {
  if (kind === 'warn') return { text: '!', style: p.yellow };
  if (kind === 'skip') return { text: '-' };
  return kind ? { text: '✓', style: p.green } : { text: '✗', style: p.red };
}

/** A mark and its label as one line: `✓ name`. */
export function marked(kind: boolean | 'warn' | 'skip', rest: Seg[], p: Paint): string {
  return line([mark(kind, p), { text: ' ' }, ...rest]);
}

/** createdAt relative to now: `<1m`, `5m`, `3h`, `2d`, or `-` when it doesn't parse. */
export function age(iso: unknown, now: number): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '-';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / (60 * 24))}d`;
}

/** A job state's colour: running green, waiting and blocked yellow, failed red. */
function stateStyle(state: unknown, p: Paint): Style | undefined {
  const s = String(state ?? '');
  if (s === 'running') return p.green;
  if (s === 'waiting' || s.startsWith('waiting:') || s === 'blocked') return p.yellow;
  if (s === 'failed') return p.red;
  return undefined;
}

/** A job's state as a cell: `waiting:<on>` when waiting, coloured by stateStyle. */
export function stateSeg(state: unknown, waitingOn: unknown, p: Paint): Seg {
  const text = state === 'waiting' ? `waiting:${txt(waitingOn)}` : txt(state);
  return { text, style: stateStyle(state, p) };
}

/** `ms` below a second, else one decimal of `s`. */
export function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `<name> <port>` pairs, comma separated. */
export function ports(v: unknown): string {
  if (!isMap(v) || !Object.keys(v).length) return '-';
  return Object.entries(v).map(([k, n]) => `${txt(k)} ${txt(n)}`).join(', ');
}

/** A list of untrusted names, comma separated, `-` when empty. */
export function list(v: unknown): string {
  return Array.isArray(v) && v.length ? v.map(txt).join(', ') : '-';
}

export const short = (v: unknown, n: number): string => (typeof v === 'string' && v ? txt(v.slice(0, n)) : '-');

export const has = (v: unknown, ...keys: string[]): v is Record<string, any> => isMap(v) && keys.every((k) => k in v);
