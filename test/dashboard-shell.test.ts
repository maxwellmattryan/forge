// The Smithy shell and job surfaces: every source keeps to the token corners and shadows and
// uses none of the pre-Smithy class names, the job surfaces use the Smithy markup, and segments and nav links expose their selected state. Reads source files only, like dashboard-svelte.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ancestry, endOf, placements, tags, type Placed } from './svelte-markup.ts';
import { TONE_CLASS } from '../dashboard/src/lib/util.ts';
import { THEME_CHOICES } from '../dashboard/src/lib/theme.ts';
import { LOG_KEY } from '../dashboard/src/lib/daemon-log.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dashboard', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const ROUNDED = /^rounded(-(?!full\b)[\w[\]-]+)?$/;
const BLURRED = /^shadow-(lg|2xl)$/;
// Job 1's aliases, deleted in job 4. `card` alone is the old sheet alias; next to `h` it is the title style.
const OLD = new Set(['btn-primary', 'kpi-label', 'kpi-value', 'prose-md', 'ember-bar', 'brand-rule', 'nav-item']);
const ACCENT = /^[\w-]+-(on-)?accent(\/\d+)?$/;
/** Variant prefixes (`hover:`, `md:`) are stripped, so `hover:text-accent` is `text-accent`. */
const base = (cls: string) => cls.slice(cls.lastIndexOf(':') + 1);
const bannedIn = (classes: string[]) => classes.filter((c) => ROUNDED.test(base(c)) || BLURRED.test(base(c)) || OLD.has(base(c)) || ACCENT.test(base(c)) || (base(c) === 'card' && !classes.includes('h')));
const banned = (cls: string) => bannedIn([cls]).length > 0;

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

/** Class tokens of each class attribute in a file, one list per attribute (so `card` can be checked against `h`). */
const fileClassLists = (rel: string) => tags(rel, read(rel)).flatMap((t) => t.attrs.filter((a) => a.name === 'class' && a.value).map((a) => classTokens(a.value as string)));

/** The fixed text of every `class="…"` in TS source, `${…}` interpolations dropped. */
function tsClassLists(text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(/class="/g)) {
    let v = '';
    for (let i = (m.index ?? 0) + m[0].length; i < text.length && text[i] !== '"'; i++) {
      if (text[i] === '$' && text[i + 1] === '{') {
        const end = endOf(text, i + 1);
        assert.ok(end > 0, `cannot parse the interpolation near ${text.slice(i, i + 40)}`);
        v += ' ';
        i = end;
      } else v += text[i];
    }
    out.push(v.split(/\s+/).filter(Boolean));
  }
  return out;
}

test('dashboard sources use no old, rounded or blurred-shadow classes', () => {
  // The matcher itself: the classes it must catch, and the Smithy ones it must let through.
  for (const bad of ['rounded', 'rounded-lg', 'md:rounded-xl', 'rounded-t-lg', 'rounded-[4px]', 'shadow-lg', 'shadow-2xl', 'md:shadow-2xl', 'btn-primary', 'hover:text-accent', 'bg-accent/15', 'text-on-accent', 'border-accent', 'kpi-value', 'nav-item', 'prose-md', 'card'])
    assert.ok(banned(bad), `${bad} is caught`);
  for (const ok of ['rounded-full', 'shadow-(--shadow-overlay)', 'shadow-(--shadow-drawer)', 'shadow-[inset_var(--bar-rule)_0_0_0_var(--gleam)]', 'md:shadow-(--shadow-overlay)', 'border-line', 'text-gleam', 'primary', 'kpi', 'prose', 'navlist'])
    assert.ok(!banned(ok), `${ok} passes`);
  assert.deepEqual(bannedIn(['h', 'card', 'line-clamp-2']), [], '`h card` is the title style');
  assert.deepEqual(bannedIn(['card', 'p-3']), ['card'], '`card` alone is the old alias');
  assert.deepEqual(classTokens(`"btn sm {on ? 'sel' : 'shadow-2xl'}"`), ['btn', 'sm', 'sel', 'shadow-2xl'], 'class tokens include those inside expressions');
  assert.deepEqual(classTokens(`{on ? 'active' : 'md:rounded-xl'}`), ['active', 'md:rounded-xl'], 'class={…} expressions are read too');
  assert.deepEqual(tsClassLists('`<div class="plate ${x ? `a` : "b"} card"><i class="h card">`'), [['plate', 'card'], ['h', 'card']], 'TS class strings drop their interpolations');

  const files = svelteFiles();
  assert.ok(files.length >= 35, `checked ${files.length} components`);
  for (const rel of files) {
    const lists = fileClassLists(rel);
    assert.deepEqual(lists.flatMap(bannedIn), [], `${rel} uses only Smithy classes, token corners and token shadows`);
  }
  const ts = tsFiles();
  assert.ok(ts.some((f) => f.endsWith('.svelte.ts')), 'rune modules are read too');
  for (const rel of ts) assert.deepEqual(tsClassLists(fs.readFileSync(path.join(SRC, rel), 'utf8')).flatMap(bannedIn), [], `${rel} builds only Smithy classes`);
  for (const [tone, cls] of Object.entries(TONE_CLASS)) assert.deepEqual(bannedIn(cls.split(/\s+/)), [], `TONE_CLASS.${tone} is a Smithy chip modifier`);
});

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
type El = { name: string; classes: string[]; attrs: { name?: string; value?: string }[]; parents: El[]; first: El | null };

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
    const el: El = { name: m[2], classes: cls ? classTokens(cls) : [], attrs: tag.attrs, parents: [...stack], first: null };
    const parent = stack.at(-1);
    if (parent && !parent.first) parent.first = el;
    out.push(el);
    if (!raw.endsWith('/>') && !VOID.has(m[2])) stack.push(el);
  }
  return out;
}

const has = (el: El, ...names: string[]) => names.every((n) => el.classes.includes(n));

test('job surfaces use the Smithy markup', () => {
  const walked = elements('x.svelte', `<div class="plate"><span class="label"></span>{#if a}<img src="x" /><input>{/if}<div class="overflow-x-auto"><table class="tbl"></table></div></div>`);
  const table = walked.find((e) => e.name === 'table');
  assert.deepEqual(table?.parents.map((p) => p.name), ['div', 'div'], 'the walker tracks ancestors past void and self-closed elements');
  assert.equal(walked[0].first?.name, 'span');

  // StateChip: a you tone is the YOU · <state> tag, with the prefix hidden from screen readers.
  const chip = read('components/StateChip.svelte');
  assert.match(chip, /\{#if tone === 'you'\}<span class="chip you"><span aria-hidden="true">\{\$t\('common\.you'\)\} ·<\/span> \{stateText\(job\)\}<\/span>\{:else\}<Chip \{tone\}/);

  // JobCard: a clickable plate, an ember plate exactly when a human is needed.
  const card = tags('components/JobCard.svelte', read('components/JobCard.svelte')).find((t) => t.name === 'button');
  const cardClass = card?.attrs.find((a) => a.name === 'class')?.value ?? '';
  assert.match(cardClass, /^"plate clickable \{needsHuman\(j\) \? 'ember' : ''\} /);
  assert.ok(!classTokens(cardClass).includes('card'), 'no card alias on the JobCard root');

  // InboxCard: everything in the Inbox waits on a person, so its root is always an ember plate.
  const inbox = elements('components/InboxCard.svelte');
  assert.ok(has(inbox[0], 'plate', 'ember'), `InboxCard's root is plate ember (${inbox[0].classes.join(' ')})`);
  // The title takes the width: it grows from 16rem, so the chips drop a line before it wraps word by word.
  const title = inbox.find((e) => e.name === 'button' && attrOf(e, 'onclick') === '{() => openDrawer(j.id)}');
  const wrapper = title?.parents.at(-1);
  assert.ok(wrapper && has(wrapper, 'min-w-0', 'flex-[1_1_16rem]'), `the title wrapper grows (${wrapper?.classes.join(' ')})`);
  assert.ok(title && has(title, 'break-words'), 'the title wraps by word');
  const header = wrapper?.parents.at(-1);
  assert.ok(header && has(header, 'flex', 'flex-wrap', 'items-start', 'gap-2'), `the header wraps (${header?.classes.join(' ')})`);
  const idLine = inbox.find((e) => attrOf(e, 'title') === '{j.id}');
  assert.ok(idLine && has(idLine, 'truncate'), 'the id line truncates, with the full id in its title');
  const chips = inbox.find((e) => e.name === 'div' && e.parents.at(-1) === header && e !== wrapper);
  assert.ok(chips && has(chips, 'flex', 'flex-wrap'), 'the chips group wraps');

  // The empty state is a cold plate; the brand and every page header are riveted plaques, and nothing else is.
  assert.ok(has(elements('components/Empty.svelte')[0], 'plate', 'cold'), 'Empty is plate cold');
  const riveted = svelteFiles().flatMap((rel) => elements(rel).filter((e) => e.classes.includes('riveted')).map(() => rel));
  assert.deepEqual(riveted.sort(), ['App.svelte', 'components/PageHeader.svelte'], 'riveted: the sidebar brand and the page header only');

  // Every .tbl sits in a plate. A component whose table has no plate of its own (CompareTable) counts only
  // when every place that renders it is inside one.
  const inSheet = (el: El) => el.parents.some((p) => p.classes.includes('plate') && !p.classes.includes('open'));
  let tables = 0;
  for (const rel of svelteFiles()) {
    for (const el of elements(rel).filter((e) => e.name === 'table' && e.classes.includes('tbl'))) {
      tables++;
      if (inSheet(el)) continue;
      const name = path.basename(rel, '.svelte');
      const uses = svelteFiles().flatMap((f) => elements(f).filter((e) => e.name === name));
      assert.ok(uses.length > 0 && uses.every(inSheet), `${rel}: its .tbl sits inside a plate (directly or wherever <${name}> is rendered)`);
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

test("DepChips and the card's agents line truncate with a full-text title", () => {
  const chips = read('components/DepChips.svelte');
  const chip = chips.match(/<span title=\{depChipTitle\(l\)\} class="chip ([^"]*)" onclick=\{\(e\) => open\(e, l\.id\)\}>(.*?)<\/span><\/span>/);
  assert.ok(chip, 'the chip span carries title={depChipTitle(l)} and opens its own id');
  const classes = chip[1].split(/\s+/);
  for (const c of ['max-w-full', 'min-w-0', 'cursor-pointer', 'hover:underline']) assert.ok(classes.includes(c), `chip class has ${c}`);
  assert.match(chip[2], /^<span class="truncate">\{\$t\('deps\.after', \{ label: depLabel\(l\) \}\)\}$/, 'the label sits in an inner truncate span');
  assert.match(chips, /e\.stopPropagation\(\);\s*openDrawer\(id\);/, "the chip opens its dependency's drawer, not the card's");
  assert.doesNotMatch(chips, /depHint/, 'the board chip title comes from depChipTitle');

  const card = read('components/JobCard.svelte');
  assert.match(card, /agentsSummary\(runningRoles\(j\)\)/);
  const line = card.match(/\{#if agents\}<span class="([^"]*)" title=\{agents\.title\}>(.*?)<\/span><\/span>\{\/if\}/);
  assert.ok(line, 'one element with title={agents.title}');
  // The footer is one line: the agents summary shrinks first (shrink-[2]) and truncates.
  for (const c of ['min-w-0', 'shrink-[2]']) assert.ok(line[1].split(/\s+/).includes(c), `agents line has ${c}`);
  assert.match(line[2], /^<span class="dot gleam plain[^"]*"><\/span><span class="truncate">/, 'the role dot (gleam, no glow), then a truncate text span');
  assert.match(line[2], /\{#if agents\.kind === 'role'\}\{agents\.role\}/);
  assert.match(line[2], /\$t\('job\.runningReviewers', \{ count: agents\.count \}\)/);
  assert.match(line[2], /\$t\('job\.runningAgents', \{ count: agents\.count \}\)/);
  assert.doesNotMatch(card, /running\.join\(/);
});

/**
 * The `{#…}` / `{:…}` headers of every block still open where `needle` first appears in a component's markup, one
 * list per open block (opener first, then its `{:else …}` branches). `<script>` and comments are dropped first.
 */
function openBlocksAt(text: string, needle: string): string[][] {
  const s = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const at = s.indexOf(needle);
  assert.ok(at >= 0, `${needle} not found`);
  const frames: string[][] = [];
  for (let i = 0; i < at; i++) {
    if (s[i] !== '{') continue;
    const end = endOf(s, i);
    assert.ok(end > 0, `cannot parse markup near ${JSON.stringify(s.slice(i, i + 60))}`);
    const body = s.slice(i + 1, end).trim();
    if (body[0] === '#') frames.push([body]);
    else if (body[0] === ':') frames.at(-1)?.push(body);
    else if (body[0] === '/') frames.pop();
    i = end;
  }
  return frames;
}

test('the action dock sits outside the drawer tabs', () => {
  const tabbed = (text: string) => openBlocksAt(text, '<ActionDock').flat().filter((h) => /shown\.tab/.test(h));
  assert.deepEqual(tabbed("{#if shown.tab === 'a'}x{:else}<ActionDock />{/if}"), ["#if shown.tab === 'a'"], 'self-check: inside a tab block');
  assert.deepEqual(tabbed("{#if a}{:else if shown.tab === 'b'}<ActionDock />{/if}"), [":else if shown.tab === 'b'"], 'self-check: inside a tab branch');
  assert.deepEqual(tabbed('{#if a}{/if}<ActionDock />'), [], 'self-check: after a closed block');
  assert.deepEqual(tabbed('{#if a}{:else if shown.tab === "b"}{/if}{#if b}<ActionDock />{/if}'), [], 'self-check: a closed branch does not leak');

  const drawer = read('components/Drawer.svelte');
  assert.equal(drawer.match(/<ActionDock\b/g)?.length, 1, 'Drawer renders the dock exactly once');
  assert.deepEqual(tabbed(drawer), [], 'no block around the dock depends on the tab');
  const aside = tags('components/Drawer.svelte', drawer).find((t) => t.name === 'aside' && t.attrs.some((a) => a.name === 'id' && a.value === '"drawer"'));
  assert.ok(aside, 'the drawer aside');
  const cls = classTokens(aside.attrs.find((a) => a.name === 'class')?.value ?? '');
  // Fixed from the viewport top to the bar's top edge: its height is the viewport less the bar and the inset.
  for (const c of ['flex', 'flex-col', 'top-0', 'bottom-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom))]']) assert.ok(cls.includes(c), `the aside has ${c}`);
  for (const c of ['overflow-hidden']) assert.ok(cls.includes(c), `the aside has ${c}`);
  for (const c of ['h-full', 'overflow-y-auto']) assert.ok(!cls.includes(c), `the aside has no ${c}: the tab panel scrolls, not the drawer`);
  assert.doesNotMatch(drawer, /resumeModel\(/, 'Resume moved to the dock');
  assert.doesNotMatch(drawer, /type: 'resume'/);

  const dock = read('components/ActionDock.svelte');
  assert.match(dock, /dockModel\(/);
  assert.ok(dock.includes('<PermissionPrompts scope={job.id} />'), 'the dock holds the prompts');
  assert.ok(dock.includes('{#key job.id}<JobActions'), 'the note is keyed by job id, so it survives polls');
  const section = tags('components/ActionDock.svelte', dock)[0];
  assert.equal(section?.name, 'section', "the dock's root is a section");
  assert.ok(section.attrs.some((a) => a.name === 'aria-labelledby'), 'labelled by its heading');
  const dockCls = classTokens(section.attrs.find((a) => a.name === 'class')?.value ?? '');
  for (const c of ['shrink-0', 'border-t', 'border-line', 'bg-panel', 'overflow-y-auto', 'max-h-[45dvh]']) assert.ok(dockCls.includes(c), `the dock has ${c}`);

  const thread = read('components/ThreadPanel.svelte');
  assert.ok(!thread.includes('<JobActions'), 'the Thread no longer holds the gate actions');
  assert.ok(!thread.includes('<PermissionPrompts'), 'nor the prompts');

  const log = read('components/SessionLog.svelte');
  /** The body of the `{…}` block that opens after `marker`. */
  const bodyAfter = (marker: string) => {
    const from = log.indexOf(marker);
    assert.ok(from >= 0, `SessionLog has ${marker}`);
    const open = log.indexOf('{', from + marker.length);
    const end = endOf(log, open);
    assert.ok(end > open, `cannot parse the block after ${marker}`);
    return log.slice(open + 1, end);
  };
  const onScroll = bodyAfter('function onScroll(');
  assert.match(onScroll, /follow = atBottom\(/, 'Follow comes from atBottom');
  assert.doesNotMatch(log, /<= 24/, 'no inline slack comparison is left');
  const onState = bodyAfter('onState: (st) =>');
  const asked = onState.indexOf('promptRefreshKey(');
  assert.ok(asked >= 0, 'a state frame checks its prompt ids against the poll');
  assert.ok(onState.indexOf('refresh()', asked) > asked, 'and then re-polls');
});

const unquote = (v: string | undefined) => (v ?? '').replace(/^["']|["']$/g, '');

// Three levels: the ground (grid and paper, on <body> alone), opaque sheets and overlays (panel), the chrome
// sidebar. Nothing above the ground carries a pattern or lets one through.
test('the ground is the only patterned surface', () => {
  const index = fs.readFileSync(path.join(ROOT, 'dashboard', 'index.html'), 'utf8');
  const grounds = tags('index.html', index).filter((t) => classTokens(t.attrs.find((a) => a.name === 'class')?.value ?? '""').includes('ground'));
  assert.deepEqual(grounds.map((t) => t.name), ['body'], 'index.html has `ground` on <body> only');
  const falloff = elements('App.svelte').filter((e) => e.classes.includes('falloff'));
  assert.deepEqual(falloff.map((e) => e.name), ['main'], 'App.svelte has `falloff` on <main> only');

  for (const rel of svelteFiles()) {
    for (const el of elements(rel)) {
      const where = `${rel}: <${el.name} class="${el.classes.join(' ')}">`;
      assert.ok(!el.classes.includes('ground'), `${where} uses ground`);
      if (!(rel === 'App.svelte' && el.name === 'main')) assert.ok(!el.classes.includes('falloff'), `${where} uses falloff`);
    }
  }
  for (const rel of [...svelteFiles(), ...tsFiles()]) {
    const lists = rel.endsWith('.svelte') ? fileClassLists(rel) : tsClassLists(read(rel));
    for (const cls of lists.flat()) {
      assert.notEqual(base(cls), 'bg-bg', `${rel} fills with bg-bg: an overlay is panel, the ground is bg`);
      assert.ok(!['ground', 'hatch', 'hatch-dense', 'crosshatch'].includes(base(cls)), `${rel} uses ${cls}: the grid, the grain and the sketch are the only patterns`);
      if (rel !== 'App.svelte') assert.notEqual(base(cls), 'falloff', `${rel} uses falloff`);
      assert.doesNotMatch(base(cls), /^bg-.+\/.+$/, `${rel} fills with ${cls}, a see-through tint`);
    }
  }

  const drawer = tags('components/Drawer.svelte', read('components/Drawer.svelte')).find((t) => t.name === 'aside' && t.attrs.some((a) => a.name === 'id' && a.value === '"drawer"'));
  const cls = classTokens(drawer?.attrs.find((a) => a.name === 'class')?.value ?? '""');
  assert.ok(cls.includes('solid') && !cls.includes('bg-bg'), `the drawer is a solid panel (${cls.join(' ')})`);
});

test('checkboxes are drawn and the theme seg keeps its radiogroup', () => {
  // Every native checkbox is the drawn .check (a styled native input, so labels and keys are the browser's).
  let boxes = 0;
  for (const rel of svelteFiles()) {
    for (const tag of tags(rel, read(rel)).filter((t) => t.name === 'input' && t.attrs.some((a) => a.name === 'type' && unquote(a.value) === 'checkbox'))) {
      boxes++;
      const cls = tag.attrs.find((a) => a.name === 'class')?.value;
      assert.ok(cls && classTokens(cls).includes('check'), `${rel}: a checkbox without the check class (${cls ?? 'no class'})`);
    }
  }
  // Six since Settings › General lost the `,` shortcut checkbox (Cmd/Ctrl+, cannot be turned off).
  assert.ok(boxes >= 6, `checked ${boxes} checkboxes`);

  const rel = 'components/settings/GeneralTab.svelte';
  const general = read(rel);
  const all = tags(rel, general);
  const groups = all.filter((t) => t.attrs.some((a) => a.name === 'role' && unquote(a.value) === 'radiogroup'));
  assert.equal(groups.length, 1, 'one radiogroup');
  assert.equal(unquote(groups[0].attrs.find((a) => a.name === 'aria-labelledby')?.value), 'settings-theme-label');
  assert.ok(all.some((t) => t.attrs.some((a) => a.name === 'id' && unquote(a.value) === 'settings-theme-label')), 'the group label exists');
  const radios = all.filter((t) => t.name === 'input' && t.attrs.some((a) => a.name === 'type' && unquote(a.value) === 'radio'));
  assert.equal(radios.length, 1, 'one radio, repeated over THEME_CHOICES');
  assert.equal(unquote(radios[0].attrs.find((a) => a.name === 'name')?.value), 'settings-theme', "Settings.svelte's focus trap groups radios by name");
  assert.match(general, /\{#each THEME_CHOICES as c \(c\)\}/);
  assert.equal(THEME_CHOICES.length, 4, 'three themes and System');
  assert.deepEqual([...THEME_CHOICES], ['forge', 'ash', 'temper', 'system']);
  for (const c of THEME_CHOICES) assert.match(general, new RegExp(`${c}: \\$t\\('settings\\.general\\.${c}'\\)`), `the ${c} choice has a label`);
  // One Grain row replaces Grid and Paper. The theme and the grain go through lib/theme.ts, which owns <html>'s attributes and their prefs.
  assert.match(general, /<div id="settings-grain-label">\{\$t\('settings\.general\.grain'\)\}<\/div>/);
  assert.match(general, /aria-labelledby="settings-grain-label" aria-describedby="settings-grain-hint"/);
  assert.match(general, /setGrain\(grain\)/);
  assert.doesNotMatch(general, /settings-(grid|paper)|setDrawing|general\.(grid|paper)/, 'no Grid or Paper rows');
  assert.match(general, /chooseTheme\(c\)/);
  for (const f of [...svelteFiles(), ...tsFiles()].filter((f) => f !== 'lib/theme.ts')) {
    const text = read(f);
    assert.doesNotMatch(text, /data-(grain|grid|paper)|dataset\.(grain|grid|paper|theme)|dataset\[/, `${f} sets appearance attributes outside lib/theme.ts`);
    assert.doesNotMatch(text, /pref\.set\('(grain|grid|paper|theme)'/, `${f} writes an appearance pref outside lib/theme.ts`);
  }
});

/** An attribute's value with its quotes dropped, or undefined. */
const attr = (el: El | undefined, name: string) => el?.attrs.find((a) => a.name === name)?.value?.replace(/^["']|["']$/g, '');

test('JobCard renders seven fixed slots from the card model', () => {
  const file = 'components/JobCard.svelte';
  const text = read(file);
  const walked = elements(file);
  const root = walked[0];
  assert.equal(root.name, 'button');
  const children = walked.filter((e) => e.parents.at(-1) === root);
  assert.deepEqual(children.map((e) => attr(e, 'data-slot')), ['title', 'ref', 'state', 'stage', 'progress', 'lenses', 'footer'], 'no corner span: the slots are the children');

  const markup = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const conds = [...markup.matchAll(/\{(?:#if|:else if)\s+([^}]*)\}/g)].map((x) => x[1]);
  assert.ok(conds.length >= 4, `checked ${conds.length} conditions`);
  for (const c of conds) assert.match(c, /^(m\.|agents)/, `{#if ${c}} reads the card model or the agents line`);
  for (const raw of ['j.state', 'j.stage', 'j.waitingOn', 'j.round']) assert.ok(!text.includes(raw), `JobCard reads no ${raw}`);
  assert.equal(text.split('needsHuman(').length - 1, 1, 'needsHuman( appears once');
  assert.match(attr(root, 'class') ?? '', /\{needsHuman\(j\) \? 'ember' : ''\}/, 'in the root class');
  assert.match(text, /const m = \$derived\(cardModel\(j\)\)/);
  assert.match(text, /<DepChips job=\{j\} \/><\/div>/, 'the dependency chips close the state slot');
  assert.match(read('components/DepChips.svelte'), /<div class="basis-full min-w-0 flex flex-wrap gap-1">/, "and always start their own line, shrinking to the card's width");

  // The footer leads with the session activity and reserves the flash dot's space, driven by the poll's flashes and the ticker.
  const footer = walked.find((e) => attr(e, 'data-slot') === 'footer');
  assert.ok(footer, 'the footer slot');
  const inFooter = walked.filter((e) => e.parents.includes(footer));
  assert.equal(inFooter[0]?.name, 'SessionActivity', 'the footer renders <SessionActivity first');
  assert.match(text, /const act = \$derived\(sessionActivity\(S\.data\?\.daemons\?\.jobs\?\.\[j\.id\], j\.lastEvent\?\.ts\)\)/);
  assert.match(text, /const flashing = \$derived\(\(S\.flashes\[j\.id\] \?\? 0\) > ticker\.now\)/);
  const flash = inFooter.find((e) => e.classes.includes('dot') && e.classes.includes('spark'));
  assert.ok(flash, 'a flash dot in the footer');
  assert.match(attr(flash, 'class') ?? '', /^\{flashing \? 'dot spark' : 'dot invisible'\}/, 'whole literals, so Tailwind sees both and the hidden dot keeps its space');
  assert.equal(attr(flash, 'aria-hidden'), 'true');
});

test('StageStepper is shared by the card and the table', () => {
  const file = 'components/StageStepper.svelte';
  const text = read(file);
  const root = elements(file)[0];
  assert.equal(attr(root, 'role'), 'img');
  assert.match(attr(root, 'aria-label') ?? '', /^\{\$t\('pipeline\.stepper', \{ n: stepPosition\(steps\), total: steps\.length, stage \}\)\}$/);
  for (const cls of ["'dot gleam plain'", "'dot hollow'", "'dot gleam plain outline outline-1 outline-offset-1 outline-gleam'", "'dot ember outline outline-1 outline-offset-1 outline-ember'"])
    assert.ok(text.includes(cls), `the dot class ${cls} is a whole literal`);
  assert.doesNotMatch(text, /\bas t\b|\(t\)|\bt =>/, 'no loop variable shadows the $t store');
  assert.match(read('components/JobCard.svelte'), /<StageStepper steps=\{m\.steps\} stage=\{m\.stage\} active=\{m\.running\} \/>/, 'the card lights a running job\'s step (cardModel: running is state === running)');
  assert.match(read('components/JobsTable.svelte'), /<StageStepper steps=\{m\.steps\} stage=\{m\.stage\} \/>/, 'the table renders the stepper still');
  assert.match(text, /let \{ steps, stage, active = false \}/, 'active defaults off');
  assert.match(text, /\{#if active && x\.status === 'current' && x\.tone === 'gleam'\}<span class="relative inline-flex"><span class="dot gleam plain"><\/span><svg class="trace" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><circle class="motion-safe:trace-loop" cx="6" cy="6" r="5\.5" \/><\/svg><\/span>/, 'the draw-on ring rides the current step while active');
  assert.doesNotMatch(text, /animate-ping|\bhalo\b/, 'the stepper borrows no live halo');

  const table = read('components/JobsTable.svelte');
  assert.ok(!table.includes('table.round'), 'no Round column');
  const buttons = tags('components/JobsTable.svelte', table).filter((x) => x.name === 'button');
  assert.equal(buttons.length, 1);
  assert.ok(attr(buttons[0] as El, 'class')?.includes('h card text-left'), 'the title is the one button');
  assert.match(table, /\{#each rows as j \(j\.id\)\}/);
  assert.match(table, /const rows = \$derived\(sortByRank\(jobs\)\)/, 'rows follow the board order');
});

test('Pipeline board is four grouped columns', () => {
  const text = read('views/Pipeline.svelte');
  for (const gone of ['overflow-x-auto', 'w-(--size-board-column)', 'lg:grid-cols', 'xl:grid-cols', 'xl:max-h']) assert.ok(!text.includes(gone), `no ${gone}`);
  assert.match(read('App.svelte'), /<div id="view" class="@container /, '#view is the container');
  // Container queries on #view (App.svelte's @container), not the viewport: the board follows its own centred width.
  for (const want of ['grid grid-cols-1 @min-[44rem]:grid-cols-2 @min-[60rem]:grid-cols-4 gap-3', '@min-[60rem]:max-h-[calc(100vh-180px)]', 'grid-cols-[repeat(auto-fill,minmax(236px,1fr))]', 'boardColumns('])
    assert.ok(text.includes(want), `has ${want}`);
  for (const id of ['queued', 'plan', 'build', 'ship', 'done']) assert.ok(text.includes(`$t('pipeline.group.${id}')`), `uses pipeline.group.${id}`);
  const all = [...tsFiles(), ...svelteFiles()].map((f) => [f, read(f)]);
  for (const [f, src] of all) assert.doesNotMatch(src, /\bboardStages\b|\bCORE_STAGES\b/, `${f} has no boardStages or CORE_STAGES`);

  // Open columns count their working sessions; Done does not.
  assert.match(text, /\{#each open as c \(c\.id\)\}\s*\{@const w = workingCount\(c\.jobs, data\.daemons\)\}/);
  const openBlock = text.slice(text.indexOf('{#each open as c'), text.indexOf('{/each}', text.indexOf('{#each open as c')));
  assert.match(openBlock, /\{#if w\}<span class="label text-gleam">\{\$t\('live\.columnWorking', \{ count: w \}\)\}<\/span>\{\/if\}/, 'an open column header shows N working');
  const doneBlock = text.slice(text.indexOf('{#if done}'));
  assert.ok(!doneBlock.includes('live.columnWorking') && !doneBlock.includes('workingCount('), "Done's header has no working count");
  assert.equal(text.split("$t('live.columnWorking'").length - 1, 1, 'one working count, in the open columns');
});

test('Needs you lists dependency parks apart, with Resume', () => {
  const file = 'components/statusbar/NeedsPanel.svelte';
  const text = read(file);
  assert.match(text, /<h3 id="needs-parks" class="label">\{\$t\('inbox\.parks'\)\}<\/h3>/, 'a label heading, not a page header');
  const parks = text.slice(text.indexOf("$t('inbox.parks')"));
  const block = parks.slice(0, parks.indexOf('{/if}'));
  assert.match(block, /<ul class="plate flat needs-list">/, 'a row list on a flat plate, not a table');
  assert.match(block, /\{#each groups\.parks as j \(j\.id\)\}/);
  assert.match(block, /<DepChips job=\{j\} \/>/);
  assert.match(block, /<JobActions job=\{j\} noteId="park-\{j\.id\}" \/>/);
  assert.match(text, /\{#if groups\.urgent\.length\}/, 'the empty state still keys on the urgent list');
  assert.match(read('lib/dock.ts'), /const actionable = needsHuman\(job\) \|\| isDependencyPark\(job\) \|\|/, "the drawer's dock keeps the gate's actions for parks");
});

test('Needs-you rows never scroll sideways', () => {
  const file = 'components/statusbar/NeedsPanel.svelte';
  const text = read(file);
  for (const banned of ['<table', 'tbl', 'overflow-x-auto']) assert.ok(!text.includes(banned), `NeedsPanel has no ${banned}`);
  const els = elements(file);
  const lists = els.filter((e) => e.name === 'ul');
  assert.equal(lists.length, 3, 'the PR, park and queued lists');
  for (const ul of lists) assert.ok(has(ul, 'plate', 'flat', 'needs-list'), `a flat plate row list (${ul.classes.join(' ')})`);
  const rows = els.filter((e) => e.name === 'li');
  assert.equal(rows.length, 3);
  for (const li of rows) assert.ok(li.classes.includes('needs-row') && lists.includes(li.parents.at(-1)!), 'each row is a needs-row li in its ul');
  const css = fs.readFileSync(path.join(ROOT, 'dashboard', 'style.css'), 'utf8');
  assert.match(css, /@utility needs-list \{\s*& > li \+ li \{ border-top: 1px solid var\(--line\); \}/, 'rows split by token hairlines');
  assert.match(css, /@utility needs-row \{[^}]*flex-direction: column;[^}]*min-width: 0;/, 'a row stacks its parts and may shrink');
  // Titles take the full row and wrap by word.
  const titles = els.filter((e) => e.name === 'button' && attrOf(e, 'onclick') === '{() => openDrawer(j.id)}');
  assert.equal(titles.length, 2, 'the PR and park titles');
  for (const b of titles) assert.ok(has(b, 'block', 'w-full', 'break-words'), `a full-width title that wraps by word (${b.classes.join(' ')})`);
  // Actions sit on their own wrapping line under the title, never beside it.
  const actions = els.find((e) => e.name === 'JobActions');
  const parkLine = actions?.parents.at(-1);
  assert.ok(parkLine && has(parkLine, 'flex', 'flex-wrap') && parkLine.parents.at(-1)?.name === 'li', `the park actions wrap on their own line (${parkLine?.classes.join(' ')})`);
  const prOpen = els.find((e) => e.name === 'a' && e.classes.includes('btn'));
  const prLine = prOpen?.parents.at(-1);
  assert.ok(prLine && has(prLine, 'flex', 'flex-wrap') && prLine.parents.at(-1)?.name === 'li', 'the PR buttons wrap on their own line');
  assert.ok(!titles.some((b) => b.parents.includes(parkLine!) || b.parents.includes(prLine!)), 'no title shares the actions line');
  // The park's ref line truncates, with the full ref in its title.
  assert.match(text, /<div class="mono muted text-\[11px\] truncate" title=\{ref\}>\{ref\}<\/div>/);
});

// Two backgrounds never conflict: a filled element (chip, button, progress, any bg-*) never shows a pattern through
// or around it, patterns never stack, and a hover-lit control never sits in another one (sheen is never inherited).
const CARRIERS = ['hatch', 'hatch-dense', 'crosshatch', 'sketch', 'ground'];
const classesOf = (el: Placed) => classTokens(el.attrs.find((a) => a.name === 'class')?.value ?? '""').map(base);
const isCarrier = (c: string[]) => c.some((x) => CARRIERS.includes(x));
const isOpaque = (c: string[]) => (c.includes('plate') && !c.includes('open')) || ['solid', 'plain', 'chrome', 'bg-panel'].some((x) => c.includes(x));
const isFilled = (c: string[]) => ['chip', 'btn', 'fill', 'track'].some((x) => c.includes(x)) || c.some((x) => x.startsWith('bg-'));
const isSketched = (el: Placed, c: string[]) => c.includes('btn') || c.includes('tab') || (el.name === 'button' && c.includes('chip'));

/** What breaks the rule in one component's markup. */
function conflicts(file: string, text: string): string[] {
  const out: string[] = [];
  for (const el of ancestry(file, text)) {
    const c = classesOf(el);
    const what = `<${el.name} class="${c.join(' ')}">`;
    if (isFilled(c)) {
      for (const a of el.ancestors) {
        const ac = classesOf(a);
        if (isCarrier(ac)) {
          out.push(`${file}: ${what} sits on a pattern (${ac.join(' ')})`);
          break;
        }
        if (isOpaque(ac)) break;
      }
    }
    if (isCarrier(c) && el.ancestors.some((a) => isCarrier(classesOf(a)))) out.push(`${file}: ${what} draws a pattern inside a pattern`);
    if (isSketched(el, c) && el.ancestors.some((a) => isSketched(a, classesOf(a)))) out.push(`${file}: ${what} is lit inside a lit control`);
  }
  return out;
}

test('no filled element nests in a patterned one', () => {
  // The walker: nearest ancestor first, past blocks, void elements and self-closed tags; unbalanced closes throw.
  const walked = ancestry('x.svelte', '<script>let a = "<b>";</script><style>.x{}</style><!-- <i> --><div class="a">{#if x}<img src="y" /><br><Comp /><svelte:element this="p"><span class="b"></span></svelte:element>{/if}</div>');
  const span = walked.find((e) => e.name === 'span');
  assert.deepEqual(span?.ancestors.map((a) => a.name), ['svelte:element', 'div']);
  assert.deepEqual(walked.map((e) => e.name), ['div', 'img', 'br', 'Comp', 'svelte:element', 'span']);
  assert.throws(() => ancestry('x.svelte', '<div></span></div>'), /closes nothing/);
  // Each failure is caught, and an opaque plate in between passes.
  assert.equal(conflicts('x', '<div class="hatch"><span class="chip ok"></span></div>').length, 1, 'a chip on a hatch');
  assert.equal(conflicts('x', '<div class="sketch p-2"><div><button class="btn sm"></button></div></div>').length, 1, 'a button on a sketch, two levels down');
  assert.equal(conflicts('x', '<div class="ground"><i class="bg-ink"></i></div>').length, 1, 'a bg-* fill on the ground class');
  assert.deepEqual(conflicts('x', '<div class="hatch"><div class="plate"><span class="chip"></span></div></div>'), [], 'an intervening plate passes');
  assert.deepEqual(conflicts('x', '<div class="hatch"><div class="solid"><div class="track"><div class="fill"></div></div></div></div>'), [], 'an intervening solid passes');
  assert.equal(conflicts('x', '<div class="ground"><div class="plate open"><span class="chip"></span></div></div>').length, 1, 'an open plate is see-through');
  assert.equal(conflicts('x', '<div class="ground"><div class="plate"><div class="crosshatch"></div></div></div>').length, 1, 'a pattern in a pattern');
  assert.equal(conflicts('x', '<div class="tab"><span class="btn sm"></span></div>').length, 1, 'a button in a tab');
  assert.deepEqual(conflicts('x', '<button class="plate clickable"><span class="btn sm"></span></button>'), [], 'a card takes no sheen, so a button in it is the one lit control');
  assert.equal(conflicts('x', '<div class="tab"><button class="chip ok"></button></div>').length, 1, 'a button chip in a tab');
  assert.deepEqual(conflicts('x', '<button class="plate clickable"><span class="chip live"></span></button>'), [], 'a span chip in a card is fine');

  const files = svelteFiles();
  assert.ok(files.length >= 35, `checked ${files.length} components`);
  for (const rel of files) assert.deepEqual(conflicts(rel, read(rel)), [], `${rel} keeps one background per layer`);
  for (const rel of tsFiles()) {
    for (const list of tsClassLists(read(rel))) assert.ok(!isCarrier(list.map(base)), `${rel} builds a pattern carrier (${list.join(' ')})`);
  }
});

// Text never sits on the grain: the grain shows only on bare ground between surfaces, so every word, value,
// caller snippet and component the shell or a view puts on the page has a surface around it. A component this test
// scans itself (GROUND, or a view) is checked inside its own file instead.
const GROUND = ['PageHeader', 'Empty', 'Banner', 'StatusBar', 'Popover', 'JobCard', 'JobsTable', 'InboxCard', 'CommandTrigger', 'Drawer', 'Settings', 'CommandBar', 'Toast', 'GitHubCard', 'NeedsPanel', 'PeriodMeter', 'Select', 'RailTip'];
/** A GROUND component's file: components/, or components/statusbar/ for a popover body. */
const groundFile = (c: string) => (fs.existsSync(path.join(SRC, 'components', `${c}.svelte`)) ? `components/${c}.svelte` : `components/statusbar/${c}.svelte`);
// A plate is a surface; an open plate is a container the grain shows through (dashboard/AGENTS.md › Text never sits on the grain).
const isSurface = (c: string[]) => (c.includes('plate') && !c.includes('open')) || ['plain', 'solid', 'chrome', 'btn', 'chip', 'input'].some((x) => c.includes(x));

/** What renders on the bare ground in one component's markup; `checked` are the components scanned on their own. */
function onGround(file: string, text: string, checked: Set<string>): string[] {
  const out: string[] = [];
  const all = placements(file, text);
  const surfaced = (ancestors: Placed[]) => ancestors.some((a) => isSurface(classesOf(a)) || checked.has(a.name));
  // A file's own snippet lands where it is rendered: its content passes when every render of it is on a surface.
  const covered = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const uses = all.filter((u) => u.kind === 'use' && u.what === name);
    return uses.length > 0 && uses.every((u) => surfaced(u.ancestors) || (u.snippet !== undefined && covered(u.snippet, seen)));
  };
  for (const p of all) {
    if (p.kind === 'use' || (p.kind === 'component' && checked.has(p.what))) continue;
    if (surfaced(p.ancestors) || (p.snippet !== undefined && covered(p.snippet))) continue;
    const what = p.kind === 'component' ? `<${p.what}>` : p.kind === 'text' ? JSON.stringify(p.what.slice(0, 40)) : `{${p.what.slice(0, 40)}}`;
    out.push(`${file}: ${what} sits on the grid; give it a surface, or add the component to GROUND`);
  }
  return out;
}

test('text never sits on the bare ground', () => {
  const ok = new Set(['Empty', 'PageHeader']);
  const bad = (markup: string) => onGround('x', markup, ok).length;
  // Rejected: text in a bare div or an open (transparent) plate, an expression, a caller's snippet, an unchecked component.
  assert.equal(bad('<div class="label">Loading</div>'), 1, 'text in a bare div');
  assert.equal(bad('<section class="plate open"><span class="label">Queued</span></section>'), 1, 'text in a plate open');
  assert.equal(bad('<p class="text-muted">{$t("a")} <code>{x}</code></p>'), 2, 'text and an expression on the ground');
  assert.equal(bad('<div class="flex">{@render children()}</div>'), 1, 'a caller snippet outside a plate');
  assert.equal(bad('<div>{@html md(x)}</div>'), 1, 'raw html on the ground');
  assert.equal(bad('<div class="mt-2"><Unknown /></div>'), 1, 'an unchecked component on the ground');
  // Accepted: the same inside a plate, plain, solid, chrome or a filled control, inside or as a checked component.
  assert.equal(bad('<div class="plate"><div class="label">Loading {x}</div>{@render children()}<Unknown /></div>'), 0, 'inside a plate');
  assert.equal(bad('<section class="plate open"><header class="plain"><span class="label">Queued</span></header></section>'), 0, "an open plate's plain header row");
  assert.equal(bad('<header class="plain flex"><span>Queued</span></header><div class="solid">a</div><aside class="chrome">b</aside>'), 0, 'inside plain, solid and chrome');
  assert.equal(bad('<button class="btn sm">Run</button><span class="chip ok">{v}</span><select class="input"><option>a</option></select>'), 0, 'filled controls');
  assert.equal(bad('<Empty>Nothing yet {x}</Empty><PageHeader title="a">{#snippet sub()}{s}{/snippet}</PageHeader>'), 0, 'checked components and their snippets');
  assert.equal(bad('{#snippet kpi(a)}<div class="plate">{a}</div>{/snippet}<div class="grid">{@render kpi(1)}</div>{#if x}{@const y = 1}{/if}'), 0, 'block tags, @const and a local snippet render place nothing themselves');
  assert.equal(bad('{#snippet row(a)}<span>{a}</span>{/snippet}'), 1, "an unrendered local snippet is checked where it is written");
  assert.equal(bad('{#snippet row(a)}<span>{a}</span>{/snippet}<div class="solid">{@render row(1)}</div><p class="plain">{@render row(2)}</p>'), 0, "a local snippet rendered only on surfaces passes");
  assert.equal(bad('{#snippet row(a)}<span>{a}</span>{/snippet}<div class="solid">{@render row(1)}</div><div>{@render row(2)}</div>'), 1, "a local snippet rendered once on the ground fails");

  const views = fs.readdirSync(path.join(SRC, 'views')).filter((f) => f.endsWith('.svelte'));
  const checked = new Set([...GROUND, ...views.map((f) => f.replace(/\.svelte$/, ''))]);
  const files = ['App.svelte', ...views.map((f) => `views/${f}`), ...GROUND.map(groundFile)];
  for (const rel of files) assert.deepEqual(onGround(rel, read(rel), checked), [], `${rel} keeps its text on a surface`);
  const agents = fs.readFileSync(path.join(ROOT, 'dashboard', 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('**Text never sits on the grain.**') && agents.includes('a `plate` (not `plate open`'), 'dashboard/AGENTS.md states the rule with plate and plate open');
  for (const s of ['`dashboard/style.css`', 'Check the forge, ash and temper themes', 'Grain']) assert.ok(agents.includes(s), `dashboard/AGENTS.md names ${s}`);
  assert.ok(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8').includes('](dashboard/AGENTS.md)'), 'AGENTS.md links dashboard/AGENTS.md');
});

/** Every file under dashboard/src, relative to it. */
const srcFiles = () => [...tsFiles(), ...svelteFiles()];

test("looping motion is the live halo and the stepper's trace, both motion-safe", () => {
  const animate = /(?<![\w-])(?:[\w-]+:)*animate-[\w-]+/g;
  const uses = srcFiles().flatMap((f) => [...read(f).matchAll(animate)].map((m) => [f, m[0]]));
  assert.deepEqual(uses.sort(), [['components/LiveDot.svelte', 'motion-safe:animate-ping']], "LiveDot's motion-safe halo is the only animate-* token");
  const dot = read('components/LiveDot.svelte');
  assert.match(dot, /<span class="dot gleam halo motion-safe:animate-ping"><\/span><span class="dot gleam relative"><\/span>/);
  assert.match(dot, /<span class="dot hollow shrink-0" aria-hidden="true"><\/span>/, 'off: a hollow dot');
  assert.match(dot, /<span class="relative inline-flex shrink-0" aria-hidden="true">/, 'on: the dot and halo are aria-hidden');

  assert.match(read('components/SessionActivity.svelte'), /<LiveDot on=\{activity\.kind === 'working'\} \/>/);
  for (const f of ['components/JobCard.svelte', 'components/Drawer.svelte']) assert.match(read(f), /<SessionActivity\b/, `${f} renders the live dot through SessionActivity`);
  assert.match(read('components/StatusBar.svelte'), /<LiveDot\b/, 'the status bar renders the live dot');

  const css = fs
    .readdirSync(path.join(ROOT, 'dashboard', 'dist', 'assets'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'dashboard', 'dist', 'assets', f), 'utf8'))
    .join('\n');
  const at = css.indexOf('.motion-safe\\:animate-ping{');
  assert.ok(at > 0, 'the built CSS has the halo');
  const media = css.lastIndexOf('@media', at);
  assert.match(css.slice(media, at), /^@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)\s*\{$/, 'inside a prefers-reduced-motion: no-preference block');
  assert.equal(css.split('.motion-safe\\:animate-ping{').length - 1, 1, 'and nowhere else');
  const trace = css.indexOf('.motion-safe\\:trace-loop{');
  assert.ok(trace > 0, "the built CSS has the stepper's trace");
  // The trace shares the halo's block, so check the nearest @media is still open at the rule, not that it opens right before it.
  const open = css.slice(css.lastIndexOf('@media', trace), trace);
  assert.match(open, /^@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)\s*\{/, 'the trace is inside a prefers-reduced-motion: no-preference block');
  assert.equal(open.split('{').length - open.split('}').length, 1, 'and that block is still open at the trace rule');
  assert.equal(css.split('.motion-safe\\:trace-loop{').length - 1, 1, 'the trace rule appears once');
});

test('no custom keyframes or animate utilities in dashboard sources', () => {
  const files = [['style.css', fs.readFileSync(path.join(ROOT, 'dashboard', 'style.css'), 'utf8')], ...srcFiles().map((f) => [f, read(f)])];
  assert.ok(files.length > 40, `checked ${files.length} files`);
  const keyframes = files.flatMap(([f, text]) => [...text.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => [f, m[1]]));
  assert.deepEqual(keyframes, [['style.css', 'trace-loop']], "the stepper's trace-loop in style.css is the only @keyframes");
  assert.equal(files.reduce((n, [, text]) => n + (text.match(/@keyframes/g)?.length ?? 0), 0), 1, 'and @keyframes appears nowhere else');
  for (const [f, text] of files) {
    assert.doesNotMatch(text, /--animate-/, `${f} sets no --animate- variable`);
    assert.doesNotMatch(text, /@utility\s+animate-/, `${f} declares no animate utility`);
  }
});

test('ticking times read the shared clock and stay out of live regions', () => {
  const TICKING = ['components/JobCard.svelte', 'components/JobsTable.svelte', 'components/Drawer.svelte', 'components/ThreadPanel.svelte', 'components/SessionActivity.svelte'];
  for (const f of TICKING) {
    const text = read(f);
    const calls = [...text.matchAll(/\bago\(/g)].map((m) => {
      const end = endOf(text, m.index + 3);
      assert.ok(end > 0, `${f}: cannot parse the ago( call`);
      return text.slice(m.index, end + 1);
    });
    assert.ok(calls.length > 0, `${f} calls ago(`);
    for (const c of calls) assert.match(c, /, ticker\.now\)$/, `${f}: ${c} passes ticker.now`);
  }
  const clockUsers = srcFiles().filter((f) => /from '[./]*(lib\/)?clock\.svelte\.ts'/.test(read(f)));
  for (const f of TICKING) assert.ok(clockUsers.includes(f), `${f} imports the ticker`);
  for (const f of clockUsers) assert.doesNotMatch(read(f), /aria-live="(polite|assertive)"/, `${f} ticks, so it has no aria-live region`);

  const app = read('App.svelte');
  const mount = app.slice(app.indexOf('onMount(() => {'));
  assert.match(mount, /const stopClock = startClock\(\);[\s\S]*?return \(\) => \{\s*stopClock\(\);/, 'App.svelte starts the clock in onMount and stops it in the cleanup');
});

test('the status bar has no version, API, sessions or sheet facts', () => {
  assert.doesNotMatch(read('lib/view.ts'), /export const activeSessions\b/, 'view.ts no longer exports activeSessions');
  const bar = read('components/StatusBar.svelte');
  for (const gone of ['footer-version', 'footer-sessions', 'activeSessions', 'activeTitle', 'viewLabels', 'viewIndex']) assert.ok(!bar.includes(gone), `StatusBar.svelte has no ${gone}`);
  assert.doesNotMatch(bar, /statusbar\.facts\.(forge|version|api|sessions|sessionsValue|sheet|sheetValue)\b/, 'none of the removed facts');
  const walked = elements('components/StatusBar.svelte');
  const facts = walked.find((e) => attr(e, 'bind:this') === '{factsBox}');
  assert.ok(facts, 'the facts strip');
  assert.ok(!walked.some((e) => e.name === 'LiveDot' && e.parents.includes(facts)), 'no live dot in the facts strip');
  // The phone strip has no sessions count of its own either.
  const app = read('App.svelte');
  for (const gone of ['mobile-sessions', 'footer-sessions', 'footer-version', '<LiveDot']) assert.ok(!app.includes(gone), `App.svelte has no ${gone}`);

  assert.match(read('components/Nav.svelte'), /navCounts\(S\.data\?\.jobs \?\? \[\]\)/, 'the Needs-you badge reads the same jobs snapshot as the board');
});

test('the drawer marks new rows and counts unread Thread changes', () => {
  const file = 'components/Drawer.svelte';
  const text = read(file);
  const markup = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const chips = markup.indexOf('<PrChip pr={j.pr} />');
  const line = markup.indexOf('<SessionActivity');
  assert.ok(chips > 0 && line > chips && line < markup.indexOf('{#if j.reason}'), 'the activity line follows the chips, before the reason');
  assert.ok(markup.includes(`{#if j.kind !== 'feature'}<Chip tone="info" text={j.kind} />{/if}<EffortChip level={effort} />{#if activity}<SessionActivity {activity} extra="caption" />{/if}</div>`), 'inside the summary row, after the kind and effort chips');
  assert.match(text, /const activity = \$derived\(job \? sessionActivity\(S\.data\?\.daemons\?\.jobs\?\.\[job\.id\], shown\?\.detail\.events\.at\(-1\)\?\.ts\) : null\)/);

  assert.match(text, /const unread = \$derived\(shown && job \? unreadCount\(threadMarks\(threadItems\(/);
  assert.match(text, /S\.threadSeen\[job\.id\] \?\? null\)/);
  assert.match(markup, /\{\$t\('drawer\.threadTab'\)\}\{#if unread > 0\}<span class="chip spark ml-1\.5">\{\$t\('drawer\.threadUnread', \{ count: unread \}\)\}<\/span>\{\/if\}/, 'the Thread tab shows chip spark N new');

  assert.match(text, /const fresh = \$derived\(shown \? freshCount\(shown\.detail\.events\.length, S\.drawer\.eventsAtOpen\) : 0\)/);
  assert.match(markup, /\{#if i < fresh\}<span class="dot spark size-1\.5 shrink-0 self-center" aria-hidden="true"><\/span><span class="sr-only">\{\$t\('live\.new'\)\}<\/span>\{\/if\}/, 'fresh Timeline rows start with dot spark and a hidden "new"');
  assert.match(markup, /<ThreadPanel [^>]*baseline=\{S\.drawer\.threadAtOpen\}/);
  // The Log label carries the live dot and a hidden "working" exactly while the job's session works.
  const logLabel = /\{:else if tab === 'log'\}\{\$t\('drawer\.logTab'\)\}\{#if ([^}]*)\}(.*?)\{\/if\}/.exec(markup);
  assert.ok(logLabel, 'the Log tab label');
  assert.equal(logLabel[1], "activity?.kind === 'working'");
  assert.ok(logLabel[2].includes('<LiveDot on={true} />'), 'the live dot');
  assert.ok(logLabel[2].includes(`<span class="sr-only">{$t('live.working')}</span>`), 'and the hidden "working"');
  assert.equal(markup.match(/<LiveDot\b/g)?.length, 1, 'the drawer has one live dot of its own, on the Log label');

  const thread = read('components/ThreadPanel.svelte');
  assert.match(thread, /baseline = null \}: \{[^}]*baseline\?: string\[\] \| null \}/, 'ThreadPanel takes a baseline prop');
  assert.match(thread, /\{#if seenAtOpen && !seenAtOpen\.has\(threadMark\(m\)\)\}<span class="dot spark size-1\.5 shrink-0" aria-hidden="true"><\/span><span class="sr-only">\{\$t\('live\.new'\)\}<\/span>\{\/if\}/, 'a message not in the baseline is marked new');
  assert.match(thread, /const seenAtOpen = \$derived\(baseline \? new Set\(baseline\) : null\)/, 'no baseline, no marks');

  // The baselines: set on a full load, reset on open and close; the Thread counts as read on first load and while shown.
  const state = read('lib/app.svelte.ts');
  assert.match(state, /if \(full\) \{\s*\/\/[^\n]*\n\s*S\.drawer\.eventsAtOpen = detail\.events\.length;\s*S\.drawer\.threadAtOpen = marksOf\(detail\);/);
  for (const fn of ['export async function openDrawer(', 'export function closeDrawer(']) {
    const body = state.slice(state.indexOf(fn), state.indexOf('\n}\n', state.indexOf(fn)));
    assert.match(body, /S\.drawer\.eventsAtOpen = null;\s*S\.drawer\.threadAtOpen = null;/, `${fn} resets the baselines`);
  }
  assert.match(state, /if \(id && \(!Object\.hasOwn\(S\.threadSeen, id\) \|\| S\.drawer\.tab === 'thread'\)\) S\.threadSeen = \{ \.\.\.S\.threadSeen, \[id\]: marksOf\(d\) \};/);
});

/** The body of the top-level function `fn` in `text`, up to its closing `\n}\n`. */
function fnBody(text: string, fn: string): string {
  const at = text.indexOf(fn);
  assert.ok(at >= 0, `${fn} not found`);
  return text.slice(at, text.indexOf('\n}\n', at));
}

test('drawer defaults to the Thread tab and resets it on close', () => {
  const state = read('lib/app.svelte.ts');
  assert.match(state, /import \{ DEFAULT_DRAWER_TAB, PANE_DEFAULT, clampPaneWidth, type DrawerTab \} from '\.\/drawer\.ts';/);
  assert.match(state, /\n {2}tab = \$state<DrawerTab>\(DEFAULT_DRAWER_TAB\);/, 'DrawerState.tab starts at the default');
  assert.match(state, /export type DrawerView = \{[^}]*\btab: DrawerTab \}/, "the view's tab is a DrawerTab");
  assert.match(state, /export async function openDrawer\(id: string, file: string \| null = null, tab: DrawerTab = DEFAULT_DRAWER_TAB\): Promise<void> \{/);
  assert.match(fnBody(state, 'export async function openDrawer('), /S\.drawer\.tab = tab;/);
  assert.match(fnBody(state, 'export function closeDrawer('), /S\.drawer\.tab = DEFAULT_DRAWER_TAB;/, 'closing resets the remembered tab');
  assert.match(state, /export function setDrawerTab\(tab: DrawerTab\): void \{/);
  assert.doesNotMatch(state, /'files'/, "no 'files' default remains");
});

test('the Log tab holds the session feed alone', () => {
  const drawer = read('components/Drawer.svelte');
  assert.equal(drawer.match(/<SessionLog\b/g)?.length, 1, 'Drawer renders the session log once');
  assert.ok(drawer.includes('{#key logKey}<SessionLog scope={j.id} active={open} transcript={ownerLog} fill />{/key}'), 'keyed by job id (and owner transcript), closed with the drawer, filling the panel');
  assert.match(drawer, /const logKey = \$derived\(ownerLog && job \? `\$\{job\.id\}:owner` : \(job\?\.id \?\? ''\)\);/, 'the key changes only with the job or the owner transcript, never with a poll');
  // The Agents tab's per-agent transcripts live in AgentsTab, mounted only on that tab.
  const agentsTab = openBlocksAt(drawer, '<AgentsTab');
  assert.deepEqual(agentsTab.flatMap((b) => b.filter((h) => /shown\.tab/.test(h))).at(-1), ":else if shown.tab === 'agents'");
  assert.equal(read('components/AgentsTab.svelte').match(/<SessionLog\b/g)?.length, 1, 'AgentsTab renders one transcript log');
  assert.match(drawer, /import SessionLog from '\.\/SessionLog\.svelte';/);
  const blocks = openBlocksAt(drawer, '<SessionLog');
  const tabbed = blocks.flatMap((b) => b.filter((h) => /shown\.tab/.test(h)).map((h) => ({ h, last: h === b.at(-1) })));
  assert.deepEqual(tabbed.filter((x) => x.last).map((x) => x.h), [":else if shown.tab === 'log'"], 'mounted only in the Log branch');

  const thread = read('components/ThreadPanel.svelte');
  assert.doesNotMatch(thread, /SessionLog/, 'ThreadPanel neither imports nor renders SessionLog');
  assert.doesNotMatch(thread, /\bactive\b/, 'and takes no active prop');
  const header = /^<!--([\s\S]*?)-->/.exec(thread);
  assert.ok(header, 'ThreadPanel opens with its header comment');
  assert.doesNotMatch(header[1], /session log/i, 'the header comment no longer mentions the session log');
  assert.match(header[1].replace(/\s+/g, ' '), /its request and the requests about it with the session's replies/);
});

/** Drawer.svelte's markup walked, with its body column, header block, tab strip and tab panel picked out. */
function drawerParts() {
  const walked = elements('components/Drawer.svelte');
  const one = (pred: (e: El) => boolean, what: string) => {
    const hits = walked.filter(pred);
    assert.equal(hits.length, 1, `Drawer has one ${what}`);
    return hits[0];
  };
  const head = one((e) => attr(e, 'bind:this') === '{head}', 'header block (bind:this={head})');
  const body = head.parents.at(-1);
  assert.ok(body, 'the header block sits in the body column');
  const strip = one((e) => attr(e, 'role') === 'tablist', 'tablist');
  const panel = one((e) => attr(e, 'role') === 'tabpanel', 'tabpanel');
  assert.equal(attr(panel, 'bind:this'), '{panel}', 'the panel is bound, so the scroll resets reach it');
  const tabs = walked.filter((e) => attr(e, 'role') === 'tab');
  return { walked, body, head, strip, panel, tabs };
}

test('drawer tabs are an ARIA tablist', () => {
  const text = read('components/Drawer.svelte');
  const { body, head, strip, panel, tabs } = drawerParts();
  assert.match(text, /import \{ DRAWER_TABS, PANE_DEFAULT, PANE_MIN, clampPaneWidth, moveDrawerTab, paneKey, paneMax, type DrawerTab \} from '\.\.\/lib\/drawer\.ts';/);
  assert.doesNotMatch(text, /const TABS\b/, 'no local tab list');
  assert.ok(text.includes('{#each DRAWER_TABS as tab (tab)}'), 'the strip iterates DRAWER_TABS');

  // AC6: the tablist, its tabs and the panel.
  assert.equal(attr(strip, 'aria-label'), "{$t('drawer.tabs')}");
  assert.equal(attr(strip, 'onkeydown'), '{stripKey}');
  const key = fnBody(text.replace(/\n {2}/g, '\n'), 'function stripKey(');
  assert.match(key, /const next = moveDrawerTab\(shown\.tab, e\.key\);/, 'arrow, Home and End keys go through moveDrawerTab');
  assert.match(key, /e\.preventDefault\(\);\s*selectTab\(next, true\);/, 'a move selects the tab and focuses it');
  assert.equal(tabs.length, 1, 'one tab button, repeated per tab');
  const tab = tabs[0];
  assert.equal(tab.name, 'button');
  assert.ok(tab.parents.includes(strip), 'the tabs sit in the strip');
  assert.equal(attr(tab, 'id'), 'drawer-tab-{tab}');
  assert.equal(attr(tab, 'aria-selected'), '{shown.tab === tab}');
  assert.equal(attr(tab, 'aria-controls'), 'drawer-panel-{tab}');
  assert.equal(attr(tab, 'tabindex'), '{shown.tab === tab ? 0 : -1}', 'roving tabindex: the selected tab is the single Tab stop');
  assert.equal(attr(tab, 'onclick'), '{() => selectTab(tab)}');
  assert.ok(has(tab, 'tab', 'shrink-0', 'whitespace-nowrap'), `the tab never wraps or squeezes (${tab.classes.join(' ')})`);
  assert.equal(attr(panel, 'id'), 'drawer-panel-{shown.tab}');
  assert.equal(attr(panel, 'aria-labelledby'), 'drawer-tab-{shown.tab}');
  assert.equal(attr(panel, 'tabindex'), '0');
  assert.ok(!/aria-pressed/.test(text), 'no aria-pressed is left on the drawer tabs');

  // Opaque, above the content and outside the scroller: a fixed-height row of the body column, outside the header block.
  assert.ok(has(strip, 'tabs', 'shrink-0', 'solid'), `the strip is a non-shrinking, opaque .tabs (${strip.classes.join(' ')})`);
  assert.ok(!has(strip, 'sticky'), 'nothing scrolls under the strip, so it needs no sticky');
  assert.ok(strip.classes.some((c) => /^z-\d+$/.test(c)), 'and has a z-index');
  // AC17: on a phone it scrolls sideways and never grows a vertical scrollbar of its own.
  assert.ok(has(strip, 'overflow-x-auto', 'overflow-y-hidden'), 'the strip scrolls only sideways');
  assert.equal(strip.parents.at(-1), body, 'the strip is a direct child of the body column');
  assert.ok(!strip.parents.includes(head), 'outside the header block');
  assert.equal(head.parents.at(-1), body, 'the header block is a direct child of the body');
  assert.equal(panel.parents.at(-1), body, 'and so is the panel');
  assert.ok(has(body, 'flex', 'min-h-0', 'flex-1', 'flex-col', 'overflow-hidden'), `the body is a column that never scrolls (${body.classes.join(' ')})`);
  assert.ok(!has(body, 'overflow-y-auto'), 'the body does not scroll');
  assert.ok(has(head, 'shrink-0', 'max-h-[40%]', 'overflow-y-auto'), `a tall header is capped and scrolls inside itself (${head.classes.join(' ')})`);
  assert.ok(has(panel, 'min-h-0', 'flex-1'), 'the panel takes the remaining height');
  assert.ok(text.includes("{shown.tab === 'log' ? 'overflow-hidden' : 'overflow-y-auto'}"), 'the panel scrolls on every tab but Log, where the log pane does');
  // The strip outranks the session log's own sticky group headings (z-10), which scroll under it.
  const zOf = (cls: string[]) => Number(cls.find((c) => /^z-\d+$/.test(c))?.slice(2) ?? 0);
  const logHeads = elements('components/SessionLog.svelte').filter((e) => e.classes.includes('sticky'));
  assert.ok(logHeads.length > 0);
  for (const h of logHeads) assert.ok(zOf(strip.classes) > zOf(h.classes), "the strip stacks above the log's sticky headings");
});

test('the drawer header is compact and Details holds the rest', () => {
  const text = read('components/Drawer.svelte');
  const markup = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const { walked, head } = drawerParts();
  const headHtml = markup.slice(markup.indexOf('bind:this={head}'), markup.indexOf('role="tablist"'));
  assert.ok(headHtml.length > 0, 'the header block precedes the strip');

  // AC10: title row, summary row, reason line, and nothing else.
  assert.ok(headHtml.includes('{#if scopeVerbs(j).length}<CommandTrigger job={j.id} />{/if}'), 'the title row keeps Command for this job');
  assert.ok(headHtml.includes(`<CloseButton size="sm" label={$t('drawer.close')} onclick={closeDrawer} />`), 'and the close button');
  const rows = walked.filter((e) => e.parents.at(-1) === head);
  assert.deepEqual(rows.map((e) => e.name), ['div', 'div', 'div', 'AgentActivity'], 'the title row, the summary row, the reason line, the running agents');
  const summary = rows[1];
  assert.ok(has(summary, 'flex', 'flex-wrap', 'items-center', 'gap-1.5'), 'one wrapping summary row');
  const inSummary = walked.filter((e) => e.parents.includes(summary)).map((e) => e.name);
  for (const c of ['StateChip', 'Chip', 'PrChip', 'SessionActivity']) assert.ok(inSummary.includes(c), `the summary row holds <${c}>`);
  assert.match(headHtml, /<span class="chip gleam">\{STAGE_LABEL\[j\.stage\] \?\? j\.stage\}<\/span>/, 'the stage chip');
  assert.ok(headHtml.includes("{#if j.round}<Chip tone=\"muted\" text={$t('job.round'"), 'the round chip');
  assert.ok(headHtml.includes("{#if j.kind !== 'feature'}<Chip tone=\"info\" text={j.kind} />{/if}"), 'the kind chip');
  assert.ok(headHtml.includes('{#if j.reason}<div class="text-sm text-muted truncate" title={j.reason}>{j.reason}</div>{/if}'), 'the reason on one truncated line, in full in its title');
  const DETAILS = ['<ProgressBar', '<div class="grid grid-cols-2 md:grid-cols-3 gap-3">', '<DepSection', '{#if matrix}', '<table class="tbl">', '{@html budgetPanel(', '{#if usageRows.length}', '{@html screenshotsPanel('];
  for (const part of DETAILS) {
    assert.ok(!headHtml.includes(part), `${part} is not in the header`);
    const at = markup.indexOf(part);
    assert.ok(at >= 0, `Drawer still renders ${part}`);
    const tabBranches = openBlocksAt(markup, part).filter((b) => b.some((h) => /shown\.tab/.test(h)));
    assert.deepEqual(tabBranches.map((b) => b.at(-1)), [":else if shown.tab === 'details'"], `${part} renders only on Details`);
  }
  // Every table in the drawer is a Details table (the matrix and the usage).
  for (const m of markup.matchAll(/<table\b/g)) assert.deepEqual(openBlocksAt(markup.slice(0, m.index) + '<TABLE_HERE', '<TABLE_HERE').filter((b) => b.some((h) => /shown\.tab/.test(h))).map((b) => b.at(-1)), [":else if shown.tab === 'details'"]);
  // In order, after the full reason.
  const det = markup.slice(markup.indexOf("{:else if shown.tab === 'details'}"));
  const order = ["{$t('drawer.reason')}", ...DETAILS.filter((p) => p !== '<table class="tbl">')].map((p) => det.indexOf(p));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `Details holds the reason, progress, facts, deps, matrix, budget, usage and screenshots in that order (${order})`);
  assert.ok(det.includes("{#if j.reason}<div><div class=\"label\">{$t('drawer.reason')}</div><div class=\"text-sm break-words\">{j.reason}</div></div>{/if}"), 'the full reason, as text');
  const gridBlocks = openBlocksAt(markup, '<div class="grid grid-cols-2 md:grid-cols-3 gap-3">');
  assert.deepEqual(gridBlocks.at(-1)?.at(-1), ":else if shown.tab === 'details'", 'the facts grid renders unconditionally on Details, so it is never empty');

  // The tab chain is exhaustive with explicit branches.
  const chain = openBlocksAt(markup, '{@html screenshotsPanel(').find((b) => b[0] === "#if shown.tab === 'thread'");
  assert.deepEqual(chain, ["#if shown.tab === 'thread'", ":else if shown.tab === 'log'", ":else if shown.tab === 'agents'", ":else if shown.tab === 'files'", ":else if shown.tab === 'timeline'", ":else if shown.tab === 'details'"]);

  // AC11: no scroll hacks.
  for (const s of ['scrollIntoView', 'setTimeout', 'scrolledFor', 'tabStrip']) assert.ok(!text.includes(s), `Drawer has no ${s}`);
});

test('drawer scroll resets when the job id changes', () => {
  const text = read('components/Drawer.svelte');
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(text)?.[1] ?? '';
  assert.match(script, /let head = \$state<HTMLDivElement>\(\);/);
  assert.match(script, /let panel = \$state<HTMLDivElement>\(\);/);
  assert.doesNotMatch(script, /tabScrollTop|\bbody\.scrollTop/, 'the body column never scrolls, so nothing resets it');
  const effects = [...script.matchAll(/\$effect\(\(\) => \{/g)].map((m) => script.slice(m.index, endOf(script, m.index + m[0].length - 1) + 1));
  const reset = effects.filter((e) => /S\.drawer\.id/.test(e));
  assert.equal(reset.length, 1, 'one effect reads the drawer id');
  assert.match(reset[0], /void S\.drawer\.id;\s*if \(panel\) panel\.scrollTop = 0;\s*if \(head\) head\.scrollTop = 0;/, 'and puts the panel and the header back at the top');
  assert.doesNotMatch(reset[0], /S\.drawerView|shown|job\b/, 'it reads only the id, so a poll refresh never moves the scroll');

  const select = fnBody(script.replace(/\n {2}/g, '\n'), 'function selectTab(');
  const tabAt = select.indexOf('setDrawerTab(tab);');
  const scroll = select.indexOf('if (panel) panel.scrollTop = 0;');
  assert.ok(tabAt >= 0 && scroll > tabAt, 'switching tabs starts the new tab at the top of the panel');
  assert.match(select, /if \(focus\) document\.getElementById\('drawer-tab-' \+ tab\)\?\.focus\(\);/);
});

test('drawer entry points pick their tab', () => {
  const calls = srcFiles().flatMap((f) => [...read(f).matchAll(/\bopenDrawer\(([^)]*)\)/g)].map((m) => ({ f, args: m[1] })));
  assert.ok(calls.length >= 15, `found ${calls.length} openDrawer calls`);
  assert.deepEqual(calls.filter((c) => /'thread'/.test(c.args)), [], "no caller asks for 'thread': it is the default");
  const tabbed = calls.filter((c) => /'(log|files|timeline|details)'/.test(c.args)).map((c) => `${c.f}: openDrawer(${c.args})`).sort();
  assert.deepEqual(tabbed, [
    "components/InboxCard.svelte: openDrawer(j.id, 'protected.diff', 'files')",
    "components/InboxCard.svelte: openDrawer(j.id, doc, 'files')",
    "components/PermissionPrompts.svelte: openDrawer(s, null, 'log')",
    "components/statusbar/DaemonPanel.svelte: openDrawer(id, null, 'log')",
  ], 'only the session entry points open on Log, and Read {doc} and View diff on Files');
  assert.ok(read('components/CommandBar.svelte').includes('openDrawer(res.id);'), 'a new job opens on the default tab');
});

/** An attribute's value with its quotes dropped (`"x"` → `x`; `{x}` stays as written). */
const attrOf = (el: { attrs: { name?: string; value?: string }[] }, name: string) => unquote(el.attrs.find((a) => a.name === name)?.value);

test('the sidebar holds the brand, stamp line, repo, command input, nav and settings', () => {
  const app = elements('App.svelte');
  const sidebar = app.find((e) => e.name === 'aside' && attrOf(e, 'id') === 'sidebar');
  assert.ok(sidebar, 'aside#sidebar');
  const kids = app.filter((e) => e.parents.at(-1) === sidebar);
  // In order: the riveted brand plaque, the view's stamp line, the repo, the command input, the nav, the Settings foot.
  assert.ok(has(kids[0], 'plate', 'riveted'), `the brand is a riveted plaque (${kids[0].classes.join(' ')})`);
  assert.ok(has(kids[1], 'stamp-line', 'wide'), `then a wide stamp line (${kids[1].classes.join(' ')})`);
  assert.ok(app.some((e) => e.parents.includes(kids[2]) && attrOf(e, 'id') === 'repo-name'), 'then the repo');
  assert.ok(app.some((e) => e.parents.includes(kids[3]) && attrOf(e, 'id') === 'sidebar-command'), 'then the command input');
  assert.equal(attrOf(kids[4], 'id'), 'nav', 'then the nav');
  assert.ok(has(kids[4], 'navlist'), 'a navlist');
  assert.ok(app.some((e) => e.parents.includes(kids[5]) && attrOf(e, 'id') === 'settings-open'), 'and Settings at the foot');
  assert.equal(kids.length, 6, 'nothing else');
  const markup = markupOf('App.svelte');
  assert.ok(markup.includes(`<div class="stamp-line wide mx-0.5 mt-0.5 mb-2">{$t('app.view', { view: viewLabel })}</div>`), 'the stamp line names the view, with no DWG prefix');
  const inside = app.filter((e) => e.parents.includes(sidebar));
  assert.ok(!inside.some((e) => e.classes.includes('tblock') || e.classes.includes('dim-line')), 'no title block or dimension line');
  const popups = inside.filter((e) => e.attrs.some((a) => a.name === 'aria-haspopup'));
  // #sidebar-command is the rail's icon button or the expanded input: two branches of one {#if}, one on screen.
  assert.deepEqual(popups.map((e) => attrOf(e, 'id')), ['sidebar-command', 'sidebar-command', 'settings-open'], 'the palette and Settings open from the sidebar');
  assert.deepEqual(popups.slice(0, 2).map((e) => e.name), ['button', 'input'], 'the rail button, then the input');
  const phone = app.find((e) => e.name === 'header' && e.classes.includes('md:hidden'));
  assert.ok(phone, 'the phone strip');
  const phoneKids = app.filter((e) => e.parents.at(-1) === phone);
  assert.deepEqual(phoneKids.map((e) => attrOf(e, 'id')), ['mobile-nav', 'mobile-command', 'settings-open-mobile'], 'the phone strip: the nav row, the palette button, the settings button');
  assert.ok(has(phoneKids[0], 'navlist', 'row'), 'a navlist row');
  const all = (fs.readdirSync(SRC, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((e) => e.isFile()).map((e) => path.relative(SRC, path.join(e.parentPath, e.name)));
  assert.ok(all.includes('App.svelte') && all.includes(path.join('messages', 'en.json')), `walked ${all.length} files`);
  for (const rel of all) assert.ok(!read(rel).includes('command-open'), `${rel} mentions no command-open button`);
});

test('the sidebar separator is a focusable window splitter', () => {
  const app = elements('App.svelte');
  const src = read('App.svelte');
  const root = app.find((e) => e.name === 'div' && e.parents.length === 0 && has(e, 'flex', 'min-h-screen'))!;
  assert.equal(attrOf(root, 'style'), '--size-sidebar: {shown}px', 'the root carries the width the sidebar shows');
  assert.match(src, /const shown = \$derived\(sidebarShown\(S\.side\)\);/);
  const sidebar = app.find((e) => e.name === 'aside' && attrOf(e, 'id') === 'sidebar')!;
  const siblings = app.filter((e) => e.parents.at(-1) === root);
  const wrap = siblings[siblings.indexOf(sidebar) + 1];
  assert.ok(wrap && has(wrap, 'hidden', 'md:block', 'sticky', 'top-0', 'h-screen', 'w-0'), `the aside's next sibling holds it, hidden below md (${wrap?.classes.join(' ')})`);
  assert.equal(attrOf(wrap, 'inert'), '{covered}', 'inert under the drawer');
  const sep = app.find((e) => e.parents.at(-1) === wrap && attrOf(e, 'role') === 'separator')!;
  assert.ok(sep, 'the separator');
  for (const [k, v] of [['aria-orientation', 'vertical'], ['aria-controls', 'sidebar'], ['aria-valuemin', '{SIDEBAR_RAIL}'], ['aria-valuemax', '{SIDEBAR_MAX}'], ['aria-valuenow', '{shown}'], ['aria-label', "{$t('sidebar.resize')}"], ['tabindex', '0'], ['onpointerdown', '{sideDragStart}'], ['onpointermove', '{sideDragMove}'], ['onpointerup', '{sideDragEnd}'], ['onlostpointercapture', '{sideDragEnd}'], ['onkeydown', '{sideKey}'], ['ondblclick', '{sideReset}']])
    assert.equal(attrOf(sep, k), v, `the separator's ${k}`);
  for (const c of ['absolute', 'inset-y-0', '-left-1', 'w-2', 'cursor-col-resize', 'touch-none']) assert.ok(sep.classes.includes(c), `an 8px hit area: ${c}`);
  const rule = app.find((e) => e.parents.at(-1) === sep && e.name === 'span')!;
  assert.ok(rule && rule.classes.includes('border-l') && rule.classes.includes('group-hover:border-gleam') && rule.classes.includes('group-focus-visible:border-gleam') && rule.classes.includes('border-gleam'), 'the rule turns gleam on hover, focus or drag');
  assert.match(src, /e\.currentTarget\.setPointerCapture\(e\.pointerId\);\s*sideDrag = \{ x: e\.clientX, start: shown \};/, 'a drag captures the pointer from the shown width');
  assert.match(src, /const r = sidebarDrag\(sideDrag\.start \+ \(e\.clientX - sideDrag\.x\)\);\s*setSidebar\(r\.compact \? \{ width: S\.side\.width, compact: true \} : r, false\);/, 'it tracks the pointer, unsaved, keeping the width on the rail');
  assert.match(src, /sideDragging = false;\s*setSidebar\(\{ width: S\.side\.width, compact: S\.side\.compact \}\);/, 'and saves once when it ends');
  assert.match(src, /const next = sidebarKey\(\{ width: S\.side\.width, compact: S\.side\.compact \}, e\.key, e\.shiftKey\);\s*if \(!next\) return;\s*e\.preventDefault\(\);\s*setSidebar\(next\);/, 'a key steps and saves; others are not prevented');
  assert.match(src, /const sideReset = \(\): void => setSidebar\(\{ width: SIDEBAR_DEFAULT, compact: false \}\);/, 'double-click resets to the default');
  const state = fs.readFileSync(path.join(SRC, 'lib', 'app.svelte.ts'), 'utf8');
  assert.match(state, /const SIDE_START: SidebarState = readSidebar\(pref\.get\);/, 'read through the guarded pref');
  assert.match(state, /pref\.set\('sidebarWidth', String\(next\.width\)\);\s*pref\.set\('sidebarCompact', next\.compact \? '1' : '0'\);/, 'saved through the guarded pref');
});

test('the compact rail labels its controls and shows tooltips', () => {
  const app = elements('App.svelte');
  const src = read('App.svelte');
  const sidebar = app.find((e) => e.name === 'aside' && attrOf(e, 'id') === 'sidebar')!;
  assert.match(attrOf(sidebar, 'class'), /\{compact \? 'px-2' : 'px-3'\}/, 'the rail drops to px-2');
  const markup = markupOf('App.svelte');
  assert.match(markup, /<img src="\/forge\.png" alt="" class="mark shrink-0" \/>\{#if !compact\}<div class="min-w-0">/, 'the brand shows the mark only');
  assert.match(markup, /\{#if !compact\}<div class="stamp-line wide/, 'no stamp line on the rail');
  assert.match(markup, /\{#if !compact\}<div class="label flex min-w-0 items-baseline gap-2 px-2\.5 pb-2\.5"><span class="shrink-0">\{\$t\('app\.repo'\)\}/, 'no repo row on the rail');
  const cmd = app.find((e) => e.name === 'button' && attrOf(e, 'id') === 'sidebar-command')!;
  assert.ok(has(cmd, 'btn', 'icon'), 'the command is an icon button');
  for (const [k, v] of [['aria-label', "{$t('command.open')}"], ['aria-haspopup', 'dialog'], ['aria-keyshortcuts', 'Meta+K Control+K'], ['onclick', '{(e) => openPalette({ opener: e.currentTarget })}']]) assert.equal(attrOf(cmd, k), v, `the rail command's ${k}`);
  assert.match(src, /\{@attach railTipOn\(\$t\('command\.open'\)\)\}><Icon name="command" \/><\/button>/, 'with a tooltip');
  const settings = app.find((e) => attrOf(e, 'id') === 'settings-open')!;
  assert.equal(attrOf(settings, 'aria-label'), "{compact ? $t('settings.open') : undefined}");
  assert.match(src, /\{@attach compact && railTipOn\(\$t\('settings\.open'\)\)\}>\{#if compact\}<Icon name="settings" \/>\{:else\}/, 'the gear alone, with a tooltip and no kbd');
  assert.match(markup, /<nav id="nav" class="navlist \{compact \? 'rail' : ''\}"><Nav \{compact\} \/><\/nav>/);
  // Nav: one link per view; on the rail it is named by aria-label (with the count) and shows the icon and a corner count.
  const nav = read('components/Nav.svelte');
  const link = tags('components/Nav.svelte', nav).find((t) => t.name === 'a')!;
  assert.equal(link.attrs.find((a) => a.name === 'aria-label')?.value, '{compact ? railName(v.id, n) : undefined}');
  assert.match(nav, /const railName = \(id: ViewId, n: number\): string => \(n \? `\$\{labels\[id\]\} · \$\{n\}` : labels\[id\]\);/, 'Pipeline · 3');
  assert.match(nav, /\{@attach compact && railTipOn\(railName\(v\.id, n\)\)\}/, 'and a tooltip');
  assert.match(nav, /<span class="mono num absolute top-1 right-1 text-\[10px\] leading-none \{on \? '' : 'muted'\}" aria-hidden="true">\{n\}<\/span>/, 'the count in the corner');
  // The tooltip: one fixed tip, role=tooltip, hidden from assistive tech, on a solid plate, outside the scrolling aside.
  const tip = elements('components/RailTip.svelte').find((e) => attrOf(e, 'role') === 'tooltip')!;
  assert.ok(tip, 'a tooltip');
  assert.equal(attrOf(tip, 'aria-hidden'), 'true');
  assert.ok(has(tip, 'solid', 'plate'), 'on a solid plate');
  assert.ok(has(tip.parents.at(-1)!, 'fixed', 'pointer-events-none', 'z-36'), 'fixed, click-through and over the status bar (z-35), so the Settings tip is never cut off');
  const rootKids = app.filter((e) => e.parents.length === 1 && e.parents[0].classes.includes('min-h-screen'));
  assert.ok(rootKids.some((e) => e.name === 'RailTip'), 'rendered in the root, so it is inert with it and never clipped by the aside');
  const rail = fs.readFileSync(path.join(SRC, 'lib', 'rail-tip.svelte.ts'), 'utf8');
  for (const h of ["addEventListener('pointerenter', show)", "addEventListener('pointerleave', hideTip)", "addEventListener('focus', show)", "addEventListener('blur', hideTip)", "addEventListener('keydown', key)"]) assert.ok(rail.includes(h), `railTipOn wires ${h}`);
  assert.match(rail, /if \(e\.key === 'Escape'\) hideTip\(\);/, 'Escape hides it');
  assert.match(src, /\$effect\(\(\) => \{\s*if \(!compact \|\| covered\) hideTip\(\);\s*\}\);/, 'expanding the rail or opening the drawer hides it');
  for (const f of ['App.svelte', 'components/Nav.svelte', 'components/RailTip.svelte']) assert.doesNotMatch(read(f), /\{@html/, `${f} adds no {@html}`);
});

test('command input: in the sidebar at md and up, a 44px strip button below md, one shortcut', () => {
  const header = read('components/PageHeader.svelte');
  assert.doesNotMatch(header, /CommandTrigger/, 'PageHeader renders no palette trigger');
  const h1 = elements('components/PageHeader.svelte').find((e) => e.name === 'h1');
  assert.equal(attrOf(h1!, 'tabindex'), '-1', 'the heading is the focus fallback');
  const views = fs.readdirSync(path.join(SRC, 'views')).filter((f) => f.endsWith('.svelte'));
  assert.equal(views.length, 6);
  for (const v of views) assert.equal(read(`views/${v}`).match(/<PageHeader\b/g)?.length, 1, `${v} renders one PageHeader`);

  // md and up: the sidebar input, or on the compact rail its icon button (the other branch of one {#if}), is the one
  // element on screen that announces the shortcut.
  const shortcut = svelteFiles().flatMap((rel) => elements(rel).filter((e) => attrOf(e, 'aria-keyshortcuts') === 'Meta+K Control+K').map((e) => ({ rel, e })));
  assert.equal(shortcut.length, 2, 'the input and the rail button announce the palette shortcut');
  assert.deepEqual(shortcut.map((s) => [s.rel, s.e.name, attrOf(s.e, 'id')]), [['App.svelte', 'button', 'sidebar-command'], ['App.svelte', 'input', 'sidebar-command']]);
  assert.match(markupOf('App.svelte'), /\{#if compact\}\s*<button id="sidebar-command"[^]*?\{:else\}\s*<input/, 'never both at once');
  const input = shortcut[1].e;
  assert.equal(input.name, 'input');
  assert.equal(attrOf(input, 'id'), 'sidebar-command');
  assert.ok(input.parents.some((p) => attrOf(p, 'id') === 'sidebar'), 'inside the sidebar');
  assert.equal(attrOf(input, 'aria-label'), "{$t('command.open')}");
  assert.equal(attrOf(input, 'placeholder'), "{$t('command.open')}");
  assert.equal(attrOf(input, 'aria-haspopup'), 'dialog');
  assert.ok(input.classes.includes('w-full'), 'full sidebar width');
  // The placeholder is its only visible label: muted, not dim, and the strong edge; the hint sits inside it.
  for (const c of ['placeholder:text-muted!', 'border-line-strong!']) assert.ok(input.classes.includes(c), `#sidebar-command has ${c}`);
  const wrap = input.parents.at(-1);
  const kbd = elements('App.svelte').find((e) => e.name === 'kbd' && e.parents.at(-1)?.classes.join(' ') === wrap?.classes.join(' ') && wrap?.classes.includes('relative'));
  assert.ok(kbd && attrOf(kbd, 'aria-hidden') === 'true' && kbd.classes.includes('absolute'), 'the ⌘K hint is drawn inside the input, hidden from assistive tech');
  const appSrc = read('App.svelte');
  for (const [ev, type] of [['oninput', 'input'], ['oncompositionend', 'compositionend'], ['onkeydown', 'keydown']]) assert.equal(attrOf(input, ev), `{(e) => inline(e, '${type}')}`, `${ev} goes through inline()`);
  assert.match(appSrc, /if \(inlineInputAction\(\{ type, value: el\.value, key, composing \}\) !== 'open'\) return;/, 'inline() asks inlineInputAction');
  assert.match(appSrc, /openPalette\(\{ text: el\.value, opener: el \}\);\s*el\.value = '';/, 'it hands its text to the palette and clears');
  assert.match(appSrc, /function commandState\(\): \{ visible: boolean; focused: boolean \}/);

  // Below md: one 44px button in the phone strip.
  const phone = elements('App.svelte').filter((e) => e.name === 'button' && attrOf(e, 'id') === 'mobile-command');
  assert.equal(phone.length, 1, 'one phone palette button');
  assert.ok(has(phone[0], 'btn', 'touch'), 'a 44px btn');
  assert.equal(attrOf(phone[0], 'aria-haspopup'), 'dialog');
  assert.match(attrOf(phone[0], 'onclick'), /openPalette\(\{ opener: e\.currentTarget \}\)/);
  assert.ok(phone[0].parents.some((p) => p.name === 'header' && p.classes.includes('md:hidden')), 'in the phone strip');
  // The status bar holds no field and no palette button.
  const bar = elements('components/StatusBar.svelte');
  assert.ok(!bar.some((e) => e.name === 'input'), 'the status bar has no input');
  assert.ok(!bar.some((e) => e.name === 'button' && /openPalette/.test(attrOf(e, 'onclick'))), 'nor a command button');
  assert.doesNotMatch(read('components/StatusBar.svelte'), /statusbar-command|openPalette|commandState|focusCommand/);

  // App: no FAB, and Cmd/Ctrl-K follows shortcutAction.
  const app = read('App.svelte');
  assert.doesNotMatch(app, /CommandTrigger/, 'App imports no CommandTrigger: the FAB is gone');
  assert.match(app, /<StatusBar \/>/);
  assert.match(app, /const inline = commandState\(\);\s*const action = shortcutAction\(\{ paletteOpen: palette\.open, inlineVisible: inline\.visible, inlineFocused: inline\.focused \}\);/);
  assert.match(app, /if \(action === 'focus-palette'\) command\?\.focus\(\);\s*else if \(action === 'focus-inline'\) input\?\.focus\(\);\s*else openPalette\(\);/);

  // The drawer keeps Command for this job; CommandTrigger is that button alone.
  const trigger = read('components/CommandTrigger.svelte');
  assert.doesNotMatch(trigger, /variant|'header'|'fab'/, 'no header or fab variant, no variant prop');
  assert.match(trigger, /let \{ job \}: \{ job: string \| null \} = \$props\(\);/);
  const drawer = read('components/Drawer.svelte');
  assert.equal(drawer.match(/<CommandTrigger\b/g)?.length, 1, 'the drawer header has one "Command for this job"');
  assert.ok(drawer.includes('{#if scopeVerbs(j).length}<CommandTrigger job={j.id} />{/if}'), 'only for a job with something to command');

  // The palette starts from the sidebar input's text, caret at the end.
  const palette = read('lib/palette.svelte.ts');
  assert.match(palette, /text = \$state\(''\);/);
  assert.match(palette, /export function openPalette\(opts: \{ scope\?: string \| null; opener\?: HTMLElement \| null; text\?: string \} = \{\}\): void/);
  assert.match(palette, /palette\.text = opts\.text \?\? '';/);
  const cmd = read('components/CommandBar.svelte');
  assert.match(cmd, /let text = \$state\(untrack\(\(\) => palette\.text\)\);/);
  assert.match(cmd, /input\?\.focus\(\);\s*input\?\.setSelectionRange\(text\.length, text\.length\);/);
});

test('one close control: drawer, dialogs and toast', () => {
  const close = elements('components/CloseButton.svelte');
  const button = close.find((e) => e.name === 'button');
  assert.ok(button && has(button, 'btn', 'icon', 'ghost'), `CloseButton renders a btn icon ghost button (${button?.classes.join(' ')})`);
  assert.ok(button.classes.includes('sm'), "the sm modifier is one of its class literals ({size === 'sm' ? 'sm' : ''})");
  assert.match(read('components/CloseButton.svelte'), /class="btn icon ghost shrink-0 \{size === 'sm' \? 'sm' : ''\} \{cls\}"/, 'sm only for size="sm"');
  assert.equal(attrOf(button, 'aria-label'), '{label}');
  assert.equal(attrOf(button, 'type'), 'button');
  assert.equal(button.first?.name, 'Icon', 'it holds the close icon');

  const uses: [string, number, string | null][] = [
    ['components/Drawer.svelte', 1, 'sm'],
    ['components/Settings.svelte', 1, null],
    ['components/CommandBar.svelte', 2, null],
    ['components/Toast.svelte', 1, 'sm'],
    ['components/Popover.svelte', 1, 'sm'],
  ];
  for (const [rel, count, size] of uses) {
    const found = elements(rel).filter((e) => e.name === 'CloseButton');
    assert.equal(found.length, count, `${rel} renders ${count} <CloseButton>`);
    assert.ok(found.every((e) => attrOf(e, 'label')), `${rel}: every CloseButton is labelled`);
    if (size) assert.ok(found.every((e) => attrOf(e, 'size') === size), `${rel}: its CloseButton is ${size}`);
  }
  const bar = elements('components/CommandBar.svelte').filter((e) => e.name === 'CloseButton');
  assert.deepEqual(bar.map((e) => attrOf(e, 'size') || 'md').sort(), ['md', 'sm'], 'the palette: an md phone close and an sm clear-scope');
  assert.ok(bar.some((e) => attrOf(e, 'class') === 'md:hidden'), 'the phone close hides from md up');
  const scope = elements('components/CommandBar.svelte').find((e) => attrOf(e, 'id') === 'command-scope');
  assert.ok(scope && has(scope, 'chip', 'gleam', 'sm'), 'the scope chip is sm, beside its sm clear button');

  for (const rel of svelteFiles().filter((f) => f !== 'components/CloseButton.svelte'))
    assert.doesNotMatch(read(rel), /<Icon name="close"/, `${rel} draws no close icon of its own`);

  // AC7: Dismiss sits outside the live region, which is always rendered and holds only the message.
  const toast = elements('components/Toast.svelte');
  const status = toast.filter((e) => attrOf(e, 'role') === 'status');
  assert.equal(status.length, 1, 'one live region');
  assert.ok(attrOf(status[0], 'aria-live') && attrOf(status[0], 'aria-atomic') === 'true', 'it is a live region');
  const dismiss = toast.find((e) => e.name === 'CloseButton');
  assert.ok(dismiss && !dismiss.parents.includes(status[0]), 'Dismiss is not inside role="status"');
  assert.equal(attrOf(dismiss, 'label'), "{$t('common.dismiss')}");
  assert.equal(attrOf(dismiss, 'onclick'), '{dismissToast}');
  // The toast plate clips to its cut corner, so Dismiss draws its focus ring inside itself.
  assert.equal(attrOf(dismiss, 'class'), 'focus-visible:-outline-offset-2', 'Dismiss keeps its ring inside the plate');
  const markup = read('components/Toast.svelte').replace(/<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, '');
  const live = markup.indexOf('role="status"');
  const before = markup.slice(0, live);
  assert.ok(live > 0 && (before.match(/\{#(if|each|key|await)\b/g) ?? []).length === (before.match(/\{\/(if|each|key|await)\}/g) ?? []).length, 'no open block wraps the live region: it is always in the DOM');
  const root = toast.find((e) => attrOf(e, 'id') === 'toast');
  assert.ok(root && clears(root), '#toast sits above the status bar at every width');
  for (const [ev, fn] of [['onmouseenter', 'holdToast'], ['onmouseleave', 'releaseToast'], ['onfocusin', 'holdToast'], ['onfocusout', 'releaseToast']])
    assert.equal(attrOf(root, ev), `{${fn}}`, `#toast ${ev} → ${fn}`);
  const state = read('lib/toast.svelte.ts');
  for (const fn of ['holdToast', 'releaseToast', 'dismissToast']) assert.match(state, new RegExp(`export function ${fn}\\(`), `toast.svelte.ts exports ${fn}`);
  assert.match(state, /opener\?\.isConnected\) opener\.focus\(\)/, 'a dismiss returns focus to a still-connected opener');
});

test('controls in one row share one size', () => {
  // Page headers are md: no view's right snippet holds an sm control.
  const views = fs.readdirSync(path.join(SRC, 'views')).filter((f) => f.endsWith('.svelte'));
  let rights = 0;
  for (const v of views) {
    const text = read(`views/${v}`);
    const at = text.indexOf('{#snippet right()}');
    if (at < 0) continue;
    rights++;
    const body = text.slice(at + '{#snippet right()}'.length, text.indexOf('{/snippet}', at));
    for (const el of elements(`views/${v}`, body)) assert.ok(!el.classes.includes('sm'), `${v}: <${el.name} class="${el.classes.join(' ')}"> in the page header is md`);
  }
  assert.ok(rights >= 4, `checked ${rights} page header snippets`);
  const pipeline = elements('views/Pipeline.svelte').filter((e) => e.name === 'button' && attrOf(e, 'aria-pressed'));
  assert.equal(pipeline.length, 2, "the Pipeline's two segs");
  for (const b of pipeline) assert.ok(b.classes.includes('btn') && !b.classes.includes('sm'), `a Pipeline seg is btn (${b.classes.join(' ')})`);
  const right = elements('components/PageHeader.svelte').filter((e) => e.name === 'div').at(-1);
  assert.ok(right && right.classes.includes('gap-2') && !right.classes.includes('gap-2.5'), `PageHeader's right container uses gap-2 (${right?.classes.join(' ')})`);

  // The Daemon popover and the session log are sm rows: their chips and fields take chip sm and input sm. The Foreman
  // row's tag is a word inside the row's name, not a control beside it, so it keeps the chip's own height.
  const daemonChips = elements('components/statusbar/DaemonPanel.svelte').filter((e) => e.classes.includes('chip') && !e.classes.includes('live'));
  assert.ok(daemonChips.length >= 2, `checked ${daemonChips.length} Daemon popover chips (the pool pill and the row pill)`);
  for (const c of daemonChips) assert.ok(c.classes.includes('sm'), `DaemonPanel: <${c.name} class="${c.classes.join(' ')}"> is chip sm`);
  const log = elements('components/SessionLog.svelte');
  const pill = log.find((e) => attrOf(e, 'role') === 'status' && e.classes.includes('chip'));
  assert.ok(pill?.classes.includes('sm'), 'the session pill is chip sm');
  const search = log.find((e) => e.name === 'input' && attrOf(e, 'type') === 'search');
  assert.ok(search && has(search, 'input', 'sm'), 'the session filter is input sm');
  assert.ok(!log.some((e) => e.name === 'select'), 'no select: Permissions and Effort are popover buttons');
  const menuTrigger = elements('components/MenuButton.svelte').find((e) => e.name === 'button');
  assert.ok(menuTrigger && has(menuTrigger, 'btn', 'sm'), `the log's popover buttons are btn sm (${menuTrigger?.classes.join(' ')})`);
  for (const b of log.filter((e) => e.name === 'button')) assert.ok(has(b, 'btn', 'sm'), `SessionLog: <button class="${b.classes.join(' ')}"> is btn sm`);

  // The issue chooser's other-ref Link sits beside an md input.
  const other = elements('components/IssueLinkActions.svelte').find((e) => e.name === 'button' && attrOf(e, 'disabled') === '{!otherRef}');
  assert.ok(other && other.classes.includes('btn') && !other.classes.includes('sm'), `the other-ref button is btn (${other?.classes.join(' ')})`);

  // The Needs-you PR row: two sm buttons in a gap-2 flex, not a literal space.
  const inbox = elements('components/statusbar/NeedsPanel.svelte');
  const open = inbox.find((e) => e.name === 'a' && e.classes.includes('btn'));
  const cell = open?.parents.at(-1);
  assert.ok(cell && cell.name === 'div' && has(cell, 'flex', 'gap-2'), `the PR-row buttons share a gap-2 flex (${cell?.classes.join(' ')})`);
  assert.equal(inbox.filter((e) => e.parents.at(-1) === cell && e.classes.includes('btn')).length, 2, 'both buttons sit in it');

  const dock = elements('components/ActionDock.svelte').find((e) => e.name === 'div' && e.first?.name === 'button' && e.first.classes.includes('primary'));
  assert.ok(dock && dock.classes.includes('gap-2') && !dock.classes.includes('gap-3'), 'the resume row uses gap-2');
  const unsaved = elements('components/settings/ConfigTab.svelte').find((e) => has(e, 'chip', 'you'));
  assert.ok(unsaved?.classes.includes('sm'), 'the unsaved chip sits in the save row as chip sm');
  // The phone rule gives every button 44px; a btn needs no min-h-11 of its own.
  for (const rel of ['components/settings/AboutTab.svelte', 'components/settings/ConfigTab.svelte', 'components/settings/DiagnosticsTab.svelte'])
    for (const el of elements(rel).filter((e) => e.classes.includes('btn'))) assert.ok(!el.classes.includes('min-h-11'), `${rel}: a btn carries no min-h-11`);
});

// ---------- the status bar ----------

/** The markup inside `{#if <cond>}` up to its matching `{/if}` (nested blocks counted), or null when there is no such block. */
function ifBody(text: string, cond: string): string | null {
  const open = `{#if ${cond}}`;
  const at = text.indexOf(open);
  if (at < 0) return null;
  let depth = 1;
  const re = /\{#if\b|\{\/if\}/g;
  re.lastIndex = at + open.length;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    depth += m[0] === '{/if}' ? -1 : 1;
    if (depth === 0) return text.slice(at + open.length, m.index);
  }
  return null;
}

/** No `{#if}`/`{#each}`/`{#key}`/`{#await}` is open at `at`: what is there is always in the DOM. */
function unconditional(text: string, at: number): boolean {
  const before = text.slice(0, at);
  return (before.match(/\{#(if|each|key|await)\b/g) ?? []).length === (before.match(/\{\/(if|each|key|await)\}/g) ?? []).length;
}

/** Clears the status bar: one class names the bar's height token and the safe-area inset. */
const clears = (el: El) => el.classes.some((c) => c.includes('var(--size-statusbar)') && c.includes('env(safe-area-inset-bottom)'));
const markupOf = (rel: string) => read(rel).replace(/<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, '');

test('status bar: one fixed footer in the inert shell, outside main', () => {
  const app = read('App.svelte');
  assert.equal(app.match(/<StatusBar\b/g)?.length, 1, 'App renders the status bar once');
  const use = elements('App.svelte').find((e) => e.name === 'StatusBar');
  assert.ok(use, 'the StatusBar element');
  const shell = use.parents.find((p) => p.name === 'div' && attrOf(p, 'inert') === '{settingsOpen || palette.open}');
  assert.ok(shell && has(shell, 'flex', 'min-h-screen'), 'inside the shell div whose inert covers Settings and the palette');
  assert.ok(!use.parents.some((p) => p.name === 'main'), 'outside main, whose falloff isolates');
  assert.doesNotMatch(app, /DaemonBar/, 'App imports no DaemonBar');
  assert.doesNotMatch(app, /CommandTrigger/, 'nor CommandTrigger');
  assert.ok(!fs.existsSync(path.join(SRC, 'components', 'DaemonBar.svelte')), 'DaemonBar.svelte is gone');

  const bar = elements('components/StatusBar.svelte');
  const footers = bar.filter((e) => e.name === 'footer');
  assert.equal(footers.length, 1, 'one footer');
  const footer = footers[0];
  assert.equal(attrOf(footer, 'id'), 'statusbar');
  for (const c of ['fixed', 'bottom-0', 'right-0', 'left-0', 'md:left-(--size-sidebar)', 'z-35', 'chrome']) assert.ok(footer.classes.includes(c), `footer#statusbar has ${c}`);
  assert.ok(footer.classes.some((c) => c.startsWith('pb-') && c.includes('env(safe-area-inset-bottom)')), 'its bottom padding is the safe-area inset');
  assert.ok(footer.classes.some((c) => c.startsWith('h-') && c.includes('var(--size-statusbar)') && c.includes('env(safe-area-inset-bottom)')), 'its height is the token plus the inset');

  // 30px tall from md up: the token, plus the inset.
  assert.ok(fs.readFileSync(path.join(ROOT, 'dashboard', 'style.css'), 'utf8').includes('--size-statusbar: 30px;'), 'the bar is 30px');
  // No spend chip: the month's spend lives on Analytics.
  assert.doesNotMatch(read('components/StatusBar.svelte'), /SpendChip/, 'StatusBar imports and renders no SpendChip');
  assert.ok(!fs.existsSync(path.join(SRC, 'components', 'SpendChip.svelte')), 'SpendChip.svelte is gone');
  // Two live dots, the Foreman's (on while the office works and the daemon runs) and the daemon indicator's (on
  // exactly when a session works); no Inbox indicator at all; holds and waits from md up.
  const markup = markupOf('components/StatusBar.svelte');
  const dots = bar.filter((e) => e.name === 'LiveDot');
  assert.deepEqual(dots.map((d) => attrOf(d, 'on')), ['{bar.foreman.daemon && bar.foreman.active}', '{bar.daemon.active}'], "the Foreman's dot and the daemon's dot");
  for (const d of dots) assert.ok(d.parents.includes(footer));
  assert.equal(ifBody(markup, 'bar.inbox'), null, 'no {#if bar.inbox}');
  assert.doesNotMatch(markup, /openPopover\('inbox'|data-popover="inbox"/, 'no Inbox indicator, whether the daemon is on or off');
  for (const [cond, msg] of [['bar.held', 'daemon.held'], ['bar.waiting', 'daemon.waiting']]) {
    const body = ifBody(markup, cond);
    assert.ok(body, `{#if ${cond}}`);
    const button = elements('components/StatusBar.svelte', body).find((e) => e.name === 'button');
    assert.ok(button?.classes.includes('max-md:hidden'), `${cond}: its button is max-md:hidden`);
    assert.match(attrOf(button!, 'onclick'), /openPopover\('daemon', e\.currentTarget\)/, `${cond} opens the Daemon popover`);
    assert.ok(body.includes(`$t('${msg}'`), `${cond} says ${msg}`);
  }
});

test('popovers: labelled dialogs outside the bar, opened by labelled buttons', () => {
  // AC14: the dialog.
  const pop = elements('components/Popover.svelte');
  const dialogs = pop.filter((e) => attrOf(e, 'role') === 'dialog');
  assert.equal(dialogs.length, 1, 'one role="dialog"');
  const dialog = dialogs[0];
  assert.equal(attrOf(dialog, 'aria-labelledby'), 'popover-{id}-title', 'labelled by its heading');
  assert.equal(attrOf(dialog, 'tabindex'), '-1', 'focusable, so its label is announced on open');
  assert.equal(attrOf(dialog, 'id'), 'popover-{id}');
  assert.ok(!dialog.attrs.some((a) => a.name === 'aria-modal'), 'non-modal');
  for (const c of ['plate', 'solid', 'fixed', 'z-42']) assert.ok(dialog.classes.includes(c), `the popover has ${c}`);
  assert.ok(dialog.classes.some((c) => c.startsWith('bottom-') && c.includes('var(--size-statusbar)') && c.includes('env(safe-area-inset-bottom)') && c.includes('var(--space-1)') && !c.includes('var(--space-2)')), 'it sits --space-1 above the bar');
  assert.ok(dialog.classes.some((c) => c.startsWith('max-h-') && c.includes('100dvh') && c.includes('var(--size-statusbar)')), 'it scrolls inside the room above the bar');
  assert.ok(dialog.classes.some((c) => c.startsWith('max-h-[min(40rem,') && c.includes('100dvh') && c.includes('var(--size-statusbar)')), 'a non-chat popover is capped at 40rem');
  assert.match(read('components/Popover.svelte'), /\{chat \? 'max-h-\[calc\(100dvh[^']*\]' : 'max-h-\[min\(40rem,calc\(100dvh[^']*\]'\}/, 'the cap applies only when not chat, as one whole-literal ternary');
  const heading = pop.find((e) => e.name === 'h2');
  assert.equal(attrOf(heading!, 'id'), 'popover-{id}-title');
  const close = pop.filter((e) => e.name === 'CloseButton');
  assert.equal(close.length, 1, 'one close button');
  assert.equal(attrOf(close[0], 'size'), 'sm');
  const script = read('components/Popover.svelte');
  assert.match(script, /document\.addEventListener\('pointerdown', down, true\)/, 'a capture-phase pointerdown while open');
  assert.match(script, /document\.removeEventListener\('pointerdown', down, true\);/, 'removed on destroy');
  assert.match(script, /document\.addEventListener\('focusin', focusIn, true\)/, 'focus that lands outside later closes it too');
  assert.match(script, /closePopover\('outside', \{ targetFocusable: target\.closest\(FOCUSABLE\) !== null \}\)/, 'a press on anything that takes focus (a select, the heading) keeps it');
  assert.match(script, /closePopover\('focusout', \{ relatedInside: to === null \? null : within\(to\) \}\)/, 'no relatedTarget is null, never outside');
  assert.match(script, /if \(to === null\) keepFocus\(\);/, 'a control that disabled itself or went away hands focus back to the dialog');
  // Tab moves through it as if it sat right after its indicator.
  assert.match(script, /if \(at === el \|\| at === items\[0\]\) \{\s*e\.preventDefault\(\);\s*closePopover\('close'\);/, 'Shift+Tab before its first stop goes back to the indicator');
  assert.match(script, /back\.compareDocumentPosition\(x\) & Node\.DOCUMENT_POSITION_FOLLOWING/, 'Tab past its last stop goes on from the indicator');
  assert.match(script, /const back = anchor;[\s\S]*?closePopover\('focusout', \{ relatedInside: false \}\);[\s\S]*?\(next \?\? back\)\.focus\(\);/, 'with nothing after the indicator, back to it (read before closing clears the prop), never the body');
  assert.match(script, /const items = \[\.\.\.el\.querySelectorAll<HTMLElement>\(TAB_STOPS\)\]/, 'its stops include summaries and selects (the Inbox log rows)');
  assert.match(script, /document\.querySelectorAll<HTMLElement>\(TAB_STOPS\)\]\.find\(/, 'and so does the stop after the indicator');
  const scroller = pop.find((e) => attrOf(e, 'bind:this') === '{body}');
  assert.ok(scroller && scroller.classes.includes('overflow-y-auto'), 'the scrolling body');
  assert.equal(attrOf(scroller, 'tabindex'), '{scrollable ? 0 : undefined}', 'it takes focus only while it scrolls');
  assert.equal(attrOf(scroller, 'aria-labelledby'), '{scrollable ? `popover-${id}-title` : undefined}');

  // AC4: the popover is a sibling after the bar, never inside the fixed footer's stacking context.
  const bar = elements('components/StatusBar.svelte');
  const footer = bar.find((e) => e.name === 'footer')!;
  const popovers = bar.filter((e) => e.name === 'Popover');
  assert.equal(popovers.length, 1, 'one Popover');
  assert.ok(!popovers[0].parents.includes(footer), 'not a descendant of footer#statusbar');

  // Every indicator is a labelled button that opens a dialog and says whether it is open.
  const indicators = bar.filter((e) => e.name === 'button' && /openPopover\(/.test(attrOf(e, 'onclick')));
  assert.equal(indicators.length, 7, 'needs, foreman, daemon, held, waiting, model, connection');
  for (const b of indicators) {
    assert.ok(b.parents.includes(footer), 'inside the bar');
    assert.equal(attrOf(b, 'aria-haspopup'), 'dialog');
    assert.ok(attrOf(b, 'aria-expanded'), 'aria-expanded');
    assert.ok(attrOf(b, 'aria-controls'), 'aria-controls while open');
    // Every icon button carries its tooltip at every width and fit level; held and waiting are text buttons, titled only
    // while their reason is hidden.
    const id = attrOf(b, 'data-popover');
    if (b.classes.includes('max-md:hidden')) assert.match(attrOf(b, 'title'), /\? .* : undefined\}$/, 'held and waiting: a tooltip only while the reason is hidden');
    else assert.equal(attrOf(b, 'title'), `{titles.${id}}`, `the ${id} indicator's tooltip is unconditional`);
    assert.ok(!b.attrs.some((a) => a.name === 'aria-label'), 'no aria-label: the name comes from the content, sr-only parts included');
    assert.ok(!b.classes.includes('truncate') && !b.classes.includes('min-w-0'), 'labels are whole or hidden, never cut');
    assert.ok(/^(foreman|needs|daemon|model|connection)$/.test(attrOf(b, 'data-popover')), 'data-popover names the popover it opens');
    // Below md every visible indicator is a 44x44 target with its ring drawn inside the 44px bar.
    if (!b.classes.includes('max-md:hidden')) for (const c of ['max-md:min-w-11', 'max-md:focus-visible:-outline-offset-2']) assert.ok(b.classes.includes(c), `the ${attrOf(b, 'data-popover')} indicator has ${c}`);
  }
  assert.equal(indicators.filter((b) => !b.classes.includes('max-md:hidden')).length, 5, 'needs, foreman, daemon, model and connection show below md');
  assert.deepEqual(indicators.map((b) => /openPopover\('(\w+)'/.exec(attrOf(b, 'onclick'))?.[1]), ['needs', 'foreman', 'daemon', 'daemon', 'daemon', 'model', 'connection'], 'in tab order: the bell first');
  assert.equal(attrOf(indicators[0], 'bind:this'), '{needsButton}', 'the first is the Needs-you bell');
  // The Foreman: always rendered once the state loads, accented rather than ghost.
  const foremanButton = indicators[1];
  assert.ok(has(foremanButton, 'btn', 'sm', 'foreman') && !foremanButton.classes.includes('ghost'), `the Foreman carries the foreman accent, not ghost (${foremanButton.classes.join(' ')})`);
  assert.deepEqual(openBlocksAt(read('components/StatusBar.svelte'), 'data-popover="foreman"'), [['#if S.data']], 'it sits outside every {#if} but {#if S.data}');
  assert.ok(bar.some((e) => e.name === 'Icon' && attrOf(e, 'name') === 'foreman' && e.parents.includes(foremanButton)), 'with the foreman icon');
  // The Daemon: the Foreman's pair, in the same accent, dashed while off, with its glyph at every width.
  const daemonButton = indicators[2];
  assert.equal(attrOf(daemonButton, 'data-popover'), 'daemon');
  assert.ok(has(daemonButton, 'btn', 'sm', 'foreman') && !daemonButton.classes.includes('ghost'), `the Daemon carries the foreman accent, not ghost (${daemonButton.classes.join(' ')})`);
  const svelteText = read('components/StatusBar.svelte');
  assert.ok(svelteText.includes(`<button class="btn sm foreman {bar.foreman.on ? '' : 'off'} `), 'the Foreman goes dashed while off');
  assert.ok(svelteText.includes(`<button class="btn sm foreman {bar.daemon.off ? 'off' : ''} `), 'and so does the Daemon');
  const daemonIcon = bar.find((e) => e.name === 'Icon' && attrOf(e, 'name') === 'daemon' && e.parents.includes(daemonButton));
  assert.ok(daemonIcon, 'with the daemon icon');
  const iconSpan = daemonIcon.parents.at(-1)!;
  assert.equal(iconSpan.name, 'span');
  assert.ok(!iconSpan.classes.includes('md:hidden') && !/left >=|holdsOut/.test(attrOf(iconSpan, 'class')), `the glyph shows at every width and level (${attrOf(iconSpan, 'class')})`);
  // The one exception is the focus fact, which opens the focused job's drawer (a panel, not a popover).
  for (const b of bar.filter((e) => e.name === 'button' && e.parents.includes(footer) && attrOf(e, 'id') !== 'footer-focus')) assert.equal(attrOf(b, 'aria-haspopup'), 'dialog', 'every bar button opens a dialog');
  const focusFact = bar.filter((e) => e.name === 'button' && attrOf(e, 'id') === 'footer-focus');
  assert.equal(focusFact.length, 1, 'the focus fact is a button');
  assert.equal(attrOf(focusFact[0], 'onclick'), '{() => openDrawer(focus.id)}', 'it opens the focused job');
  assert.equal(attrOf(focusFact[0], 'aria-haspopup'), '', 'and claims no popup');
  const script2 = read('components/StatusBar.svelte');
  assert.match(script2, /popover\.open === id \? `popover-\$\{id\}` : undefined/, 'aria-controls names the popover only while it is open');

  // No live region of their own: the bar holds the one.
  for (const rel of ['components/Popover.svelte', ...fs.readdirSync(path.join(SRC, 'components', 'statusbar')).map((f) => `components/statusbar/${f}`)]) {
    const text = read(rel);
    assert.doesNotMatch(text, /aria-live/, `${rel} has no aria-live`);
    assert.doesNotMatch(text, /role="status"/, `${rel} has no role="status"`);
  }
  assert.equal(fs.readdirSync(path.join(SRC, 'components', 'statusbar')).sort().join(' '), 'ConnectionPanel.svelte DaemonPanel.svelte ForemanPanel.svelte ModelPanel.svelte NeedsPanel.svelte');

  // AC8: one polite live region, always in the DOM, fed by promptAnnouncement and the permission heading.
  const live = bar.filter((e) => e.attrs.some((a) => a.name === 'aria-live'));
  assert.equal(live.length, 1, 'one aria-live element in the bar');
  assert.equal(attrOf(live[0], 'aria-live'), 'polite');
  assert.ok(live[0].parents.includes(footer) && live[0].classes.includes('sr-only'), 'visually hidden, inside the bar');
  const markup = markupOf('components/StatusBar.svelte');
  assert.ok(unconditional(markup, markup.indexOf('aria-live="polite"')), 'outside every {#if}: it is always in the DOM');
  assert.match(markup, /aria-live="polite">\{announcement\}<\/div>/);
  assert.match(script2, /const say = promptAnnouncement\(lastPrompts, next\);/);
  assert.match(script2, /\$t\('permission\.heading', \{ count: say \}\)/);

  // AC8: the Needs-you popover lists every prompt in the pool first, only while one is pending, then the decisions.
  const needs = elements('components/statusbar/NeedsPanel.svelte');
  const prompts = needs.filter((e) => e.name === 'PermissionPrompts');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].attrs.length, 0, '<PermissionPrompts /> takes no scope: the whole pool');
  const needsMarkup = markupOf('components/statusbar/NeedsPanel.svelte');
  assert.ok(ifBody(needsMarkup, 'prompts')?.includes('<PermissionPrompts />'), 'inside {#if prompts}');
  assert.ok(needsMarkup.indexOf('<PermissionPrompts') < needsMarkup.indexOf('id="needs-urgent"'), 'before the decisions');
  const needsText = read('components/statusbar/NeedsPanel.svelte');
  assert.match(needsText, /const prompts = \$derived\(pendingPrompts\(S\.data\?\.daemons \?\? null\)\.length\);/, 'the same source PermissionPrompts reads');
  assert.match(needsText, /\{#if groups\.urgent\.length\}[\s\S]*?\{:else if prompts\}\s*<p class="text-sm text-muted">\{\$t\('needs\.noDecisions'\)\}<\/p>\s*\{:else\}\s*<p class="text-sm text-muted">\{\$t\('needs\.empty'\)\}<\/p>/, 'Nothing needs you only with no decisions and no prompts; No decisions waiting with prompts alone');
  assert.equal(fs.existsSync(path.join(SRC, 'components', 'statusbar', 'InboxPanel.svelte')), false, 'the Inbox popover is gone');
});

test('the view, the toast and the drawer clear the status bar', () => {
  const view = elements('App.svelte').find((e) => attrOf(e, 'id') === 'view');
  assert.ok(view && clears(view) && view.classes.some((c) => c.startsWith('pb-')), '#view pads its bottom by the bar and the inset');
  for (const c of ['pb-24', 'md:pb-6']) assert.ok(!view.classes.includes(c), `#view drops ${c}`);
  const toast = elements('components/Toast.svelte').find((e) => attrOf(e, 'id') === 'toast');
  assert.ok(toast && clears(toast) && toast.classes.some((c) => c.startsWith('bottom-')), '#toast sits above the bar and the inset');
  for (const c of ['bottom-24', 'md:bottom-4']) assert.ok(!toast.classes.includes(c), `#toast drops ${c}`);
  assert.ok(toast.classes.includes('z-50'), 'the toast stays z-50');

  // At every width the drawer ends at the bar's top edge: fixed, its bottom is the bar's top. The backdrop (z-30)
  // dims everything behind it but the bar (z-35), which sits under the drawer (z-40).
  const drawer = elements('components/Drawer.svelte');
  const aside = drawer.find((e) => e.name === 'aside' && attrOf(e, 'id') === 'drawer');
  assert.ok(aside, 'aside#drawer');
  assert.ok(aside.classes.includes('bottom-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom))]'), 'it stops at the bar');
  assert.ok(aside.classes.includes('z-40'), 'the drawer is z-40');
  assert.ok(!aside.classes.includes('h-dvh'), 'it never covers the bar');
  const backdrop = drawer.find((e) => attrOf(e, 'id') === 'drawer-backdrop');
  assert.ok(backdrop && has(backdrop, 'fixed', 'inset-0', 'backdrop', 'z-30'), 'a z-30 backdrop');
  const footer = elements('components/StatusBar.svelte').find((e) => e.name === 'footer');
  assert.ok(footer?.classes.includes('z-35'), 'the bar sits between them');
});

test('the daemon popover keeps every daemon bar control', () => {
  // The bar owns the pool, pending and act(), so the indicator and the popover agree; the popover gets act().
  const bar = read('components/StatusBar.svelte');
  assert.match(bar, /import \{[^}]*\bmergePoolState\b[^}]*\bpostDaemon\b[^}]*\} from '\.\.\/lib\/daemon\.ts';/, 'postDaemon and mergePoolState from lib/daemon.ts');
  assert.match(bar, /await postDaemon\(action, forgeToken\(\)\)/, 'Start and Stop post through postDaemon with the token');
  assert.match(bar, /pool = mergePoolState\(pool, st\)/);
  assert.match(bar, /toast\(\$t\('daemon\.failed'/, 'a failed Start or Stop toasts');
  assert.match(bar, /<DaemonPanel \{model\} \{pending\} \{act\} foreman=\{bar\.foreman\} \{openForeman\} \/>/);
  const panel = read('components/statusbar/DaemonPanel.svelte');
  for (const [rel, text] of [['StatusBar', bar], ['DaemonPanel', panel]]) assert.doesNotMatch(text, /\bfetch\(/, `${rel} calls no fetch(`);
  // The Inbox session log lives here, under the session list, with its saved state.
  assert.match(panel, /import \{ LOG_KEY \} from '\.\.\/\.\.\/lib\/daemon-log\.ts';/);
  assert.equal(LOG_KEY, 'forge.daemonLog', 'the toggle keeps its saved state');
  assert.match(panel, /localStorage\.getItem\(LOG_KEY\) === '1'/);
  assert.match(panel, /localStorage\.setItem\(LOG_KEY, inboxOpen \? '1' : '0'\)/);
  const markup = markupOf('components/statusbar/DaemonPanel.svelte');
  assert.equal(markup.match(/<SessionLog\b/g)?.length, 1);
  assert.ok(ifBody(markup, 'inboxOpen')?.includes('<SessionLog scope={INBOX_SCOPE} compact />'), 'the inbox session log renders only while the toggle is on');
  const on = ifBody(markup, 'model') ?? '';
  assert.ok(on.slice(0, on.lastIndexOf('{:else}')).includes('toggleInbox'), 'only while the daemon is on (the {#if model} branch)');
  assert.ok(!on.slice(on.lastIndexOf('{:else}')).includes('toggleInbox'), 'the daemon-off branch is unchanged');
  assert.ok(markup.indexOf('</ul>') < markup.indexOf('toggleInbox'), 'after the session list');
  const toggle = elements('components/statusbar/DaemonPanel.svelte').find((e) => attrOf(e, 'onclick') === '{toggleInbox}');
  assert.ok(toggle && has(toggle, 'btn', 'sm') && attrOf(toggle, 'aria-expanded'), 'the Inbox session log toggle is a btn sm with aria-expanded');
  for (const icon of ['play', 'stop']) assert.ok(panel.includes(`<Icon name="${icon}" />`), `the ${icon} icon`);
  assert.match(panel, /disabled=\{!model\.canStart\} title=\{model\.startHint\} aria-label=\{\$t\('daemon\.startAll'\)\}/, 'Start follows canStart and carries the config hint');
  assert.match(panel, /disabled=\{!model\.canStop\} aria-label=\{\$t\('daemon\.stopAll'\)\}/);
  for (const chip of ['daemon.held', 'daemon.waiting', 'daemon.kept']) assert.ok(!panel.includes(`$t('${chip}'`), `no ${chip} chip: the rows say it`);
  assert.match(markup, /\{#if model\.error !== null\}<p[^>]*>\{model\.error\}<\/p>\{\/if\}/, 'the pool error renders as text');
  assert.doesNotMatch(panel, /\{@html/);
  assert.match(panel, /closePopover\('navigate'\);\s*openDrawer\(id, null, 'log'\);/, 'a job row closes the popover, then opens that job on its session log');
  assert.match(markup, /\$t\('statusbar\.daemon\.disabled'\)/, 'the daemon-off explanation');
});

test('the model popover is read-only', () => {
  const panel = read('components/statusbar/ModelPanel.svelte');
  for (const banned of ['<select', '<input', 'postConfig', 'fetch(']) assert.ok(!panel.includes(banned), `ModelPanel has no ${banned}`);
  assert.match(panel, /import \{[^}]*\bloadRoster\b[^}]*\} from '\.\.\/\.\.\/lib\/app\.svelte\.ts';/);
  assert.match(panel, /onMount\(\(\) => \{[\s\S]*?loadRoster\(\)/, 'fetched each time it opens');
  for (const key of ['loading', 'failed', 'noReviewers']) assert.ok(panel.includes(`$t('statusbar.model.${key}'`), `the ${key} state`);
  assert.match(read('lib/app.svelte.ts'), /export async function loadRoster\(\): Promise<void> \{\s*S\.roster = await api<Roster>\('\/api\/roster'\);/, 'GET /api/roster, the error left to the caller');
});

test('status bar labels are whole or sr-only, never cut', () => {
  const bar = elements('components/StatusBar.svelte');
  const script = read('components/StatusBar.svelte');
  // Each cluster clips sideways, keeps 4px for the focus ring at every width, and holds a max-content row it measures.
  for (const [box, row] of [['{leftBox}', '{leftRow}'], ['{rightBox}', '{rightRow}']]) {
    const cluster = bar.find((e) => attrOf(e, 'bind:this') === box);
    assert.ok(cluster && has(cluster, 'overflow-x-clip', 'px-1'), `${box} clips sideways with px-1 at every width (${cluster?.classes.join(' ')})`);
    assert.ok(!cluster.classes.includes('md:px-1'), `${box}: the padding is not md-only`);
    const inner = bar.find((e) => attrOf(e, 'bind:this') === row);
    assert.ok(inner && inner.classes.includes('w-max') && inner.parents.includes(cluster), `${row} is a max-content row inside ${box}`);
  }
  assert.ok(!bar.some((e) => e.parents.some((p) => attrOf(p, 'bind:this') === '{leftRow}' || attrOf(p, 'bind:this') === '{rightRow}') && e.classes.includes('truncate')), 'no indicator text truncates');
  // The fit loop steps one level of text at a time to sr-only, from whole labels, until the row fits.
  assert.match(script, /left = 0;\s*right = 0;\s*facts = 0;\s*await tick\(\);/, 'every fit starts from whole labels');
  assert.match(script, /while \(me === fitting && facts < FACTS_MAX && cut\(factsBox\)\) \{\s*facts\+\+;\s*await tick\(\);/, 'the facts drop first, while the strip is cut');
  assert.ok(script.indexOf('facts < FACTS_MAX') < script.indexOf('left < LEFT_MAX'), 'before either cluster sheds a word');
  assert.match(script, /while \(me === fitting && left < LEFT_MAX && overflows\(leftBox, leftRow\)\) \{\s*left\+\+;\s*await tick\(\);/);
  assert.match(script, /while \(me === fitting && right < RIGHT_MAX && overflows\(rightBox, rightRow\)\) \{\s*right\+\+;\s*await tick\(\);/);
  assert.doesNotMatch(script, /cmdLabel|MID_MAX|\bmid\b/, 'no palette button gives way: the bar has none');
  assert.match(script, /const ro = new ResizeObserver\(\(\) => fit\(\)\);\s*ro\.observe\(footer\);/, 'a resize refits');
  assert.match(script, /document\.fonts\?\.ready\.then\(\(\) => fit\(\)\)/, 'so does the fonts arriving');
  // The levels, in the order the text goes.
  const markup = markupOf('components/StatusBar.svelte');
  for (const [cut, what] of [
    [`<span class={left >= 1 ? 'sr-only' : ''}>{$t('statusbar.daemon.title')}`, 'level 1: the "Daemon" word'],
    [`{$t('statusbar.held.word')}<span class={left >= 2 ? 'sr-only' : ''}>{$t('statusbar.held.rest')}</span>`, 'level 2: why a job is held'],
    [`{$t('statusbar.waiting.word')}<span class={left >= 2 ? 'sr-only' : ''}>{$t('statusbar.waiting.rest')}</span>`, 'level 2: what a job waits for'],
    [`<button class="btn sm ghost max-md:hidden {left >= 3 ? 'hidden!' : ''}"`, 'level 3: held and waiting'],
    [`{#if holdsOut}<span class="sr-only">{', '}{holdText}</span>{/if}`, 'level 3: the Daemon indicator names them'],
    [`<span class="inline-flex {TONE_TEXT[daemonTone]}"><Icon name="daemon" /></span>`, 'and its glyph, always shown, goes warn while they are out of sight'],
    [`<span class="max-md:sr-only {left >= 4 ? 'sr-only' : ''} {bar.daemon.off ? 'text-muted' : ''}">`, "level 4: the Daemon's live/cap"],
    [`<span class="max-md:sr-only {left >= 5 ? 'sr-only' : ''}">{$t('statusbar.foreman.name')}</span>`, 'level 5: the "Foreman" word'],
    [`<span class="max-md:sr-only {left >= 5 ? 'sr-only' : ''}">{$t('statusbar.foreman.off')}</span>`, 'level 5: "Foreman off" too'],
    [`<span class={right >= 1 ? 'sr-only' : ''}>{models.provider}`, 'right level 1: the provider'],
    [`<span class="max-md:sr-only {right >= 2 ? 'sr-only' : ''}">`, 'right level 2: the model label'],
    [`<span class="{connQuiet ? 'max-md:sr-only' : ''} {(connQuiet && right >= 3) || right >= 4 ? 'sr-only' : ''} {TONE_TEXT[conn.tone]}">{connWord}</span>`, 'right level 3: Live or Connecting; level 4: the rest'],
    [`<span class="text-warn {right >= 4 ? 'sr-only' : ''}">{$t('statusbar.conn.outdatedWord')}<span class={right >= 3 ? 'sr-only' : ''}>{$t('statusbar.conn.outdatedRest')}</span></span>`, 'right level 3: "needed" after "Update"'],
  ])
    assert.ok(markup.includes(cut), what);
  assert.match(script, /const connQuiet = \$derived\(conn\.state === 'live' \|\| conn\.state === 'connecting'\);/, 'Offline and Update needed keep their word at every width');
  // The facts strip takes what the clusters leave (basis 0), so it gives way before they do; the right cluster sits at the edge.
  const facts = bar.find((e) => attrOf(e, 'bind:this') === '{factsBox}');
  assert.ok(facts && has(facts, 'facts', 'flex-1', 'basis-0'), `the facts strip fills the middle (${facts?.classes.join(' ')})`);
  assert.ok(bar.find((e) => attrOf(e, 'bind:this') === '{rightBox}')?.classes.includes('ml-auto'), 'the right cluster is pushed right');
});

test('popovers close on every route the spec lists', () => {
  const app = read('App.svelte');
  assert.match(app, /if \(settingsOpen \|\| palette\.open\) untrack\(\(\) => closePopover\('external'\)\);/, 'Settings or the palette opening closes it');
  assert.match(app, /\} else if \(layer === 'popover'\) \{\s*e\.preventDefault\(\);\s*closePopover\('escape'\);/, 'Escape closes it through shellEscape');
  const bar = read('components/StatusBar.svelte');
  assert.match(bar, /if \(id !== null && id !== lastDrawer\) untrack\(\(\) => closePopover\(focusInPopover\(\) \? 'navigate' : 'external'\)\);/, 'a drawer opened by any route closes it');
  assert.match(bar, /if \(other\) reanchor\(other\);\s*else closePopover\('gone'\);/, 'a vanished indicator hands it to another for the same popover, or closes it');
  assert.match(bar, /querySelectorAll<HTMLElement>\(`\[data-popover="\$\{open\}"\]`\)/);
  assert.match(bar, /keepFocus\(\);\s*\}/, 'Start and Stop keep keyboard focus in the popover');
  const state = read('lib/popover.svelte.ts');
  assert.match(state, /if \(reason === 'gone'\) \{\s*if \(inside\) tick\(\)\.then\(\(\) => heading\(\)\?\.focus\(\)\);/, 'gone: focus inside goes to the heading');
  assert.match(state, /export function reanchor\(trigger: HTMLElement\): void/);
  assert.match(state, /document\.activeElement === document\.body\)\) document\.getElementById\(`popover-\$\{popover\.open\}`\)\?\.focus\(\);/, 'keepFocus puts focus back on the open dialog');
  assert.match(read('components/statusbar/NeedsPanel.svelte'), /void prompts;\s*keepFocus\(\);/, 'an answered prompt keeps focus in the popover');
  assert.match(read('components/statusbar/DaemonPanel.svelte'), /closePopover\('navigate'\);\s*openDrawer\(id, null, 'log'\);/, 'a job chip');

  // AC11: the poll feeds Connection, and Retry now polls again without disabling itself.
  const s = read('lib/app.svelte.ts');
  assert.match(s, /const data = await api<ApiState>\('\/api\/state'\);\s*S\.online = true;\s*S\.polledAt = new Date\(\)\.toISOString\(\);/);
  assert.match(s, /\} catch \(e\) \{\s*S\.online = false;/);
  const conn = read('components/statusbar/ConnectionPanel.svelte');
  assert.match(conn, /await refresh\(\);/);
  const retry = elements('components/statusbar/ConnectionPanel.svelte').find((e) => e.name === 'button');
  assert.equal(attrOf(retry!, 'onclick'), '{retry}');
  assert.ok(!retry!.attrs.some((a) => a.name === 'disabled'), 'never disabled: focus would fall to the body');
  assert.equal(attrOf(retry!, 'aria-busy'), '{pending}');
});

test('no doc or source names the removed bar or the old palette triggers', () => {
  const STALE = /daemon bar|DaemonBar|\bFAB\b|phone button|dashed .*header/i;
  const roots = ['README.md', 'docs', path.join('dashboard', 'src'), 'skills'];
  const files = roots.flatMap((r) => {
    const abs = path.join(ROOT, r);
    if (fs.statSync(abs).isFile()) return [abs];
    return (fs.readdirSync(abs, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  });
  assert.ok(files.length > 100, `scanned ${files.length} files`);
  const hits = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => STALE.test(l)).map(([f, n]) => `${path.relative(ROOT, f)}:${n}`));
  assert.deepEqual(hits, []);
  assert.match(read('messages/en.json'), /"locked": "[^"]*status bar[^"]*"/, 'settings.locked names the status bar');

  // Nor the Drafting look: its name, its themes, its title block or the design/ folder. lib/theme.ts keeps the old theme
  // ids on purpose: it maps a value saved by an earlier version onto forge or ash.
  const DRAFTING = /\bDrafting\b|cyanotype|vellum|nightprint|title block|tblock|(?<![\w./-])design\/|Text never sits on the grid/i;
  const docs = ['README.md', 'AGENTS.md', path.join('dashboard', 'AGENTS.md'), 'docs', path.join('dashboard', 'src'), 'skills', 'agents', 'reviewers', 'templates'].flatMap((r) => {
    const abs = path.join(ROOT, r);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isFile()) return [abs];
    return (fs.readdirSync(abs, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  });
  assert.ok(DRAFTING.test('the Drafting look') && DRAFTING.test('see design/README.md') && !DRAFTING.test('https://www.figma.com/design/x'), 'self-check: the Drafting matcher');
  const stale = docs
    .filter((f) => path.relative(ROOT, f) !== path.join('dashboard', 'src', 'lib', 'theme.ts'))
    .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => DRAFTING.test(l)).map(([f, n]) => `${path.relative(ROOT, f)}:${n}`));
  assert.deepEqual(stale, [], 'no doc or source names the Drafting look');
  assert.ok(!fs.existsSync(path.join(ROOT, 'design')), 'design/ is gone');
});

// Voice: counts sit after their label in parentheses, in muted tabular numerals ("Active (3)",
// "Timeline (14)"); a count that stands alone at the right of a row (a nav badge, a chip) needs none.
test('counts read Label (N) in tabs and segments', () => {
  const pipeline = read('views/Pipeline.svelte');
  assert.ok(pipeline.includes(`{filterLabel[f]} <span class="num {on ? '' : 'muted'}">({counts[f]})</span>`), 'the Pipeline filters read Active (3)');
  const drawer = read('components/Drawer.svelte');
  assert.ok(drawer.includes(`{$t('drawer.timeline')} <span class="muted num">({d.events.length})</span>`), 'the Timeline tab reads Timeline (14)');
  // Every count inside a tab or a segment button is parenthesised.
  for (const [rel, text] of [['views/Pipeline.svelte', pipeline], ['components/Drawer.svelte', drawer]] as const) {
    for (const m of markupOf(rel).matchAll(/<button\b[^>]*class="(?:tab|btn)\b[\s\S]*?<\/button>/g))
      assert.doesNotMatch(m[0], /<span class="[^"]*\bnum\b[^"]*">\{[^}]*\}<\/span>/, `${rel}: a bare count in ${m[0].slice(0, 60)}`);
    assert.ok(text.length > 0);
  }
  // Right-aligned badges stay bare.
  const nav = read('components/Nav.svelte');
  assert.ok(nav.includes(`<span class="mono num {on ? '' : 'muted'}">{n}</span>`), 'nav badges stay bare');
  assert.ok(read('components/StatusBar.svelte').includes(`<span class="chip you num" aria-hidden="true">{needsTotal}</span>`), 'the Needs-you badge too');
});

test('scrollers contain their overscroll', () => {
  const has = (rel: string, re: RegExp, what: string) => assert.match(read(rel), re, what);
  has('App.svelte', /id="sidebar" class="[^"]*\boverscroll-contain\b/, 'the sidebar');
  has('components/Drawer.svelte', /bind:this=\{head\} class="[^"]*\boverscroll-contain\b/, 'the job pane header');
  has('components/Drawer.svelte', /bind:this=\{panel\} role="tabpanel"[^>]*class="[^"]*\boverscroll-contain\b/, 'the job pane tab panel');
  has('components/Popover.svelte', /class="min-h-0 flex-1 overflow-y-auto overscroll-contain\b/, 'the popover body');
  has('views/Pipeline.svelte', /class="flex flex-col gap-2\.5 p-2\.5 overflow-y-auto overscroll-contain"/, 'the board column scrollers');
  has('components/CommandBar.svelte', /id="command-list"[^>]*class="[^"]*\boverscroll-contain\b/, 'the palette list');
  const settings = read('components/Settings.svelte');
  assert.match(settings, /role="tablist"[^>]*class="[^"]*\boverscroll-contain\b/, 'the Settings rail');
  assert.match(settings, /role="tabpanel"[^>]*class="[^"]*\boverscroll-contain\b/, 'the Settings pane');
});

test('Needs you is a status-bar popover, not a page', () => {
  // The page is gone: no view file, nav entry, route or catalog key.
  assert.ok(!fs.existsSync(path.join(SRC, 'views', 'Inbox.svelte')), 'views/Inbox.svelte is gone');
  for (const rel of ['App.svelte', 'components/Nav.svelte', 'components/StatusBar.svelte']) assert.doesNotMatch(read(rel), /nav\.inbox|views\/Inbox|S\.view === 'inbox'/, `${rel} has no Needs-you page`);
  const en = JSON.parse(read('messages/en.json'));
  assert.equal(en.nav.inbox, undefined, 'no nav.inbox key');
  assert.equal(en.inbox.title, undefined, 'no inbox.title');
  assert.equal(en.inbox.sub, undefined, 'no inbox.sub');
  // One place for what needs you: no catalogue value names a separate "Inbox".
  assert.equal(en.statusbar.inbox, undefined, 'no statusbar.inbox keys');
  assert.equal(en.daemon.inbox, undefined, 'no daemon.inbox key');
  const leaves = (o: any, at = ''): [string, string][] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v ? leaves(v, `${at}${k}.`) : [[`${at}${k}`, String(v)] as [string, string]]));
  assert.deepEqual(leaves(en).filter(([, v]) => v === 'Inbox').map(([k]) => k), [], 'no message is exactly "Inbox"');
  for (const [k, v] of [['daemon.rows.inbox', 'Inbox session'], ['statusbar.daemon.inboxLog', 'Inbox session log'], ['permission.inbox', 'Inbox session'],['session.startInbox', 'Start inbox session'], ['session.stopInbox', 'Stop inbox session'], ['needs.noDecisions', 'No decisions waiting']])
    assert.equal(k.split('.').reduce((o: any, p) => o?.[p], en), v, k);
  // The old link shows the Pipeline, rewrites the hash and asks for the popover.
  const route = fnBody(read('lib/app.svelte.ts'), 'export function route(');
  assert.match(route, /if \(v === 'inbox'\) \{\s*history\.replaceState\(null, '', '#\/pipeline'\);\s*S\.openNeeds = true;\s*\}/);
  assert.match(route, /S\.view = VIEWS\.find\(\(x\) => x\.id === v\)\?\.id \?\? 'pipeline';/, 'and falls through to the Pipeline');

  // The first indicator in the left cluster, before the Foreman: a bell, with a you-chip count only above 0.
  const bar = elements('components/StatusBar.svelte');
  const first = bar.filter((e) => e.name === 'button' && /openPopover\(/.test(attrOf(e, 'onclick')))[0];
  assert.equal(attrOf(first!, 'data-popover'), 'needs', 'Needs you comes first, before the Foreman');
  for (const [k, v] of [['aria-haspopup', 'dialog'], ['aria-expanded', "{expanded('needs')}"], ['aria-controls', "{controls('needs')}"]]) assert.equal(attrOf(first!, k), v, `the button's ${k}`);
  const text = read('components/StatusBar.svelte');
  assert.match(text, /const needs = \$derived\(inboxGroups\(S\.data\?\.jobs \?\? \[\]\)\.urgent\.length\);/, 'decisions are the urgent list');
  assert.match(text, /const needsTotal = \$derived\(needs \+ bar\.prompts\);/, 'the badge adds every pending permission prompt in the pool');
  assert.ok(bar.some((e) => e.name === 'Icon' && attrOf(e, 'name') === 'bell' && e.parents.includes(first!)), 'the bell icon');
  assert.match(text, /\{#if needsTotal > 0\}<span class="chip you num" aria-hidden="true">\{needsTotal\}<\/span>\{\/if\}/, 'a you chip only above 0');
  assert.match(text, /<span class="inline-flex \{needsTotal > 0 \? 'text-fg' : 'text-muted'\}"><Icon name="bell" \/><\/span>/, 'the bell is muted at 0');
  assert.match(text, /<span class="sr-only">\{\$t\('statusbar\.needs\.name'\)\}\{#if needs > 0\}\{', '\}\{\$t\('statusbar\.needs\.count', \{ count: needs \}\)\}\{\/if\}\{#if bar\.prompts > 0\}\{', '\}\{\$t\('permission\.heading', \{ count: bar\.prompts \}\)\}\{\/if\}<\/span>/, 'its name is Needs you plus the decisions, then the prompts');
  // Icon-only at every width: every text node in it is sr-only or the aria-hidden badge.
  const nm = markupOf('components/StatusBar.svelte');
  const nAt = nm.indexOf('data-popover="needs"');
  const nButton = nm.slice(nm.indexOf('<span', nAt), nm.indexOf('</button>', nAt));
  const nVisible = nButton.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, '').replace(/<span class="chip you num" aria-hidden="true">\{needsTotal\}<\/span>/g, '');
  assert.doesNotMatch(nVisible.replace(/\{[^{}]*\}/g, '').replace(/<[^>]*>/g, ''), /\S/, `no visible text in the bell (${nVisible})`);
  assert.match(text, /needs: \$t\('statusbar\.needs\.tooltip'\),/, 'its title is only "Notifications": the counts are in the sr-only text and the badge');
  // It opens the wide popover holding the page's sections, and #/inbox opens it once.
  assert.match(text, /\{:else if open === 'needs'\}\{#if S\.data\}<NeedsPanel data=\{S\.data\} \/>\{\/if\}/);
  assert.match(text, /if \(!S\.openNeeds \|\| !S\.data \|\| !needsButton\) return;[\s\S]*?S\.openNeeds = false;\s*if \(popover\.open !== 'needs'\) openPopover\('needs', anchor\);/, '#/inbox opens it anchored to its button');
  const panel = read('components/statusbar/NeedsPanel.svelte');
  for (const c of ['<InboxCard job={j} />', '<PrChip pr={j.pr} />', '<DepChips job={j} />', '<JobActions job={j} noteId="park-{j.id}" />', '{#each reqs as r (r.id)}', "$t('needs.empty')", "$t('inbox.openPr')", "$t('inbox.addressFeedback')"]) assert.ok(panel.includes(c), `NeedsPanel renders ${c}`);
  assert.equal(panel.match(/<h3 id="needs-[a-z]+" class="label">/g)?.length, 4, 'four h3.label headings');
  assert.doesNotMatch(panel, /PageHeader|<h2|\{@html/, 'no page header and no raw html');
  assert.match(panel, /href=\{u\}/, 'the PR link is the safeUrl');
  assert.match(panel, /const u = safeUrl\(j\.pr\?\.url\)/);
});

test('the Daemon popover lists sessions and holds the Inbox session log', () => {
  const panel = read('components/statusbar/DaemonPanel.svelte');
  assert.match(panel, /const rows = \$derived\(model \? daemonRows\(model, S\.data\?\.jobs \?\? \[\]\) : \[\]\);/, 'rows come from daemonRows');
  const els = elements('components/statusbar/DaemonPanel.svelte');
  const jobRow = els.find((e) => e.name === 'button' && attrOf(e, 'onclick') === '{() => openJob(r.id)}');
  assert.ok(jobRow && has(jobRow, 'plain', 'clickable'), 'a job row is a button on a plain surface');
  assert.ok(has(jobRow, 'border-line-soft') && !has(jobRow, 'border-transparent'), 'and shows its edge at rest, so it reads as clickable before hover');
  assert.match(panel, /<span class="truncate text-sm">\{r\.title \?\? r\.id\}<\/span><span class="mono muted truncate">\{r\.id\}/, 'its title (or id) and its mono id, as text');
  assert.match(panel, /\$t\('daemon\.rows\.inbox'\)/);
  assert.match(panel, /\$t\('daemon\.rows\.inboxAbout'\)/);
  assert.doesNotMatch(panel, /r\.kind === 'foreman'/, 'the Foreman is not among the session rows');
  const inert = els.find((e) => e.name === 'div' && has(e, 'plain') && !attrOf(e, 'onclick'));
  assert.ok(inert, 'the Inbox row is not interactive');
  assert.ok(has(inert, 'border-transparent'), 'and draw no edge');
  assert.equal((panel.match(/\{@render pill\(r\.pill\)\}/g) ?? []).length, 2, 'every row ends with its session pill');
  assert.doesNotMatch(panel, /daemon\.(held|waiting|kept)/, 'no held, waiting or kept chips');
  assert.doesNotMatch(panel, /\{@html/);
  assert.equal((panel.match(/<SessionLog scope=\{INBOX_SCOPE\} compact \/>/g) ?? []).length, 1, 'the Daemon popover holds the Inbox session log, once');
  assert.match(read('lib/daemon-log.ts'), /Daemon popover's Inbox session log/, "LOG_KEY's comment names its new home");
  // The Held and Waiting buttons still open the Daemon popover.
  assert.equal((read('components/StatusBar.svelte').match(/data-popover="daemon"/g) ?? []).length, 3, 'Daemon, Held and Waiting');
});

test('status bar: the Daemon indicator shows only its name and live/cap', () => {
  const markup = markupOf('components/StatusBar.svelte');
  const at = markup.indexOf(`data-popover="daemon" title={titles.daemon}`);
  assert.ok(at >= 0, 'the Daemon button, its tooltip always on: the state is never visible');
  const open = markup.lastIndexOf('<button', at);
  const button = markup.slice(markup.indexOf('>', at) + 1, markup.indexOf('</button>', at));
  assert.ok(open >= 0 && button.length > 0);
  // What is visible: everything outside the sr-only spans (none of which nests a span).
  const visible = button.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, '');
  assert.doesNotMatch(visible, /bar\.daemon\.pill\.label/, 'no state word in the bar');
  assert.doesNotMatch(visible, /statusbar\.daemon\.off/, 'not "Daemon off" either');
  assert.ok(visible.includes(`{$t('statusbar.daemon.title')}`), 'the word "Daemon"');
  assert.ok(visible.includes(`<span class="num">{bar.daemon.off ? 0 : bar.daemon.live}/{bar.daemon.cap}</span>`), 'and live/cap, 0/<cap> while off');
  assert.ok(visible.includes('<LiveDot on={bar.daemon.active} />'), 'with its live dot');
  // The state is still spoken and in the tooltip.
  assert.ok(button.includes(`<span class="sr-only">{' '}{$t('statusbar.daemon.sessions')}{', '}{bar.daemon.off ? $t('statusbar.daemon.off') : bar.daemon.pill.label}</span>`), 'the state in the sr-only text');
  const script = read('components/StatusBar.svelte');
  assert.match(script, /daemon: \[\s*bar\.daemon\.off \? \$t\('statusbar\.daemon\.off'\) : \$t\('daemon\.pill', \{ label: bar\.daemon\.pill\.label \}\),/, 'and in the title');
  assert.match(script, /const LEFT_MAX = 5;/);
});

test('the Foreman popover reuses SessionLog and PermissionPrompts and writes no config', () => {
  assert.ok(!fs.existsSync(path.join(SRC, 'components', 'statusbar', 'OfficePanel.svelte')), 'OfficePanel.svelte is gone');
  const text = read('components/statusbar/ForemanPanel.svelte');
  const markup = markupOf('components/statusbar/ForemanPanel.svelte');
  const body = ifBody(markup, 'foreman.on');
  assert.ok(body, '{#if foreman.on}');
  const [on, off] = body.split('{:else}');
  assert.ok(on.includes('<PermissionPrompts scope={OFFICE_SCOPE} />'), 'on: the office prompts');
  assert.ok(on.includes('<div class="max-h-[40%] shrink-0 overflow-y-auto"><PermissionPrompts'), 'capped at 40% of the popover, scrolling on their own');
  assert.ok(on.includes('<SessionLog scope={OFFICE_SCOPE} fill />'), "on: the office's live thread in the fill layout");
  assert.ok(on.indexOf('<PermissionPrompts') < on.indexOf('<SessionLog'), 'prompts above the log');
  assert.ok(on.includes(`$t('statusbar.foreman.about')`) && on.includes(`$t('statusbar.foreman.daemonOffHow')`), 'the role text, and how to start the daemon');
  assert.ok(off !== undefined, 'an off branch');
  assert.doesNotMatch(off, /<SessionLog|<PermissionPrompts/, 'off: no log and no prompts');
  for (const k of ['offTitle', 'offBody', 'offHow']) assert.ok(off.includes(`$t('statusbar.foreman.${k}')`), `off: statusbar.foreman.${k}`);
  assert.match(text, /'\{key\}': 'foreman\.enabled: true'/, 'it names foreman.enabled');
  assert.match(text, /'\{file\}': '\.forge\/config\.yml'/, 'and .forge/config.yml');
  assert.ok(text.includes('<code class="mono">{CODE[part]}</code>'), 'the key names render in mono, as text');
  for (const banned of ['postConfig', 'fetch(', '{@html', '<button', '<select', '<input']) assert.ok(!text.includes(banned), `ForemanPanel has no ${banned}`);
  const en = JSON.parse(read('messages/en.json'));
  assert.equal(en.statusbar.office, undefined, 'the statusbar.office keys are gone');
  assert.match(en.statusbar.foreman.offHow, /\{key\}[\s\S]*\{file\}/);
});

test("SessionLog: fill layout and the office's read-only model and effort", () => {
  const text = read('components/SessionLog.svelte');
  assert.match(text, /fill = false \}: \{[^}]*fill\?: boolean \}/, 'fill is an opt-in prop');
  assert.ok(text.includes(`<div class="flex flex-col gap-2 {fill ? 'min-h-0 flex-1' : ''}">`), 'the root grows into its container');
  assert.ok(text.includes(`{fill ? 'min-h-0 flex-1' : compact ? 'max-h-72' : 'max-h-[70vh]'}`), 'the log pane fills instead of capping its height');
  // The drawer's Log tab fills its panel, so the log pane is the one scroller; the Daemon popover's Inbox log keeps its cap.
  assert.ok(/<SessionLog\b[^>]*\bfill\b/.test(read('components/Drawer.svelte')), 'the drawer passes fill');
  assert.ok(!/<SessionLog\b[^>]*\bfill\b/.test(read('components/statusbar/DaemonPanel.svelte')), 'the Daemon popover passes no fill');
  const markup = markupOf('components/SessionLog.svelte');
  const facts = ifBody(markup, 'scope === OFFICE_SCOPE');
  assert.ok(facts, "{#if scope === OFFICE_SCOPE}: the office's facts");
  assert.ok(facts.includes(`{$t('session.model', { model: officeModel })}`), 'the model');
  assert.ok(facts.includes(`title={$t('session.effortHint')}>{$t('session.effort', { effort: officeEffort })}`), 'the effort, with the runtime.effort hint');
  assert.doesNotMatch(facts, /<select|<input|<button|EffortSelect/, 'both read-only');
  assert.deepEqual(openBlocksAt(read('components/SessionLog.svelte'), '{#if scope === OFFICE_SCOPE}'), [['#if transcript', ':else']], 'only without a transcript');
  assert.ok(text.includes('{#if scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE}<EffortSelect job={scope} />{/if}'), 'still no EffortSelect for the office');
  assert.match(text, /const raw = latestInitModel\(entries\);\s*return raw === null \? \$t\('session\.modelUnknown'\) : \(modelLabel\(raw\)\.label \?\? raw\);/, "the newest init line's model, labelled");
  assert.match(text, /const spawned = level\(session\?\.effort\);[\s\S]*?const fallback = level\(S\.data\?\.config\?\.effort\);\s*return fallback === null \? \$t\('effort\.claude'\) : \$t\('effort\.inherit', \{ level: effortName\[fallback\] \}\);/, "the spawn effort, else runtime.effort as inherit, else Claude Code's own");
});

test('the session log merges Start and Stop', () => {
  const text = read('components/SessionLog.svelte');
  const markup = markupOf('components/SessionLog.svelte');
  assert.doesNotMatch(markup, /act\('start'\)|act\('stop'\)/, 'no Start and Stop pair');
  assert.match(text, /const toggle = \$derived\(sessionToggle\(controls, session\)\);/, 'one action, from sessionToggle');
  const flip = markup.slice(markup.indexOf('{#snippet flip('), markup.indexOf('{/snippet}', markup.indexOf('{#snippet flip(')));
  const inFlip = elements('components/SessionLog.svelte', flip);
  const buttons = inFlip.filter((e) => e.name === 'button');
  assert.equal(buttons.length, 1, 'the snippet renders one button');
  const b = buttons[0];
  assert.equal(attrOf(b, 'onclick'), '{(e) => act(toggle.action, e.currentTarget)}', 'the button, so focus can return to it');
  assert.match(fnBody(read('components/SessionLog.svelte').replace(/\n {2}/g, '\n'), 'async function act('), /const restore = keepFocus\(el\);[\s\S]*finally \{\s*pending = false;\s*await tick\(\);\s*restore\(\);/, 'focus returns to the toggle once it is enabled again');
  assert.equal(attrOf(b, 'disabled'), '{!toggle.enabled}');
  assert.equal(attrOf(b, 'title'), "{toggle.action === 'start' ? $t('session.startHint') : undefined}", 'the start hint while it shows Start');
  const swap = inFlip.find((e) => e.classes.includes('swap'));
  assert.ok(swap && swap.parents.at(-1) === b, 'icon and label sit in one swap cell inside the button');
  const states = inFlip.filter((e) => e.parents.at(-1) === swap);
  assert.equal(states.length, 2, 'one child per state');
  for (const st of states) {
    assert.ok(attrOf(st, 'data-off') && attrOf(st, 'aria-hidden'), 'the inactive state is data-off and aria-hidden');
    assert.ok(inFlip.some((e) => e.name === 'Icon' && e.parents.includes(st)), 'each state holds its icon');
  }
  assert.ok(flip.includes('<Icon name="play" />{start}') && flip.includes('<Icon name="stop" />{stop}'), 'play for Start, stop for Stop');
  // One render per scope branch, with the scope's labels (and a job's aria-labels).
  assert.equal(markup.match(/\{@render flip\(/g)?.length, 3, 'one per scope branch');
  assert.match(markup, /\{#if scope === INBOX_SCOPE\}\s*\{@render flip\(\$t\('session\.startInbox'\), \$t\('session\.stopInbox'\)\)\}/, 'the inbox');
  assert.match(markup, /\{:else if scope === OFFICE_SCOPE\}\s*\{@render flip\(\$t\('session\.startOffice'\), \$t\('session\.stopOffice'\)\)\}/, 'the office');
  assert.ok(markup.includes("{@render flip($t('session.start'), $t('session.stop'), toggle.action === 'start' ? $t('session.startJob') : $t('session.stopJob'))}"), 'a job, named by its aria-label');
  assert.deepEqual(openBlocksAt(read('components/SessionLog.svelte'), '{@render flip(').at(0)?.slice(0, 1), ['#if !transcript'], 'never in transcript mode');
});

test('log menus are top-layer dialogs', () => {
  const text = read('components/MenuButton.svelte');
  const els = elements('components/MenuButton.svelte');
  const trigger = els.find((e) => e.name === 'button');
  assert.ok(trigger, 'a trigger button');
  assert.equal(attrOf(trigger, 'aria-haspopup'), 'dialog');
  assert.equal(attrOf(trigger, 'aria-expanded'), '{open}');
  assert.equal(attrOf(trigger, 'aria-controls'), '{panelId}');
  const panel = els.find((e) => e.name === 'div' && attrOf(e, 'role') === 'dialog');
  assert.ok(panel, 'a dialog panel');
  assert.equal(attrOf(panel, 'popover'), 'manual', 'manual: this component owns dismissal, not light dismiss');
  assert.equal(attrOf(panel, 'id'), '{panelId}');
  assert.equal(attrOf(panel, 'aria-labelledby'), '{titleId}');
  assert.ok(has(panel, 'plate', 'solid', 'shadow-(--shadow-overlay)'), `an opaque overlay surface (${panel.classes.join(' ')})`);
  assert.ok(els.some((e) => e.name === 'h2' && attrOf(e, 'id') === '{titleId}'), 'its visible title labels it');
  assert.match(text, /const uid = \$props\.id\(\);/, 'ids from $props.id()');
  assert.match(text, /const panelId = `\$\{uid\}-menu`;/);
  assert.match(text, /const titleId = `\$\{uid\}-title`;/);
  const key = fnBody(text.replace(/\n {2}/g, '\n'), 'function key(');
  assert.match(key, /e\.key !== 'Escape'/);
  assert.match(key, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/, 'Escape stops here, so the drawer and the status bar popover stay open');
  assert.match(text, /placeMenu\(\{/, 'placement from lib/menu.ts');
  assert.match(text, /import \{ FOCUSABLE, dismissal \} from '\.\.\/lib\/popover\.ts';/, 'the status bar popovers\' dismissal rules');
  assert.match(text, /dismissal\('outside', \{ targetFocusable: target\.closest\(FOCUSABLE\) !== null \}\)/);
  assert.match(text, /showPopover\(\)/);
  assert.doesNotMatch(text, /popover="auto"|popover\.svelte\.ts/, 'no light dismiss, no global popover state');
});

test("the session log's settings and filters live in popovers", () => {
  const log = elements('components/SessionLog.svelte');
  assert.ok(!log.some((e) => e.name === 'select'), 'SessionLog has no select');
  const menus = log.filter((e) => e.name === 'MenuButton');
  assert.equal(menus.length, 2, 'Permissions and Filter');
  const inMenu = (e: El) => e.parents.some((p) => p.name === 'MenuButton');
  for (const i of log.filter((e) => e.name === 'input')) assert.ok(inMenu(i), `<input ${i.attrs.map((a) => a.name).join(' ')}> sits in a MenuButton`);
  const [perm, filter] = menus;
  assert.equal(attrOf(perm, 'icon'), 'shield');
  assert.equal(attrOf(perm, 'label'), "{$t('session.modeTrigger', { mode: modeName[shownMode] ?? shownMode })}");
  assert.equal(attrOf(perm, 'title'), "{$t('session.modeLabel')}");
  const radios = log.filter((e) => e.name === 'input' && attrOf(e, 'type') === 'radio');
  assert.equal(radios.length, 2, 'one radio per mode (repeated) and the unknown mode');
  for (const r of radios) assert.ok(r.parents.includes(perm), 'the permission radios sit in its popover');
  assert.equal(attrOf(radios[0], 'onchange'), '{(e) => setMode(m, e.currentTarget)}', 'the radio, so focus can wait on its panel');
  assert.match(fnBody(read('components/SessionLog.svelte').replace(/\n {2}/g, '\n'), 'async function setMode('), /const restore = parkFocus\(el\);\s*picked = next;\s*pending = true;[\s\S]*finally \{\s*picked = null;\s*pending = false;\s*await tick\(\);\s*restore\(\);/, 'focus waits on the panel while the radios are disabled');
  for (const r of radios) assert.ok(has(r, 'radio') && !has(r, 'check'), 'round radios, not checkboxes');
  assert.equal(attrOf(radios[0], 'disabled'), '{modeLocked}');
  assert.match(read('components/SessionLog.svelte'), /const modeLocked = \$derived\(pending \|\| S\.data\?\.daemons\?\.enabled !== true\);/);
  assert.ok(log.some((e) => e.parents.includes(perm) && e.name === 'span' && /modeHint\[m\]/.test(read('components/SessionLog.svelte'))), 'each mode shows its hint');
  assert.ok('checked' in Object.fromEntries(radios[1].attrs.map((a) => [a.name, a.value])) && attrOf(radios[1], 'disabled') !== undefined, 'an unknown mode shows checked and disabled');
  assert.equal(attrOf(filter, 'icon'), 'filter');
  assert.ok(filter.attrs.some((a) => a.name === 'iconOnly'), 'the filter button is icon-only');
  assert.equal(attrOf(filter, 'badge'), '{filtering}', 'filtersActive drives the badge');
  assert.equal(attrOf(filter, 'label'), "{filtering ? $t('session.filterActive') : $t('session.filter')}", 'and the name');
  assert.match(read('components/SessionLog.svelte'), /const filtering = \$derived\(filtersActive\(filters\)\);/);
  const search = log.find((e) => e.name === 'input' && attrOf(e, 'type') === 'search');
  assert.ok(search?.parents.includes(filter) && attrOf(search, 'bind:value') === '{filters.text}', 'the search input is in the Filter popover');
  const boxes = log.filter((e) => e.name === 'input' && attrOf(e, 'type') === 'checkbox');
  assert.deepEqual(boxes.map((b) => attrOf(b, 'bind:checked')), ['{filters.tools}', '{filters.thinking}', '{filters.subagents}']);
  for (const b of boxes) assert.ok(b.parents.includes(filter), 'the checkboxes are in the Filter popover');
  assert.ok(read('components/SessionLog.svelte').includes('{#if scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE}<EffortSelect job={scope} />{/if}'), 'Effort for job scopes only');

  const effort = elements('components/EffortSelect.svelte');
  assert.ok(!effort.some((e) => e.name === 'select'), 'EffortSelect has no select');
  const menu = effort.find((e) => e.name === 'MenuButton');
  assert.ok(menu, 'EffortSelect is a MenuButton');
  assert.equal(attrOf(menu, 'icon'), 'gauge');
  assert.equal(attrOf(menu, 'label'), "{$t('effort.trigger', { level: levelName })}");
  assert.equal(attrOf(menu, 'extraTitle'), "{restart ? $t('effort.restart') : undefined}", 'the restart note joins the title while it applies');
  const eRadios = effort.filter((e) => e.name === 'input' && attrOf(e, 'type') === 'radio');
  assert.equal(eRadios.length, 2, 'Inherit, then each level');
  for (const r of eRadios) assert.ok(r.parents.includes(menu), 'inside the popover');
  assert.deepEqual(eRadios.map((r) => attrOf(r, 'onchange')), ["{(e) => choose('', e.currentTarget)}", '{(ev) => choose(e, ev.currentTarget)}']);
  for (const r of eRadios) assert.ok(has(r, 'radio') && !has(r, 'check'), 'round radios, not checkboxes');
  const fieldset = effort.find((e) => e.name === 'fieldset');
  assert.ok(fieldset && has(fieldset, 'gap-2'), 'rows at least 24px apart on desktop (WCAG 2.5.8)');
  assert.match(fnBody(read('components/EffortSelect.svelte').replace(/\n {2}/g, '\n'), 'async function choose('), /const restore = parkFocus\(el\);\s*picked = value;\s*pending = true;[\s\S]*finally \{\s*picked = null;\s*pending = false;\s*await tick\(\);\s*restore\(\);/, 'focus waits on the panel while the radios are disabled');
  const note = effort.find((e) => attrOf(e, 'role') === 'status');
  assert.ok(note?.parents.includes(menu), 'the restart note sits in the popover');
});

test("the session log's rendered/raw toggle is icon-only", () => {
  assert.ok(read('components/SessionLog.svelte').includes('<MarkdownToggle surface="session" iconOnly />'));
  for (const f of srcFiles().filter((x) => x !== 'components/SessionLog.svelte' && x.endsWith('.svelte'))) assert.doesNotMatch(read(f), /<MarkdownToggle\b[^>]*\biconOnly\b/, `${f} keeps the labelled segment`);
  const els = elements('components/MarkdownToggle.svelte');
  const icon = openBlocksAt(read('components/MarkdownToggle.svelte'), '<Icon name="markdown" />');
  assert.deepEqual(icon.map((b) => b.at(-1)), ['#if iconOnly'], 'the icon button renders only with iconOnly');
  const b = els.find((e) => e.name === 'button' && e.first?.name === 'Icon');
  assert.ok(b && has(b, 'btn', 'sm', 'icon'), 'one btn sm icon');
  assert.equal(attrOf(b, 'aria-pressed'), '{rendered}');
  assert.equal(attrOf(b, 'aria-label'), "{$t('markdown.sessionRendered')}");
  assert.equal(attrOf(b, 'title'), "{$t('markdown.sessionRendered')}");
  assert.equal(attrOf(b, 'onclick'), "{() => setMdView(surface, rendered ? 'raw' : 'rendered')}");
  assert.ok(b.classes.includes("{rendered ? 'sel' : ''}") || /rendered \? 'sel' : ''/.test(attrOf(b, 'class')), 'sel shows the state');
  assert.match(read('components/MarkdownToggle.svelte'), /const rendered = \$derived\(mdView\[surface\] === 'rendered'\);/);
  assert.ok(read('components/MarkdownToggle.svelte').includes('<div class="seg" role="group" aria-label={groupLabel[surface]}>'), 'without it, the segment is unchanged');
});

test('the Daemon popover leads with a Foreman row that opens the Foreman popover', () => {
  const panel = read('components/statusbar/DaemonPanel.svelte');
  const markup = markupOf('components/statusbar/DaemonPanel.svelte');
  assert.match(panel, /openForeman: \(\) => void/, 'an openForeman prop');
  const row = elements('components/statusbar/DaemonPanel.svelte').find((e) => e.name === 'button' && attrOf(e, 'onclick') === '{openForeman}');
  assert.ok(row && has(row, 'plain', 'foreman', 'clickable'), 'a button with the foreman accent on a plain surface');
  assert.ok(row.classes.includes("{foreman.on ? '' : 'off'}") || /foreman\.on \? '' : 'off'/.test(attrOf(row, 'class')), 'dashed and muted while off');
  const snippet = markup.slice(markup.indexOf('{#snippet foremanRow()}'), markup.indexOf('{/snippet}', markup.indexOf('{#snippet foremanRow()}')));
  for (const k of ["$t('daemon.rows.foremanRow')", "$t('daemon.rows.foremanRowAbout')", "$t('statusbar.foreman.off')", '{@render pill(foreman.pill)}']) assert.ok(snippet.includes(k), `the row shows ${k}`);
  // First in both branches, above the pool facts.
  const on = ifBody(markup, 'model');
  assert.ok(on);
  const [enabled, disabled] = on.split(/\{:else\}(?![\s\S]*\{:else\})/);
  assert.ok(enabled.indexOf('{@render foremanRow()}') >= 0 && enabled.indexOf('{@render foremanRow()}') < enabled.indexOf("$t('daemon.pill'"), 'on: before the pool pill');
  assert.ok(disabled.indexOf('{@render foremanRow()}') >= 0 && disabled.indexOf('{@render foremanRow()}') < disabled.indexOf("$t('statusbar.daemon.disabled')"), 'off: before the disabled text');
  const bar = read('components/StatusBar.svelte');
  assert.match(bar, /function openForeman\(\): void \{\s*const el = footer\?\.querySelector<HTMLElement>\('\[data-popover="foreman"\]'\);\s*if \(el\) openPopover\('foreman', el\);/, "it opens the Foreman popover on the bar's own Foreman button");
  assert.doesNotMatch(panel, /\{@html|fetch\(/);
});

test('the job drawer overlays the view with a resizable left edge', () => {
  // PaneState: one global width, the md breakpoint and the window width; no layout mode.
  const state = read('lib/app.svelte.ts');
  const paneState = state.slice(state.indexOf('class PaneState {'), state.indexOf('\n}\n', state.indexOf('class PaneState {')));
  assert.match(paneState, /width = \$state\(clampPaneWidth\(Number\(pref\.get\('paneWidth', String\(PANE_DEFAULT\)\)\), Infinity\)\);/, 'the width starts from the pref');
  assert.match(paneState, /\n {2}md = \$state\(true\);/);
  assert.match(paneState, /\n {2}viewport = \$state\(Infinity\);/);
  assert.deepEqual(paneState.match(/^ {2}(\w+) = /gm)?.map((m) => m.trim().split(' ')[0]), ['width', 'md', 'viewport'], 'only width, md and viewport');
  // App binds the window width; a resize never writes the width or the pref.
  const appSrc = read('App.svelte');
  assert.match(appSrc, /<svelte:window bind:innerWidth=\{S\.pane\.viewport\} /);
  assert.doesNotMatch(appSrc, /S\.pane\.width =/, 'App never writes the width');
  assert.doesNotMatch(appSrc, /paneWidth|ResizeObserver|mainEl/, 'no pref write, no main-column measuring');
  // Drawer renders once, outside main and the shell, in its own inert wrapper, after the shell and before Settings.
  const app = elements('App.svelte');
  const pane = app.find((e) => e.name === 'Drawer');
  assert.ok(pane, '<Drawer />');
  assert.ok(!pane.parents.some((p) => p.name === 'main'), 'outside <main>');
  assert.equal(pane.parents.length, 1, 'only its wrapper above it');
  assert.equal(attrOf(pane.parents[0], 'inert'), '{settingsOpen || palette.open}', 'the wrapper goes inert under Settings and the palette');
  const appText = markupOf('App.svelte');
  assert.equal(appText.match(/<Drawer\b/g)?.length, 1, 'once');
  assert.ok(appText.indexOf('<StatusBar />') < appText.indexOf('<Drawer />'), 'after the shell');
  assert.ok(appText.indexOf('<Drawer />') < appText.indexOf('<Settings '), 'before Settings');
  // The view keeps its centred width; the split row is gone.
  const view = app.find((e) => attrOf(e, 'id') === 'view')!;
  for (const c of ['@container', 'mx-auto', 'max-w-[1400px]']) assert.ok(view.classes.includes(c), `#view has ${c}`);
  assert.doesNotMatch(attrOf(view, 'class'), /\{/, 'its classes are static');
  assert.ok(!app.some((e) => has(e, 'flex', 'items-start', 'min-w-0')), 'no split row');
  // The aside: fixed at the right, slid out and invisible when closed, its width inline at md and up only.
  const drawer = read('components/Drawer.svelte');
  const aside = elements('components/Drawer.svelte').find((e) => e.name === 'aside' && attrOf(e, 'id') === 'drawer')!;
  for (const c of ['fixed', 'right-0', 'top-0', 'z-40', 'solid', 'w-full', 'flex', 'flex-col', 'overflow-hidden']) assert.ok(aside.classes.includes(c), `the drawer has ${c}`);
  for (const c of ['sticky', 'h-dvh', 'md:left-(--size-sidebar)', 'self-start']) assert.ok(!aside.classes.includes(c), `no ${c}`);
  assert.match(attrOf(aside, 'class'), /\{open \? 'shadow-\(--shadow-drawer\)' : 'translate-x-full invisible'\}/, 'closed, it is slid out and invisible');
  assert.match(attrOf(aside, 'class'), /\{dragging \? '' : open \? 'transition-\[translate\]' : 'transition-\[translate,visibility\]'\}/, 'it slides, except while dragging; visibility waits only on a close');
  assert.equal(attrOf(aside, 'style'), '{S.pane.md ? `width: ${width}px` : undefined}', 'the inline width only at md and up');
  assert.match(drawer, /const gutter = \$derived\(sidebarShown\(S\.side\)\);/, "the gutter is the sidebar's current width");
  assert.match(drawer, /const width = \$derived\(clampPaneWidth\(S\.pane\.width, S\.pane\.viewport, gutter\)\);/, 'clamped to the window, the pref untouched');
  // The backdrop closes it, as does the close button.
  const backdrop = elements('components/Drawer.svelte').find((e) => attrOf(e, 'id') === 'drawer-backdrop')!;
  assert.equal(attrOf(backdrop, 'onclick'), '{closeDrawer}', 'a backdrop click closes it');
  assert.match(attrOf(backdrop, 'class'), /\{open \? '' : 'hidden'\}/, 'hidden when closed');
  assert.equal(drawer.match(/onclick=\{closeDrawer\}/g)?.length, 2, 'the backdrop and the close button');
  assert.match(drawer, /<CloseButton size="sm" label=\{\$t\('drawer\.close'\)\} onclick=\{closeDrawer\} \/>/);
  // The separator: a focusable ARIA window splitter, md and up only.
  assert.match(drawer, /\{#if S\.pane\.md && open\}\s*<!-- An 8px hit area/, 'only at md and up, while open');
  const sep = elements('components/Drawer.svelte').find((e) => attrOf(e, 'role') === 'separator')!;
  assert.ok(sep, 'a separator');
  for (const [k, v] of [['aria-orientation', 'vertical'], ['aria-controls', 'drawer'], ['aria-valuemin', '{PANE_MIN}'], ['aria-valuemax', '{paneMax(S.pane.viewport, gutter)}'], ['aria-valuenow', '{width}'], ['aria-label', "{$t('drawer.resize')}"], ['tabindex', '0'], ['onpointerdown', '{dragStart}'], ['onpointermove', '{dragMove}'], ['onpointerup', '{dragEnd}'], ['onlostpointercapture', '{dragEnd}'], ['onkeydown', '{sepKey}'], ['ondblclick', '{sepReset}']])
    assert.equal(attrOf(sep, k), v, `the separator's ${k}`);
  for (const c of ['w-2', 'cursor-col-resize', 'touch-none']) assert.ok(sep.classes.includes(c), `the separator has ${c}`);
  assert.match(drawer, /<span class="absolute inset-y-0 left-0 border-l /, 'a 1px visible rule');
  assert.match(drawer, /e\.currentTarget\.setPointerCapture\(e\.pointerId\)/, 'a drag captures the pointer');
  assert.match(drawer, /S\.pane\.width = clampPaneWidth\(drag\.w \+ \(drag\.x - e\.clientX\), S\.pane\.viewport, gutter\)/, 'and resizes live');
  assert.match(drawer, /const save = \(\): void => pref\.set\('paneWidth', String\(S\.pane\.width\)\);/, 'the width is saved per viewer');
  assert.match(drawer, /const next = paneKey\(width, e\.key, e\.shiftKey, S\.pane\.viewport, gutter\);/);
  assert.match(drawer, /S\.pane\.width = clampPaneWidth\(PANE_DEFAULT, S\.pane\.viewport, gutter\);/, 'double-click restores the default');
  assert.equal(drawer.match(/save\(\);/g)?.length, 3, 'drag end, a key and a reset each save once');
});

test('an open drawer takes focus, locks the page and takes the view out of the tab order', () => {
  const app = read('App.svelte');
  assert.match(app, /const covered = \$derived\(S\.drawer\.id !== null\);/);
  const els = elements('App.svelte');
  for (const [what, el] of [['#sidebar', els.find((e) => attrOf(e, 'id') === 'sidebar')], ['the phone header', els.find((e) => e.name === 'header')], ['#view', els.find((e) => attrOf(e, 'id') === 'view')]] as const)
    assert.equal(el && attrOf(el, 'inert'), '{covered}', `${what} is inert under the drawer`);
  assert.match(app, /\$effect\.pre\(\(\) => \{\s*if \(!covered\) return;\s*const active = untrack\(\(\) => document\.activeElement\);/, 'the opener is read before inert lands');
  assert.match(app, /if \(opener\) tick\(\)\.then\(\(\) => S\.drawer\.id === null && opener\.isConnected && opener\.focus\(\)\);/, 'closing hands focus back');
  assert.match(app, /\$effect\(\(\) => \{\s*if \(!covered\) return;\s*document\.documentElement\.classList\.add\('overflow-hidden'\);\s*return \(\) => document\.documentElement\.classList\.remove\('overflow-hidden'\);\s*\}\);/, 'the page does not scroll under it');
  const drawer = read('components/Drawer.svelte');
  assert.match(drawer, /<h2 bind:this=\{title\} tabindex="-1" class="h sheet-title">\{j\.title\}<\/h2>/, 'the title can take focus');
  assert.match(drawer, /if \(!open \|\| !title \|\| !pane\) return;[\s\S]*?if \(!untrack\(\(\) => el\.contains\(document\.activeElement\)\)\) title\.focus\(\);/, 'opening focuses it unless focus is already inside');
  assert.doesNotMatch(drawer, /\bsplit\b/, 'at every width');
});

test('the job pane reads at body size', () => {
  const thread = read('components/ThreadPanel.svelte');
  assert.doesNotMatch(thread, /prose compact/, 'no compact prose in the Thread');
  assert.match(thread, /<div class="prose break-words">\{@html md\(m\.text\)\}<\/div>/, 'bodies are prose');
  assert.match(thread, /<div class="prose break-words">\{@html md\(m\.result\)\}<\/div>/, 'Forge replies are prose');
  const drawer = read('components/Drawer.svelte');
  assert.match(drawer, /<li class="flex gap-3 py-1\.5 border-b border-line text-sm">/, 'Timeline rows are text-sm');
  assert.match(drawer, /class="block w-full text-left truncate px-2 py-1 text-sm font-mono /, 'the Files list is text-sm');
  const timeline = drawer.slice(drawer.indexOf("shown.tab === 'timeline'"), drawer.indexOf("shown.tab === 'details'"));
  const files = drawer.slice(drawer.indexOf("shown.tab === 'files'"), drawer.indexOf("shown.tab === 'timeline'"));
  assert.doesNotMatch(timeline + files, /text-xs/, 'no text-xs in the Timeline or the Files tab');
  assert.equal(files.match(/<pre class="selectable text-\[13px\] font-mono /g)?.length, 2, 'the Files viewer is 13px');
  assert.doesNotMatch(files, /text-\[12px\]/);
  assert.match(drawer, /<div class="mono text-\[13px\] break-all selectable">\{#if icon\}[^\n]*?\{\/if\}\{v\}<\/div>/, 'fact values are 13px mono');
  assert.match(drawer, /<div class="mono text-\[13px\] muted selectable">\{j\.id\}<\/div>/, 'the id line is 13px mono');
  const log = read('components/SessionLog.svelte');
  assert.ok(log.includes("{compact ? 'text-[11px] leading-5' : 'text-[13px] leading-5'}"), 'the pane log is 13px, the compact one 11px');
  assert.doesNotMatch(log, /text-\[9px\]/, 'labels are the 11px label');
  assert.equal(log.match(/\{compact \? 'prose compact' : 'prose'\}/g)?.length, 3, 'agent text (short and long) and thinking are prose in the pane');
  assert.match(log, /<div class="flex items-baseline gap-2 font-sans /, 'agent text is sans, its time on the first line baseline');
  assert.ok(log.includes("{:else if prose}<div class=\"{compact ? 'prose compact' : 'prose'} min-w-0 break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0 "), 'the prose starts on the line of the time');
});

test('messages tint by sender', () => {
  const thread = read('components/ThreadPanel.svelte');
  const log = read('components/SessionLog.svelte');
  for (const [rel, text] of [['ThreadPanel', thread], ['SessionLog', log]]) {
    assert.match(text, /import \{ TINT, (logSender|threadSender) \} from '\.\.\/lib\/sender\.ts';/, `${rel} imports TINT`);
    assert.doesNotMatch(text.replace(/<!--[\s\S]*?-->/g, ''), /['"\s]tint(?:\s|['"])/, `${rel} applies tints only through TINT`);
  }
  assert.match(thread, /<li class="plate p-3 flex flex-col gap-1\.5 \{TINT\[threadSender\(m\.from\)\]\}">/, 'a message tints by its sender');
  assert.match(thread, /<li class="plate ember p-3 flex flex-col gap-1\.5 \{TINT\.forge\}">/, 'a secret note is Forge, on its ember plate');
  assert.equal(thread.match(/\{TINT\.forge\} border-l border-line-strong px-2\.5 py-1\.5/g)?.length, 2, 'the Forge reply block, rendered or raw');
  assert.ok(!thread.includes('font-medium text-fg'), 'sender names are font-semibold');
  assert.match(log, /\{#snippet line\([^)]*\)\}\s*<div class="flex items-start gap-2 \{TINT\.cli\} px-1\.5 -mx-1\.5 py-0\.5">/, 'plumbing lines are cli');
  assert.equal(log.match(/\{TINT\[logSender\(it\.kind\)\]\}/g)?.length, 4, 'text, thinking, tool and subagent tint by kind');
  assert.equal(log.match(/px-1\.5 -mx-1\.5/g)?.length, 5, 'every tinted row, the tool and subagent boxes too, shares one edge');
  assert.match(log, /<h3 class="label sticky top-0 z-10 bg-panel/, 'the turn heading keeps bg-panel');
});

test('the card footer stays on one line', () => {
  const footer = elements('components/JobCard.svelte').find((e) => attr(e, 'data-slot') === 'footer')!;
  for (const c of ['flex', 'flex-nowrap', 'min-w-0', 'overflow-hidden']) assert.ok(footer.classes.includes(c), `the footer has ${c}`);
  assert.ok(!footer.classes.some((c) => c.startsWith('flex-wrap') || c.startsWith('gap-y')), 'and never wraps');
  const card = read('components/JobCard.svelte');
  assert.match(card, /<SessionActivity activity=\{act\} extra="normal-case tracking-normal min-w-0 shrink" \/>/, 'the activity shrinks and truncates');
  assert.match(card, /<span class="flex items-center gap-1\.5 text-gleam min-w-0 shrink-\[2\]" title=\{agents\.title\}>/, 'the agents summary shrinks first');
  assert.match(card, /<span class="ml-auto shrink-0 whitespace-nowrap normal-case tracking-normal">/, 'the usage keeps its width at the right');
  assert.match(read('components/SessionActivity.svelte'), /<span class="truncate">/, 'the activity text truncates');
});
