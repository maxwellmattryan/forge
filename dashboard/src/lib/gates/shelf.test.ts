// The Shelved list: a shelved job blocks nothing and is listed apart; the batch body pins each row to the
// time the list showed it shelved; the toast lists every outcome and skip; a Foreman shelve says who did it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxGroups, needsCount } from './inbox.ts';
import { filterJobs, pipelineCounts, sortByRank } from '../jobs/board.ts';
import { needsHuman, stateText, stateTone } from '../jobs/state.ts';
import { actorLabel, isForemanEvent } from '../jobs/drawer.ts';
import { postShelf, shelfActionReady, shelfBody, shelfNeedsConfirm, shelfPress, shelfRows, shelfSummary } from './shelf.ts';
import { setProject } from '../core/project.ts';
import type { Job, JobEvent } from '../core/types.ts';

const AT = '2026-10-26T10:00:00.000Z';
const shelf = (from: NonNullable<Job['shelved']>['from']): Job['shelved'] => ({ at: AT, reason: 'waiting on the billing owner', actor: { login: 'alice', source: 'gh' }, from });
const shelved = { id: 's', title: 'Shelved one', kind: 'feature', stage: 'decide', state: 'waiting', waitingOn: 'shelved', reason: 'shelved: waiting on the billing owner', shelved: shelf({ state: 'waiting', waitingOn: 'escalation', reason: 'r' }) } as Partial<Job>;
const escalated = { id: 'e', kind: 'feature', stage: 'decide', state: 'waiting', waitingOn: 'escalation' } as Partial<Job>;
const running = { id: 'r', kind: 'feature', stage: 'build', state: 'running', waitingOn: null } as Partial<Job>;

test('a shelved job is listed apart and blocks nothing', () => {
  const jobs = [shelved, escalated, running];
  assert.equal(needsHuman(shelved), false);
  const g = inboxGroups(jobs);
  assert.deepEqual([g.urgent.map((j) => j.id), g.shelved.map((j) => j.id)], [['e'], ['s']]);
  assert.equal(needsCount(jobs, []), 1);
  assert.deepEqual(filterJobs(jobs, 'waiting').map((j) => j.id), ['e']);
  assert.equal(pipelineCounts(jobs).waiting, 1);
  assert.deepEqual([stateText(shelved), stateTone(shelved)], ['Shelved', 'muted']);
  // Rank 3, with the other non-blocking waits: after running jobs.
  assert.deepEqual(sortByRank([shelved, running, escalated]).map((j) => j.id), ['e', 'r', 's']);
});

test('the batch body names each row\'s shelvedAt', () => {
  const queued = { ...shelved, id: 'q', shelved: { ...shelf({ state: 'queued', waitingOn: null, reason: null }), at: '2026-10-26T11:00:00.000Z', actor: { login: null, source: 'unknown' } } } as Partial<Job>;
  const rows = shelfRows([shelved, escalated, queued, { ...shelved, id: 'no-record', shelved: null }]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.from, r.at, r.by, r.reason]),
    [
      ['s', 'Escalated', AT, 'alice', 'waiting on the billing owner'],
      ['q', 'Queued', '2026-10-26T11:00:00.000Z', null, 'waiting on the billing owner'],
    ],
  );
  assert.deepEqual(shelfBody('approve', rows, '  '), { action: 'approve', jobs: [{ id: 's', shelvedAt: AT }, { id: 'q', shelvedAt: '2026-10-26T11:00:00.000Z' }], note: null });
  assert.deepEqual(shelfBody('rework', rows.slice(0, 1), 'fix it'), { action: 'rework', jobs: [{ id: 's', shelvedAt: AT }], note: 'fix it' });
  assert.deepEqual(['approve', 'rework', 'unshelve', 'close'].map((a) => shelfNeedsConfirm(a as never)), [true, false, false, true]);
  assert.equal(shelfActionReady('unshelve', 0, ''), false, 'nothing selected');
  assert.equal(shelfActionReady('rework', 2, ' '), false, 'rework needs its note');
  assert.equal(shelfActionReady('rework', 2, 'why'), true);
});

test('a Foreman shelve is named as the Foreman on its row and in the timeline', () => {
  const foreman = { login: null, source: 'foreman' };
  const byForeman = { ...shelved, id: 'f', shelved: { ...shelf({ state: 'waiting', waitingOn: 'escalation', reason: 'r' }), actor: foreman } } as Partial<Job>;
  assert.deepEqual(
    shelfRows([shelved, byForeman]).map((r) => [r.id, r.by, r.foreman]),
    [['s', 'alice', false], ['f', null, true]],
  );
  // Every event the Foreman recorded gets the Foreman chip and no "by"; a person's, or one with no actor, does neither.
  const event = (type: string, actor?: { login: string | null; source: string }) => ({ type, actor }) as Partial<JobEvent>;
  assert.deepEqual(['human', 'shelved', 'senior-pass'].map((t) => [isForemanEvent(event(t, foreman)), actorLabel(event(t, foreman))]), Array(3).fill([true, null]));
  assert.deepEqual([event('shelved', { login: 'alice', source: 'gh' }), event('shelved')].map((e) => isForemanEvent(e)), [false, false]);
  assert.deepEqual(actorLabel(event('shelved', { login: 'alice', source: 'gh' })), { login: 'alice', source: 'gh' });
});

test('pressing the same action twice from the bar never posts', () => {
  // The bar's Approve and Close only open the confirm, so a double-click can't skip the count it names.
  for (const a of ['approve', 'close'] as const) {
    assert.deepEqual([1, 2].map(() => shelfPress(a, 'bar', 3, '')), ['confirm', 'confirm']);
    assert.equal(shelfPress(a, 'confirm', 3, ''), 'post', 'the confirm row\'s own button posts');
  }
  // Rework and Un-shelve have no confirm step: the bar posts them, once the rows (and Rework's note) are there.
  assert.deepEqual([shelfPress('unshelve', 'bar', 1, ''), shelfPress('rework', 'bar', 1, 'why'), shelfPress('rework', 'bar', 1, ' ')], ['post', 'post', 'none']);
  assert.deepEqual([shelfPress('approve', 'bar', 0, ''), shelfPress('close', 'confirm', 0, '')], ['none', 'none']);
});

test('the summary lists every skip', async () => {
  const msg = { outcome: (o: string, n: number) => `${n} ${o}`, skipped: (id: string, reason: string) => `${id}: ${reason}` };
  assert.deepEqual(
    shelfSummary(
      [
        { id: 'a', outcome: 'approved' },
        { id: 'b', outcome: 'approved' },
        { id: 'c', outcome: 'skipped', reason: 'not shelved' },
        { id: 'd', outcome: 'skipped', reason: 'shelved again since the list loaded' },
      ],
      msg,
    ),
    { text: '2 approved · c: not shelved · d: shelved again since the list loaded', bad: true },
  );
  assert.deepEqual(shelfSummary([{ id: 'a', outcome: 'closed' }], msg), { text: '1 closed', bad: false });
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  setProject('web');
  await postShelf({ action: 'close', jobs: [{ id: 's', shelvedAt: AT }], note: null }, fetchImpl);
  assert.equal(seen[0].url, '/api/p/web/shelf');
  assert.deepEqual(seen[0].init.headers, { 'content-type': 'application/json' });
});
