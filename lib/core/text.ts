// Small text helpers: redaction, safe refs and outside text, slugs, CLI value coercion, shell words,
// templates, fences and tails.
import { ForgeError } from './errors.ts';

export const REDACTED = '[redacted]';

/** `text` with every secret replaced by `[redacted]`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join(REDACTED);
  return out;
}

/**
 * A branch or job name that is safe as one shell word and as a git argument: no metacharacters,
 * no whitespace, and no leading `-` that git would read as an option.
 */
export const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** `value` when it matches SAFE_REF; otherwise a one-line ForgeError naming `field`. */
export function assertSafeRef(value: unknown, field: string): string {
  if (typeof value === 'string' && SAFE_REF.test(value)) return value;
  const shown = (JSON.stringify(value) ?? String(value)).slice(0, 80);
  throw new ForgeError(`${field} ${shown} is not a safe branch name: it must start with a letter or digit and use only A-Z a-z 0-9 . _ / - (at most 200 characters)`);
}

/**
 * Text that came from outside Forge, made safe for one markdown line: control characters,
 * Unicode line separators and backticks go, so it can't break out of its line or a code span.
 */
export function safeText(s: string, max = 200): string {
  return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, '').slice(0, max);
}

export function slugify(text: string, maxWords = 6): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, maxWords)
      .join('-')
      .slice(0, 48)
      .replace(/-+$/, '') || 'job'
  );
}

/**
 * Interprets CLI values so `--field round=2` stores a number, not "2". A `[`/`{` value that is not
 * JSON is almost always one whose quotes the shell stripped, so it fails rather than being stored
 * as a string that crashes `forge job step` later.
 */
export function coerce(v: string, key = 'value'): any {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[\[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      const bare = /^\[([^"\[\]{}]*)\]$/.exec(v);
      const suggestion = bare
        ? JSON.stringify(bare[1].split(',').map((s) => s.trim()).filter(Boolean))
        : v.startsWith('[') ? '["a","b"]' : '{"k":"v"}';
      throw new ForgeError(`--field ${key}: ${JSON.stringify(v.slice(0, 80))} is not valid JSON; quote it for the shell, e.g. --field '${key}=${suggestion}'`, 'usage');
    }
  }
  return v;
}

/**
 * Splits a command template into argv the way a POSIX shell splits words, without any of the
 * shell's other powers: whitespace separates, '…' is literal, "…" honours \" and \\.
 * `label` names the setting in errors.
 */
export function splitWords(template: string, label = 'command'): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else if (c === "'") {
      const end = template.indexOf("'", i + 1);
      if (end === -1) throw new ForgeError(`${label}: unterminated ' in ${JSON.stringify(template)}`);
      cur += template.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < template.length && template[j] !== '"'; j++) {
        if (template[j] === '\\' && (template[j + 1] === '"' || template[j + 1] === '\\')) j++;
        cur += template[j];
      }
      if (j >= template.length) throw new ForgeError(`${label}: unterminated " in ${JSON.stringify(template)}`);
      i = j;
      inWord = true;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/**
 * `forge run`'s extra arguments as shell words, each in single quotes. A quote, backslash or control
 * character is refused rather than escaped: without them a single-quoted word is literal in sh,
 * bash, zsh and fish alike (fish reads \' and \\ inside them), whatever $SHELL is.
 */
export function shellArgs(args: string[]): string {
  args.forEach((a, i) => {
    if (/['\\\x00-\x1f\x7f]/.test(a)) throw new ForgeError(`forge run: argument ${i + 1} contains a quote, backslash or control character (got ${JSON.stringify(a)})`);
  });
  return args.map((a) => `'${a}'`).join(' ');
}

export function fill(template: string, vars: Record<string, string | number>): string {
  // Dotted keys for `{endpoint.<component>}` and `{backing.<name>.port}` (lib/endpoints.ts).
  return template.replace(/\{([\w./-]+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

/** A fence longer than any backtick run inside the text, at least three, so the text can't close it. */
export function fenced(text: string, lang = 'text'): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

export function tail(text: string, n: number): string {
  const lines = text.trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}
