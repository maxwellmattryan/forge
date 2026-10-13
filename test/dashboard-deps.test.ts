import test from 'node:test';
import assert from 'node:assert/strict';
import { depLinks, dependents, blockLinks, depHint } from '../dashboard/src/lib/deps.ts';

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
  assert.deepEqual(blockLinks(jobs[1], jobs), [{ id: 'child', title: 'Child', stage: 'backlog', state: 'waiting', tone: 'warn' }]);
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
