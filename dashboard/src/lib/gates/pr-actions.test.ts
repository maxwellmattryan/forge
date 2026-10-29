// The Needs you PR row's actions follow why the PR waits: failing checks, feedback, both or neither;
// and its CI buttons post the action with the head the row showed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackCount, postPrCi, prActions } from './pr-actions.ts';
import { setProject } from '../core/project.ts';
import type { Job } from '../core/types.ts';

const HEAD = 'b'.repeat(40);
type Pr = NonNullable<Job['pr']>;
const pr = (over: Partial<Pr> = {}): Pr => ({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, lastSyncedAt: 't', headOid: HEAD, unresolvedThreads: 0, feedbackSinceRound: 0, ...over });
const checks = (state: 'failing' | 'passing' | 'pending' | 'none') => ({ state, passing: 0, failing: state === 'failing' ? 1 : 0, pending: state === 'pending' ? 1 : 0 });
const failing = (actions: number) => ({ checks: checks('failing'), failingChecks: { names: ['test'], more: 0, actions } });

test('prActions', () => {
  const rows: [string, Job['pr'] | null | undefined, string[]][] = [
    ['failing with no feedback', pr(failing(1)), ['rerun', 'fix-ci']],
    ['threads with passing checks', pr({ checks: checks('passing'), unresolvedThreads: 2 }), ['feedback']],
    ['new feedback with passing checks', pr({ checks: checks('passing'), feedbackSinceRound: 1 }), ['feedback']],
    ['passing, no feedback', pr({ checks: checks('passing') }), []],
    ['pending, no feedback', pr({ checks: checks('pending') }), []],
    ['no checks, no feedback', pr({ checks: checks('none') }), []],
    ['failing checks and feedback', pr({ ...failing(2), unresolvedThreads: 1 }), ['rerun', 'fix-ci', 'feedback']],
    ['failing with only external statuses', pr(failing(0)), ['fix-ci']],
    ['failing, recorded before failingChecks', pr({ checks: checks('failing') }), ['rerun', 'fix-ci']],
    ['a merged PR', pr({ ...failing(1), state: 'MERGED', unresolvedThreads: 1 }), []],
    ['a closed PR', pr({ ...failing(1), state: 'CLOSED' }), []],
    ['no PR', null, []],
    ['no PR recorded', undefined, []],
    ['a head that is not a sha', pr({ ...failing(1), headOid: 'main' }), []],
    ['no head', pr({ ...failing(1), headOid: null, unresolvedThreads: 1 }), ['feedback']],
    ['a negative or fractional count', pr({ checks: checks('passing'), unresolvedThreads: -1, feedbackSinceRound: 0.5 }), []],
  ];
  for (const [name, p, want] of rows) assert.deepEqual(prActions(p), want, name);
});

test('feedbackCount counts only a positive whole number, as prActions does', () => {
  const rows: [string, Job['pr'] | null | undefined, number][] = [
    ['new comments', pr({ feedbackSinceRound: 3 }), 3],
    ['none', pr({ feedbackSinceRound: 0 }), 0],
    ['negative', pr({ feedbackSinceRound: -1 }), 0],
    ['fractional', pr({ feedbackSinceRound: 0.5 }), 0],
    ['not recorded', pr({ feedbackSinceRound: undefined }), 0],
    ['no PR', null, 0],
  ];
  for (const [name, p, want] of rows) assert.equal(feedbackCount(p), want, name);
});

test('postPrCi posts the action and the head', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const reply = { action: 'fix-ci', id: 'j 1', head: HEAD, checks: ['test'] };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  setProject('web');
  assert.deepEqual(await postPrCi('j 1', { action: 'fix-ci', head: HEAD }, fetchImpl), reply);
  assert.equal(seen[0].url, '/api/p/web/jobs/j%201/ci');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { action: 'fix-ci', head: HEAD });
  assert.deepEqual(seen[0].init.headers, { 'content-type': 'application/json' });

  const refusing = (async () => new Response(JSON.stringify({ error: 'job j moved; nothing started' }), { status: 409 })) as unknown as typeof fetch;
  await assert.rejects(postPrCi('j', { action: 'rerun', head: HEAD }, refusing), /job j moved; nothing started/);
});
