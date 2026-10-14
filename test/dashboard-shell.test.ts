// The Drafting shell (design/jobs/03-shell.md): the sidebar, nav, page header, Pipeline controls and the overlays
// draw square corners and hard-offset shadows, and their segments and nav links expose their selected state.
// Reads source files only, like dashboard-svelte.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endOf, tags } from './svelte-markup.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dashboard', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// The files this restyle moved onto the Drafting markup. Job 4 widens the list as it restyles the rest.
const SHELL_FILES = [
  'App.svelte',
  'components/Nav.svelte',
  'components/PageHeader.svelte',
  'views/Pipeline.svelte',
  'views/Analytics.svelte',
  'components/Drawer.svelte',
  'components/Settings.svelte',
  'components/settings/ConfigTab.svelte',
  'components/CommandBar.svelte',
  'components/Banner.svelte',
  'components/Toast.svelte',
];

const ROUNDED = /(^|:)rounded(-(?!full\b)[\w[\]-]+)?$/;
const BLURRED = /(^|:)shadow-(lg|2xl)$/;
const banned = (cls: string) => ROUNDED.test(cls) || BLURRED.test(cls);

/** Every string literal in a JS expression: the class names a `{cond ? 'a' : 'b'}` can apply. */
function literals(expr: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c !== '"' && c !== "'" && c !== '`') continue;
    const end = endOf(expr, i);
    if (end < 0) break;
    out.push(expr.slice(i + 1, end));
    i = end;
  }
  return out;
}

/** Class tokens of one `class` attribute value: `"a {x ? 'b' : ''}"` or `{expr}`. */
function classTokens(value: string): string[] {
  let v = value.trim();
  if (v[0] === '"' || v[0] === "'") v = v.slice(1, -1);
  const parts: string[] = [];
  let rest = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== '{') {
      rest += v[i];
      continue;
    }
    const end = endOf(v, i);
    if (end < 0) throw new Error(`cannot parse class value ${JSON.stringify(value)}`);
    parts.push(...literals(v.slice(i + 1, end)));
    rest += ' ';
    i = end;
  }
  return [rest, ...parts].flatMap((s) => s.split(/\s+/)).filter(Boolean);
}

/** Class tokens of every element and component in a file. */
const fileClasses = (rel: string) => tags(rel, read(rel)).flatMap((t) => t.attrs.filter((a) => a.name === 'class' && a.value).flatMap((a) => classTokens(a.value as string)));

test('shell files use no rounded or blurred-shadow classes', () => {
  // The matcher itself: the corner and shadow classes it must catch, and the Drafting ones it must let through.
  for (const bad of ['rounded', 'rounded-lg', 'md:rounded-xl', 'rounded-t-lg', 'rounded-[4px]', 'shadow-lg', 'shadow-2xl', 'md:shadow-2xl']) assert.ok(banned(bad), `${bad} is caught`);
  for (const ok of ['rounded-full', 'shadow-(--shadow-dialog)', 'shadow-(--shadow-drawer)', 'shadow-[inset_3px_0_0_var(--ink)]', 'md:shadow-(--shadow-dialog)', 'border-line']) assert.ok(!banned(ok), `${ok} passes`);
  assert.deepEqual(classTokens(`"btn sm {on ? 'sel' : 'shadow-2xl'}"`), ['btn', 'sm', 'sel', 'shadow-2xl'], 'class tokens include those inside expressions');
  assert.deepEqual(classTokens(`{on ? 'active' : 'md:rounded-xl'}`), ['active', 'md:rounded-xl'], 'class={…} expressions are read too');

  for (const rel of SHELL_FILES) {
    const classes = fileClasses(rel);
    assert.ok(classes.length > 0, `${rel} has class attributes`);
    assert.deepEqual(classes.filter(banned), [], `${rel} draws square corners and hard shadows`);
  }
});

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
type El = { name: string; classes: string[]; parents: El[]; first: El | null };

/** Every element of a file with its ancestors and its first child element, from a bracket-aware walk of the markup. */
function elements(rel: string, text = read(rel)): El[] {
  const s = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const out: El[] = [];
  const stack: El[] = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === '{') {
      const end = endOf(s, i);
      assert.ok(end > 0, `${rel}: cannot parse markup near ${s.slice(i, i + 40)}`);
      i = end + 1;
      continue;
    }
    const m = s[i] === '<' ? /^<(\/?)([A-Za-z][\w:.-]*)/.exec(s.slice(i)) : null;
    if (!m) {
      i++;
      continue;
    }
    let j = i + m[0].length;
    for (; j < s.length && s[j] !== '>'; j++) {
      if (s[j] === '{' || s[j] === '"' || s[j] === "'") j = s[j] === '{' ? endOf(s, j) : s.indexOf(s[j], j + 1);
      assert.ok(j >= 0, `${rel}: cannot parse the tag near ${s.slice(i, i + 40)}`);
    }
    const raw = s.slice(i, j + 1);
    i = j + 1;
    if (m[1]) {
      const at = stack.map((e) => e.name).lastIndexOf(m[2]);
      assert.ok(at >= 0, `${rel}: </${m[2]}> closes nothing`);
      stack.length = at;
      continue;
    }
    const tag = tags(rel, raw)[0];
    const cls = tag.attrs.find((a) => a.name === 'class')?.value;
    const el: El = { name: m[2], classes: cls ? classTokens(cls) : [], parents: [...stack], first: null };
    const parent = stack.at(-1);
    if (parent && !parent.first) parent.first = el;
    out.push(el);
    if (!raw.endsWith('/>') && !VOID.has(m[2])) stack.push(el);
  }
  return out;
}

const has = (el: El, ...names: string[]) => names.every((n) => el.classes.includes(n));

test('job surfaces use the Drafting markup', () => {
  const walked = elements('x.svelte', `<div class="sheet ticks"><span class="tk"></span>{#if a}<img src="x" /><input>{/if}<div class="overflow-x-auto"><table class="tbl"></table></div></div>`);
  const table = walked.find((e) => e.name === 'table');
  assert.deepEqual(table?.parents.map((p) => p.name), ['div', 'div'], 'the walker tracks ancestors past void and self-closed elements');
  assert.equal(walked[0].first?.name, 'span');

  // StateChip: a rev tone is the REV · <state> tag, with the prefix hidden from screen readers.
  const chip = read('components/StateChip.svelte');
  assert.match(chip, /\{#if tone === 'rev'\}<span class="chip rev"><span aria-hidden="true">\{\$t\('common\.rev'\)\} ·<\/span> \{stateText\(job\)\}<\/span>\{:else\}<Chip \{tone\}/);

  // JobCard: a ticked, clickable sheet, redlined exactly when a human is needed.
  const card = tags('components/JobCard.svelte', read('components/JobCard.svelte')).find((t) => t.name === 'button');
  const cardClass = card?.attrs.find((a) => a.name === 'class')?.value ?? '';
  assert.match(cardClass, /^"sheet ticks clickable \{needsHuman\(j\) \? 'redline' : ''\} /);
  assert.ok(!classTokens(cardClass).includes('card'), 'no card alias on the JobCard root');

  // InboxCard: everything in the Inbox waits on a person, so its root is always redlined.
  const inbox = elements('components/InboxCard.svelte');
  assert.ok(has(inbox[0], 'sheet', 'ticks', 'redline'), `InboxCard's root is sheet ticks redline (${inbox[0].classes.join(' ')})`);

  // Every ticks element starts with its .tk span, which draws the two bottom corners.
  for (const rel of svelteFiles()) {
    for (const el of elements(rel).filter((e) => e.classes.includes('ticks'))) {
      assert.ok(el.first?.name === 'span' && el.first.classes.includes('tk'), `${rel}: <${el.name} class="${el.classes.join(' ')}"> has a .tk span as its first child`);
    }
  }

  // Every .tbl sits in a ticked sheet. A component whose table has no sheet of its own (CompareTable) counts only
  // when every place that renders it is inside one.
  const inSheet = (el: El) => el.parents.some((p) => has(p, 'sheet', 'ticks'));
  let tables = 0;
  for (const rel of svelteFiles()) {
    for (const el of elements(rel).filter((e) => e.name === 'table' && e.classes.includes('tbl'))) {
      tables++;
      if (inSheet(el)) continue;
      const name = path.basename(rel, '.svelte');
      const uses = svelteFiles().flatMap((f) => elements(f).filter((e) => e.name === name));
      assert.ok(uses.length > 0 && uses.every(inSheet), `${rel}: its .tbl sits inside a sheet ticks element (directly or wherever <${name}> is rendered)`);
    }
  }
  assert.ok(tables >= 14, `checked ${tables} tables`);
  for (const f of tsFiles()) assert.doesNotMatch(fs.readFileSync(path.join(SRC, f), 'utf8'), /class="[^"]*\btbl\b/, `${f} builds no .tbl outside a component`);
});

/** Every .ts file under dashboard/src (including *.svelte.ts), relative to it. */
function tsFiles(dir = SRC): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.relative(SRC, path.join(dir, e.name))] : []))
    .sort();
}

/** Every .svelte file under dashboard/src, relative to it. */
function svelteFiles(dir = SRC): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? svelteFiles(path.join(dir, e.name)) : e.name.endsWith('.svelte') ? [path.relative(SRC, path.join(dir, e.name))] : []))
    .sort();
}

test('segments and nav expose their selected state', () => {
  const pipeline = read('views/Pipeline.svelte');
  const buttons = tags('views/Pipeline.svelte', pipeline).filter((t) => t.name === 'button' && t.attrs.some((a) => a.name === 'class' && /\bsel\b/.test(a.value ?? '')));
  assert.equal(buttons.length, 2, 'the filter and layout segments');
  for (const b of buttons) {
    const pressed = b.attrs.find((a) => a.name === 'aria-pressed');
    const sel = b.attrs.find((a) => a.name === 'class')?.value ?? '';
    assert.ok(pressed, 'a segment button carries aria-pressed');
    // aria-pressed and the `sel` class read the same condition.
    const cond = /\{(\w+) \? 'sel'/.exec(sel)?.[1];
    assert.ok(cond && pressed.value === `{${cond}}`, `aria-pressed follows the sel condition (${pressed.value} vs ${sel})`);
  }
  assert.match(pipeline, /\{@const on = S\.filter === f\}/);
  assert.match(pipeline, /\{@const on = S\.layout === l\}/);

  const nav = read('components/Nav.svelte');
  const links = tags('components/Nav.svelte', nav).filter((t) => t.name === 'a');
  assert.equal(links.length, 1, 'one link per view, for the sidebar and the phone strip');
  const attr = (n: string) => links[0].attrs.find((a) => a.name === n)?.value;
  assert.equal(attr('aria-current'), `{on ? 'page' : undefined}`);
  assert.equal(attr('class'), `{on ? 'active' : ''}`);
  assert.match(nav, /\{@const on = S\.view === v\.id\}/);
});
