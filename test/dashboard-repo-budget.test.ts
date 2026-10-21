import test from 'node:test';
import assert from 'node:assert/strict';
import { ackPeriod, dayMeter, isRepoHold, meterFraction, meterTone, money, monthMeter, showRepoSection } from '../dashboard/src/lib/repo-budget.ts';
import { sessionPill } from '../dashboard/src/lib/daemon.ts';
import { inboxActions, inboxDoc, inboxKind, showsNote, stateText } from '../dashboard/src/lib/view.ts';
import type { RepoBudgetStatus } from '../dashboard/src/lib/types.ts';

const status = (over: Partial<RepoBudgetStatus> = {}): RepoBudgetStatus => ({
  day: '2026-10-16',
  month: '2026-10',
  onExceeded: 'hold',
  spent: { dayUsd: 2, monthUsd: 12.34, monthTokens: 1000 },
  configured: { usdPerMonth: 100, tokensPerMonth: null, usdPerDay: 5 },
  acks: { day: 0, month: 0 },
  caps: { usdPerMonth: 100, tokensPerMonth: null, usdPerDay: 5 },
  remaining: { usdPerMonth: 87.66, tokensPerMonth: null, usdPerDay: 3 },
  projectedMonthUsd: 23.91,
  exceeded: [],
  held: false,
  reason: null,
  heldJobs: [],
  ...over,
});

test('meter fractions and tones', () => {
  assert.equal(meterFraction(25, 100), 0.25);
  assert.equal(meterFraction(150, 100), 1, 'clamped');
  assert.equal(meterFraction(0, 0), 1, 'a cap of 0 reads as full');
  assert.equal(meterFraction(5, null), null, 'uncapped');
  assert.equal(meterTone(79, 100, false), 'none');
  assert.equal(meterTone(80, 100, false), 'warn', 'warn from 80%');
  assert.equal(meterTone(100, 100, true), 'danger', 'danger when exceeded');
  assert.equal(meterTone(5, null, false), 'none');
  assert.deepEqual(monthMeter(status()), { spent: 12.34, cap: 100, remaining: 87.66, percent: 12.3, tone: 'none' });
  assert.equal(monthMeter(status({ spent: { dayUsd: 0, monthUsd: 104, monthTokens: 0 }, exceeded: ['usdPerMonth'] })).tone, 'danger');
  assert.deepEqual(dayMeter(status()), { spent: 2, cap: 5, remaining: 3, percent: 40, tone: 'none' });
  assert.equal(monthMeter(status({ caps: { usdPerMonth: null, tokensPerMonth: null, usdPerDay: null } })).percent, null);
});

test('money formats whole and fractional dollars', () => {
  assert.equal(money(100), '$100');
  assert.equal(money(12.5), '$12.50');
});

test('ack period: month first, else day', () => {
  assert.equal(ackPeriod(status()), null);
  assert.equal(ackPeriod(status({ exceeded: ['usdPerDay'] })), '2026-10-16');
  assert.equal(ackPeriod(status({ exceeded: ['tokensPerMonth', 'usdPerDay'] })), '2026-10');
  assert.equal(ackPeriod(status({ exceeded: ['usdPerMonth'] })), '2026-10');
  assert.equal(showRepoSection(status()), false);
  assert.equal(showRepoSection(status({ held: true })), true);
  assert.equal(showRepoSection(status({ heldJobs: ['a'] })), true, 'held jobs still waiting for a release');
  assert.equal(showRepoSection(undefined), false);
});

test('isRepoHold and the daemon label', () => {
  assert.equal(isRepoHold({ state: 'waiting', waitingOn: 'budget', reason: 'repo budget: $1.00 of $0.00 today' }), true);
  assert.equal(isRepoHold({ state: 'waiting', waitingOn: 'budget', reason: 'budget exceeded: usd 2/1' }), false, 'a per-job stop');
  assert.equal(isRepoHold({ state: 'queued', waitingOn: null, reason: 'repo budget: x' }), false);
  assert.equal(isRepoHold(null), false);
  assert.equal(sessionPill({ held: 'repo-budget' } as any).label, 'held: repo budget');
  assert.equal(sessionPill({ held: 'budget' } as any).label, 'held: budget');
});

test('a repo-held card offers only Cancel, with its own chip label', () => {
  const repo = { state: 'waiting', waitingOn: 'budget', reason: 'repo budget: $103.20 of $100 this month' } as const;
  const own = { state: 'waiting', waitingOn: 'budget', reason: 'budget exceeded: usd 2/1' } as const;
  assert.equal(inboxKind(repo), 'repo-budget');
  assert.deepEqual(inboxActions(inboxKind(repo)), [{ label: 'Cancel job', type: 'cancel', primary: false, needsNote: false }], 'no Approve: approving lifts no repo cap');
  assert.equal(showsNote(inboxKind(repo)), false, 'no new-limits note');
  assert.equal(inboxDoc(inboxKind(repo), repo), null);
  assert.equal(stateText(repo), 'Repo budget');
  // A job's own budget stop is unchanged.
  assert.equal(inboxKind(own), 'budget');
  assert.deepEqual(inboxActions(inboxKind(own)).map((a) => a.label), ['Approve & continue', 'Cancel job']);
  assert.equal(showsNote(inboxKind(own)), true);
  assert.equal(stateText(own), 'Budget exceeded');
});
