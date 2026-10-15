// The Drafting shell and job surfaces (design/jobs/03-shell.md, 04-job-surfaces.md): every source draws square
// corners and hard-offset shadows and uses none of the pre-Drafting class names, the job surfaces use the Drafting
// markup, and segments and nav links expose their selected state. Reads source files only, like dashboard-svelte.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ancestry, endOf, placements, tags, type Placed } from './svelte-markup.ts';
import { TONE_CLASS } from '../dashboard/src/lib/util.ts';
import { THEME_CHOICES } from '../dashboard/src/lib/theme.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dashboard', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const ROUNDED = /^rounded(-(?!full\b)[\w[\]-]+)?$/;
const BLURRED = /^shadow-(lg|2xl)$/;
// Job 1's aliases, deleted in job 4. `card` alone is the old sheet alias; next to `h` it is the Drafting title style.
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
  // The matcher itself: the classes it must catch, and the Drafting ones it must let through.
  for (const bad of ['rounded', 'rounded-lg', 'md:rounded-xl', 'rounded-t-lg', 'rounded-[4px]', 'shadow-lg', 'shadow-2xl', 'md:shadow-2xl', 'btn-primary', 'hover:text-accent', 'bg-accent/15', 'text-on-accent', 'border-accent', 'kpi-value', 'nav-item', 'prose-md', 'card'])
    assert.ok(banned(bad), `${bad} is caught`);
  for (const ok of ['rounded-full', 'shadow-(--shadow-dialog)', 'shadow-(--shadow-drawer)', 'shadow-[inset_3px_0_0_var(--ink)]', 'md:shadow-(--shadow-dialog)', 'border-line', 'text-ink', 'primary', 'kpi', 'prose', 'nav'])
    assert.ok(!banned(ok), `${ok} passes`);
  assert.deepEqual(bannedIn(['h', 'card', 'line-clamp-2']), [], '`h card` is the Drafting title style');
  assert.deepEqual(bannedIn(['card', 'p-3']), ['card'], '`card` alone is the old alias');
  assert.deepEqual(classTokens(`"btn sm {on ? 'sel' : 'shadow-2xl'}"`), ['btn', 'sm', 'sel', 'shadow-2xl'], 'class tokens include those inside expressions');
  assert.deepEqual(classTokens(`{on ? 'active' : 'md:rounded-xl'}`), ['active', 'md:rounded-xl'], 'class={…} expressions are read too');
  assert.deepEqual(tsClassLists('`<div class="sheet ${x ? `a` : "b"} card"><i class="h card">`'), [['sheet', 'card'], ['h', 'card']], 'TS class strings drop their interpolations');

  const files = svelteFiles();
  assert.ok(files.length >= 35, `checked ${files.length} components`);
  for (const rel of files) {
    const lists = fileClassLists(rel);
    assert.deepEqual(lists.flatMap(bannedIn), [], `${rel} uses only Drafting classes, square corners and hard shadows`);
  }
  const ts = tsFiles();
  assert.ok(ts.some((f) => f.endsWith('.svelte.ts')), 'rune modules are read too');
  for (const rel of ts) assert.deepEqual(tsClassLists(fs.readFileSync(path.join(SRC, rel), 'utf8')).flatMap(bannedIn), [], `${rel} builds only Drafting classes`);
  for (const [tone, cls] of Object.entries(TONE_CLASS)) assert.deepEqual(bannedIn(cls.split(/\s+/)), [], `TONE_CLASS.${tone} is a Drafting chip modifier`);
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
  for (const c of ['min-w-0', 'max-w-full']) assert.ok(line[1].split(/\s+/).includes(c), `agents line has ${c}`);
  assert.match(line[2], /^<span class="dot ink[^"]*"><\/span><span class="truncate">/, 'the dot, then a truncate text span');
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
  for (const c of ['flex', 'flex-col', 'h-dvh']) assert.ok(cls.includes(c), `the aside has ${c}`);
  for (const c of ['h-full', 'overflow-y-auto']) assert.ok(!cls.includes(c), `the aside has no ${c}: the body scrolls, not the drawer`);
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
  assert.ok(boxes >= 8, `checked ${boxes} checkboxes`);

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
  assert.deepEqual([...THEME_CHOICES], ['cyanotype', 'vellum', 'nightprint', 'system']);
  assert.match(general, /nightprint: \$t\('settings\.general\.nightprint'\)/, 'every choice has a label');
  // The theme and the drawings go through lib/theme.ts, which owns <html>'s attributes and their prefs.
  assert.match(general, /setDrawing\('grid', /);
  assert.match(general, /setDrawing\('paper', /);
  assert.match(general, /chooseTheme\(c\)/);
  for (const f of [...svelteFiles(), ...tsFiles()].filter((f) => f !== 'lib/theme.ts')) {
    const text = read(f);
    assert.doesNotMatch(text, /data-(grid|paper)|dataset\.(grid|paper|theme)|dataset\[/, `${f} sets appearance attributes outside lib/theme.ts`);
    assert.doesNotMatch(text, /pref\.set\('(grid|paper|theme)'/, `${f} writes an appearance pref outside lib/theme.ts`);
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
  assert.equal(children[0].name, 'span');
  assert.ok(has(children[0], 'tk'), 'the .tk span comes first');
  assert.deepEqual(children.slice(1).map((e) => attr(e, 'data-slot')), ['title', 'ref', 'state', 'stage', 'progress', 'lenses', 'footer']);

  const markup = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const conds = [...markup.matchAll(/\{(?:#if|:else if)\s+([^}]*)\}/g)].map((x) => x[1]);
  assert.ok(conds.length >= 4, `checked ${conds.length} conditions`);
  for (const c of conds) assert.match(c, /^(m\.|agents)/, `{#if ${c}} reads the card model or the agents line`);
  for (const raw of ['j.state', 'j.stage', 'j.waitingOn', 'j.round']) assert.ok(!text.includes(raw), `JobCard reads no ${raw}`);
  assert.equal(text.split('needsHuman(').length - 1, 1, 'needsHuman( appears once');
  assert.match(attr(root, 'class') ?? '', /\{needsHuman\(j\) \? 'redline' : ''\}/, 'in the root class');
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
  const flash = inFooter.find((e) => e.classes.includes('dot') && e.classes.includes('hl'));
  assert.ok(flash, 'a flash dot in the footer');
  assert.match(attr(flash, 'class') ?? '', /^\{flashing \? 'dot hl' : 'dot invisible'\}/, 'whole literals, so Tailwind sees both and the hidden dot keeps its space');
  assert.equal(attr(flash, 'aria-hidden'), 'true');
});

test('StageStepper is shared by the card and the table', () => {
  const file = 'components/StageStepper.svelte';
  const text = read(file);
  const root = elements(file)[0];
  assert.equal(attr(root, 'role'), 'img');
  assert.match(attr(root, 'aria-label') ?? '', /^\{\$t\('pipeline\.stepper', \{ n: stepPosition\(steps\), total: steps\.length, stage \}\)\}$/);
  for (const cls of ["'dot ink'", "'dot hollow'", "'dot ink outline outline-1 outline-offset-1 outline-ink'", "'dot red outline outline-1 outline-offset-1 outline-redline'"])
    assert.ok(text.includes(cls), `the dot class ${cls} is a whole literal`);
  assert.doesNotMatch(text, /\bas t\b|\(t\)|\bt =>/, 'no loop variable shadows the $t store');
  for (const f of ['components/JobCard.svelte', 'components/JobsTable.svelte']) assert.match(read(f), /<StageStepper steps=\{m\.steps\} stage=\{m\.stage\} \/>/, `${f} renders the stepper`);

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
  for (const gone of ['overflow-x-auto', 'w-(--size-board-column)']) assert.ok(!text.includes(gone), `no ${gone}`);
  for (const want of ['grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-3', 'xl:max-h-[calc(100vh-180px)]', 'grid-cols-[repeat(auto-fill,minmax(236px,1fr))]', 'boardColumns('])
    assert.ok(text.includes(want), `has ${want}`);
  for (const id of ['queued', 'plan', 'build', 'ship', 'done']) assert.ok(text.includes(`$t('pipeline.group.${id}')`), `uses pipeline.group.${id}`);
  const all = [...tsFiles(), ...svelteFiles()].map((f) => [f, read(f)]);
  for (const [f, src] of all) assert.doesNotMatch(src, /\bboardStages\b|\bCORE_STAGES\b/, `${f} has no boardStages or CORE_STAGES`);

  // Open columns count their working sessions; Done does not.
  assert.match(text, /\{#each open as c \(c\.id\)\}\s*\{@const w = workingCount\(c\.jobs, data\.daemons\)\}/);
  const openBlock = text.slice(text.indexOf('{#each open as c'), text.indexOf('{/each}', text.indexOf('{#each open as c')));
  assert.match(openBlock, /\{#if w\}<span class="label text-ink">\{\$t\('live\.columnWorking', \{ count: w \}\)\}<\/span>\{\/if\}/, 'an open column header shows N working');
  const doneBlock = text.slice(text.indexOf('{#if done}'));
  assert.ok(!doneBlock.includes('live.columnWorking') && !doneBlock.includes('workingCount('), "Done's header has no working count");
  assert.equal(text.split("$t('live.columnWorking'").length - 1, 1, 'one working count, in the open columns');
});

test('Inbox lists dependency parks apart, with Resume', () => {
  const file = 'views/Inbox.svelte';
  const text = read(file);
  assert.match(text, /<h2 class="sheet h section w-fit max-w-full px-3 py-1\.5 mt-8 mb-3">\{\$t\('inbox\.parks'\)\}<\/h2>/);
  const parks = text.slice(text.indexOf("$t('inbox.parks')"));
  const block = parks.slice(0, parks.indexOf('{/if}'));
  assert.match(block, /<div class="sheet ticks"><span class="tk"><\/span><div class="overflow-x-auto">\s*<table class="tbl">/, 'a sheet ticks table');
  assert.match(block, /\{#each groups\.parks as j \(j\.id\)\}/);
  assert.match(block, /<DepChips job=\{j\} \/>/);
  assert.match(block, /<JobActions job=\{j\} noteId="park-\{j\.id\}" \/>/);
  assert.match(text, /\{#if groups\.urgent\.length\}/, 'the empty state still keys on the urgent list');
  assert.match(read('lib/dock.ts'), /const actionable = needsHuman\(job\) \|\| isDependencyPark\(job\) \|\|/, "the drawer's dock keeps the gate's actions for parks");
});

// Two backgrounds never conflict: a filled element (chip, button, progress, any bg-*) never shows a pattern through
// or around it, patterns never stack, and a sketched control never sits in another one (two sketches at once).
const CARRIERS = ['hatch', 'hatch-dense', 'crosshatch', 'sketch', 'ground'];
const classesOf = (el: Placed) => classTokens(el.attrs.find((a) => a.name === 'class')?.value ?? '""').map(base);
const isCarrier = (c: string[]) => c.some((x) => CARRIERS.includes(x));
const isOpaque = (c: string[]) => (c.includes('sheet') && !c.includes('dashed')) || ['solid', 'plain', 'chrome', 'bg-panel'].some((x) => c.includes(x));
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
    if (isSketched(el, c) && el.ancestors.some((a) => isSketched(a, classesOf(a)))) out.push(`${file}: ${what} sketches inside a sketched control`);
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
  // Each failure is caught, and an opaque sheet in between passes.
  assert.equal(conflicts('x', '<div class="hatch"><span class="chip ok"></span></div>').length, 1, 'a chip on a hatch');
  assert.equal(conflicts('x', '<div class="sketch p-2"><div><button class="btn sm"></button></div></div>').length, 1, 'a button on a sketch, two levels down');
  assert.equal(conflicts('x', '<div class="ground"><i class="bg-ink"></i></div>').length, 1, 'a bg-* fill on the ground class');
  assert.deepEqual(conflicts('x', '<div class="hatch"><div class="sheet"><span class="chip"></span></div></div>'), [], 'an intervening sheet passes');
  assert.deepEqual(conflicts('x', '<div class="hatch"><div class="solid"><div class="track"><div class="fill"></div></div></div></div>'), [], 'an intervening solid passes');
  assert.equal(conflicts('x', '<div class="hatch"><div class="sheet dashed"><span class="chip"></span></div></div>').length, 1, 'a dashed sheet is see-through');
  assert.equal(conflicts('x', '<div class="sketch"><div class="sheet"><div class="crosshatch"></div></div></div>').length, 1, 'a pattern in a pattern');
  assert.equal(conflicts('x', '<div class="tab"><span class="btn sm"></span></div>').length, 1, 'a button in a tab');
  assert.deepEqual(conflicts('x', '<button class="sheet ticks clickable"><span class="tk"></span><span class="btn sm"></span></button>'), [], 'a card does not sketch, so a button in it is one sketch');
  assert.equal(conflicts('x', '<div class="tab"><button class="chip ok"></button></div>').length, 1, 'a button chip in a tab');
  assert.deepEqual(conflicts('x', '<button class="sheet clickable"><span class="chip live"></span></button>'), [], 'a span chip in a card is fine');

  const files = svelteFiles();
  assert.ok(files.length >= 35, `checked ${files.length} components`);
  for (const rel of files) assert.deepEqual(conflicts(rel, read(rel)), [], `${rel} keeps one background per layer`);
  for (const rel of tsFiles()) {
    for (const list of tsClassLists(read(rel))) assert.ok(!isCarrier(list.map(base)), `${rel} builds a pattern carrier (${list.join(' ')})`);
  }
});

// Text never sits on the grid: the grid and grain show only on bare ground between surfaces, so every word, value,
// caller snippet and component the shell or a view puts on the page has a surface around it. A component this test
// scans itself (GROUND, or a view) is checked inside its own file instead.
const GROUND = ['PageHeader', 'Empty', 'Banner', 'DaemonBar', 'JobCard', 'JobsTable', 'InboxCard', 'CommandTrigger', 'Drawer', 'Settings', 'CommandBar', 'Toast'];
const isSurface = (c: string[]) => (c.includes('sheet') && !c.includes('dashed')) || ['plain', 'solid', 'chrome', 'btn', 'chip', 'input'].some((x) => c.includes(x));

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
  // Rejected: text in a bare div or a dashed (transparent) sheet, an expression, a caller's snippet, an unchecked component.
  assert.equal(bad('<div class="label">Loading</div>'), 1, 'text in a bare div');
  assert.equal(bad('<section class="sheet dashed"><span class="label">Queued</span></section>'), 1, 'text in a sheet dashed');
  assert.equal(bad('<p class="text-muted">{$t("a")} <code>{x}</code></p>'), 2, 'text and an expression on the ground');
  assert.equal(bad('<div class="flex">{@render children()}</div>'), 1, 'a caller snippet outside a sheet');
  assert.equal(bad('<div>{@html md(x)}</div>'), 1, 'raw html on the ground');
  assert.equal(bad('<div class="mt-2"><Unknown /></div>'), 1, 'an unchecked component on the ground');
  // Accepted: the same inside a sheet, plain, solid, chrome or a filled control, inside or as a checked component.
  assert.equal(bad('<div class="sheet ticks"><span class="tk"></span><div class="label">Loading {x}</div>{@render children()}<Unknown /></div>'), 0, 'inside a sheet');
  assert.equal(bad('<header class="plain flex"><span>Queued</span></header><div class="solid">a</div><aside class="chrome">b</aside>'), 0, 'inside plain, solid and chrome');
  assert.equal(bad('<button class="btn sm">Run</button><span class="chip ok">{v}</span><select class="input"><option>a</option></select>'), 0, 'filled controls');
  assert.equal(bad('<Empty>Nothing yet {x}</Empty><PageHeader title="a">{#snippet sub()}{s}{/snippet}</PageHeader>'), 0, 'checked components and their snippets');
  assert.equal(bad('{#snippet kpi(a)}<div class="sheet">{a}</div>{/snippet}<div class="grid">{@render kpi(1)}</div>{#if x}{@const y = 1}{/if}'), 0, 'block tags, @const and a local snippet render place nothing themselves');
  assert.equal(bad('{#snippet row(a)}<span>{a}</span>{/snippet}'), 1, "an unrendered local snippet is checked where it is written");
  assert.equal(bad('{#snippet row(a)}<span>{a}</span>{/snippet}<div class="solid">{@render row(1)}</div><p class="plain">{@render row(2)}</p>'), 0, "a local snippet rendered only on surfaces passes");
  assert.equal(bad('{#snippet row(a)}<span>{a}</span>{/snippet}<div class="solid">{@render row(1)}</div><div>{@render row(2)}</div>'), 1, "a local snippet rendered once on the ground fails");

  const views = fs.readdirSync(path.join(SRC, 'views')).filter((f) => f.endsWith('.svelte'));
  const checked = new Set([...GROUND, ...views.map((f) => f.replace(/\.svelte$/, ''))]);
  const files = ['App.svelte', ...views.map((f) => `views/${f}`), ...GROUND.map((c) => `components/${c}.svelte`)];
  for (const rel of files) assert.deepEqual(onGround(rel, read(rel), checked), [], `${rel} keeps its text on a surface`);
  for (const doc of ['MIGRATION.md', 'README.md']) assert.ok(fs.readFileSync(path.join(ROOT, 'design', doc), 'utf8').includes('Text never sits on the grid'), `design/${doc} states the rule`);
});

/** Every file under dashboard/src, relative to it. */
const srcFiles = () => [...tsFiles(), ...svelteFiles()];

test('the live halo is the only animation and is motion-safe', () => {
  const animate = /(?<![\w-])(?:[\w-]+:)*animate-[\w-]+/g;
  const uses = srcFiles().flatMap((f) => [...read(f).matchAll(animate)].map((m) => [f, m[0]]));
  assert.deepEqual(uses, [['components/LiveDot.svelte', 'motion-safe:animate-ping']], 'one animate-* token in dashboard/src: the motion-safe halo');
  const dot = read('components/LiveDot.svelte');
  assert.match(dot, /<span class="dot ink absolute inset-0 opacity-75 motion-safe:animate-ping"><\/span><span class="dot ink relative"><\/span>/);
  assert.match(dot, /<span class="dot hollow shrink-0" aria-hidden="true"><\/span>/, 'off: a hollow dot');
  assert.match(dot, /<span class="relative inline-flex shrink-0" aria-hidden="true">/, 'on: the dot and halo are aria-hidden');

  assert.match(read('components/SessionActivity.svelte'), /<LiveDot on=\{activity\.kind === 'working'\} \/>/);
  for (const f of ['components/JobCard.svelte', 'components/Drawer.svelte']) assert.match(read(f), /<SessionActivity\b/, `${f} renders the live dot through SessionActivity`);
  assert.match(read('App.svelte'), /<LiveDot\b/, 'App.svelte renders the live dot');

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
});

test('no custom keyframes or animate utilities in dashboard sources', () => {
  const files = [['style.css', fs.readFileSync(path.join(ROOT, 'dashboard', 'style.css'), 'utf8')], ...srcFiles().map((f) => [f, read(f)])];
  assert.ok(files.length > 40, `checked ${files.length} files`);
  for (const [f, text] of files) {
    assert.doesNotMatch(text, /@keyframes/, `${f} defines no @keyframes`);
    assert.doesNotMatch(text, /--animate-/, `${f} sets no --animate- variable`);
    assert.doesNotMatch(text, /@utility\s+animate-/, `${f} declares no animate utility`);
  }
});

test('design docs name the live halo', () => {
  const DESIGN = path.join(ROOT, 'design');
  const readme = fs.readFileSync(path.join(DESIGN, 'README.md'), 'utf8');
  const section = (name: string) => {
    const start = readme.indexOf(`\n## ${name}\n`);
    assert.ok(start >= 0, `design/README.md has § ${name}`);
    const end = readme.indexOf('\n## ', start + 1);
    return readme.slice(start, end < 0 ? undefined : end);
  };
  const SENTENCE = 'one looping `animate-ping` halo on the live dot marks an active session; it is the only looping motion and it is off under reduced motion';
  for (const name of ['States', 'Motion']) assert.ok(section(name).includes(SENTENCE), `§ ${name} names the live halo`);
  for (const f of ['README.md', 'preview.html']) assert.ok(fs.existsSync(path.join(DESIGN, 'components', 'LiveDot', f)), `design/components/LiveDot/${f} exists`);
  const index = fs.readFileSync(path.join(DESIGN, 'components', 'index.html'), 'utf8');
  for (const href of ['LiveDot/preview.html', 'LiveDot/README.md']) assert.ok(index.includes(`href="${href}"`), `index.html links ${href}`);
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

test('the sidebar and phone strip show the live session indicator', () => {
  assert.doesNotMatch(read('lib/view.ts'), /export const activeSessions\b/, 'view.ts no longer exports activeSessions');
  const app = read('App.svelte');
  assert.match(app, /import \{ activeSessions \} from '\.\/lib\/live\.ts';/);
  assert.doesNotMatch(app, /import \{[^}]*\bactiveSessions\b[^}]*\} from '\.\/lib\/view\.ts'/);
  assert.match(app, /const active = \$derived\(activeSessions\(S\.data\?\.daemons\)\)/);
  assert.match(app, /const activeTitle = \$derived\(active\.count \? active\.ids\.map\(\(id\) => \(id === INBOX_SCOPE \? \$t\('live\.inbox'\) : id\)\)\.join\('\\n'\) : \$t\('live\.none'\)\)/, 'the tooltip lists active ids, the inbox by name');

  const walked = elements('App.svelte');
  for (const id of ['footer-sessions', 'mobile-sessions']) {
    const cell = walked.find((e) => attr(e, 'id') === id);
    assert.ok(cell, `#${id}`);
    assert.equal(attr(cell, 'title'), '{activeTitle}', `#${id} carries the active-session tooltip`);
    const dots = walked.filter((e) => e.name === 'LiveDot' && e.parents.includes(cell));
    assert.equal(dots.length, 1, `#${id} renders one <LiveDot`);
    assert.equal(attr(dots[0], 'on'), '{active.count > 0}');
    assert.ok(!walked.some((e) => e.parents.includes(cell) && e.attrs.some((a) => a.name === 'aria-live')), `#${id} is not a live region`);
  }
  assert.match(app, /\$t\('app\.tblock\.sessionsValue', \{ count: active\.count \}\)/);
  const mobileAt = app.indexOf('id="mobile-sessions"');
  assert.ok(app.indexOf('id="mobile-nav"') < mobileAt && mobileAt < app.indexOf('id="settings-open-mobile"'), 'the phone strip puts it between the nav and the settings button');

  assert.match(read('components/Nav.svelte'), /navCounts\(S\.data\?\.jobs \?\? \[\]\)/, 'the Needs-you badge reads the same jobs snapshot as the board');
});

test('the drawer marks new rows and counts unread Thread changes', () => {
  const file = 'components/Drawer.svelte';
  const text = read(file);
  const markup = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const chips = markup.indexOf('<PrChip pr={j.pr} />');
  const line = markup.indexOf('<SessionActivity');
  assert.ok(chips > 0 && line > chips && line < markup.indexOf('{#if j.reason}'), 'the activity line follows the chips, before the reason');
  assert.ok(markup.includes(`{#if j.kind !== 'feature'}<Chip tone="info" text={j.kind} />{/if}{#if activity}<SessionActivity {activity} extra="caption" />{/if}</div>`), 'inside the summary row, after the kind chip');
  assert.match(text, /const activity = \$derived\(job \? sessionActivity\(S\.data\?\.daemons\?\.jobs\?\.\[job\.id\], shown\?\.detail\.events\.at\(-1\)\?\.ts\) : null\)/);

  assert.match(text, /const unread = \$derived\(shown && job \? unreadCount\(threadMarks\(threadItems\(/);
  assert.match(text, /S\.threadSeen\[job\.id\] \?\? null\)/);
  assert.match(markup, /\{\$t\('drawer\.threadTab'\)\}\{#if unread > 0\}<span class="chip hl ml-1\.5">\{\$t\('drawer\.threadUnread', \{ count: unread \}\)\}<\/span>\{\/if\}/, 'the Thread tab shows chip hl N new');

  assert.match(text, /const fresh = \$derived\(shown \? freshCount\(shown\.detail\.events\.length, S\.drawer\.eventsAtOpen\) : 0\)/);
  assert.match(markup, /\{#if i < fresh\}<span class="dot hl size-1\.5 shrink-0 self-center" aria-hidden="true"><\/span><span class="sr-only">\{\$t\('live\.new'\)\}<\/span>\{\/if\}/, 'fresh Timeline rows start with dot hl and a hidden "new"');
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
  assert.match(thread, /\{#if seenAtOpen && !seenAtOpen\.has\(threadMark\(m\)\)\}<span class="dot hl size-1\.5 shrink-0" aria-hidden="true"><\/span><span class="sr-only">\{\$t\('live\.new'\)\}<\/span>\{\/if\}/, 'a message not in the baseline is marked new');
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
  assert.match(state, /import \{ DEFAULT_DRAWER_TAB, type DrawerTab \} from '\.\/drawer\.ts';/);
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
  assert.ok(drawer.includes('{#key j.id}<SessionLog scope={j.id} active={open} />{/key}'), 'keyed by job id, closed with the drawer');
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

/** Drawer.svelte's markup walked, with its scrolling body, header block, tab strip and tab panel picked out. */
function drawerParts() {
  const walked = elements('components/Drawer.svelte');
  const one = (pred: (e: El) => boolean, what: string) => {
    const hits = walked.filter(pred);
    assert.equal(hits.length, 1, `Drawer has one ${what}`);
    return hits[0];
  };
  const body = one((e) => attr(e, 'bind:this') === '{body}', 'scrolling body (bind:this={body})');
  const head = one((e) => attr(e, 'bind:this') === '{head}', 'header block (bind:this={head})');
  const strip = one((e) => attr(e, 'role') === 'tablist', 'tablist');
  const panel = one((e) => attr(e, 'role') === 'tabpanel', 'tabpanel');
  const tabs = walked.filter((e) => attr(e, 'role') === 'tab');
  return { walked, body, head, strip, panel, tabs };
}

test('drawer tabs are an ARIA tablist', () => {
  const text = read('components/Drawer.svelte');
  const { body, head, strip, panel, tabs } = drawerParts();
  assert.match(text, /import \{ DRAWER_TABS, moveDrawerTab, tabScrollTop, type DrawerTab \} from '\.\.\/lib\/drawer\.ts';/);
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

  // AC7: sticky, opaque and above the content, a direct child of the scrolling body outside the header block.
  assert.ok(has(strip, 'tabs', 'sticky', 'top-0', 'solid'), `the strip is a sticky, opaque .tabs (${strip.classes.join(' ')})`);
  assert.ok(strip.classes.some((c) => /^z-\d+$/.test(c)), 'and has a z-index');
  // AC17: on a phone it scrolls sideways and never grows a vertical scrollbar of its own.
  assert.ok(has(strip, 'overflow-x-auto', 'overflow-y-hidden'), 'the strip scrolls only sideways');
  assert.equal(strip.parents.at(-1), body, 'the strip is a direct child of the scrolling body');
  assert.ok(!strip.parents.includes(head), 'outside the header block');
  assert.equal(head.parents.at(-1), body, 'the header block is a direct child of the body');
  assert.equal(panel.parents.at(-1), body, 'and so is the panel');
  assert.ok(has(body, 'min-h-0', 'flex-1', 'overflow-y-auto'), 'the body is what scrolls');
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
  assert.ok(headHtml.includes('{#if scopeVerbs(j).length}<CommandTrigger variant="drawer" job={j.id} />{/if}'), 'the title row keeps Command for this job');
  assert.ok(headHtml.includes(`<CloseButton size="sm" label={$t('drawer.close')} onclick={closeDrawer} />`), 'and the close button');
  const rows = walked.filter((e) => e.parents.at(-1) === head);
  assert.deepEqual(rows.map((e) => e.name), ['div', 'div', 'div'], 'the title row, the summary row, the reason line');
  const summary = rows[1];
  assert.ok(has(summary, 'flex', 'flex-wrap', 'items-center', 'gap-1.5'), 'one wrapping summary row');
  const inSummary = walked.filter((e) => e.parents.includes(summary)).map((e) => e.name);
  for (const c of ['StateChip', 'Chip', 'PrChip', 'SessionActivity']) assert.ok(inSummary.includes(c), `the summary row holds <${c}>`);
  assert.match(headHtml, /<span class="chip ink">\{STAGE_LABEL\[j\.stage\] \?\? j\.stage\}<\/span>/, 'the stage chip');
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
  assert.deepEqual(chain, ["#if shown.tab === 'thread'", ":else if shown.tab === 'log'", ":else if shown.tab === 'files'", ":else if shown.tab === 'timeline'", ":else if shown.tab === 'details'"]);

  // AC11: no scroll hacks.
  for (const s of ['scrollIntoView', 'setTimeout', 'scrolledFor', 'tabStrip']) assert.ok(!text.includes(s), `Drawer has no ${s}`);
});

test('drawer scroll resets when the job id changes', () => {
  const text = read('components/Drawer.svelte');
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(text)?.[1] ?? '';
  assert.match(script, /let body = \$state<HTMLDivElement>\(\);/);
  assert.match(script, /let head = \$state<HTMLDivElement>\(\);/);
  const effects = [...script.matchAll(/\$effect\(\(\) => \{/g)].map((m) => script.slice(m.index, endOf(script, m.index + m[0].length - 1) + 1));
  const reset = effects.filter((e) => /S\.drawer\.id/.test(e));
  assert.equal(reset.length, 1, 'one effect reads the drawer id');
  assert.match(reset[0], /void S\.drawer\.id;\s*if \(body\) body\.scrollTop = 0;/, 'and puts the body back at the top');
  assert.doesNotMatch(reset[0], /S\.drawerView|shown|job\b/, 'it reads only the id, so a poll refresh never moves the scroll');

  const select = fnBody(script.replace(/\n {2}/g, '\n'), 'function selectTab(');
  const scroll = select.indexOf('body.scrollTop = tabScrollTop(body.scrollTop, head.offsetHeight)');
  assert.ok(scroll > 0, 'switching tabs lands the new tab under the stuck strip');
  assert.ok(select.indexOf('setDrawerTab(tab)') > scroll, 'before the tab changes');
  assert.match(select, /if \(focus\) document\.getElementById\('drawer-tab-' \+ tab\)\?\.focus\(\);/);
});

test('drawer entry points pick their tab', () => {
  const calls = srcFiles().flatMap((f) => [...read(f).matchAll(/\bopenDrawer\(([^)]*)\)/g)].map((m) => ({ f, args: m[1] })));
  assert.ok(calls.length >= 15, `found ${calls.length} openDrawer calls`);
  assert.deepEqual(calls.filter((c) => /'thread'/.test(c.args)), [], "no caller asks for 'thread': it is the default");
  const tabbed = calls.filter((c) => /'(log|files|timeline|details)'/.test(c.args)).map((c) => `${c.f}: openDrawer(${c.args})`).sort();
  assert.deepEqual(tabbed, [
    "components/DaemonBar.svelte: openDrawer(j.id, null, 'log')",
    "components/InboxCard.svelte: openDrawer(j.id, doc, 'files')",
    "components/PermissionPrompts.svelte: openDrawer(s, null, 'log')",
  ], 'only the session entry points open on Log, and Read {doc} on Files');
  assert.ok(read('components/CommandBar.svelte').includes('openDrawer(res.id);'), 'a new job opens on the default tab');
});

/** An attribute's value with its quotes dropped (`"x"` → `x`; `{x}` stays as written). */
const attrOf = (el: { attrs: { name?: string; value?: string }[] }, name: string) => unquote(el.attrs.find((a) => a.name === name)?.value);

test('the sidebar is navigation only', () => {
  const app = elements('App.svelte');
  const sidebar = app.find((e) => e.name === 'aside' && attrOf(e, 'id') === 'sidebar');
  assert.ok(sidebar, 'aside#sidebar');
  const inside = app.filter((e) => e.parents.includes(sidebar));
  assert.ok(inside.some((e) => e.name === 'nav' && attrOf(e, 'id') === 'nav'), 'the sidebar keeps the nav');
  assert.ok(inside.some((e) => e.classes.includes('tblock')), 'and the title block');
  const popups = inside.filter((e) => e.attrs.some((a) => a.name === 'aria-haspopup'));
  assert.deepEqual(popups.map((e) => attrOf(e, 'id')), ['settings-open'], 'only Settings opens a dialog from the sidebar');
  const phone = app.find((e) => e.name === 'header' && e.classes.includes('md:hidden'));
  assert.ok(phone, 'the phone strip');
  const phoneButtons = app.filter((e) => e.name === 'button' && e.parents.includes(phone));
  assert.deepEqual(phoneButtons.map((e) => attrOf(e, 'id')), ['settings-open-mobile'], 'the phone strip keeps only the settings button');
  const all = (fs.readdirSync(SRC, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((e) => e.isFile()).map((e) => path.relative(SRC, path.join(e.parentPath, e.name)));
  assert.ok(all.includes('App.svelte') && all.includes(path.join('messages', 'en.json')), `walked ${all.length} files`);
  for (const rel of all) assert.ok(!read(rel).includes('command-open'), `${rel} mentions no command-open button`);
});

test('command triggers: header on every view, phone FAB in the inert shell, drawer', () => {
  const header = read('components/PageHeader.svelte');
  assert.equal(header.match(/<CommandTrigger\b/g)?.length, 1, 'PageHeader renders one trigger');
  assert.ok(header.includes('{@render right?.()}<CommandTrigger variant="header" />'), "the header trigger follows the view's own controls");
  const h1 = elements('components/PageHeader.svelte').find((e) => e.name === 'h1');
  assert.equal(attrOf(h1!, 'tabindex'), '-1', 'the heading is the focus fallback');
  const views = fs.readdirSync(path.join(SRC, 'views')).filter((f) => f.endsWith('.svelte'));
  assert.equal(views.length, 6);
  for (const v of views) assert.equal(read(`views/${v}`).match(/<PageHeader\b/g)?.length, 1, `${v} renders one PageHeader`);

  const shortcut = svelteFiles().flatMap((rel) => elements(rel).filter((e) => attrOf(e, 'aria-keyshortcuts') === 'Meta+K Control+K').map((e) => ({ rel, e })));
  assert.equal(shortcut.length, 1, 'one element announces the palette shortcut');
  assert.equal(shortcut[0].rel, 'components/CommandTrigger.svelte');
  assert.equal(attrOf(shortcut[0].e, 'aria-haspopup'), 'dialog');
  assert.ok(shortcut[0].e.classes.includes('max-md:hidden'), 'the header trigger is hidden below md');

  const trigger = elements('components/CommandTrigger.svelte');
  const fab = trigger.find((e) => e.name === 'div' && has(e, 'md:hidden', 'fixed', 'z-20'));
  assert.ok(fab, 'the FAB wrapper is md:hidden fixed z-20');
  assert.equal(fab.first?.name, 'button');
  assert.ok(attrOf(fab.first!, 'aria-label'), 'the FAB is labelled');
  assert.equal(attrOf(fab.first!, 'aria-haspopup'), 'dialog');

  const app = read('App.svelte');
  assert.equal(app.match(/<CommandTrigger variant="fab" \/>/g)?.length, 1, 'App renders the FAB once');
  const fabUse = elements('App.svelte').find((e) => e.name === 'CommandTrigger');
  assert.ok(fabUse, 'the FAB in App');
  const shell = fabUse.parents.find((p) => p.name === 'div' && attrOf(p, 'inert') === '{settingsOpen || palette.open}');
  assert.ok(shell && has(shell, 'flex', 'min-h-screen'), 'inside the shell div whose inert covers the palette');
  assert.ok(!fabUse.parents.some((p) => p.name === 'main'), 'outside main, whose falloff isolates');

  const drawer = read('components/Drawer.svelte');
  assert.equal(drawer.match(/<CommandTrigger variant="drawer"/g)?.length, 1, 'the drawer header has one "Command for this job"');
  assert.ok(drawer.includes('{#if scopeVerbs(j).length}<CommandTrigger variant="drawer" job={j.id} />{/if}'), 'only for a job with something to command');

  const view = elements('App.svelte').find((e) => attrOf(e, 'id') === 'view');
  assert.ok(view && has(view, 'pb-24', 'md:pb-6'), "#view's last row stays clear of the FAB");
  const toast = elements('components/Toast.svelte').find((e) => attrOf(e, 'id') === 'toast');
  assert.ok(toast && has(toast, 'bottom-24', 'md:bottom-4'), 'the toast sits above the FAB on phones');
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
  assert.ok(scope && has(scope, 'chip', 'ink', 'sm'), 'the scope chip is sm, beside its sm clear button');

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
  const markup = read('components/Toast.svelte').replace(/<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, '');
  const live = markup.indexOf('role="status"');
  const before = markup.slice(0, live);
  assert.ok(live > 0 && (before.match(/\{#(if|each|key|await)\b/g) ?? []).length === (before.match(/\{\/(if|each|key|await)\}/g) ?? []).length, 'no open block wraps the live region: it is always in the DOM');
  const root = toast.find((e) => attrOf(e, 'id') === 'toast');
  assert.ok(root && has(root, 'bottom-24', 'md:bottom-4'), '#toast keeps its position');
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
  const header = elements('components/CommandTrigger.svelte').find((e) => attrOf(e, 'aria-keyshortcuts'));
  assert.ok(header && has(header, 'btn', 'dashed') && !header.classes.includes('sm'), `the header trigger is btn dashed (${header?.classes.join(' ')})`);
  const fab = elements('components/CommandTrigger.svelte').find((e) => e.classes.includes('primary'));
  assert.ok(fab?.classes.includes('size-14!'), 'the FAB stays 56px over btn icon');
  const right = elements('components/PageHeader.svelte').find((e) => e.name === 'div' && e.first?.name === 'CommandTrigger');
  assert.ok(right && right.classes.includes('gap-2') && !right.classes.includes('gap-2.5'), `PageHeader's right container uses gap-2 (${right?.classes.join(' ')})`);

  // The daemon bar and the session log are sm rows: their chips and fields take chip sm and input sm.
  const daemonChips = elements('components/DaemonBar.svelte').filter((e) => e.classes.includes('chip'));
  assert.ok(daemonChips.length >= 6, `checked ${daemonChips.length} daemon bar chips`);
  for (const c of daemonChips) assert.ok(c.classes.includes('sm'), `DaemonBar: <${c.name} class="${c.classes.join(' ')}"> is chip sm`);
  const log = elements('components/SessionLog.svelte');
  const pill = log.find((e) => attrOf(e, 'role') === 'status' && e.classes.includes('chip'));
  assert.ok(pill?.classes.includes('sm'), 'the session pill is chip sm');
  const search = log.find((e) => e.name === 'input' && attrOf(e, 'type') === 'search');
  assert.ok(search && has(search, 'input', 'sm'), 'the session filter is input sm');
  const select = log.find((e) => e.name === 'select');
  assert.ok(select && has(select, 'input', 'sm'), 'the mode select is input sm');

  // The issue chooser's other-ref Link sits beside an md input.
  const other = elements('components/IssueLinkActions.svelte').find((e) => e.name === 'button' && attrOf(e, 'disabled') === '{!otherRef}');
  assert.ok(other && other.classes.includes('btn') && !other.classes.includes('sm'), `the other-ref button is btn (${other?.classes.join(' ')})`);

  // The Inbox PR row: two md buttons in a gap-2 flex, not a literal space.
  const inbox = elements('views/Inbox.svelte');
  const open = inbox.find((e) => e.name === 'a' && e.classes.includes('btn'));
  const cell = open?.parents.at(-1);
  assert.ok(cell && cell.name === 'div' && has(cell, 'flex', 'gap-2'), `the PR-row buttons share a gap-2 flex (${cell?.classes.join(' ')})`);
  assert.equal(inbox.filter((e) => e.parents.at(-1) === cell && e.classes.includes('btn')).length, 2, 'both buttons sit in it');

  const dock = elements('components/ActionDock.svelte').find((e) => e.name === 'div' && e.first?.name === 'button' && e.first.classes.includes('primary'));
  assert.ok(dock && dock.classes.includes('gap-2') && !dock.classes.includes('gap-3'), 'the resume row uses gap-2');
  const unsaved = elements('components/settings/ConfigTab.svelte').find((e) => has(e, 'chip', 'rev'));
  assert.ok(unsaved?.classes.includes('sm'), 'the unsaved chip sits in the save row as chip sm');
  // The phone rule gives every button 44px; a btn needs no min-h-11 of its own.
  for (const rel of ['components/settings/AboutTab.svelte', 'components/settings/ConfigTab.svelte', 'components/settings/DiagnosticsTab.svelte'])
    for (const el of elements(rel).filter((e) => e.classes.includes('btn'))) assert.ok(!el.classes.includes('min-h-11'), `${rel}: a btn carries no min-h-11`);
});
