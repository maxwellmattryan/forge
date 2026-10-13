// A deliberately small YAML subset so Forge stays zero-dependency.
// Supported: block maps, block sequences (including "- key: value" maps), scalars,
// single/double-quoted strings, flow [] and {} collections, "|" and ">" block scalars,
// comments. Not supported: anchors/aliases, tags, multi-document streams, complex keys.
// Anything outside the subset fails loudly with a line number rather than misparsing.

import type { ConfigValue } from './types.ts';

export class YamlError extends Error {
  // `declare` keeps this a type only: a plain field would become a runtime class field and show up in Object.keys.
  declare line: number | undefined;
  constructor(message: string, line?: number) {
    super(line ? `YAML line ${line}: ${message}` : `YAML: ${message}`);
    this.line = line;
  }
}

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#{\[\]},&*!|>%@`-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

interface Line {
  indent: number;
  text: string;
  line: number;
  raw: string;
}

interface BlockState {
  lines: Line[];
  i: number;
}

interface FlowState {
  t: string;
  i: number;
  line: number;
}

export function parse(src: string): any {
  const lines: Line[] = [];
  src.replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) return;
    if (/\t/.test(raw.match(/^\s*/)?.[0] ?? '')) throw new YamlError('tabs are not allowed for indentation', idx + 1);
    const text = stripComment(raw);
    if (!text.trim()) {
      lines.push({ indent: -1, text: '', line: idx + 1, raw });
      return;
    }
    const indent = text.length - text.trimStart().length;
    lines.push({ indent, text: text.trim(), line: idx + 1, raw });
  });
  const state = { lines, i: 0 };
  skipBlank(state);
  if (state.i >= lines.length) return null;
  const value = parseBlock(state, lines[state.i].indent);
  skipBlank(state);
  if (state.i < lines.length) throw new YamlError('unexpected content (check indentation)', lines[state.i].line);
  return value;
}

function skipBlank(s: BlockState): void {
  while (s.i < s.lines.length && s.lines[s.i].indent === -1) s.i++;
}

function parseBlock(s: BlockState, indent: number): any {
  const first = s.lines[s.i];
  return first.text === '-' || first.text.startsWith('- ') ? parseSeq(s, indent) : parseMap(s, indent);
}

function parseSeq(s: BlockState, indent: number): any[] {
  const out: any[] = [];
  while (true) {
    skipBlank(s);
    const ln = s.lines[s.i];
    if (!ln || ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlError('bad indentation in sequence', ln.line);
    if (!(ln.text === '-' || ln.text.startsWith('- '))) break;
    const rest = ln.text === '-' ? '' : ln.text.slice(2).trimStart();
    if (!rest) {
      s.i++;
      skipBlank(s);
      const next = s.lines[s.i];
      if (next && next.indent > indent) out.push(parseBlock(s, next.indent));
      else out.push(null);
    } else if (isMapEntry(rest) || rest === '-' || rest.startsWith('- ')) {
      const inner = indent + (ln.text.length - rest.length);
      s.lines[s.i] = { ...ln, indent: inner, text: rest };
      out.push(parseBlock(s, inner));
    } else {
      s.i++;
      out.push(scalarOrBlockText(s, rest, indent, ln.line));
    }
  }
  return out;
}

function isMapEntry(text: string): boolean {
  if (text.startsWith('[') || text.startsWith('{')) return false;
  return KEY_RE.test(text);
}

function parseMap(s: BlockState, indent: number): Record<string, any> {
  const out: Record<string, any> = {};
  while (true) {
    skipBlank(s);
    const ln = s.lines[s.i];
    if (!ln || ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlError('bad indentation in mapping', ln.line);
    if (ln.text === '-' || ln.text.startsWith('- ')) break;
    const m = ln.text.match(KEY_RE);
    if (!m) throw new YamlError(`expected "key: value", got "${ln.text}"`, ln.line);
    const key = unquoteKey(m[1].trim());
    const rest = (m[2] ?? '').trim();
    s.i++;
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, ln.line);
    if (!rest) {
      skipBlank(s);
      const next = s.lines[s.i];
      if (next && next.indent > indent) out[key] = parseBlock(s, next.indent);
      else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- ')))
        out[key] = parseSeq(s, indent);
      else out[key] = null;
    } else {
      out[key] = scalarOrBlockText(s, rest, indent, ln.line);
    }
  }
  return out;
}

function unquoteKey(k: string): string {
  if (k.startsWith('"') || k.startsWith("'")) return parseScalar(k, 0) as string;
  return k;
}

function scalarOrBlockText(s: BlockState, rest: string, indent: number, line: number): any {
  const block = rest.match(/^([|>])([+-]?)$/);
  if (!block) return parseScalar(rest, line);
  const collected: string[] = [];
  let blockIndent = -1;
  while (s.i < s.lines.length) {
    const ln = s.lines[s.i];
    const rawIndent = ln.raw.length - ln.raw.trimStart().length;
    if (ln.raw.trim() && rawIndent <= indent) break;
    if (ln.raw.trim() && blockIndent === -1) blockIndent = rawIndent;
    collected.push(ln.raw.trim() ? ln.raw.slice(blockIndent) : '');
    s.i++;
  }
  while (collected.length && collected[collected.length - 1] === '') collected.pop();
  const chomp = block[2];
  let text = block[1] === '|' ? collected.join('\n') : collected.join('\n').replace(/([^\n])\n(?!\n)/g, '$1 ');
  if (chomp !== '-') text += '\n';
  return text;
}

export function parseScalar(t: string, line: number): any {
  t = t.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const p: FlowState = { t, i: 0, line };
    const v = parseFlow(p);
    if (p.t.slice(p.i).trim()) throw new YamlError('trailing characters after flow collection', line);
    return v;
  }
  if (t.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(t)) throw new YamlError(`unterminated string ${t}`, line);
    return JSON.parse(t.replace(/\\'/g, "'"));
  }
  if (t.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(t)) throw new YamlError(`unterminated string ${t}`, line);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!]/.test(t)) throw new YamlError('anchors, aliases and tags are not supported', line);
  if (t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?\d+$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

function parseFlow(p: FlowState): any {
  ws(p);
  const c = p.t[p.i];
  if (c === '[') {
    p.i++;
    const out: any[] = [];
    ws(p);
    if (p.t[p.i] === ']') { p.i++; return out; }
    while (true) {
      out.push(parseFlow(p));
      ws(p);
      if (p.t[p.i] === ',') { p.i++; ws(p); if (p.t[p.i] === ']') { p.i++; return out; } continue; }
      if (p.t[p.i] === ']') { p.i++; return out; }
      throw new YamlError('expected , or ] in flow sequence', p.line);
    }
  }
  if (c === '{') {
    p.i++;
    const out: Record<string, any> = {};
    ws(p);
    if (p.t[p.i] === '}') { p.i++; return out; }
    while (true) {
      const key = flowAtom(p, true);
      ws(p);
      if (p.t[p.i] !== ':') throw new YamlError('expected : in flow mapping', p.line);
      p.i++;
      out[String(key)] = parseFlow(p);
      ws(p);
      if (p.t[p.i] === ',') { p.i++; ws(p); if (p.t[p.i] === '}') { p.i++; return out; } continue; }
      if (p.t[p.i] === '}') { p.i++; return out; }
      throw new YamlError('expected , or } in flow mapping', p.line);
    }
  }
  return flowAtom(p, false);
}

function flowAtom(p: FlowState, isKey: boolean): any {
  ws(p);
  const start = p.i;
  const q = p.t[p.i];
  if (q === '"' || q === "'") {
    p.i++;
    while (p.i < p.t.length) {
      if (q === '"' && p.t[p.i] === '\\') { p.i += 2; continue; }
      if (p.t[p.i] === q) {
        if (q === "'" && p.t[p.i + 1] === "'") { p.i += 2; continue; }
        break;
      }
      p.i++;
    }
    p.i++;
    return parseScalar(p.t.slice(start, p.i), p.line);
  }
  if (q === '[' || q === '{') return parseFlow(p);
  const stop = isKey ? /[:,}\]]/ : /[,}\]]/;
  while (p.i < p.t.length && !stop.test(p.t[p.i])) p.i++;
  return parseScalar(p.t.slice(start, p.i), p.line);
}

function ws(p: FlowState): void {
  while (p.i < p.t.length && /\s/.test(p.t[p.i])) p.i++;
}

function needsQuote(v: any): boolean {
  if (v === '') return true;
  if (/^[\s]|[\s]$/.test(v)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`~]/.test(v)) return true;
  if (/: |\s#|\n/.test(v) || v.endsWith(':')) return true;
  if (/^(true|false|null|yes|no|on|off)$/i.test(v)) return true;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return true;
  return false;
}

function scalarOut(v: any): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const str = String(v);
  return needsQuote(str) ? JSON.stringify(str) : str;
}

export function stringify(value: any, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return '[]\n';
    return value
      .map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) {
          const body = stringify(item, indent + 2);
          return `${pad}- ${body.slice(indent + 2)}`;
        }
        if (Array.isArray(item) && item.length) return `${pad}-\n${stringify(item, indent + 2)}`;
        return `${pad}- ${inline(item)}\n`;
      })
      .join('');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}\n';
    return keys
      .map((k) => {
        const v = value[k];
        const key = needsQuote(k) ? JSON.stringify(k) : k;
        if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length))
          return `${pad}${key}:\n${stringify(v, indent + 2)}`;
        if (typeof v === 'string' && v.includes('\n')) {
          const body = v.replace(/\n$/, '').split('\n').map((l) => (l ? `${pad}  ${l}` : '')).join('\n');
          return `${pad}${key}: |${v.endsWith('\n') ? '' : '-'}\n${body}\n`;
        }
        return `${pad}${key}: ${inline(v)}\n`;
      })
      .join('');
  }
  return `${pad}${scalarOut(value)}\n`;
}

function inline(v: any): string {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return keys.length ? `{ ${keys.map((k) => `${k}: ${inline(v[k])}`).join(', ')} }` : '{}';
  }
  return scalarOut(v);
}

// ---------- setIn: one-value edits that keep the rest of the text ----------

interface SrcLine {
  raw: string;
  /** raw without its trailing comment and trailing whitespace */
  code: string;
  /** -1 for blank and comment-only lines */
  indent: number;
}

const isDash = (l: SrcLine) => l.indent >= 0 && /^-(\s|$)/.test(l.code.trim());
const isBlockScalar = (t: string) => /^[|>][+-]?$/.test(t);

/**
 * Returns `src` with the value at `path` set to `value`, touching only the lines that hold it (or
 * inserting the missing keys), so comments, blank lines and key order survive. Whatever it can't
 * change without dropping a comment or restructuring the document throws YamlError, and so does
 * an edit that doesn't parse back to exactly the intended change.
 */
export function setIn(src: string, path: string[], value: ConfigValue): string {
  if (!path.length) throw new YamlError('setIn needs a key');
  const where = path.join('.');
  const crlf = /\r\n/.test(src);
  const raws = src.replace(/\r\n?/g, '\n').split('\n');
  const lines: SrcLine[] = raws.map((raw) => {
    const code = stripComment(raw);
    const blank = !code.trim() || /^(---|\.\.\.)$/.test(code.trim());
    return { raw, code, indent: blank ? -1 : code.length - code.trimStart().length };
  });
  const nextContent = (from: number) => {
    for (let j = from; j < lines.length; j++) if (lines[j].indent >= 0) return j;
    return -1;
  };
  const restOf = (j: number) => (lines[j].code.trim().match(KEY_RE)?.[2] ?? '').trim();
  /** The key line for `key` among the children at `ind` that start at `from`, or -1. */
  const findKey = (from: number, ind: number, key: string) => {
    for (let j = from; j < lines.length; j++) {
      const l = lines[j];
      if (l.indent < 0 || l.indent > ind) continue;
      if (l.indent < ind) break;
      if (isDash(l)) continue; // a same-indent sequence: the previous key's value
      const m = l.code.trim().match(KEY_RE);
      if (!m) throw new YamlError(`expected "key: value", got "${l.code.trim()}"`, j + 1);
      if (unquoteKey(m[1].trim()) === key) return j;
    }
    return -1;
  };

  let out: string[] | null = null;
  const top = nextContent(0);
  if (top !== -1 && isDash(lines[top])) throw new YamlError('the document is a sequence, not a map', top + 1);
  // The map being searched: its children start at `from` at indent `ind`; `header` is its key line.
  let from = top === -1 ? lines.length : top;
  let ind = top === -1 ? 0 : lines[top].indent;
  let header = -1;
  let depth = 0;
  for (; depth < path.length; depth++) {
    const k = findKey(from, ind, path[depth]);
    if (k === -1) break;
    if (depth === path.length - 1) {
      out = replaceValue(k);
      break;
    }
    const name = path.slice(0, depth + 1).join('.');
    const rest = restOf(k);
    if (rest.startsWith('{')) throw new YamlError(`${name} is a flow map; edit it by hand`, k + 1);
    if (rest) throw new YamlError(`${name} is a scalar, not a map`, k + 1);
    const n = nextContent(k + 1);
    if (n !== -1 && isDash(lines[n]) && lines[n].indent >= lines[k].indent) throw new YamlError(`${name} is a sequence; edit it by hand`, k + 1);
    header = k;
    if (n === -1 || lines[n].indent <= lines[k].indent) {
      // `key:` with a null value: the rest of the path goes under it.
      from = k + 1;
      ind = lines[k].indent + 2;
      depth++;
      break;
    }
    from = n;
    ind = lines[n].indent;
  }

  if (!out) {
    let at: number;
    if (header === -1) {
      at = raws.length && raws[raws.length - 1] === '' ? raws.length - 1 : raws.length;
    } else {
      at = header;
      for (let j = from; j < lines.length; j++) {
        if (lines[j].indent < 0) continue;
        if (lines[j].indent < ind) break;
        at = j;
      }
      at++;
    }
    const add: string[] = [];
    for (let k = depth; k < path.length; k++) {
      const pad = ' '.repeat(ind + (k - depth) * 2);
      const key = needsQuote(path[k]) ? JSON.stringify(path[k]) : path[k];
      add.push(k === path.length - 1 ? `${pad}${key}: ${flowOut(value)}` : `${pad}${key}:`);
    }
    out = [...raws.slice(0, at), ...add, ...raws.slice(at)];
  }

  function replaceValue(k: number): string[] {
    const l = lines[k];
    const rest = restOf(k);
    const next = raws.slice();
    const onKeyLine = () => l.code + ' ' + flowOut(value) + l.raw.slice(l.code.length);
    if (rest) {
      if (isBlockScalar(rest)) throw new YamlError(`${where} is a block scalar; edit it by hand`, k + 1);
      if (rest.startsWith('{')) throw new YamlError(`${where} is a map; edit it by hand`, k + 1);
      // `code` is a prefix of `raw`, so the value ends where `code` does and a trailing comment stays.
      const end = l.code.length;
      next[k] = l.raw.slice(0, end - rest.length) + flowOut(value) + l.raw.slice(end);
      return next;
    }
    const n = nextContent(k + 1);
    const child = n === -1 ? null : lines[n];
    const seq = child !== null && isDash(child) && child.indent >= l.indent;
    if (child && !seq && child.indent > l.indent) throw new YamlError(`${where} is a map; edit it by hand`, k + 1);
    if (!seq) {
      next[k] = onKeyLine();
      return next;
    }
    const dash = lines[n].indent;
    let last = n;
    for (let j = n; j < lines.length; j++) {
      const it = lines[j];
      if (it.indent < 0) {
        const after = nextContent(j + 1);
        if (it.raw.trim() && after !== -1 && lines[after].indent === dash && isDash(lines[after]))
          throw new YamlError(`${where} has a comment between its items; edit it by hand`, j + 1);
        continue;
      }
      if (it.indent < dash || (it.indent === dash && !isDash(it))) break;
      if (it.indent > dash) throw new YamlError(`${where} has items that span lines; edit it by hand`, j + 1);
      const item = it.code.trim().replace(/^-\s*/, '');
      if (!item || isMapEntry(item) || /^-(\s|$)/.test(item) || isBlockScalar(item))
        throw new YamlError(`${where} has items that aren't one-line scalars; edit it by hand`, j + 1);
      if (it.raw.trimEnd() !== it.code) throw new YamlError(`${where} has a comment on an item; edit it by hand`, j + 1);
      last = j;
    }
    if (Array.isArray(value) && value.length) {
      const pad = ' '.repeat(dash);
      return [...next.slice(0, n), ...value.map((v) => `${pad}- ${scalarOut(v)}`), ...next.slice(last + 1)];
    }
    next[k] = onKeyLine();
    return [...next.slice(0, n), ...next.slice(last + 1)];
  }

  const text = out.join('\n');
  const result = crlf ? text.replace(/\n/g, '\r\n') : text;
  selfCheck(src, result, path, value);
  return result;
}

/** A scalar as `stringify` writes it, or a list as `[a, b]` with items that would break it double-quoted. */
function flowOut(v: ConfigValue): string {
  if (Array.isArray(v)) return `[${v.map((x) => (/[,\[\]{}]/.test(String(x)) ? JSON.stringify(String(x)) : scalarOut(x))).join(', ')}]`;
  return scalarOut(v);
}

/** The edit must set exactly `path` and leave every other key as it parsed before. */
function selfCheck(before: string, after: string, path: string[], value: ConfigValue): void {
  const where = path.join('.');
  let old: any;
  let neu: any;
  try {
    old = parse(before) ?? {};
    neu = parse(after) ?? {};
  } catch (e) {
    throw new YamlError(`editing ${where} would leave the file unparseable (${(e as Error).message})`);
  }
  const at = (o: any, p: string[]) => p.reduce((x, k) => (x && typeof x === 'object' && !Array.isArray(x) ? x[k] : undefined), o);
  if (JSON.stringify(at(neu, path)) !== JSON.stringify(value)) throw new YamlError(`editing ${where} did not produce the intended value`);
  delete at(old, path.slice(0, -1))?.[path[path.length - 1]];
  delete at(neu, path.slice(0, -1))?.[path[path.length - 1]];
  // Ancestors the insertion created (or turned from null into a map) go too, deepest first.
  for (let n = path.length - 1; n >= 1; n--) {
    const was = at(old, path.slice(0, n));
    const now = at(neu, path.slice(0, n));
    if (!now || typeof now !== 'object' || Array.isArray(now) || Object.keys(now).length) break;
    const parent = at(neu, path.slice(0, n - 1));
    if (was === undefined) delete parent[path[n - 1]];
    else if (was === null) parent[path[n - 1]] = null;
  }
  if (JSON.stringify(old) !== JSON.stringify(neu)) throw new YamlError(`editing ${where} would change other keys`);
}
