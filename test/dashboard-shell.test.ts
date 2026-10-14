// The Drafting shell and job surfaces (design/jobs/03-shell.md, 04-job-surfaces.md): every source draws square
// corners and hard-offset shadows and uses none of the pre-Drafting class names, the job surfaces use the Drafting
// markup, and segments and nav links expose their selected state. Reads source files only, like dashboard-svelte.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endOf, tags } from './svelte-markup.ts';
import { TONE_CLASS } from '../dashboard/src/lib/util.ts';

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

const unquote = (v: string | undefined) => (v ?? '').replace(/^["']|["']$/g, '');

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
});

test('Inbox lists dependency parks apart, with Resume', () => {
  const file = 'views/Inbox.svelte';
  const text = read(file);
  assert.match(text, /<h2 class="h section mt-8 mb-3">\{\$t\('inbox\.parks'\)\}<\/h2>/);
  const parks = text.slice(text.indexOf("$t('inbox.parks')"));
  const block = parks.slice(0, parks.indexOf('{/if}'));
  assert.match(block, /<div class="sheet ticks"><span class="tk"><\/span><div class="overflow-x-auto">\s*<table class="tbl">/, 'a sheet ticks table');
  assert.match(block, /\{#each groups\.parks as j \(j\.id\)\}/);
  assert.match(block, /<DepChips job=\{j\} \/>/);
  assert.match(block, /<JobActions job=\{j\} noteId="park-\{j\.id\}" \/>/);
  assert.match(text, /\{#if groups\.urgent\.length\}/, 'the empty state still keys on the urgent list');
  assert.match(read('components/ThreadPanel.svelte'), /const actionable = \$derived\(needsHuman\(job\) \|\| isDependencyPark\(job\) \|\|/, "the drawer's Thread keeps Resume for parks");
});
