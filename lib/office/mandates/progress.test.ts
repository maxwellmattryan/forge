// A mandate's progress reads only the CLI's records: its jobs' classes against its until, its spend
// and starts, and the candidates its scope offers, in its order, one milestone at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, jobDir, logEvent, setJob, updateJob } from '#core/job/store.ts';
import { archiveJob } from '#engine/ops/retention.ts';
import { FOREMAN_ACTOR } from '#integrations/github/actor.ts';
import { applyInput, blankMandate, fillDefaults } from './contract.ts';
import { logDirective } from './directives.ts';
import { bounceHold, classifyJob, mandateProgress, readProgressCtx } from './progress.ts';
import { listMandates, writeMandate } from './store.ts';
import type { Config, Job, JobEvent, Tracker, TrackerItem } from '#core/types.ts';
import type { Mandate, MandateInput } from './types.ts';
import type { ProgressCtx } from './progress.ts';

function scratch(t: test.TestContext, patch: (c: Config) => void = () => {}): { root: string; config: Config } {
  const r = tempRepo();
  t.after(r.cleanup);
  const config = defaults();
  config.foreman.enabled = true;
  config.tracker.kind = 'github';
  config.tracker.github.repo = 'acme/web';
  patch(config);
  return { root: r.dir, config };
}

function mandate(root: string, config: Config, id: string, input: MandateInput): void {
  writeMandate(root, () => ({ mandate: applyInput(blankMandate(id, new Date().toISOString()), fillDefaults(config, { title: id, ...input })), action: 'new' as const }));
}

const item = (n: number, extra: Partial<TrackerItem> = {}): TrackerItem => ({ ref: String(n), title: `Issue ${n}`, labels: [], needsInfo: false, priority: null, ...extra });

/** A tracker that lists each milestone's items (the key '' for no milestone); `scope: false` leaves the method out. */
function stub(byMilestone: Record<string, TrackerItem[]>, opts: { scope?: boolean } = {}): Tracker {
  const t: Partial<Tracker> = { name: 'stub', list: () => [], get: () => null, claim: () => ({ ok: true }) };
  if (opts.scope !== false) t.scope = (_ctx, q) => byMilestone[q.milestone ?? ''] ?? [];
  return t as Tracker;
}

const issue = (n: number) => [{ tracker: 'github', ref: `acme/web#${n}` }] as Parameters<typeof createJob>[2]['issues'];

function progress(root: string, config: Config, id: string, tracker: Tracker | null, over: Partial<ProgressCtx> = {}) {
  const all = listMandates(root);
  const m = all.find((x) => x.id === id) as Mandate;
  return mandateProgress(root, config, m, all, { ...readProgressCtx(root, config, { tracker, trackerError: null }), ...over });
}

const classOf = (p: ReturnType<typeof progress>, id: string) => p.jobs.find((j) => j.id === id)?.class;

test("a mandate's jobs, spend and candidates", async (t) => {
  await t.test('(a) a pr-review job with a PR is reached under merge-ready and in flight under merged', (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'], until: 'merged' });
    const j = jobAt(root, 'pr', { create: { mandate: 'm1', issues: issue(1) }, state: 'waiting', waitingOn: 'pr-review', pr: { number: 7, url: 'https://github.com/acme/web/pull/7', state: 'OPEN' } });
    // until merged applies only under foreman.ship: merge; otherwise merge-ready.
    assert.equal(classOf(progress(root, config, 'm1', stub({})), j.id), 'reached');
    config.foreman.ship = 'merge';
    assert.equal(classOf(progress(root, config, 'm1', stub({})), j.id), 'inFlight');
  });

  await t.test('(b) a cancelled job is handled; a failed one is unfinishable until a mandate-unfinishable event follows', (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] });
    const cancelled = jobAt(root, 'build', { create: { mandate: 'm1' }, state: 'cancelled' });
    const failed = jobAt(root, 'build', { create: { mandate: 'm1' }, state: 'failed' });
    let p = progress(root, config, 'm1', stub({}));
    assert.deepEqual([classOf(p, cancelled.id), classOf(p, failed.id)], ['handled', 'unfinishable']);
    logEvent(root, failed.id, 'mandate-unfinishable', { mandate: 'm1', action: 'park', why: 'failed' });
    p = progress(root, config, 'm1', stub({}));
    assert.equal(classOf(p, failed.id), 'handled');
    assert.deepEqual(p.counts, { reached: 0, inFlight: 0, handled: 2, unfinishable: 0 });
  });

  await t.test("(c) spend sums the mandate's live and archived jobs, from the CLI records", (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] });
    mandate(root, config, 'm2', { milestones: ['M2'] });
    const live = jobAt(root, 'build', { create: { mandate: 'm1' } });
    const gone = jobAt(root, 'done', { create: { mandate: 'm1' } });
    archiveJob(root, gone.id, 'cli', { config });
    const other = jobAt(root, 'build', { create: { mandate: 'm2' } });
    const bucket = (usd: number) => ({ runs: 1, tokens: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd });
    const entry = (b: number, m: number, own = 0) =>
      ({ source: 'live', size: 0, mtimeMs: 0, meterSize: 0, meterMtimeMs: 0, usageSize: 0, usageMtimeMs: 0, kind: null, title: '', buckets: { k: bucket(b) }, metered: { k: bucket(m) }, orchestrator: own ? { k: bucket(own) } : {} }) as ProgressCtx['ledger'][string];
    // The live job's session usage (role orchestrator) overlaps its meter, so it never adds to the mandate's spend.
    const ledger = { [live.id]: entry(1.5, 0.5, 50), [gone.id]: entry(2, 0), [other.id]: entry(100, 0) };
    const p = progress(root, config, 'm1', stub({}), { ledger });
    assert.equal(p.spentUsd, 4);
    assert.deepEqual(p.jobs.map((j) => [j.id, j.live]).sort(), [[gone.id, false], [live.id, true]].sort());
    // The session-writable mirror: dropping the mandate there changes nothing Forge reads.
    const mirror = path.join(jobDir(root, live.id), 'job.json');
    fs.writeFileSync(mirror, JSON.stringify({ ...JSON.parse(fs.readFileSync(mirror, 'utf8')), mandate: null }));
    assert.equal(progress(root, config, 'm1', stub({}), { ledger }).spentUsd, 4);
  });

  await t.test('(d) started counts a split parent and not its children', (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] });
    const parent = jobAt(root, 'build', { create: { mandate: 'm1' } });
    for (const n of [1, 2]) createJob(root, config, { title: `child ${n}`, parent: parent.id, mandate: 'm1' });
    const p = progress(root, config, 'm1', stub({}));
    assert.equal(p.jobs.length, 3);
    assert.equal(p.started, 1);
  });

  await t.test('(e) candidates leave out needs-info, issues carried elsewhere and skipped issues', (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] });
    jobAt(root, 'build', { create: { issues: issue(3) } });
    logDirective(root, { mandate: 'm1', action: 'skip', issue: 'acme/web#4', reason: 'closed upstream', actor: FOREMAN_ACTOR });
    const p = progress(root, config, 'm1', stub({ M1: [item(2, { needsInfo: true }), item(3), item(4), item(5)] }));
    assert.deepEqual(p.candidates.map((c) => c.ref), ['acme/web#5']);
    assert.deepEqual([p.needsInfo, p.elsewhere, p.skipped], [['acme/web#2'], ['acme/web#3'], [{ issue: 'acme/web#4', why: 'closed upstream' }]]);
  });

  await t.test("(f) a second milestone's issues wait until the first has no open work", (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1', 'M2'], maxJobs: 3 });
    const tracker = stub({ M1: [item(1)], M2: [item(2)] });
    assert.deepEqual(progress(root, config, 'm1', tracker).candidates.map((c) => c.ref), ['acme/web#1']);
    const j = jobAt(root, 'build', { create: { mandate: 'm1', issues: issue(1) } });
    assert.deepEqual(progress(root, config, 'm1', tracker).candidates, [], 'M1 still has work in flight');
    setJob(root, j.id, { stage: 'done', state: 'done' });
    assert.deepEqual(progress(root, config, 'm1', tracker).candidates.map((c) => c.ref), ['acme/web#2']);
  });

  await t.test('(g) priority orders by priority then number; listed keeps the written order', (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'p', { milestones: ['M1'], order: 'priority', maxJobs: 4 });
    mandate(root, config, 'l', { issues: ['acme/web#9', 'acme/web#2'], order: 'listed', maxJobs: 2 });
    const tracker = stub({ M1: [item(3, { priority: 'P2' }), item(1, { priority: 'P10' }), item(2), item(4, { priority: 'P2' }), item(5, { priority: 'P1' })] });
    assert.deepEqual(progress(root, config, 'p', tracker).candidates.map((c) => c.ref), ['acme/web#5', 'acme/web#3', 'acme/web#4', 'acme/web#1', 'acme/web#2']);
    const listed = progress(root, config, 'l', null);
    assert.deepEqual(listed.candidates.map((c) => c.ref), ['acme/web#9', 'acme/web#2']);
    assert.deepEqual(listed.window.map((c) => c.ref), ['acme/web#9', 'acme/web#2'], 'listed: the first free candidates');
  });

  await t.test('(h) a tracker without scope is an error for a milestone scope, not for a listed one', (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] });
    mandate(root, config, 'l', { issues: ['acme/web#9'], order: 'listed' });
    const bare = stub({}, { scope: false });
    const m = progress(root, config, 'm1', bare);
    assert.ok(m.trackerError, 'a trackerError');
    assert.match(String(m.blocked), /^tracker: /);
    const l = progress(root, config, 'l', bare);
    assert.deepEqual([l.trackerError, l.candidates.map((c) => c.ref)], [null, ['acme/web#9']]);
  });

  await t.test('(i) lastActivity is now while a job has a running agent', (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] });
    const j = jobAt(root, 'build', { create: { mandate: 'm1' } });
    const at = Date.now() + 24 * 3600 * 1000;
    assert.notEqual(progress(root, config, 'm1', stub({}), { at }).lastActivity, new Date(at).toISOString());
    updateJob(root, j.id, (job) => {
      job.agents.builder = { runs: 1, status: 'running' };
    });
    assert.equal(progress(root, config, 'm1', stub({}), { at }).lastActivity, new Date(at).toISOString());
  });
});

test('an overlap wait is reached under merge-ready and never a bounce', () => {
  const into = (waitingOn: string) => ({ v: 1, ts: 't', type: 'transition', from: { stage: 'pr', state: 'running', waitingOn: null }, to: { stage: 'pr', state: 'waiting', waitingOn } }) as JobEvent;
  const held = { state: 'waiting', stage: 'pr', waitingOn: 'overlap', pr: { number: 7 } } as Pick<Job, 'state' | 'stage' | 'waitingOn' | 'pr'>;
  assert.equal(classifyJob(held, [], 'merge-ready'), 'reached');
  assert.equal(classifyJob({ ...held, pr: null }, [], 'merge-ready'), 'inFlight', 'no PR: not reached');
  assert.equal(classifyJob(held, [], 'merged'), 'inFlight', 'merged needs the merge');
  const events = [into('overlap'), into('overlap'), into('overlap')];
  assert.equal(bounceHold(held, events, { id: 'm1', stall: { bounces: 1 } } as Pick<Mandate, 'id' | 'stall'>), null);
  // A counted gate entered as often does bounce, so the overlap row is what keeps it out.
  assert.match(bounceHold({ ...held, waitingOn: 'escalation' }, events.map(() => into('escalation')), { id: 'm1', stall: { bounces: 1 } } as Pick<Mandate, 'id' | 'stall'>) ?? '', /back at escalation 3 times/);
});
