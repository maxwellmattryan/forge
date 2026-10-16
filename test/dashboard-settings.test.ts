// The settings modal's plain-TS helpers and the i18n lookup (dashboard/src/lib), imported straight
// from source: they have no svelte or DOM dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_LOCALE, pickLocale, translate } from '../dashboard/src/lib/i18n.ts';
import { SETTINGS_TABS, moveTab, settingsKey, settingsKeyShortcuts, settingsShortcutLabel, wrapFocus } from '../dashboard/src/lib/settings.ts';
import { isMac } from '../dashboard/src/lib/command.ts';
import { changedKeys, draftOf, fieldsFor, formatValue, invalidKeys, parseDraft } from '../dashboard/src/lib/config-form.ts';
import { doctorReport, failedCount } from '../dashboard/src/lib/diagnostics.ts';
import { FIELDS } from '../lib/config-fields.ts';

const EN = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'dashboard', 'src', 'messages', 'en.json'), 'utf8'));
const inEn = (key: string) => typeof key.split('.').reduce((o: any, k) => o?.[k], EN) === 'string';

test('i18n translate and pickLocale', () => {
  const catalogs = {
    en: { nav: { pipeline: 'Pipeline' }, hello: 'Hello {name}, {missing}', jobs: { one: '{count} job', other: '{count} jobs' }, only: 'English only' },
    de: { nav: { pipeline: 'Pipeline (de)' }, jobs: { one: '{count} Job', other: '{count} Jobs' } },
  };
  assert.equal(SOURCE_LOCALE, 'en');
  assert.equal(translate('en', catalogs, 'nav.pipeline'), 'Pipeline', 'nested keys');
  assert.equal(translate('en', catalogs, 'hello', { name: 'Ada' }), 'Hello Ada, {missing}', 'interpolates and leaves unknown placeholders');
  assert.equal(translate('en', catalogs, 'jobs', { count: 1 }), '1 job');
  assert.equal(translate('en', catalogs, 'jobs', { count: 2 }), '2 jobs');
  assert.equal(translate('en', catalogs, 'jobs', { count: 0 }), '0 jobs');
  assert.equal(translate('en', catalogs, 'jobs'), '{count} jobs', 'no count: other');
  assert.equal(translate('de', catalogs, 'jobs', { count: 1 }), '1 Job');
  assert.equal(translate('de', catalogs, 'only'), 'English only', 'a missing key falls back to en');
  assert.equal(translate('fr', catalogs, 'nav.pipeline'), 'Pipeline', 'a missing locale falls back to en');
  assert.equal(translate('en', catalogs, 'nope.key'), 'nope.key', 'missing everywhere: the key');
  assert.equal(translate('en', catalogs, 'nav'), 'nav', 'a branch is not a message');

  assert.equal(pickLocale('de', ['en-US'], ['en', 'de']), 'de', 'saved wins');
  assert.equal(pickLocale('xx', ['de-AT', 'en'], ['en', 'de']), 'de', 'then navigator, by base language');
  assert.equal(pickLocale('', ['en-GB'], ['en']), 'en', 'en-GB matches en');
  assert.equal(pickLocale(null, ['ja'], ['en', 'de']), 'en', 'else en');
});

test('settings opens on Cmd+, or Ctrl+, only', () => {
  const k = (o: Partial<Parameters<typeof settingsKey>[0]>) => settingsKey({ key: ',', ctrlKey: false, metaKey: false, altKey: false, open: false, mac: true, ...o });
  // mac: Cmd+, alone.
  assert.equal(k({ metaKey: true }), 'open', 'Cmd+, on mac');
  assert.equal(k({}), null, 'a bare , does nothing');
  assert.equal(k({ ctrlKey: true }), null, "Ctrl+, is not mac's shortcut");
  assert.equal(k({ metaKey: true, ctrlKey: true }), null, 'Cmd+Ctrl+,');
  assert.equal(k({ metaKey: true, altKey: true }), null, 'with Alt');
  // Elsewhere: Ctrl+, alone.
  assert.equal(k({ mac: false, ctrlKey: true }), 'open', 'Ctrl+, elsewhere');
  assert.equal(k({ mac: false }), null, 'a bare , does nothing');
  assert.equal(k({ mac: false, metaKey: true }), null, 'Meta+, is not the shortcut off mac');
  assert.equal(k({ mac: false, ctrlKey: true, altKey: true }), null, 'with Alt (AltGr)');
  assert.equal(k({ mac: false, ctrlKey: true, metaKey: true }), null, 'Ctrl+Meta+,');
  // Never on repeat, while composing, or while Settings or the palette is open; Escape still closes.
  assert.equal(k({ metaKey: true, repeat: true }), null, 'auto-repeat');
  assert.equal(k({ metaKey: true, composing: true }), null, 'IME composition');
  assert.equal(k({ metaKey: true, open: true }), null, 'already open');
  assert.equal(k({ metaKey: true, palette: true }), null, 'the palette owns the keyboard');
  assert.equal(k({ key: 'Escape', open: true }), 'close');
  assert.equal(k({ key: 'Escape' }), null, "Escape while closed is the drawer's");
  assert.equal(k({ key: 'a', metaKey: true }), null);
  // A modified key types nothing, so it opens from a form field too (the input has no say).
  assert.equal(settingsKey({ key: ',', ctrlKey: true, metaKey: false, altKey: false, open: false, mac: false, targetTag: 'INPUT' } as Parameters<typeof settingsKey>[0]), 'open', 'inside an INPUT');
  assert.equal(settingsKey({ key: ',', ctrlKey: false, metaKey: true, altKey: false, open: false, mac: true, targetTag: 'TEXTAREA' } as Parameters<typeof settingsKey>[0]), 'open', 'inside a TEXTAREA');

  assert.equal(settingsShortcutLabel('MacIntel'), '⌘,');
  assert.equal(settingsShortcutLabel('iPad'), '⌘,');
  assert.equal(settingsShortcutLabel('Win32'), 'Ctrl ,');
  assert.equal(settingsKeyShortcuts('MacIntel'), 'Meta+,');
  assert.equal(settingsKeyShortcuts('Linux x86_64'), 'Control+,');
  assert.equal(isMac('iPhone'), true);
  assert.equal(isMac(''), false);

  // The checkbox and its pref are gone: one caption names the shortcut, and the sidebar button announces it.
  const general = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'src', 'components', 'settings', 'GeneralTab.svelte'), 'utf8');
  assert.doesNotMatch(general, /'settingsShortcut'|settings\.general\.(shortcut|hintOff)/, 'no settingsShortcut checkbox');
  assert.equal(general.match(/type="checkbox"/g)?.length, 1, 'Grain is the only checkbox');
  assert.match(general, /\$t\('settings\.general\.hint', \{ key \}\)/);
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'dashboard', 'src', 'App.svelte'), 'utf8');
  assert.match(app, /id="settings-open"[^>]*aria-keyshortcuts=\{settingsKeyShortcuts\(platform\)\}/);
  assert.match(app, /aria-hidden="true">\{settingsShortcut\}<\/kbd>/);
  assert.doesNotMatch(app, /settingsShortcut'|pref\.get\('settingsShortcut'/, 'the old pref is ignored');
});

test('settings tab and focus helpers', () => {
  assert.deepEqual(SETTINGS_TABS.map((x) => x.id), ['general', 'pipeline', 'review', 'agents', 'tracker', 'dashboard', 'daemon', 'diagnostics', 'about']);
  assert.equal(moveTab('general', 'ArrowDown'), 'pipeline');
  assert.equal(moveTab('general', 'ArrowRight'), 'pipeline');
  assert.equal(moveTab('general', 'ArrowUp'), 'about', 'wraps backwards');
  assert.equal(moveTab('general', 'ArrowLeft'), 'about');
  assert.equal(moveTab('about', 'ArrowDown'), 'general', 'wraps forwards');
  assert.equal(moveTab('tracker', 'Home'), 'general');
  assert.equal(moveTab('tracker', 'End'), 'about');
  assert.equal(moveTab('tracker', 'Enter'), null);

  assert.equal(wrapFocus(4, 3, false), 0, 'Tab on the last wraps to the first');
  assert.equal(wrapFocus(4, 0, true), 3, 'Shift+Tab on the first wraps to the last');
  assert.equal(wrapFocus(4, 1, false), null, 'inside: the browser moves focus');
  assert.equal(wrapFocus(4, 2, true), null);
  assert.equal(wrapFocus(4, -1, false), 0, 'focus outside comes back in');
  assert.equal(wrapFocus(4, -1, true), 3);
  assert.equal(wrapFocus(0, -1, false), null);
});

test('config form drafts, parsing and changed keys', () => {
  const values = Object.fromEntries(FIELDS.map((f) => [f.key, f.default]));
  for (const f of FIELDS.filter((x) => x.editable)) {
    const back = parseDraft(f, draftOf(f, f.default));
    assert.ok(back.ok, `${f.key} default round-trips`);
    assert.deepEqual(back.value, f.default, f.key);
  }
  const by = (key: string) => FIELDS.find((f) => f.key === key)!;
  const types = new Set(FIELDS.filter((f) => f.editable).map((f) => f.type));
  assert.deepEqual([...types].sort(), ['boolean', 'enum', 'integer', 'list', 'number', 'string']);

  const tokens = by('pipeline.budget.tokens');
  assert.deepEqual(parseDraft(tokens, ''), { ok: true, value: null }, 'empty nullable number is null');
  assert.deepEqual(parseDraft(tokens, ' 1200 '), { ok: true, value: 1200 });
  const milestone = by('tracker.github.ready.milestone');
  assert.deepEqual(parseDraft(milestone, ''), { ok: true, value: null }, 'empty nullable string is null');
  assert.deepEqual(parseDraft(milestone, 'v1'), { ok: true, value: 'v1' });
  const effort = by('runtime.effort');
  assert.equal(draftOf(effort, null), '', 'unset effort drafts as the "Not set" option');
  assert.deepEqual(parseDraft(effort, ''), { ok: true, value: null }, 'empty nullable enum is null');
  assert.deepEqual(parseDraft(effort, 'high'), { ok: true, value: 'high' });
  assert.deepEqual(parseDraft(effort, 'ultra'), { ok: false, error: 'settings.form.option' });
  assert.deepEqual(parseDraft(by('pipeline.plan'), ''), { ok: false, error: 'settings.form.option' }, 'a non-nullable enum has no empty option');
  const rounds = by('pipeline.maxRounds');
  const prefix = by('tracker.github.labels.prefix');
  const errors = [
    parseDraft(rounds, ''),
    parseDraft(prefix, ''),
    parseDraft(rounds, '0'),
    parseDraft(rounds, '21'),
    parseDraft(rounds, '2.5'),
    parseDraft(rounds, 'x'),
    parseDraft(by('pipeline.budget.usd'), 'x'),
    parseDraft(by('pipeline.plan'), 'sometimes'),
    parseDraft(by('review.blockOn'), ['blocker', 'huge']),
    parseDraft(prefix, 'x'.repeat(201)),
    parseDraft(by('daemon.idleStopMinutes'), '0'),
    parseDraft(by('review.blockOn'), ['blocker']),
    parseDraft(by('review.blockOn'), []),
  ];
  assert.deepEqual(errors.map((e: any) => (e.ok ? 'ok' : e.error)), [
    'settings.form.required', 'settings.form.required', 'settings.form.min', 'settings.form.max', 'settings.form.integer', 'settings.form.integer',
    'settings.form.number', 'settings.form.option', 'settings.form.listOption', 'settings.form.tooLong',
    'settings.form.greater', 'settings.form.listRequired', 'settings.form.listRequired',
  ]);
  assert.deepEqual((errors[11] as any).params, { items: 'major' });
  assert.deepEqual(parseDraft(by('daemon.idleStopMinutes'), '0.5'), { ok: true, value: 0.5 }, 'just above an exclusive minimum');
  assert.deepEqual(parseDraft(by('review.blockOn'), ['blocker', 'major', 'minor']), { ok: true, value: ['blocker', 'major', 'minor'] });
  assert.deepEqual(by('review.blockOn').required, ['blocker', 'major']);
  assert.equal(formatValue(by('review.panel').default), JSON.stringify(by('review.panel').default), 'a list of maps shows as JSON');
  assert.equal(formatValue(['a', 'b']), 'a, b');
  assert.equal(formatValue([]), null);
  for (const e of errors as any[]) if (!e.ok) assert.ok(inEn(e.error), `${e.error} exists in en.json`);
  assert.deepEqual((errors[2] as any).params, { min: 1 });

  const blockOn = by('review.blockOn');
  assert.deepEqual(draftOf(blockOn, ['major', 'blocker']), ['blocker', 'major'], 'checkbox drafts follow option order');
  const labels = by('tracker.github.ready.labels');
  assert.equal(draftOf(labels, ['a', 'b c']), 'a\nb c');
  assert.deepEqual(parseDraft(labels, ' a \n\nb c\n'), { ok: true, value: ['a', 'b c'] });
  assert.equal(draftOf(by('runtime.diversity'), false), false);

  assert.deepEqual(changedKeys(FIELDS, values, {}), []);
  const drafts = {
    'pipeline.maxRounds': '4',
    'pipeline.plan': 'auto', // same as current
    'runtime.diversity': true,
    'daemon.command': 'claude', // read-only: never a change
    'dashboard.port': '80', // invalid: not a change
  };
  assert.deepEqual(changedKeys(FIELDS, values, drafts), ['pipeline.maxRounds', 'runtime.diversity'], 'editable, parsed and different, in field order');
  assert.deepEqual(invalidKeys(FIELDS, drafts), ['dashboard.port']);
  assert.deepEqual(fieldsFor(FIELDS, 'dashboard').map((f) => f.key), ['dashboard.port']);
});

test('doctor report text', () => {
  const doctor = {
    ok: false,
    at: '2026-10-13T12:00:00.000Z',
    checks: [
      { name: 'node >= 22.18', ok: true, detail: '22.18.0' },
      { name: 'gh installed + authenticated', ok: false, detail: '<img src=x onerror=alert(1)> & "quotes"' },
    ],
  };
  const about = { forgeVersion: '0.8.1', apiVersion: 6, pluginRoot: '/p', schemaVersions: { config: 2, job: 3, event: 1 }, pricingAsOf: '2026-10-06', node: '22.18.0', links: { repo: null, docs: null } };
  const text = doctorReport(doctor, about);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Forge v0.8.1 · API 6 · Node 22.18.0');
  assert.equal(lines[1], '[ok] node >= 22.18: 22.18.0');
  assert.equal(lines[2], '[FAIL] gh installed + authenticated: <img src=x onerror=alert(1)> & "quotes"', 'raw text, never escaped HTML');
  assert.ok(text.endsWith(doctor.at));
  assert.equal(lines.length, 4);
  assert.equal(failedCount(doctor), 1);
});

test('an option list renders one control, never a textarea too', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'dashboard', 'src', 'components', 'settings', 'ConfigFieldRow.svelte'), 'utf8');
  const options = src.indexOf("{:else if f.type === 'list' && f.options}");
  const textarea = src.indexOf('<textarea');
  assert.ok(options > 0 && textarea > options, 'the checkbox group branch comes first');
  // Still the same if-chain: a closed chain would have one more {/if} than {#if} in between.
  const between = src.slice(options, textarea);
  assert.ok((between.match(/\{#if\b/g) ?? []).length >= (between.match(/\{\/if\}/g) ?? []).length, 'the textarea is an {:else} of the option-list branch');
  assert.equal((src.match(/<textarea/g) ?? []).length, 1);
});
