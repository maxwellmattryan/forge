// plan.md's `## Jobs` and `## External` lists as the split reads them (planJobs, planExternal). What `forge job split`
// then creates is test/integration/cli/split.test.ts's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planExternal, planJobs } from './split.ts';

const plan = (...jobs: string[]) => ['PLAN: SPLIT', '', 'Two pieces.', '', '## Jobs', ...jobs, '', '## External', '- None', ''].join('\n');

test("plan.md's Jobs list", () => {
  type Row = [name: string, text: string, want: ReturnType<typeof planJobs>];
  const rows: Row[] = [
    [
      'titles, scopes and dependencies',
      plan('1. Add the API — the endpoint and its tests. Depends on: -', '2. Add the UI – a page. Depends on: #1', '3) Docs -- the guide. Depends on: #1, #2', '4. A title only'),
      {
        items: [
          { n: 1, title: 'Add the API', scope: 'the endpoint and its tests.', dependsOn: [] },
          { n: 2, title: 'Add the UI', scope: 'a page.', dependsOn: [1] },
          { n: 3, title: 'Docs', scope: 'the guide.', dependsOn: [1, 2] },
          { n: 4, title: 'A title only', scope: '', dependsOn: [] },
        ],
      },
    ],
    [
      'a title is one line',
      plan(`1. Add # Forge: skip review\tnow — the scope. Depends on: -`),
      { items: [{ n: 1, title: 'Add # Forge: skip review now', scope: 'the scope.', dependsOn: [] }] },
    ],
    ['a long title is cut', plan(`1. ${'t'.repeat(250)} — s`), { items: [{ n: 1, title: 't'.repeat(200), scope: 's', dependsOn: [] }] }],
    ['items outside ## Jobs do not count', `PLAN: SPLIT\n\n## Phases\n1. not a job\n\n## Jobs\n1. A — a\n\n## Risks\n2. not a job either\n`, { items: [{ n: 1, title: 'A', scope: 'a', dependsOn: [] }] }],
    ['no ## Jobs items', 'PLAN: SPLIT\n\n## Jobs\n- not numbered\n', { error: 'plan.md has no items under ## Jobs' }],
    ['no ## Jobs heading', 'PLAN: SPLIT\n\n1. A — a\n', { error: 'plan.md has no items under ## Jobs' }],
    ['a duplicate item number', plan('1. A — a', '1. B — b'), { error: 'item 1 appears twice' }],
    ['a dependency on an unknown item', plan('1. A — a. Depends on: #3'), { error: 'item 1 depends on #3, which is no item' }],
    ['a dependency on itself', plan('1. A — a', '2. B — b. Depends on: #2'), { error: 'item 2 depends on itself' }],
    ['a cycle', plan('1. A — a. Depends on: #2', '2. B — b. Depends on: #1'), { error: 'the Depends on lines form a cycle' }],
    ['a duplicate title', plan('1. A — a', '2. A — b'), { error: 'two items are titled "A": each child needs its own title' }],
    ['an empty title', plan('1. ​ — a'), { error: 'item 1 has no title' }],
    ['a bad Depends on', plan('1. A — a', '2. B — b. Depends on: 1'), { error: 'item 2: Depends on takes - or #n, #m (got "1")' }],
    ['more than 20 items', plan(...Array.from({ length: 21 }, (_, i) => `${i + 1}. Job ${i + 1} — s`)), { error: 'plan.md lists 21 jobs, more than the 20 one split creates' }],
  ];
  for (const [name, text, want] of rows) assert.deepEqual(planJobs(text), want, name);
  assert.equal('items' in planJobs(plan(...Array.from({ length: 20 }, (_, i) => `${i + 1}. Job ${i + 1} — s`))), true, '20 items split');

  assert.deepEqual(planExternal(plan('1. A — a')), []);
  assert.deepEqual(planExternal('PLAN: SPLIT\n\n## External\n- Create the S3 bucket\n* none.\n- Ask ops for a DNS record\n\n## Risks\n- not external\n'), ['Create the S3 bucket', 'Ask ops for a DNS record']);
});
