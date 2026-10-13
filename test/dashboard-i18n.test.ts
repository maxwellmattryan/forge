// The i18n scaffold's static guard: every user-facing string in the Svelte components comes from
// dashboard/src/messages/en.json through $t('literal.key'), and every message there is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { literals, markup, tags } from './svelte-markup.ts';
import { isPlural } from '../dashboard/src/lib/i18n.ts';

const SRC = path.resolve(import.meta.dirname, '..', 'dashboard', 'src');
const EN = JSON.parse(fs.readFileSync(path.join(SRC, 'messages', 'en.json'), 'utf8'));
const svelte = fs
  .readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.svelte'))
  .sort()
  .map((f) => [f.split(path.sep).join('/'), fs.readFileSync(path.join(SRC, f), 'utf8')] as const);

/** Attributes whose value is shown to people (natively or by our components). */
const TEXT_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'text', 'msg']);
const LETTERS = /\p{L}{2,}/u;
/** A literal that reads as prose: Capitalised or several words. */
const PROSE = (s: string) => /\p{Lu}\p{Ll}/u.test(s) || /\p{L}+ +\p{L}+/u.test(s);
const COMPARED = (before: string, after: string) => /(===|!==|==|!=)\s*$/.test(before) || /^\s*(===|!==|==|!=)/.test(after);
const KEY_ARG = (before: string) => /\$t\(\s*$/.test(before);

function leaves(o: any, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || isPlural(v)) return [key];
    assert.ok(v && typeof v === 'object' && !Array.isArray(v), `${key} is a string, a plural object or a nested map`);
    assert.ok(!('other' in (v as object)), `${key} looks like a plural object but isn't one: ${JSON.stringify(v)}`);
    return leaves(v, key);
  });
}

const resolves = (key: string) => {
  const v = key.split('.').reduce((o: any, k) => (o && typeof o === 'object' && !isPlural(o) && Object.hasOwn(o, k) ? o[k] : undefined), EN);
  return typeof v === 'string' || isPlural(v);
};

test('en.json is a catalog of strings and plural objects, and every message is used', () => {
  const all = leaves(EN);
  assert.ok(all.length > 50, `${all.length} messages`);
  const used = new Set<string>();
  for (const [f, text] of svelte) {
    for (const m of text.matchAll(/\$t\(/g)) {
      const lit = /^\$t\(\s*(['"])([^'"\\]+)\1/.exec(text.slice(m.index));
      assert.ok(lit, `${f}: $t( needs a string-literal key: ${text.slice(m.index, m.index + 50)}`);
      assert.ok(resolves(lit[2]), `${f}: $t('${lit[2]}') is not in en.json`);
      used.add(lit[2]);
    }
  }
  assert.deepEqual(all.filter((k) => !used.has(k)), [], 'unused messages');
});

test('components carry no hard-coded user-facing text', () => {
  const problems: string[] = [];
  const proseIn = (f: string, where: string, expr: string) => {
    for (const l of literals(expr)) if (!KEY_ARG(l.before) && !COMPARED(l.before, l.after) && PROSE(l.value)) problems.push(`${f}: ${where} literal ${JSON.stringify(l.value)}`);
  };
  for (const [f, text] of svelte) {
    const { texts, exprs } = markup(f, text);
    for (const t of texts) if (LETTERS.test(t)) problems.push(`${f}: text ${JSON.stringify(t.trim())}`);
    for (const e of exprs) proseIn(f, 'markup', e);
    for (const tag of tags(f, text)) {
      for (const a of tag.attrs) {
        if (!a.name || !TEXT_ATTRS.has(a.name) || a.value === undefined) continue;
        const v = a.value.replace(/^["']|["']$/g, '');
        let fixed = '';
        for (let i = 0; i < v.length; i++) {
          if (v[i] !== '{') fixed += v[i];
          else {
            const end = v.indexOf('}', i) < 0 ? v.length : matching(v, i);
            proseIn(f, `<${tag.name} ${a.name}>`, v.slice(i + 1, end));
            i = end;
          }
        }
        if (LETTERS.test(fixed)) problems.push(`${f}: <${tag.name} ${a.name}="${a.value}">`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

/** The `}` that closes the `{` at `i`, counting nesting and skipping strings. */
function matching(v: string, i: number): number {
  let depth = 0;
  for (let j = i; j < v.length; j++) {
    const c = v[j];
    if (c === '"' || c === "'" || c === '`') {
      const end = v.indexOf(c, j + 1);
      j = end < 0 ? v.length : end;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return v.length;
}

test('the text guard catches what it should', () => {
  const run = (src: string) => {
    const { texts, exprs } = markup('x.svelte', src);
    return [...texts.filter((t) => LETTERS.test(t)), ...exprs.flatMap((e) => literals(e).filter((l) => !KEY_ARG(l.before) && !COMPARED(l.before, l.after) && PROSE(l.value)).map((l) => l.value))];
  };
  assert.deepEqual(run('<div>{$t(\'a.bC\')} · {x === \'Some Thing\' ? 1 : 2}</div>'), []);
  assert.deepEqual(run('<div>Hello</div>'), ['Hello']);
  assert.deepEqual(run("<b>{ok ? 'Done' : 'not yet'}</b>"), ['Done', 'not yet']);
  assert.deepEqual(run('<p>{`Forge v${v}`}</p>'), ['Forge v']);
  assert.deepEqual(run('<script lang="ts">const a = "Hidden words";</script><!-- a comment --><i class="a b">{n}</i>'), []);
});
