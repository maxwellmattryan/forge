// @ts-check
// A deliberately small YAML subset so Forge stays zero-dependency.
// Supported: block maps, block sequences (including "- key: value" maps), scalars,
// single/double-quoted strings, flow [] and {} collections, "|" and ">" block scalars,
// comments. Not supported: anchors/aliases, tags, multi-document streams, complex keys.
// Anything outside the subset fails loudly with a line number rather than misparsing.

export class YamlError extends Error {
  /** @param {string} message @param {number} [line] */
  constructor(message, line) {
    super(line ? `YAML line ${line}: ${message}` : `YAML: ${message}`);
    this.line = line;
  }
}

/** @param {string} line */
function stripComment(line) {
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

/**
 * @param {string} src
 * @returns {any}
 */
export function parse(src) {
  /** @type {{indent:number,text:string,line:number,raw:string}[]} */
  const lines = [];
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

/** @param {{lines:any[],i:number}} s */
function skipBlank(s) {
  while (s.i < s.lines.length && s.lines[s.i].indent === -1) s.i++;
}

/** @param {{lines:any[],i:number}} s @param {number} indent */
function parseBlock(s, indent) {
  const first = s.lines[s.i];
  return first.text === '-' || first.text.startsWith('- ') ? parseSeq(s, indent) : parseMap(s, indent);
}

/** @param {{lines:any[],i:number}} s @param {number} indent */
function parseSeq(s, indent) {
  const out = [];
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

/** @param {string} text */
function isMapEntry(text) {
  if (text.startsWith('[') || text.startsWith('{')) return false;
  return KEY_RE.test(text);
}

/** @param {{lines:any[],i:number}} s @param {number} indent */
function parseMap(s, indent) {
  /** @type {Record<string, any>} */
  const out = {};
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

/** @param {string} k */
function unquoteKey(k) {
  if (k.startsWith('"') || k.startsWith("'")) return /** @type {string} */ (parseScalar(k, 0));
  return k;
}

/** @param {{lines:any[],i:number}} s @param {string} rest @param {number} indent @param {number} line */
function scalarOrBlockText(s, rest, indent, line) {
  const block = rest.match(/^([|>])([+-]?)$/);
  if (!block) return parseScalar(rest, line);
  const collected = [];
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

/** @param {string} t @param {number} line @returns {any} */
export function parseScalar(t, line) {
  t = t.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const p = { t, i: 0, line };
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

/** @param {{t:string,i:number,line:number}} p @returns {any} */
function parseFlow(p) {
  ws(p);
  const c = p.t[p.i];
  if (c === '[') {
    p.i++;
    const out = [];
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
    /** @type {Record<string, any>} */
    const out = {};
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

/** @param {{t:string,i:number,line:number}} p @param {boolean} isKey */
function flowAtom(p, isKey) {
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

/** @param {{t:string,i:number}} p */
function ws(p) {
  while (p.i < p.t.length && /\s/.test(p.t[p.i])) p.i++;
}

/** @param {any} v */
function needsQuote(v) {
  if (v === '') return true;
  if (/^[\s]|[\s]$/.test(v)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`~]/.test(v)) return true;
  if (/: |\s#|\n/.test(v) || v.endsWith(':')) return true;
  if (/^(true|false|null|yes|no|on|off)$/i.test(v)) return true;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return true;
  return false;
}

/** @param {any} v */
function scalarOut(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const str = String(v);
  return needsQuote(str) ? JSON.stringify(str) : str;
}

/**
 * @param {any} value
 * @param {number} [indent]
 * @returns {string}
 */
export function stringify(value, indent = 0) {
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

/** @param {any} v */
function inline(v) {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return keys.length ? `{ ${keys.map((k) => `${k}: ${inline(v[k])}`).join(', ')} }` : '{}';
  }
  return scalarOut(v);
}
