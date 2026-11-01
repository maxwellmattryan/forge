// The machine cap's slot gate over fake members: the opt-in cap, that a free slot never waits on another
// member's waiter, and which members a freed slot pokes; and which session spawns get Forge's browser.
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, updateJob } from '#core/job/store.ts';
import { browserMcpConfig } from '#integrations/claude/browser.ts';
import { counted, createMachineSlots, sessionBrowser, sessionKind, type MachineSlots, type SlotMember } from './slots.ts';

test('sessionBrowser gives the browser only to a job whose spec needs UI proof', (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  const UI_SPEC = '# Spec\n\n## Acceptance criteria\n- [ ] AC1 — the list renders · Proven by: screenshots/ac1-list-375.png\n';
  const job = (spec: string | null, port: number | null) => {
    const { id } = createJob(root, defaults(), { title: `job ${spec === null ? 'no spec' : 'spec'} ${port}` });
    if (spec !== null) fs.writeFileSync(path.join(root, '.forge', 'jobs', id, 'spec.md'), spec);
    updateJob(root, id, (j) => {
      j.port = port;
    });
    return id;
  };
  // The machine's npx, found on an absolute PATH entry only: the session's PATH, here a scratch dir holding one.
  const bin = path.join(root, '.git', 'scratch-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'npx.cmd' : 'npx'), '', { mode: 0o755 });
  const env = { PATH: bin };
  const ui = job(UI_SPEC, 7412);
  const want = browserMcpConfig({ root, port: 7412, outputDir: path.join(root, '.forge', 'jobs', ui, 'screenshots'), env });
  assert.equal(typeof want, 'string');
  assert.equal(sessionBrowser(root, ui, env), want);
  assert.equal(sessionBrowser(root, ui, { PATH: '' }), null, 'no npx on the PATH: no browser');
  const none: [string, string][] = [
    ['the inbox', '_inbox'],
    ['the office', '_office'],
    ['a chat', '_chat-0123456789ab'],
    ['no spec.md', job(null, 7412)],
    ['no UI AC', job('# Spec\n\n## Acceptance criteria\n- [ ] AC1 — the API answers · Proven by: a test\n', 7412)],
    ['a null port', job(UI_SPEC, null)],
    ['an unreadable job', 'no-such-job'],
  ];
  if (process.platform !== 'win32') {
    // A planted link or FIFO is no spec: it never steers or stalls a spawn.
    const linked = job(null, 7412);
    const outside = path.join(root, 'ui-spec.md');
    fs.writeFileSync(outside, UI_SPEC);
    fs.symlinkSync(outside, path.join(root, '.forge', 'jobs', linked, 'spec.md'));
    const fifo = job(null, 7412);
    execFileSync('mkfifo', [path.join(root, '.forge', 'jobs', fifo, 'spec.md')]);
    none.push(['a linked spec.md', linked], ['a FIFO spec.md', fifo]);
  }
  for (const [name, scope] of none) assert.equal(sessionBrowser(root, scope, env), null, name);
});

interface Fake extends SlotMember {
  name: string;
  pokes: number;
}

function fake(name: string, o: { live?: number; held?: boolean } = {}): Fake {
  const m: Fake = {
    name,
    pokes: 0,
    live: () => o.live ?? 0,
    held: () => o.held ?? false,
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
  const caps: { name: string; setting: number | null; members: Fake[]; want: number | null }[] = [
    { name: 'the settings value', setting: 3, members: [fake('a', { live: 8 })], want: 3 },
    { name: 'unset: no machine cap, even with members', setting: null, members: [fake('a', { live: 2 }), fake('b', { live: 5 })], want: null },
    { name: 'unset with no members: no machine cap', setting: null, members: [], want: null },
    { name: 'a non-integer setting counts as unset', setting: 2.5, members: [fake('a')], want: null },
    { name: 'a setting below 1 counts as unset', setting: 0, members: [fake('a')], want: null },
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

  const takes: { name: string; setting: number | null; members: Fake[]; asker: number; want: boolean }[] = [
    { name: 'unset: true however many sessions run machine-wide', setting: null, members: [fake('a', { live: 16 }), fake('b', { live: 16, held: true })], asker: 1, want: true },
    { name: 'no free slot', setting: 2, members: [fake('a', { live: 1 }), fake('b', { live: 1 })], asker: 0, want: false },
    { name: 'a free slot', setting: 2, members: [fake('a', { live: 1 }), fake('b')], asker: 1, want: true },
    { name: "another member's held waiter never blocks a free slot", setting: 2, members: [fake('a', { live: 1, held: true }), fake('b')], asker: 1, want: true },
    { name: "the asker's own held waiter never blocks it", setting: 2, members: [fake('a', { held: true })], asker: 0, want: true },
  ];
  for (const r of takes) {
    it(`mayTake: ${r.name}`, () => {
      const s = gate(r.setting, ...r.members);
      assert.equal(s.mayTake(r.members[r.asker]!), r.want);
    });
  }

  const frees: { name: string; setting: number | null; held: boolean[]; want: number[] }[] = [
    { name: 'unset: pokes no member, held or not', setting: null, held: [true, true, false], want: [0, 0, 0] },
    { name: 'set: pokes only the other held members', setting: 2, held: [false, true, false], want: [0, 1, 0] },
    { name: 'set: never the asker itself, held or not', setting: 2, held: [true, true, true], want: [0, 1, 1] },
  ];
  for (const r of frees) {
    it(`freed: ${r.name}`, async () => {
      const members = r.held.map((held, i) => fake(`m${i}`, { held }));
      gate(r.setting, ...members).freed(members[0]!);
      await new Promise((done) => setImmediate(done));
      assert.deepEqual(members.map((m) => m.pokes), r.want);
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
});
