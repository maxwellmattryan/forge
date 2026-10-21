// The command bar (dashboard/src/lib/command.ts and CommandBar.svelte): grammar, completions,
// keyboard rule, request mapping and the combobox markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tags } from './svelte-markup.ts';
import { VERBS, commandKey, commandQueuedMessage, commandRequest, createdMessage, emptyReason, parseCommand, scopeVerbs, scopedJob, shellEscape, shortcutAction, shortcutLabel, suggest } from '../dashboard/src/lib/command.ts';
import { buildRequest } from '../dashboard/src/lib/view.ts';

const job = (id: string, state = 'running', extra: Record<string, unknown> = {}): any => ({ id, title: `Title of ${id}`, state, waitingOn: null, stage: 'build', ...extra });
const JOBS = [
  job('add-reading-time-a1b2'),
  job('add-dark-mode-c3d4', 'waiting', { waitingOn: 'spec-approval' }),
  job('add-old-thing-e5f6', 'done'),
  job('fix-login-g7h8', 'failed'),
  job('add-cancelled-i9j0', 'cancelled'),
  job('add-pr-k1l2', 'waiting', { waitingOn: 'pr-review' }),
];
const BACKLOG: any[] = [
  { ref: 'reading-list', title: 'Reading list page', status: 'ready', claimedBy: null },
  { ref: 'reading-time', title: 'Reading time badge', status: 'in-progress', claimedBy: 'add-reading-time-a1b2' },
  { ref: 'export-csv', title: 'Export reading stats to CSV', status: 'ready', claimedBy: null },
  { ref: 'old-item', title: 'Old reading item', status: 'done', claimedBy: null },
];
const ctx: any = { jobs: JOBS, backlog: BACKLOG, tracker: 'local' };
const gh: any = { jobs: JOBS, backlog: null, tracker: 'github' };

test('parseCommand grammar', () => {
  const p = (s: string, c = ctx) => parseCommand(s, c);
  assert.deepEqual(p(''), { kind: 'empty' });
  assert.deepEqual(p('   '), { kind: 'empty' });
  assert.deepEqual(p('/forge '), { kind: 'empty' });
  // next [n]
  assert.deepEqual(p('next'), { kind: 'next', n: null });
  assert.deepEqual(p('NEXT 3'), { kind: 'next', n: 3 });
  assert.deepEqual(p('/forge next 3'), { kind: 'next', n: 3 });
  assert.deepEqual(p('/next 16'), { kind: 'next', n: 16 });
  for (const s of ['next 0', 'next 17', 'next 2.5', 'next button is broken']) assert.deepEqual(p(s), { kind: 'free', text: s }, s);
  // sync, retro
  assert.deepEqual(p('sync'), { kind: 'sync' });
  assert.deepEqual(p('/forge retro '), { kind: 'retro' });
  assert.deepEqual(p('sync the header'), { kind: 'free', text: 'sync the header' });
  assert.deepEqual(p('retro board redesign').kind, 'free');
  // job verbs
  assert.deepEqual(p('approve add-dark-mode-c3d4'), { kind: 'job', verb: 'approve', job: 'add-dark-mode-c3d4', note: '' });
  assert.deepEqual(p('Approve add-dark-mode-c3d4 looks good'), { kind: 'job', verb: 'approve', job: 'add-dark-mode-c3d4', note: 'looks good' });
  assert.deepEqual(p('revise add-dark-mode-c3d4'), { kind: 'job', verb: 'revise', job: 'add-dark-mode-c3d4', note: '' }, 'revise without a note is a command; the submit says what is missing');
  assert.deepEqual(p('answer fix-login-g7h8 use OAuth'), { kind: 'job', verb: 'answer', job: 'fix-login-g7h8', note: 'use OAuth' });
  assert.deepEqual(p('cancel add-pr-k1l2'), { kind: 'job', verb: 'cancel', job: 'add-pr-k1l2', note: '' });
  assert.deepEqual(p('approve'), { kind: 'partial', verb: 'approve', arg: '' });
  assert.deepEqual(p('approve '), { kind: 'partial', verb: 'approve', arg: '' });
  assert.deepEqual(p('rework add-'), { kind: 'partial', verb: 'rework', arg: 'add-' });
  assert.deepEqual(p('approve unknown-job'), { kind: 'free', text: 'approve unknown-job' }, 'approve <unknown>');
  assert.deepEqual(p('approve add-old-thing-e5f6').kind, 'free', 'done jobs are not candidates');
  assert.deepEqual(p('cancel add-cancelled-i9j0').kind, 'free', 'cancelled jobs are not candidates');
  assert.deepEqual(p('approve add- the rest').kind, 'free', 'a prefix followed by more words is text');
  // issue <ref>
  assert.deepEqual(p('issue reading-list'), { kind: 'issue', ref: 'reading-list' });
  assert.deepEqual(p('issue #export-csv'), { kind: 'issue', ref: 'export-csv' });
  assert.deepEqual(p('issue'), { kind: 'partial', verb: 'issue', arg: '' });
  assert.deepEqual(p('issue read'), { kind: 'partial', verb: 'issue', arg: 'read' });
  assert.deepEqual(p('issue tracker is slow'), { kind: 'free', text: 'issue tracker is slow' });
  assert.deepEqual(p('issue 42'), { kind: 'free', text: 'issue 42' }, 'numeric refs are syntactic only on github');
  assert.deepEqual(p('issue #42', gh), { kind: 'issue', ref: '42' });
  assert.deepEqual(p('issue 42', gh), { kind: 'issue', ref: '42' }, 'works with no backlog loaded');
  // free text
  assert.deepEqual(p('Add a reading-time badge'), { kind: 'free', text: 'Add a reading-time badge' });
  assert.deepEqual(p('app'), { kind: 'free', text: 'app' }, 'a verb prefix alone is text until completed');
  assert.deepEqual(p('/forge Add dark mode '), { kind: 'free', text: '/forge Add dark mode' });
});

test('suggest ordering and limits', () => {
  const kinds = (s: string, c = ctx) => suggest(s, c).map((o: any) => (o.kind === 'verb' ? `verb:${o.verb}` : o.kind === 'job' ? `job:${o.job.id}` : o.kind === 'ref' ? `ref:${o.item.ref}` : o.kind));
  const empty = suggest('', ctx);
  assert.equal(empty.length, VERBS.length, 'the empty bar lists every verb');
  assert.deepEqual(empty.map((o: any) => o.verb), [...VERBS]);
  assert.ok(empty.every((o: any) => o.kind === 'verb' && o.insert === `${o.verb} `));
  assert.deepEqual(kinds('re'), ['verb:revise', 'verb:rework', 'verb:retro', 'run-job'], 'verb prefixes first, then a new job');
  assert.deepEqual(kinds('approve'), ['verb:approve'], 'completes the verb with its space');
  assert.deepEqual(kinds('Add a badge'), ['run-job'], 'free text: Start job first');
  assert.deepEqual(kinds('next button is broken'), ['run-job']);
  assert.deepEqual(kinds('next'), ['run-command'], 'a complete command: Send first');
  assert.deepEqual(kinds('n'), ['verb:next', 'run-job']);
  assert.deepEqual(kinds('approve '), ['job:add-dark-mode-c3d4', 'job:fix-login-g7h8', 'job:add-reading-time-a1b2', 'job:add-pr-k1l2'], 'jobs needing a human first, done and cancelled excluded');
  assert.deepEqual(kinds('approve add-'), ['job:add-dark-mode-c3d4', 'job:add-reading-time-a1b2', 'job:add-pr-k1l2']);
  assert.equal((suggest('approve add-d', ctx)[0] as any).insert, 'approve add-dark-mode-c3d4 ');
  assert.deepEqual(kinds('approve add-dark-mode-c3d4 ship'), ['run-command']);
  assert.deepEqual(kinds('issue '), ['ref:reading-list', 'ref:export-csv'], 'open, unclaimed items only');
  assert.deepEqual(kinds('issue read'), ['ref:reading-list', 'ref:export-csv'], 'ref prefix or title substring');
  assert.deepEqual(kinds('issue exp'), ['ref:export-csv']);
  assert.equal((suggest('issue exp', ctx)[0] as any).insert, 'issue export-csv');
  assert.deepEqual(kinds('issue export-csv'), ['run-command']);
  assert.deepEqual(kinds('issue ', gh), [], 'no backlog: no ref completion');
  assert.deepEqual(suggest('approve my-typo', ctx), [{ kind: 'run-job', verbLike: true }], 'a command word with no match says it becomes a job');
  assert.deepEqual(suggest('Add a badge', ctx), [{ kind: 'run-job', verbLike: false }]);
  const reason = (s: string, c = ctx, err: string | null = null) => emptyReason(parseCommand(s, c), suggest(s, c), err, c);
  assert.equal(reason('approve ', { ...ctx, jobs: [job('done-1', 'done')] }), 'noJobs', 'no open jobs');
  assert.equal(reason('issue ', { ...ctx, backlog: [] }), 'noItems');
  assert.equal(reason('issue ', { ...ctx, backlog: null }), 'backlogLoading');
  assert.equal(reason('issue ', { ...ctx, backlog: [] }, 'gh: not logged in'), 'backlogFailed');
  assert.equal(reason('approve '), null, 'options to show');
  assert.equal(reason('Add a badge'), null);
  const many: any = { ...ctx, jobs: Array.from({ length: 20 }, (_, i) => job(`job-${i}`)) };
  assert.equal(suggest('cancel job-', many).length, 8);
});

test('continue and resume', () => {
  const owner = (status: string) => ({ ownerStatus: { status, session: status === 'none' ? null : 's1', since: null, renewedAt: null, expiresAt: null, epoch: 1, jobSession: false } });
  const jobs = [
    job('add-queued-q1', 'queued', owner('none')),
    job('add-held-q2', 'queued', owner('live')),
    job('add-failed-f1', 'failed', owner('expired')),
    job('add-stalled-r1', 'running', owner('expired')),
    job('add-running-r2', 'running', owner('live')),
    job('add-waiting-w1', 'waiting', { waitingOn: 'spec-approval', ...owner('expired') }),
    job('add-done-d1', 'done', owner('none')),
  ];
  const c: any = { jobs, backlog: [], tracker: 'local' };
  assert.deepEqual(parseCommand('continue add-queued-q1', c), { kind: 'job', verb: 'continue', job: 'add-queued-q1', note: '' });
  assert.deepEqual(parseCommand('resume add-queued-q1 pick it up again', c), { kind: 'job', verb: 'continue', job: 'add-queued-q1', note: 'pick it up again' });
  assert.deepEqual(parseCommand('/forge Resume add-running-r2', c), { kind: 'job', verb: 'continue', job: 'add-running-r2', note: '' }, 'any open job parses; the server decides');
  assert.equal(parseCommand('continue add-done-d1', c).kind, 'free');
  const sent = commandRequest(parseCommand('resume add-queued-q1 pick it up', c));
  assert.ok('input' in sent && buildRequest(sent.input));
  assert.deepEqual(buildRequest((sent as any).input), { body: { type: 'resume', job: 'add-queued-q1', text: 'pick it up', args: {} } });
  assert.deepEqual(buildRequest((commandRequest(parseCommand('continue add-queued-q1', c)) as any).input), { body: { type: 'resume', job: 'add-queued-q1', text: null, args: {} } });
  assert.deepEqual([...VERBS].slice(0, 3), ['next', 'issue', 'continue']);

  const ids = (s: string) => suggest(s, c).filter((o: any) => o.kind === 'job').map((o: any) => o.job.id);
  assert.deepEqual(ids('continue '), ['add-failed-f1', 'add-queued-q1', 'add-stalled-r1'], 'only jobs with an enabled Resume, urgent first');
  assert.deepEqual(ids('resume '), ids('continue '));
  assert.equal((suggest('resume add-q', c)[0] as any).insert, 'continue add-queued-q1 ');
  const verbs = (s: string) => suggest(s, c).filter((o: any) => o.kind === 'verb').map((o: any) => o.verb);
  assert.deepEqual(verbs('resume'), ['continue'], 'the alias offers the continue verb');
  assert.deepEqual(verbs('res'), ['continue']);
  assert.deepEqual(verbs('cont'), ['continue']);
  const none: any = { ...c, jobs: [job('add-held-q2', 'queued', owner('live'))] };
  assert.equal(emptyReason(parseCommand('continue ', none), suggest('continue ', none), null, none), 'noJobs');
});

test('scopeVerbs per state and gate', () => {
  const owner = (status: string) => ({ ownerStatus: { status, session: status === 'none' ? null : 's1', since: null, renewedAt: null, expiresAt: null, epoch: 1, jobSession: false } });
  const gate = (waitingOn: string) => scopeVerbs(job('x', 'waiting', { waitingOn, ...owner('none') }));
  assert.deepEqual(gate('spec-approval'), ['approve', 'revise', 'cancel']);
  for (const g of ['split-approval', 'issue-link', 'infra', 'external', 'budget']) assert.deepEqual(gate(g), ['approve', 'cancel'], g);
  assert.deepEqual(gate('input'), ['approve', 'answer', 'cancel']);
  for (const g of ['escalation', 'rounds-exhausted', 'conflicts', 'human']) assert.deepEqual(gate(g), ['approve', 'rework', 'cancel'], g);
  assert.deepEqual(gate('pr-review'), ['cancel'], 'a PR review waits on the PR, not a gate');
  assert.deepEqual(scopeVerbs(job('x', 'failed', owner('none'))), ['continue', 'cancel']);
  assert.deepEqual(scopeVerbs(job('x', 'failed')), ['continue', 'cancel'], 'no ownerStatus at all');
  assert.deepEqual(scopeVerbs(job('x', 'queued', owner('none'))), ['continue', 'cancel']);
  assert.deepEqual(scopeVerbs(job('x', 'running', owner('live'))), ['cancel'], 'a live lease drives it');
  assert.deepEqual(scopeVerbs(job('x', 'running', owner('expired'))), ['continue', 'cancel']);
  assert.deepEqual(scopeVerbs(job('x', 'done', owner('none'))), []);
  assert.deepEqual(scopeVerbs(job('x', 'cancelled', owner('expired'))), []);
  // Always in VERBS order.
  for (const g of ['spec-approval', 'input', 'escalation']) {
    const got = gate(g);
    assert.deepEqual(got, VERBS.filter((v) => (got as string[]).includes(v)), `${g} in VERBS order`);
  }
});

test('suggest lists the scoped job\'s verbs first', () => {
  const id = 'add-dark-mode-c3d4';
  const plain = suggest('', ctx);
  const scoped = suggest('', { ...ctx, scope: id });
  const head = scoped.slice(0, 3);
  assert.deepEqual(head, ['approve', 'revise', 'cancel'].map((verb) => ({ kind: 'scoped', verb, job: JOBS[1], insert: `${verb} ${id} ` })));
  assert.deepEqual(scoped.slice(3), plain, 'then every global verb, unchanged');
  assert.equal(plain.length, VERBS.length);
  for (const scope of ['add-old-thing-e5f6', 'add-cancelled-i9j0', 'no-such-job', null, undefined, '']) assert.deepEqual(suggest('', { ...ctx, scope }), plain, `scope ${scope} is ignored`);
  for (const s of ['re', 'approve ', 'Add a badge', 'cancel add-', 'issue ']) assert.deepEqual(suggest(s, { ...ctx, scope: id }), suggest(s, ctx), `typed ${JSON.stringify(s)} completes as unscoped`);
  assert.equal(scopedJob({ ...ctx, scope: id }), JOBS[1]);
  assert.equal(scopedJob({ ...ctx, scope: 'add-reading-time-a1b2' })?.id, 'add-reading-time-a1b2');
  for (const scope of ['add-old-thing-e5f6', 'add-cancelled-i9j0', 'no-such-job', null, undefined]) assert.equal(scopedJob({ ...ctx, scope }), null, `scope ${scope}`);
  assert.equal(scopedJob(ctx), null);
  // A scoped row inserts a complete command that parses and sends for that job.
  assert.deepEqual(parseCommand(head[0].kind === 'scoped' ? head[0].insert : '', ctx), { kind: 'job', verb: 'approve', job: id, note: '' });
});

test('shellEscape precedence', () => {
  let n = 0;
  for (const command of [false, true]) {
    for (const settings of [false, true]) {
      for (const popover of [false, true]) {
        for (const drawer of [false, true]) {
          const want = command ? 'command' : settings ? 'settings' : popover ? 'popover' : drawer ? 'drawer' : null;
          assert.equal(shellEscape({ command, settings, popover, drawer }), want, JSON.stringify({ command, settings, popover, drawer }));
          n++;
        }
      }
    }
  }
  assert.equal(n, 16);
  assert.equal(shellEscape({ command: true, settings: false, popover: false, drawer: true }), 'command', 'a palette opened from the drawer closes alone');
  assert.equal(shellEscape({ command: false, settings: false, popover: true, drawer: true }), 'popover', 'a popover over the drawer closes first');
  assert.equal(shellEscape({ command: false, settings: false, popover: false, drawer: false }), null);
});

test('shortcutAction', () => {
  for (const inlineVisible of [false, true])
    for (const inlineFocused of [false, true]) assert.equal(shortcutAction({ paletteOpen: true, inlineVisible, inlineFocused }), 'focus-palette', 'open palette: back to its input');
  assert.equal(shortcutAction({ paletteOpen: false, inlineVisible: true, inlineFocused: false }), 'focus-inline', 'md and up: the first press focuses the bar');
  assert.equal(shortcutAction({ paletteOpen: false, inlineVisible: true, inlineFocused: true }), 'open-palette', 'and a second opens the palette');
  assert.equal(shortcutAction({ paletteOpen: false, inlineVisible: false, inlineFocused: false }), 'open-palette', 'below md the input is hidden: open the palette');
});

test('commandKey', () => {
  const k = (o: Partial<Parameters<typeof commandKey>[0]>) => commandKey({ key: 'k', ctrlKey: false, metaKey: true, altKey: false, open: false, settingsOpen: false, ...o });
  assert.equal(k({}), 'open', 'Cmd-K');
  assert.equal(k({ metaKey: false, ctrlKey: true }), 'open', 'Ctrl-K');
  assert.equal(k({ key: 'K' }), 'open', 'with Shift or Caps Lock');
  assert.equal(k({ metaKey: false }), null, 'a bare k is typing');
  assert.equal(k({ altKey: true }), null, 'not with Alt');
  assert.equal(k({ repeat: true }), null, 'not on auto-repeat');
  assert.equal(k({ composing: true }), null, 'not mid-composition');
  assert.equal(k({ settingsOpen: true }), null, 'never over Settings');
  assert.equal(k({ open: true }), 'open', 'again while open: refocus, and keep the browser shortcut away');
  assert.equal(k({ key: 'Escape', metaKey: false, open: true }), 'close');
  assert.equal(k({ key: 'Escape', metaKey: false }), null, 'Escape while closed is the drawer\'s');
  // A field has focus: the chord still opens it (there is no target check at all).
  assert.equal(k({ ctrlKey: true, metaKey: false }), 'open');
  assert.equal(shortcutLabel('MacIntel'), '⌘K');
  assert.equal(shortcutLabel('iPhone'), '⌘K');
  assert.equal(shortcutLabel('Win32'), 'Ctrl K');
  assert.equal(shortcutLabel('Linux x86_64'), 'Ctrl K');
  assert.equal(shortcutLabel(''), 'Ctrl K');
  assert.equal(createdMessage('add-x-1a2b', true), 'Created add-x-1a2b. The daemon picks it up.');
  assert.equal(commandQueuedMessage('approve', 'add-x-1a2b', true), 'Queued "approve" for add-x-1a2b. The daemon picks it up.');
  assert.equal(commandQueuedMessage('sync', null, false), 'Queued "sync". Your orchestrator session picks it up (/forge requests).');
  assert.equal(createdMessage('add-x-1a2b', false), 'Created add-x-1a2b. Start the daemon, or run /forge requests in Claude Code.');
});

test('commandRequest bodies', () => {
  const body = (s: string, c = ctx) => {
    const r: any = commandRequest(parseCommand(s, c));
    if ('error' in r) return r;
    if (r.kind === 'job') return { job: r.body };
    const b: any = buildRequest(r.input);
    return b.body;
  };
  assert.deepEqual(body('  Add a reading-time badge  '), { job: { text: 'Add a reading-time badge' } });
  assert.deepEqual(body('next'), { type: 'next', job: null, text: null, args: {} });
  assert.deepEqual(body('/forge next 3'), { type: 'next', job: null, text: null, args: { n: 3 } });
  assert.deepEqual(body('sync'), { type: 'sync', job: null, text: null, args: {} });
  assert.deepEqual(body('retro'), { type: 'retro', job: null, text: null, args: {} });
  assert.deepEqual(body('approve add-dark-mode-c3d4'), { type: 'approve', job: 'add-dark-mode-c3d4', text: null, args: {} });
  assert.deepEqual(body('approve add-dark-mode-c3d4  ship it '), { type: 'approve', job: 'add-dark-mode-c3d4', text: 'ship it', args: {} });
  assert.deepEqual(body('revise add-dark-mode-c3d4 split the toggle'), { type: 'revise-spec', job: 'add-dark-mode-c3d4', text: 'split the toggle', args: {} });
  assert.deepEqual(body('rework fix-login-g7h8'), { type: 'rework', job: 'fix-login-g7h8', text: null, args: {} });
  assert.deepEqual(body('answer fix-login-g7h8 yes'), { type: 'answer', job: 'fix-login-g7h8', text: 'yes', args: {} });
  assert.deepEqual(body('cancel fix-login-g7h8'), { type: 'cancel', job: 'fix-login-g7h8', text: null, args: {} });
  assert.deepEqual(body('issue #export-csv'), { type: 'run', job: null, text: null, args: { ref: 'export-csv' } });
  assert.deepEqual(body('issue 42', gh), { type: 'run', job: null, text: null, args: { ref: '42' } });
  assert.deepEqual(body('revise add-dark-mode-c3d4'), { error: 'Write something first.' });
  assert.deepEqual(body('answer fix-login-g7h8'), { error: 'Write something first.' });
  assert.ok('error' in body('approve '), 'a partial command sends nothing');
  assert.ok('error' in body(''), 'nor does an empty bar');
});

test('command bar markup is an ARIA combobox', () => {
  const file = path.resolve(import.meta.dirname, '..', 'dashboard', 'src', 'components', 'CommandBar.svelte');
  const all = tags('CommandBar.svelte', fs.readFileSync(file, 'utf8'));
  const attr = (t: any, name: string) => t.attrs.find((a: any) => a.name === name)?.value;
  const with_ = (name: string, value: string) => all.filter((t) => attr(t, name) === value);
  const [dialog] = with_('role', '"dialog"');
  assert.ok(dialog, 'a dialog');
  assert.equal(attr(dialog, 'aria-modal'), '"true"');
  assert.match(attr(dialog, 'aria-label') ?? attr(dialog, 'aria-labelledby') ?? '', /\$t\('command\.title'\)|\S/);
  const [combo] = with_('role', '"combobox"');
  assert.ok(combo && combo.name === 'input', 'the input is the combobox');
  for (const a of ['aria-expanded', 'aria-activedescendant', 'aria-label']) assert.ok(attr(combo, a), a);
  assert.equal(attr(combo, 'aria-controls'), '"command-list"');
  assert.equal(attr(combo, 'aria-autocomplete'), '"list"');
  const [list] = with_('role', '"listbox"');
  assert.equal(attr(list, 'id'), '"command-list"');
  const [option] = with_('role', '"option"');
  assert.ok(attr(option, 'aria-selected'), 'options carry aria-selected');
  assert.ok(attr(option, 'id'), 'options have ids for aria-activedescendant');
  assert.equal(with_('aria-live', '"polite"').length, 1, 'one polite live region');
  assert.ok(with_('role', '"alert"').length >= 1, 'server errors show as an alert');
  // The job scope: a chip that describes the combobox, and its own labelled remove button.
  assert.equal(with_('id', '"command-scope"').length, 1, 'the scope chip');
  // The shared close control (CloseButton renders a button with aria-label={label}).
  const remove = with_('label', "{$t('command.clearScope')}");
  assert.ok(remove.length === 1 && remove[0].name === 'CloseButton', 'a button removes the scope');
  assert.match(attr(combo, 'aria-describedby') ?? '', /^\{(\w+) \? 'command-scope' : undefined\}$/, 'the combobox is described by the chip only while scoped');
});
