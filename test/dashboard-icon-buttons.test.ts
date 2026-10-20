// Icon-only buttons: the session log's and the Daemon popover's one Start/Stop icon toggle, and the dashboard tooltip and
// en.json name every icon-only button carries. Reads source files only, like dashboard-i18n.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ancestry, type Placed } from './svelte-markup.ts';

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
