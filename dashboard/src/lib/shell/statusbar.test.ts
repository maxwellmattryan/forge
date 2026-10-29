// The status bar's lamps: the Inbox indicator's lamp follows the inbox session alone, while Workers keeps the pool-wide rule;
// the Foreman indicator follows the office session and the gate runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { barLamps, barModel, foremanIndicator } from './statusbar.ts';

test('foremanIndicator: active for a live gate run, prompts only the office', () => {
  const prompt = { id: 'p1', tool: 'Bash', input: '{}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-26T00:00:00.000Z' };
  const office = { scope: '_office', status: 'idle', running: true, wanted: true, lastError: null };
  const gates = (live: number) => ({ enabled: true, parallel: 2, live, held: null, runs: [] });
  const base = { enabled: true, wanted: true, maxConcurrent: 2, live: 0, lastError: null, foreman: true, office, gates: gates(0), jobs: {}, permissionModes: {} };
  const rows: [string, object, { active: boolean; prompts: number; officeError: string | null }][] = [
    ['idle', base, { active: false, prompts: 0, officeError: null }],
    ['a live gate run', { ...base, gates: gates(1) }, { active: true, prompts: 0, officeError: null }],
    ['the office busy', { ...base, office: { ...office, status: 'busy' } }, { active: true, prompts: 0, officeError: null }],
    ['an office prompt', { ...base, office: { ...office, permissions: [prompt] } }, { active: false, prompts: 1, officeError: null }],
    ["a job's prompt is not the Foreman's", { ...base, jobs: { 'a-job': { scope: 'a-job', status: 'idle', running: true, permissions: [prompt] } } }, { active: false, prompts: 0, officeError: null }],
    ['an office error', { ...base, office: { ...office, lastError: 'daily cap reached' } }, { active: false, prompts: 0, officeError: 'daily cap reached' }],
    ['an older server with no gates', { ...base, gates: undefined }, { active: false, prompts: 0, officeError: null }],
  ];
  for (const [name, pool, want] of rows) {
    const f = foremanIndicator(pool as any, true);
    assert.ok(f.on, name);
    assert.deepEqual({ active: f.active, prompts: f.prompts, officeError: f.officeError }, want, name);
  }
  assert.deepEqual(foremanIndicator({ ...base, foreman: false } as any, true), { on: false });
  const lamps = (pool: object) => barLamps(barModel(pool as any, { pending: false }), { needs: 0, conn: 'live' }).foreman;
  assert.deepEqual([lamps(base), lamps({ ...base, gates: gates(1) }), lamps({ ...base, office: { ...office, permissions: [prompt] } })], ['done', 'working', 'you']);
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
