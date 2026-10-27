// The Office page's report card model: which card a mandate shows, figures that are pending or have
// nothing to measure never reading as 0, and the interventions by gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { figureView, gateCounts, shownCard } from './report-card.ts';
import type { MandateReportCard, MandateRow } from './types.ts';

/** An empty mandate's card (every count 0, every figure null), with overrides. */
const card = (o: Partial<MandateReportCard> = {}): MandateReportCard => ({
  mandate: 'm1',
  at: '2026-10-02T00:00:00.000Z',
  jobs: { total: 0, reached: 0, merged: 0, inFlight: 0 },
  scores: { scored: 0, held: 0, failed: 0, pending: 0, unscored: 0, median: null, below3: null },
  review: { reviewed: 0, avgRounds: null, firstPassRate: null },
  interventions: { total: 0, byGate: {} },
  spend: { usd: 0, budgetUsd: 150, started: 0, budgetJobs: 5 },
  outcomes: { final: 0, open: 0, unmeasured: 0, reverted: null, followedUp: null, finalAt: null },
  ...o,
});

const row = (o: Partial<Pick<MandateRow, 'state' | 'card' | 'closing'>> = {}): Pick<MandateRow, 'state' | 'card' | 'closing'> => ({ state: 'active', card: card(), closing: null, ...o });

test('which card a mandate shows', () => {
  const live = card({ at: '2026-10-27T00:00:00.000Z' });
  const stored = card({ at: '2026-10-10T00:00:00.000Z', jobs: { total: 2, reached: 2, merged: 2, inFlight: 0 } });
  for (const state of ['active', 'paused', 'waiting'] as const) assert.deepEqual(shownCard(row({ state, card: live })), { card: live, source: 'live', at: null }, state);
  assert.deepEqual(shownCard(row({ state: 'closed', card: live, closing: { card: stored, outcomesFinalAt: null } })), { card: stored, source: 'close', at: '2026-10-10T00:00:00.000Z' });
  assert.deepEqual(shownCard(row({ state: 'closed', card: live, closing: { card: stored, outcomesFinalAt: '2026-10-24T00:00:00.000Z' } })), {
    card: stored,
    source: 'final',
    at: '2026-10-24T00:00:00.000Z',
  });
  assert.deepEqual(shownCard(row({ state: 'closed', card: live, closing: null })), { card: live, source: 'live', at: null }, 'no usable closing card: the live one');
});

test('figures: pending and none are never 0', () => {
  assert.deepEqual(figureView('pending'), { kind: 'pending' });
  assert.deepEqual(figureView(null), { kind: 'none' });
  assert.deepEqual(figureView(0), { kind: 'value', value: 0 });
  assert.deepEqual(figureView(3.5), { kind: 'value', value: 3.5 });
});

test('interventions by gate', () => {
  assert.deepEqual(gateCounts({ escalation: 1, none: 2, 'spec-approval': 3, budget: 0 }), [
    { key: 'spec-approval', count: 3 },
    { key: 'escalation', count: 1 },
    { key: 'none', count: 2 },
  ]);
  assert.deepEqual(gateCounts({}), []);
});
