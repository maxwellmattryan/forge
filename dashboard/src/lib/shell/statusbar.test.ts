// The status bar's lamps: the Inbox indicator's lamp follows the inbox session alone, while Workers keeps the pool-wide rule;
// the Foreman indicator follows the office runs and the gate runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { barLamps, barModel, foremanIndicator } from './statusbar.ts';

test('foremanIndicator: active for a live office or gate run, its error the office cap', () => {
  const prompt = { id: 'p1', tool: 'Bash', input: '{}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-26T00:00:00.000Z' };
  const office = (live: number, held: object | null = null) => ({ enabled: true, live, held, runs: [] });
  const gates = (live: number) => ({ enabled: true, parallel: 2, live, held: null, runs: [] });
  const base = { enabled: true, wanted: true, maxConcurrent: 2, live: 0, lastError: null, foreman: true, office: office(0), gates: gates(0), jobs: {}, permissionModes: {} };
  const cap = { reason: 'daily-cap', until: null, message: 'daemon stopped: the office runs and gate runs spent $1.05 of the $1.00 daily cap' };
  const rows: [string, object, { active: boolean; pill: string; officeError: string | null }][] = [
    ['idle', base, { active: false, pill: 'idle', officeError: null }],
    ['a live gate run', { ...base, gates: gates(1) }, { active: true, pill: 'busy', officeError: null }],
    ['a live office run', { ...base, office: office(1) }, { active: true, pill: 'busy', officeError: null }],
    ["a job's prompt is not the Foreman's", { ...base, jobs: { 'a-job': { scope: 'a-job', status: 'idle', running: true, permissions: [prompt] } } }, { active: false, pill: 'idle', officeError: null }],
    ['the office cap', { ...base, office: office(0, cap) }, { active: false, pill: 'idle', officeError: cap.message }],
    ['a retry hold is no error', { ...base, office: office(0, { reason: 'retry', until: '2026-10-26T01:00:00.000Z', message: 'x' }) }, { active: false, pill: 'idle', officeError: null }],
    ['the pool not wanted', { ...base, wanted: false }, { active: false, pill: 'stopped', officeError: null }],
    ['an older server with no gates or runs', { ...base, gates: undefined, office: { scope: '_office', status: 'busy' } }, { active: false, pill: 'idle', officeError: null }],
  ];
  for (const [name, pool, want] of rows) {
    const f = foremanIndicator(pool as any, true);
    assert.ok(f.on, name);
    assert.deepEqual({ active: f.active, pill: f.pill.label, officeError: f.officeError }, want, name);
  }
  assert.deepEqual(foremanIndicator({ ...base, foreman: false } as any, true), { on: false });
  const lamps = (pool: object) => barLamps(barModel(pool as any, { pending: false }), { needs: 0, conn: 'live' }).foreman;
  assert.deepEqual([lamps(base), lamps({ ...base, gates: gates(1) }), lamps({ ...base, office: office(1) })], ['done', 'working', 'working']);
});

test('barLamps: the Inbox lamp follows the inbox session only', () => {
  const prompt = { id: 'p1', tool: 'Bash', input: '{}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-26T00:00:00.000Z' };
  const base = { enabled: true, wanted: true, maxConcurrent: 2, live: 0, lastError: null, foreman: false, jobs: {}, permissionModes: {} };
  const idle = { scope: '_inbox', status: 'idle', running: true, wanted: true };
  const rows: [string, object, string, string | null][] = [
    ['daemon off', { ...base, enabled: false, wanted: false }, 'idle', 'idle'],
    ['enabled, no inbox session', base, 'idle', null],
    ['inbox running idle', { ...base, inbox: idle }, 'done', null],
    ['inbox busy', { ...base, inbox: { ...idle, status: 'busy' } }, 'working', 'working'],
    ['inbox prompt', { ...base, inbox: { ...idle, permissions: [prompt] } }, 'you', 'you'],
    ['job prompt', { ...base, inbox: idle, live: 1, jobs: { 'a-job': { scope: 'a-job', status: 'idle', running: true, wanted: true, permissions: [prompt] } } }, 'done', 'you'],
  ];
  for (const [name, pool, inbox, workers] of rows) {
    const lamps = barLamps(barModel(pool as any, { pending: false }), { needs: 0, conn: 'live' });
    assert.equal(lamps.inbox, inbox, `${name}: inbox`);
    if (workers !== null) assert.equal(lamps.workers, workers, `${name}: workers`);
  }
  const lamps = barLamps(barModel(base as any, { pending: false }), { needs: 0, conn: 'live' });
  assert.deepEqual(Object.keys(lamps).sort(), ['connection', 'foreman', 'inbox', 'needs', 'workers']);
});

test('barModel counts the job sessions the machine cap holds', () => {
  const base = { enabled: true, wanted: true, maxConcurrent: 2, live: 1, lastError: null, foreman: false, permissionModes: {}, machine: { maxConcurrent: 1, live: 1 } };
  const job = (waitingFor: string | null) => ({ status: 'off', running: false, wanted: true, waiting: waitingFor !== null, waitingFor });
  const rows: [string, object, { waiting: number; machineWaiting: number }][] = [
    ['one on the machine cap, one on its own', { ...base, jobs: { a: job('machine'), b: job('project') } }, { waiting: 2, machineWaiting: 1 }],
    ['an older server sends no waitingFor', { ...base, jobs: { a: { status: 'off', running: false, wanted: true, waiting: true } } }, { waiting: 1, machineWaiting: 0 }],
    ['the daemon off', { ...base, enabled: false, wanted: false, live: 0, jobs: { a: job('machine') } }, { waiting: 0, machineWaiting: 0 }],
  ];
  for (const [name, pool, want] of rows) {
    const m = barModel(pool as any, { pending: false });
    assert.deepEqual({ waiting: m.waiting, machineWaiting: m.machineWaiting }, want, name);
  }
});
