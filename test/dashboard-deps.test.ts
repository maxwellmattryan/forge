import test from 'node:test';
import assert from 'node:assert/strict';
import { depLinks, dependents, blockLinks, depHint, depLabel, depChipTitle } from '../dashboard/src/lib/deps.ts';

const jobs: any = [
  { id: 'done-dep', title: 'Done', stage: 'done', state: 'done', dependsOn: [] },
  { id: 'live-dep', title: 'Live', stage: 'build', state: 'running', dependsOn: [] },
  { id: 'dead-dep', title: 'Dead', stage: 'spec', state: 'cancelled', dependsOn: [] },
  { id: 'child', title: 'Child', stage: 'backlog', state: 'waiting', dependsOn: ['done-dep', 'live-dep', 'dead-dep', 'gone'] },
  { id: 'plain', title: 'Plain', stage: 'backlog', state: 'queued', dependsOn: [] },
];
const child = jobs[3];

test('depLinks: done is ok, missing and cancelled are bad, anything else warns', () => {
  assert.deepEqual(
    depLinks(child, jobs).map((l) => [l.id, l.state, l.tone]),
    [
      ['done-dep', 'done', 'ok'],
      ['live-dep', 'running', 'warn'],
      ['dead-dep', 'cancelled', 'bad'],
      ['gone', 'missing', 'bad'],
    ],
  );
  assert.deepEqual(depLinks({ dependsOn: 'not-a-list' } as any, jobs), [], 'hand-edited garbage is ignored');
  assert.deepEqual(dependents(jobs[1], jobs).map((j) => j.id), ['child']);
});

test('blockLinks and depHint match the old drawer section', () => {
  // Depends on: the board chips and the drawer row share depLinks; titles come from depHint.
  assert.deepEqual(
    depLinks(child, jobs).map((l) => [l.id, l.state, l.tone, depHint(l)]),
    [
      ['done-dep', 'done', 'ok', 'Done · done/done'],
      ['live-dep', 'running', 'warn', 'Live · build/running'],
      ['dead-dep', 'cancelled', 'bad', 'Dead · spec/cancelled'],
      ['gone', 'missing', 'bad', 'missing'],
    ],
  );
  assert.deepEqual(blockLinks(child, jobs), [], 'child blocks nothing');
  // Blocks: the jobs that depend on this one.
  assert.deepEqual(blockLinks(jobs[1], jobs), [{ id: 'child', title: 'Child', ref: null, stage: 'backlog', state: 'waiting', tone: 'warn' }]);
  assert.equal(depHint(blockLinks(jobs[1], jobs)[0]), 'Child · backlog/waiting');
  assert.deepEqual(blockLinks(jobs[0], jobs).map((l) => l.id), ['child']);
  assert.deepEqual([depLinks(jobs[4], jobs), blockLinks(jobs[4], jobs)], [[], []], 'no section without links');
  assert.equal(depHint({ title: null, stage: 'build', state: 'running' }), ' · build/running', 'a missing title renders empty, as before');
  const done = { id: 'shipped', title: 'S', stage: 'done', state: 'done', dependsOn: ['plain'] };
  assert.deepEqual(blockLinks(jobs[4], [...jobs, done]).map((l) => [l.id, l.tone]), [['shipped', 'ok']]);
  // Hostile ids and titles come back verbatim: Svelte escapes them at render time.
  const evil: any = [
    { id: 'x"><img src=x onerror=alert(1)>', title: '<script>alert(1)</script>', stage: 'build', state: 'running', dependsOn: [] },
    { id: 'kid', title: 'Kid', stage: 'backlog', state: 'queued', dependsOn: ['x"><img src=x onerror=alert(1)>'] },
  ];
  assert.equal(depHint(depLinks(evil[1], evil)[0]), '<script>alert(1)</script> · build/running');
  assert.equal(blockLinks(evil[0], evil)[0].id, 'kid');
});

// An issue-linked job (GitHub #66), a local slug job (ref equal to its id) and a card depending on both plus a missing one.
const linked: any = [
  { id: '66-x', title: 'Drafting', issues: [{ tracker: 'github', ref: '66', url: null }], stage: 'done', state: 'done', dependsOn: [] },
  { id: 'local-slug', title: 'Local', issues: [{ tracker: 'github', ref: 'local-slug', url: null }], stage: 'build', state: 'running', dependsOn: [] },
  { id: 'card', title: 'Card', stage: 'build', state: 'running', dependsOn: ['66-x', 'local-slug', 'gone'] },
];

test("depLinks and blockLinks carry the dependency's tracker ref", () => {
  assert.deepEqual(
    depLinks(linked[2], linked).map((l) => [l.id, l.ref]),
    [
      ['66-x', '#66'],
      ['local-slug', null],
      ['gone', null],
    ],
  );
  assert.deepEqual(depLinks(linked[2], linked)[0], { id: '66-x', title: 'Drafting', ref: '#66', stage: 'done', state: 'done', tone: 'ok' }, 'every other field is unchanged');
  assert.deepEqual(depLinks(linked[2], linked)[2], { id: 'gone', title: null, ref: null, stage: null, state: 'missing', tone: 'bad' });
  const issueChild: any = { id: '70-kid', title: 'Kid', issues: [{ tracker: 'github', ref: '70', url: null }], stage: 'spec', state: 'queued', dependsOn: ['66-x'] };
  assert.deepEqual(blockLinks(linked[0], [...linked, issueChild]).map((l) => [l.id, l.ref]), [['card', null], ['70-kid', '#70']]);
  assert.deepEqual(blockLinks(linked[0], [...linked, issueChild])[1], { id: '70-kid', title: 'Kid', ref: '#70', stage: 'spec', state: 'queued', tone: 'warn' });
});

test('depLabel: issue ref plus title, else the id', () => {
  assert.equal(depLabel(depLinks(linked[2], linked)[0]), '#66 Drafting');
  assert.equal(depLabel(depLinks(linked[2], linked)[1]), 'local-slug', 'a local slug job shows its id');
  assert.equal(depLabel(depLinks(linked[2], linked)[2]), 'gone', 'a missing dependency shows its id');
  assert.equal(depLabel({ id: '66-x', ref: '#66', title: null }), '66-x', 'no title');
  assert.equal(depLabel({ id: '66-x', ref: '#66', title: '   ' }), '66-x', 'a whitespace-only title');
  assert.equal(depLabel({ id: '66-x', ref: '#66', title: '  Padded title \n' }), '#66 Padded title', 'the title is trimmed');
  assert.equal(depLabel({ id: 'slug', ref: null, title: 'Has a title' }), 'slug', 'no ref');
  const long = 'L'.repeat(120);
  assert.equal(depLabel({ id: '66-x', ref: '#66', title: long }), `#66 ${long}`, 'CSS truncates, the helper never cuts');
  assert.equal(depLabel({ id: '66-x', ref: '#66', title: '<script>alert(1)</script>' }), '#66 <script>alert(1)</script>', 'hostile text is verbatim: Svelte escapes it');
  assert.equal(depLabel({ id: '<img src=x onerror=alert(1)>', ref: null, title: null }), '<img src=x onerror=alert(1)>');
});

test('depChipTitle: full id then the hint', () => {
  assert.equal(depChipTitle(depLinks(linked[2], linked)[0]), '66-x · Drafting · done/done');
  assert.equal(depChipTitle(depLinks(linked[2], linked)[1]), 'local-slug · Local · build/running');
  assert.equal(depChipTitle(depLinks(linked[2], linked)[2]), 'gone · missing');
});
