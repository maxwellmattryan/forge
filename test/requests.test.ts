import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { defaults } from '../lib/config.ts';
import { ackRequest, claimRequest, enqueue, listRequests } from '../lib/requests.ts';

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
    assert.throws(() => claimRequest(root, id, 'session-2'), (e: any) => e.exitCode === 3 && /being handled by session session-1/.test(e.message));
    assert.equal(claimRequest(root, id, 'session-1').session, 'session-1', 'the holder can re-claim');
    assert.equal(claimRequest(root, id, 'session-2', true).session, 'session-2', '--force takes over');
    ackRequest(root, id, { status: 'done', result: 'synced' });
    assert.throws(() => claimRequest(root, id, 'session-1'), /already done/);
  } finally {
    repo.cleanup();
  }
});

test('AC4: enqueue only writes the inbox file', () => {
  const repo = tempRepo();
  try {
    // A config that still carries a launcher must not start anything.
    const config = { ...defaults(), dashboard: { port: 7400, launcher: 'touch launched-marker' } };
    const rec = enqueue(repo.dir, config, { type: 'next', from: 'dashboard' });
    assert.equal('launched' in rec, false);
    assert.equal(rec.status, 'pending');
    const dir = path.join(repo.dir, '.forge', 'runtime');
    assert.deepEqual(fs.readdirSync(dir), ['requests']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'requests')), [`${rec.id}.json`]);
    assert.equal(fs.existsSync(path.join(repo.dir, 'launched-marker')), false);
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'lib', 'requests.ts'), 'utf8');
    assert.equal(src.includes('child_process'), false);
  } finally {
    repo.cleanup();
  }
});
