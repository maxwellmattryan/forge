// The sleep helper's argv per platform, and a hold's life over a fake spawn and clock: nothing real
// is ever started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSleepHold, sleepHoldCommand } from './sleep.ts';
import type { SleepChild } from './types.ts';

test('the sleep helper per platform', () => {
  assert.deepEqual(sleepHoldCommand('darwin', 42), ['caffeinate', '-i', '-w', '42']);
  assert.deepEqual(sleepHoldCommand('linux', 42), [
    'systemd-inhibit',
    '--what=idle:sleep',
    '--who=Forge',
    '--why=Forge has a mandate or job in flight',
    '--mode=block',
    'tail',
    '--pid=42',
    '-f',
    '/dev/null',
  ]);
  for (const p of ['win32', 'freebsd'] as const) assert.equal(sleepHoldCommand(p, 42), null, p);
  for (const pid of [0, 1, -5, 1.5, NaN]) assert.equal(sleepHoldCommand('darwin', pid), null, String(pid));
});

/** A fake child: kill records its signal; exit and fail emit what a real one would. */
class FakeChild extends EventEmitter implements SleepChild {
  pid = 4242;
  kills: (string | undefined)[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }
}

function fakes() {
  const spawned: { file: string; args: string[]; child: FakeChild }[] = [];
  let clock = 1_000_000;
  const hold = createSleepHold({
    command: ['caffeinate', '-i', '-w', '42'],
    spawn: (file, args) => {
      const child = new FakeChild();
      spawned.push({ file, args, child });
      return child;
    },
    now: () => clock,
  });
  return { hold, spawned, tick: (ms: number) => (clock += ms) };
}

test('a sleep hold spawns once, releases, and retries a dead helper after its delay', () => {
  const { hold, spawned, tick } = fakes();
  assert.deepEqual(hold.state(), { held: false, since: null, error: null });

  hold.set(true);
  hold.set(true);
  assert.equal(spawned.length, 1, 'a repeat set(true) spawns nothing more');
  assert.deepEqual([spawned[0]!.file, spawned[0]!.args], ['caffeinate', ['-i', '-w', '42']]);
  assert.equal(hold.state().held, true);
  assert.equal(typeof hold.state().since, 'string');

  hold.set(false);
  assert.deepEqual(spawned[0]!.child.kills, ['SIGTERM'], 'set(false) kills the child');
  assert.equal(hold.state().held, false);
  // Its exit after our own kill is no failure.
  spawned[0]!.child.emit('exit', null);
  assert.equal(hold.state().error, null);

  hold.set(true);
  assert.equal(spawned.length, 2, 'held again with a new helper');
  // An unexpected exit: not held, the error set, and never a throw.
  spawned[1]!.child.emit('exit', 1);
  assert.deepEqual([hold.state().held, hold.state().error], [false, 'caffeinate exited with code 1']);
  tick(59_000);
  hold.set(true);
  assert.equal(spawned.length, 2, 'no respawn inside the retry delay');
  assert.equal(hold.state().error, 'caffeinate exited with code 1');
  tick(1_000);
  hold.set(true);
  assert.equal(spawned.length, 3, 'respawned once the delay passed');
  assert.deepEqual([hold.state().held, hold.state().error], [true, null]);

  // A spawn error (ENOENT) is a failure like an exit, and waits out the delay too.
  spawned[2]!.child.emit('error', Object.assign(new Error('spawn caffeinate ENOENT'), { code: 'ENOENT' }));
  assert.deepEqual([hold.state().held, hold.state().error], [false, 'caffeinate failed to start: spawn caffeinate ENOENT']);
  hold.set(true);
  assert.equal(spawned.length, 3);
  tick(60_000);
  hold.set(true);
  assert.equal(spawned.length, 4);

  hold.release();
  assert.deepEqual(spawned[3]!.child.kills, ['SIGTERM'], 'release() kills the child');
  hold.set(true);
  assert.equal(spawned.length, 4, 'nothing spawns after release()');
  assert.equal(hold.state().held, false);
});

test('a spawn that throws leaves the hold unheld with its error', () => {
  let calls = 0;
  const hold = createSleepHold({
    command: ['systemd-inhibit', '--what=idle:sleep'],
    spawn: () => {
      calls++;
      throw new Error('EACCES');
    },
    retryMs: 10,
    now: () => 0,
  });
  assert.doesNotThrow(() => hold.set(true));
  assert.deepEqual(hold.state(), { held: false, since: null, error: 'systemd-inhibit failed to start: EACCES' });
  hold.set(true);
  assert.equal(calls, 1, 'retried only after retryMs');
});
