// Human output mode (docs/CLI.md "Output mode"): the generic renderer for results and errors.
// Pure on purpose: callers pass whether colour is on, so tests need no TTY and no process.env.
import type { CliError } from '../types.ts';

/** Colour only on a terminal, and never when NO_COLOR is set to anything (https://no-color.org). */
export function colorEnabled(isTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return isTTY && !env.NO_COLOR;
}

export type Style = (s: string) => string;

export type Paint = { bold: Style; red: Style; green: Style; yellow: Style };

/** ANSI styles, each the identity when colour is off, so callers never branch on it. */
export function paint(on: boolean): Paint {
  const sgr = (code: number): Style => (on ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s);
  return { bold: sgr(1), red: sgr(31), green: sgr(32), yellow: sgr(33) };
}

const hex = (c: string, width: number): string => c.charCodeAt(0).toString(16).padStart(width, '0');

/**
 * Rendered text can come from tracker issues, PR comments and agent-written job state, so every
 * control a terminal acts on is shown as a visible escape: OSC 52 clipboard writes, title changes,
 * cursor moves and carriage returns could otherwise hide or forge lines. Only `\n` survives.
 * The set matches the title sanitising in lib/notify.ts, which deletes rather than escapes.
 */
export function sanitize(s: string): string {
  return s.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (c) => `\\x${hex(c, 2)}`).replace(/[\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, (c) => `\\u${hex(c, 4)}`);
}

type Scalar = string | number | boolean | null | undefined;
/** A piece of an output line: its plain text and the style it is painted with, if any. */
export type Seg = { text: string; style?: Style };

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is Scalar => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);

/** One value as a segment: object values, table cells and items of a plain list. */
export function cell(v: unknown, p: Paint): Seg {
  if (v === null || v === undefined) return { text: '-' };
  if (typeof v === 'string') return { text: sanitize(v) };
  if (typeof v === 'boolean') return { text: String(v), style: v ? p.green : p.red };
  if (typeof v === 'number') return { text: String(v) };
  if (Array.isArray(v) && !v.length) return { text: '-' };
  if (isPlainObject(v) && !Object.keys(v).length) return { text: '-' };
  if (Array.isArray(v) && v.every(isScalar)) return { text: v.map((x) => cell(x, p).text).join(', ') };
  // Nothing is hidden or truncated: a person sees everything --json would show, on one line.
  return { text: sanitize(JSON.stringify(v) ?? String(v)) };
}

/** Right-trims a line on its plain text, so colour never changes where a line ends. */
export function line(segs: Seg[]): string {
  const kept = [...segs];
  while (kept.length) {
    const last = kept[kept.length - 1];
    const text = last.text.trimEnd();
    if (text) {
      kept[kept.length - 1] = { ...last, text };
      break;
    }
    kept.pop();
  }
  return kept.map((s) => (s.style ? s.style(s.text) : s.text)).join('');
}

export const pad = (text: string, width: number): Seg => ({ text: ' '.repeat(Math.max(0, width - text.length)) });

function renderObject(o: Record<string, unknown>, p: Paint): string {
  const keys = Object.keys(o);
  if (!keys.length) return '(empty)';
  // A newline in a key would break the aligned layout, so it becomes a space as in table cells.
  const names = keys.map((k) => sanitize(k).replace(/\n/g, ' '));
  const w = Math.max(...names.map((k) => k.length));
  return keys
    .map((k, i) => {
      const v = cell(o[k], p);
      // Later lines of a multi-line string start under the value column.
      const text = v.text.split('\n').join('\n' + ' '.repeat(w + 2));
      return line([{ text: names[i], style: p.bold }, pad(names[i], w + 2), { ...v, text }]);
    })
    .join('\n');
}

export function renderTable(rows: Record<string, unknown>[], p: Paint): string {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const header = cols.map((k): Seg => ({ text: sanitize(k), style: p.bold }));
  const body = rows.map((r) => cols.map((k) => {
    const c = cell(r[k], p);
    return { ...c, text: c.text.replace(/\n/g, ' ') };
  }));
  const widths = cols.map((_, i) => Math.max(header[i].text.length, ...body.map((b) => b[i].text.length)));
  const fmt = (cells: Seg[]): string => line(cells.flatMap((c, i) => (i === cells.length - 1 ? [c] : [c, pad(c.text, widths[i] + 2)])));
  return [header, ...body].map(fmt).join('\n');
}

/** A result for a person at a terminal (docs/CLI.md "Output mode"), with no trailing newline. */
export function render(data: unknown, opts: { color: boolean }): string {
  const p = paint(opts.color);
  // Raw like agent mode, so help, tables and `$(forge worktree path …)` match in both modes.
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    if (!data.length) return '(none)';
    if (data.every(isPlainObject)) return renderTable(data, p);
    return data.map((v) => line([cell(v, p)])).join('\n');
  }
  if (isPlainObject(data)) return renderObject(data, p);
  return line([cell(data, p)]);
}

/**
 * Later lines of a message start under its text, so untrusted text in an error (git, gh, tracker
 * output) can never print a column-0 `fix:` line that passes for Forge's own hint.
 */
const hanging = (s: string, label: string): string => sanitize(s).split('\n').join('\n' + ' '.repeat(label.length + 1));

/** A failed call in human mode: `error: <message>`, then `fix: <hint>` when there is one. */
export function renderError(e: CliError, opts: { color: boolean }): string {
  const p = paint(opts.color);
  const fix = e.hint ? `${p.yellow('fix:')} ${hanging(e.hint, 'fix:')}\n` : '';
  return `${p.bold(p.red('error:'))} ${hanging(e.message, 'error:')}\n${fix}`;
}
