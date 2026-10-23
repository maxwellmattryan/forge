import test from 'node:test';
import assert from 'node:assert/strict';
import { findingTitle, recurringAcrossJobs } from './findings.ts';
import type { LensFinding } from './findings.ts';

test('findingTitle normalises a finding to its first words', () => {
  const rows: [string, string | null][] = [
    ['lib/api/versions.ts:2 — the header comment\'s second line runs well past', 'header comment second line'],
    ['lib/office/driver.ts:1-3 — The header comment\'s second line is much longer', 'header comment second line'],
    ['lib/job-fields.ts:68-71 (and :63-65) — `checkJobFields` checks the kind field twice', 'checks kind field twice'],
    ['.forge/config.yml:136 — The security lens `paths` still lists only `lib/step.ts`, which', 'security lens lists only'],
    ['lib/release-run.ts:328: carried over from round 1', 'carried over from round'],
    ['lib/a.ts — see docs/A.md and build.md here please', 'see here please'],
    ['The new terms are missing', 'new terms missing'],
    ['comment', null],
    ['lib/x.ts — a b', null],
  ];
  for (const [rest, want] of rows) assert.equal(findingTitle(rest), want, rest);
  const hostile = '- `'.repeat(66_667).slice(0, 200_000);
  const started = Date.now();
  findingTitle(hostile);
  assert.ok(Date.now() - started < 1000, 'linear on a long hostile line');
});

const f = (lens: string, title: string | null, text = `${title}`): LensFinding => ({ lens, title, text, severity: 'minor', path: null, line: null });

test('recurringAcrossJobs groups findings by lens and title across jobs', () => {
  const rows: { name: string; perJob: { id: string; findings: LensFinding[] }[]; want: unknown }[] = [
    { name: 'two rounds of one job', perJob: [{ id: 'A', findings: [f('code', 'long line here'), f('code', 'long line here')] }], want: [] },
    { name: 'different lenses', perJob: [{ id: 'A', findings: [f('code', 'long line here')] }, { id: 'B', findings: [f('docs', 'long line here')] }], want: [] },
    {
      name: 'same lens and title in B then A',
      perJob: [
        { id: 'B', findings: [f('code', 'long line here', 'first'), f('code', 'long line here', 'second')] },
        { id: 'A', findings: [f('code', 'long line here', 'third')] },
      ],
      want: [{ lens: 'code', title: 'long line here', findings: 3, jobs: ['A', 'B'], example: 'first' }],
    },
    { name: 'a null title never groups', perJob: [{ id: 'A', findings: [f('code', null)] }, { id: 'B', findings: [f('code', null)] }], want: [] },
  ];
  for (const r of rows) assert.deepEqual(recurringAcrossJobs(r.perJob), r.want, r.name);

  const order = recurringAcrossJobs([
    { id: 'A', findings: [f('docs', 'zz zz'), f('code', 'yy yy'), f('code', 'xx xx'), f('code', 'xx xx'), f('code', 'ww ww'), f('code', 'vv vv')] },
    { id: 'B', findings: [f('docs', 'zz zz'), f('code', 'yy yy'), f('code', 'xx xx'), f('code', 'ww ww'), f('code', 'vv vv')] },
    { id: 'C', findings: [f('code', 'ww ww'), f('code', 'vv vv')] },
  ]).map((g) => `${g.lens}/${g.title}`);
  assert.deepEqual(order, ['code/vv vv', 'code/ww ww', 'code/xx xx', 'code/yy yy', 'docs/zz zz'], 'jobs desc, findings desc, lens, title');
});
