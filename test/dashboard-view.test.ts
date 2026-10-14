// The view logic moved out of the pre-Svelte app.js (dashboard/src/lib/view.ts). Goldens were produced by running
// main's app.js code (inboxCard, the click handler's req/eval-run branches, compareTable, prChip, filteredJobs) and
// are pasted here as data, so any drift in actions, placeholders or POST bodies fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../dashboard/src/lib/view.ts';
import { WAIT_LABEL } from '../dashboard/src/lib/labels.ts';
import { cleanRef, parseCandidates, threadItems } from '../dashboard/src/lib/thread.ts';
import { dur, tokensShort } from '../dashboard/src/lib/util.ts';

// Per waiting kind: the card's buttons, its textarea placeholder (null: no textarea) and its "Read …" link.
const INBOX = {"spec-approval":{"actions":[{"label":"Approve spec","type":"approve","primary":true,"needsNote":false},{"label":"Request changes","type":"revise-spec","primary":false,"needsNote":true}],"note":"Optional note for the agents…","doc":"spec.md"},"split-approval":{"actions":[{"label":"Approve split","type":"approve","primary":true,"needsNote":false},{"label":"Keep as one job","type":"revise-spec","primary":false,"needsNote":false}],"note":"Optional note for the agents…","doc":"plan.md"},"input":{"actions":[{"label":"Send answer","type":"answer","primary":true,"needsNote":true}],"note":"Your answer…","doc":"questions.md"},"escalation":{"actions":[{"label":"Approve","type":"approve","primary":true,"needsNote":false},{"label":"Rework","type":"rework","primary":false,"needsNote":true},{"label":"Cancel job","type":"cancel","primary":false,"needsNote":false}],"note":"Optional note for the agents…","doc":"decision.md"},"rounds-exhausted":{"actions":[{"label":"Another round","type":"rework","primary":false,"needsNote":true},{"label":"Accept as is","type":"approve","primary":false,"needsNote":false},{"label":"Cancel job","type":"cancel","primary":false,"needsNote":false}],"note":"Optional note for the agents…","doc":"review/round-2"},"budget":{"actions":[{"label":"Approve & continue","type":"approve","primary":true,"needsNote":true},{"label":"Cancel job","type":"cancel","primary":false,"needsNote":false}],"note":"Optional: new limits, e.g. usd=20 tokens=2000000","doc":null},"infra":{"actions":[{"label":"Steps done, resume","type":"resume","primary":true,"needsNote":false}],"note":null,"doc":"runbook.md"},"conflicts":{"actions":[{"label":"Fix conflicts now","type":"rework","primary":true,"needsNote":false,"text":"Resolve merge conflicts with the base branch"},{"label":"Leave for later","type":"resume","primary":false,"needsNote":false}],"note":null,"doc":null},"external":{"actions":[{"label":"Unblocked, resume","type":"resume","primary":false,"needsNote":false}],"note":null,"doc":null},"failed":{"actions":[{"label":"Retry","type":"resume","primary":false,"needsNote":false},{"label":"Cancel job","type":"cancel","primary":false,"needsNote":false}],"note":null,"doc":null},"pr-review":{"actions":[{"label":"Resume","type":"resume","primary":false,"needsNote":false}],"note":null,"doc":null},"mystery":{"actions":[{"label":"Resume","type":"resume","primary":false,"needsNote":false}],"note":null,"doc":null}};
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
  const tones: any = [['done', null, 'ok'], ['failed', null, 'bad'], ['cancelled', null, 'muted'], ['waiting', 'pr-review', 'info'], ['waiting', 'input', 'warn'], ['blocked', null, 'bad'], ['running', null, 'accent'], ['queued', null, 'muted']];
  for (const [state, waitingOn, tone] of tones) assert.equal(V.stateTone({ state, waitingOn }), tone, `${state}/${waitingOn}`);
  assert.equal(V.stateText({ state: 'waiting', waitingOn: 'input' }), 'Question for you');
  assert.equal(V.stateText({ state: 'waiting', waitingOn: 'later' } as any), 'later', 'unknown wait reasons show raw');
  assert.equal(V.stateText({ state: 'running' }), 'running');
  assert.deepEqual(['PASS', 'CHANGES', 'MALFORMED', undefined].map(V.verdictTone), ['ok', 'bad', 'warn', 'muted']);
  // main's prChip, as [input, toneChip(tone, text)] with toneChip stubbed to `[tone:text]`.
  const prs: any = [
    [null, ''], [{}, ''], [{ number: 5, state: 'MERGED' }, '[ok:#5]'], [{ number: 5, state: 'CLOSED', conflicts: true }, '[muted:#5 · conflicts]'],
    [{ number: 5, state: 'OPEN', conflicts: true }, '[bad:#5 · conflicts]'], [{ number: 5, state: 'OPEN', checks: { state: 'failing' } }, '[bad:#5 · failing]'],
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
  assert.equal(V.cardRef({ id: '12-x', source: { ref: '12' } } as any), '#12');
  assert.equal(V.cardRef({ id: 'my-job', source: { ref: 'ENG-4' } } as any), 'ENG-4');
  assert.equal(V.cardRef({ id: 'slug', source: { ref: 'slug' } } as any), null);
  assert.equal(V.cardRef({ id: 'x', source: null }), null);
  assert.deepEqual(V.runningRoles({ agents: { builder: { status: 'running' }, reviewer: { status: 'done' } } } as any), ['builder']);
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
  assert.deepEqual(V.boardStages([]), ['backlog', 'spec', 'build', 'review', 'pr', 'done']);
  assert.deepEqual(V.boardStages(JOBS), ['backlog', 'plan', 'spec', 'build', 'verify', 'review', 'pr', 'done']);
  assert.deepEqual(V.navCounts(JOBS), { active: 7, needs: 2 }, 'pr-review waits are not "needs you"');
  assert.deepEqual(V.VIEWS.map((v) => v.id), ['pipeline', 'inbox', 'backlog', 'agents', 'analytics', 'evals']);
  const now = Date.parse('2026-10-12T12:00:00Z');
  const owned: any = [
    { owner: { session: 's1', heartbeat: '2026-10-12T11:45:00Z', since: '2026-10-12T10:00:00Z' } },
    { owner: { session: 's1', heartbeat: '2026-10-12T11:59:00Z' } },
    { owner: { session: 's2', heartbeat: null, since: '2026-10-12T11:50:00Z' } },
    { owner: { session: 's3', heartbeat: '2026-10-12T11:00:00Z' } },
    { owner: null },
  ];
  assert.equal(V.activeSessions(owned, now), 2);
  const sessions = V.agentSessions(owned.filter((j) => j.owner), now);
  assert.deepEqual(sessions.map((x) => [x.session, x.jobs.length, x.live]), [['s1', 2, true], ['s2', 1, true], ['s3', 1, false]]);
  assert.deepEqual(V.runningAgents([{ id: 'j', agents: { builder: { status: 'running', model: 'opus' }, x: { status: 'done' } } }] as any).map((a) => [a.job.id, a.role, a.model]), [['j', 'builder', 'opus']]);
});

test('inbox groups urgent jobs and PRs awaiting review', () => {
  const g = V.inboxGroups(JOBS);
  assert.deepEqual(g.urgent.map((j) => j.id), ['b', 'c', 'd']);
  assert.deepEqual(g.prs.map((j) => j.id), ['p']);
});

test('evals: compare rows keep the old table\'s values and tones', () => {
  const rows = V.compareRows({
    a: { configHash: 'h1', forgeVersion: '1' }, b: { configHash: 'h2', forgeVersion: '2' },
    delta: {
      tasks: { a: 2, b: 2, change: 0 }, checkPassRate: { a: 0.5, b: 0.75, change: 0.25 }, avgJudgeScore: { a: 0.9, b: 0.8, change: -0.1 }, firstPassRate: { a: null, b: 1, change: null },
      avgRounds: { a: 2, b: 1, change: -1 }, escalationRate: { a: 0, b: 0.5, change: 0.5 }, avgTokens: { a: 100, b: 100, change: 0 }, avgCostUsd: { a: 1, b: 2, change: 1 }, avgMinutes: { a: 10, b: 5, change: -5 },
    },
  } as any);
  // main's compareTable rendered these rows (metric, A, B, Δ and the Δ cell's tone class).
  assert.deepEqual(rows.map((r) => [r.key, r.a, r.b, r.change, r.tone]), [
    ['checkPassRate', '0.5', '0.75', '+0.25', 'text-ok'],
    ['avgJudgeScore', '0.9', '0.8', '-0.1', 'text-bad'],
    ['firstPassRate', '—', '1', '—', 'text-muted'],
    ['avgRounds', '2', '1', '-1', 'text-ok'],
    ['escalationRate', '0', '0.5', '+0.5', 'text-bad'],
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
  assert.equal(items[2].type, 'resume');
  assert.equal(items[0].at, '2026-10-13T00:00:01Z');
  assert.deepEqual(threadItems([]), []);
  assert.deepEqual(threadItems(undefined), []);
  const hostile = threadItems([r('1-x', 'dashboard', 'done', { text: '<script>alert(1)</script>', result: '<img src=x onerror=alert(1)>' })])[0];
  assert.equal(hostile.text, '<script>alert(1)</script>', 'kept as text: Svelte escapes it');
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
