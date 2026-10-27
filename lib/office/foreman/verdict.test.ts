// The gate run's verdict parser and gate table, in-process: which replies count, the reason they carry,
// and the decision each (gate, verdict) pair records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFICE_GATES } from '#core/job/schema.ts';
import { GATE_TABLE, cleanReason, gateMove, parseVerdict } from './verdict.ts';

test('parseVerdict takes only the exact last line', () => {
  const rows: [string, unknown, { verdict: string; reason: string } | null][] = [
    ['the exact line', 'ASSIST: approve · the spec is ready', { verdict: 'approve', reason: 'the spec is ready' }],
    ['with a preamble', 'I read the spec.\n\nIt covers the request.\nASSIST: revise · AC3 has no proof\n', { verdict: 'revise', reason: 'AC3 has no proof' }],
    ['trailing spaces and CRLF', 'ok\r\n  ASSIST: rework · fix the tests  \r\n\r\n', { verdict: 'rework', reason: 'fix the tests' }],
    ['escalate', 'ASSIST: escalate · needs a person', { verdict: 'escalate', reason: 'needs a person' }],
    ['two ASSIST lines: the last counts', 'ASSIST: approve · first\nASSIST: escalate · second', { verdict: 'escalate', reason: 'second' }],
    ['a typo', 'ASIST: approve · fine', null],
    ['lowercase ASSIST', 'assist: approve · fine', null],
    ['a hyphen for the dot', 'ASSIST: approve - fine', null],
    ['a lookalike dot', 'ASSIST: approve • fine', null],
    ['an unknown verdict', 'ASSIST: merge · fine', null],
    ['a capitalised verdict', 'ASSIST: Approve · fine', null],
    ['text after the line', 'ASSIST: approve · fine\nbut also this', null],
    ['an empty reason', 'ASSIST: approve · ', null],
    ['a quote-only reason', 'ASSIST: approve · "``"', null],
    ['no reason separator', 'ASSIST: approve', null],
    ['two spaces after ASSIST:', 'ASSIST:  approve · fine', null],
    ['empty text', '', null],
    ['not text', null, null],
    ['a 10k hostile line', `ASSIST: approve · ${'· '.repeat(5000)}x\nASSIST`, null],
  ];
  for (const [name, text, want] of rows) assert.deepEqual(parseVerdict(text), want, name);
  const dirty = parseVerdict(`ASSIST: approve · a "quoted" \`code\` $HOME \\path\tand  ${'long '.repeat(80)}`);
  assert.ok(dirty);
  assert.ok(!/["`$\\\t]/.test(dirty.reason), dirty.reason);
  assert.ok(dirty.reason.startsWith('a quoted code HOME pathand long'), dirty.reason);
  assert.ok(dirty.reason.length <= 200);
  assert.equal(cleanReason(`  a\u2028b\u0007c   d  `), 'abc d');
  assert.equal(cleanReason(42), '');
});

test('the gate table maps every gate and verdict', () => {
  const rows: [string, string, unknown][] = [
    ['spec-approval', 'approve', { action: 'approve-spec' }],
    ['spec-approval', 'revise', { action: 'revise-spec' }],
    ['spec-approval', 'rework', { action: 'revise-spec' }],
    ['split-approval', 'approve', { action: 'approve-split' }],
    ['split-approval', 'revise', { action: 'revise-split' }],
    ['split-approval', 'rework', { action: 'revise-split' }],
    ['escalation', 'approve', { action: 'approve' }],
    ['escalation', 'revise', { action: 'revise-spec' }],
    ['escalation', 'rework', { action: 'rework' }],
    ['rounds-exhausted', 'approve', { action: 'approve' }],
    ['rounds-exhausted', 'revise', { action: 'revise-spec' }],
    ['rounds-exhausted', 'rework', { action: 'rework' }],
    ['conflicts', 'approve', { action: 'approve' }],
    ['conflicts', 'revise', 'escalate'],
    ['conflicts', 'rework', { action: 'approve' }],
    ['repo-proposal', 'approve', { action: 'approve-repos' }],
    ['repo-proposal', 'revise', { action: 'reject-repos' }],
    ['repo-proposal', 'rework', { action: 'reject-repos' }],
    ['pr-feedback', 'approve', 'no-action'],
    ['pr-feedback', 'revise', { action: 'rework' }],
    ['pr-feedback', 'rework', { action: 'rework' }],
    ['release', 'approve', { action: 'approve-release' }],
    ['release', 'revise', 'escalate'],
    ['release', 'rework', 'escalate'],
    ['milestone-approval', 'approve', { draft: 'approve' }],
    ['milestone-approval', 'revise', { draft: 'revise' }],
    ['milestone-approval', 'rework', { draft: 'revise' }],
  ];
  assert.deepEqual(Object.keys(GATE_TABLE).sort(), [...OFFICE_GATES].sort(), 'every gate class has a row');
  for (const [gate, verdict, want] of rows) assert.deepEqual(gateMove(gate as never, verdict as never), want, `${gate} ${verdict}`);
  for (const gate of OFFICE_GATES) assert.equal(gateMove(gate, 'escalate'), 'escalate', `${gate} escalate`);
});
