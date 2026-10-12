import test from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from './helpers.mjs';
import { defaults } from '../lib/config.mjs';
import { ackRequest, claimRequest, enqueue, listRequests } from '../lib/requests.mjs';

test('one session claims a request; a second is refused until the first is done or stale', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const { id } = enqueue(root, defaults(), { type: 'sync', from: 'dashboard' });
    assert.equal(listRequests(root, { status: 'pending' }).length, 1);
    const claimed = claimRequest(root, id, 'session-1');
    assert.equal(claimed.status, 'in-progress');
    assert.equal(claimed.session, 'session-1');
    assert.equal(listRequests(root, { status: 'pending' }).length, 0, 'a claimed request leaves the pending list');
    assert.throws(() => claimRequest(root, id, 'session-2'), (e) => e.exitCode === 3 && /being handled by session session-1/.test(e.message));
    assert.equal(claimRequest(root, id, 'session-1').session, 'session-1', 'the holder can re-claim');
    assert.equal(claimRequest(root, id, 'session-2', true).session, 'session-2', '--force takes over');
    ackRequest(root, id, { status: 'done', result: 'synced' });
    assert.throws(() => claimRequest(root, id, 'session-1'), /already done/);
  } finally {
    repo.cleanup();
  }
});
