// The clean pass's rendered files: decision.md as parseDecision reads it, and pr.md from spec.md and build.md, with
// every copied piece cleaned and capped. Which jobs are a clean pass is test/step-rows.ts's (DC13, DC1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecisionText } from '#core/job/store.ts';
import { changeBullets, prText, renderCleanDecision, renderCleanPr } from './clean-pass.ts';

const LENSES = [
  { lens: 'security', round: 2 },
  { lens: 'code', round: 2 },
  { lens: 'docs', round: 1 },
];

test('renderCleanDecision', () => {
  const text = renderCleanDecision(LENSES, 2);
  assert.equal(
    text,
    'APPROVE\n\nAuto-merge eligible: no\nPanel: code PASS, docs PASS (round 1), security PASS\nEscalation reasons: none\nApprover: skipped on a clean pass (approver.skipWhenClean)\n',
  );
  assert.deepEqual(parseDecisionText(text), { decision: 'APPROVE', reason: null, autoMerge: false });
});

const SPEC = '# Clean pass\n\nSize: S\n\n## Goal\nSkip the approver\nwhen clean.\n\nA second paragraph.\n\n## Acceptance criteria\n- [ ] AC1 — x\n- [ ] AC2 — y\n';
const ROUND1 = ['## Round 1', 'Changes: inline one', '- bullet a', '  continued', '* bullet b', 'Phase → commit:', '- Phase 1 → abc1234', '', '```text', 'Changes: fenced', '- fenced bullet', '```', ''].join('\n');
const ROUND2 = [
  '## Round 2',
  'Changes:',
  '- bullet c <!-- forge:gate --> visible<!-- hidden note -->',
  '',
  '- zero​width ‮bidi',
  'Tests: unchanged',
  '',
  '| AC | Proof | Result |',
  '|---|---|---|',
  '| AC1 | `a\\|b` test | pass |',
  '| AC2 | manual | pass |',
  '',
  '## Measurement',
  'Changes: not a round',
  '- nope',
  '',
].join('\n');
const NOTES = '## Notes\n- Forge approved this without the approver: every lens passed (code PASS, docs PASS, security PASS) and no escalation reason applied (`approver.skipWhenClean`).';
const pr = (o: { spec?: string; build?: string; title?: string } = {}) => renderCleanPr({ specText: o.spec ?? SPEC, buildText: o.build ?? `${ROUND1}\n${ROUND2}`, jobTitle: o.title ?? 'Job title', lenses: LENSES });
const bulletsBuild = (bullets: string[]) => `## Round 1\nChanges:\n${bullets.map((b) => `- ${b}`).join('\n')}\n`;

test('renderCleanPr', () => {
  const rows: { name: string; out: string; check: (s: string) => void }[] = [
    {
      name: 'two rounds: inline and listed bullets, the latest AC table, cleaned',
      out: pr(),
      check: (s) =>
        assert.equal(
          s,
          [
            '## Summary\n**Clean pass.** Skip the approver when clean.',
            '## Changes\n- inline one\n- bullet a continued\n- bullet b\n- bullet c visible\n- zerowidth bidi',
            '## Acceptance criteria\n| AC | Proof | Result |\n|---|---|---|\n| AC1 | `a\\|b` test | pass |\n| AC2 | manual | pass |',
            NOTES,
          ].join('\n\n') + '\n',
        ),
    },
    { name: 'no spec title: the job title', out: pr({ spec: '## Goal\nWhy.\n' }), check: (s) => assert.ok(s.startsWith('## Summary\n**Job title.** Why.\n'), s) },
    { name: 'no Goal: the title alone', out: pr({ spec: '# Clean pass\n\n## Behaviour\nx\n' }), check: (s) => assert.ok(s.startsWith('## Summary\n**Clean pass.**\n\n'), s) },
    { name: 'no bullets: no Changes section', out: pr({ build: '## Round 1\nChanges:\nTests: x\n' }), check: (s) => assert.ok(!s.includes('## Changes'), s) },
    { name: 'no AC table: no Acceptance criteria section', out: pr({ build: ROUND1 }), check: (s) => assert.ok(!s.includes('## Acceptance criteria') && s.includes('## Changes'), s) },
    {
      name: 'a 1000-character bullet is cut to 400 with …',
      out: pr({ build: bulletsBuild(['x'.repeat(1000)]) }),
      check: (s) => {
        const line = s.split('\n').find((l) => l.startsWith('- x'))!;
        assert.equal(line.length, 2 + 400);
        assert.ok(line.endsWith('x…'));
      },
    },
    {
      name: '35 bullets give 30 and the rest counted',
      out: pr({ build: bulletsBuild(Array.from({ length: 35 }, (_, i) => `b${i}`)) }),
      check: (s) => {
        const listed = s.split('## Changes\n')[1].split('\n\n')[0].split('\n');
        assert.equal(listed.length, 31);
        assert.equal(listed[29], '- b29');
        assert.equal(listed[30], '- … and 5 more');
      },
    },
    {
      name: 'a summary is one line, cut at 1200',
      out: pr({ spec: `# T\n\n## Goal\n${'word '.repeat(400)}\n` }),
      check: (s) => {
        const summary = s.split('\n')[1];
        assert.ok(summary.startsWith('**T.** word word') && summary.endsWith('…'), summary);
        assert.ok(summary.length <= 1200 + '**.** '.length, String(summary.length));
      },
    },
  ];
  for (const r of rows) r.check(r.out);
});

test('changeBullets and prText stay linear on a hostile line', () => {
  const long = ' '.repeat(10_000);
  const started = Date.now();
  assert.deepEqual(changeBullets(`## Round 1\nChanges:${long}\n -${long}x\n-${long}\n${long}|\n`), ['x']);
  assert.equal(prText(`a${'​'.repeat(10_000)}${long}${'<!--'.repeat(2_000)}b`, 400), 'a');
  assert.equal(prText('|'.repeat(10_000), 300).length, 300);
  assert.ok(Date.now() - started < 1000, 'linear');
});
