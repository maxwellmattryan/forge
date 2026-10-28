// The brief's helpers that need no job: withPrefixLine, the brief a role run with a trusted prefix gets, and needsBrowser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTIONS_LINE, PREFIX_INSTRUCTIONS_LINE, REPLY_LINE, needsBrowser, withPrefixLine } from './brief.ts';

test('withPrefixLine swaps or inserts the prefix line', () => {
  const head = ['Job id: j', 'Role: reviewer · lens code', 'Round: 1', 'Output: /x/review/code.md', 'Effort: high'];
  const tail = ['Lens: code', 'Checklist: /x/reviewers/code.md', REPLY_LINE];
  const rows: { name: string; brief: string[]; want: string[] | null }[] = [
    { name: 'the instructions line is swapped in place', brief: [...head, INSTRUCTIONS_LINE, ...tail], want: [...head, PREFIX_INSTRUCTIONS_LINE, ...tail] },
    { name: 'without one, the prefix line follows Effort', brief: [...head, ...tail], want: [...head, PREFIX_INSTRUCTIONS_LINE, ...tail] },
    {
      name: 'only the first Effort line counts',
      brief: ['Job id: j', 'Effort: low', 'Lens: x', 'Effort: high'],
      want: ['Job id: j', 'Effort: low', PREFIX_INSTRUCTIONS_LINE, 'Lens: x', 'Effort: high'],
    },
    {
      // A line that only contains the instructions text is not the line: the Effort rule applies.
      name: 'a near-copy of the instructions line is left alone',
      brief: [...head, `x ${INSTRUCTIONS_LINE}`, ...tail],
      want: [...head, PREFIX_INSTRUCTIONS_LINE, `x ${INSTRUCTIONS_LINE}`, ...tail],
    },
    { name: 'an effort-like line that does not start the line is no anchor', brief: ['Job id: j', 'Lens: Effort: high', REPLY_LINE], want: null },
    { name: 'neither line', brief: ['Job id: j', REPLY_LINE], want: null },
    { name: 'empty', brief: [''], want: null },
  ];
  for (const row of rows) assert.equal(withPrefixLine(row.brief.join('\n')), row.want === null ? null : row.want.join('\n'), row.name);
});

test('only UI roles of a spec with a UI AC get the browser', () => {
  const ui = ['AC3', 'AC7'];
  const rows: [{ role: string; lens?: string }, boolean][] = [
    [{ role: 'builder' }, true],
    [{ role: 'designer' }, true],
    ...['ui', 'ux', 'accessibility', 'design'].map((lens): [{ role: string; lens?: string }, boolean] => [{ role: `reviewer:${lens}`, lens }, true]),
    [{ role: 'reviewer:ui' }, true],
    [{ role: 'reviewer:web:ui', lens: 'web:ui' }, true],
    [{ role: 'reviewer:code', lens: 'code' }, false],
    [{ role: 'reviewer:security', lens: 'security' }, false],
    [{ role: 'reviewer' }, false],
    [{ role: 'planner' }, false],
    [{ role: 'spec-writer' }, false],
    [{ role: 'approver' }, false],
    [{ role: 'integrator' }, false],
    [{ role: 'judge' }, false],
  ];
  for (const [spawn, want] of rows) {
    assert.equal(needsBrowser(spawn, ui), want, JSON.stringify(spawn));
    assert.equal(needsBrowser(spawn, []), false, `${JSON.stringify(spawn)} with no UI AC`);
  }
});
