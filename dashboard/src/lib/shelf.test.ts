// The Shelved list: a shelved job blocks nothing and is listed apart; the batch body pins each row to the
// time the list showed it shelved; the toast lists every outcome and skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxGroups, needsCount } from './inbox.ts';
import { filterJobs, pipelineCounts, sortByRank } from './board.ts';
import { needsHuman, stateText, stateTone } from './job-state.ts';
import { postShelf, shelfActionReady, shelfBody, shelfNeedsConfirm, shelfRows, shelfSummary } from './shelf.ts';
import { setProject } from './project.ts';
import type { Job } from './types.ts';

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
      ['q', 'queued', '2026-10-26T11:00:00.000Z', null, 'waiting on the billing owner'],
    ],
  );
  assert.deepEqual(shelfBody('approve', rows, '  '), { action: 'approve', jobs: [{ id: 's', shelvedAt: AT }, { id: 'q', shelvedAt: '2026-10-26T11:00:00.000Z' }], note: null });
  assert.deepEqual(shelfBody('rework', rows.slice(0, 1), 'fix it'), { action: 'rework', jobs: [{ id: 's', shelvedAt: AT }], note: 'fix it' });
  assert.deepEqual(['approve', 'rework', 'unshelve', 'close'].map((a) => shelfNeedsConfirm(a as never)), [true, false, false, true]);
  assert.equal(shelfActionReady('unshelve', 0, ''), false, 'nothing selected');
  assert.equal(shelfActionReady('rework', 2, ' '), false, 'rework needs its note');
  assert.equal(shelfActionReady('rework', 2, 'why'), true);
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
  await postShelf({ action: 'close', jobs: [{ id: 's', shelvedAt: AT }], note: null }, 'tok', fetchImpl);
  assert.equal(seen[0].url, '/api/p/web/shelf');
  assert.equal((seen[0].init.headers as Record<string, string>)['x-forge-token'], 'tok');
});
