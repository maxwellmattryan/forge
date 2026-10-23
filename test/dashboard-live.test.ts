// The live board's pure helpers (dashboard/src/lib/live.ts and thread.ts's marks): session activity, the sidebar's
// heartbeat, column working counts, change flashes, fresh rows, Thread unread counts and the visibility-aware ticker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeSessions, addFlashes, changedJobs, freshCount, pollChanges, sessionActivity, startTicker, workingCount } from '../dashboard/src/lib/live.ts';
import { threadItems, threadMarks, unreadCount, type ThreadItem } from '../dashboard/src/lib/thread.ts';

/** A fake document and timers: `fire` runs every live interval once, `show`/`hide` flip visibility and dispatch the event. */
function fakeEnv(visible = true) {
  let state = visible ? 'visible' : 'hidden';
  let clock = 1000;
  let next = 1;
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const listeners = new Set<() => void>();
  const env = {
    doc: {
      get visibilityState() {
        return state;
      },
      addEventListener: (type: string, fn: () => void) => type === 'visibilitychange' && listeners.add(fn),
      removeEventListener: (type: string, fn: () => void) => type === 'visibilitychange' && listeners.delete(fn),
    },
    setInterval: (fn: () => void, ms: number) => {
      intervals.set(next, { fn, ms });
      return next++;
    },
    clearInterval: (h: number) => void intervals.delete(h),
    now: () => clock,
  };
  const flip = (to: string) => {
    state = to;
    for (const fn of [...listeners]) fn();
  };
  return {
    env,
    intervals,
    listeners,
    advance: (ms: number) => (clock += ms),
    fire: () => [...intervals.values()].forEach((i) => i.fn()),
    show: () => flip('visible'),
    hide: () => flip('hidden'),
  };
}

test('startTicker ticks only while the tab is visible', () => {
  const f = fakeEnv(true);
  const ticks: number[] = [];
  const stop = startTicker((n) => ticks.push(n), f.env);
  assert.equal(f.intervals.size, 1, 'visible: one interval');
  assert.equal([...f.intervals.values()][0].ms, 1000, 'every 1000 ms by default');
  assert.deepEqual(ticks, [], 'no tick until the first interval');
  f.advance(1000);
  f.fire();
  f.advance(1000);
  f.fire();
  assert.deepEqual(ticks, [2000, 3000], 'each interval ticks with the current time');

  f.hide();
  assert.equal(f.intervals.size, 0, 'hidden: the interval is cleared');
  f.advance(10000);
  f.fire();
  assert.deepEqual(ticks, [2000, 3000], 'no tick while hidden');

  f.show();
  assert.deepEqual(ticks, [2000, 3000, 13000], 'visible again: one tick at once, with the caught-up time');
  assert.equal(f.intervals.size, 1, 'and the interval resumes');
  f.show();
  assert.equal(f.intervals.size, 1, 'a repeated visible event schedules no second interval');

  stop();
  assert.equal(f.intervals.size, 0, 'stop clears the interval');
  assert.equal(f.listeners.size, 0, 'and removes the listener');

  const hidden = fakeEnv(false);
  const late: number[] = [];
  const stop2 = startTicker((n) => late.push(n), hidden.env, 500);
  assert.equal(hidden.intervals.size, 0, 'started hidden: nothing scheduled');
  assert.equal(hidden.listeners.size, 1, 'but it listens for visibility');
  hidden.show();
  assert.deepEqual(late, [1000], 'shown: ticks at once');
  assert.equal([...hidden.intervals.values()][0].ms, 500, 'then every ms');
  stop2();
  assert.equal(hidden.intervals.size + hidden.listeners.size, 0);
});

const T = (m: number) => `2026-10-14T12:${String(m).padStart(2, '0')}:00.000Z`;
const prompt = (at: string): any => ({ id: at, tool: 'Bash', input: '{}', at });

test('sessionActivity: one row per kind', () => {
  const rows: [string, any, string][] = [
    ['working (busy)', { running: true, status: 'busy' }, 'working'],
    ['asking, ahead of busy', { running: true, status: 'busy', permissions: [prompt(T(1))] }, 'asking'],
    ['waiting: true', { running: false, status: 'off', waiting: true }, 'waiting'],
    ["held: 'budget'", { running: false, status: 'off', held: 'budget' }, 'waiting'],
    ['idle (running, idle)', { running: true, status: 'idle' }, 'idle'],
    ['idle (running, stopping)', { running: true, status: 'stopping' }, 'idle'],
    ['off (null session)', null, 'off'],
    ['off (not running, wanted: false)', { running: false, status: 'off', wanted: false }, 'off'],
  ];
  for (const [name, session, kind] of rows) assert.equal(sessionActivity(session).kind, kind, name);
  assert.equal(sessionActivity({ running: false, permissions: [prompt(T(1))] }).kind, 'off', 'a prompt on a stopped session is not asking');
  assert.equal(sessionActivity('nonsense' as any).kind, 'off', 'a malformed session reads as off');
});

test('sessionActivity: since precedence', () => {
  const busy = { running: true, status: 'busy' as const, lastTurnAt: T(10) };
  assert.equal(sessionActivity(busy, T(12)).since, T(12), 'a newer lastLineAt wins');
  assert.equal(sessionActivity(busy, T(5)).since, T(10), 'an older one loses to lastTurnAt');
  assert.equal(sessionActivity(busy).since, T(10), 'no lastLineAt: lastTurnAt');
  assert.equal(sessionActivity(busy, null).since, T(10));
  assert.equal(sessionActivity({ running: true, status: 'busy' }).since, null, 'neither: null');
  assert.equal(sessionActivity(busy, 'not a time').since, T(10), 'an unparseable lastLineAt is ignored');
  assert.equal(sessionActivity({ ...busy, lastTurnAt: 'garbage' }, T(3)).since, T(3), 'an unparseable lastTurnAt is ignored');
  assert.equal(sessionActivity({ running: true, status: 'idle', lastTurnAt: T(10) }, T(11)).since, T(11), 'idle uses the same rule');
  assert.equal(sessionActivity({ running: true, status: 'busy', permissions: [prompt(T(20)), prompt(T(15)), { id: 'x', at: 'bad' }] as any }, T(30)).since, T(15), "asking: the oldest prompt's at");
  assert.equal(sessionActivity({ waiting: true, lastTurnAt: T(10) }, T(11)).since, null, 'waiting: null');
  assert.equal(sessionActivity({ running: false, lastTurnAt: T(10) }, T(11)).since, null, 'off: null');
});

const busy = { running: true, status: 'busy' };
const idle = { running: true, status: 'idle' };

test('activeSessions counts working and asking sessions', () => {
  assert.deepEqual(activeSessions(null), { count: 0, ids: [] });
  assert.deepEqual(activeSessions({ inbox: idle, jobs: { a: idle, b: { running: false } } } as any), { count: 0, ids: [] }, 'all idle');
  assert.deepEqual(activeSessions({ inbox: busy, jobs: {} } as any), { count: 1, ids: ['_inbox'] }, 'a busy inbox only');
  assert.deepEqual(activeSessions({ inbox: idle, jobs: { zeta: busy, alpha: busy } } as any), { count: 2, ids: ['alpha', 'zeta'] }, 'two busy jobs, sorted');
  assert.deepEqual(activeSessions({ inbox: busy, jobs: { b: busy, a: busy } } as any).ids, ['_inbox', 'a', 'b'], 'the inbox first');
  assert.deepEqual(activeSessions({ inbox: idle, jobs: { p: { ...idle, permissions: [prompt(T(1))] } } } as any), { count: 1, ids: ['p'] }, 'asking counts');
});

test('workingCount per column', () => {
  const pool: any = { inbox: busy, jobs: { a: busy, b: { ...busy, permissions: [prompt(T(1))] }, c: idle, other: busy } };
  assert.equal(workingCount([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], pool), 1, 'only a: b is asking, c idle, d has no session');
  assert.equal(workingCount([{ id: 'other' }], pool), 1, "another column's job counts there");
  assert.equal(workingCount([{ id: 'a' }], null), 0, 'no pool');
  assert.equal(workingCount([{ id: '__proto__' }, { id: 'toString' }], pool), 0, 'ids never read Object.prototype');
});

test('changedJobs flashes only real changes', () => {
  const jobs = [
    { id: 'a', eventCount: 3, state: 'running', stage: 'build' },
    { id: 'b', eventCount: 1, state: 'waiting', stage: 'spec' },
  ];
  const first = changedJobs(null, jobs);
  assert.deepEqual(first.changed, [], 'no previous poll: no changes');
  assert.deepEqual(Object.keys(first.sigs), ['a', 'b'], 'but every signature is filled');
  assert.deepEqual(changedJobs(first.sigs, structuredClone(jobs)).changed, [], 'an identical second poll reports none');
  assert.deepEqual(changedJobs(first.sigs, [{ ...jobs[0], eventCount: 4 }, jobs[1]]).changed, ['a'], 'an eventCount change');
  assert.deepEqual(changedJobs(first.sigs, [jobs[0], { ...jobs[1], state: 'running' }]).changed, ['b'], 'a state change');
  assert.deepEqual(changedJobs(first.sigs, [{ ...jobs[0], stage: 'review' }, jobs[1]]).changed, ['a'], 'a stage change');
  const added = changedJobs(first.sigs, [...jobs, { id: 'c', eventCount: 0, state: 'queued', stage: 'intake' }]);
  assert.deepEqual(added.changed, ['c'], 'a job new against a previous poll');
  const removed = changedJobs(first.sigs, [jobs[0]]);
  assert.deepEqual(removed.changed, [], 'a removed job is not a change');
  assert.deepEqual(Object.keys(removed.sigs), ['a'], 'nor is it kept in sigs');
});

test('pollChanges: first load, event, state and stage changes, new jobs, resumed', () => {
  const jobs = [
    { id: 'a', eventCount: 3, state: 'running', stage: 'build' },
    { id: 'b', eventCount: 1, state: 'waiting', stage: 'spec' },
  ];
  const first = pollChanges(null, jobs, false);
  assert.deepEqual([first.changed, first.staged], [[], []], 'the first load reports nothing');
  assert.deepEqual(Object.keys(first.memo.sigs), ['a', 'b'], 'but fills the memo');
  const same = pollChanges(first.memo, structuredClone(jobs), false);
  assert.deepEqual([same.changed, same.staged], [[], []], 'an identical poll');
  const ev = pollChanges(first.memo, [{ ...jobs[0], eventCount: 4 }, { ...jobs[1], state: 'running' }], false);
  assert.deepEqual([ev.changed, ev.staged], [['a', 'b'], []], 'event and state changes flash but do not cool');
  const st = pollChanges(first.memo, [{ ...jobs[0], stage: 'review' }, jobs[1]], false);
  assert.deepEqual([st.changed, st.staged], [['a'], ['a']], 'a stage change does both');
  const added = pollChanges(first.memo, [...jobs, { id: 'c', eventCount: 0, state: 'queued', stage: 'intake' }], false);
  assert.deepEqual([added.changed, added.staged], [['c'], []], 'a new job is changed, never staged');
  const resumed = pollChanges(first.memo, [{ ...jobs[0], stage: 'review', eventCount: 9 }, jobs[1]], true);
  assert.deepEqual([resumed.changed, resumed.staged], [[], []], 'the poll after a failed one reports nothing');
  assert.equal(resumed.memo.stages.a, 'review', 'but rebaselines the memo');
  assert.deepEqual(pollChanges(resumed.memo, [{ ...jobs[0], stage: 'review', eventCount: 9 }, jobs[1]], false).changed, [], 'so the next poll sees no change');
});

test('addFlashes expires after 3 s', () => {
  const now = 10_000;
  const a = addFlashes({}, ['x', 'y'], now);
  assert.deepEqual(a, { x: 13_000, y: 13_000 }, 'each changed id until now + 3000');
  const b = addFlashes(a, ['z'], now + 1000);
  assert.deepEqual(b, { x: 13_000, y: 13_000, z: 14_000 }, 'unexpired entries are kept');
  const c = addFlashes(b, ['x'], now + 3500);
  assert.deepEqual(c, { x: 16_500, z: 14_000 }, 'expired y is dropped; x restarts');
  assert.deepEqual(addFlashes(c, [], now + 10_000), {}, 'all expired');
  assert.deepEqual(addFlashes({}, ['q'], 0, 500), { q: 500 }, 'ms is configurable');
});

const item = (id: string, status: ThreadItem['status'], result: string | null = null): ThreadItem => ({ id, from: 'you', action: { kind: 'request' }, text: null, status, at: null, result, secret: null });

test('unreadCount: new request, new result, status change, null seen', () => {
  const seenItems = [item('request', null), item('r1', 'queued'), item('r2', 'handling')];
  const seen = threadMarks(seenItems);
  assert.equal(unreadCount(threadMarks(seenItems), null), 0, 'null seen: nothing is unread');
  assert.equal(unreadCount(threadMarks(structuredClone(seenItems)), seen), 0, 'identical items');
  assert.equal(unreadCount(threadMarks([...seenItems, item('r3', 'queued')]), seen), 1, 'a new request');
  assert.equal(unreadCount(threadMarks([seenItems[0], seenItems[1], item('r2', 'handling', 'on it')]), seen), 1, 'a new result on a seen item');
  assert.equal(unreadCount(threadMarks([seenItems[0], item('r1', 'handling'), seenItems[2]]), seen), 1, 'a status change on a seen item');
  assert.equal(unreadCount(threadMarks([seenItems[0], item('r1', 'done', 'merged'), seenItems[2]]), seen), 1, 'a status change and a result together count 1');
  // A secret-found event is one new note; reading the Thread again changes nothing.
  const events: any = [{ v: 1, ts: '2026-10-13T00:00:09Z', type: 'secret-found', gate: 'verify', blocked: true, count: 1, findings: [] }];
  const withNote = threadItems([], null, events);
  assert.equal(unreadCount(threadMarks([...seenItems, ...withNote]), seen), 1, 'a new secret note');
  assert.equal(unreadCount(threadMarks([...seenItems, ...threadItems([], null, events)]), threadMarks([...seenItems, ...withNote])), 0, 'the same note again');
});

test('freshCount', () => {
  assert.equal(freshCount(5, null), 0, 'no baseline');
  assert.equal(freshCount(5, 5), 0);
  assert.equal(freshCount(4, 5), 0, 'total below the baseline');
  assert.equal(freshCount(7, 5), 2);
});
