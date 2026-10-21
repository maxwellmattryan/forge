import test from 'node:test';
import assert from 'node:assert/strict';
import { activityLine, newestActivity, ownerLiveness, roundAgents, sortedActivity } from '../dashboard/src/lib/agent-activity.ts';

const NOW = Date.parse('2026-10-15T10:10:00.000Z');
const act = (role: string, startedAt: string | null, over: Record<string, unknown> = {}) => ({ role, model: 'opus', startedAt, last: null, ...over }) as any;
const owner = (status: string, renewedAt: string | null) => ({ status, session: 's', since: '2026-10-15T09:00:00.000Z', renewedAt, expiresAt: null, epoch: 1, jobSession: false }) as any;

test('activityLine gives role, model, elapsed time and the last thing', () => {
  const a = act('reviewer:security', '2026-10-15T10:06:00.000Z', { last: { kind: 'tool', text: 'Read lib/server.ts', at: null } });
  assert.deepEqual(activityLine(a, NOW), { role: 'reviewer:security', model: 'opus', elapsed: '4m 0s', last: 'Read lib/server.ts' });
  assert.equal(activityLine(act('builder', '2026-10-15T10:06:00.000Z', { model: null }), NOW).model, '—');
  assert.equal(activityLine(act('builder', '2026-10-15T10:06:00.000Z'), NOW).last, null, 'no transcript: the line ends after the elapsed time');
  assert.equal(activityLine(act('builder', null), NOW).elapsed, '—');
  // Markup stays a plain string for the template to escape.
  assert.equal(activityLine(act('b', null, { last: { kind: 'text', text: '<img onerror=x>', at: null } }), NOW).last, '<img onerror=x>');
});

test('newestActivity picks the latest start and counts the rest', () => {
  assert.deepEqual(newestActivity([]), { newest: null, more: 0 });
  assert.deepEqual(newestActivity(undefined), { newest: null, more: 0 });
  const list = [act('a', '2026-10-15T10:00:00.000Z'), act('b', '2026-10-15T10:05:00.000Z'), act('c', null)];
  const r = newestActivity(list);
  assert.equal(r.newest?.role, 'b');
  assert.equal(r.more, 2);
  assert.deepEqual(sortedActivity(list).map((x) => x.role), ['b', 'a', 'c']);
});

test('ownerLiveness tones a live and an expired lease, and hides a missing driver', () => {
  assert.deepEqual(ownerLiveness(owner('live', '2026-10-15T10:09:40.000Z'), NOW), { tone: 'ok', status: 'live', age: '20s ago' });
  assert.deepEqual(ownerLiveness(owner('expired', '2026-10-15T09:29:00.000Z'), NOW), { tone: 'warn', status: 'expired', age: '41m ago' });
  assert.deepEqual(ownerLiveness(owner('expired', null), NOW), { tone: 'warn', status: 'expired', age: '1h ago' }, 'never renewed: the age is the claim time');
  assert.deepEqual(ownerLiveness(owner('none', null), NOW), { tone: null, status: null, age: null });
  assert.deepEqual(ownerLiveness(null, NOW), { tone: null, status: null, age: null });
});

test('roundAgents sorts newest first and times running agents live', () => {
  const row = (role: string, status: string, startedAt: string | null, durationMs: number | null) => ({ role, status, model: 'opus', startedAt, endedAt: null, durationMs, tokens: null, transcript: true });
  const rows = roundAgents({ agents: [row('builder', 'done', '2026-10-15T09:00:00.000Z', 60_000), row('reviewer:code', 'running', '2026-10-15T10:08:00.000Z', null), row('reviewer:ui', 'lost', '2026-10-15T09:30:00.000Z', 1000)] }, NOW);
  assert.deepEqual(rows.map((r) => r.role), ['reviewer:code', 'reviewer:ui', 'builder']);
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].elapsedMs, 120_000);
  assert.equal(rows[2].elapsedMs, 60_000);
  assert.deepEqual(roundAgents(null, NOW), []);
});
