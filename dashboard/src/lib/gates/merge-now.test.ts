// The Merge now card's model: offered only for an open PR on a feature job, armed only by the id
// typed back, and posting `now: true` with that id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmMatches, mergeNowDone, mergeNowOffered, postMergeNow } from './merge-now.ts';
import { setProject } from '../core/project.ts';
import type { Job } from '../core/types.ts';

const pr = (state: string) => ({ number: 7, url: 'https://github.com/o/r/pull/7', state }) as unknown as Job['pr'];

test('mergeNowOffered', () => {
  const rows: [string, Pick<Job, 'kind' | 'pr'>, boolean][] = [
    ['an open PR on a feature job', { kind: 'feature', pr: pr('OPEN') }, true],
    ['no PR', { kind: 'feature', pr: null }, false],
    ['a merged PR', { kind: 'feature', pr: pr('MERGED') }, false],
    ['a closed PR', { kind: 'feature', pr: pr('CLOSED') }, false],
    ['an eval job with an open PR', { kind: 'eval', pr: pr('OPEN') }, false],
  ];
  for (const [name, job, want] of rows) assert.equal(mergeNowOffered(job), want, name);
});

test('the card arms only on the id typed back, and posts it with now: true', async () => {
  assert.equal(confirmMatches('  j-1 ', 'j-1'), true);
  assert.equal(confirmMatches('j-2', 'j-1'), false);
  assert.equal(confirmMatches('', 'j-1'), false);
  assert.deepEqual(['merged', 'already-merged', 'deferred', 'refused', 'failed', 'auto'].map((action) => mergeNowDone({ action: action as never })), [true, true, false, false, false, false]);
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ merged: true, action: 'merged' }), { status: 200 });
  }) as unknown as typeof fetch;
  setProject('web');
  assert.deepEqual(await postMergeNow('j 1', 'j 1', fetchImpl), { merged: true, action: 'merged' });
  assert.equal(seen[0].url, '/api/p/web/jobs/j%201/merge');
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { now: true, confirm: 'j 1' });
  assert.deepEqual(seen[0].init.headers, { 'content-type': 'application/json' });
});
