// The status bar's lamps: the Inbox indicator's lamp follows the inbox session alone, while Workers keeps the pool-wide rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { barLamps, barModel } from './statusbar.ts';

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
