// moveJob: one locked write, then the environment, gate and mirror effects once each, against the
// job as the write's lock read it; the named inputs; and mirrorJob, which runs the mirror alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobAt, recordingMoveEffects, repoTemplate, type MoveEffectCall, type MoveSide } from '../../../../test/helpers.ts';
import { mirrorJob, moveJob, type MoveResult } from './apply.ts';
import { currentMoveEffects, realMoveEffects, useMoveEffects } from './effects.ts';
import { defaults } from '#core/config/load.ts';
import { claimJob, loadJob, readEvents, setJob } from '#core/job/store.ts';
import type { Config } from '#core/types.ts';

const config: Config = defaults();
let jobId = '';
const scratch = repoTemplate((dir) => {
  jobId = jobAt(dir, 'backlog', { config, title: 'move me' }).id;
});

const side = (stage: string, state: string, waitingOn: string | null = null): MoveSide => ({ stage, state, waitingOn });

interface Row {
  name: string;
  /** Runs before the move, after the job is set running; may write the job itself. */
  prepare?: (root: string, id: string) => void;
  /** The move under test; its calls are recorded. */
  move: (root: string, id: string) => Promise<MoveResult | void>;
  calls: (id: string, start: MoveSide) => MoveEffectCall[];
  /** Checks on job.json and events after the move. */
  check?: (root: string, id: string, result: MoveResult | void) => void;
  /** The move rejects, and no effect runs. */
  rejects?: boolean;
}

const park = side('build', 'waiting', 'escalation');
const effects = (id: string, from: MoveSide, to: MoveSide, mode: 'teardown' | 'stop' = 'teardown', mirror = true): MoveEffectCall[] => [
  { effect: 'environment', job: id, from, to, mode },
  { effect: 'gate', job: id, from, to },
  ...(mirror ? [{ effect: 'mirror' as const, job: id, from: null, to }] : []),
];
const transitions = (root: string, id: string) => readEvents(root, id).filter((e) => e.type === 'transition').length;

const ROWS: Row[] = [
  {
    name: 'a default park passes every change field through one write',
    prepare: (root, id) => {
      claimJob(root, id, 'sess-1');
    },
    move: (root, id) => {
      const epoch = loadJob(root, id).lease.epoch;
      return moveJob(root, config, id, {
        stage: 'build',
        state: 'waiting',
        waitingOn: 'escalation',
        reason: 'stuck',
        note: 'parked by the test',
        fields: { services: ['api'] },
        owned: { noIssue: true },
        fence: { epoch, session: 'sess-1' },
        release: true,
        derive: (j) => (j.state === 'running' ? { reason: 'stuck, derived' } : null),
      });
    },
    calls: (id, start) => effects(id, start, park),
    check: (root, id, r) => {
      const job = loadJob(root, id);
      assert.equal(job.reason, 'stuck, derived');
      assert.deepEqual(job.services, ['api']);
      assert.equal(job.noIssue, true);
      assert.equal(job.lease.driver, null);
      const events = readEvents(root, id);
      // The set to running before the move, then the move's one write.
      assert.equal(transitions(root, id), 2);
      assert.ok(events.some((e) => e.type === 'note' && e.text === 'parked by the test'));
      assert.ok(events.some((e) => e.type === 'released'));
      assert.equal((r as MoveResult).before.state, 'running');
      assert.equal((r as MoveResult).job.state, 'waiting');
    },
  },
  {
    name: 'a write between the caller’s read and the move shows up in before',
    move: (root, id) => {
      const seen = loadJob(root, id);
      assert.equal(seen.state, 'running');
      setJob(root, id, { state: 'waiting', waitingOn: 'input' });
      return moveJob(root, config, id, { stage: 'build', state: 'waiting', waitingOn: 'escalation' });
    },
    calls: (id, start) => effects(id, side(start.stage, 'waiting', 'input'), park),
    check: (root, id, r) => assert.equal((r as MoveResult).before.waitingOn, 'input'),
  },
  {
    name: 'a declining derive still runs each effect once against the unchanged job',
    move: (root, id) => moveJob(root, config, id, { derive: () => null }),
    calls: (id, start) => effects(id, start, start),
    // Only the set to running before the move.
    check: (root, id) => assert.equal(transitions(root, id), 1),
  },
  {
    name: "environment: 'stop' stops rather than tears down",
    move: (root, id) => moveJob(root, config, id, { state: 'cancelled' }, { environment: 'stop' }),
    calls: (id, start) => effects(id, start, side(start.stage, 'cancelled'), 'stop'),
  },
  {
    name: 'mirror: false calls no mirror',
    move: (root, id) => moveJob(root, config, id, { state: 'cancelled' }, { mirror: false }),
    calls: (id, start) => effects(id, start, side(start.stage, 'cancelled'), 'teardown', false),
  },
  {
    name: "afterWrite's job is what every effect sees, and no input skips the gate",
    move: (root, id) =>
      moveJob(root, config, id, { stage: 'build', state: 'waiting', waitingOn: 'escalation' }, { environment: 'stop', mirror: true, afterWrite: (j) => setJob(root, j.id, { waitingOn: 'input' }) }),
    calls: (id, start) => effects(id, start, side('build', 'waiting', 'input'), 'stop'),
    check: (root, id, r) => assert.equal((r as MoveResult).job.waitingOn, 'input'),
  },
  {
    name: 'a setJob that throws runs no effect',
    move: (root, id) => moveJob(root, config, id, { state: 'waiting' }),
    calls: () => [],
    rejects: true,
  },
  {
    name: 'mirrorJob runs only the mirror, once, with that job',
    move: async (root, id) => mirrorJob(root, config, { ...loadJob(root, id), state: 'cancelled', reason: 'deleted' }),
    calls: (id, start) => [{ effect: 'mirror', job: id, from: null, to: side(start.stage, 'cancelled') }],
  },
];

test('moveJob runs the effects once each against the job as its lock read it', async () => {
  for (const row of ROWS) {
    const r = scratch();
    const fake = recordingMoveEffects();
    try {
      row.prepare?.(r.dir, jobId);
      const start = loadJob(r.dir, jobId);
      const restore = useMoveEffects(fake);
      let result: MoveResult | void = undefined;
      try {
        if (row.rejects) await assert.rejects(row.move(r.dir, jobId), row.name);
        else result = await row.move(r.dir, jobId);
      } finally {
        restore();
      }
      assert.equal(currentMoveEffects(), realMoveEffects, `${row.name}: the restore puts the real adapter back`);
      assert.deepEqual(fake.calls, row.calls(jobId, side(start.stage, start.state, start.waitingOn)), row.name);
      row.check?.(r.dir, jobId, result);
    } finally {
      r.cleanup();
    }
  }
});
