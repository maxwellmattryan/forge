// Icon-only buttons: the session log's and the Daemon popover's one Start/Stop icon toggle, and the dashboard tooltip and
// en.json name every icon-only button carries. Reads source files only, like dashboard-i18n.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ancestry, endOf, tags, type Placed } from './svelte-markup.ts';

const SRC = path.resolve(import.meta.dirname, '..', 'dashboard', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const EN = JSON.parse(read('messages/en.json'));
const attr = (el: Placed, name: string): string | undefined => {
  const v = el.attrs.find((a) => a.name === name)?.value;
  return v === undefined ? undefined : /^["']/.test(v) ? v.slice(1, -1) : v;
};
const markupOf = (text: string) => text.replace(/<script\b[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, '');

test('session log: one Start/Stop icon toggle', () => {
  const text = read('components/SessionLog.svelte');
  const els = ancestry('SessionLog.svelte', text);
  const toggles = els.filter((e) => e.name === 'IconButton');
  assert.equal(toggles.length, 1, 'one IconButton');
  const b = toggles[0];
  assert.equal(attr(b, 'icon'), "{toggle.action === 'start' ? 'play' : 'stop'}");
  assert.equal(attr(b, 'label'), "{toggle.action === 'start' ? $t('session.start') : $t('session.stop')}");
  assert.equal(attr(b, 'hint'), "{toggle.action === 'start' ? $t('session.startHint') : null}", 'the hint only for start');
  assert.equal(attr(b, 'disabled'), '{!toggle.enabled}');
  assert.equal(attr(b, 'onclick'), '{(e) => act(toggle.action, e.currentTarget)}');
  assert.match(text, /import IconButton from '\.\/IconButton\.svelte';/);
  const markup = markupOf(text);
  assert.doesNotMatch(markup, /\{#snippet flip\b|\{@render flip\(/, 'no flip snippet');
  assert.doesNotMatch(markup, /\bswap\b/, 'no swap span');
  assert.ok(!els.some((e) => e.name === 'Icon' && e.ancestors.some((a) => a.name === 'button')), 'no text Start/Stop button with an icon');
  assert.doesNotMatch(markup, /\$t\('session\.(start|stop)'\)\}<\/button>/, 'no text Start/Stop button');
  // Transcript logs show none: the toggle sits in the {#if !transcript} branch, before its {:else} or {/if}.
  const at = markup.indexOf('{#if !transcript}');
  const open = markup.indexOf('<IconButton');
  assert.ok(at >= 0 && at < open, 'inside {#if !transcript}');
  const between = markup.slice(at, open);
  assert.equal((between.match(/\{#if\b/g) ?? []).length - 1, (between.match(/\{\/if\}/g) ?? []).length, 'the !transcript block is still open at the toggle');
});

test('daemon popover: one pool Start/Stop icon toggle', () => {
  const text = read('components/statusbar/DaemonPanel.svelte');
  const markup = markupOf(text);
  const split = markup.lastIndexOf('{:else}');
  assert.ok(split > 0, 'the daemon-off branch');
  const on = ancestry('DaemonPanel.svelte (on)', markup.slice(0, split)).filter((e) => e.name === 'IconButton');
  const offEls = ancestry('DaemonPanel.svelte (off)', markup.slice(split)).filter((e) => e.name === 'IconButton');
  assert.equal(on.length, 1, 'one toggle while the daemon is on');
  assert.equal(attr(on[0], 'icon'), "{model.toggle.action === 'start' ? 'play' : 'stop'}");
  assert.equal(attr(on[0], 'label'), "{model.toggle.action === 'start' ? $t('daemon.start') : $t('daemon.stop')}");
  assert.equal(attr(on[0], 'hint'), "{model.toggle.action === 'start' ? model.startHint : null}");
  assert.equal(attr(on[0], 'disabled'), '{!model.toggle.enabled}');
  assert.equal(attr(on[0], 'onclick'), '{() => act(model.toggle.action)}');
  assert.equal(offEls.length, 1, 'one toggle while the daemon is off');
  assert.equal(attr(offEls[0], 'icon'), 'play');
  assert.equal(attr(offEls[0], 'label'), "{$t('daemon.start')}");
  assert.equal(attr(offEls[0], 'hint'), '{START_HINT}');
  assert.ok(offEls[0].attrs.some((a) => a.name === 'disabled' && a.value === undefined), 'a disabled Start');
  // No <button> in the file holds the play or stop icon.
  for (let i = markup.indexOf('<button'); i >= 0; i = markup.indexOf('<button', i + 1)) {
    const body = markup.slice(i, markup.indexOf('</button>', i));
    assert.ok(!body.includes('<Icon name="play"') && !body.includes('<Icon name="stop"'), `no text Start/Stop button: ${body.slice(0, 80)}`);
  }
});

/** Every `.svelte` file under dashboard/src, as [path relative to src, text]. */
const svelteFiles = (): (readonly [string, string])[] =>
  fs
    .readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.svelte'))
    .sort()
    .map((f) => [f.split(path.sep).join('/'), read(f)] as const);

/** Class tokens of a `class` value: its fixed words plus every string literal in its `{…}` parts. */
function classTokens(value: string | undefined): string[] {
  if (value === undefined) return [];
  const words: string[] = [];
  let rest = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '{') {
      rest += value[i];
      continue;
    }
    const end = endOf(value, i);
    if (end < 0) throw new Error(`cannot parse class value ${JSON.stringify(value)}`);
    for (const m of value.slice(i + 1, end).matchAll(/'([^']*)'|"([^"]*)"/g)) words.push(m[1] ?? m[2]);
    rest += ' ';
    i = end;
  }
  return [rest, ...words].flatMap((s) => s.split(/\s+/)).filter(Boolean);
}

/** Index just past the opening tag at `i`, skipping quoted values and `{…}`. */
function openEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '>') return j + 1;
    if (s[j] === '{' || s[j] === '"' || s[j] === "'") {
      const end = endOf(s, j);
      if (end < 0) return -1;
      j = end;
    }
  }
  return -1;
}

/**
 * The icon-only `<button>`s of one component that lack a tooltip or a label. Icon-only: its class has the `icon` token,
 * or its content is only `<Icon …/>`, optionally inside `{#if}`. Each needs an aria-label, no native title (MenuButton's
 * title, set only when it is not icon-only, is the one exception) and a `<Tooltip` in the same file.
 */
function iconButtonProblems(file: string, text: string): string[] {
  const s = text.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
  const problems: string[] = [];
  for (let i = s.search(/<button\b/); i >= 0; ) {
    const end = openEnd(s, i);
    if (end < 0) throw new Error(`${file}: cannot parse <button near ${JSON.stringify(s.slice(i, i + 60))}`);
    const tag = tags(file, s.slice(i, end))[0];
    const closeAt = s.slice(end).search(/<\/button\s*>/);
    if (closeAt < 0) throw new Error(`${file}: <button> never closes`);
    const close = end + closeAt;
    const content = s.slice(end, close).replace(/\{[#:/](if|else)\b[^}]*\}/g, '').replace(/>\s+</g, '><').trim();
    const value = (name: string) => tag.attrs.find((a) => a.name === name)?.value;
    const iconOnly = classTokens(value('class')?.replace(/^["']|["']$/g, '')).includes('icon') || /^(<Icon\b[^>]*\/>)+$/.test(content);
    if (iconOnly) {
      const at = `${file}: <button ${s.slice(i + 8, Math.min(end, i + 80)).trim()}`;
      if (!value('aria-label')) problems.push(`${at} has no aria-label`);
      const title = value('title');
      if (tag.attrs.some((a) => a.name === 'title') && !(title !== undefined && title.startsWith('{iconOnly ? undefined :'))) problems.push(`${at} has a native title`);
      if (!s.includes('<Tooltip')) problems.push(`${at} has no <Tooltip> in its file`);
    }
    const next = s.slice(close).search(/<button\b/);
    i = next < 0 ? -1 : close + next;
  }
  return problems;
}

test('the icon-button sweep finds a planted button without a tooltip', () => {
  const planted = `<script lang="ts">import Icon from './Icon.svelte';</script>
<div>
  <button class="btn sm icon" aria-label={$t('x.y')} onclick={go}><Icon name="close" /></button>
  <button class="btn sm" title={$t('x.z')}>{#if on}<Icon name="play" />{:else}<Icon name="stop" />{/if}</button>
  <button class="btn sm">{$t('x.text')}</button>
</div>`;
  const found = iconButtonProblems('Planted.svelte', planted);
  assert.equal(found.filter((p) => p.includes('no <Tooltip>')).length, 2, `both icon-only buttons lack a tooltip: ${found.join('; ')}`);
  assert.ok(found.some((p) => p.includes('no aria-label')), 'the unlabelled one is reported');
  assert.ok(found.some((p) => p.includes('native title')), 'a native title is reported');
  assert.ok(!found.some((p) => p.includes('x.text')), 'a text button is not icon-only');
  const fixed = `<button bind:this={b} class="btn icon" aria-label={$t('x.y')}><Icon name="close" /></button><Tooltip anchor={b} text={$t('x.y')} />`;
  assert.deepEqual(iconButtonProblems('Fixed.svelte', fixed), []);
});

test('every icon-only button has a tooltip and a label', () => {
  const files = svelteFiles();
  assert.ok(files.length > 30, `${files.length} components`);
  assert.deepEqual(files.flatMap(([f, text]) => iconButtonProblems(f, text)), []);
  // The shared pieces render the tooltip themselves.
  for (const f of ['components/IconButton.svelte', 'components/CloseButton.svelte']) assert.match(read(f), /<Tooltip anchor=\{\w+\} text=\{label\}/, `${f} renders <Tooltip>`);
  const menu = markupOf(read('components/MenuButton.svelte'));
  assert.match(menu, /\{#if iconOnly\}<Tooltip anchor=\{trigger\} text=\{label\} off=\{open\} \/>\{\/if\}/, 'MenuButton renders <Tooltip> when iconOnly, hidden while open');
  assert.match(menu, /title=\{iconOnly \? undefined :/, 'and no native title then');
  // The Needs-you bell: a Tooltip with titles.needs, and no native title.
  const bar = read('components/StatusBar.svelte');
  assert.match(markupOf(bar), /<Tooltip anchor=\{needsButton\} text=\{titles\.needs\} off=\{expanded\('needs'\) === true\} \/>/);
  const bell = ancestry('StatusBar.svelte', bar).find((e) => e.name === 'button' && attr(e, 'data-popover') === 'needs');
  assert.ok(bell, 'the bell');
  assert.ok(!bell.attrs.some((a) => a.name === 'title'), 'the bell has no native title');
  // The phone settings button.
  assert.match(markupOf(read('App.svelte')), /<Tooltip anchor=\{settingsMobile\} text=\{\$t\('settings\.open'\)\} \/>/);
  // The tooltip is a top-layer, aria-hidden plate that renders text only.
  const tip = read('components/Tooltip.svelte');
  const div = ancestry('Tooltip.svelte', tip).find((e) => e.name === 'div');
  assert.ok(div, 'a tip element');
  assert.equal(attr(div, 'popover'), 'manual');
  assert.equal(attr(div, 'aria-hidden'), 'true');
  assert.ok(classTokens(attr(div, 'class')).includes('plate') && classTokens(attr(div, 'class')).includes('pointer-events-none'));
  assert.doesNotMatch(tip, /\{@html|innerHTML/, 'text only');
  assert.match(tip, /pointerType === 'touch'/, 'touch never opens it');
  assert.match(tip, /matches\(':focus-visible'\)/, 'keyboard focus shows it');
  assert.match(tip, /setTimeout\(show, TIP_DELAY_MS\)/, 'hover waits');
  // IconButton: a disabled button lets hover reach the wrapper the tip anchors on, and the hint is described.
  const ib = read('components/IconButton.svelte');
  assert.match(ib, /disabled:pointer-events-none/);
  assert.match(ib, /aria-describedby=\{hint \? hintId : undefined\}/);
  assert.match(ib, /<span id=\{hintId\} class="sr-only">\{hint\}<\/span>/);
});

test('icon button labels come from en.json', () => {
  const KEY = String.raw`\$t\('([\w.]+)'\)`;
  const one = new RegExp(`^\\{${KEY}\\}$`);
  const either = new RegExp(`^\\{[^?{}]+\\?\\s*${KEY}\\s*:\\s*${KEY}\\}$`);
  const resolves = (key: string) => typeof key.split('.').reduce((o: any, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), EN) === 'string';
  let seen = 0;
  for (const [f, text] of svelteFiles()) {
    for (const el of ancestry(f, text)) {
      const counts = el.name === 'IconButton' || el.name === 'CloseButton' || (el.name === 'MenuButton' && el.attrs.some((a) => a.name === 'iconOnly'));
      if (!counts) continue;
      seen++;
      const label = attr(el, 'label') ?? '';
      const m = one.exec(label) ?? either.exec(label);
      assert.ok(m, `${f}: <${el.name} label=${label}> is one $t('literal.key') or a ternary of two`);
      for (const key of m.slice(1).filter(Boolean)) assert.ok(resolves(key), `${f}: ${key} is in en.json`);
    }
  }
  assert.ok(seen >= 10, `${seen} icon button usages`);
});

test('the removed Start/Stop messages are gone', () => {
  for (const key of ['session.startInbox', 'session.stopInbox', 'session.startOffice', 'session.stopOffice', 'session.startJob', 'session.stopJob', 'daemon.startAll', 'daemon.stopAll']) {
    const [group, name] = key.split('.');
    assert.ok(!Object.hasOwn(EN[group], name), `${key} is not in en.json`);
  }
  for (const key of ['session.start', 'session.stop', 'session.startHint', 'daemon.start', 'daemon.stop']) {
    const [group, name] = key.split('.');
    assert.equal(typeof EN[group][name], 'string', `${key} stays`);
  }
});
