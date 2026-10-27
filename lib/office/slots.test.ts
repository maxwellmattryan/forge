// The machine cap's slot gate over fake members: the cap, which waiter a free slot goes to, that a pool
// held only by its own cap never blocks another, which idle sessions a reclaim stops, and the pokes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { counted, createMachineSlots, sessionKind, type MachineSlots, type SlotMember } from './slots.ts';

interface Fake extends SlotMember {
  name: string;
  pokes: number;
  stopped: string[];
}

function fake(name: string, o: { live?: number; max?: number; oldest?: string | null; idle?: [string, string | null][]; stopping?: number } = {}): Fake {
  const m: Fake = {
    name,
    pokes: 0,
    stopped: [],
    live: () => o.live ?? 0,
    maxConcurrent: () => o.max ?? 1,
    oldestWaiting: () => o.oldest ?? null,
    idle: () => (o.idle ?? []).map(([id, at]) => ({ lastResultAt: at, stop: () => void m.stopped.push(id) })),
    stopping: () => o.stopping ?? 0,
    poke: () => void m.pokes++,
  };
  return m;
}

const gate = (setting: number | null, ...members: Fake[]): MachineSlots => {
  const s = createMachineSlots(() => setting);
  for (const m of members) s.join(m);
  return s;
};

describe('machine slots', () => {
  const caps: { name: string; setting: number | null; members: Fake[]; want: number }[] = [
    { name: 'the settings value wins', setting: 3, members: [fake('a', { max: 8 })], want: 3 },
    { name: 'unset: the highest member maxConcurrent', setting: null, members: [fake('a', { max: 2 }), fake('b', { max: 5 })], want: 5 },
    { name: 'unset with no members: 1', setting: null, members: [], want: 1 },
  ];
  for (const r of caps) it(`cap(): ${r.name}`, () => assert.equal(gate(r.setting, ...r.members).cap(), r.want));

  it('live() sums the members, and a member that leaves stops counting', () => {
    const s = createMachineSlots(() => null);
    s.join(fake('a', { live: 1 }));
    const leave = s.join(fake('b', { live: 2 }));
    assert.equal(s.live(), 3);
    leave();
    assert.equal(s.live(), 1);
  });

  const takes: { name: string; setting: number; members: Fake[]; asker: number; oldest: string; want: boolean }[] = [
    { name: 'no free slot', setting: 2, members: [fake('a', { live: 1 }), fake('b', { live: 1 })], asker: 0, oldest: '1', want: false },
    { name: 'a free slot and no other waiter', setting: 2, members: [fake('a', { live: 1 }), fake('b')], asker: 1, oldest: '5', want: true },
    { name: "another member's held waiter is older", setting: 2, members: [fake('a', { live: 1, oldest: '3' }), fake('b')], asker: 1, oldest: '5', want: false },
    { name: "another member's held waiter is newer", setting: 2, members: [fake('a', { live: 1, oldest: '7' }), fake('b')], asker: 1, oldest: '5', want: true },
    // A member at its own maxConcurrent reports no held waiter (SlotMember.oldestWaiting), so it never blocks.
    { name: 'a member held only by its own cap', setting: 4, members: [fake('a', { live: 1, max: 1, oldest: null }), fake('b')], asker: 1, oldest: '5', want: true },
    { name: "the asker's own held waiter never blocks it", setting: 2, members: [fake('a', { oldest: '1' })], asker: 0, oldest: '5', want: true },
  ];
  for (const r of takes) {
    it(`mayTake: ${r.name}`, () => {
      const s = gate(r.setting, ...r.members);
      assert.equal(s.mayTake(r.members[r.asker]!, r.oldest), r.want);
    });
  }

  it('mayTake refused for an older waiter pokes that member', async () => {
    const a = fake('a', { oldest: '1' });
    const b = fake('b');
    assert.equal(gate(2, a, b).mayTake(b, '5'), false);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([a.pokes, b.pokes], [1, 0]);
  });

  const reclaims: { name: string; setting: number; members: () => Fake[]; n: number; want: Record<string, string[]> }[] = [
    {
      name: 'stops idle sessions in other members, oldest result first, up to n',
      setting: 3,
      members: () => [fake('a', { live: 1 }), fake('b', { live: 1, idle: [['b1', '2026-10-24T10:00:00Z'], ['b2', '2026-10-24T08:00:00Z']] }), fake('c', { live: 1, idle: [['c1', '2026-10-24T09:00:00Z']] })],
      n: 2,
      want: { a: [], b: ['b2'], c: ['c1'] },
    },
    { name: "never the asker's own", setting: 1, members: () => [fake('a', { live: 1, idle: [['a1', 't']] }), fake('b')], n: 1, want: { a: [], b: [] } },
    { name: 'a free slot counts against n', setting: 2, members: () => [fake('a'), fake('b', { live: 1, idle: [['b1', 't']] })], n: 1, want: { a: [], b: [] } },
    { name: 'a session already stopping counts against n', setting: 1, members: () => [fake('a'), fake('b', { live: 1, stopping: 1, idle: [['b1', 't']] })], n: 1, want: { a: [], b: [] } },
  ];
  for (const r of reclaims) {
    it(`reclaim: ${r.name}`, () => {
      const members = r.members();
      gate(r.setting, ...members).reclaim(members[0]!, r.n);
      assert.deepEqual(Object.fromEntries(members.map((m) => [m.name, m.stopped])), r.want);
    });
  }

  const kinds: [string, string, boolean][] = [
    ['_inbox', 'inbox', false],
    ['_office', 'office', false],
    ['_chat-0123456789ab', 'chat', false],
    ['j-1', 'job', true],
  ];
  for (const [scope, kind, isCounted] of kinds) {
    it(`sessionKind(${scope}) is ${kind}, ${isCounted ? '' : 'not '}counted`, () => {
      assert.equal(sessionKind(scope), kind);
      assert.equal(counted(scope), isCounted);
    });
  }

  it('freed pokes every other member', () => {
    const [a, b, c] = [fake('a'), fake('b'), fake('c')];
    gate(2, a, b, c).freed(a);
    assert.deepEqual([a.pokes, b.pokes, c.pokes], [0, 1, 1]);
  });
});
