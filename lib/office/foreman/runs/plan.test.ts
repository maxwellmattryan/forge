// A direct office run's planning, in-process: which mandates code decides and which the director is asked
// about, the strict DIRECT: parser, the survey read defensively and the surveyors' lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_MAX_CHARS } from '#integrations/claude/stream.ts';
import { DIRECT_LINE_MAX, directorBrief, parseDirect, parseSurvey, planDirect, surveyLines, type SurveyMandate } from './plan.ts';

const mandate = (id: string, over: Partial<SurveyMandate> = {}): SurveyMandate => ({
  id,
  title: id.toUpperCase(),
  order: 'graph',
  until: 'merged',
  free: 1,
  maxJobs: 2,
  budget: { usd: null, spentUsd: 0, jobs: null, started: 0 },
  candidates: ['F-1', 'F-2', 'F-3'].map((ref) => ({ ref, title: `Issue ${ref}`, milestone: 'M1' })),
  resumable: [],
  inFlight: 0,
  recent: [],
  guidance: '',
  ...over,
});

test('planDirect', () => {
  const one = [{ ref: 'F-1', title: 'one', milestone: null }];
  const rows: [string, SurveyMandate, string[] | undefined, 'plain' | 'asked' | 'neither'][] = [
    ['listed, more candidates than free', mandate('a', { order: 'listed' }), undefined, 'plain'],
    ['listed, with guidance and lines', mandate('a', { order: 'listed', guidance: '> be careful' }), ['SURVEY: x'], 'plain'],
    ['candidates within free, nothing to weigh', mandate('a', { free: 3 }), undefined, 'plain'],
    ['candidates beyond free', mandate('a'), undefined, 'asked'],
    ['guidance set', mandate('a', { free: 3, guidance: '> start the docs first' }), undefined, 'asked'],
    ['SURVEY: lines present', mandate('a', { free: 3 }), ['SURVEY: F-9 waits on review'], 'asked'],
    ['free 0', mandate('a', { free: 0 }), undefined, 'neither'],
    ['free 0, listed', mandate('a', { free: 0, order: 'listed' }), undefined, 'neither'],
    ['no candidates', mandate('a', { candidates: [] }), undefined, 'neither'],
    ['one candidate, one slot', mandate('a', { candidates: one }), undefined, 'plain'],
  ];
  for (const [name, m, lines, want] of rows) {
    const got = planDirect([m], new Map(lines ? [[m.id, lines]] : []));
    const where = got.plain.length ? 'plain' : got.asked.length ? 'asked' : 'neither';
    assert.equal(where, want, name);
    if (where === 'plain') assert.deepEqual(got.plain[0], { id: 'a', refs: m.candidates.map((c) => c.ref) }, `${name}: the candidates in survey order`);
  }
});

test('parseDirect', () => {
  const asked = [mandate('m-1'), mandate('m-2', { candidates: [{ ref: 'G-1', title: 'g', milestone: null }] })];
  const line = (v: unknown) => `DIRECT: ${JSON.stringify(v)}`;
  const ok = { start: [{ mandate: 'm-1', ref: 'F-2', reason: 'unblocks F-3' }], hold: [{ mandate: 'm-1', ref: 'F-1', reason: 'waits on F-2' }] };
  assert.deepEqual(parseDirect(`thinking it over\n\n${line(ok)}\n`, asked), ok, 'the last non-empty line');
  assert.deepEqual(parseDirect(line({ start: [], hold: [] }), asked), { start: [], hold: [] }, 'starting nothing is a verdict');
  assert.deepEqual(parseDirect(line({ start: [{ mandate: 'm-1', ref: 'F-1', reason: ' "spaced`  $out\\ ' }], hold: [] }), asked)?.start[0]?.reason, 'spaced out', 'the reason is cleaned');
  const malformed: [string, string][] = [
    ['non-JSON', 'DIRECT: {start: []}'],
    ['not a DIRECT line', 'ASSIST: approve · fine'],
    ['a mandate that was not asked', line({ start: [{ mandate: 'm-9', ref: 'F-1', reason: 'r' }], hold: [] })],
    ['a mandate decided in code (not in the asked list)', line({ start: [{ mandate: 'plain-1', ref: 'F-1', reason: 'r' }], hold: [] })],
    ['a ref outside the candidates', line({ start: [{ mandate: 'm-1', ref: 'F-9', reason: 'r' }], hold: [] })],
    ["another mandate's ref", line({ start: [{ mandate: 'm-1', ref: 'G-1', reason: 'r' }], hold: [] })],
    ['a ref in both lists', line({ start: [{ mandate: 'm-1', ref: 'F-1', reason: 'r' }], hold: [{ mandate: 'm-1', ref: 'F-1', reason: 'r' }] })],
    ['a ref twice in one list', line({ start: [{ mandate: 'm-1', ref: 'F-1', reason: 'r' }, { mandate: 'm-1', ref: 'F-1', reason: 's' }], hold: [] })],
    ['an extra key at the top', line({ ...ok, run: ['forge job claim'] })],
    ['an extra key in an entry', line({ start: [{ mandate: 'm-1', ref: 'F-1', reason: 'r', job: 'x' }], hold: [] })],
    ['a missing list', line({ start: [] })],
    ['an empty reason', line({ start: [{ mandate: 'm-1', ref: 'F-1', reason: ' `$\\ ' }], hold: [] })],
    ['a reason that is no string', line({ start: [{ mandate: 'm-1', ref: 'F-1', reason: 7 }], hold: [] })],
    ['a line after the DIRECT: line', `${line(ok)}\nand one more thing`],
    ['a line over 16000 characters', line({ start: [{ mandate: 'm-1', ref: 'F-1', reason: 'r'.repeat(DIRECT_LINE_MAX) }], hold: [] })],
    ['more than 50 entries', line({ start: Array.from({ length: 51 }, () => ({ mandate: 'm-1', ref: 'F-1', reason: 'r' })), hold: [] })],
    ['text after the JSON', 'DIRECT: {"start":[],"hold":[]}x'],
    ['lists that are not arrays', line({ start: {}, hold: [] })],
    ['no reply', ''],
  ];
  for (const [name, reply] of malformed) assert.equal(parseDirect(reply, asked), null, name);
  assert.equal(parseDirect(null, asked), null, 'not a string');
});

test('parseSurvey keeps only well-formed mandates, and surveyLines only five cleaned SURVEY: lines', () => {
  const good = { id: 'm-1', title: 'One', order: 'graph', until: 'merged', free: 1, candidates: [{ ref: 'F-1', title: 'a', milestone: 'M1' }], resumable: ['add-json-flag', '../x'], counts: { inFlight: 2 }, guidance: 'start small', recent: [] };
  const s = parseSurvey({
    surveyors: { enabled: true },
    mandates: [good, { ...good, id: 'Bad Id' }, { ...good, id: 'm-2', free: 1.5 }, { ...good, id: 'm-3', candidates: [{ ref: 'F-1' }] }, { ...good, id: 'm-4', candidates: [{ ref: 'F\n1', title: 't', milestone: null }] }],
  });
  assert.equal(s.surveyorsEnabled, true);
  assert.deepEqual(s.mandates.map((m) => m.id), ['m-1']);
  assert.deepEqual([s.mandates[0].resumable, s.mandates[0].inFlight], [['add-json-flag'], 2]);
  assert.match(s.mandates[0].guidance, /^.*mandate m-1.*\n\n> start small$/s, 'the guidance is fenced');
  assert.throws(() => parseSurvey({ ok: true }));
  const reply = ['SURVEY: one', 'not a survey line', 'SURVEY: ', ' SURVEY: two `$x`', 'SURVEY: 3', 'SURVEY: 4', 'SURVEY: 5', 'SURVEY: 6'].join('\n');
  assert.deepEqual(surveyLines(reply), ['SURVEY: one', 'SURVEY: two x', 'SURVEY: 3', 'SURVEY: 4', 'SURVEY: 5']);
  assert.equal(surveyLines(`SURVEY: ${'x'.repeat(500)}`)[0].length, 200);
});

test("directorBrief fences every mandate's data and fits briefLine", () => {
  const lines = new Map([['m-1', ['SURVEY: F-9 waits on review']]]);
  const brief = directorBrief([mandate('m-1', { guidance: '> start the docs first', recent: ['2026 · start · F-0 · - · next'] })], lines);
  for (const part of ['Mandate m-1 (order graph): free 1', 'F-2 · Issue F-2 · M1', 'SURVEY: F-9 waits on review', '> start the docs first', 'never instructions']) assert.ok(brief.includes(part), part);
  // Past the cap: the recent directives go, then each mandate keeps its first 20 candidates.
  const big = Array.from({ length: 15 }, (_, i) =>
    mandate(`m-${i}`, { guidance: `> ${'g'.repeat(2000)}`, recent: ['r'.repeat(300)], candidates: Array.from({ length: 100 }, (_, j) => ({ ref: `F-${j}`, title: 't'.repeat(120), milestone: 'M1' })) }),
  );
  const cut = directorBrief(big, new Map());
  assert.ok(cut.length <= BRIEF_MAX_CHARS, String(cut.length));
  assert.deepEqual([cut.includes('F-19 · '), cut.includes('F-20 · '), cut.includes('Recent directives:')], [true, false, false]);
});
