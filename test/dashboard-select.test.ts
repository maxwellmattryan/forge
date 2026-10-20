// The dashboard's Select: lib/select.ts's keyboard model, Select.svelte's combobox/listbox markup, and its call sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tags } from './svelte-markup.ts';
import { CLOSED, TYPEAHEAD_MS, edgeIndex, moveActive, openAt, selectKey, selectedIndex, typeahead } from '../dashboard/src/lib/select.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'dashboard', 'src');
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

type Tag = ReturnType<typeof tags>[number];
/** An attribute's value with its quotes removed; undefined when absent, true when a bare attribute. */
function attr(tag: Tag, name: string): string | true | undefined {
  const a = tag.attrs.find((x) => x.name === name);
  if (!a) return undefined;
  if (a.value === undefined) return true;
  return a.value.replace(/^(["'])([\s\S]*)\1$/, '$2');
}

const opts = (...labels: string[]) => labels.map((label) => ({ value: label.toLowerCase(), label }));
const FRUIT = opts('Apple', 'Banana', 'Blueberry', 'Cherry', 'Date');
const open = (active: number) => ({ open: true, active, typed: '', typedAt: 0 });

test('selectKey opens on the closed keys', () => {
  // Selected Cherry (3): the opening keys open on it.
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ']) {
    const s = selectKey(CLOSED, { key }, FRUIT, 3, 1000);
    assert.deepEqual(s, { state: open(3), commit: null, handled: true }, key);
  }
  assert.deepEqual(selectKey(CLOSED, { key: 'ArrowDown', altKey: true }, FRUIT, 3, 1000).state, open(3), 'Alt+ArrowDown');
  // Nothing selected: the first enabled option.
  assert.equal(selectKey(CLOSED, { key: 'ArrowDown' }, FRUIT, -1, 1000).state.active, 0);
  assert.equal(selectKey(CLOSED, { key: 'Home' }, FRUIT, 3, 1000).state.active, 0);
  assert.equal(selectKey(CLOSED, { key: 'End' }, FRUIT, 1, 1000).state.active, 4);
  // A printable key opens and runs type-ahead from the selected option.
  const typed = selectKey(CLOSED, { key: 'b' }, FRUIT, 0, 1000);
  assert.deepEqual(typed, { state: { open: true, active: 1, typed: 'b', typedAt: 1000 }, commit: null, handled: true });
  // Other keys on a closed Select are the page's: Escape, Tab, a letter with Alt.
  for (const ev of [{ key: 'Escape' }, { key: 'Tab' }, { key: 'x', altKey: true }, { key: 'Shift' }]) {
    const s = selectKey(CLOSED, ev, FRUIT, 3, 1000);
    assert.equal(s.handled, false, ev.key);
    assert.equal(s.state, CLOSED);
    assert.equal(s.commit, null);
  }
  assert.equal(selectedIndex(FRUIT, 'cherry'), 3);
  assert.equal(selectedIndex(FRUIT, 'kiwi'), -1);
  assert.equal(openAt(FRUIT, 2), 2);
});

test('selectKey moves and clamps while open', () => {
  assert.equal(selectKey(open(1), { key: 'ArrowDown' }, FRUIT, 1, 0).state.active, 2);
  assert.equal(selectKey(open(1), { key: 'ArrowUp' }, FRUIT, 1, 0).state.active, 0);
  // No wrap at either end.
  assert.equal(selectKey(open(4), { key: 'ArrowDown' }, FRUIT, 1, 0).state.active, 4);
  assert.equal(selectKey(open(0), { key: 'ArrowUp' }, FRUIT, 1, 0).state.active, 0);
  assert.equal(selectKey(open(2), { key: 'Home' }, FRUIT, 1, 0).state.active, 0);
  assert.equal(selectKey(open(2), { key: 'End' }, FRUIT, 1, 0).state.active, 4);
  const s = selectKey(open(2), { key: 'ArrowDown' }, FRUIT, 1, 0);
  assert.equal(s.handled, true);
  assert.equal(s.commit, null);
  assert.equal(s.state.open, true);
});

test('selectKey skips disabled options', () => {
  const o = [{ value: 'a', label: 'A', disabled: true }, { value: 'b', label: 'B' }, { value: 'c', label: 'C', disabled: true }, { value: 'd', label: 'D' }, { value: 'e', label: 'E', disabled: true }];
  assert.equal(moveActive(o, 1, 1), 3);
  assert.equal(moveActive(o, 3, -1), 1);
  assert.equal(moveActive(o, 3, 1), 3, 'only disabled ones below: stays');
  assert.equal(moveActive(o, 1, -1), 1);
  assert.equal(edgeIndex(o, 'first'), 1);
  assert.equal(edgeIndex(o, 'last'), 3);
  assert.equal(openAt(o, 0), 1, 'a disabled selected option opens on the first enabled one');
  assert.equal(selectKey(open(1), { key: 'ArrowDown' }, o, -1, 0).state.active, 3);
  assert.equal(selectKey(CLOSED, { key: 'End' }, o, -1, 0).state.active, 3);
  assert.equal(typeahead(o, 0, 'c'), -1, 'type-ahead never lands on a disabled option');
  assert.equal(selectKey(open(1), { key: 'c' }, o, -1, 0).state.active, 1);
});

test('selectKey commits on Enter, Space and Alt+ArrowUp', () => {
  for (const ev of [{ key: 'Enter' }, { key: ' ' }, { key: 'ArrowUp', altKey: true }]) {
    assert.deepEqual(selectKey(open(2), ev, FRUIT, 0, 5000), { state: CLOSED, commit: 2, handled: true }, ev.key);
  }
});

test('selectKey closes on Escape and Tab without committing', () => {
  assert.deepEqual(selectKey(open(2), { key: 'Escape' }, FRUIT, 0, 0), { state: CLOSED, commit: null, handled: true });
  assert.deepEqual(selectKey(open(2), { key: 'Tab' }, FRUIT, 0, 0), { state: CLOSED, commit: null, handled: false }, 'Tab moves focus on as normal');
});

test('selectKey ignores modifier and composing keys', () => {
  for (const ev of [{ key: 'k', ctrlKey: true }, { key: 'k', metaKey: true }, { key: 'ArrowDown', ctrlKey: true }, { key: 'Enter', isComposing: true }, { key: 'a', isComposing: true }]) {
    for (const st of [CLOSED, open(2)]) {
      const s = selectKey(st, ev, FRUIT, 0, 0);
      assert.equal(s.handled, false, JSON.stringify(ev));
      assert.equal(s.state, st);
      assert.equal(s.commit, null);
    }
  }
});

test('selectKey with no enabled option', () => {
  const none = [{ value: 'a', label: 'A', disabled: true }];
  for (const o of [[], none]) {
    const s = selectKey(CLOSED, { key: 'ArrowDown' }, o, -1, 0);
    assert.deepEqual(s, { state: open(-1), commit: null, handled: true });
    assert.equal(selectKey(s.state, { key: 'ArrowDown' }, o, -1, 0).state.active, -1);
    assert.deepEqual(selectKey(s.state, { key: 'Enter' }, o, -1, 0), { state: CLOSED, commit: null, handled: true });
  }
});

test('rich options keep the keyboard model', () => {
  const rich = [
    { value: '', label: 'Inherit', icon: 'settings' as const, hint: 'From the config' },
    { value: 'low', label: 'Low', separator: true, group: 'Levels' },
    { value: 'medium', label: 'Medium', group: 'Levels', disabled: true, hint: 'Saving' },
    { value: 'high', label: 'High', group: 'Levels' },
    { value: 'max', label: 'Max', group: 'Other', separator: true, icon: 'gauge' as const },
  ];
  // The same options without the presentation fields give the same answers.
  const plain = rich.map(({ value, label, disabled }) => ({ value, label, disabled }));
  for (const o of [rich, plain]) {
    assert.equal(selectedIndex(o, 'high'), 3, 'indices stay flat across groups');
    assert.equal(openAt(o, 2), 0, 'a disabled selected option opens on the first enabled one');
    assert.equal(moveActive(o, 1, 1), 3, 'the disabled entry is skipped');
    assert.equal(moveActive(o, 3, -1), 1);
    assert.equal(moveActive(o, 3, 1), 4, 'a separator or a new group is no stop');
    assert.equal(edgeIndex(o, 'last'), 4);
    assert.equal(typeahead(o, 0, 'm'), 4, 'type-ahead skips the disabled Medium');
    assert.equal(typeahead(o, 0, 'from'), -1, 'type-ahead matches the label, not the hint');
    assert.equal(typeahead(o, 0, 'levels'), -1, 'nor the group');
    assert.equal(typeahead(o, 1, 'i'), 0);
    assert.deepEqual(selectKey(CLOSED, { key: 'End' }, o, 0, 0).state, open(4));
    assert.deepEqual(selectKey(open(1), { key: 'Enter' }, o, 0, 0), { state: CLOSED, commit: 1, handled: true });
    assert.deepEqual(selectKey(open(2), { key: 'Enter' }, o, 0, 0), { state: CLOSED, commit: null, handled: true }, 'a disabled entry is never chosen');
  }
});

test('typeahead matches a prefix and wraps', () => {
  assert.equal(typeahead(FRUIT, 0, 'bl'), 2);
  assert.equal(typeahead(FRUIT, 0, 'BLUE'), 2, 'case-insensitive');
  assert.equal(typeahead(FRUIT, 4, 'ch'), 3, 'wraps from the end');
  assert.equal(typeahead(FRUIT, 0, 'zz'), -1);
  // Typed within TYPEAHEAD_MS: the buffer grows and refines from the active option.
  let s = selectKey(open(0), { key: 'b' }, FRUIT, 0, 1000);
  assert.equal(s.state.active, 1);
  s = selectKey(s.state, { key: 'l' }, FRUIT, 0, 1000 + TYPEAHEAD_MS - 1);
  assert.deepEqual(s.state, { open: true, active: 2, typed: 'bl', typedAt: 1000 + TYPEAHEAD_MS - 1 });
  // No match: the active option stays.
  assert.equal(selectKey(s.state, { key: 'x' }, FRUIT, 0, 1600).state.active, 2);
});

test('typeahead cycles a repeated character', () => {
  let s = selectKey(open(0), { key: 'b' }, FRUIT, 0, 1000);
  assert.equal(s.state.active, 1);
  s = selectKey(s.state, { key: 'b' }, FRUIT, 0, 1100);
  assert.equal(s.state.active, 2, 'the same character moves to the next match');
  s = selectKey(s.state, { key: 'B' }, FRUIT, 0, 1200);
  assert.equal(s.state.active, 1, 'and wraps back to the first');
});

test('typeahead buffer expires', () => {
  let s = selectKey(open(0), { key: 'b' }, FRUIT, 0, 1000);
  s = selectKey(s.state, { key: 'd' }, FRUIT, 0, 1000 + TYPEAHEAD_MS);
  assert.equal(s.state.typed, 'd', 'a key after TYPEAHEAD_MS starts a new buffer');
  assert.equal(s.state.active, 4);
});

test('space extends a live buffer', () => {
  const o = opts('New York', 'Newark', 'Nice');
  let s = selectKey(open(2), { key: 'n' }, o, 2, 1000);
  s = selectKey(s.state, { key: 'e' }, o, 2, 1100);
  s = selectKey(s.state, { key: 'w' }, o, 2, 1200);
  s = selectKey(s.state, { key: ' ' }, o, 2, 1300);
  assert.equal(s.commit, null, 'space while typing is part of the buffer');
  assert.equal(s.state.typed, 'new ');
  assert.equal(s.state.active, 0);
  // Once the buffer expires, space chooses.
  assert.deepEqual(selectKey(s.state, { key: ' ' }, o, 2, 1300 + TYPEAHEAD_MS), { state: CLOSED, commit: 0, handled: true });
});

const CALL_SITES = ['components/settings/ConfigFieldRow.svelte', 'components/settings/GeneralTab.svelte', 'views/Evals.svelte', 'views/Analytics.svelte', 'views/Project.svelte'];
const selects = (rel: string) => tags(rel, readSrc(rel)).filter((x) => x.name === 'Select');

test('no native select remains in the dashboard', () => {
  const files = fs.readdirSync(SRC, { recursive: true }).map((f) => String(f).split(path.sep).join('/')).filter((f) => f.endsWith('.svelte'));
  for (const f of files) assert.ok(!tags(f, readSrc(f)).some((x) => x.name === 'select'), `${f} has a native <select>`);
  for (const rel of CALL_SITES) assert.match(readSrc(rel), /import Select from '(\.\.\/)+(components\/)?Select\.svelte';/, `${rel} imports Select.svelte`);
  const ids = CALL_SITES.flatMap((rel) => selects(rel).map((x) => attr(x, 'id')));
  for (const id of ['settings-locale', 'cmp-a', 'cmp-b', 'project-job']) assert.ok(ids.includes(id), `a Select keeps id ${id}`);
});

test('every Select call site is named', () => {
  const [field] = selects('components/settings/ConfigFieldRow.svelte');
  assert.equal(attr(field, 'id'), '{id}');
  assert.equal(attr(field, 'describedby'), '{describedBy}');
  assert.equal(attr(field, 'invalid'), '{Boolean(error)}');
  assert.equal(attr(field, 'disabled'), '{disabled}');
  assert.match(readSrc('components/settings/ConfigFieldRow.svelte'), /<label for=\{id\}>/, 'the field label names the trigger');
  assert.match(readSrc('components/settings/GeneralTab.svelte'), /<label for="settings-locale">/);
  const evals = selects('views/Evals.svelte');
  assert.deepEqual(evals.map((x) => attr(x, 'label')), ["{$t('evals.runA')}", "{$t('evals.runB')}"]);
  assert.deepEqual(selects('views/Analytics.svelte').map((x) => attr(x, 'label')), ["{$t('analytics.window')}"]);
  const [job] = selects('views/Project.svelte');
  assert.equal(attr(job, 'labelledby'), 'project-job-label');
  assert.match(readSrc('views/Project.svelte'), /<span id="project-job-label">\{\$t\('project\.job'\)\}<\/span>/);
});

test('Select markup has combobox and listbox semantics', () => {
  const text = readSrc('components/Select.svelte');
  assert.ok(!text.includes('{@html'), 'no {@html}');
  assert.ok(!/<style\b/.test(text), 'no <style> block');
  const all = tags('Select.svelte', text);
  const button = all.find((x) => x.name === 'button');
  assert.ok(button, 'a button trigger');
  for (const [k, v] of Object.entries({ type: 'button', role: 'combobox', 'aria-haspopup': 'listbox' })) assert.equal(attr(button, k), v, `button ${k}`);
  for (const k of ['aria-expanded', 'aria-controls', 'aria-activedescendant', 'aria-invalid', 'aria-describedby', 'aria-label', 'aria-labelledby']) assert.ok(attr(button, k), `button has ${k}`);
  assert.match(String(attr(button, 'class')), /^\{variant === 'button' \? 'btn sm' : 'input inline-flex [^']*'\} \{cls\}$/, 'the trigger is an input field, or a small button');
  assert.equal(attr(button, 'title'), '{title}');
  assert.match(text, /st\.open && st\.active >= 0 \? optId\(st\.active\) : undefined/, 'aria-activedescendant only while open with an active option');
  const list = all.find((x) => x.name === 'ul' && attr(x, 'role') === 'listbox');
  assert.ok(list, 'a list');
  assert.equal(attr(list, 'popover'), 'manual');
  assert.equal(attr(list, 'id'), '{listId}');
  assert.equal(attr(button, 'aria-controls'), '{listId}');
  const cls = String(attr(list, 'class')).split(/\s+/);
  for (const c of ['plate', 'solid', 'shadow-(--shadow-overlay)', 'menu-pop']) assert.ok(cls.includes(c), `list has ${c}`);
  assert.match(String(attr(list, 'style')), /transform-origin: \{origin\}/, 'the panel grows from the trigger edge');
  assert.match(text, /origin = `\$\{at\.top < r\.top \? 'bottom' : 'top'\} \$\{align === 'end' \? 'right' : 'left'\}`;/, 'bottom when it opened above, the side the alignment pins');
  assert.match(text, /placeMenu\(\{[^}]*\balign,/, 'placement follows align');
  const option = all.find((x) => x.name === 'li' && attr(x, 'role') === 'option');
  assert.ok(option, 'options');
  assert.equal(attr(option, 'id'), '{optId(i)}');
  assert.ok(attr(option, 'aria-selected'), 'option aria-selected');
  assert.ok(attr(option, 'aria-disabled'), 'option aria-disabled');
  const optionCls = String(attr(option, 'class'));
  assert.match(optionCls, /\{o\.disabled \? 'opacity-40' : ''\}/, 'a disabled entry is dimmed');
  assert.match(optionCls, /\{o\.separator \? 'mt-1 pt-1 border-t border-line-soft' : ''\}/, 'a separator rules the entry off');
  assert.match(optionCls, /'bg-raised text-fg shadow-\[inset_var\(--bar-rule\)_0_0_0_var\(--gleam\)\]' : 'text-fg'/, 'the active highlight, else text-fg');
  // Groups: a role=group item labelled by its non-interactive name, holding the options; ids stay flat.
  const group = all.find((x) => x.name === 'li' && attr(x, 'role') === 'group');
  assert.ok(group, 'a group wrapper');
  assert.equal(attr(group, 'aria-labelledby'), '{groupId(r)}');
  const name = all.find((x) => x.name === 'div' && attr(x, 'id') === '{groupId(r)}');
  assert.ok(name && String(attr(name, 'class')).split(/\s+/).includes('label'), 'the group name is label-styled');
  assert.equal(attr(name, 'role'), 'presentation');
  assert.ok(all.some((x) => x.name === 'ul' && attr(x, 'role') === 'none'), 'the group list is presentational');
  assert.match(text, /\{@render row\(o, run\.start \+ k\)\}/, 'options keep their flat index inside a group');
  assert.match(text, /document\.getElementById\(optId\(next\.active\)\)\?\.scrollIntoView/, 'scrolls the active option by id, not by child index');
  assert.doesNotMatch(text, /list\?\.children\[/);
});

test('Select renders text, icon, hint and snippet entries', () => {
  const text = readSrc('components/Select.svelte');
  const all = tags('Select.svelte', text);
  const icons = all.filter((x) => x.name === 'Icon').map((x) => attr(x, 'name'));
  assert.deepEqual(icons.sort(), ['check', 'chevron-down', '{icon}', '{o.icon}']);
  // One markup path: the snippet, else the optional icon, the label and the optional hint line.
  assert.ok(
    text.includes(
      '{#if entry}{@render entry(o, i)}{:else}{#if o.icon}<Icon name={o.icon} class="shrink-0" />{/if}<span class="flex min-w-0 flex-col"><span class="truncate">{o.label}</span>{#if o.hint}<span class="text-xs text-muted whitespace-normal">{o.hint}</span>{/if}</span>{/if}',
    ),
    'the entry content',
  );
  // The props and their types.
  for (const decl of [
    'entry?: Snippet<[SelectOption, number]>;',
    "variant?: 'field' | 'button';",
    'icon?: IconName;',
    'text?: string;',
    'title?: string;',
    'badge?: boolean;',
    "align?: 'start' | 'end';",
  ])
    assert.ok(text.includes(decl), `prop ${decl}`);
  for (const def of ["variant = 'field',", 'badge = false,', "align = 'start',"]) assert.ok(text.includes(def), `default ${def}`);
  // The button variant: the icon, the text (or the override) and the chevron, and MenuButton's badge.
  assert.ok(text.includes("{#if variant === 'button' && icon}<Icon name={icon} />{/if}"), 'the leading icon');
  assert.ok(text.includes("{text ?? sel?.label ?? $t('select.choose')}"), 'the override, the chosen label, else Choose');
  assert.ok(text.includes("{#if variant === 'button' && badge}<span class=\"dot spark absolute -top-1 -right-1 size-2\" aria-hidden=\"true\"></span>{/if}"), 'the badge');
  assert.ok(text.includes("{variant === 'button' ? 'w-[min(16rem,calc(100vw_-_16px))]' : ''}"), "the button variant's panel is MenuButton's width");
});
