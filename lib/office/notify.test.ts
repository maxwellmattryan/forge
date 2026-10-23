// Notifications follow registerNotify's hook, never an import: importing this module registers
// nothing, a registered queue hears each new failure once, and its remover stops it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from '../../test/helpers.ts';
import { registerNotify, type QueueNotify } from './notify.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, setJob } from '#core/job/store.ts';
import { runTransitionHooks } from '#core/job/transitions.ts';
import type { LoadedJob } from '#core/types.ts';

test('notifications follow registerNotify, not imports', () => {
  // Any hook would read the job (transitionEvents reads its kind), so an untouched job means none ran.
  const read: PropertyKey[] = [];
  const watched = new Proxy({ id: 'j1', kind: null } as unknown as LoadedJob, { get: (t, k) => (read.push(k), Reflect.get(t, k)) });
  runTransitionHooks('/nowhere', watched, { stage: 'build', state: 'running', waitingOn: null }, { stage: 'build', state: 'failed', waitingOn: null });
  assert.deepEqual(read, [], 'importing notify.ts registered a hook');

  const repo = tempRepo();
  const calls: { events: readonly string[]; job?: string | null; reason: string }[] = [];
  const queue: QueueNotify = (_root, events, opts) => (calls.push({ events, job: opts.job, reason: opts.reason }), true);
  try {
    const id = createJob(repo.dir, defaults(), { title: 'notify me' }).id;
    setJob(repo.dir, id, { state: 'running' });
    const remove = registerNotify(queue);
    try {
      setJob(repo.dir, id, { state: 'failed' });
      setJob(repo.dir, id, { state: 'failed' });
      assert.deepEqual(calls, [{ events: ['job-failed'], job: id, reason: 'failed' }]);
    } finally {
      remove();
    }
    setJob(repo.dir, id, { state: 'running' });
    setJob(repo.dir, id, { state: 'failed' });
    assert.equal(calls.length, 1, 'a transition after the remover ran calls nothing');
  } finally {
    repo.cleanup();
  }
});
