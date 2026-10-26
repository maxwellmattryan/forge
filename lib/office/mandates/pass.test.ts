// The Office pass enforces each mandate's contract with no model: it pauses at the budget, stalls a
// mandate with no progress and a job that keeps bouncing, applies onUnfinishable, and closes a finished
// mandate with its summary, starting the next link of its chain in the same pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { jobAt, parkedAt, recordingMoveEffects, tempRepo } from '../../../test/helpers.ts';
import { planSteps, releaseFiles, writeReleasePlan } from '#engine/release/files.ts';
import { latestMandatePlan } from '#engine/release/mandate.ts';
import { RELEASE_FILE_VERSION } from '#engine/release/plan.ts';
import { defaults } from '#core/config/load.ts';
import { listRequests } from '#core/job/requests.ts';
import { createJob, loadJob, logEvent,logHumanEvent, readEvents, repoAuditFile, setJob, updateJob } from '#core/job/store.ts';
import { useMoveEffects } from '#engine/pipeline/moves/effects.ts';
import { applyInput, blankMandate, fillDefaults } from './contract.ts';
import { readDirectives } from './directives.ts';
import { readSummary, runOfficePass } from './pass.ts';
import { mandateProgress, readProgressCtx } from './progress.ts';
import { listMandates, readMandate, writeMandate } from './store.ts';
import type { Config, Tracker, TrackerItem } from '#core/types.ts';
import type { QueueNotify } from '../notify.ts';
import type { Mandate, MandateInput } from './types.ts';

function scratch(t: test.TestContext): { root: string; config: Config } {
  const r = tempRepo();
  const restore = useMoveEffects(recordingMoveEffects());
  t.after(() => {
    restore();
    r.cleanup();
  });
  const config = defaults();
  config.foreman.enabled = true;
  config.foreman.cadence = 10;
  config.tracker.kind = 'github';
  config.tracker.github.repo = 'acme/web';
  // $1 per input token, so an agent end's input is its cost.
  config.usage.pricing = { models: { 'usd-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  return { root: r.dir, config };
}

function mandate(root: string, config: Config, id: string, input: MandateInput, opts: { at?: string; after?: string; status?: Mandate['status']; goal?: string } = {}): void {
  const at = opts.at ?? new Date().toISOString();
  const m = applyInput(blankMandate(id, at), fillDefaults(config, { title: id, stallCadences: 3, stallBounces: 3, ...input }));
  writeMandate(root, () => ({ mandate: { ...m, after: opts.after ?? null, status: opts.status ?? 'active', goal: opts.goal ?? null }, action: 'new' as const }));
}

const item = (n: number): TrackerItem => ({ ref: String(n), title: `Issue ${n}`, labels: [], needsInfo: false, priority: null });

/** A tracker listing each milestone's issue numbers; a milestone named BAD throws. `onScope` runs on every call. */
function stub(byMilestone: Record<string, number[]>, onScope: () => void = () => {}): Tracker {
  return {
    name: 'stub',
    list: () => [],
    get: () => null,
    claim: () => ({ ok: true }),
    scope: (_ctx, q) => {
      onScope();
      if (q.milestone === 'BAD') throw new Error('gh: milestone not found');
      return (byMilestone[q.milestone ?? ''] ?? []).map(item);
    },
  } as Partial<Tracker> as Tracker;
}

function notifier() {
  const calls: [string[], Record<string, unknown>][] = [];
  const fn: QueueNotify = (_root, events, opts) => {
    calls.push([[...events], { ...opts }]);
    return true;
  };
  return { calls, fn };
}

const issue = (n: number) => [{ tracker: 'github', ref: `acme/web#${n}` }] as Parameters<typeof createJob>[2]['issues'];

function audit(root: string): Record<string, any>[] {
  try {
    return fs
      .readFileSync(repoAuditFile(root), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const spend = (root: string, id: string, usd: number) =>
  logEvent(root, id, 'agent-end', { role: 'builder', model: 'usd-model', usage: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: usd } });

const status = (root: string, id: string) => (readMandate(root, id) as Mandate).status;
const reason = (root: string, id: string) => (readMandate(root, id) as Mandate).reason;
const MINUTE = 60 * 1000;

test('the pass pauses a mandate at its budget', async (t) => {
  await t.test('spend at budget.usd with candidates left pauses it', async (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'], budgetUsd: 2 });
    const j = jobAt(root, 'build', { create: { mandate: 'm1', issues: issue(1) } });
    spend(root, j.id, 2);
    const n = notifier();
    const out = await runOfficePass(root, config, { tracker: stub({ M1: [1, 2] }), notify: n.fn });
    assert.equal(status(root, 'm1'), 'paused');
    assert.match(String(reason(root, 'm1')), /^budget: \$2 of \$2 spent$/);
    const pause = audit(root).find((e) => e.type === 'mandate-pause');
    assert.deepEqual(pause?.actor, { login: null, source: 'foreman' });
    assert.deepEqual(readDirectives(root, { mandate: 'm1' }).map((d) => d.action), ['pause']);
    assert.deepEqual(n.calls, [[['mandate-budget'], { reason: 'mandate-budget', mandate: 'm1' }]]);
    assert.deepEqual(out.mandates.map((m) => [m.id, m.state, m.actions]), [['m1', 'paused', ['pause']]]);
    assert.equal(out.direct, null, 'nothing to direct under a paused mandate');
  });

  await t.test('started at budget.jobs pauses it only while candidates remain', async (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'], budgetJobs: 1 });
    mandate(root, config, 'm2', { milestones: ['M2'], budgetJobs: 1 });
    jobAt(root, 'build', { create: { mandate: 'm1', issues: issue(1) } });
    jobAt(root, 'build', { create: { mandate: 'm2', issues: issue(5) } });
    const n = notifier();
    await runOfficePass(root, config, { tracker: stub({ M1: [1, 2], M2: [5] }), notify: n.fn });
    assert.deepEqual([status(root, 'm1'), reason(root, 'm1')], ['paused', 'budget: 1 of 1 jobs started']);
    assert.equal(status(root, 'm2'), 'active', 'no candidates: no pause');
    assert.deepEqual(n.calls, [[['mandate-budget'], { reason: 'mandate-budget', mandate: 'm1' }]]);
  });

  await t.test('an owner who paused the mandate after the pass read it is not overwritten', async (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'], budgetUsd: 1 });
    const j = jobAt(root, 'build', { create: { mandate: 'm1', issues: issue(1) } });
    spend(root, j.id, 5);
    let once = false;
    const ownerPauses = () => {
      if (once) return;
      once = true;
      writeMandate(root, (all) => {
        const cur = all.find((x) => x.id === 'm1') as Mandate;
        return { mandate: { ...cur, status: 'paused', reason: 'owner', updatedAt: new Date(Date.now() + 1000).toISOString() }, action: 'pause' as const };
      });
    };
    const n = notifier();
    await runOfficePass(root, config, { tracker: stub({ M1: [1, 2] }, ownerPauses), notify: n.fn });
    assert.deepEqual([status(root, 'm1'), reason(root, 'm1')], ['paused', 'owner']);
    assert.deepEqual(readDirectives(root), []);
    assert.deepEqual(n.calls, []);
  });
});

test('the pass stalls a mandate with no progress and a job that keeps bouncing', async (t) => {
  const past = new Date(Date.now() - 3 * 60 * MINUTE).toISOString();
  await t.test('no transition for stall.cadences × foreman.cadence minutes pauses it', async (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] }, { at: past });
    jobAt(root, 'build', { create: { mandate: 'm1', issues: issue(1) } });
    const n = notifier();
    await runOfficePass(root, config, { tracker: stub({ M1: [1] }), notify: n.fn, at: Date.now() + 31 * MINUTE });
    assert.deepEqual([status(root, 'm1'), reason(root, 'm1')], ['paused', 'stalled: no progress for 30 min (3 passes)']);
    assert.deepEqual(n.calls, [[['mandate-stalled'], { reason: 'mandate-stalled', mandate: 'm1' }]]);
  });

  await t.test('a running agent keeps it active', async (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] }, { at: past });
    const j = jobAt(root, 'build', { create: { mandate: 'm1', issues: issue(1) } });
    updateJob(root, j.id, (job) => void (job.agents.builder = { runs: 1, status: 'running' }));
    const n = notifier();
    await runOfficePass(root, config, { tracker: stub({ M1: [1] }), notify: n.fn, at: Date.now() + 31 * MINUTE });
    assert.equal(status(root, 'm1'), 'active');
    assert.deepEqual(n.calls, []);
  });

  await t.test('a transition inside the window keeps it active', async (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] }, { at: past });
    jobAt(root, 'build', { create: { mandate: 'm1', issues: issue(1) } });
    await runOfficePass(root, config, { tracker: stub({ M1: [1] }), notify: notifier().fn, at: Date.now() + 20 * MINUTE });
    assert.equal(status(root, 'm1'), 'active');
  });

  await t.test('a job at escalation for the stall.bounces-th time is stalled once', async (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] });
    const id = parkedAt(root, 'escalation', { create: { mandate: 'm1', issues: issue(1) } }).id;
    for (let i = 0; i < 2; i++) {
      setJob(root, id, { state: 'running' });
      setJob(root, id, { state: 'waiting', waitingOn: 'escalation' });
    }
    const n = notifier();
    await runOfficePass(root, config, { tracker: stub({ M1: [1] }), notify: n.fn });
    const stalled = () => readEvents(root, id).filter((e) => e.type === 'mandate-stalled');
    assert.deepEqual(
      stalled().map((e) => [e.mandate, e.waitingOn, e.bounces]),
      [['m1', 'escalation', 3]],
    );
    const stalls = () => readDirectives(root).filter((d) => d.action === 'stall');
    assert.deepEqual(
      stalls().map((d) => [d.job, d.reason]),
      [[id, 'mandate m1: back at escalation 3 times (stall.bounces 3): left for a human']],
    );
    assert.deepEqual(n.calls, [[['mandate-stalled'], { job: id, reason: 'mandate-stalled' }]]);
    await runOfficePass(root, config, { tracker: stub({ M1: [1] }), notify: n.fn });
    assert.equal(stalled().length, 1, 'a second pass adds no event');
    assert.equal(stalls().length, 1, 'nor a directive');
    assert.equal(n.calls.length, 1);
    assert.equal(loadJob(root, id).waitingOn, 'escalation', 'the job keeps waiting, as a person’s gate');
  });
});

test('the pass applies onUnfinishable', async (t) => {
  const { root, config } = scratch(t);
  mandate(root, config, 'mc', { milestones: ['M1'], onUnfinishable: 'cancel' });
  mandate(root, config, 'mp', { milestones: ['M2'], onUnfinishable: 'park' });
  const c = jobAt(root, 'build', { create: { mandate: 'mc', issues: issue(1) }, state: 'failed' });
  const p = jobAt(root, 'build', { create: { mandate: 'mp', issues: issue(5) }, state: 'failed' });
  // A candidate left in each, so neither closes.
  const tracker = stub({ M1: [1, 2], M2: [5, 6] });
  const run = () => runOfficePass(root, config, { tracker, notify: notifier().fn });
  await run();
  const cancelled = loadJob(root, c.id);
  assert.deepEqual([cancelled.state, cancelled.reason], ['cancelled', 'mandate mc: unfinishable (failed): cancelled']);
  assert.equal(loadJob(root, p.id).state, 'failed');
  const events = (id: string) => readEvents(root, id).filter((e) => e.type === 'mandate-unfinishable');
  const actions = () => readDirectives(root).filter((d) => d.action === 'cancel' || d.action === 'park').map((d) => [d.mandate, d.action, d.job]);
  assert.deepEqual(events(c.id).map((e) => [e.mandate, e.action, e.why]), [['mc', 'cancel', 'failed']]);
  assert.deepEqual(events(p.id).map((e) => [e.mandate, e.action, e.why]), [['mp', 'park', 'failed']]);
  assert.deepEqual(actions(), [['mc', 'cancel', c.id], ['mp', 'park', p.id]]);
  await run();
  assert.equal(events(c.id).length + events(p.id).length, 2, 'a second pass adds no event');
  assert.equal(actions().length, 2, 'nor a directive');
  const all = listMandates(root);
  for (const [id, job] of [['mc', c.id], ['mp', p.id]] as const) {
    const pr = mandateProgress(root, config, all.find((m) => m.id === id) as Mandate, all, readProgressCtx(root, config, { tracker, trackerError: null }));
    assert.equal(pr.jobs.find((j) => j.id === job)?.class, 'handled', id);
  }
});

test('the pass closes a finished mandate and starts the next link', async (t) => {
  await t.test('a finished mandate closes with its summary, and the next link starts in the same pass', async (t) => {
    const { root, config } = scratch(t);
    const early = new Date(Date.now() - MINUTE).toISOString();
    // m2 sorts first, so it is first seen waiting: the close of m1 brings it back in the same pass.
    mandate(root, config, 'm2', { milestones: ['M2'] }, { at: early, after: 'm1' });
    mandate(root, config, 'm1', { milestones: ['M1'], onUnfinishable: 'park' });
    const reached = jobAt(root, 'done', { create: { mandate: 'm1', issues: issue(1) } });
    spend(root, reached.id, 1.5);
    logHumanEvent(root, reached.id, 'human', { action: 'approve', note: 'ok' }, { login: 'alice', source: 'gh' });
    logHumanEvent(root, reached.id, 'human', { action: 'approve', note: 'ok' }, { login: null, source: 'foreman' });
    const cancelled = jobAt(root, 'build', { create: { mandate: 'm1', issues: issue(2) }, state: 'cancelled' });
    const parked = jobAt(root, 'build', { create: { mandate: 'm1', issues: issue(3) }, state: 'failed' });
    logEvent(root, cancelled.id, 'mandate-stalled', { mandate: 'm1', waitingOn: 'escalation', bounces: 3 });
    const n = notifier();
    const tracker = stub({ M1: [1, 2, 3], M2: [7, 8] });
    const out = await runOfficePass(root, config, { tracker, notify: n.fn });

    const m1 = readMandate(root, 'm1') as Mandate;
    assert.equal(m1.status, 'closed');
    assert.equal(m1.reason, 'done: 1 jobs reached merge-ready, 1 parked, $1.5');
    assert.deepEqual(audit(root).find((e) => e.type === 'mandate-close')?.actor, { login: null, source: 'foreman' });
    const s = readSummary(root, 'm1');
    assert.ok(s && !('problem' in s), JSON.stringify(s));
    assert.deepEqual(
      s.jobs.map((j) => [j.id, j.outcome]).sort(),
      [[reached.id, 'reached'], [cancelled.id, 'cancelled'], [parked.id, 'parked']].sort(),
    );
    assert.deepEqual([s.spend.usd, s.humanInterventions, s.stalls, s.parked], [1.5, 1, 1, [{ job: parked.id, why: 'failed' }]]);
    assert.deepEqual(
      n.calls.filter(([e]) => e[0] === 'mandate-closed'),
      [[['mandate-closed'], { reason: 'mandate-closed', mandate: 'm1' }]],
    );
    // The next link: active in this pass, with one direct request for the office.
    assert.deepEqual(out.mandates.find((m) => m.id === 'm2')?.state, 'active');
    const directs = () => listRequests(root).filter((r) => r.type === 'direct');
    assert.deepEqual(
      directs().map((r) => [r.status, r.job, r.from]),
      [['pending', null, 'forge']],
    );
    assert.equal(out.direct, directs()[0].id);
    const again = await runOfficePass(root, config, { tracker, notify: n.fn });
    assert.equal(again.direct, null, 'none while one is pending');
    assert.equal(directs().length, 1);
  });

  await t.test('a tracker error never closes; a paused mandate whose work is done closes; a drafting goal mandate is untouched', async (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'broken', { milestones: ['BAD'] });
    mandate(root, config, 'resting', { milestones: ['M4'] }, { status: 'paused' });
    jobAt(root, 'done', { create: { mandate: 'resting', issues: issue(4) } });
    mandate(root, config, 'goal', {}, { goal: 'ship the thing' });
    const goalBefore = readMandate(root, 'goal');
    const out = await runOfficePass(root, config, { tracker: stub({ M4: [4] }), notify: notifier().fn });
    assert.equal(status(root, 'broken'), 'active');
    assert.match(String(out.mandates.find((m) => m.id === 'broken')?.blocked), /^tracker: gh: milestone not found/);
    assert.equal(status(root, 'resting'), 'closed');
    assert.deepEqual(readMandate(root, 'goal'), goalBefore);
    assert.ok(!out.mandates.some((m) => m.id === 'goal'));
  });

  await t.test('with foreman.enabled false the pass writes nothing', async (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1', { milestones: ['M1'] });
    const before = audit(root).length;
    config.foreman.enabled = false;
    const out = await runOfficePass(root, config, { tracker: stub({ M1: [] }), notify: notifier().fn });
    assert.deepEqual(out, { ok: true, enabled: false, mandates: [], direct: null, problems: [] });
    assert.equal(status(root, 'm1'), 'active');
    assert.equal(audit(root).length, before);
    assert.deepEqual(listRequests(root), []);
  });
});

/**
 * scratch() releasing its root with a tag command under ship release, the foreman deciding `release`,
 * and an `until: released` mandate m1 whose one job is done. `tag`: v0.1.0 on the first commit with one
 * commit after it (behind), at HEAD (head), or none.
 */
function releasing(t: test.TestContext, tag: 'behind' | 'head' | 'none' = 'behind', input: MandateInput = {}, at?: string) {
  const s = scratch(t);
  const { root, config } = s;
  config.foreman.ship = 'release';
  config.foreman.decides = [...config.foreman.decides, 'release'];
  config.foreman.reserved = config.foreman.reserved.filter((x) => x !== 'gate:release');
  config.release = { ...config.release, mechanism: 'tag', command: 'git tag v0.2.0' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  if (tag !== 'none') git('tag', 'v0.1.0');
  if (tag === 'behind') {
    fs.writeFileSync(`${root}/a.txt`, 'a\n');
    git('add', '-A');
    git('commit', '-qm', 'work');
  }
  mandate(root, config, 'm1', { milestones: ['M1'], until: 'released', decides: ['release'], ...input }, { at });
  const job = jobAt(root, 'done', { create: { mandate: 'm1', issues: issue(1) } }).id;
  return { ...s, job };
}

const planned = (root: string) => audit(root).filter((e) => e.type === 'mandate-release-planned');
const releaseGates = (root: string) => listRequests(root).filter((r) => r.type === 'gate' && r.args?.gate === 'release');
const writeState = (root: string, hash: string, steps: Record<string, unknown>, finishedAt: string | null = null) =>
  fs.writeFileSync(releaseFiles(root).state, JSON.stringify({ version: RELEASE_FILE_VERSION, planHash: hash, startedAt: 'x', updatedAt: 'x', finishedAt, steps }));

test('a mandate until released waits for its release and never closes early', async (t) => {
  const pass = (root: string, config: Config, at?: number, notify: QueueNotify = notifier().fn) => runOfficePass(root, config, { tracker: stub({ M1: [1] }), notify, at });
  const blockedOf = (out: Awaited<ReturnType<typeof runOfficePass>>) => out.mandates.find((m) => m.id === 'm1')?.blocked;
  const waits = async (root: string, config: Config, want: RegExp, plans: number, notify?: QueueNotify) => {
    const out = await pass(root, config, undefined, notify);
    assert.equal(status(root, 'm1'), 'active', 'not closed');
    assert.match(String(blockedOf(out)), want);
    assert.equal(planned(root).length, plans, 'planned events');
    return out;
  };

  await t.test('no tag in the root', async (t) => {
    const { root, config } = releasing(t, 'none');
    await waits(root, config, /^release: the root repo has no tag to release since; tag its last release, or edit the mandate's until$/, 0);
  });

  await t.test('nothing to release since the tag', async (t) => {
    const { root, config } = releasing(t, 'head');
    await waits(root, config, /^release: nothing to release since v0\.1\.0 \(\(root\): no commits since v0\.1\.0\)$/, 0);
  });

  await t.test('an unfinished run of another plan', async (t) => {
    const { root, config } = releasing(t);
    fs.mkdirSync(releaseFiles(root).dir, { recursive: true });
    writeState(root, 'c'.repeat(64), {});
    await waits(root, config, /^release: a release run is in progress \(0\/0 steps done\)/, 0);
    assert.deepEqual(releaseGates(root), []);
  });

  await t.test('a failed step', async (t) => {
    const { root, config } = releasing(t);
    await waits(root, config, /^release: plan [0-9a-f]{12} waits for release approval \(foreman\)$/, 1);
    writeState(root, latestMandatePlan(root, 'm1')!.hash, { '(root)/preflight': { status: 'failed', at: 'x', detail: 'check ready failed: no origin/main' } });
    await waits(root, config, /^release: step \(root\)\/preflight failed: check ready failed: no origin\/main$/, 1);
  });

  await t.test('a plan that went stale after a step ran', async (t) => {
    const { root, config } = releasing(t);
    await pass(root, config);
    writeState(root, latestMandatePlan(root, 'm1')!.hash, { '(root)/preflight': { status: 'done', at: 'x' } });
    config.release.command = 'git tag v0.3.0';
    await waits(root, config, /^release: the plan went stale \(plan [0-9a-f]{12}, now [0-9a-f]{12}\); re-plan with forge release plan --mandate m1 --force$/, 1);
    assert.equal(releaseGates(root).length, 1, 'no new request');
  });

  await t.test('another plan in release.json that has not started is never replaced', async (t) => {
    const { root, config } = releasing(t);
    const other = jobAt(root, 'done', { pr: { number: 3, url: 'https://github.com/acme/web/pull/3', state: 'MERGED' } }).id;
    writeReleasePlan(root, config, { kind: 'job', job: other });
    const before = fs.readFileSync(releaseFiles(root).json, 'utf8');
    await waits(root, config, /^release: blocked by another plan, plan it with forge release plan --mandate m1$/, 0);
    assert.equal(fs.readFileSync(releaseFiles(root).json, 'utf8'), before, 'release.json untouched');
    assert.deepEqual([releaseGates(root), readDirectives(root, { mandate: 'm1' })], [[], []], 'no request, no directive');
  });

  await t.test('a finished release that a later merge missed is planned again, not closed', async (t) => {
    const { root, config } = releasing(t);
    const n = notifier();
    await pass(root, config, undefined, n.fn);
    const [first] = planned(root);
    const plan = JSON.parse(fs.readFileSync(releaseFiles(root).json, 'utf8'));
    writeState(root, first.planHash, Object.fromEntries(planSteps(plan).map((s) => [s.id, { status: 'done', at: 'x' }])), 'x');
    // Another mandate job merges after the plan was planned: its commit lands in the root.
    fs.writeFileSync(`${root}/b.txt`, 'b\n');
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'later'], { cwd: root, stdio: 'pipe' });
    const mergedAt = new Date(Date.parse(first.ts) + 1000).toISOString();
    jobAt(root, 'done', { create: { mandate: 'm1', issues: issue(1) }, pr: { number: 4, url: 'https://github.com/acme/web/pull/4', state: 'MERGED', mergedAt } });
    await waits(root, config, /^release: plan [0-9a-f]{12} waits for release approval \(foreman\)$/, 2, n.fn);
    const second = latestMandatePlan(root, 'm1')!.hash;
    assert.notEqual(second, first.planHash, 'a new hash');
    assert.deepEqual(releaseGates(root).map((r) => r.args?.key), [first.planHash, second], 'a new request');
    const gate = [['gate'], { reason: 'mandate-release', mandate: 'm1' }];
    assert.deepEqual(n.calls, [gate, gate], 'a plan after a release ran is news: notified again');
  });

  await t.test('release.json replaced by another plan', async (t) => {
    const { root, config } = releasing(t);
    await pass(root, config);
    writeReleasePlan(root, config, { kind: 'since', tag: 'v0.1.0' });
    await waits(root, config, /^release: release\.json no longer holds plan [0-9a-f]{12}; run forge release plan --mandate m1$/, 1);
  });

  await t.test('a plan that went stale before any step ran is planned again', async (t) => {
    const { root, config } = releasing(t);
    const n = notifier();
    await pass(root, config, undefined, n.fn);
    const first = latestMandatePlan(root, 'm1')!.hash;
    config.release.command = 'git tag v0.3.0';
    const out = await waits(root, config, /^release: plan [0-9a-f]{12} waits for release approval \(foreman\)$/, 2, n.fn);
    assert.deepEqual(n.calls, [[['gate'], { reason: 'mandate-release', mandate: 'm1' }]], 'the re-plan notifies no one again');
    const second = latestMandatePlan(root, 'm1')!.hash;
    assert.notEqual(second, first, 'a new hash');
    assert.deepEqual(releaseGates(root).map((r) => r.args?.key), [first, second], 'a new request');
    assert.equal(out.mandates[0].release?.plan, second.slice(0, 12));
    assert.deepEqual(readDirectives(root, { mandate: 'm1' }).map((d) => d.action), ['release', 'release']);
  });

  await t.test('over budget with old activity, it neither pauses nor stalls', async (t) => {
    const past = new Date(Date.now() - 3 * 60 * MINUTE).toISOString();
    const { root, config, job } = releasing(t, 'behind', { budgetUsd: 1 }, past);
    spend(root, job, 5);
    const out = await waits(root, config, /^release: plan [0-9a-f]{12} waits for release approval \(foreman\)$/, 1);
    const later = await pass(root, config, Date.now() + 120 * MINUTE);
    assert.equal(status(root, 'm1'), 'active', 'no pause');
    assert.ok(!readDirectives(root, { mandate: 'm1' }).some((d) => d.action === 'pause'));
    assert.deepEqual([out.direct, later.direct], [null, null], 'no direct request');
  });

  await t.test('a paused mandate is never planned', async (t) => {
    const { root, config } = releasing(t);
    writeMandate(root, (all) => ({ mandate: { ...(all.find((m) => m.id === 'm1') as Mandate), status: 'paused' }, action: 'pause' as const }));
    const out = await pass(root, config);
    assert.equal(status(root, 'm1'), 'paused');
    assert.equal(planned(root).length, 0);
    assert.match(String(blockedOf(out)), /^release: the Office pass plans it once the mandate's jobs have merged$/);
  });
});
