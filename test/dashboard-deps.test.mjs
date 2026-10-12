import test from 'node:test';
import assert from 'node:assert/strict';
import { depLinks, dependents, depChips, depSection } from '../dashboard/deps.js';

const jobs = [
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
  assert.deepEqual(depLinks({ dependsOn: 'not-a-list' }, jobs), [], 'hand-edited garbage is ignored');
  assert.deepEqual(dependents(jobs[1], jobs).map((j) => j.id), ['child']);
});

test('depChips: one clickable chip per dependency, nothing without dependencies', () => {
  const html = depChips(child, jobs);
  assert.equal(html.match(/data-action="open"/g).length, 4);
  assert.match(html, /<span data-action="open" data-id="done-dep" title="Done · done\/done" class="chip bg-ok\/15 text-ok[^"]*">after done-dep<\/span>/);
  assert.match(html, /data-id="live-dep" title="Live · build\/running" class="chip bg-warn\/15 text-warn/);
  assert.match(html, /data-id="dead-dep"[^>]*class="chip bg-bad\/15 text-bad/);
  assert.match(html, /data-id="gone" title="missing" class="chip bg-bad\/15 text-bad[^"]*">after gone</);
  assert.equal(depChips(jobs[4], jobs), '');
  assert.equal(depChips({ id: 'x' }, jobs), '');
});

test('depSection: depends-on and blocks rows, each only when non-empty', () => {
  const s = depSection(child, jobs);
  assert.match(s, /Depends on/);
  assert.doesNotMatch(s, /Blocks/);
  const blocker = depSection(jobs[1], jobs);
  assert.match(blocker, /Blocks/);
  assert.doesNotMatch(blocker, /Depends on/);
  assert.match(blocker, /<button data-action="open" data-id="child"/);
  assert.equal(depSection(jobs[4], jobs), '');
});

test('hostile ids and titles render escaped', () => {
  const evil = [
    { id: 'x"><img src=x onerror=alert(1)>', title: '<script>alert(1)</script>', stage: 'build', state: 'running', dependsOn: [] },
    { id: 'kid', title: 'Kid', stage: 'backlog', state: 'queued', dependsOn: ['x"><img src=x onerror=alert(1)>'] },
  ];
  for (const html of [depChips(evil[1], evil), depSection(evil[1], evil), depSection(evil[0], evil)]) {
    assert.doesNotMatch(html, /<script>|<img/);
  }
  assert.match(depChips(evil[1], evil), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(depChips(evil[1], evil), /data-id="x&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
});
