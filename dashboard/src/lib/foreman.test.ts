// The Foreman page's model: its panels and their keys, the editor's exact POST bodies, the mandate groups and the
// actions each status offers, the assistant foremen with their current gates, the directives feed and the badge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FOREMAN_PANEL,
  FOREMAN_PANELS,
  assistantRows,
  blankForm,
  directiveActor,
  directiveFeed,
  editMandateBody,
  formOf,
  mandateActions,
  mandateBadge,
  mandateGroups,
  newMandateBody,
  panelKey,
  pendingGates,
  type ForemanPanel,
} from './foreman.ts';
import type { DaemonSessionState, Directive, ForgeRequest, MandateRow, UnreadableMandateRow } from './types.ts';

const row = (id: string, o: Partial<MandateRow> = {}): MandateRow => ({
  id,
  title: id.toUpperCase(),
  status: 'active',
  state: 'active',
  reason: null,
  after: null,
  intake: false,
  scope: { milestones: ['M1'], labels: [], issues: [] },
  contract: { until: 'merge-ready', maxJobs: 2, order: 'graph', decides: ['spec-approval'], budget: { usd: 150, jobs: 5 }, stall: { cadences: 3, bounces: 3 }, onUnfinishable: 'park', scoring: 'all' },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  closedAt: null,
  filedAt: null,
  effective: { until: 'merge-ready', maxJobs: 2, order: 'graph', decides: ['spec-approval'], budget: { usd: 150, jobs: 5 }, stall: { cadences: 3, bounces: 3 }, onUnfinishable: 'park', scoring: 'all' },
  capped: [],
  chain: [id],
  activeLink: id,
  progress: { jobs: { reached: 0, inFlight: 0, handled: 0, unfinishable: 0 }, spend: { usd: 0, budget: 150 }, started: { jobs: 0, budget: 5 }, lastActivity: '2026-10-02T00:00:00.000Z' },
  draft: null,
  // An empty mandate's card: every count 0, every figure null.
  card: {
    mandate: id,
    at: '2026-10-02T00:00:00.000Z',
    jobs: { total: 0, reached: 0, merged: 0, inFlight: 0 },
    scores: { scored: 0, held: 0, failed: 0, pending: 0, unscored: 0, median: null, below3: null },
    review: { reviewed: 0, avgRounds: null, firstPassRate: null },
    interventions: { total: 0, byGate: {} },
    spend: { usd: 0, budgetUsd: 150, started: 0, budgetJobs: 5 },
    outcomes: { final: 0, open: 0, unmeasured: 0, reverted: null, followedUp: null, finalAt: null },
  },
  ...o,
});

test("the Foreman page's panels start with the Office", () => {
  assert.equal(FOREMAN_PANELS[0], 'office');
  assert.equal(DEFAULT_FOREMAN_PANEL, FOREMAN_PANELS[0]);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.equal(panelKey('office', key), 'office', key);
  assert.equal(panelKey('office', 'ArrowDown'), null);
  // With more panels (#396's Chats), the keys wrap and jump through the list in order.
  const three = ['office', 'chats', 'third'] as unknown as ForemanPanel[];
  const at = (p: string) => p as ForemanPanel;
  assert.deepEqual(
    [panelKey(at('office'), 'ArrowRight', three), panelKey(at('third'), 'ArrowRight', three), panelKey(at('office'), 'ArrowLeft', three), panelKey(at('chats'), 'Home', three), panelKey(at('office'), 'End', three)],
    ['chats', 'office', 'third', 'office', 'third'],
  );
});

test('editor bodies send only what changed', () => {
  // A new mandate: id and title, each filled term, comma lists split and trimmed with empty entries dropped, after null for none.
  assert.deepEqual(newMandateBody({ ...blankForm(), id: ' m1 ', title: ' First ', milestones: ' M1 , ,M2,' }), { id: 'm1', title: 'First', milestones: ['M1', 'M2'], after: null });
  assert.deepEqual(
    newMandateBody({ ...blankForm(), id: 'm2', title: 'T', labels: 'infra', until: 'merged', maxJobs: '3', budgetUsd: '20.5', decides: [], after: 'm1', body: 'Guidance.' }),
    { id: 'm2', title: 'T', labels: ['infra'], until: 'merged', maxJobs: 3, budgetUsd: 20.5, decides: [], after: 'm1', body: 'Guidance.' },
  );

  // An edit: an unchanged form sends updatedAt alone.
  const m = row('m1', { after: 'm0', scope: { milestones: ['M1', 'M2'], labels: [], issues: [] } });
  const loaded = { body: 'Prefer small PRs.' };
  assert.deepEqual(editMandateBody(m, loaded, formOf(m, loaded.body)), { updatedAt: m.updatedAt });
  // Only the terms that differ, a cleared list as [], none as after null, decides compared as a set.
  const form = { ...formOf(m, loaded.body), title: 'Renamed', milestones: 'M2, M1', maxJobs: '4', decides: ['spec-approval'], after: '', body: 'New guidance.' };
  assert.deepEqual(editMandateBody(m, loaded, form), { updatedAt: m.updatedAt, title: 'Renamed', milestones: ['M2', 'M1'], maxJobs: 4, after: null, body: 'New guidance.' });
  assert.deepEqual(editMandateBody(m, loaded, { ...formOf(m, loaded.body), milestones: '', labels: 'x', maxJobs: '' }), { updatedAt: m.updatedAt, milestones: [], labels: ['x'] }, 'a cleared number is left as it was');
  // A goal mandate in intake never sends scope keys.
  const goal = row('g1', { intake: true, scope: { milestones: [], labels: [], issues: [] } });
  assert.deepEqual(editMandateBody(goal, { body: '' }, { ...formOf(goal, ''), milestones: 'M9', title: 'G' }), { updatedAt: goal.updatedAt, title: 'G' });
  // Filed, it is an ordinary scoped mandate again.
  const filed = { ...goal, filedAt: '2026-10-03T00:00:00.000Z' };
  assert.deepEqual(editMandateBody(filed, { body: '' }, { ...formOf(filed, ''), milestones: 'M9' }), { updatedAt: goal.updatedAt, milestones: ['M9'] });
});

test('mandate groups and actions', () => {
  const bad: UnreadableMandateRow = { id: 'bad', problem: 'no frontmatter between --- lines' };
  const rows = [row('a'), row('b', { status: 'closed', state: 'closed' }), row('c', { status: 'paused', state: 'paused' }), row('d', { state: 'waiting' }), bad, row('e', { status: 'closed', state: 'closed' })];
  const g = mandateGroups(rows);
  assert.deepEqual(
    g.open.map((m) => m.id),
    ['a', 'c', 'd', 'bad'],
  );
  assert.deepEqual(
    g.closed.map((m) => m.id),
    ['b', 'e'],
  );
  assert.deepEqual(mandateActions(row('a')), ['edit', 'pause', 'close']);
  assert.deepEqual(mandateActions(row('d', { state: 'waiting' })), ['edit', 'pause', 'close']);
  assert.deepEqual(mandateActions(row('c', { status: 'paused', state: 'paused' })), ['edit', 'resume', 'close']);
  assert.deepEqual(mandateActions(row('b', { status: 'closed', state: 'closed' })), []);
  assert.deepEqual(mandateActions(bad), []);
});

test('assistant foremen and their gates', () => {
  const session = (scope: string, status: DaemonSessionState['status'], sessionId: string | null) => ({ scope, status, sessionId }) as DaemonSessionState;
  const req = (id: string, o: Partial<ForgeRequest>): ForgeRequest => ({ id, type: 'gate', job: null, text: null, args: {}, from: 'cli', status: 'pending', createdAt: '2026-10-01T00:00:00.000Z', ...o });
  const daemons = { assistants: { '_assistant-10': session('_assistant-10', 'idle', 's10'), '_assistant-2': session('_assistant-2', 'busy', 's2'), '_assistant-1': session('_assistant-1', 'busy', 's1') } };
  const requests = [
    req('1-a', { job: 'j1', status: 'in-progress', session: 's1', args: { gate: 'spec-approval' } }),
    req('2-b', { status: 'in-progress', session: 's2', args: { gate: 'milestone-approval', mandate: 'g1' } }),
    req('3-c', { job: 'j3', status: 'done', session: 's10', args: { gate: 'escalation' } }),
    req('4-d', { job: 'j4', args: { gate: 'conflicts' } }),
    req('5-e', { job: 'j5', args: { gate: 'conflicts' } }),
    req('6-f', { type: 'resume', job: 'j6', status: 'in-progress', session: 's10' }),
  ];
  assert.deepEqual(assistantRows(daemons, requests), [
    { scope: '_assistant-1', n: 1, status: 'busy', gate: { job: 'j1', gate: 'spec-approval' } },
    { scope: '_assistant-2', n: 2, status: 'busy', gate: { mandate: 'g1', gate: 'milestone-approval' } },
    { scope: '_assistant-10', n: 10, status: 'idle', gate: null },
  ]);
  assert.deepEqual(assistantRows({ assistants: { '_assistant-1': session('_assistant-1', 'off', null) } }, requests)[0]?.gate, null, 'no session id, no gate');
  assert.deepEqual(assistantRows(null, requests), []);
  assert.equal(pendingGates(requests), 2);
});

test('the directives feed', () => {
  const d = (ts: string, reason: string, actor: Directive['actor']): Directive => ({ ts, mandate: 'm1', action: 'note', issue: null, job: null, reason, actor });
  const list = [d('2026-10-01T00:00:00.000Z', 'first', null), d('2026-10-02T00:00:00.000Z', 'second', { login: 'ana', source: 'gh' }), d('2026-10-02T00:00:00.000Z', 'third', { login: null, source: 'foreman' })];
  assert.deepEqual(
    directiveFeed(list).map((x) => x.reason),
    ['third', 'second', 'first'],
  );
  assert.equal(directiveActor(list[2]!), 'Foreman');
  assert.equal(directiveActor(list[1]!), 'ana');
  assert.equal(directiveActor({ actor: { login: null, source: 'dashboard' } }), 'dashboard');
  assert.equal(directiveActor({ actor: { login: 'ana', source: 'foreman' } }, 'Contremaître'), 'Contremaître');
});

test('mandate badges', () => {
  assert.deepEqual(mandateBadge({ mandate: 'm1' }), { id: 'm1' });
  assert.deepEqual(mandateBadge({ mandate: 'q4-infra-2' }), { id: 'q4-infra-2' });
  for (const mandate of [null, undefined, '', 'none', 'Bad', '-x', '../x', 'x'.repeat(41), 7]) assert.equal(mandateBadge({ mandate }), null, String(mandate));
  assert.equal(mandateBadge({}), null);
});
