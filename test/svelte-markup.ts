// Bracket- and string-aware scanning of Svelte markup, shared by the static dashboard guards
// (dashboard-svelte.test.ts, dashboard-i18n.test.ts). Not a test file: node --test never runs it.

// A regex can't tell where `{md(x) + raw}` ends or that `onclick={() => …}` doesn't close a tag, so the guards below
// scan brackets, strings and template literals. Anything they can't parse is reported, never skipped.
export const CLOSE = { '{': '}', '(': ')', '[': ']' };
/** Index of the character closing the bracket group, string or template literal opened at `i`; -1 if it never closes. */
export function endOf(/** @type {string} */ text, /** @type {number} */ i) {
  const open = text[i];
  if (open === '"' || open === "'") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === open) return j;
    }
    return -1;
  }
  if (open === '`') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++;
      else if (text[j] === '`') return j;
      else if (text[j] === '$' && text[j + 1] === '{' && (j = endOf(text, j + 1)) < 0) return -1;
    }
    return -1;
  }
  const close = CLOSE[/** @type {keyof typeof CLOSE} */ (open)];
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === close) return j;
    if (c in CLOSE || c === '"' || c === "'" || c === '`') {
      if ((j = endOf(text, j)) < 0) return -1;
    } else if (c === ')' || c === ']' || c === '}') return -1;
  }
  return -1;
}

/** The callee when `expr` is exactly one call `name(…)` with nothing before or after it, otherwise null. */
export function soleCall(/** @type {string} */ expr) {
  const e = expr.trim();
  const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
  return m && endOf(e, m[0].length - 1) === e.length - 1 ? m[1] : null;
}

/**
 * Opening tags of a component's markup with their attributes. `<script>` and comments are dropped, and top-level
 * `{…}` blocks are skipped whole, so `a < b` in an expression is never read as a tag.
 * @param {string} file @param {string} text
 */
export function tags(file, text) {
  const s = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const unclosed = (/** @type {number} */ at) => new Error(`${file}: cannot parse markup near ${JSON.stringify(s.slice(at, at + 60))}`);
  /** @type {{ name: string, attrs: { name?: string, value?: string, spread?: string }[] }[]} */
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '{') {
      const end = endOf(s, i);
      if (end < 0) throw unclosed(i);
      i = end + 1;
      continue;
    }
    const open = s[i] === '<' && /^<([A-Za-z][\w:.-]*)/.exec(s.slice(i));
    if (!open) { i++; continue; }
    /** @type {{ name: string, attrs: { name?: string, value?: string, spread?: string }[] }} */
    const tag = { name: open[1], attrs: [] };
    let j = i + open[0].length;
    for (;;) {
      while (/\s/.test(s[j] ?? '')) j++;
      if (j >= s.length) throw unclosed(i);
      if (s[j] === '>' || s.startsWith('/>', j)) break;
      if (s[j] === '{') {
        const end = endOf(s, j);
        if (end < 0) throw unclosed(j);
        const expr = s.slice(j + 1, end).trim();
        // `{...props}` spreads; `{href}` is shorthand for href={href}.
        tag.attrs.push(expr.startsWith('...') ? { spread: expr } : { name: expr, value: `{${expr}}` });
        j = end + 1;
        continue;
      }
      const name = /^[^\s=/>{"']+/.exec(s.slice(j))?.[0];
      if (!name) { j++; continue; }
      j += name.length;
      while (/\s/.test(s[j] ?? '')) j++;
      if (s[j] !== '=') { tag.attrs.push({ name }); continue; }
      j++;
      while (/\s/.test(s[j] ?? '')) j++;
      const from = j;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j++];
        while (j < s.length && s[j] !== q) j = s[j] === '{' ? endOf(s, j) + 1 || s.length : j + 1;
        if (j >= s.length) throw unclosed(from);
        j++;
      } else {
        while (j < s.length && !/[\s>]/.test(s[j])) j = s[j] === '{' ? endOf(s, j) + 1 || s.length : j + 1;
      }
      tag.attrs.push({ name, value: s.slice(from, j) });
    }
    out.push(tag);
    i = j;
  }
  return out;
}

/** Index just past the tag that opens at `i` (`<x …>` or `</x>`), skipping quoted values and `{…}` in attributes. */
function tagEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '>') return j + 1;
    if (c === '{' || c === '"' || c === "'") {
      const end = c === '{' ? endOf(s, j) : s.indexOf(c, j + 1);
      if (end < 0) return -1;
      j = end;
    }
  }
  return -1;
}

/**
 * A component's markup split into text runs (outside tags and `{…}`) and the top-level `{…}`
 * expressions in text position (block tags such as `{#if …}` included, attributes excluded).
 * `<script>` and comments are dropped first.
 */
export function markup(file: string, text: string): { texts: string[]; exprs: string[] } {
  const s = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const texts: string[] = [];
  const exprs: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf) texts.push(buf);
    buf = '';
  };
  for (let i = 0; i < s.length; ) {
    if (s[i] === '{') {
      flush();
      const end = endOf(s, i);
      if (end < 0) throw new Error(`${file}: cannot parse markup near ${JSON.stringify(s.slice(i, i + 60))}`);
      exprs.push(s.slice(i + 1, end));
      i = end + 1;
    } else if (s[i] === '<' && /^<\/?[A-Za-z]/.test(s.slice(i, i + 3))) {
      flush();
      const end = tagEnd(s, i);
      if (end < 0) throw new Error(`${file}: cannot parse tag near ${JSON.stringify(s.slice(i, i + 60))}`);
      i = end;
    } else buf += s[i++];
  }
  flush();
  return { texts, exprs };
}

/**
 * String and template literals in an expression, with what precedes and follows each. A template
 * literal's `${…}` parts are dropped, so only its fixed text is returned.
 */
export function literals(expr: string): { value: string; before: string; after: string }[] {
  const out: { value: string; before: string; after: string }[] = [];
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c !== '"' && c !== "'" && c !== '`') continue;
    const end = endOf(expr, i);
    if (end < 0) break;
    let value = expr.slice(i + 1, end);
    if (c === '`') {
      let fixed = '';
      for (let j = 0; j < value.length; j++) {
        if (value[j] === '$' && value[j + 1] === '{') {
          const close = endOf(value, j + 1);
          if (close < 0) break;
          j = close;
        } else fixed += value[j];
      }
      value = fixed;
    }
    out.push({ value, before: expr.slice(0, i), after: expr.slice(end + 1) });
    i = end;
  }
  return out;
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
type Attr = { name?: string; value?: string; spread?: string };
export type Placed = { name: string; attrs: Attr[]; ancestors: Placed[] };

/**
 * Every opening element of a component's markup with its ancestors, nearest first. `<script>`, `<style>` and
 * comments are dropped and `{…}` is skipped as in `tags()`. Components and `svelte:*` tags count as elements;
 * void elements and `/>` open nothing. An unbalanced close throws.
 */
export function ancestry(file: string, text: string): Placed[] {
  const s = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const out: Placed[] = [];
  const stack: Placed[] = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === '{') {
      const end = endOf(s, i);
      if (end < 0) throw new Error(`${file}: cannot parse markup near ${JSON.stringify(s.slice(i, i + 60))}`);
      i = end + 1;
      continue;
    }
    const m = s[i] === '<' ? /^<(\/?)([A-Za-z][\w:.-]*)/.exec(s.slice(i, i + 80)) : null;
    if (!m) {
      i++;
      continue;
    }
    const end = tagEnd(s, i);
    if (end < 0) throw new Error(`${file}: cannot parse tag near ${JSON.stringify(s.slice(i, i + 60))}`);
    const raw = s.slice(i, end);
    i = end;
    if (m[1]) {
      const at = stack.map((e) => e.name).lastIndexOf(m[2]);
      if (at < 0) throw new Error(`${file}: </${m[2]}> closes nothing`);
      stack.length = at;
      continue;
    }
    const el: Placed = { name: m[2], attrs: tags(file, raw)[0]?.attrs ?? [], ancestors: [...stack].reverse() };
    out.push(el);
    if (!raw.endsWith('/>') && !VOID_ELEMENTS.has(m[2])) stack.push(el);
  }
  return out;
}
