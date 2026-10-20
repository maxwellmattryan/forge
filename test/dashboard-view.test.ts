// The view logic moved out of the pre-Svelte app.js (dashboard/src/lib/view.ts). Goldens were produced by running
// main's app.js code (inboxCard, the click handler's req/eval-run branches, compareTable, prChip, filteredJobs) and
// are pasted here as data, so any drift in actions, placeholders or POST bodies fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../dashboard/src/lib/view.ts';
import { PARK_LABEL, WAIT_LABEL } from '../dashboard/src/lib/labels.ts';
import { cleanRef, parseCandidates, secretItems, secretLine, threadAction, threadItems, threadMarks, threadOpening } from '../dashboard/src/lib/thread.ts';
import { dur, tokensShort } from '../dashboard/src/lib/util.ts';
import { STAGES, STATES, WAITING_ON } from '../dashboard/src/lib/types.ts';
import { DEP_REASON } from '../lib/deps.ts';

// Per waiting kind: the card's buttons, its textarea placeholder (null: no textarea) and its "Read …" link.
const INBOX = {"spec-approval":{"actions":[{"label":"Approve spec","type":"approve","primary":true,"needsNote":false},{"label":"Request changes","type":"revise-spec","primary":false,"needsNote":true}],"note":"Optional note for the agents…","doc":"spec.md"},"split-approval":{"actions":[{"label":"Approve split","type":"approve","primary":true,"needsNote":false},{"label":"Keep as one job","type":"revise-spec","primary":false,"needsNote":false}],"note":"Optional note for the agents…","doc":"plan.md"},"input":{"actions":[{"label":"Send answer","type":"answer","primary":true,"needsNote":true}],"note":"Your answer…","doc":"questions.md"},"escalation":{"actions":[{"label":"Approve","type":"approve","primary":true,"needsNote":false},{"label":"Rework","type":"rework","primary":false,"needsNote":true},{"label":"Cancel job","type":"cancel","primary":false,"needsNote":false}],"note":"Optional note for the agents…","doc":"decision.md"},"rounds-exhausted":{"actions":[{"label":"Another round","type":"rework","primary":false,"needsNote":true},{"label":"Accept as is","type":"approve","primary":false,"needsNote":false},{"label":"Cancel job","type":"cancel","primary":false,"needsNote":false}],"note":"Optional note for the agents…","doc":"review/round-2"},"budget":{"actions":[{"label":"Approve & continue","type":"approve","primary":true,"needsNote":true},{"label":"Cancel job","type":"cancel","primary":false,"needsNote":false}],"note":"Optional: new limits, e.g. usd=20 tokens=2000000","doc":null},"infra":{"actions":[{"label":"Steps done, resume","type":"resume","primary":true,"needsNote":false}],"note":null,"doc":"runbook.md"},"conflicts":{"actions":[{"label":"Fix conflicts now","type":"rework","primary":true,"needsNote":false,"text":"Resolve merge conflicts with the base branch"},{"label":"Leave for later","type":"resume","primary":false,"needsNote":false}],"note":null,"doc":null},"external":{"actions":[{"label":"Unblocked, resume","type":"resume","primary":false,"needsNote":false}],"note":null,"doc":null},"human":{"actions":[{"label":"Approve","type":"approve","primary":true,"needsNote":false},{"label":"Rework","type":"rework","primary":false,"needsNote":true},{"label":"Cancel job","type":"cancel","primary":false,"needsNote":false}],"note":"Optional note for the agents…","doc":null},"failed":{"actions":[{"label":"Retry","type":"resume","primary":false,"needsNote":false},{"label":"Cancel job","type":"cancel","primary":false,"needsNote":false}],"note":null,"doc":null},"pr-review":{"actions":[{"label":"Resume","type":"resume","primary":false,"needsNote":false}],"note":null,"doc":null},"mystery":{"actions":[{"label":"Resume","type":"resume","primary":false,"needsNote":false}],"note":null,"doc":null}};
const REQUESTS = {"runNext":{"type":"next","job":null,"text":null,"args":{}},"start":{"type":"run","job":null,"text":null,"args":{"ref":"12"}},"addressFeedback":{"type":"rework","job":"j2","text":"Address the PR feedback","args":{}},"approveWithNote":{"type":"approve","job":"j1","text":"ship it","args":{}},"approveNoNote":{"type":"approve","job":"j3","text":null,"args":{}},"answerEmpty":{"toast":["Write something first.",true]},"reworkEmpty":{"type":"rework","job":"j3","text":null,"args":{}},"fixConflicts":{"type":"rework","job":"j1","text":"Resolve merge conflicts with the base branch","args":{}},"evalRun":{"type":"eval-run","args":{"tags":"replay, ui","tasks":null,"label":"base"}},"evalRunEmpty":{"type":"eval-run","args":{"tags":null,"tasks":null,"label":null}}};
const FILTERS = {"active":["a","b","c","d","i"],"waiting":["b","c","d"],"done":["e","f"],"all":["a","b","c","d","e","f","g","h","i"]};

const card = (kind): any => (kind === 'failed' ? { id: 'j1', state: 'failed', waitingOn: null, round: 2 } : { id: 'j1', state: 'waiting', waitingOn: kind, round: 2 });

test('inbox: every waiting kind keeps its actions, note and doc', () => {
  for (const [kind, want] of Object.entries(INBOX)) {
    const k = V.inboxKind(card(kind));
    assert.deepEqual(V.inboxActions(k), want.actions, kind);
    assert.equal(V.showsNote(k) ? V.notePlaceholder(k) : null, want.note, kind);
    assert.equal(V.inboxDoc(k, card(kind)), want.doc, kind);
  }
  assert.equal(V.inboxKind({ state: 'failed', waitingOn: 'input' }), 'failed');
});

test('requests: the exact POST bodies of main\'s buttons', () => {
  const body = (input) => {
    const r = V.buildRequest(input);
    return 'error' in r ? { toast: [r.error, true] } : r.body;
  };
  const note = '  ship it  ';
  assert.deepEqual(body({ type: 'next' }), REQUESTS.runNext, 'Run next');
  assert.deepEqual(body({ type: 'run', ref: '12' }), REQUESTS.start, 'Start');
  assert.deepEqual(body({ type: 'rework', job: 'j2', fixedText: 'Address the PR feedback' }), REQUESTS.addressFeedback, 'Address feedback');
  assert.deepEqual(body({ type: 'approve', job: 'j1', note }), REQUESTS.approveWithNote, 'approve with a note');
  assert.deepEqual(body({ type: 'approve', job: 'j3', note: '' }), REQUESTS.approveNoNote, 'approve without a note');
  assert.deepEqual(body({ type: 'approve', job: 'j3', note: null }), REQUESTS.approveNoNote, 'a card without a textarea');
  assert.deepEqual(body({ type: 'answer', job: 'j3', note: '   ', needsNote: true }), REQUESTS.answerEmpty, 'an empty answer');
  assert.deepEqual(body({ type: 'revise-spec', job: 'j3', note: '', needsNote: true }), REQUESTS.answerEmpty, 'empty spec changes');
  assert.deepEqual(body({ type: 'rework', job: 'j3', note: '', needsNote: true }), REQUESTS.reworkEmpty, 'rework may be empty');
  assert.deepEqual(body({ type: 'rework', job: 'j1', note, fixedText: 'Resolve merge conflicts with the base branch' }), REQUESTS.fixConflicts, 'fixed text wins over the note');
  assert.deepEqual(V.evalRunBody({ tags: ' replay, ui ', tasks: '   ', label: 'base' }), REQUESTS.evalRun, 'Run eval');
  assert.deepEqual(V.evalRunBody({ tags: '', tasks: null, label: '' }), REQUESTS.evalRunEmpty, 'Run eval, empty form');
  assert.deepEqual(Object.keys(body({ type: 'next' })), ['type', 'job', 'text', 'args'], 'same key order on the wire');
  assert.deepEqual(body({ type: 'approve', job: 'j1', note: ' why ', args: { link: 'none' } }), { type: 'approve', job: 'j1', text: 'why', args: { link: 'none' } }, 'args ride along');
  assert.deepEqual(body({ type: 'run', ref: '12', args: { n: 2 } }), { type: 'run', job: null, text: null, args: { ref: '12', n: 2 } }, 'args merge after ref');
  assert.deepEqual(body({ type: 'next', args: { n: 3 } }), { type: 'next', job: null, text: null, args: { n: 3 } });
  assert.equal(V.queuedMessage('next', true), 'Queued "next". The daemon picks it up.');
  assert.equal(V.queuedMessage('next', false), 'Queued "next". Your orchestrator session picks it up (/forge requests).');
});

test('chips: state, verdict and PR tones and text', () => {
  const TONE: Record<string, string> = { running: 'live', failed: 'bad', blocked: 'bad', done: 'ok', queued: 'muted', cancelled: 'muted' };
  let checked = 0;
  for (const state of STATES)
    for (const waitingOn of state === 'waiting' ? WAITING_ON : [null]) {
      const j: any = { state, waitingOn };
      const want = state === 'waiting' ? (waitingOn === 'pr-review' ? 'info' : 'you') : TONE[state];
      const got = V.stateTone(j);
      assert.equal(got, want, `${state}/${waitingOn}`);
      assert.equal(got === 'you', V.needsHuman(j), `${state}/${waitingOn}: you exactly when a human is needed`);
      assert.notEqual(got, 'accent');
      checked++;
    }
  assert.equal(checked, STATES.length - 1 + WAITING_ON.length);
  assert.equal(V.stateText({ state: 'waiting', waitingOn: 'input' }), 'Question for you');
  assert.equal(V.stateText({ state: 'waiting', waitingOn: 'later' } as any), 'later', 'unknown wait reasons show raw');
  assert.equal(V.stateText({ state: 'running' }), 'running');
  assert.deepEqual(['PASS', 'CHANGES', 'MALFORMED', undefined].map(V.verdictTone), ['ok', 'bad', 'warn', 'muted']);
  // main's prChip, as [input, toneChip(tone, text)] with toneChip stubbed to `[tone:text]`.
  const prs: any = [
    [null, ''], [{}, ''], [{ number: 5, state: 'MERGED' }, '[ok:#5]'], [{ number: 5, state: 'CLOSED', conflicts: true }, '[muted:#5 · conflicts]'],
    [{ number: 5, state: 'OPEN', conflicts: true }, '[warn:#5 · conflicts]'], [{ number: 5, state: 'OPEN', checks: { state: 'failing' } }, '[bad:#5 · failing]'],
    [{ number: 5, state: 'OPEN', checks: { state: 'pending' } }, '[warn:#5 · pending]'], [{ number: 5, state: 'OPEN', checks: { state: 'passing' } }, '[info:#5 · passing]'],
    [{ number: 5, state: 'OPEN', checks: { state: 'none' } }, '[info:#5]'], [{ number: 5, state: 'OPEN' }, '[info:#5]'],
  ];
  for (const [pr, want] of prs) {
    const m = V.prChipModel(pr);
    assert.equal(m ? `[${m.tone}:${m.text}]` : '', want, JSON.stringify(pr));
  }
  assert.equal(V.progressWidth({ done: 1, total: 3 }), 33);
  assert.equal(V.progressWidth({ done: 0, total: 0 }), null);
  assert.equal(V.progressWidth(undefined), null);
  assert.equal(V.cardRef({ id: '12-x', issues: [{ tracker: 'local', ref: '12', url: null }] } as any), '#12');
  assert.equal(V.cardRef({ id: 'my-job', issues: [{ tracker: 'local', ref: 'ENG-4', url: null }] } as any), 'ENG-4');
  assert.equal(V.cardRef({ id: 'slug', issues: [{ tracker: 'local', ref: 'slug', url: null }] } as any), null);
  assert.equal(V.cardRef({ id: 'x', issues: [] }), null);
  assert.equal(V.cardRef({ id: 'job-x', issues: [{ tracker: 'local', ref: '85', url: null }] } as any), '#85', 'a numeric ref is always #n');
  assert.equal(V.cardRef({ id: '12', issues: [{ tracker: 'local', ref: '12', url: null }] } as any), '#12');
  assert.equal(V.cardRef({ id: 'slug-ab12', issues: [{ tracker: 'local', ref: 'slug', url: null }] } as any), null, 'a local slug ref the id starts with');
  assert.deepEqual(V.runningRoles({ agents: { builder: { status: 'running' }, reviewer: { status: 'done' } } } as any), ['builder']);
});

test('agentsSummary: 0, 1, 2 and 7 agents, reviewers vs mixed roles', () => {
  assert.equal(V.agentsSummary([]), null);
  assert.deepEqual(V.agentsSummary(['builder']), { kind: 'role', role: 'builder', title: 'builder' });
  assert.deepEqual(V.agentsSummary(['reviewer:code']), { kind: 'role', role: 'reviewer:code', title: 'reviewer:code' });
  assert.deepEqual(V.agentsSummary(['reviewer:code', 'reviewer:tests']), { kind: 'reviewers', count: 2, title: 'reviewer:code, reviewer:tests' });
  const lenses = ['code', 'tests', 'security', 'docs', 'ui', 'accessibility', 'ux'].map((l) => `reviewer:${l}`);
  assert.deepEqual(V.agentsSummary(lenses), { kind: 'reviewers', count: 7, title: lenses.join(', ') });
  assert.deepEqual(V.agentsSummary(['builder', 'reviewer:code']), { kind: 'agents', count: 2, title: 'builder, reviewer:code' });
  assert.deepEqual(V.agentsSummary(['reviewer', 'reviewer:ux']), { kind: 'reviewers', count: 2, title: 'reviewer, reviewer:ux' }, 'a bare reviewer counts');
  assert.equal(V.agentsSummary(['reviewers-lead', 'reviewer:ux'])?.kind, 'agents', 'only `reviewer` or `reviewer:<lens>` counts');
  // Fed from runningRoles, in agents key order.
  const job: any = { agents: { 'reviewer:ux': { status: 'running' }, builder: { status: 'done' }, 'reviewer:code': { status: 'running' } } };
  assert.deepEqual(V.agentsSummary(V.runningRoles(job)), { kind: 'reviewers', count: 2, title: 'reviewer:ux, reviewer:code' });
});

const JOBS: any = [
  { id: 'a', state: 'running', kind: 'feature', stage: 'build' }, { id: 'b', state: 'waiting', waitingOn: 'input', kind: 'feature', stage: 'spec' },
  { id: 'c', state: 'blocked', kind: 'bug', stage: 'verify' }, { id: 'd', state: 'failed', kind: 'feature', stage: 'build' },
  { id: 'e', state: 'done', kind: 'feature', stage: 'done' }, { id: 'f', state: 'cancelled', kind: 'feature', stage: 'plan' },
  { id: 'g', state: 'running', kind: 'eval', stage: 'build' }, { id: 'h', state: 'done', kind: 'eval', stage: 'done' },
  { id: 'i', state: 'queued', kind: 'feature', stage: 'backlog' }, { id: 'p', state: 'waiting', waitingOn: 'pr-review', kind: 'feature', stage: 'pr' },
];

test('pipeline: filters, counts, board columns and nav badges', () => {
  const base = JOBS.slice(0, 9);
  for (const [f, ids] of Object.entries(FILTERS)) assert.deepEqual(V.filterJobs(base, f).map((j) => j.id), ids, f);
  assert.deepEqual(V.pipelineCounts(base), { all: 9, active: 5, waiting: 3, done: 2 }, 'all counts evals; the rest do not');
  assert.deepEqual(V.boardColumns([]).map((c) => c.id), ['queued', 'plan', 'build', 'ship']);
  assert.deepEqual(V.boardColumns(JOBS).map((c) => [c.id, c.jobs.map((j) => j.id)]), [['queued', ['i']], ['plan', ['b']], ['build', ['c', 'd', 'a', 'g']], ['ship', ['p']], ['done', ['e', 'f', 'h']]]);
  assert.deepEqual(V.navCounts(JOBS), { active: 7, needs: 2 }, 'pr-review waits are not "needs you"');
  const now = Date.parse('2026-10-12T12:00:00Z');
  const owned: any = [
    { owner: { session: 's1', heartbeat: '2026-10-12T11:45:00Z', since: '2026-10-12T10:00:00Z' } },
    { owner: { session: 's1', heartbeat: '2026-10-12T11:59:00Z' } },
    { owner: { session: 's2', heartbeat: null, since: '2026-10-12T11:50:00Z' } },
    { owner: { session: 's3', heartbeat: '2026-10-12T11:00:00Z' } },
    { owner: null },
  ];
  const sessions = V.agentSessions(owned.filter((j) => j.owner), now);
  assert.deepEqual(sessions.map((x) => [x.session, x.jobs.length, x.live]), [['s1', 2, true], ['s2', 1, true], ['s3', 1, false]]);
  assert.deepEqual(V.runningAgents([{ id: 'j', agents: { builder: { status: 'running', model: 'opus' }, x: { status: 'done' } } }] as any).map((a) => [a.job.id, a.role, a.model]), [['j', 'builder', 'opus']]);
});

test('views list six pages', () => {
  // Needs you is a status-bar popover now, not a page.
  assert.deepEqual(V.VIEWS.map((v) => v.id), ['pipeline', 'backlog', 'agents', 'analytics', 'evals', 'project']);
  assert.equal(V.VIEWS.length, 6);
  assert.equal(V.viewIndex('pipeline'), 1);
  assert.equal(V.viewIndex('backlog'), 2);
  assert.equal(V.viewIndex('evals'), 5);
  assert.equal(V.viewIndex('project'), 6);
  assert.equal(V.viewIndex('inbox'), 1, 'the old Needs-you id reads as the first view');
  assert.equal(V.viewIndex('nope'), 1, 'an unknown id reads as the first view');
  V.VIEWS.forEach((v, i) => assert.equal(V.viewIndex(v.id), i + 1, v.id));
});

test('inbox groups urgent jobs and PRs awaiting review', () => {
  const g = V.inboxGroups(JOBS);
  assert.deepEqual(g.urgent.map((j) => j.id), ['b', 'c', 'd']);
  assert.deepEqual(g.prs.map((j) => j.id), ['p']);
  assert.deepEqual(g.parks, []);
});

test('evals: compare rows keep the old table\'s values and tones', () => {
  const rows = V.compareRows({
    a: { configHash: 'h1', forgeVersion: '1' }, b: { configHash: 'h2', forgeVersion: '2' },
    delta: {
      tasks: { a: 2, b: 2, change: 0 }, checkPassRate: { a: 0.5, b: 0.75, change: 0.25 }, avgJudgeScore: { a: 0.9, b: 0.8, change: -0.1 }, firstPassRate: { a: null, b: 1, change: null },
      avgRounds: { a: 2, b: 1, change: -1 }, escalationRate: { a: 0, b: 0.5, change: 0.5 }, roundsExhaustedRate: { a: 0, b: 0.25, change: 0.25 }, avgTokens: { a: 100, b: 100, change: 0 }, avgCostUsd: { a: 1, b: 2, change: 1 }, avgMinutes: { a: 10, b: 5, change: -5 },
    },
  } as any);
  // main's compareTable rendered these rows (metric, A, B, Δ and the Δ cell's tone class).
  assert.deepEqual(rows.map((r) => [r.key, r.a, r.b, r.change, r.tone]), [
    ['checkPassRate', '0.5', '0.75', '+0.25', 'text-ok'],
    ['avgJudgeScore', '0.9', '0.8', '-0.1', 'text-bad'],
    ['firstPassRate', '—', '1', '—', 'text-muted'],
    ['avgRounds', '2', '1', '-1', 'text-ok'],
    ['escalationRate', '0', '0.5', '+0.5', 'text-bad'],
    ['roundsExhaustedRate', '0', '0.25', '+0.25', 'text-bad'],
    ['avgTokens', '100', '100', '0', 'text-muted'],
    ['avgCostUsd', '1', '2', '+1', 'text-bad'],
    ['avgMinutes', '10', '5', '-5', 'text-ok'],
  ]);
});

test('drawer: file selection and timeline details', () => {
  assert.equal(V.pickDrawerFile(['a.md', 'build.md', 'spec.md'], null), 'spec.md');
  assert.equal(V.pickDrawerFile(['a.md', 'build.md'], null), 'build.md');
  assert.equal(V.pickDrawerFile(['z.txt'], null), 'z.txt');
  assert.equal(V.pickDrawerFile([], null), null);
  assert.equal(V.pickDrawerFile(['spec.md', 'review/round-2/code.md'], 'review/round-2'), 'review/round-2/code.md', 'an inbox link to a dir opens its first file');
  assert.equal(V.pickDrawerFile(['spec.md'], 'gone.md'), 'gone.md');
  assert.equal(V.pickDrawerFile(['spec.md', 'build.md'], 'build.md'), 'build.md');
  const fmt = { tokens: tokensShort, dur };
  const d = (e) => V.eventDetail({ v: 1, ts: 't', ...e }, fmt);
  assert.deepEqual(d({ type: 'transition', from: { stage: 'spec', state: 'running' }, to: { stage: 'spec', state: 'waiting', waitingOn: 'spec-approval' }, reason: 'ready' }), { pre: 'spec/running → ', bold: 'spec/waiting', post: ' (spec-approval) · ready' });
  assert.deepEqual(d({ type: 'transition', from: null, to: { stage: 'backlog', state: 'queued' } }), { pre: '/ → ', bold: 'backlog/queued', post: '' });
  assert.deepEqual(d({ type: 'agent-end', role: 'builder', model: 'opus', usage: { totalTokens: 1500 }, summary: 'ok' }), { pre: 'builder (opus) · 2k tok · ok', bold: null, post: '' });
  assert.deepEqual(d({ type: 'agent-start', role: 'builder' }), { pre: 'builder ', bold: null, post: '' });
  assert.deepEqual(d({ type: 'command', name: 'test', ok: false, exit: 1, durationMs: 61000 }), { pre: 'test ✗ exit 1 · 1m 1s', bold: null, post: '' });
  assert.deepEqual(d({ type: 'command', name: 'test', ok: true, durationMs: 0 }), { pre: 'test ✓ · 0m 0s', bold: null, post: '' });
  assert.deepEqual(d({ type: 'note', text: '<b>hi</b>' }), { pre: '<b>hi</b>', bold: null, post: '' }, 'raw text: Svelte escapes it');
  assert.deepEqual(d({ type: 'human', action: 'approve', note: 'lgtm' }), { pre: '', bold: 'approve', post: ' · lgtm' });
  const other = d({ type: 'mystery', blob: '<'.repeat(300) });
  assert.equal(other.pre, JSON.stringify({ blob: '<'.repeat(300) }).slice(0, 240), 'sliced before escaping, so no entity is cut');
  assert.deepEqual(V.verdictMatrix({ verdicts: {}, verify: {} }), null);
  assert.deepEqual(V.verdictMatrix({ reviewers: ['code'], verdicts: { 2: { code: 'PASS', ui: 'CHANGES' }, 1: { code: 'CHANGES' } }, verify: { 3: 'FAIL' } }), { rounds: [1, 2, 3], reviewers: ['code', 'ui'] });
  // A round with only a verifiers result still gets a row.
  assert.deepEqual(V.verdictMatrix({ verdicts: {}, verify: {} }, { 4: { outcome: 'PASS', blocking: 0, warned: 1 } }), { rounds: [4], reviewers: [] });
  assert.deepEqual(V.verdictMatrix({ reviewers: ['code'], verdicts: { 1: { code: 'PASS' } }, verify: { 1: 'PASS' } }, { 2: { outcome: 'CHANGES', blocking: 1, warned: 0 } }), { rounds: [1, 2], reviewers: ['code'] });
});

test('verifierRounds', () => {
  const ev = (n: number, data: Record<string, unknown>) => ({ v: 1, ts: `2026-10-16T00:00:${String(n).padStart(2, '0')}.000Z`, type: 'verifiers', ...data });
  const events: any[] = [
    ev(1, { phase: 'run', round: 1, selected: ['a'] }),
    ev(2, { phase: 'record', round: 1, outcome: 'CHANGES', blocking: 1, warned: 0, results: [] }),
    ev(3, { phase: 'run', round: 1, selected: ['a'] }),
    ev(4, { phase: 'record', round: 1, outcome: 'PASS', blocking: 0, warned: 2, results: [] }),
    ev(5, { phase: 'record', round: 2, outcome: 'PASS', blocking: 0, warned: 0 }),
    ev(6, { phase: 'record', round: 3, outcome: 'MAYBE', blocking: 0, warned: 0 }),
    ev(7, { phase: 'record', round: '4', outcome: 'PASS', blocking: 0, warned: 0 }),
    ev(8, { phase: 'record', round: 5, outcome: 'PASS', blocking: -1, warned: 0 }),
    ev(9, { phase: 'record', round: 6, outcome: 'PASS', blocking: 0 }),
    { v: 1, ts: 'x', type: 'verify', round: 7, outcome: 'PASS', blocking: 0, warned: 0, phase: 'record' },
    null,
  ];
  assert.deepEqual(V.verifierRounds(events), { 1: { outcome: 'PASS', blocking: 0, warned: 2 }, 2: { outcome: 'PASS', blocking: 0, warned: 0 } });
  assert.deepEqual(V.verifierRounds([]), {});
  assert.deepEqual(V.verifierRounds(undefined), {});
  assert.equal(V.verifierTone({ outcome: 'CHANGES', blocking: 1, warned: 3 }), 'bad');
  assert.equal(V.verifierTone({ outcome: 'PASS', blocking: 0, warned: 3 }), 'warn');
  assert.equal(V.verifierTone({ outcome: 'PASS', blocking: 0, warned: 0 }), 'ok');
});

test('analytics: stats query, usage bars and top jobs', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  assert.equal(V.statsQuery('all', now), '');
  assert.equal(V.statsQuery('7', now), `?since=${encodeURIComponent('2026-10-05T00:00:00.000Z')}`);
  assert.equal(V.statsQuery('30', now), `?since=${encodeURIComponent('2026-09-12T00:00:00.000Z')}`);
  assert.deepEqual(V.usageBars({ a: { tokens: 10 }, b: { tokens: 30 }, c: { tokens: 0 } }).map((r) => [r.key, r.width]), [['b', 100], ['a', (10 / 30) * 100], ['c', 2]]);
  assert.deepEqual(V.usageBars({}), []);
  const jobs: any = [{ id: 'x', kind: 'feature', usage: { totalTokens: 5 } }, { id: 'y', kind: 'eval', usage: { totalTokens: 50 } }, { id: 'z', kind: 'bug', usage: { totalTokens: 9 } }, { id: 'w', kind: 'bug', usage: { totalTokens: 0 } }];
  assert.deepEqual(V.topJobsByUsage(jobs).map((j) => j.id), ['z', 'x']);
  assert.equal(V.jobMs({ createdAt: '2026-10-12T00:00:00Z', finishedAt: '2026-10-12T00:01:00Z' }), 60000);
  assert.equal(V.jobMs({ createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' }), null, 'zero is null, as main had it');
  assert.equal(V.jobMs({}), null);
});

test('thread items', () => {
  const r = (id: string, from: string, status: string, extra: Record<string, unknown> = {}): any => ({ id, type: 'answer', job: 'j1', text: `t ${id}`, args: {}, from, status, createdAt: `2026-10-13T00:00:0${id[0]}Z`, ...extra });
  const items = threadItems([
    r('3-c', 'daemon:j1', 'done', { type: 'resume', text: null, result: 'continued from build' }),
    r('1-a', 'dashboard', 'pending'),
    r('2-b', 'cli', 'in-progress', { result: '' }),
    r('4-d', 'someone-else', 'rejected', { result: 'not a human' }),
  ]);
  assert.deepEqual(items.map((i) => i.id), ['1-a', '2-b', '3-c', '4-d'], 'oldest first');
  assert.deepEqual(items.map((i) => i.from), ['you', 'cli', 'forge', 'cli']);
  assert.deepEqual(items.map((i) => i.status), ['queued', 'handling', 'done', 'rejected']);
  assert.deepEqual(items.map((i) => i.result), [null, null, 'continued from build', 'not a human']);
  assert.deepEqual(items.map((i) => i.text), ['t 1-a', 't 2-b', null, 't 4-d']);
  assert.deepEqual(items.map((i) => i.action), [{ kind: 'verb', verb: 'answer' }, { kind: 'verb', verb: 'answer' }, { kind: 'resumed' }, { kind: 'verb', verb: 'answer' }], 'friendly actions, never the raw type');
  assert.equal(items[0].at, '2026-10-13T00:00:01Z');
  assert.deepEqual(threadItems([]), []);
  assert.deepEqual(threadItems(undefined), []);
  // A job from the command bar: its request opens the thread as yours, then "Start this job", not "resume".
  const created = threadItems([r('5-e', 'dashboard', 'pending', { type: 'resume', text: null, args: { intake: 'new' } })], { text: 'Add a reading-time badge', at: '2026-10-13T00:00:00Z', tracker: false });
  assert.deepEqual(
    created.map((i) => [i.id, i.from, i.action, i.text, i.status]),
    [
      ['request', 'you', { kind: 'request' }, 'Add a reading-time badge', null],
      ['5-e', 'you', { kind: 'started' }, null, 'queued'],
    ],
  );
  assert.deepEqual(threadItems([], { text: 'Imported body', at: null, tracker: true })[0].from, 'tracker');
  // Typed in the bar, then linked or --create'd at the issue-link gate: it has issues, but the words are still yours.
  const linkedLater = { job: { createdAt: '2026-10-13T00:00:00Z', issues: [{ tracker: 'github', ref: '42', url: null }] }, request: 'Add a reading-time badge', requestFromTracker: false };
  assert.deepEqual(
    threadItems([], threadOpening(linkedLater)).map((i) => [i.from, i.action, i.text, i.at]),
    [['you', { kind: 'request' }, 'Add a reading-time badge', '2026-10-13T00:00:00Z']],
  );
  assert.equal(threadItems([], threadOpening({ ...linkedLater, request: 'Issue body', requestFromTracker: true }))[0].from, 'tracker', 'from-ref: the issue\'s text');
  assert.equal(threadOpening({ job: { createdAt: null }, request: null } as any).tracker, false, 'an older server without the flag');
  assert.deepEqual(threadItems([], { text: null, at: null, tracker: false }), [], 'no request text, no opening message');
  // Every answer to the issue-link gate reads differently, and next says how many.
  const a = (type: string, args: Record<string, unknown>, from = 'dashboard') => threadAction({ type, args, from } as any);
  assert.deepEqual(a('approve', { link: '42' }), { kind: 'link', ref: '42' });
  assert.deepEqual(a('approve', { link: '#42' }), { kind: 'link', ref: '42' });
  assert.deepEqual(a('approve', { link: 'new' }), { kind: 'link-new' });
  assert.deepEqual(a('approve', { link: 'none' }), { kind: 'link-none' });
  assert.deepEqual(a('approve', {}), { kind: 'verb', verb: 'approve' });
  assert.deepEqual(a('next', { n: 3 }), { kind: 'next', n: 3 });
  assert.deepEqual(a('next', {}), { kind: 'next', n: 1 });
  assert.deepEqual(a('run', { ref: '12' }), { kind: 'run', ref: '12' });
  assert.deepEqual(a('resume', { intake: 'run' }, 'daemon:_inbox'), { kind: 'handoff' });
  assert.deepEqual(a('revise-spec', {}), { kind: 'verb', verb: 'revise' });
  assert.deepEqual(a('eval-run', {}), { kind: 'verb', verb: 'eval' });
  const hostile = threadItems([r('1-x', 'dashboard', 'done', { text: '<script>alert(1)</script>', result: '<img src=x onerror=alert(1)>' })])[0];
  assert.equal(hostile.text, '<script>alert(1)</script>', 'kept as text: Svelte escapes it');
});

test('thread secret notes', () => {
  const fp = `sha256:${'ab12'.repeat(16)}`;
  const finding = (extra: Record<string, unknown> = {}) => ({ kind: 'aws-access-key', path: 'cfg/app.cfg', line: 3, excerpt: 'AKIA…XY', fingerprint: fp, ...extra });
  const ev = (ts: string, data: Record<string, unknown>): any => ({ v: 1, ts, type: 'secret-found', ...data });
  const events = [
    { v: 1, ts: '2026-10-13T00:00:01Z', type: 'verify', ok: false },
    ev('2026-10-13T00:00:02Z', {
      gate: 'verify',
      blocked: true,
      count: 5,
      allowed: 0,
      more: 0,
      findings: [
        finding(),
        finding({ kind: 'Not A Kind' }),
        finding({ path: 7 }),
        finding({ excerpt: 'x'.repeat(25) }),
        finding({ kind: 'high-entropy', path: 'p'.repeat(600), line: -1, excerpt: '<script>', fingerprint: 'sha256:nothex' }),
      ],
    }),
    ev('2026-10-13T00:00:04Z', { gate: 'telepathy', blocked: false, count: 14, more: 4, findings: Array.from({ length: 14 }, (_, i) => finding({ line: i + 1 })) }),
    ev('2026-10-13T00:00:03Z', { gate: 'agent-end', role: 'builder', blocked: false, count: 1, findings: 'nope' }),
    ev('2026-10-13T00:00:05Z', { gate: 'pr', role: 'Not a role!', blocked: 'yes', count: -2, findings: [] }),
  ];
  const notes = secretItems(events as any);
  assert.deepEqual(notes.map((n) => [n.id, n.from, n.action, n.text, n.status]), [
    ['secret:2026-10-13T00:00:02Z:1', 'forge', { kind: 'secret' }, null, null],
    ['secret:2026-10-13T00:00:03Z:3', 'forge', { kind: 'secret' }, null, null],
    ['secret:2026-10-13T00:00:04Z:2', 'forge', { kind: 'secret' }, null, null],
    ['secret:2026-10-13T00:00:05Z:4', 'forge', { kind: 'secret' }, null, null],
  ]);
  const [verify, agent, other, pr] = notes.map((n) => n.secret!);
  assert.deepEqual([verify.gate, verify.blocked, verify.count, verify.more], ['verify', true, 5, 0]);
  assert.equal(verify.findings.length, 2, 'a bad kind, a non-string path and an over-long excerpt are dropped');
  assert.deepEqual(verify.findings[0], { kind: 'aws-access-key', path: 'cfg/app.cfg', line: 3, excerpt: 'AKIA…XY', fingerprint: fp });
  const odd = verify.findings[1];
  assert.equal(odd.path.length, 500);
  assert.ok(odd.path.endsWith('…'));
  assert.equal(odd.line, null);
  assert.equal(odd.fingerprint, null);
  assert.equal(odd.excerpt, '<script>', 'kept as a plain string: Svelte escapes it');
  assert.deepEqual([agent.gate, agent.role, agent.blocked, agent.count, agent.findings], ['agent-end', 'builder', false, 1, []], 'no valid findings: caption and count only');
  assert.deepEqual([other.gate, other.findings.length, other.more, other.count], ['other', 10, 4, 14]);
  assert.deepEqual([pr.gate, pr.role, pr.blocked, pr.count], ['pr', null, false, 0]);
  assert.equal(secretLine(verify.findings[0]), `aws-access-key · cfg/app.cfg:3 · AKIA…XY · sha256:${'ab12'.repeat(3)}`);
  assert.equal(secretLine({ kind: 'k', path: 'p', line: null, excerpt: '…', fingerprint: null }), 'k · p · …');
  // A scan that could not finish: the error is kept as plain text, control characters as single spaces, capped; anything else is null.
  assert.deepEqual(notes.map((n) => n.secret!.error), [null, null, null, null]);
  const errs = secretItems([
    ev('2026-10-13T00:00:06Z', { gate: 'pr', blocked: true, count: 0, findings: [], error: 'base x\u0007 not\nfound\u2028' }),
    ev('2026-10-13T00:00:07Z', { gate: 'pr', blocked: true, count: 0, findings: [], error: 'e'.repeat(400) }),
    ev('2026-10-13T00:00:08Z', { gate: 'pr', blocked: true, count: 0, findings: [], error: { message: 'x' } }),
    ev('2026-10-13T00:00:09Z', { gate: 'pr', blocked: true, count: 0, findings: [], error: 42 }),
    ev('2026-10-13T00:00:10Z', { gate: 'pr', blocked: true, count: 0, findings: [], error: '\u0000\u001f' }),
    ev('2026-10-13T00:00:11Z', { gate: 'pr', blocked: true, count: 0, findings: [], error: 'fatal: x\r\nhint: y\n' }),
  ]).map((n) => n.secret!.error);
  assert.deepEqual(errs, ['base x not found', 'e'.repeat(300), null, null, null, 'fatal: x hint: y']);

  // Merged with the requests by time; a request comes first on a tie.
  const req = (id: string, createdAt: string): any => ({ id, type: 'answer', job: 'j1', text: 'x', args: {}, from: 'dashboard', status: 'done', createdAt });
  const merged = threadItems([req('1-a', '2026-10-13T00:00:02Z'), req('2-b', '2026-10-13T00:00:06Z')], { text: 'Opening', at: '2026-10-13T00:00:00Z', tracker: false }, events as any);
  assert.deepEqual(merged.map((m) => m.id), ['request', '1-a', 'secret:2026-10-13T00:00:02Z:1', 'secret:2026-10-13T00:00:03Z:3', 'secret:2026-10-13T00:00:04Z:2', 'secret:2026-10-13T00:00:05Z:4', '2-b']);
  assert.deepEqual(threadItems([req('1-a', '2026-10-13T00:00:02Z')], null), threadItems([req('1-a', '2026-10-13T00:00:02Z')], null, []), 'no events: the Thread as before');
  assert.ok(merged.filter((m) => !m.secret).every((m) => m.secret === null));
  // Each note is one mark, so a new one counts once toward the unread chip.
  assert.equal(threadMarks(merged).length, merged.length);
  assert.equal(new Set(threadMarks(merged)).size, merged.length);
});

test('issue-link candidates and actions', () => {
  const good = { ref: '12', title: 'Reading time badge', url: 'https://github.com/o/r/issues/12', labels: [], score: 6 };
  const json = JSON.stringify({
    query: 'reading time',
    tracker: 'github',
    items: [
      good,
      { ref: '../etc', title: 'bad ref', url: null },
      { ref: 13, title: 'numeric ref', url: null },
      { ref: '14', title: 'x'.repeat(201), url: null },
      { ref: '15', title: 7, url: null },
      { ref: '16', title: 'bad url', url: 5 },
      null,
      'junk',
      { ref: 'local-ref', title: '<img src=x onerror=alert(1)>' },
      { ref: '17', title: 'a', url: null },
      { ref: '18', title: 'b', url: null },
      { ref: '19', title: 'c', url: null },
      { ref: '20', title: 'd', url: null },
    ],
  });
  const c = parseCandidates(json);
  assert.deepEqual(c.map((x) => x.ref), ['12', 'local-ref', '17', '18', '19'], 'malformed dropped, at most 5');
  assert.deepEqual(c[0], { ref: '12', title: 'Reading time badge', url: 'https://github.com/o/r/issues/12' });
  assert.deepEqual(c[1], { ref: 'local-ref', title: '<img src=x onerror=alert(1)>', url: null });
  assert.equal(parseCandidates(JSON.stringify({ items: [{ ref: 'a', title: 'x'.repeat(200) }] })).length, 1, '200 characters is fine');
  for (const bad of ['', 'not json', 'null', '[]', '{"items": "no"}', '{"items": {}}']) assert.deepEqual(parseCandidates(bad), [], bad);
  assert.equal(cleanRef('#12'), '12');
  assert.equal(cleanRef(' reading-list '), 'reading-list');
  assert.equal(cleanRef('o/r#12'), 'o/r#12', 'a qualified ref keeps its #');
  assert.equal(cleanRef('a/../b#1'), null);
  assert.equal(cleanRef('../x'), null);
  assert.equal(cleanRef(''), null);

  const k = V.inboxKind({ state: 'waiting', waitingOn: 'issue-link' } as any);
  assert.equal(V.inboxDoc(k, { round: 0 } as any), 'issue-candidates.md');
  assert.equal(V.showsNote(k), true);
  assert.equal(V.notePlaceholder(k), 'Optional: why this job needs no issue…');
  assert.deepEqual(V.inboxActions(k), [{ label: 'Cancel job', type: 'cancel', primary: false, needsNote: false }], 'the link buttons come from IssueLinkActions');
  assert.equal(WAIT_LABEL['issue-link'], 'Issue to link');
  assert.equal(V.stateText({ state: 'waiting', waitingOn: 'issue-link' }), 'Issue to link');
  assert.equal(V.needsHuman({ state: 'waiting', waitingOn: 'issue-link' }), true);
  const link = (to: string, note: string | null = null) => (V.buildRequest({ type: 'approve', job: 'j1', note, args: { link: to } }) as any).body;
  assert.deepEqual(link('12'), { type: 'approve', job: 'j1', text: null, args: { link: '12' } });
  assert.deepEqual(link('none', 'tiny fix'), { type: 'approve', job: 'j1', text: 'tiny fix', args: { link: 'none' } });
  assert.deepEqual(link('new'), { type: 'approve', job: 'j1', text: null, args: { link: 'new' } });
});

test('spec-approval on an unlinked job: the chooser replaces Approve', () => {
  const gate = { state: 'waiting', waitingOn: 'spec-approval', reason: 'spec ready, issue unlinked', issues: [] as any[], noIssue: null } as const;
  assert.equal(V.UNLINKED_SPEC_REASON, 'spec ready, issue unlinked');
  assert.equal(V.specLinkPending(gate), true);
  assert.equal(V.specLinkPending({ ...gate, issues: undefined, noIssue: undefined }), true, 'fields missing from a hand-edited job.json');
  for (const [why, j] of [
    ['linked while it waits', { ...gate, issues: [{ tracker: 'local', ref: 'x', url: null }] }],
    ['no issue needed', { ...gate, noIssue: { reason: null, at: 'now' } }],
    ['the plain reason', { ...gate, reason: 'spec ready' }],
    ['no reason', { ...gate, reason: null }],
    ['another gate', { ...gate, waitingOn: 'issue-link' }],
    ['running again', { ...gate, state: 'running' }],
  ] as const)
    assert.equal(V.specLinkPending(j as any), false, why);

  assert.deepEqual(V.inboxActions('spec-approval', { linkPending: true }), [{ label: 'Request changes', type: 'revise-spec', primary: false, needsNote: true }]);
  assert.deepEqual(V.inboxActions('spec-approval'), INBOX['spec-approval'].actions, 'a linked spec card is unchanged');
  assert.deepEqual(V.inboxActions('spec-approval', { linkPending: false }), INBOX['spec-approval'].actions);
  assert.equal(V.notePlaceholder('spec-approval', { linkPending: true }), 'Optional note for the agents, or why no issue is needed…');
  assert.equal(V.notePlaceholder('spec-approval'), INBOX['spec-approval'].note);
  // linkPending only changes the spec gate.
  for (const kind of Object.keys(INBOX)) if (kind !== 'spec-approval') {
    assert.deepEqual(V.inboxActions(kind as any, { linkPending: true }), INBOX[kind].actions, kind);
    assert.equal(V.notePlaceholder(kind as any, { linkPending: true }), V.notePlaceholder(kind as any), kind);
  }
});

test('resumeModel', () => {
  const os = (status: string, agentRunning = false): any => ({ status, session: 's1', since: null, heartbeat: null, agentRunning, reason: status === 'dead' ? 'not-running' : null });
  const m = (state: string, ownerStatus: any, kind = 'feature') => V.resumeModel({ state, kind, ownerStatus } as any);
  const show = (enabled: boolean, note: string | null) => ({ show: true, enabled, note });
  const hidden = { show: false, enabled: false, note: null };
  assert.deepEqual(m('queued', os('none')), show(true, null), 'queued, no owner');
  assert.deepEqual(m('queued', os('live')), show(false, 'live'), 'queued, live owner');
  assert.deepEqual(m('failed', os('live', true)), show(false, 'agent'), 'failed, live owner with an agent');
  assert.deepEqual(m('running', os('stale')), show(true, 'stale'), 'running, stale owner');
  assert.deepEqual(m('blocked', os('dead')), show(true, 'gone'), 'blocked, dead owner');
  assert.deepEqual(m('running', os('live')), hidden, 'running, live owner');
  assert.deepEqual(m('running', os('none')), hidden, 'running, no owner');
  assert.deepEqual(m('waiting', os('stale')), hidden, 'waiting keeps its gate buttons');
  assert.deepEqual(m('done', os('none')), hidden);
  assert.deepEqual(m('cancelled', os('stale')), hidden);
  assert.deepEqual(m('queued', os('none'), 'eval'), hidden, 'eval jobs');
  assert.deepEqual(m('queued', undefined), show(true, null), 'a missing ownerStatus counts as none');
  assert.deepEqual(m('failed', null), show(true, null));
  assert.deepEqual(m('queued', { ...os('live'), jobSession: true }), show(true, null), "the job's own daemon session takes the resume");
  assert.deepEqual(m('running', { ...os('live'), jobSession: true }), hidden, 'running with a live owner stays hidden');
});

// Modelled on this repo's .forge snapshot: five dependency parks, two real human gates, one running build, one spec
// in progress, one done and one cancelled job.
const SNAPSHOT: any = [
  ['67-drafting-restyle-5-5-appearance', 'build', 'running', null, null, '67', '2026-10-14T19:38:26Z'],
  ['alive-dashboard-live-session-indicators-q3ik', 'backlog', 'waiting', 'external', 'dependencies not done: job-drawer-action-dock-decisions-0s08 (backlog/waiting)', null, '2026-10-14T18:00:00Z'],
  ['job-drawer-action-dock-decisions-0s08', 'backlog', 'waiting', 'issue-link', 'link an issue', null, '2026-10-14T12:00:00Z'],
  ['markdown-everywhere-in-the-dashboard-2l9s', 'backlog', 'waiting', 'external', 'dependencies not done: job-drawer-action-dock-decisions-0s08 (backlog/waiting)', null, '2026-10-14T17:00:00Z'],
  ['pipeline-board-four-grouped-columns-77fc', 'spec', 'running', null, null, '89', '2026-10-14T20:13:15Z'],
  ['restyle-the-dashboard-in-the-79e6', 'plan', 'waiting', 'external', 'split into 5 jobs', '62', '2026-10-14T03:32:19Z'],
  ['surface-hierarchy-opaque-sheets-and-xki2', 'backlog', 'waiting', 'external', 'dependencies not done: 67-drafting-restyle-5-5-appearance (build/running)', null, '2026-10-14T19:00:00Z'],
  ['three-themes-whiter-vellum-true-rwun', 'backlog', 'waiting', 'external', 'dependencies not done: surface-hierarchy-opaque-sheets-and-xki2 (backlog/waiting)', null, '2026-10-14T16:00:00Z'],
  ['universal-command-palette-triggers-out-s3yj', 'backlog', 'waiting', 'external', 'dependencies not done: 67-drafting-restyle-5-5-appearance (build/running)', null, '2026-10-14T19:00:00Z'],
  ['66-drafting-restyle-4-5-job', 'done', 'done', null, null, '66', '2026-10-14T10:00:00Z'],
  ['23-split-lib-cli-mjs-into', 'plan', 'cancelled', null, null, '23', '2026-10-12T10:00:00Z'],
].map(([id, stage, state, waitingOn, reason, ref, updatedAt]) => ({ id, kind: 'feature', stage, state, waitingOn, reason, issues: ref ? [{ tracker: 'github', ref, url: null }] : [], updatedAt }));

const PARKS = ['alive-dashboard-live-session-indicators-q3ik', 'markdown-everywhere-in-the-dashboard-2l9s', 'surface-hierarchy-opaque-sheets-and-xki2', 'three-themes-whiter-vellum-true-rwun', 'universal-command-palette-triggers-out-s3yj'];

test('board: groups, columns and the snapshot fixture', () => {
  assert.deepEqual(V.BOARD_GROUPS.flatMap((g) => [...g.stages]), [...STAGES], 'every stage in exactly one group, in pipeline order');
  assert.deepEqual(V.STEPPER_STAGES, STAGES.slice(1, -1));
  const empty = V.boardColumns([]);
  assert.deepEqual(empty.map((c) => c.id), ['queued', 'plan', 'build', 'ship']);
  assert.ok(empty.every((c) => c.jobs.length === 0));

  const ids = (cols: { id: string; jobs: { id?: string }[] }[]) => Object.fromEntries(cols.map((c) => [c.id, c.jobs.map((j) => j.id)]));
  const active = {
    queued: ['job-drawer-action-dock-decisions-0s08', 'surface-hierarchy-opaque-sheets-and-xki2', 'universal-command-palette-triggers-out-s3yj', 'alive-dashboard-live-session-indicators-q3ik', 'markdown-everywhere-in-the-dashboard-2l9s', 'three-themes-whiter-vellum-true-rwun'],
    plan: ['restyle-the-dashboard-in-the-79e6', 'pipeline-board-four-grouped-columns-77fc'],
    build: ['67-drafting-restyle-5-5-appearance'],
    ship: [],
  };
  const cols = V.boardColumns(V.filterJobs(SNAPSHOT, 'active'));
  assert.deepEqual(cols.map((c) => c.id), ['queued', 'plan', 'build', 'ship'], 'no Done column under the Active filter');
  assert.deepEqual(ids(cols), active);
  const all = V.boardColumns(SNAPSHOT);
  assert.deepEqual(all.map((c) => c.id), ['queued', 'plan', 'build', 'ship', 'done']);
  assert.deepEqual(ids(all), { ...active, done: ['66-drafting-restyle-4-5-job', '23-split-lib-cli-mjs-into'] });
  assert.equal(SNAPSHOT.length, 11, 'boardColumns does not mutate or drop its input');

  assert.equal(V.boardGroup({ stage: 'plan', state: 'cancelled' }), 'done');
  assert.equal(V.boardGroup({ stage: 'pr', state: 'done' }), 'done', 'a finished job left in an earlier stage');
  assert.equal(V.boardGroup({ stage: 'done', state: 'running' }), 'done');
  assert.equal(V.boardGroup({ stage: 'mystery', state: 'queued' } as any), 'queued', 'an unknown stage is never invisible');
  assert.equal(V.boardGroup({ state: 'queued' }), 'queued');
  for (const g of V.BOARD_GROUPS.slice(0, 4)) for (const stage of g.stages) assert.equal(V.boardGroup({ stage, state: 'running' }), g.id, stage);
});

test('stageSteps: one row per stage plus needs-you, failed, blocked, cancelled and unknown', () => {
  const render = (j: any) => {
    const chars = V.stageSteps(j).map((x) => (x.status === 'past' ? 'p' : x.status === 'future' ? 'f' : x.tone === 'ember' ? 'R' : 'I'));
    return [0, 3, 6].map((i) => chars.slice(i, i + 3).join('')).join(' ');
  };
  const rows: [any, string][] = [
    [{ stage: 'backlog', state: 'queued' }, 'fff fff fff'],
    [{ stage: 'plan', state: 'running' }, 'Iff fff fff'],
    [{ stage: 'spec', state: 'running' }, 'pIf fff fff'],
    [{ stage: 'design', state: 'running' }, 'ppI fff fff'],
    [{ stage: 'build', state: 'running' }, 'ppp Iff fff'],
    [{ stage: 'verify', state: 'running' }, 'ppp pIf fff'],
    [{ stage: 'review', state: 'running' }, 'ppp ppI fff'],
    [{ stage: 'integrate', state: 'running' }, 'ppp ppp Iff'],
    [{ stage: 'decide', state: 'running' }, 'ppp ppp pIf'],
    [{ stage: 'pr', state: 'running' }, 'ppp ppp ppI'],
    [{ stage: 'done', state: 'done' }, 'ppp ppp ppp'],
    [{ stage: 'spec', state: 'waiting', waitingOn: 'spec-approval' }, 'pRf fff fff'],
    [{ stage: 'build', state: 'failed' }, 'ppp Rff fff'],
    [{ stage: 'verify', state: 'blocked' }, 'ppp pRf fff'],
    [{ stage: 'plan', state: 'cancelled' }, 'Iff fff fff'],
    [{ stage: 'mystery', state: 'queued' }, 'fff fff fff'],
    [{ stage: 'pr', state: 'waiting', waitingOn: 'pr-review' }, 'ppp ppp ppI'],
  ];
  for (const [j, want] of rows) assert.equal(render(j), want, `${j.stage}/${j.state}${j.waitingOn ? ` ${j.waitingOn}` : ''}`);
  assert.equal(render({ stage: 'build', state: 'waiting', waitingOn: 'external', reason: 'dependencies not done: x' }), 'ppp Iff fff', 'a dependency park is not red');
  for (const [j] of rows) {
    const steps = V.stageSteps(j);
    assert.equal(steps.length, 9);
    assert.deepEqual(steps.map((x) => x.stage), V.STEPPER_STAGES);
    assert.ok(steps.every((x) => x.status === 'current' || x.tone === 'gleam'), 'only the current step can be ember');
  }
  const pos = (j: any) => V.stepPosition(V.stageSteps(j));
  assert.equal(pos({ stage: 'backlog', state: 'queued' }), 0);
  assert.equal(pos({ stage: 'mystery', state: 'queued' }), 0);
  assert.equal(pos({ stage: 'done', state: 'done' }), 9);
  V.STEPPER_STAGES.forEach((stage, i) => assert.equal(pos({ stage, state: 'running' }), i + 1, stage));
});

test('dependency parks are not human gates', () => {
  assert.equal(V.DEP_PARK_PREFIX, DEP_REASON, 'the dashboard reads the reason the engine writes');
  const park: any = { state: 'waiting', waitingOn: 'external', reason: `${DEP_REASON}a (build/running)` };
  assert.equal(V.isDependencyPark(park), true);
  assert.equal(V.needsHuman(park), false);
  assert.equal(V.stateTone(park), 'muted');
  assert.equal(V.stateText(park), 'Dependencies');
  assert.equal(V.stateText(park), PARK_LABEL);
  for (const other of [
    { state: 'waiting', waitingOn: 'external', reason: 'waiting on the vendor' },
    { state: 'waiting', waitingOn: 'external', reason: null },
    { state: 'waiting', waitingOn: 'external' },
    { state: 'waiting', waitingOn: 'input', reason: `${DEP_REASON}a (build/running)` },
  ] as any[]) {
    assert.equal(V.isDependencyPark(other), false, JSON.stringify(other));
    assert.equal(V.stateTone(other), 'you', JSON.stringify(other));
    assert.equal(V.needsHuman(other), true, JSON.stringify(other));
  }
  assert.equal(V.isDependencyPark({ state: 'queued', waitingOn: 'external', reason: `${DEP_REASON}a` } as any), false, 'only a waiting job is parked');
  assert.equal(V.stateText({ state: 'waiting', waitingOn: 'external', reason: 'x' }), 'External dependency');

  assert.deepEqual(V.navCounts(SNAPSHOT), { active: 9, needs: 2 });
  const g = V.inboxGroups(SNAPSHOT);
  assert.deepEqual(g.urgent.map((j) => j.id), ['job-drawer-action-dock-decisions-0s08', 'restyle-the-dashboard-in-the-79e6']);
  assert.deepEqual(g.prs, []);
  assert.deepEqual(g.parks.map((j) => j.id), PARKS, 'five parks, in input order');
  assert.equal(V.boardRank(park), 3, 'a park sorts with the queued jobs');
});

test('boardRank and sortByRank: rank, then newest, then id', () => {
  const R = (j: any) => V.boardRank(j);
  assert.equal(R({ state: 'waiting', waitingOn: 'input' }), 0);
  assert.equal(R({ state: 'failed' }), 0);
  assert.equal(R({ state: 'blocked' }), 0);
  assert.equal(R({ state: 'running' }), 1);
  assert.equal(R({ state: 'waiting', waitingOn: 'pr-review' }), 2);
  assert.equal(R({ state: 'queued' }), 3);
  assert.equal(R({ state: 'waiting', waitingOn: 'external', reason: `${DEP_REASON}x` }), 3);
  assert.equal(R({ state: 'mystery' }), 3, 'an unknown state');
  assert.equal(R({ state: 'done' }), 4);
  assert.equal(R({ state: 'cancelled' }), 4);

  const jobs: any = [
    { id: 'done', state: 'done', updatedAt: '2026-10-14T23:00:00Z' },
    { id: 'q-none', state: 'queued' },
    { id: 'q-bad', state: 'queued', updatedAt: 'not a date' },
    { id: 'q-old', state: 'queued', updatedAt: '2026-10-13T00:00:00Z' },
    { id: 'q-b', state: 'queued', updatedAt: '2026-10-14T00:00:00Z' },
    { id: 'q-a', state: 'queued', updatedAt: '2026-10-14T00:00:00Z' },
    { id: 'pr', state: 'waiting', waitingOn: 'pr-review', updatedAt: '2026-10-14T00:00:00Z' },
    { id: 'run', state: 'running', updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'fail', state: 'failed', updatedAt: '2026-10-01T00:00:00Z' },
  ];
  const before = jobs.map((j) => j.id);
  const sorted = V.sortByRank(jobs);
  assert.deepEqual(sorted.map((j) => j.id), ['fail', 'run', 'pr', 'q-a', 'q-b', 'q-old', 'q-bad', 'q-none', 'done'], 'equal rank and time fall back to id; a missing or invalid date sorts last');
  assert.deepEqual(jobs.map((j) => j.id), before, 'a new array; the input keeps its order');
  assert.notEqual(sorted, jobs);
});

test('cardModel: slots and null rules', () => {
  const bare = V.cardModel({ id: 'slug-ab12', stage: 'backlog', state: 'queued', issues: [{ tracker: 'local', ref: 'slug', url: null }], round: 0 } as any);
  assert.deepEqual(bare, { ref: 'slug-ab12', refTitle: 'slug-ab12', steps: V.stageSteps({ stage: 'backlog', state: 'queued' }), stage: 'Queued', round: null, progress: null, lenses: null, running: false, protected: null });
  assert.equal(V.cardModel({ id: 'x', reviewers: [], progress: { done: 0, total: 0 } } as any).lenses, null, 'no reviewers, no lenses');
  assert.equal(V.cardModel({ id: 'x', progress: { done: 0, total: 0 } } as any).progress, null, 'no tasks, no bar');

  const full = V.cardModel({
    id: '89-board', stage: 'verify', state: 'running', issues: [{ tracker: 'local', ref: '89', url: null }], round: 2, maxRounds: 3, progress: { done: 3, total: 5 },
    reviewers: ['code', 'ui'], verdicts: { 1: { code: 'CHANGES', ui: 'PASS' }, 2: { code: 'PASS' } },
  } as any);
  assert.equal(full.ref, '#89');
  assert.equal(full.refTitle, '89-board');
  assert.equal(full.stage, 'Verify');
  assert.deepEqual(full.round, { round: 2, max: 3 });
  assert.deepEqual(full.progress, { done: 3, total: 5 });
  assert.deepEqual(full.lenses, [{ name: 'code', verdict: 'PASS' }, { name: 'ui', verdict: null }], "this round's verdicts only");
  assert.equal(V.stepPosition(full.steps), 5);
  assert.equal(full.running, true, 'a running job lights its stepper');
  for (const state of ['queued', 'waiting', 'failed', 'done']) assert.equal(V.cardModel({ id: 'x', state } as any).running, false, state);

  assert.deepEqual(V.cardModel({ id: 'x', round: 1 } as any).round, { round: 1, max: null }, 'a missing maxRounds');
  assert.equal(V.cardModel({ id: 'x', stage: 'mystery' } as any).stage, 'mystery', 'an unknown stage shows raw');
  assert.equal(V.cardModel({ id: 'my-job', issues: [{ tracker: 'local', ref: 'ENG-4', url: null }] } as any).ref, 'ENG-4');
  const flag = { hits: [{ path: 'yarn.lock', rule: 4, glob: 'yarn.lock', reason: 'dependency lockfile', blob: null }], more: 0, at: 't', gate: 'commit', head: null };
  assert.deepEqual(V.cardModel({ id: 'x', protectedPaths: flag } as any).protected, { reasons: ['dependency lockfile'], rows: [{ path: 'yarn.lock', reason: 'dependency lockfile' }], more: 0 }, 'the Protected chip');
});

test('foreman event line and gate owner badge', () => {
  assert.equal(V.isForemanEvent({ type: 'human', action: 'approve-spec', actor: { login: null, source: 'foreman' } }), true);
  assert.equal(V.isForemanEvent({ type: 'human', action: 'approve-spec', actor: { login: 'alice', source: 'gh' } }), false);
  assert.equal(V.isForemanEvent({ type: 'human', action: 'approve-spec', actor: { login: null, source: 'unknown' } }), false, 'a v1 human event reads as unknown, not foreman');
  assert.equal(V.isForemanEvent({ type: 'human', action: 'approve-spec' }), false, 'an older event without actor is a human one');
  assert.equal(V.isForemanEvent({ type: 'note', actor: { login: null, source: 'foreman' } }), false);
  assert.equal(V.isForemanEvent(null), false);
  // The line itself is unchanged: the label is a chip beside it.
  assert.deepEqual(V.eventDetail({ v: 1, ts: 't', type: 'human', action: 'rework', note: 'fix it', actor: { login: null, source: 'foreman' } }, { tokens: tokensShort, dur }), { pre: '', bold: 'rework', post: ' · fix it' });
  assert.deepEqual(V.gateOwnerBadge('foreman'), { foreman: true, tone: 'live' });
  assert.deepEqual(V.gateOwnerBadge('human'), { foreman: false, tone: 'you' });
  for (const none of [null, undefined, 'robot', 1]) assert.equal(V.gateOwnerBadge(none), null, String(none));
});

test('secretPark: secret parks and still blocked after approve', () => {
  const approve = { ts: '2026-10-19T10:00:00Z', type: 'human', action: 'approve', actor: { login: 'alice', source: 'gh' } } as any;
  const park = (ts: string): any => ({ v: 1, ts, type: 'transition', from: { stage: 'pr', state: 'running', waitingOn: null }, to: { stage: 'pr', state: 'waiting', waitingOn: 'human' } });
  const job = (extra: Record<string, unknown> = {}): any => ({ state: 'waiting', waitingOn: 'human', reason: 'secret scan blocked pr open', lastHuman: null, lastEvent: null, ...extra });
  // Not secret parks.
  assert.equal(V.secretPark(job({ reason: 'protected path edited' })), null);
  assert.equal(V.secretPark(job({ waitingOn: 'escalation' })), null);
  assert.equal(V.secretPark(job({ state: 'running' })), null);
  assert.equal(V.secretPark(job({ reason: null })), null);
  assert.equal(V.SECRET_PARK_PREFIX, 'secret scan blocked ');
  // A fresh park, and an approve nothing has acted on yet.
  assert.deepEqual(V.secretPark(job({ reason: 'secret scan blocked verify round 2', lastEvent: park('2026-10-19T09:00:00Z') })), { stillBlocked: false });
  assert.deepEqual(V.secretPark(job({ lastHuman: approve, lastEvent: { v: 1, ts: approve.ts, type: 'human', action: 'approve' } })), { stillBlocked: false });
  assert.deepEqual(V.secretPark(job({ lastHuman: approve, lastEvent: null })), { stillBlocked: false });
  assert.deepEqual(V.secretPark(job({ lastHuman: approve, lastEvent: park('2026-10-19T09:59:59Z') })), { stillBlocked: false }, 'a park before the approve');
  // The approve ran the scan again and it parked once more.
  assert.deepEqual(V.secretPark(job({ lastHuman: approve, lastEvent: park('2026-10-19T10:00:05Z') })), { stillBlocked: true });
  // Only an approve counts, and only a park on human.
  assert.deepEqual(V.secretPark(job({ lastHuman: { ...approve, action: 'note' }, lastEvent: park('2026-10-19T10:00:05Z') })), { stillBlocked: false });
  const other = park('2026-10-19T10:00:05Z');
  other.to.waitingOn = 'escalation';
  assert.deepEqual(V.secretPark(job({ lastHuman: approve, lastEvent: other })), { stillBlocked: false });
});

test('actorLabel and lastActed', () => {
  const ev = (actor: any, type = 'human') => ({ v: 2, ts: 't', type, action: 'approve', actor });
  assert.deepEqual(V.actorLabel(ev({ login: 'alice', source: 'gh' })), { login: 'alice', source: 'gh' });
  assert.deepEqual(V.actorLabel(ev({ login: null, source: 'unknown' })), { login: 'unknown', source: 'unknown' }, 'a null login reads as unknown');
  assert.deepEqual(V.actorLabel(ev({ login: 'bob', source: 'env' }, 'budget-ack')), { login: 'bob', source: 'env' }, 'any event with an actor, not only human');
  assert.equal(V.actorLabel(ev({ login: null, source: 'foreman' })), null, 'the foreman keeps its chip and shows no login');
  assert.equal(V.actorLabel({ v: 2, ts: 't', type: 'agent-end' }), null);
  assert.equal(V.actorLabel(null), null);
  // Markup is returned as text; Svelte's {…} escapes it, and no {@html} renders an actor (dashboard-svelte.test.ts).
  assert.equal(V.actorLabel(ev({ login: '<img src=x onerror=alert(1)>', source: 'env' }))!.login, '<img src=x onerror=alert(1)>');

  assert.equal(V.lastActed({ lastHuman: null }), null);
  assert.equal(V.lastActed({}), null, 'an older server without lastHuman');
  assert.deepEqual(V.lastActed({ lastHuman: { ts: 't1', type: 'human', action: 'approve', actor: { login: 'alice', source: 'gh' } } }), { who: 'alice', foreman: false, ts: 't1' });
  assert.deepEqual(V.lastActed({ lastHuman: { ts: 't2', type: 'human', action: 'rework', actor: { login: null, source: 'foreman' } } }), { who: 'foreman', foreman: true, ts: 't2' });
  assert.deepEqual(V.lastActed({ lastHuman: { ts: 't3', type: 'budget-ack', action: null, actor: { login: null, source: 'unknown' } } }), { who: 'unknown', foreman: false, ts: 't3' });
});

test('the raw event line leaves the actor to its own label', () => {
  const e = { v: 2, ts: 't', type: 'budget-set', key: 'usd', value: 5, actor: { login: 'bob', source: 'env' } } as const;
  assert.equal(V.eventDetail(e, { tokens: tokensShort, dur }).pre, '{"key":"usd","value":5}');
});

test('issue labels and link state', () => {
  const gh = (ref: string | null) => ({ tracker: 'github', ref, url: null });
  assert.equal(V.cardRef({ id: '12-x', issues: [gh('12')] } as any), '#12');
  assert.equal(V.cardRef({ id: '12-x', issues: [gh('o/repo#12')] } as any), 'repo#12');
  assert.equal(V.cardRef({ id: '12-x', issues: [gh('o/repo#12'), gh('x/y#3')] } as any), 'repo#12 +1');
  assert.equal(V.cardRef({ id: '12-x', issues: [gh('o/repo#12'), gh(null)] } as any), 'repo#12', 'a ref-less issue is not counted');
  assert.equal(V.cardRef({ id: 'slug-ab12', issues: [{ tracker: 'local', ref: 'slug', url: null }] } as any), null, 'a local slug the id starts with');
  assert.equal(V.cardRef({ id: 'slug-ab12', issues: [{ tracker: 'local', ref: 'slug', url: null }, { tracker: 'local', ref: 'other', url: null }, { tracker: 'local', ref: 'third', url: null }] } as any), '+2', 'the count stays when the label is hidden');
  assert.equal(V.cardRef({ id: 'x', issues: [gh(null)] } as any), null);
  assert.equal(V.issueLabel('group/sub/project#7'), 'project#7');
  assert.equal(V.issueLabel('KEY-1'), 'KEY-1');
  assert.equal(V.issueLabel(null), null);
  assert.equal(V.hasLinkedIssue([]), false);
  assert.equal(V.hasLinkedIssue([{ ref: null }]), false);
  assert.equal(V.hasLinkedIssue(undefined), false);
  assert.equal(V.hasLinkedIssue([{ ref: null }, { ref: 'o/r#1' }]), true);
  const gate = { state: 'waiting', waitingOn: 'spec-approval', reason: 'spec ready, issue unlinked', noIssue: null } as const;
  assert.equal(V.specLinkPending({ ...gate, issues: [gh(null)] } as any), true, 'specLinkPending uses hasLinkedIssue');
  assert.equal(V.specLinkPending({ ...gate, issues: [gh('o/r#1')] } as any), false);
});
