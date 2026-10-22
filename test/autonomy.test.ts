import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/core/config/load.ts';
import { createJob, logEvent, setJob } from '../lib/core/job/store.ts';
import { AUTONOMY_REASONS, judgeAutonomy } from '../lib/engine/evals/autonomy.ts';
import { computeStats } from '../lib/engine/metrics/stats.ts';
import { statsText } from '../lib/cli/commands/status.ts';
import { prepareRetro } from '../lib/engine/evals/retro.ts';

const PERSON = { login: 'pat', source: 'env' };
const FOREMAN = { login: null, source: 'foreman' };
const SHA = 'c'.repeat(40);

const outcome = (extra: Record<string, unknown> = {}) => ({
  status: 'final',
  windowDays: 14,
  mergedAt: '2026-09-01T00:00:00.000Z',
  closesAt: '2026-09-15T00:00:00.000Z',
  mergeSha: SHA,
  reverted: false,
  revertedBy: null,
  followUps: 0,
  followUpRefs: [],
  churn: { commits: 0, lines: 0, files: 0 },
  measuredAt: '2026-09-16T00:00:00.000Z',
  attempts: 0,
  ...extra,
});
const job = (extra: Record<string, unknown> = {}) => ({ id: 'j', kind: 'feature', state: 'done', decision: null, pr: { number: 7, state: 'MERGED' }, outcome: outcome(), ...extra }) as any;
const ev = (type: string, data: Record<string, unknown> = {}) => ({ v: 2, ts: '2026-09-01T00:00:00.000Z', type, ...data });
const human = (action: string, actor: unknown = PERSON) => ev('human', { action, actor });
const park = (waitingOn: string, reason = '') => ev('transition', { from: { stage: 'review', state: 'running', waitingOn: null }, to: { stage: 'decide', state: 'waiting', waitingOn }, reason });

describe('judgeAutonomy', { concurrency: 4 }, () => {
  const cases: [string, any, any[]][] = [
    ['person-rework', job(), [human('rework')]],
    ['person-revise', job(), [human('revise-spec')]],
    ['person-decision', job(), [park('input'), human('answer')]],
    ['escalation-person', job({ decision: 'ESCALATE' }), [park('escalation')]],
    ['pr-feedback', job(), [ev('pr-synced', { newFeedback: true })]],
    ['human-delta', job({ pr: { number: 7, state: 'MERGED', humanDelta: { status: 'measured', fileCount: 2 } } }), []],
    ['reverted', job({ outcome: outcome({ reverted: true, revertedBy: { kind: 'commit', sha: SHA } }) }), []],
    ['follow-up', job({ outcome: outcome({ followUps: 1, followUpRefs: ['o/r#9'] }) }), []],
  ];
  assert.deepEqual(cases.map((c) => c[0]), [...AUTONOMY_REASONS], 'one case per reason');
  for (const [reason, j, events] of cases) {
    test(`${reason} makes the job non-autonomous`, () => {
      const r = judgeAutonomy(j, events as any)!;
      assert.equal(r.autonomous, false);
      assert.equal(r.strict, false);
      assert.deepEqual(r.reasons, [reason]);
    });
  }

  test('a clean merged job is autonomous; anything not merged and final is not judged', () => {
    assert.deepEqual(judgeAutonomy(job(), []), { autonomous: true, strict: true, reasons: [] });
    assert.equal(judgeAutonomy(job({ outcome: null }), []), null);
    assert.equal(judgeAutonomy(job({ pr: { number: 7, state: 'CLOSED' } }), []), null);
    assert.equal(judgeAutonomy(job({ pr: null }), []), null);
    assert.equal(judgeAutonomy(job({ pr: { number: 7, state: 'MERGED', humanDelta: { status: 'unavailable', fileCount: null } } }), []).autonomous, true, 'an unavailable delta is not held against the job');
    assert.equal(judgeAutonomy(job({ pr: { number: 7, state: 'MERGED', humanDelta: { status: 'measured', fileCount: 0 } } }), []).autonomous, true);
    assert.deepEqual(judgeAutonomy(job({ pr: { number: 7, state: 'MERGED', humanDelta: { status: 'rewritten' } } }), [])!.reasons, ['human-delta']);
    assert.deepEqual(judgeAutonomy(job(), [human('revise-split')])!.reasons, ['person-revise']);
    assert.deepEqual(judgeAutonomy(job(), [park('rounds-exhausted'), human('approve')])!.reasons, ['person-decision']);
  });

  test('open outcomes are not counted', () => {
    assert.equal(judgeAutonomy(job({ outcome: outcome({ status: 'open' }) }), [human('rework')]), null);
  });

  test('churn does not affect autonomy', () => {
    assert.deepEqual(judgeAutonomy(job({ outcome: outcome({ churn: { commits: 5, lines: 80, files: 3 } }) }), []), { autonomous: true, strict: true, reasons: [] });
  });

  test('required spec approval does not count', () => {
    assert.deepEqual(judgeAutonomy(job(), [human('approve-spec')]), { autonomous: true, strict: false, reasons: [] });
    assert.deepEqual(judgeAutonomy(job(), [human('approve-spec', FOREMAN)]), { autonomous: true, strict: true, reasons: [] });
    for (const action of ['approve-split', 'approve-repos', 'reject-repos', 'approve-release']) assert.deepEqual(judgeAutonomy(job(), [human(action)]), { autonomous: true, strict: false, reasons: [] }, action);
  });

  test('foreman decisions never count', () => {
    const events = [human('rework', FOREMAN), human('revise-spec', FOREMAN), park('input'), human('answer', FOREMAN), park('escalation'), human('approve', FOREMAN)];
    assert.deepEqual(judgeAutonomy(job({ decision: 'ESCALATE' }), events as any), { autonomous: true, strict: true, reasons: [] });
    assert.deepEqual(judgeAutonomy(job(), [human('rework', 'foreman')]), { autonomous: true, strict: true, reasons: [] }, 'the legacy foreman string too');
    assert.deepEqual(judgeAutonomy(job(), [human('rework', { login: 'x' })])!.reasons, ['person-rework'], 'an actor without a source is a person');
  });

  test('protected-paths approve is a required gate', () => {
    assert.deepEqual(judgeAutonomy(job(), [park('human', 'protected paths: .github/workflows/ci.yml'), human('approve')]), { autonomous: true, strict: false, reasons: [] });
    assert.deepEqual(judgeAutonomy(job(), [park('issue-link'), human('approve')]), { autonomous: true, strict: false, reasons: [] });
    assert.deepEqual(judgeAutonomy(job(), [park('infra'), human('approve')]), { autonomous: true, strict: false, reasons: [] });
    assert.deepEqual(judgeAutonomy(job(), [park('human', 'secret found'), human('approve')])!.reasons, ['person-decision'], 'another human park is a decision');
    const escalated = judgeAutonomy(job({ decision: 'ESCALATE' }), [park('escalation'), human('approve')])!;
    assert.deepEqual(escalated.reasons, ['person-decision', 'escalation-person'], 'after an escalation park it is not');
    // The park that counts is the last one before the approval.
    assert.deepEqual(judgeAutonomy(job(), [park('escalation'), park('issue-link'), human('approve')])!.reasons, []);
    assert.deepEqual(judgeAutonomy(job({ decision: 'ESCALATE' }), [park('escalation'), human('approve', FOREMAN), park('escalation')])!.reasons, ['escalation-person'], 'only an approval after the last escalation park clears it');
  });
});

/** Writes jobs to a scratch repo, each with its own events. */
function seed(dir: string, specs: { title: string; fields: Record<string, unknown>; events?: [string, Record<string, unknown>][] }[]): string[] {
  const config = defaults();
  return specs.map((s) => {
    const j = createJob(dir, config, { title: s.title });
    const { pr, ...fields } = s.fields;
    setJob(dir, j.id, { stage: 'done', state: 'done', owned: pr === undefined ? {} : { pr }, fields });
    for (const [type, data] of s.events ?? []) logEvent(dir, j.id, type, data);
    return j.id;
  });
}

const merged = (extra: Record<string, unknown> = {}) => ({ pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED', isDraft: false, lastSyncedAt: 'x' }, ...extra });
const FINAL_SET = () => [
  { title: 'A clean', fields: merged({ outcome: outcome() }), events: [['human', { action: 'approve-spec', actor: PERSON }]] as [string, Record<string, unknown>][] },
  { title: 'B reverted', fields: merged({ outcome: outcome({ reverted: true, revertedBy: { kind: 'pr', number: 12 }, churn: { commits: 1, lines: 3, files: 1 } }) }) },
  { title: 'C followed up', fields: merged({ outcome: outcome({ followUps: 2, followUpRefs: ['o/r#20', 'o/r#21'], churn: null }) }) },
  { title: 'D foreman', fields: merged({ outcome: outcome({ reverted: null, followUps: 'unsupported' }) }), events: [['human', { action: 'rework', actor: FOREMAN }]] as [string, Record<string, unknown>][] },
  { title: 'E open', fields: merged({ outcome: outcome({ status: 'open', reverted: true, revertedBy: { kind: 'commit', sha: SHA } }) }) },
  { title: 'F unmeasured', fields: merged() },
];

describe('stats and retro', { concurrency: 4 }, () => {
  test('stats rates over final outcomes', () => {
    const r = tempRepo();
    try {
      seed(r.dir, FINAL_SET());
      const q = computeStats(r.dir).quality;
      assert.equal(q.autonomyRate, 0.5, 'A and D over four final outcomes');
      assert.equal(q.autonomyRateStrict, 0.25, 'A had a person approve its spec');
      assert.equal(q.revertRate, 0.333, 'D never completed its revert check');
      assert.equal(q.followUpRate, 0.333, 'D is unsupported, so not in the denominator');
      assert.equal(q.churnRate, 0.333, 'C has no churn reading');
      assert.deepEqual(q.outcomeCoverage, { merged: 6, final: 4, open: 1 });
    } finally {
      r.cleanup();
    }
  });

  test('stats text line', () => {
    const r = tempRepo();
    try {
      seed(r.dir, FINAL_SET());
      const text = statsText(computeStats(r.dir));
      assert.ok(text.split('\n').includes('autonomy 50% (strict 25%) · reverted 33% · follow-ups 33% · churn 33% · outcomes final 4/6 (open 1)'), text);
      const old = statsText({ ...computeStats(r.dir), quality: { firstPassReviewRate: null } } as any);
      assert.ok(old.includes('autonomy — (strict —) · reverted — · follow-ups — · churn — · outcomes final 0/0 (open 0)'), 'an older stats.json prints dashes');
    } finally {
      r.cleanup();
    }
  });

  test('old jobs without outcome read cleanly', () => {
    const r = tempRepo();
    try {
      const jobs = [{ id: 'a', createdAt: new Date().toISOString(), state: 'done', pr: { state: 'MERGED' } }, { id: 'b', createdAt: new Date().toISOString(), state: 'done', pr: { state: 'MERGED' } }];
      const q = computeStats(r.dir, { jobs } as any).quality;
      assert.deepEqual(q.outcomeCoverage, { merged: 2, final: 0, open: 0 });
      for (const k of ['autonomyRate', 'autonomyRateStrict', 'revertRate', 'followUpRate', 'churnRate'] as const) assert.equal(q[k], null, k);
    } finally {
      r.cleanup();
    }
  });

  test('retro lists reverted and followed-up jobs', () => {
    const r = tempRepo();
    const none = tempRepo();
    try {
      const config = defaults();
      const ids = seed(r.dir, FINAL_SET());
      const retro = createJob(r.dir, config, { title: 'Retro', kind: 'retro' });
      const signals = fs.readFileSync(prepareRetro(r.dir, config, retro.id, { since: '2026-09-01' }).signals, 'utf8');
      const section = signals.slice(signals.indexOf('## Post-merge outcomes')).split('\n\n')[0].split('\n');
      assert.deepEqual(section.slice(1).sort(), [`- ${ids[1]}: reverted by PR #12`, `- ${ids[2]}: 2 follow-up bug issue(s): o/r#20, o/r#21`, `- ${ids[4]}: reverted by commit ${SHA.slice(0, 12)} (window open)`].sort());
      const later = fs.readFileSync(prepareRetro(r.dir, config, retro.id, { since: '2026-10-01' }).signals, 'utf8');
      assert.ok(!later.includes('## Post-merge outcomes'), 'outcomes measured before the window are left out');
      seed(none.dir, [{ title: 'clean', fields: merged({ outcome: outcome() }) }]);
      const retro2 = createJob(none.dir, config, { title: 'Retro', kind: 'retro' });
      assert.ok(!fs.readFileSync(prepareRetro(none.dir, config, retro2.id, { since: '1970-01-01' }).signals, 'utf8').includes('## Post-merge outcomes'), 'no section when nothing escaped');
    } finally {
      r.cleanup();
      none.cleanup();
    }
  });
});
