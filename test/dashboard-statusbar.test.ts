// The status bar's pure half (dashboard/src/lib/statusbar.ts) and the popover rules (dashboard/src/lib/popover.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_ORDER, barModel, type BarModel, type DaemonIndicator, connectionState, inlineInputAction, modelLabel, modelSummary, promptAnnouncement, reviewerRows, roleRows, summaryText } from '../dashboard/src/lib/statusbar.ts';
import { FOCUSABLE, POPOVERS, TAB_STOPS, dismissal, placePopover, togglePopover, type DismissReason } from '../dashboard/src/lib/popover.ts';
import { TABBABLE } from '../dashboard/src/lib/settings.ts';

const session = (o: any = {}): any => ({ scope: 'job', wanted: true, running: false, status: 'off', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, failures: 0, held: null, waiting: false, lastError: null, ...o });
const pool = (o: any = {}): any => ({ enabled: true, wanted: true, maxConcurrent: 3, live: 0, lastError: null, inbox: session({ scope: '_inbox' }), jobs: {}, clients: 0, ...o });
const prompt = (id: string, at = '2026-10-15T00:00:00Z') => ({ id, tool: 'Bash', input: '{"command":"ls"}', at });
/** The daemon indicator of a pool that is on. */
const on = (b: BarModel) => {
  assert.equal(b.daemon.off, false, 'the daemon is on');
  return b.daemon as Extract<DaemonIndicator, { off: false }>;
};

test('barModel: daemon, inbox, held, waiting and prompt attention', () => {
  // A null pool: the daemon is off, nothing else shows.
  const none = barModel(null, { pending: false });
  assert.deepEqual(none, { daemon: { off: true, active: false }, inbox: null, prompts: 0, held: 0, waiting: 0, attention: false });

  // Disabled, not wanted, nothing running: off as well.
  const disabled = barModel(pool({ enabled: false, wanted: false }), { pending: false });
  assert.equal(disabled.daemon.off, true);
  assert.equal(disabled.inbox, null);

  // Standby: enabled and wanted, nothing running yet.
  const standby = barModel(pool(), { pending: false });
  assert.deepEqual([on(standby).pill.label, on(standby).pill.tone], ['standby', 'muted']);
  assert.deepEqual([on(standby).live, on(standby).cap, on(standby).active], [0, 3, false]);
  assert.deepEqual([standby.inbox?.label, standby.inbox?.tone], ['no session', 'muted']);
  assert.equal(standby.attention, false);

  // Busy: a working session lights the live dot.
  const busy = barModel(pool({ live: 1, jobs: { a: session({ scope: 'a', running: true, status: 'busy' }) } }), { pending: false });
  assert.deepEqual([on(busy).pill.label, on(busy).pill.tone, on(busy).live, on(busy).active], ['busy', 'live', 1, true]);
  const idle = barModel(pool({ live: 1, jobs: { a: session({ scope: 'a', running: true, status: 'idle' }) } }), { pending: false });
  assert.equal(on(idle).active, false, 'an idle session does not pulse');

  // Needs permission: a prompt on a job session turns the inbox warn and counts pool-wide.
  const asking = pool({
    live: 2,
    inbox: session({ scope: '_inbox', running: true, status: 'idle', sessionId: 'x' }),
    jobs: { a: session({ scope: 'a', running: true, status: 'busy', permissions: [prompt('p1'), prompt('p2', '2026-10-15T00:00:01Z')] }) },
  });
  const ask = barModel(asking, { pending: false });
  assert.deepEqual([on(ask).pill.label, on(ask).pill.tone, on(ask).active], ['needs permission', 'warn', true]);
  assert.equal(ask.prompts, 2);
  assert.equal(ask.attention, true);
  assert.equal(ask.inbox?.label, 'idle', "the inbox keeps its own label");
  assert.equal(ask.inbox?.tone, 'warn', 'but takes the warn tone while a prompt waits anywhere');
  assert.equal(barModel(pool({ inbox: session({ scope: '_inbox', running: true, status: 'idle', sessionId: 'x' }) }), { pending: false }).inbox?.tone, 'ok', 'and keeps its own tone without one');

  // Held and waiting counts.
  const held = barModel(pool({ jobs: { a: session({ scope: 'a', held: 'budget' }), b: session({ scope: 'b', held: 'budget' }) } }), { pending: false });
  assert.deepEqual([held.held, held.waiting], [2, 0]);
  const waiting = barModel(pool({ jobs: { a: session({ scope: 'a', waiting: true }) } }), { pending: false });
  assert.deepEqual([waiting.held, waiting.waiting], [0, 1]);
});

test('promptAnnouncement speaks only when the count rises', () => {
  assert.equal(promptAnnouncement(0, 1), 1);
  assert.equal(promptAnnouncement(1, 3), 3);
  assert.equal(promptAnnouncement(3, 3), null, 'holding is silent');
  assert.equal(promptAnnouncement(3, 2), null, 'falling is silent');
  assert.equal(promptAnnouncement(2, 0), null);
  assert.equal(promptAnnouncement(0, 0), null);
});

test('modelLabel resolves aliases, full ids, inherit and unknown models', () => {
  const pick = (raw: unknown, models?: Record<string, unknown> | null) => {
    const m = modelLabel(raw, models);
    return [m.label, m.provider, m.inherited];
  };
  assert.deepEqual(pick('opus'), ['Opus', 'Anthropic', false]);
  assert.deepEqual(pick('claude-opus-5-5'), ['Opus 5.5', 'Anthropic', false]);
  assert.deepEqual(pick('claude-sonnet-4-5-20250929'), ['Sonnet 4.5', 'Anthropic', false]);
  assert.deepEqual(pick('claude-3-5-haiku-20241022'), ['Haiku 3.5', 'Anthropic', false]);
  assert.deepEqual(pick('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), ['Sonnet 4.5', 'Anthropic', false]);
  assert.deepEqual(pick('claude-opus-5-5[1m]'), ['Opus 5.5', 'Anthropic', false]);
  assert.deepEqual(pick('claude-fable-5-1'), ['Fable 5.1', 'Anthropic', false]);
  assert.deepEqual(pick('claude-opus-4-20250514'), ['Opus 4', 'Anthropic', false], 'a date is never a minor version');
  assert.deepEqual(pick('claude-3-haiku-20240307'), ['Haiku 3', 'Anthropic', false]);
  assert.deepEqual(pick('Sonnet'), ['Sonnet', 'Anthropic', false]);
  assert.deepEqual(pick('inherit', { orchestrator: 'sonnet' }), ['Sonnet', 'Anthropic', true]);
  assert.deepEqual(pick('INHERIT', { orchestrator: 'claude-opus-5-5' }), ['Opus 5.5', 'Anthropic', true]);
  assert.deepEqual(pick('inherit', { orchestrator: 'inherit' }), [null, 'Anthropic', true], 'the session default');
  assert.deepEqual(pick('inherit', null), [null, 'Anthropic', false], 'the orchestrator itself resolves nowhere');
  for (const blank of ['', '   ', null, undefined, 42, {}, ['opus']]) {
    const m = modelLabel(blank, { orchestrator: 'haiku' });
    assert.deepEqual([m.raw, m.label, m.inherited], ['inherit', 'Haiku', true], `${JSON.stringify(blank)} is inherit`);
  }
  assert.deepEqual(pick('my-model'), ['my-model', null, false]);
  assert.equal(modelLabel('my-model').raw, 'my-model');
  assert.equal(modelLabel('opus').raw, 'opus', 'raw keeps the value as written');
  const xss = '<img src=x onerror=alert(1)>';
  assert.deepEqual(pick(xss), [xss, null, false], 'markup is a plain unknown string: the component renders it as text');
  // Config text is outside input: values that make the version scan walk every group stay linear (a hang times out).
  assert.deepEqual(pick('opus' + '-12345678'.repeat(2000)), ['Opus', 'Anthropic', false], 'every group after the family is a date');
  assert.deepEqual(pick('claude-' + '9-'.repeat(5000) + 'haiku' + '-20240307'.repeat(1000)), ['Haiku 9.9', 'Anthropic', false], 'the old-id fallback over a long prefix');
});

test('modelSummary shows the builder and an effort only when given a valid level', () => {
  const models = { orchestrator: 'inherit', builder: 'claude-opus-5-5', reviewer: 'sonnet' };
  const s = modelSummary(models);
  assert.deepEqual([s.provider, s.label, s.effort], ['Anthropic', 'Opus 5.5', null]);
  assert.equal(summaryText(s, 'Session default'), 'Anthropic · Opus 5.5');
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(modelSummary(models, level).effort, level);
  for (const bad of ['', 'HIGH', 'ultra', 3, null, undefined, {}]) assert.equal(modelSummary(models, bad).effort, null, `${JSON.stringify(bad)} is no effort`);
  assert.equal(summaryText(modelSummary({ builder: 'opus' }, 'high'), 'Session default'), 'Anthropic · Opus · high');
  assert.equal(summaryText(modelSummary({ builder: 'opus' }, 'max'), 'Session default', (e) => `${e} effort`), 'Anthropic · Opus · max effort', 'the effort goes through the caller\'s message');
  assert.equal(summaryText(modelSummary({ builder: 'inherit', orchestrator: 'inherit' }), 'Session default'), 'Anthropic · Session default');
  assert.equal(summaryText(modelSummary({ builder: 'my-model' }), 'Session default'), 'my-model', 'an unknown model drops the provider');
  assert.equal(modelSummary(null).label, null, 'no models: the session default');
  assert.equal(modelSummary({ builder: 'inherit', orchestrator: 'sonnet' }).inherited, true);
});

test('roleRows and reviewerRows list every role in order and every lens', () => {
  const models = { judge: 'opus', zeta: 'x', builder: 'claude-opus-5-5', orchestrator: 'inherit', alpha: 'haiku', planner: 'inherit', reviewer: 'sonnet', 'spec-writer': 'opus', designer: 'sonnet', approver: 'opus', integrator: 'sonnet', retro: 'opus' };
  const rows = roleRows(models);
  assert.deepEqual(rows.map((r) => r.role), [...ROLE_ORDER, 'alpha', 'zeta']);
  assert.equal(ROLE_ORDER.length, 10);
  const by = Object.fromEntries(rows.map((r) => [r.role, r.model]));
  assert.deepEqual([by.orchestrator.label, by.orchestrator.inherited], [null, false], 'the orchestrator is the session default, not inherited');
  assert.deepEqual([by.planner.label, by.planner.inherited, by.planner.raw], [null, true, 'inherit']);
  assert.equal(by.builder.label, 'Opus 5.5');
  assert.equal(by.zeta.provider, null);
  assert.deepEqual(roleRows({ builder: 'opus' }).map((r) => r.role), ['builder'], 'only the keys config.models has');
  assert.deepEqual(roleRows(null), []);
  assert.equal(roleRows({ planner: 'inherit', orchestrator: 'sonnet' }).find((r) => r.role === 'planner')?.model.label, 'Sonnet', 'inherit resolves through the orchestrator');

  const roster = { reviewers: [{ name: 'code', model: 'sonnet', always: true }, { name: 'ui', model: 'inherit', always: false }, { name: 'docs', model: 'claude-haiku-4-5', always: false }] } as any;
  const lenses = reviewerRows(roster, { orchestrator: 'opus' });
  assert.deepEqual(lenses.map((r) => [r.name, r.model.label, r.always]), [['code', 'Sonnet', true], ['ui', 'Opus', false], ['docs', 'Haiku 4.5', false]]);
  assert.deepEqual(reviewerRows(null, {}), []);
  assert.deepEqual(reviewerRows({ reviewers: null } as any, {}), []);
});

test('connectionState: connecting, live, offline, outdated', () => {
  assert.deepEqual(connectionState({ online: null, apiVersion: null, clientApi: 14 }), { state: 'connecting', tone: 'muted' });
  assert.deepEqual(connectionState({ online: false, apiVersion: 14, clientApi: 14 }), { state: 'offline', tone: 'bad' });
  assert.deepEqual(connectionState({ online: false, apiVersion: 15, clientApi: 14 }), { state: 'offline', tone: 'bad' }, 'a failed poll is offline first');
  assert.deepEqual(connectionState({ online: true, apiVersion: 15, clientApi: 14 }), { state: 'outdated', tone: 'warn' });
  assert.deepEqual(connectionState({ online: true, apiVersion: 14, clientApi: 14 }), { state: 'live', tone: 'ok' });
  assert.deepEqual(connectionState({ online: true, apiVersion: 13, clientApi: 14 }), { state: 'live', tone: 'ok' });
  assert.deepEqual(connectionState({ online: true, apiVersion: undefined, clientApi: 14 }), { state: 'live', tone: 'ok' });
});

test('togglePopover keeps one popover open', () => {
  assert.deepEqual([...POPOVERS], ['daemon', 'inbox', 'model', 'connection']);
  assert.equal(togglePopover(null, 'model'), 'model', 'a click opens');
  assert.equal(togglePopover('model', 'model'), null, 'the same indicator closes it');
  assert.equal(togglePopover('model', 'daemon'), 'daemon', 'another indicator switches');
  for (const a of POPOVERS) for (const b of POPOVERS) assert.equal(togglePopover(a, b), a === b ? null : b);
});

test('dismissal: when a popover closes and where focus goes', () => {
  const d = (reason: DismissReason, ctx = {}) => {
    const r = dismissal(reason, ctx);
    return [r.close, r.refocus];
  };
  for (const r of ['escape', 'close', 'toggle', 'navigate'] as const) assert.deepEqual(d(r), [true, true], `${r} returns focus to the indicator`);
  assert.deepEqual(d('outside', { targetFocusable: true }), [true, false], 'a press on a control keeps its focus');
  assert.deepEqual(d('outside', { targetFocusable: false }), [true, true], 'a press on plain text sends focus back');
  assert.deepEqual(d('outside'), [true, true]);
  assert.deepEqual(d('focusout', { relatedInside: false }), [true, false], 'focus left: close and let it stay');
  assert.deepEqual(d('focusout', { relatedInside: true }), [false, false], 'focus moved inside or to the indicator');
  assert.deepEqual(d('focusout', { relatedInside: null }), [false, false], 'no relatedTarget (Safari clicks) closes nothing');
  assert.deepEqual(d('focusout'), [false, false]);
  for (const r of ['external', 'gone'] as const) assert.deepEqual(d(r), [true, false], `${r} closes without refocus`);
});

test('placePopover anchors to the trigger and stays on screen', () => {
  // md and up, left cluster: left edges meet.
  assert.deepEqual(placePopover({ triggerLeft: 260, triggerRight: 380, viewport: 1280, width: 560, align: 'start', narrow: false }), { left: 260, width: 560 });
  // Right cluster: right edges meet.
  assert.deepEqual(placePopover({ triggerLeft: 1100, triggerRight: 1260, viewport: 1280, width: 400, align: 'end', narrow: false }), { left: 860, width: 400 });
  // Clamped 16px inside the viewport on either side.
  assert.deepEqual(placePopover({ triggerLeft: 900, triggerRight: 1000, viewport: 1024, width: 560, align: 'start', narrow: false }), { left: 1024 - 16 - 560, width: 560 });
  assert.deepEqual(placePopover({ triggerLeft: 0, triggerRight: 200, viewport: 1024, width: 400, align: 'end', narrow: false }), { left: 16, width: 400 });
  assert.deepEqual(placePopover({ triggerLeft: 4, triggerRight: 80, viewport: 1024, width: 400, align: 'start', narrow: false }), { left: 16, width: 400 });
  // A viewport narrower than the popover: it shrinks to fit.
  assert.deepEqual(placePopover({ triggerLeft: 300, triggerRight: 400, viewport: 500, width: 560, align: 'start', narrow: false }), { left: 16, width: 468 });
  // Below md: the viewport less 16px on each side.
  assert.deepEqual(placePopover({ triggerLeft: 300, triggerRight: 360, viewport: 375, width: 560, align: 'end', narrow: true }), { left: 16, width: 343 });
  assert.deepEqual(placePopover({ triggerLeft: 0, triggerRight: 40, viewport: 320, width: 400, align: 'start', narrow: true, gutter: 8 }), { left: 8, width: 304 });
});

test('inlineInputAction opens the palette on typed, composed or pasted text, and on Enter or ArrowDown when empty', () => {
  const a = (type: 'input' | 'compositionend' | 'keydown', value: string, composing = false, key?: string) => inlineInputAction({ type, value, composing, key });
  assert.equal(a('input', 'f'), 'open', 'a typed character');
  assert.equal(a('input', 'fix the flaky test'), 'open', 'a paste is an input event too');
  assert.equal(a('input', ''), null, 'a deletion to empty');
  assert.equal(a('input', 'ふ', true), null, 'nothing opens mid-composition');
  assert.equal(a('compositionend', '修正'), 'open', 'composition ends with text');
  assert.equal(a('compositionend', ''), null, 'a cancelled composition');
  assert.equal(a('keydown', '', false, 'Enter'), 'open');
  assert.equal(a('keydown', '', false, 'ArrowDown'), 'open');
  assert.equal(a('keydown', 'x', false, 'Enter'), null, 'Enter with text (the input event already opened it)');
  assert.equal(a('keydown', '', true, 'Enter'), null, 'Enter that confirms a composition');
  assert.equal(a('keydown', '', false, 'ArrowUp'), null);
  assert.equal(a('keydown', '', false, 'Tab'), null);
  assert.equal(a('keydown', '', false, 'a'), null, 'a printable key waits for its input event');
});

test('a press outside counts as focusable on anything that takes focus, not only Tab stops', () => {
  assert.ok(FOCUSABLE.startsWith(`${TABBABLE}, `), 'every Tab stop');
  for (const sel of ['select:not([disabled])', '[tabindex]', 'summary', '[contenteditable]']) assert.ok(FOCUSABLE.includes(sel), `and ${sel}`);
  assert.ok(!TABBABLE.includes('select'), 'the palette trap keeps its own list');
});

test("a popover's own Tab handling stops on summaries and selects, never on tabindex -1", () => {
  assert.ok(TAB_STOPS.startsWith(`${TABBABLE}, `), 'every palette Tab stop');
  for (const sel of ['select:not([disabled])', 'summary', '[contenteditable]']) assert.ok(TAB_STOPS.includes(sel), `and ${sel}`);
  assert.ok(!/(^|, )\[tabindex\](,|$)/.test(TAB_STOPS), 'no bare [tabindex]: tabindex="-1" is not a Tab stop');
});
