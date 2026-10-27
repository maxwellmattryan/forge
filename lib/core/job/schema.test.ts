// normalizeJob on a current-version job: the fields it reads one by one, so a partial or planted value
// never reads as something it isn't. Migrations from older versions are test/schema.test.ts's tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOB_SCHEMA_VERSION, normalizeJob } from './schema.ts';

test('a current-version lease is read field by field', () => {
  // A partial or planted lease never reads as live by accident.
  assert.deepEqual(normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION, id: 'x' }).lease, { driver: null, epoch: 0, since: null, renewedAt: null, expiresAt: null });
  assert.deepEqual(normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION, id: 'x', lease: { driver: 'S', epoch: -2, expiresAt: 42 } }).lease, { driver: 'S', epoch: 0, since: null, renewedAt: null, expiresAt: null });
});

test('a shelf record is kept only well formed and only on a job waiting on shelved', () => {
  const at = '2026-10-01T10:00:00.000Z';
  const shelf = { at, reason: ' later\u0007 `x` ', actor: { login: 'al', source: 'gh' }, from: { state: 'waiting', waitingOn: 'escalation', reason: 'touches billing' } };
  const read = (shelved: unknown, waitingOn = 'shelved') => normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION, id: 'x', state: 'waiting', waitingOn, shelved }).shelved;
  assert.deepEqual(read(shelf), { ...shelf, reason: 'later x' }, 'the reason is cleaned again');
  assert.equal(read(shelf, 'escalation'), null, 'a job off the shelf keeps none');
  const queued = { ...shelf, from: { state: 'queued', waitingOn: null, reason: null } };
  assert.deepEqual(read(queued)?.from, queued.from);
  assert.deepEqual(read({ ...shelf, actor: { login: 'al', source: 'root' } })?.actor, { login: null, source: 'unknown' }, 'an unknown source keeps no login');
  const malformed: [string, unknown][] = [
    ['a bad time', { ...shelf, at: 'yesterday' }],
    ['an empty reason', { ...shelf, reason: '``' }],
    ['from running', { ...shelf, from: { state: 'running', waitingOn: null, reason: null } }],
    ['from the shelf', { ...shelf, from: { state: 'waiting', waitingOn: 'shelved', reason: null } }],
    ['a wait with no waitingOn', { ...shelf, from: { state: 'waiting', waitingOn: null, reason: null } }],
    ['a queued job with a waitingOn', { ...shelf, from: { state: 'queued', waitingOn: 'escalation', reason: null } }],
    ['a reason that is not text', { ...shelf, from: { ...shelf.from, reason: 3 } }],
    ['no record', 'shelved'],
  ];
  for (const [name, raw] of malformed) assert.equal(read(raw), null, name);
});

test('a finished-while-shelved mark is kept only as true, and only on a done or cancelled job', () => {
  const read = (mark: unknown, state: string) => normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION, id: 'x', state, finishedWhileShelved: mark }).finishedWhileShelved;
  assert.deepEqual([read(true, 'cancelled'), read(true, 'done')], [true, true]);
  assert.deepEqual([read(true, 'queued'), read(true, 'waiting'), read('true', 'cancelled'), read(1, 'done'), read(undefined, 'cancelled')], [false, false, false, false, false]);
});
