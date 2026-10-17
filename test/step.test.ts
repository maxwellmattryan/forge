// `step` as a table (issue #68): fixture state → the action it must return. Every rule ID in
// lib/step.ts RULES names at least one row ("every rule has a row"), and every row's commands are
// checked for shell safety ("emitted commands are shell-safe").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RULES, hasSpecDeltas, listLineCount, parsePlan, parseSpecHeader, roundLenses, selectPanel, shellLine, step } from '../lib/step.ts';
import type { Config, Job, StepAction, StepInput, VerifyRun } from '../lib/types.ts';
import { JOB_DIR, WT, ag, ev, fixture, t, verdicts } from './step-fixture.ts';
import type { FixtureOpts } from './step-fixture.ts';

interface Row {
  name: string;
  fx: FixtureOpts;
  want: Record<string, unknown>;
  check?: (a: any) => void;
}

const run = (...command: string[]) => ({ action: 'run', command });
const vr = (round: number, at: number, ok: boolean, failure: string | null = ok ? null : 'test'): VerifyRun => ({ round, attempt: 1, sha: 's', ok, at: t(at), file: `verify/round-${round}.md`, failure });
const job = (j: Partial<Job>): Partial<Job> => ({ state: 'running', ...j });
const SPEC_DONE = { 'spec-writer': ag(0, 1, 2) };
const LOCAL = (c: Config) => void (c.tracker.kind = 'local');
const LINKED: Partial<Job> = { issues: [{ tracker: 'local', ref: 'x', url: null }] };
const NO_ISSUE: Partial<Job> = { noIssue: { reason: null, at: t(0) } };
// I1/SP5/SP7 read issues: none of these is linked.
const UNLINKED: [string, Partial<Job>, ReturnType<typeof ev>[]][] = [
  ['an empty issues list', { issues: [] }, []],
  ['only a ref-less issue', { issues: [{ tracker: 'local', ref: null, url: 'https://example.test/1' }] }, []],
  ['its last issue removed', { issues: [] }, [ev('unlinked', 1, { ref: 'x' })]],
];
const SPEC_TELL = `j spec ready: ${path.join(JOB_DIR, 'spec.md')}. /forge approve j or /forge revise j <note>`;
const LINK_TELL = `j needs an issue: candidates in ${path.join(JOB_DIR, 'issue-candidates.md')} (untrusted). /forge approve j <ref> | new | none [reason]`;
const PANEL_SET = ev('fields', 3, { fields: { reviewers: ['code', 'tests'] } });

/** A job in review, round 1: builder done, verify passed, panel and scope written. */
const inReview = (agents: Job['agents'] = {}, more: Partial<Job> = {}): Partial<Job> =>
  job({ stage: 'review', round: 1, reviewers: ['code', 'tests'], verifyRuns: [vr(1, 10, true)], agents: { builder: ag(1, 5, 9), ...agents }, ...more });
const panelled = ev('panel', 11, { round: 1 });
const scoped = [ev('round', 4, { round: 1 }), panelled, ev('scope', 11, { round: 1 })];

/** Verifiers: the round's run event at minute 8, its files, and the failing verify run a CHANGES record appends at 12. */
const VF_RUN = ev('verifiers', 8, { phase: 'run', round: 1, sha: 's', selected: ['help-rows', 'docs-links'], problems: 0, truncated: false });
const VF_INPUT = path.join(JOB_DIR, 'verify', 'round-1-verifiers-input.md');
const VF_ANSWERS = path.join(JOB_DIR, 'verify', 'round-1-verifier-answers.md');
const VF_REPORT = path.join(JOB_DIR, 'verify', 'round-1-verifiers.md');
const VF_FAIL: VerifyRun = { round: 1, attempt: 2, sha: 's', ok: false, at: t(12), file: 'verify/round-1-verifiers.md', failure: 'verifiers' };

/** A job at decide, round 1, approver done at minute 21. */
const atDecide = (more: Partial<Job> = {}): Partial<Job> => job({ stage: 'decide', round: 1, reviewers: ['code'], verdicts: { 1: { code: 'PASS' } }, agents: { approver: ag(1, 20, 21) }, ...more });

/** A job in integrate that entered the stage at minute 30. */
const entered = ev('transition', 30, { from: { stage: 'decide', state: 'running', waitingOn: null }, to: { stage: 'integrate', state: 'running', waitingOn: null } });
const atIntegrate = (more: Partial<Job> = {}): Partial<Job> => job({ stage: 'integrate', round: 1, reviewers: ['code'], verdicts: { 1: { code: 'PASS' } }, verifyRuns: [vr(1, 10, true)], ...more });
/** forge sync moved a PR job back to integrate at minute 30, after an earlier episode integrated and pushed. */
const routed = [ev('integrated', 5, { behind: 0 }), ev('pr-updated', 11), ev('transition', 30, { from: { stage: 'pr', state: 'waiting', waitingOn: 'pr-review' }, to: { stage: 'integrate', state: 'running', waitingOn: null } })];
const routedMerged = [...routed, ev('integrated', 31, { behind: 2, strategy: 'merge' })];
const conflicts = ev('integrate-conflicts', 31, { strategy: 'rebase', conflicts: ['a.ts', '`x`'], behind: 2 });
/** An integrate-conflicts event at minute 31 naming these conflicts. */
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const resolvedConflicts = (names: string[], more: Record<string, unknown> = {}) => ev('integrate-conflicts', 31, { strategy: 'merge', conflicts: names, behind: 1, head: HEAD_SHA, upstream: BASE_SHA, ...more });
const docsConflicts = resolvedConflicts(['README.md'], { regenerated: ['dashboard/dist/app.js'] });
/** What the resolution changed by default: exactly the listed conflicted and regenerated paths. */
const listed = (events: ReturnType<typeof ev>[]) =>
  [...new Set(events.filter((e) => e.type === 'integrate-conflicts').flatMap((e) => [e.conflicts, e.regenerated].flatMap((l) => (Array.isArray(l) ? l : []))))];
/** Conflicts under `fix`: the integrator resolved them (33–36) and verify passed at 37 on sha `s`, so step reaches IG8. */
const resolvedIntegration = (events: ReturnType<typeof ev>[], config: (c: Config) => unknown = () => {}, touched: Partial<NonNullable<StepInput['integrationTouched']>> = {}): FixtureOpts => ({
  config: (c) => ((c.pr.conflicts = 'fix'), config(c)),
  job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36) } }),
  events: [...events, ev('agent-start', 33, { role: 'integrator' })],
  integrationTouched: { head: HEAD_SHA, upstream: BASE_SHA, sha: 's', files: listed(events), ...touched },
});
const OPEN_PR: Job['pr'] = { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) };
type Side = { stage: string; state?: string; waitingOn?: string | null };
/** A transition event at minute n; a side's state defaults to running. */
const tr = (n: number, from: Side, to: Side) => ev('transition', n, { from: { state: 'running', waitingOn: null, ...from }, to: { state: 'running', waitingOn: null, ...to } });
/** The new order: every lens passed and RV8 sent the job straight to integrate at minute 25. */
const reviewed = tr(25, { stage: 'review' }, { stage: 'integrate' });
/** The old order: review → decide at 15, the approver's decision at 22, then integrate at 30 (`entered`). */
const legacy = [tr(15, { stage: 'review' }, { stage: 'decide' }), ev('decision', 22), entered];
/** The new order up to a decide gate: integrated clean, decide at 33, the approver's decision at 36, parked on `gate` at 37, a human approve at 40. */
const gated = (decision: string, gate: string) => [reviewed, ev('integrated', 31, { behind: 0 }), tr(33, { stage: 'integrate' }, { stage: 'decide' }), ev('decision', 36, { decision }), tr(37, { stage: 'decide' }, { stage: 'decide', state: 'waiting', waitingOn: gate }), ev('human', 40, { action: 'approve' })];
const escalated = gated('ESCALATE', 'escalation');
/** …then set running in decide again at 41. */
const unparkedFrom = (events: ReturnType<typeof gated>, gate: string) => [...events, tr(41, { stage: 'decide', state: 'waiting', waitingOn: gate }, { stage: 'decide' })];
const unparked = unparkedFrom(escalated, 'escalation');
/** …then DC9 sent it to integrate at 42. */
const reenteredFrom = (events: ReturnType<typeof gated>) => [...events, tr(42, { stage: 'decide' }, { stage: 'integrate' })];
const reentered = reenteredFrom(unparked);
/** …an integrate-stage escalation at 50, cleared by a human at 52 and sent back to decide at 53. */
const sendBack = (events: ReturnType<typeof gated>) => [...events, tr(50, { stage: 'integrate' }, { stage: 'integrate', state: 'waiting', waitingOn: 'escalation' }), ev('human', 52, { action: 'approve' }), tr(53, { stage: 'integrate', state: 'waiting', waitingOn: 'escalation' }, { stage: 'decide' })];
const sentBack = sendBack(reentered);
/** The same path for an APPROVE whose before-merge runbook parked on `infra` at 37. */
const runbookSentBack = sendBack(reenteredFrom(unparkedFrom(gated('APPROVE', 'infra'), 'infra')));
/** The approver (34–35) ends and the agent-end budget check parks at 35; a budget acknowledgement at 40; the decision is recorded at 42. */
const budgetAck = (decision: string) => [reviewed, ev('integrated', 31, { behind: 0 }), tr(33, { stage: 'integrate' }, { stage: 'decide' }), tr(35, { stage: 'decide' }, { stage: 'decide', state: 'waiting', waitingOn: 'budget' }), ev('human', 40, { action: 'approve' }), tr(41, { stage: 'decide', state: 'waiting', waitingOn: 'budget' }, { stage: 'decide' }), ev('decision', 42, { decision })];
const decidedLate = (more: Partial<Job> = {}) => atDecide({ agents: { approver: ag(1, 34, 35) }, ...more });

/** A protected-paths flag recorded at minute `at` over `paths` (escalate, rule 4). */
const FLAG = (at = 15, paths = ['package-lock.json'], more = 0): Job['protectedPaths'] => ({
  hits: paths.map((p) => ({ path: p, rule: 4, glob: 'package-lock.json', reason: 'dependency lockfile', blob: 'b'.repeat(40) })),
  more,
  at: t(at),
  gate: 'commit',
  head: null,
});
/** PP1 parked the job at minute `parkAt`, a human approved at `approveAt`, and it ran again a minute later. */
const ppPark = (parkAt: number, approveAt: number, human: Record<string, unknown> = {}) => [
  ev('transition', parkAt, { from: { stage: 'decide', state: 'running', waitingOn: null }, to: { stage: 'decide', state: 'waiting', waitingOn: 'human' }, reason: 'protected paths: package-lock.json' }),
  ev('human', approveAt, { action: 'approve', ...human }),
  tr(approveAt + 1, { stage: 'decide', state: 'waiting', waitingOn: 'human' }, { stage: 'decide' }),
];

const rows: Row[] = [
  // ---- Global
  { name: 'G1 a done job is done', fx: { job: job({ stage: 'done', state: 'done' }) }, want: { action: 'done', state: 'done' } },
  { name: 'G1 a cancelled job is done', fx: { job: job({ stage: 'build', state: 'cancelled' }) }, want: { action: 'done', state: 'cancelled', tell: 'j is cancelled' } },
  { name: 'G2 a failed job reports its reason', fx: { job: job({ stage: 'backlog', state: 'failed', reason: 'worktree setup failed' }) }, want: { action: 'done', state: 'failed', tell: 'j failed: worktree setup failed' } },
  { name: 'G3 releases the claim while the PR waits', fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', owner: { session: 's', host: 'h', since: t(0), heartbeat: t(0) } }) }, want: run('job', 'release', 'j') },
  { name: 'G3 stops background processes', fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review' }), runtime: ['dev'] }, want: run('stop', 'j') },
  {
    name: 'G3 waits on review and names a missing issue',
    fx: { config: (c) => (c.tracker.kind = 'local'), job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }) },
    want: { action: 'wait', waitingOn: 'pr-review', running: [], tell: 'j PR https://github.com/o/r/pull/7 waits on review\nj has no linked issue: `forge job link j <ref>` or `--none`' },
  },
  { name: 'G4 waiting on budget', fx: { job: job({ stage: 'build', state: 'waiting', waitingOn: 'budget', reason: 'usd 12 > 10' }) }, want: { action: 'wait', waitingOn: 'budget', tell: 'j over budget: usd 12 > 10. /forge approve j to acknowledge, or raise it: forge job budget j --set usd=…' } },
  {
    name: 'G4 a repo budget hold tells the ack of the current month, not the per-job budget',
    fx: { job: job({ stage: 'build', state: 'waiting', waitingOn: 'budget', reason: 'repo budget: $103.20 of $100.00 this month' }) },
    want: { action: 'wait', waitingOn: 'budget', tell: `j held by the repo budget (repo budget: $103.20 of $100.00 this month). A human runs forge budget ack --period ${new Date().toISOString().slice(0, 7)}, or raises budget.usdPerMonth in .forge/config.yml; the job resumes once the repo is under its cap` },
  },
  {
    name: 'G4 a repo budget hold on the day cap tells the ack of the current day',
    fx: { job: job({ stage: 'build', state: 'waiting', waitingOn: 'budget', reason: 'repo budget: $5.00 of $5.00 today' }) },
    want: { action: 'wait', waitingOn: 'budget', tell: `j held by the repo budget (repo budget: $5.00 of $5.00 today). A human runs forge budget ack --period ${new Date().toISOString().slice(0, 10)}, or raises budget.usdPerDay in .forge/config.yml; the job resumes once the repo is under its cap` },
  },
  { name: 'G4 blocked waits on external', fx: { job: job({ stage: 'build', state: 'blocked', reason: 'dependency' }) }, want: { action: 'wait', waitingOn: 'external', tell: 'j waits: dependency' } },
  { name: 'G4 an escalation names the decision', fx: { job: job({ stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: see decision.md' }) }, want: { action: 'wait', waitingOn: 'escalation', tell: `j escalated (approver escalated: see decision.md): see ${path.join(JOB_DIR, 'decision.md')}. /forge approve j or /forge rework j <note>` } },
  { name: 'G4 spec approval names the spec and mockup', fx: { files: ['spec', 'mockup'], job: job({ stage: 'spec', state: 'waiting', waitingOn: 'spec-approval' }) }, want: { action: 'wait', waitingOn: 'spec-approval', tell: `j spec ready: ${path.join(JOB_DIR, 'spec.md')} · mockup ${path.join(JOB_DIR, 'mockup.html')}. /forge approve j or /forge revise j <note>` } },
  { name: 'G4 running agents are listed at a gate', fx: { job: job({ stage: 'review', state: 'waiting', waitingOn: 'budget', agents: { 'reviewer:tests': ag(1, 1) } }) }, want: { action: 'wait', waitingOn: 'budget', running: ['reviewer:tests'] } },
  { name: 'G5 waits on running agents', fx: { job: job({ stage: 'build', round: 1, agents: { builder: ag(1, 5) } }) }, want: { action: 'wait', waitingOn: 'agents', running: ['builder'] } },
  { name: 'L1 respawns a lost builder without resume', fx: { files: ['spec'], job: job({ stage: 'build', round: 1, agents: { builder: ag(1, 5, 6, { status: 'lost' }) } }), events: [ev('round', 4)] }, want: { action: 'spawn', role: 'builder' }, check: (a) => assert.equal(a.resume, undefined) },
  { name: 'L1 respawns a failed approver', fx: { job: atDecide({ agents: { approver: ag(1, 20, 21, { status: 'failed' }) } }) }, want: { action: 'spawn', role: 'approver' } },

  // ---- Per-role generic rules
  { name: 'N1 parks a spec-writer that asked', fx: { job: job({ stage: 'spec', agents: { 'spec-writer': ag(0, 1, 2, { summary: 'SPEC: NEEDS-INPUT · 2 questions' }) } }) }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'input', '--reason', 'spec-writer has questions') },
  { name: 'N1 an eval NEEDS-INPUT fails the task', fx: { job: job({ kind: 'eval', stage: 'spec', agents: { 'spec-writer': ag(0, 1, 2, { summary: 'NEEDS-INPUT' }) } }) }, want: run('job', 'set', 'j', '--state', 'failed', '--reason', 'eval: NEEDS-INPUT fails the task') },
  { name: 'N1 builder asked in this round', fx: { job: job({ stage: 'build', round: 1, agents: { builder: ag(1, 5, 6, { summary: 'needs-input' }) } }), events: [ev('round', 4)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'input', '--reason', 'builder has questions') },
  {
    name: 'N2 resumes the agent after an answer',
    fx: { files: ['questions'], job: job({ stage: 'spec', agents: { 'spec-writer': ag(0, 1, 2, { summary: 'NEEDS-INPUT' }) } }), events: [ev('human', 5, { action: 'answer', note: 'x' })] },
    want: { action: 'spawn', role: 'spec-writer', resume: 'a1' },
    check: (a) => assert.ok(a.brief.includes(path.join(JOB_DIR, 'questions.md'))),
  },
  {
    name: 'M1 retries a reviewer that wrote no review',
    fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: true, output: 'review/round-1/code.md' }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped },
    want: { action: 'spawn', role: 'reviewer:code', lens: 'code', retry: true, output: path.join(JOB_DIR, 'review', 'round-1', 'code.md') },
    check: (a) => {
      assert.equal(a.start.at(-1), '--retry');
      assert.ok(a.brief.includes(`Retry: ${path.join(JOB_DIR, 'review', 'round-1', 'code.md')}`));
    },
  },
  {
    name: 'M1 a pre-v6 reviewer record falls back to MISSING',
    fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13), 'reviewer:tests': ag(1, 12, 13) }), events: scoped, verdicts: { round: verdicts({ code: 'MISSING', tests: 'PASS' }) } },
    want: { action: 'spawn', role: 'reviewer:code', retry: true },
  },
  {
    name: 'M2 escalates after the retry also wrote nothing',
    fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: true, retry: true }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped },
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'reviewer code wrote no review', '--note', 'reviewer:code ended twice without writing code.md'),
  },
  // Review-stage retries go out back to back like first spawns (RV4), not one per G5.
  {
    name: 'M1 retries a lost reviewer while another retry runs',
    fx: { job: inReview({ 'reviewer:code': ag(1, 14, undefined, { retry: true }), 'reviewer:tests': ag(1, 12, 13, { status: 'lost', outputMissing: true }) }), events: scoped },
    want: { action: 'spawn', role: 'reviewer:tests', parallel: true, retry: true },
  },
  {
    name: 'G5 waits on a running retry; a retried lens is not respawned',
    fx: { job: inReview({ 'reviewer:code': ag(1, 14), 'reviewer:tests': ag(1, 12, 13, { outputMissing: true, retry: true }) }), events: scoped },
    want: { action: 'wait', waitingOn: 'agents', running: ['reviewer:code'] },
  },
  {
    name: "M1 a retryable lens goes before another lens's M2",
    fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: true, retry: true }), 'reviewer:tests': ag(1, 12, 13, { status: 'lost', outputMissing: true }) }), events: scoped },
    want: { action: 'spawn', role: 'reviewer:tests', parallel: true, retry: true },
  },
  {
    name: 'M1 a pre-v6 lost reviewer retries while another runs',
    fx: { job: inReview({ 'reviewer:code': ag(1, 14), 'reviewer:tests': ag(1, 12, 13, { status: 'lost' }) }), events: scoped, verdicts: { round: verdicts({ code: 'MISSING', tests: 'MISSING' }) } },
    want: { action: 'spawn', role: 'reviewer:tests', parallel: true, retry: true },
  },
  {
    name: 'M1 a lost integration reviewer retries without parallel',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { status: 'lost', outputMissing: true }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })] },
    want: { action: 'spawn', role: 'reviewer:code', retry: true },
    check: (a) => assert.equal(a.parallel, undefined),
  },
  { name: 'M1 approver wrote no decision.md', fx: { job: atDecide({ agents: { approver: ag(1, 20, 21, { outputMissing: true }) } }) }, want: { action: 'spawn', role: 'approver', retry: true } },
  { name: 'M2 approver twice without decision.md', fx: { job: atDecide({ agents: { approver: ag(1, 20, 21, { outputMissing: true, retry: true }) } }) }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'approver wrote no decision.md', '--note', 'approver ended twice without writing decision.md') },

  // ---- Kind gates
  { name: 'K1 a retro job starts with the procedure', fx: { job: job({ kind: 'retro', stage: 'backlog' }) }, want: { action: 'procedure', reference: path.join(path.resolve(import.meta.dirname, '..'), 'skills', 'forge', 'reference', 'retro.md') } },
  { name: 'K1 a retro that wrote no spec.md', fx: { job: job({ kind: 'retro', stage: 'backlog', agents: { retro: ag(0, 1, 2) } }) }, want: { action: 'procedure' } },
  { name: 'K2 a retro with spec.md moves to spec', fx: { files: ['spec'], job: job({ kind: 'retro', stage: 'backlog', agents: { retro: ag(0, 1, 2) } }) }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'running') },

  // ---- Intake
  { name: 'I1 looks for issue candidates', fx: { config: (c) => (c.tracker.kind = 'local'), job: job({ stage: 'backlog', state: 'queued' }) }, want: run('job', 'link', 'j', '--suggest') },
  ...UNLINKED.map(([why, j, events]) => ({ name: `I1 reads issues: ${why}`, fx: { config: LOCAL, job: job({ stage: 'backlog', state: 'queued', ...j }), events }, want: run('job', 'link', 'j', '--suggest') })),
  { name: 'G4 issue-link tell names the candidates as untrusted', fx: { job: job({ stage: 'backlog', state: 'waiting', waitingOn: 'issue-link' }) }, want: { action: 'wait', tell: `j needs an issue: candidates in ${path.join(JOB_DIR, 'issue-candidates.md')} (untrusted). /forge approve j <ref> | new | none [reason]` } },
  { name: 'I3 creates the worktree', fx: { worktree: false, job: job({ stage: 'backlog' }) }, want: run('worktree', 'create', 'j') },
  {
    name: 'I3: a member repo worktree is missing',
    fx: { worktree: false, job: job({ stage: 'backlog', repos: [{ repo: null, worktree: WT, branch: 'forge/j', base: 'main', pr: null, verifyOnly: false }, { repo: 'lib', worktree: null, branch: 'forge/j', base: 'main', pr: null, verifyOnly: false }] }) },
    want: run('worktree', 'create', 'j'),
  },
  {
    name: 'I3: every job repo has its worktree',
    fx: { job: job({ stage: 'backlog', repos: [{ repo: null, worktree: WT, branch: 'forge/j', base: 'main', pr: null, verifyOnly: false }, { repo: 'lib', worktree: '/lib.worktrees/j', branch: 'forge/j', base: 'main', pr: null, verifyOnly: false }] }) },
    want: run('pr', 'find', 'j'),
  },
  { name: 'I3 an unlinked job with candidates gets its worktree', fx: { config: LOCAL, files: ['issueCandidates'], worktree: false, job: job({ stage: 'backlog' }) }, want: run('worktree', 'create', 'j') },
  { name: 'I8 an unlinked job specs like a linked one', fx: { config: LOCAL, files: ['issueCandidates'], job: job({ stage: 'backlog' }), events: [ev('pr-find', 1)] }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'running') },
  { name: 'I7 an unlinked long request gets a planner', fx: { config: LOCAL, files: ['issueCandidates'], job: job({ stage: 'backlog' }), events: [ev('pr-find', 1)], request: { length: 601 } }, want: run('job', 'set', 'j', '--stage', 'plan', '--state', 'running') },
  { name: 'I4 a failed setup command fails the job', fx: { job: job({ stage: 'backlog' }), events: [ev('worktree', 1), ev('worktree-setup-failed', 2)] }, want: run('job', 'set', 'j', '--state', 'failed', '--reason', 'worktree setup failed') },
  { name: 'I5 looks for an existing PR', fx: { job: job({ stage: 'backlog' }) }, want: run('pr', 'find', 'j') },
  { name: 'I6 an existing PR is a continuation', fx: { job: job({ stage: 'backlog', pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }), events: [ev('pr-adopted', 1)] }, want: { action: 'procedure', why: 'PR exists' } },
  { name: 'I7 a long request gets a planner', fx: { job: job({ stage: 'backlog' }), events: [ev('pr-find', 1, { found: false })], request: { length: 601 } }, want: run('job', 'set', 'j', '--stage', 'plan', '--state', 'running') },
  { name: 'I7 three list lines get a planner', fx: { job: job({ stage: 'backlog' }), events: [ev('pr-find', 1)], request: { listLines: 3 } }, want: run('job', 'set', 'j', '--stage', 'plan', '--state', 'running') },
  { name: 'I7 pipeline.plan always plans', fx: { config: (c) => (c.pipeline.plan = 'always'), job: job({ stage: 'backlog' }), events: [ev('pr-find', 1)] }, want: run('job', 'set', 'j', '--stage', 'plan', '--state', 'running') },
  { name: 'I8 a short request goes straight to spec', fx: { job: job({ stage: 'backlog' }), events: [ev('pr-find', 1)], request: { length: 600, listLines: 2 } }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'running') },
  { name: 'I8 pipeline.plan never skips planning', fx: { config: (c) => (c.pipeline.plan = 'never'), job: job({ stage: 'backlog' }), events: [ev('pr-find', 1)], request: { length: 5000 } }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'running') },
  { name: 'I8 pr.enabled false skips the PR lookup', fx: { config: (c) => (c.pr.enabled = false), job: job({ stage: 'backlog' }) }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'running') },

  // ---- Plan
  { name: 'P1 spawns the planner', fx: { job: job({ stage: 'plan' }) }, want: { action: 'spawn', role: 'planner', output: path.join(JOB_DIR, 'plan.md') }, check: (a) => assert.ok(a.brief.includes('Split mode: ask')) },
  { name: 'P1 re-plans after revise-split with split mode never', fx: { job: job({ stage: 'plan', splitMode: 'never', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 2 }, events: [ev('human', 3, { action: 'revise-split' })] }, want: { action: 'spawn', role: 'planner' }, check: (a) => assert.ok(a.brief.includes('Split mode: never')) },
  { name: 'P2 a split under auto follows split.md', fx: { config: (c) => (c.pipeline.split = 'auto'), job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 3 } }, want: { action: 'procedure', why: 'PLAN: SPLIT under pipeline.split auto' }, check: (a) => assert.ok(a.reference.endsWith(path.join('reference', 'split.md'))) },
  { name: 'P2 approve-split recorded → split.md', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 3 }, events: [ev('human', 5, { action: 'approve-split', actor: 'foreman' })] }, want: { action: 'procedure', rule: 'P2', why: 'PLAN: SPLIT approved' }, check: (a) => assert.ok(a.reference.endsWith(path.join('reference', 'split.md'))) },
  { name: 'P3 an approve-split older than the planner still parks', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 3, 4) } }), plan: { verdict: 'SPLIT', jobs: 3 }, events: [ev('human', 1, { action: 'approve-split' })] }, want: { action: 'run', rule: 'P3' } },
  { name: 'P3 a split under ask waits for approval', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 3 } }, want: run('job', 'set', 'j', '--stage', 'plan', '--state', 'waiting', '--waiting-on', 'split-approval', '--reason', 'planner proposes 3 jobs') },
  { name: 'P3 a split returned under never still waits', fx: { config: (c) => (c.pipeline.split = 'never'), job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 2 } }, want: { action: 'run', rule: 'P3' } },
  { name: 'G4 split-approval tell', fx: { files: ['plan'], plan: { verdict: 'SPLIT', jobs: 3 }, job: job({ stage: 'plan', state: 'waiting', waitingOn: 'split-approval' }) }, want: { action: 'wait', tell: `j planner proposes 3 jobs: ${path.join(JOB_DIR, 'plan.md')}. /forge approve j to create them, or /forge revise j [note] to keep one job` } },
  { name: 'P4 a single plan moves to spec', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SINGLE' } }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'running'), check: (a) => assert.equal(a.tell, undefined) },
  { name: 'P4 a split recommendation is told', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SINGLE', recommendSplit: true } }, want: { action: 'run', tell: `j plan recommends splitting: ${path.join(JOB_DIR, 'plan.md')}` } },
  { name: 'P5 a plan without a PLAN line escalates', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }) }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'plan.md has no PLAN line') },
  { name: 'M1 planner wrote no plan.md', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2, { outputMissing: true }) } }) }, want: { action: 'spawn', role: 'planner', retry: true } },

  // ---- Split mode
  { name: 'split mode auto: a new job splits', fx: { config: (c) => (c.pipeline.split = 'auto'), job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 2 } }, want: { action: 'procedure', rule: 'P2' } },
  { name: 'split mode auto: a from-ref job never splits', fx: { config: (c) => (c.pipeline.split = 'auto'), job: job({ stage: 'plan', splitMode: 'never', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 2 } }, want: { action: 'run', rule: 'P3' } },
  { name: 'split mode auto: a from-ref planner is briefed never', fx: { config: (c) => (c.pipeline.split = 'auto'), job: job({ stage: 'plan', splitMode: 'never' }) }, want: { action: 'spawn', rule: 'P1' }, check: (a) => assert.ok(a.brief.includes('Split mode: never')) },
  { name: 'split mode ask: the planner is briefed ask', fx: { job: job({ stage: 'plan' }) }, want: { action: 'spawn' }, check: (a) => assert.ok(a.brief.includes('Split mode: ask')) },
  { name: 'split mode never: the planner is briefed never', fx: { config: (c) => (c.pipeline.split = 'never'), job: job({ stage: 'plan' }) }, want: { action: 'spawn' }, check: (a) => assert.ok(a.brief.includes('Split mode: never')) },
  { name: 'split mode: a revise-split job moves on once re-planned', fx: { config: (c) => (c.pipeline.split = 'auto'), job: job({ stage: 'plan', splitMode: 'never', agents: { planner: ag(0, 4, 5) } }), plan: { verdict: 'SINGLE' }, events: [ev('human', 3, { action: 'revise-split' })] }, want: { action: 'run', rule: 'P4' } },

  // ---- Spec
  { name: 'SP1 spawns the spec-writer', fx: { files: ['request'], job: job({ stage: 'spec' }) }, want: { action: 'spawn', role: 'spec-writer', agent: 'forge:spec-writer', model: 'opus', output: path.join(JOB_DIR, 'spec.md') }, check: (a) => assert.ok(a.brief.includes('Review panel: code, tests, security')) },
  { name: 'SP2 a revise-spec re-runs the spec-writer with feedback', fx: { files: ['feedback'], job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET, ev('human', 4, { action: 'revise-spec' })] }, want: { action: 'spawn', role: 'spec-writer' }, check: (a) => assert.ok(a.brief.includes(path.join(JOB_DIR, 'feedback.md'))) },
  { name: 'SP3 panel always lenses', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }) }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]') },
  { name: 'SP3 panel adds suggested lenses that exist', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { suggested: ['security', 'docs'] } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests","security"]') },
  { name: 'SP3 panel drops unknown and malformed names', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { suggested: ['evil;rm', 'UI ', 'Security', 'a\';touch x;\''] } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]') },
  {
    name: 'SP3 panel adds lenses whose when paths the Approach names, in panel order',
    fx: {
      config: (c) =>
        (c.review.panel = [
          { name: 'ui', when: 'dashboard/src/**, dashboard/style.css (check themes)' },
          { name: 'code', always: true },
          { name: 'security', when: 'lib/server.ts, lib/trackers/*, anything that runs shell commands' },
          { name: 'perf', when: 'hot paths and big loops' },
          { name: 'docs', when: 'README.md' },
        ]),
      job: job({ stage: 'spec', agents: SPEC_DONE }),
      spec: { approachPaths: ['dashboard/src/App.svelte', 'lib/trackers/github.ts'] },
    },
    want: run('job', 'set', 'j', '--field', 'reviewers=["ui","code","security"]'),
  },
  {
    name: 'SP3 panel adds lenses whose paths the Approach names',
    fx: {
      config: (c) =>
        (c.review.panel = [
          { name: 'code', always: true },
          { name: 'design', when: 'user-visible UI changes', paths: ['dashboard/src/**', '*.svelte'] },
          { name: 'security', when: 'anything that runs shell commands', paths: ['lib/server.ts'] },
          { name: 'docs', when: 'docs', paths: ['docs/**'] },
        ]),
      job: job({ stage: 'spec', agents: SPEC_DONE }),
      spec: { approachPaths: ['ui/Widget.svelte', 'lib/server.ts'] },
    },
    want: run('job', 'set', 'j', '--field', 'reviewers=["code","design","security"]'),
  },
  {
    name: 'SP3 panel records size and known services only',
    fx: { config: (c) => (c.components = [{ name: 'api', path: 'api', kind: 'service' }]), job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { size: 'L', services: ['api', 'evil;x', 'web'] } },
    want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'size=L', '--field', 'services=["api"]'),
  },
  { name: 'SP3 panel ignores a size that is not S, M or L', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { size: 'XL;rm' } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]') },
  { name: 'SP3 panel for a retro job is code and docs', fx: { files: ['spec'], job: job({ kind: 'retro', stage: 'spec', agents: { retro: ag(0, 1, 2) } }), spec: { suggested: ['security'] } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","docs"]') },
  { name: 'SP3 records the spec\'s complexity', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { complexity: 'high' } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'complexity=high') },
  { name: 'SP3 without a Complexity header records none', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }) }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]') },
  { name: 'SP3 clears a stale complexity', fx: { job: job({ stage: 'spec', complexity: 'low', agents: SPEC_DONE }) }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'complexity=null') },
  { name: 'SP3 ignores an invalid complexity', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { complexity: 'extreme' } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]') },
  { name: 'SP3 panel is re-recorded after a new spec', fx: { job: job({ stage: 'spec', agents: { 'spec-writer': ag(0, 4, 5) } }), events: [PANEL_SET] }, want: { action: 'run', rule: 'SP3' } },
  { name: 'SP4 a spec that needs design', fx: { config: (c) => (c.pipeline.design = 'reference'), job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET], spec: { needsDesign: true } }, want: run('job', 'set', 'j', '--stage', 'design', '--state', 'running') },
  { name: 'SP5 the spec gate under always', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET] }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready') },
  { name: 'SP5 large gates an L spec', fx: { config: (c) => (c.pipeline.specApproval = 'large'), job: job({ stage: 'spec', size: 'L', agents: SPEC_DONE }), events: [PANEL_SET] }, want: { action: 'run', rule: 'SP5' } },
  { name: 'SP5 a retro spec always waits', fx: { config: (c) => (c.pipeline.specApproval = 'never'), files: ['spec'], job: job({ kind: 'retro', stage: 'spec', agents: { retro: ag(0, 1, 2) } }), events: [PANEL_SET] }, want: { action: 'run', rule: 'SP5' } },
  { name: 'SP6 builds after a human approved the spec', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET, ev('human', 4, { action: 'approve-spec' })] }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
  { name: 'SP6 large lets an M spec through', fx: { config: (c) => (c.pipeline.specApproval = 'large'), job: job({ stage: 'spec', size: 'M', agents: SPEC_DONE }), events: [PANEL_SET] }, want: { action: 'run', rule: 'SP6' } },
  // ---- One human visit: the issue is chosen at the spec gate, or SP7 parks before build
  { name: "SP5 an unlinked job's gate says the issue is unlinked", fx: { config: LOCAL, job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET] }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready, issue unlinked') },
  ...UNLINKED.map(([why, j, events]) => ({ name: `SP5 reads issues: ${why}`, fx: { config: LOCAL, job: job({ stage: 'spec', agents: SPEC_DONE, ...j }), events: [PANEL_SET, ...events] }, want: { ...run('job', 'set', 'j', '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready, issue unlinked'), rule: 'SP5' } })),
  ...UNLINKED.map(([why, j, events]) => ({ name: `SP7 reads issues: ${why}`, fx: { config: (c: Config) => ((c.tracker.kind = 'local'), (c.pipeline.specApproval = 'never')), job: job({ stage: 'spec', agents: SPEC_DONE, ...j }), events: [PANEL_SET, ...events] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'issue-link', '--reason', 'link an issue before build'), rule: 'SP7' } })),
  { name: "SP5 a linked job's gate is unchanged", fx: { config: LOCAL, job: job({ stage: 'spec', agents: SPEC_DONE, ...LINKED }), events: [PANEL_SET] }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready') },
  { name: 'SP5 a job with no issue needed keeps the plain reason', fx: { config: LOCAL, job: job({ stage: 'spec', agents: SPEC_DONE, ...NO_ISSUE }), events: [PANEL_SET] }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready') },
  { name: 'SP5 a retro gate keeps the plain reason under a tracker', fx: { config: LOCAL, files: ['spec'], job: job({ kind: 'retro', stage: 'spec', agents: { retro: ag(0, 1, 2) } }), events: [PANEL_SET] }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready') },
  { name: 'G4 an unlinked spec gate tells the spec and the candidates', fx: { config: LOCAL, files: ['spec'], job: job({ stage: 'spec', state: 'waiting', waitingOn: 'spec-approval', reason: 'spec ready, issue unlinked' }) }, want: { action: 'wait', rule: 'G4', waitingOn: 'spec-approval', tell: `${SPEC_TELL}\n${LINK_TELL}` } },
  { name: 'G4 a linked spec gate tells only the spec', fx: { config: LOCAL, files: ['spec'], job: job({ stage: 'spec', state: 'waiting', waitingOn: 'spec-approval', reason: 'spec ready', ...LINKED }) }, want: { action: 'wait', rule: 'G4', waitingOn: 'spec-approval', tell: SPEC_TELL } },
  { name: 'SP7 an approved spec without an issue parks before build', fx: { config: LOCAL, job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET, ev('human', 4, { action: 'approve-spec' })] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'issue-link', '--reason', 'link an issue before build'), rule: 'SP7' } },
  { name: 'SP7 specApproval never parks before build', fx: { config: (c) => ((c.tracker.kind = 'local'), (c.pipeline.specApproval = 'never')), job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'issue-link', '--reason', 'link an issue before build'), rule: 'SP7' } },
  { name: 'SP7 large with an M spec parks before build', fx: { config: (c) => ((c.tracker.kind = 'local'), (c.pipeline.specApproval = 'large')), job: job({ stage: 'spec', size: 'M', agents: SPEC_DONE }), events: [PANEL_SET] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'issue-link', '--reason', 'link an issue before build'), rule: 'SP7' } },
  { name: 'SP6 builds an approved linked job', fx: { config: LOCAL, job: job({ stage: 'spec', agents: SPEC_DONE, ...LINKED }), events: [PANEL_SET, ev('human', 4, { action: 'approve-spec' })] }, want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'SP6' } },
  { name: 'SP6 builds an approved job with no issue needed', fx: { config: LOCAL, job: job({ stage: 'spec', agents: SPEC_DONE, ...NO_ISSUE }), events: [PANEL_SET, ev('human', 4, { action: 'approve-spec' })] }, want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'SP6' } },
  { name: 'SP6 a split child builds without an issue', fx: { config: LOCAL, job: job({ stage: 'spec', parent: 'p', agents: SPEC_DONE }), events: [PANEL_SET, ev('human', 4, { action: 'approve-spec' })] }, want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'SP6' } },
  { name: 'eval mode: no spec gate', fx: { job: job({ kind: 'eval', stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET] }, want: { action: 'run', rule: 'SP6' } },

  // ---- Design
  { name: 'D1 spawns the designer in reference mode', fx: { config: (c) => (c.pipeline.design = 'reference'), job: job({ stage: 'design', agents: SPEC_DONE }) }, want: { action: 'spawn', role: 'designer', output: path.join(JOB_DIR, 'design.md') }, check: (a) => assert.ok(a.brief.includes('Mode: reference')) },
  { name: 'D1 mockup mode', fx: { config: (c) => (c.pipeline.design = 'mockup'), job: job({ stage: 'design', agents: SPEC_DONE }) }, want: { action: 'spawn', role: 'designer' }, check: (a) => assert.ok(a.brief.includes('Mode: mockup')) },
  { name: 'eval mode: the designer uses references', fx: { config: (c) => (c.pipeline.design = 'mockup'), job: job({ kind: 'eval', stage: 'design', agents: SPEC_DONE }) }, want: { action: 'spawn', rule: 'D1' }, check: (a) => assert.ok(a.brief.includes('Mode: reference')) },
  { name: 'M1 designer wrote no design.md', fx: { job: job({ stage: 'design', agents: { ...SPEC_DONE, designer: ag(0, 4, 5, { outputMissing: true }) } }) }, want: { action: 'spawn', role: 'designer', retry: true } },
  { name: 'D2 folds the spec deltas in', fx: { job: job({ stage: 'design', agents: { ...SPEC_DONE, designer: ag(0, 4, 5) } }), designDeltas: true }, want: { action: 'spawn', role: 'spec-writer' }, check: (a) => assert.ok(a.brief.includes('Fold in the Spec deltas from design.md.')) },
  { name: 'D3 back to spec once folded in', fx: { job: job({ stage: 'design', agents: { 'spec-writer': ag(0, 6, 7), designer: ag(0, 4, 5) } }), designDeltas: true }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'running') },
  { name: 'D3 back to spec without deltas', fx: { job: job({ stage: 'design', agents: { ...SPEC_DONE, designer: ag(0, 4, 5) } }) }, want: { action: 'run', rule: 'D3' } },
  { name: 'N1 the fold-in spec-writer asked', fx: { job: job({ stage: 'design', agents: { 'spec-writer': ag(0, 6, 7, { summary: 'NEEDS-INPUT' }), designer: ag(0, 4, 5) } }), designDeltas: true }, want: { action: 'run', rule: 'N1' } },

  // ---- Build
  { name: 'B1 starts round 1', fx: { job: job({ stage: 'build', round: 0 }) }, want: run('job', 'round', 'j') },
  { name: 'B1 starts the next round after CHANGES', fx: { job: job({ stage: 'build', round: 1, verdicts: { 1: { code: 'CHANGES' } }, agents: { builder: ag(1, 5, 6) } }) }, want: run('job', 'round', 'j') },
  { name: 'B1 a human rework starts a round', fx: { job: job({ stage: 'build', round: 2, agents: { builder: ag(2, 5, 6) } }), events: [ev('round', 4), ev('human', 7, { action: 'rework' })] }, want: run('job', 'round', 'j') },
  { name: 'B2 rounds exhausted', fx: { job: job({ stage: 'build', round: 4, maxRounds: 3, agents: { builder: ag(3, 5, 6) } }), events: [ev('round', 7)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 4 exceeds maxRounds 3') },
  { name: 'rounds exhausted: a human rework continues', fx: { job: job({ stage: 'build', round: 4, maxRounds: 3, agents: { builder: ag(3, 5, 6) } }), events: [ev('human', 7, { action: 'rework' }), ev('round', 8)] }, want: { action: 'spawn', rule: 'B4', role: 'builder' } },
  { name: 'B4 a rework past maxRounds spawns the builder', fx: { job: job({ stage: 'build', round: 5, maxRounds: 3, agents: { builder: ag(4, 5, 6) } }), events: [ev('round', 10), ev('human', 20, { action: 'rework' }), ev('round', 21)] }, want: { action: 'spawn', rule: 'B4', role: 'builder' } },
  { name: 'B5 a rework past maxRounds verifies after its builder ends', fx: { job: job({ stage: 'build', round: 5, maxRounds: 3, agents: { builder: ag(5, 22, 30) } }), events: [ev('round', 10), ev('human', 20, { action: 'rework' }), ev('round', 21)] }, want: run('job', 'set', 'j', '--stage', 'verify', '--state', 'running') },
  {
    name: 'B4 a failing verify in a reworked round past maxRounds sends the builder back',
    fx: { present: [path.join(JOB_DIR, 'verify', 'round-5.md')], job: job({ stage: 'build', round: 5, maxRounds: 3, verifyRuns: [vr(5, 31, false)], agents: { builder: ag(5, 22, 30) } }), events: [ev('round', 10), ev('human', 20, { action: 'rework' }), ev('round', 21)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
  },
  {
    name: 'B2 a later round past maxRounds without a new rework parks',
    fx: { job: job({ stage: 'build', round: 6, maxRounds: 3, verdicts: { 5: { code: 'CHANGES' } }, agents: { builder: ag(5, 22, 30) } }), events: [ev('round', 10), ev('human', 20, { action: 'rework' }), ev('round', 21), ev('round', 40)] },
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 6 exceeds maxRounds 3'),
  },
  { name: 'G4 rounds-exhausted tell', fx: { job: job({ stage: 'build', round: 4, maxRounds: 3, state: 'waiting', waitingOn: 'rounds-exhausted' }) }, want: { action: 'wait', tell: 'j used all 3 rounds. /forge approve j to ship, or /forge rework j <note>' } },
  {
    name: 'B3 integrity fails twice around a builder run',
    fx: { job: job({ stage: 'build', round: 1, verifyRuns: [vr(1, 10, false, 'integrity'), vr(1, 14, false, 'integrity')], agents: { builder: ag(1, 11, 12) } }), events: [ev('round', 4)] },
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'integrity: verify failed twice on test integrity'),
  },
  {
    name: 'B4 spawns the round-1 builder',
    fx: { files: ['spec', 'tasks'], job: job({ stage: 'build', round: 1 }), events: [ev('round', 4)] },
    want: { action: 'spawn', role: 'builder', agent: 'forge:builder', round: 1 },
    check: (a) => {
      assert.equal(a.output, undefined);
      assert.equal(a.resume, undefined);
      assert.ok(!a.brief.includes('Rework:'));
      assert.ok(!a.brief.includes('Rework scope:'));
      assert.ok(!a.brief.includes('Reference:'));
      assert.ok(a.brief.includes('Infra: mode human · allowed []'));
      assert.equal(a.brief.split('\n').length, 12);
      assert.ok(a.brief.split('\n').includes(`Inputs: ${path.join(JOB_DIR, 'spec.md')}, ${path.join(JOB_DIR, 'tasks.md')}`));
    },
  },
  {
    name: 'B4 a review rework spawns a fresh builder with a findings-first brief',
    fx: {
      files: ['spec', 'feedback', 'tasks', 'build'],
      present: [path.join(JOB_DIR, 'review', 'round-1', 'code.md'), path.join(JOB_DIR, 'review', 'round-1', 'tests.md')],
      job: job({ stage: 'build', round: 2, verdicts: { 1: { code: 'CHANGES', tests: 'PASS' } }, agents: { builder: ag(1, 5, 6, { agentId: 'b1' }) } }),
      events: [ev('round', 7)],
    },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      assert.equal(a.resume, undefined);
      assert.ok(!('resume' in a));
      const lines = a.brief.split('\n');
      assert.ok(lines.includes(`Inputs: ${[path.join(JOB_DIR, 'review', 'round-1', 'code.md'), path.join(JOB_DIR, 'feedback.md'), path.join(JOB_DIR, 'tasks.md'), path.join(JOB_DIR, 'build.md')].join(', ')}`));
      assert.ok(lines.includes('Rework: review, feedback'));
      assert.ok(lines.some((l: string) => l.startsWith('Rework scope: ')));
      assert.ok(lines.includes(`Reference: ${path.join(JOB_DIR, 'spec.md')}`));
    },
  },
  {
    name: 'B4 a failing verify sends a fresh builder back',
    fx: { files: ['spec', 'tasks', 'build'], present: [path.join(JOB_DIR, 'verify', 'round-1.md')], job: job({ stage: 'build', round: 1, verifyRuns: [vr(1, 10, false)], agents: { builder: ag(1, 5, 6) } }), events: [ev('round', 4)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      assert.ok(!('resume' in a));
      const lines = a.brief.split('\n');
      assert.ok(lines.includes(`Inputs: ${[path.join(JOB_DIR, 'verify', 'round-1.md'), path.join(JOB_DIR, 'tasks.md'), path.join(JOB_DIR, 'build.md')].join(', ')}`));
      assert.ok(lines.includes('Rework: verify'));
      assert.ok(lines.some((l: string) => l.startsWith('Rework scope: ')));
    },
  },
  {
    name: 'B4 a PR rework brings pr-feedback',
    fx: { files: ['spec', 'prFeedback'], job: job({ stage: 'build', round: 2, verdicts: { 1: { code: 'PASS' } }, pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) }, agents: { builder: ag(1, 5, 6) } }), events: [ev('round', 7)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      assert.ok(!('resume' in a));
      const inputs = a.brief.split('\n').find((l: string) => l.startsWith('Inputs: '));
      assert.ok(inputs.includes(path.join(JOB_DIR, 'pr-feedback.md')));
      assert.ok(!inputs.includes(path.join(JOB_DIR, 'spec.md')));
      assert.ok(a.brief.includes('Rework: pr-feedback') && a.brief.includes('Rework scope: '));
    },
  },
  {
    name: 'N2 resumes a builder after an answer',
    fx: { files: ['spec', 'questions'], job: job({ stage: 'build', round: 2, agents: { builder: ag(2, 8, 9, { summary: 'NEEDS-INPUT', agentId: 'b9' }) } }), events: [ev('round', 7), ev('human', 10, { action: 'answer', note: 'x' })] },
    want: { action: 'spawn', rule: 'N2', role: 'builder', resume: 'b9' },
    check: (a) => {
      assert.ok(a.brief.includes(path.join(JOB_DIR, 'questions.md')));
      assert.ok(a.brief.split('\n').includes('Rework: answer'));
      assert.ok(!a.brief.includes('Rework scope:'));
    },
  },
  {
    name: 'B4 a rework after an answered question spawns fresh',
    fx: {
      files: ['spec', 'questions', 'feedback'],
      job: job({ stage: 'build', round: 2, agents: { builder: ag(1, 5, 6, { summary: 'NEEDS-INPUT', agentId: 'b5' }) } }),
      events: [ev('round', 4), ev('human', 7, { action: 'answer', note: 'x' }), ev('human', 8, { action: 'rework', note: 'y' }), ev('round', 9)],
    },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      assert.ok(!('resume' in a));
      const lines = a.brief.split('\n');
      assert.ok(lines.find((l: string) => l.startsWith('Rework: '))?.endsWith('answer'));
      assert.ok(lines.find((l: string) => l.startsWith('Inputs: '))?.includes(path.join(JOB_DIR, 'questions.md')));
    },
  },
  {
    name: 'hostile: a malformed lens name is never a rework input',
    fx: {
      files: ['tasks'],
      present: [path.join(JOB_DIR, 'review', 'round-1', '../x.md'), path.join(JOB_DIR, 'review', 'round-1', 'code.md')],
      job: job({ stage: 'build', round: 2, verdicts: { 1: { '../x': 'CHANGES', code: 'CHANGES' } }, agents: { builder: ag(1, 5, 6) } }),
      events: [ev('round', 7)],
    },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      const inputs = a.brief.split('\n').find((l: string) => l.startsWith('Inputs: '));
      assert.equal(inputs, `Inputs: ${path.join(JOB_DIR, 'review', 'round-1', 'code.md')}, ${path.join(JOB_DIR, 'tasks.md')}`);
      assert.ok(!a.brief.includes(path.join(JOB_DIR, 'review', 'x.md')));
    },
  },
  { name: 'B5 the builder committed: verify', fx: { job: job({ stage: 'build', round: 1, agents: { builder: ag(1, 5, 6) } }), events: [ev('round', 4)] }, want: run('job', 'set', 'j', '--stage', 'verify', '--state', 'running') },

  // ---- Verify
  { name: 'V1 verifies the round', fx: { job: job({ stage: 'verify', round: 1, agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('verify', 'j'), shell: "forge verify j" } },
  { name: 'V1 re-verifies after the builder fixed it', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 4, false)], agents: { builder: ag(1, 5, 6) } }) }, want: run('verify', 'j') },
  { name: 'V2 a pass goes to review', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6) } }) }, want: run('job', 'set', 'j', '--stage', 'review', '--state', 'running') },
  { name: 'V3 a failure goes back to build', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, false)], agents: { builder: ag(1, 5, 6) } }) }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
  // Verifiers (VF1–VF3): only when the main checkout has .forge/verifiers/*.md, between a passing verify and V2.
  { name: 'VF1 runs the verifiers after a passing verify', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('verifiers', 'run', 'j'), shell: 'forge verifiers run j' } },
  {
    name: 'VF2 spawns the verifier on haiku with the answers as output',
    fx: { verifiers: 2, present: [VF_INPUT], job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6) } }), events: [VF_RUN] },
    want: { action: 'spawn', role: 'verifier', agent: 'forge:verifier', model: 'haiku', output: VF_ANSWERS },
    check: (a) => {
      const lines = a.brief.split('\n');
      assert.ok(lines.includes(`Inputs: ${VF_INPUT}`), a.brief);
      assert.ok(lines.includes(`Output: ${VF_ANSWERS}`));
      assert.ok(lines.includes('Verifiers: 2 selected'));
      assert.deepEqual(a.start, ['job', 'agent', 'j', 'start', '--role', 'verifier', '--model', 'haiku', '--output', VF_ANSWERS]);
    },
  },
  {
    name: 'VF2 retries a verifier that ended without answers',
    fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10, { outputMissing: true }) } }), events: [VF_RUN] },
    want: { action: 'spawn', role: 'verifier', retry: true },
  },
  { name: 'VF3 records the answers', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10, { outputMissing: false }) } }), events: [VF_RUN] }, want: run('verifiers', 'record', 'j') },
  { name: 'VF3 records after the retry wrote nothing either', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10, { outputMissing: true, retry: true }) } }), events: [VF_RUN] }, want: run('verifiers', 'record', 'j') },
  { name: 'V2 after a verifiers pass', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10) } }), events: [VF_RUN, ev('verifiers', 11, { phase: 'record', round: 1, sha: 's', outcome: 'PASS', blocking: 0, warned: 1, results: [] })] }, want: run('job', 'set', 'j', '--stage', 'review', '--state', 'running') },
  { name: 'V3 after a verifiers failure', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true), VF_FAIL], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10) } }), events: [VF_RUN, ev('verifiers', 11, { phase: 'record', round: 1, sha: 's', outcome: 'CHANGES' })] }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
  {
    name: 'B4 rework from verifiers',
    fx: { verifiers: 2, files: ['spec', 'tasks', 'build'], present: [VF_REPORT, path.join(JOB_DIR, 'verify', 'round-1.md')], job: job({ stage: 'build', round: 1, verifyRuns: [vr(1, 7, true), VF_FAIL], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10) } }), events: [ev('round', 4)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      const lines = a.brief.split('\n');
      assert.ok(lines.includes('Rework: verifiers'), a.brief);
      assert.ok(lines.includes(`Inputs: ${[VF_REPORT, path.join(JOB_DIR, 'tasks.md'), path.join(JOB_DIR, 'build.md')].join(', ')}`), a.brief);
    },
  },
  { name: 'G5 waits on the verifier', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9) } }), events: [VF_RUN] }, want: { action: 'wait', waitingOn: 'agents', running: ['verifier'] } },
  { name: 'L1 respawns a lost verifier', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10, { status: 'lost' }) } }), events: [VF_RUN] }, want: { action: 'spawn', role: 'verifier' } },

  // ---- Review
  { name: 'RV1 no lens this round goes to pr', fx: { config: (c) => (c.review.onPrFeedback = 'none'), job: inReview({}, { pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }) }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  { name: 'RV2 writes the scope report first', fx: { job: inReview(), events: [panelled, ev('scope', 3, { round: 1 })] }, want: run('job', 'scope', 'j') },
  { name: 'RV9 picks the panel before anything else in review', fx: { job: inReview(), events: [ev('round', 4, { round: 1 })] }, want: { ...run('job', 'panel', 'j'), rule: 'RV9', shell: 'forge job panel j' } },
  { name: 'RV9 runs again when the panel predates the last verify', fx: { job: inReview(), events: [ev('panel', 8, { round: 1 }), ev('scope', 11, { round: 1 })] }, want: { ...run('job', 'panel', 'j'), rule: 'RV9' } },
  { name: 'RV9 runs again when the panel is of another round', fx: { job: inReview(), events: [ev('panel', 11, { round: 0 }), ev('scope', 11, { round: 1 })] }, want: { ...run('job', 'panel', 'j'), rule: 'RV9' } },
  { name: 'RV9 a reviewer of an earlier round does not count', fx: { job: inReview({ 'reviewer:code': ag(0, 2, 3) }), events: [ev('scope', 11, { round: 1 })] }, want: { ...run('job', 'panel', 'j'), rule: 'RV9' } },
  { name: 'RV9 runs on a PR rework under full', fx: { config: (c) => (c.review.onPrFeedback = 'full'), job: inReview({}, { pr: OPEN_PR }), events: [ev('scope', 11, { round: 1 })] }, want: { ...run('job', 'panel', 'j'), rule: 'RV9' } },
  { name: 'RV3 starts the dev server for UI lenses', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({}, { reviewers: ['code', 'ui'] }), events: scoped }, want: run('run', 'j', 'dev', '--background') },
  { name: 'RV3 starts the dev server for the design lens', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({}, { reviewers: ['code', 'design'] }), events: scoped }, want: run('run', 'j', 'dev', '--background') },
  { name: 'RV3 starts the dev server for a custom needsApp lens', fx: { config: (c) => { c.commands.dev = 'npm run dev'; c.review.panel.push({ name: 'visual-qa', needsApp: true, checklist: 'reviewers/ui.md' }); }, job: inReview({}, { reviewers: ['code', 'visual-qa'] }), events: scoped }, want: run('run', 'j', 'dev', '--background') },
  { name: 'RV4 a ui lens with needsApp false skips RV3',fx: { config: (c) => { c.commands.dev = 'npm run dev'; c.review.panel.push({ name: 'ui', needsApp: false }); }, job: inReview({}, { reviewers: ['code', 'ui'] }), events: scoped }, want: { action: 'spawn', role: 'reviewer:code' } },
  {
    name: 'RV4 spawns the first lens in parallel',
    fx: { job: inReview(), events: scoped },
    want: { action: 'spawn', role: 'reviewer:code', agent: 'forge:reviewer', lens: 'code', model: 'sonnet', parallel: true, output: path.join(JOB_DIR, 'review', 'round-1', 'code.md') },
    check: (a) => {
      assert.deepEqual(a.start, ['job', 'agent', 'j', 'start', '--role', 'reviewer:code', '--model', 'sonnet', '--output', path.join(JOB_DIR, 'review', 'round-1', 'code.md')]);
      assert.ok(a.brief.includes('Lens: code') && a.brief.includes(`Scope: ${path.join(JOB_DIR, 'scope.md')}`) && a.brief.includes('Checklist: '));
    },
  },
  { name: 'RV4 spawns the next lens while one runs', fx: { job: inReview({ 'reviewer:code': ag(1, 12) }), events: scoped }, want: { action: 'spawn', role: 'reviewer:tests' }, check: (a) => assert.ok(!Object.hasOwn(a, 'spawns')) },
  {
    name: 'RV4 batches every unstarted lens of a 4-lens panel',
    fx: { job: inReview({}, { reviewers: ['code', 'tests', 'security', 'docs'] }), events: scoped },
    want: { action: 'spawn', role: 'reviewer:code', lens: 'code', parallel: true },
    check: (a) => {
      assert.deepEqual(a.spawns.map((s: any) => s.lens), ['tests', 'security', 'docs']);
      for (const s of a.spawns) {
        const output = path.join(JOB_DIR, 'review', 'round-1', `${s.lens}.md`);
        assert.equal(s.action, 'spawn');
        assert.equal(s.rule, 'RV4');
        assert.equal(s.parallel, true);
        assert.equal(s.role, `reviewer:${s.lens}`);
        assert.equal(s.output, output);
        assert.equal(typeof s.model, 'string');
        assert.ok(Object.hasOwn(s, 'effort'));
        assert.deepEqual(s.start, ['job', 'agent', 'j', 'start', '--role', `reviewer:${s.lens}`, '--model', s.model, '--output', output]);
        assert.equal(s.startShell, shellLine(s.start));
        assert.ok(s.brief.includes(`Lens: ${s.lens}`));
        assert.ok(!Object.hasOwn(s, 'spawns'));
      }
      assert.equal(a.spawns.find((s: any) => s.lens === 'security').model, 'opus');
      assert.deepEqual(Object.keys(a).at(-1), 'spawns');
    },
  },
  {
    name: 'RV4 batches only the lenses not yet started',
    fx: { job: inReview({ 'reviewer:code': ag(1, 12), 'reviewer:tests': ag(1, 12) }, { reviewers: ['code', 'tests', 'security', 'docs'] }), events: scoped },
    want: { action: 'spawn', role: 'reviewer:security' },
    check: (a) => assert.deepEqual(a.spawns.map((s: any) => s.role), ['reviewer:docs']),
  },
  { name: 'RV4 a panel model wins', fx: { job: inReview({}, { reviewers: ['security'] }), events: scoped }, want: { action: 'spawn', role: 'reviewer:security', model: 'opus' } },
  { name: 'RV4 a UI lens gets the dev server', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:code': ag(1, 12, 13) }, { reviewers: ['code', 'ui'] }), events: scoped, runtime: ['dev'] }, want: { action: 'spawn', role: 'reviewer:ui' }, check: (a) => assert.ok(a.brief.includes('Dev server: http://localhost:4100')) },
  { name: 'RV4 the design lens gets the dev server', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:code': ag(1, 12, 13) }, { reviewers: ['code', 'design'] }), events: scoped, runtime: ['dev'] }, want: { action: 'spawn', role: 'reviewer:design' }, check: (a) => assert.ok(a.brief.includes('Dev server: http://localhost:4100')) },
  { name: 'RV4 a needsApp false lens gets no dev server', fx: { config: (c) => { c.commands.dev = 'npm run dev'; c.review.panel.push({ name: 'ui', needsApp: false }); }, job: inReview({ 'reviewer:code': ag(1, 12, 13) }, { reviewers: ['code', 'ui'] }), events: scoped }, want: { action: 'spawn', role: 'reviewer:ui' }, check: (a) => assert.ok(!a.brief.includes('Dev server:')) },
  { name: 'G5 waits once every lens has started', fx: { job: inReview({ 'reviewer:code': ag(1, 12), 'reviewer:tests': ag(1, 12, 13) }), events: scoped }, want: { action: 'wait', waitingOn: 'agents', running: ['reviewer:code'] } },
  {
    name: 'RV5 a malformed review gets one retry',
    fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped, verdicts: { round: verdicts({ code: 'MALFORMED', tests: 'PASS' }) } },
    want: { action: 'spawn', role: 'reviewer:code', retry: true },
    check: (a) => assert.ok(a.brief.includes(`Retry: ${path.join(JOB_DIR, 'review', 'round-1', 'code.md')} has no VERDICT line; rewrite it in the required format.`)),
  },
  { name: 'RV5 malformed twice counts as CHANGES', fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false, retry: true }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped, verdicts: { round: verdicts({ code: 'MALFORMED', tests: 'PASS' }) } }, want: run('job', 'verdicts', 'j', '--compact', '--malformed', 'changes') },
  { name: 'RV6 records the verdicts', fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped, verdicts: { round: verdicts({ code: 'PASS', tests: 'CHANGES' }) } }, want: run('job', 'verdicts', 'j', '--compact') },
  { name: 'RV7 stops the dev server once verdicts are in', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: scoped, runtime: ['dev'] }, want: run('stop', 'j') },
  { name: 'RV7 stops a UI review\'s dev server', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:ui': ag(1, 12, 13) }, { reviewers: ['ui'], verdicts: { 1: { ui: 'PASS' } } }), events: scoped, runtime: ['dev'] }, want: run('stop', 'j') },
  { name: 'RV8 a UI lens with the dev server stopped moves on, never restarting it', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:code': ag(1, 12, 13), 'reviewer:ui': ag(1, 12, 13) }, { reviewers: ['code', 'ui'], verdicts: { 1: { code: 'PASS', ui: 'PASS' } } }), events: scoped, runtime: [] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'RV3 a UI retry before the verdicts gets the app again', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:ui': ag(1, 12, 13, { outputMissing: true }) }, { reviewers: ['code', 'ui'] }), events: scoped, runtime: [] }, want: run('run', 'j', 'dev', '--background') },
  { name: 'RV8 every lens passed: integrate', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'RV8 an eval job goes to decide', fx: { job: inReview({}, { kind: 'eval', eval: { run: 'r', task: 'hello' }, verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'decide', '--state', 'running') },
  { name: 'RV8 a lens asked for changes: build', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'CHANGES' } } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
  { name: 'RV8 a PR rework that passed goes to pr', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } }, pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },

  // ---- PR rework under onPrFeedback
  { name: 'PR rework full: the whole panel reviews', fx: { config: (c) => (c.review.onPrFeedback = 'full'), job: inReview({ 'reviewer:code': ag(1, 12), 'reviewer:tests': ag(1, 12) }, { reviewers: ['code', 'tests', 'security'], pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }), events: scoped }, want: { action: 'spawn', role: 'reviewer:security' } },
  {
    name: 'PR rework changed: only the always lenses, recorded with --reviewers',
    fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }, { reviewers: ['code', 'tests', 'security'], pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }), events: scoped, verdicts: { round: verdicts({ code: 'PASS', tests: 'PASS' }) } },
    want: run('job', 'verdicts', 'j', '--compact', '--reviewers', 'code,tests'),
  },
  { name: 'PR rework none: verify goes straight to pr', fx: { config: (c) => (c.review.onPrFeedback = 'none'), job: job({ stage: 'verify', round: 2, verifyRuns: [vr(2, 7, true)], agents: { builder: ag(2, 5, 6) }, pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }) }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },

  // ---- Decide
  {
    name: 'DC1 spawns the approver with policy and acs',
    fx: { job: job({ stage: 'decide', round: 1 }) },
    want: { action: 'spawn', role: 'approver', output: path.join(JOB_DIR, 'decision.md') },
    check: (a) => {
      assert.ok(a.brief.includes('Acceptance criteria (forge job acs): {"total":0'));
      assert.ok(a.brief.includes('Always escalate: ["changes to CI/CD'));
      assert.ok(a.brief.includes('Merge: auto false · autoWhen []'));
      assert.ok(a.brief.includes('Infra: mode human'));
      assert.ok(a.brief.includes(path.join(JOB_DIR, 'pr.md')));
    },
  },
  {
    name: 'DC1 the approver reads the integration review',
    fx: { job: job({ stage: 'decide', round: 1 }), files: ['spec'], present: [path.join(JOB_DIR, 'review', 'integration', 'code.md')] },
    want: { action: 'spawn', role: 'approver' },
    check: (a) => assert.ok(a.brief.split('\n').find((l: string) => l.startsWith('Inputs: '))!.includes(path.join(JOB_DIR, 'review', 'integration', 'code.md')), a.brief),
  },
  { name: 'DC1 no integration review, no input line for it', fx: { job: job({ stage: 'decide', round: 1 }), files: ['spec'] }, want: { action: 'spawn', role: 'approver' }, check: (a) => assert.ok(!a.brief.split('\n').find((l: string) => l.startsWith('Inputs: '))!.includes(path.join('review', 'integration', 'code.md')), a.brief) },
  { name: 'DC2 records the decision', fx: { job: atDecide(), decision: { decision: 'APPROVE' } }, want: run('job', 'decision', 'j') },
  { name: 'DC3 a decision.md without a decision line escalates', fx: { job: atDecide() }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'decision.md has no APPROVE/ESCALATE line') },
  { name: 'DC4 eval mode: the judge scores a rubric task', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' } }), decision: { decision: 'ESCALATE' }, events: [ev('decision', 22)], evalTask: { rubric: 'rubric.md', reference: null } }, want: { action: 'spawn', role: 'judge', output: path.join(JOB_DIR, 'eval-judge.md') }, check: (a) => assert.ok(a.brief.includes(`Eval task: ${path.join('/repo', '.forge', 'evals', 'hello')}`)) },
  { name: 'DC5 eval mode: grade once judged', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' }, agents: { approver: ag(1, 20, 21), judge: ag(1, 23, 24) } }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], evalTask: { rubric: 'rubric.md', reference: null } }, want: run('eval', 'grade', 'j') },
  { name: 'DC5 eval mode: no rubric, no judge', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' } }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], evalTask: { rubric: null, reference: null } }, want: run('eval', 'grade', 'j') },
  { name: 'DC6 eval mode: graded is done', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' } }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ev('eval-graded', 23)] }, want: run('job', 'set', 'j', '--stage', 'done', '--state', 'done') },
  { name: 'DC7 an escalation waits on a human', fx: { job: atDecide(), decision: { decision: 'ESCALATE' }, events: [ev('decision', 22)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'approver escalated: see decision.md') },
  { name: 'DC8 runbook steps before merge', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], runbookBeforeMerge: true }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'infra', '--reason', 'runbook: steps before merge') },
  { name: 'DC9 approved: integrate', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'DC9 approved on an integrated branch: pr', fx: { job: decidedLate(), decision: { decision: 'APPROVE' }, events: [reviewed, ev('integrated', 31, { behind: 0 }), tr(33, { stage: 'integrate' }, { stage: 'decide' }), ev('decision', 36)] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  { name: 'DC9 a legacy job with no integration since review integrates', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [tr(15, { stage: 'review' }, { stage: 'decide' }), ev('decision', 22)] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'DC9 an integration from an earlier round does not count', fx: { job: decidedLate({ round: 2, agents: { approver: ag(2, 34, 35) } }), decision: { decision: 'APPROVE' }, events: [tr(5, { stage: 'integrate' }, { stage: 'decide' }), tr(15, { stage: 'review' }, { stage: 'decide' }), ev('decision', 36)] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'DC7 a parked escalation stays parked without a human approve', fx: { job: decidedLate(), decision: { decision: 'ESCALATE' }, events: escalated.slice(0, 5) }, want: { rule: 'DC7' } },
  { name: 'DC9 approved after an escalation wait re-integrates', fx: { job: decidedLate(), decision: { decision: 'ESCALATE' }, events: unparked }, want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'DC9' } },
  { name: 'cleared gate: DC7 a human-cleared escalation re-entering decide goes on to DC9', fx: { job: decidedLate(), decision: { decision: 'ESCALATE' }, events: sentBack }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'DC9' } },
  { name: 'cleared gate: DC8 a human-cleared runbook re-entering decide goes on to DC9', fx: { job: decidedLate(), decision: { decision: 'APPROVE' }, events: runbookSentBack, runbookBeforeMerge: true }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'DC9' } },
  { name: 'DC7 a budget acknowledgement after an ESCALATE still parks', fx: { job: decidedLate(), decision: { decision: 'ESCALATE' }, events: budgetAck('ESCALATE') }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'approver escalated: see decision.md') },
  { name: 'DC8 a budget acknowledgement does not clear the runbook', fx: { job: decidedLate(), decision: { decision: 'APPROVE' }, events: budgetAck('APPROVE'), runbookBeforeMerge: true }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'infra', '--reason', 'runbook: steps before merge') },
  { name: 'DC8 an escalation approve does not clear the runbook', fx: { job: decidedLate(), decision: { decision: 'APPROVE' }, events: sentBack, runbookBeforeMerge: true }, want: { rule: 'DC8' } },
  { name: 'DC3 a budget acknowledgement does not clear a missing decision line', fx: { job: decidedLate(), events: budgetAck('APPROVE').slice(0, -1) }, want: { rule: 'DC3' } },
  { name: 'cleared gate: DC3 a human-cleared missing decision line goes on to DC9', fx: { job: decidedLate(), events: sentBack }, want: { rule: 'DC9' } },
  { name: 'DC10 an open PR in decide goes to pr', fx: { job: job({ stage: 'decide', round: 1, pr: OPEN_PR }) }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'DC10' } },
  { name: 'DC5 an eval job with a PR record still grades, never DC10', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' }, pr: OPEN_PR }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], evalTask: { rubric: null, reference: null } }, want: { rule: 'DC5' } },

  // ---- Integrate
  { name: 'IG1 integrates the base', fx: { job: atIntegrate(), events: [entered] }, want: run('integrate', 'j') },
  { name: 'IG1 without an entry transition anchors on the decision, ignoring an older integration', fx: { job: atIntegrate(), events: [ev('integrated', 5, { behind: 0 }), ev('decision', 22)] }, want: run('integrate', 'j') },
  { name: 'IG2 re-verifies new commits', fx: { job: atIntegrate(), events: [entered, ev('integrated', 31, { behind: 2, strategy: 'rebase' })] }, want: run('verify', 'j') },
  { name: 'IG2 a failing verify after integrating goes to build', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 32, false)] }), events: [entered, ev('integrated', 31, { behind: 2 })] }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
  { name: 'IG3 up to date after a decision: pr', fx: { job: atIntegrate(), events: [ev('decision', 22), entered, ev('integrated', 31, { behind: 0 })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  { name: 'IG3 up to date before a decision: decide', fx: { job: atIntegrate(), events: [reviewed, ev('integrated', 31, { behind: 0 })] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running'), rule: 'IG3' } },
  { name: 'IG3 verified after new commits before a decision: decide', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 32, true)] }), events: [reviewed, ev('integrated', 31, { behind: 2 })] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running'), rule: 'IG3' } },
  { name: 'IG2 new commits before a decision are verified first', fx: { job: atIntegrate(), events: [reviewed, ev('integrated', 31, { behind: 2 })] }, want: run('verify', 'j') },
  { name: 'IG1 a legacy job integrates after its decision', fx: { job: atIntegrate(), events: legacy }, want: run('integrate', 'j') },
  { name: 'IG3 a legacy job up to date goes to pr', fx: { job: atIntegrate(), events: [...legacy, ev('integrated', 31, { behind: 0 })] }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'IG3' } },
  { name: 'IG1 after a gate wait integrates again', fx: { job: atIntegrate(), events: reentered }, want: run('integrate', 'j') },
  { name: 'IG3 after a gate wait and behind 0: pr without verify', fx: { job: atIntegrate(), events: [...reentered, ev('integrated', 43, { behind: 0 })] }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'IG3' } },
  { name: 'IG2 after a gate wait and new commits: verify', fx: { job: atIntegrate(), events: [...reentered, ev('integrated', 43, { behind: 2 })] }, want: run('verify', 'j') },
  { name: 'IG3 after a gate wait, verified: pr', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 44, true)] }), events: [...reentered, ev('integrated', 43, { behind: 2 })] }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'IG3' } },
  {
    name: 'IG3 after a human ship approval: pr',
    fx: { job: atIntegrate(), events: [tr(25, { stage: 'review' }, { stage: 'build' }), tr(26, { stage: 'build' }, { stage: 'build', state: 'waiting', waitingOn: 'escalation' }), ev('human', 28, { action: 'approve' }), tr(30, { stage: 'build', state: 'waiting', waitingOn: 'escalation' }, { stage: 'integrate' }), ev('integrated', 31, { behind: 0 })] },
    want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'IG3' },
  },
  { name: 'IG3 a recorded ESCALATE alone is not an approval', fx: { job: atIntegrate(), events: [tr(15, { stage: 'review' }, { stage: 'decide' }), ev('decision', 22, { decision: 'ESCALATE' }), entered, ev('integrated', 31, { behind: 0 })] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running'), rule: 'IG3' } },
  { name: 'IG3 a budget approve before integrate is not a ship approval', fx: { job: atIntegrate(), events: [tr(25, { stage: 'review' }, { stage: 'build' }), tr(26, { stage: 'build' }, { stage: 'build', state: 'waiting', waitingOn: 'budget' }), ev('human', 28, { action: 'approve' }), tr(30, { stage: 'build', state: 'waiting', waitingOn: 'budget' }, { stage: 'integrate' }), ev('integrated', 31, { behind: 0 })] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running'), rule: 'IG3' } },
  { name: 'IG3 a human approve before the review does not count', fx: { job: atIntegrate(), events: [ev('human', 20, { action: 'approve' }), reviewed, ev('integrated', 31, { behind: 0 })] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running'), rule: 'IG3' } },
  { name: 'IG3 without an entry transition counts an integration after the round\'s first passing verify', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 32, true)] }), events: [ev('integrated', 5, { behind: 0 }), ev('integrated', 15, { behind: 2 })] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running'), rule: 'IG3' } },
  { name: 'IG3 verified after new commits: pr', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 32, true)] }), events: [ev('decision', 22), entered, ev('integrated', 31, { behind: 2 })] }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'IG3' } },
  { name: 'IG2 re-verifies a regenerated integration', fx: { job: atIntegrate(), events: [entered, ev('integrated', 31, { behind: 2, strategy: 'merge', regenerated: ['dist/out.txt'] })] }, want: run('verify', 'j') },
  { name: 'IG3 regenerated and verified: pr', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 32, true)] }), events: [ev('decision', 22), entered, ev('integrated', 31, { behind: 2, strategy: 'merge', regenerated: ['dist/out.txt'] })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  { name: 'IG4 conflicts under ask wait on a human', fx: { job: atIntegrate(), events: [entered, conflicts] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'conflicts', '--reason', 'conflicts with base: 2 files') },
  { name: 'G4 conflicts tell', fx: { job: atIntegrate({ state: 'waiting', waitingOn: 'conflicts' }) }, want: { action: 'wait', tell: 'j conflicts with main. /forge approve j to have the integrator fix them' } },
  { name: 'IG5 conflicts under defer after a decision go to pr', fx: { config: (c) => (c.pr.conflicts = 'defer'), job: atIntegrate(), events: [ev('decision', 22), entered, conflicts] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running', '--note', 'conflicts with base deferred') },
  { name: 'IG5 conflicts under defer before a decision go to decide', fx: { config: (c) => (c.pr.conflicts = 'defer'), job: atIntegrate(), events: [reviewed, conflicts] }, want: run('job', 'set', 'j', '--stage', 'decide', '--state', 'running', '--note', 'conflicts with base deferred') },
  {
    name: 'IG6 conflicts under fix spawn the integrator',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate(), events: [entered, conflicts] },
    want: { action: 'spawn', role: 'integrator', model: 'sonnet' },
    check: (a) => {
      assert.ok(a.brief.includes('Strategy: merge'));
      assert.ok(a.brief.includes('Conflicts: ["a.ts","`x`"]'));
      assert.ok(!a.brief.includes('Regenerated:'), 'no line without regenerated paths');
      assert.equal(a.output, undefined);
    },
  },
  {
    name: 'IG6 brief lists only real conflicts',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate(), events: [entered, ev('integrate-conflicts', 31, { strategy: 'merge', conflicts: ['README.md'], behind: 1, regenerated: ['dist/out.txt'] })] },
    want: { action: 'spawn', role: 'integrator' },
    check: (a) => {
      const lines = a.brief.split('\n');
      assert.ok(lines.includes('Conflicts: ["README.md"]'), a.brief);
      assert.ok(lines.some((l) => l.startsWith('Regenerated: ["dist/out.txt"]')), a.brief);
      assert.ok(!lines.find((l) => l.startsWith('Conflicts:')).includes('dist/out.txt'));
    },
  },
  { name: 'IG6 ask with a human approve spawns the integrator', fx: { job: atIntegrate(), events: [entered, conflicts, ev('human', 32, { action: 'approve' })] }, want: { action: 'spawn', role: 'integrator' } },
  { name: 'IG6 the integrator merges by default before a PR', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate(), events: [reviewed, conflicts] }, want: { action: 'spawn', role: 'integrator' }, check: (a) => assert.ok(a.brief.split('\n').includes('Strategy: merge'), a.brief) },
  { name: 'IG6 pr.updateStrategy: rebase reaches the integrator brief', fx: { config: (c) => ((c.pr.conflicts = 'fix'), (c.pr.updateStrategy = 'rebase')), job: atIntegrate(), events: [reviewed, conflicts] }, want: { action: 'spawn', role: 'integrator' }, check: (a) => assert.ok(a.brief.split('\n').includes('Strategy: rebase'), a.brief) },
  { name: 'IG6 an open PR integrates with pr.updateStrategy', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }), events: [entered, conflicts] }, want: { action: 'spawn', role: 'integrator' }, check: (a) => assert.ok(a.brief.includes('Strategy: merge')) },
  { name: 'IG7 verifies the resolution', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ agents: { integrator: ag(1, 33, 36) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })] }, want: run('verify', 'j') },
  { name: 'IG7 a failing verify after the resolution escalates', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, false)], agents: { integrator: ag(1, 33, 36) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'integration: verify failed after conflict resolution') },
  {
    name: 'IG8 spawns the integration reviewer',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 12, 13) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })] },
    want: { action: 'spawn', role: 'reviewer:code', output: path.join(JOB_DIR, 'review', 'integration', 'code.md') },
    check: (a) => {
      assert.equal(a.parallel, undefined);
      assert.ok(a.brief.includes('Integration review: conflicted files ["a.ts","`x`"]'));
      assert.ok(a.brief.includes("Diff: use the Before/Merge shas in build.md's ## Integration block, as in "));
    },
  },
  { name: 'IG9 records the integration review', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })], verdicts: { integration: verdicts({ code: 'PASS' }) } }, want: run('job', 'verdicts', 'j', '--round', 'integration', '--compact') },
  { name: 'RV5 a malformed integration review gets one retry', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })], verdicts: { integration: verdicts({ code: 'MALFORMED' }) } }, want: { action: 'spawn', role: 'reviewer:code', retry: true } },
  { name: 'IG10 a passing integration review after a decision goes to pr', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [ev('decision', 22), entered, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'PASS' })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  { name: 'IG10 a passing integration review before a decision goes to decide', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [reviewed, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'PASS' })] }, want: run('job', 'set', 'j', '--stage', 'decide', '--state', 'running') },
  { name: 'IG10 an ask approval inside the episode still goes to decide', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [reviewed, conflicts, ev('human', 32, { action: 'approve' }), ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'PASS' })] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running'), rule: 'IG10' } },
  { name: 'IG10 a passing integration review on an open PR goes to pr', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ pr: OPEN_PR, verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [...routed, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'PASS' })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  {
    name: 'IG10 CHANGES once: the integrator fixes it',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'CHANGES' })] },
    want: { action: 'spawn', role: 'integrator', resume: 'a33' },
    check: (a) => assert.ok(a.brief.includes(`Integration review: ${path.join(JOB_DIR, 'review', 'integration', 'code.md')}`)),
  },
  { name: 'IG11 docs and regenerated conflicts skip the review and go to pr', fx: resolvedIntegration([ev('decision', 22), entered, docsConflicts]), want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running', '--note', 'integration review skipped: only docs or generated files conflicted, 2 files'), rule: 'IG11' } },
  { name: 'IG11 skipped review before a decision goes to decide', fx: resolvedIntegration([reviewed, docsConflicts]), want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running', '--note', 'integration review skipped: only docs or generated files conflicted, 2 files'), rule: 'IG11' } },
  {
    name: 'IG11 generated paths matched by worktrees.generated count as generated',
    fx: resolvedIntegration([ev('decision', 22), entered, resolvedConflicts(['docs/guide.txt', 'dashboard/dist/x.js'])], (c) => (c.worktrees.generated = ['dashboard/dist/**'])),
    want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running', '--note', 'integration review skipped: only docs or generated files conflicted, 2 files'), rule: 'IG11' },
  },
  { name: 'IG8 generated paths without a matching worktrees.generated keep the review', fx: resolvedIntegration([entered, resolvedConflicts(['docs/guide.txt', 'dashboard/dist/x.js'])]), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG8 a code conflict keeps the integration review', fx: resolvedIntegration([entered, resolvedConflicts(['README.md', 'lib/cli.ts'])]), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG11 a regenerated path counts as generated whatever its extension', fx: resolvedIntegration([ev('decision', 22), entered, resolvedConflicts(['CHANGELOG.md'], { regenerated: ['lib/gen.ts'] })]), want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running', '--note', 'integration review skipped: only docs or generated files conflicted, 2 files'), rule: 'IG11' } },
  { name: 'IG8 pr.integrationReview always reviews docs-only conflicts', fx: resolvedIntegration([ev('decision', 22), entered, docsConflicts], (c) => (c.pr.integrationReview = 'always')), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG8 an invalid pr.integrationReview reviews', fx: resolvedIntegration([ev('decision', 22), entered, docsConflicts], (c) => ((c.pr as any).integrationReview = 'sometimes')), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG8 empty conflicts keep the review', fx: resolvedIntegration([entered, resolvedConflicts([])]), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  {
    name: 'IG8 malformed conflicts keep the review',
    fx: resolvedIntegration([entered, resolvedConflicts('README.md' as any)]),
    want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' },
    check: () => {
      for (const bad of [{ conflicts: ['README.md'], regenerated: 'dist/x' }, { conflicts: ['README.md', 3] }, { conflicts: ['README.md', ''] }, { conflicts: null }]) {
        const a: any = step(fixture(resolvedIntegration([entered, ev('integrate-conflicts', 31, { strategy: 'merge', behind: 1, head: HEAD_SHA, upstream: BASE_SHA, ...bad })], undefined, { files: ['README.md'] })));
        assert.equal(a.rule, 'IG8', JSON.stringify(bad));
      }
    },
  },
  {
    name: 'IG8 unsafe conflict names keep the review',
    fx: resolvedIntegration([entered, resolvedConflicts(['../x.md'])]),
    want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' },
    check: () => {
      for (const bad of ['/etc/x.md', 'docs/../lib/x.ts', 'a\nb.md', 'a\u0000.md', 'docs\\x.md']) {
        const a: any = step(fixture(resolvedIntegration([entered, resolvedConflicts([bad])])));
        assert.equal(a.rule, 'IG8', JSON.stringify(bad));
      }
    },
  },
  { name: 'IG8 a later rebase stop with code keeps the review', fx: resolvedIntegration([entered, resolvedConflicts(['README.md']), ev('integrate-conflicts', 34, { strategy: 'rebase', conflicts: ['lib/a.ts'], behind: 1 })]), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  {
    // Named IG8, not IG11 as in the spec: the row's prefix must be the rule that decides it.
    name: 'IG8 re-reviews: IG11 never skips once an integration review ran',
    // The first review asked for changes; the integrator fixed it (41–45) and verify passed at 46.
    fx: {
      job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true), vr(1, 46, true)], agents: { integrator: ag(1, 41, 45), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }),
      events: [entered, docsConflicts, ev('agent-start', 33, { role: 'integrator' }), ev('agent-start', 38, { role: 'reviewer:code' }), ev('integration-review', 40, { outcome: 'CHANGES' }), ev('agent-start', 41, { role: 'integrator' })],
      config: (c) => (c.pr.conflicts = 'fix'),
      integrationTouched: { head: HEAD_SHA, upstream: BASE_SHA, sha: 's', files: ['README.md', 'dashboard/dist/app.js'] },
    },
    want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' },
  },
  { name: 'IG8 a resolution that also changed code keeps the review', fx: resolvedIntegration([ev('decision', 22), entered, docsConflicts], undefined, { files: ['README.md', 'dashboard/dist/app.js', 'lib/x.ts'] }), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG8 an unknown resolution diff keeps the review', fx: resolvedIntegration([ev('decision', 22), entered, docsConflicts], undefined, { files: null }), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG8 a resolution diff of another sha keeps the review', fx: resolvedIntegration([ev('decision', 22), entered, docsConflicts], undefined, { sha: 't' }), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG8 a resolution diff of other sides keeps the review', fx: resolvedIntegration([ev('decision', 22), entered, docsConflicts], undefined, { upstream: 'c'.repeat(40) }), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG8 conflicts logged without their sides keep the review', fx: resolvedIntegration([ev('decision', 22), entered, resolvedConflicts(['README.md'], { head: undefined, upstream: undefined })]), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG8 an unsafe name in the resolution diff keeps the review', fx: resolvedIntegration([ev('decision', 22), entered, docsConflicts], undefined, { files: ['README.md', 'a\nb.md'] }), want: { action: 'spawn', role: 'reviewer:code', rule: 'IG8' } },
  { name: 'IG11 docs the resolution changed count in the note', fx: resolvedIntegration([ev('decision', 22), entered, docsConflicts], undefined, { files: ['README.md', 'dashboard/dist/app.js', 'docs/x.txt'] }), want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running', '--note', 'integration review skipped: only docs or generated files conflicted, 3 files'), rule: 'IG11' } },
  {
    name: 'IG11 hostile file names stay out of the note',
    fx: resolvedIntegration([ev('decision', 22), entered, resolvedConflicts(["a'$(x).md", 'b"`y`.MD'])]),
    want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running', '--note', 'integration review skipped: only docs or generated files conflicted, 2 files'), rule: 'IG11' },
    check: (a) => assert.doesNotThrow(() => shellLine(a.command)),
  },
  { name: 'IG10 CHANGES after two integrator runs escalates', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 46, true)], agents: { integrator: ag(1, 41, 45), 'reviewer:code': ag(1, 47, 48, { outputMissing: false }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'CHANGES' }), ev('agent-start', 41, { role: 'integrator' }), ev('integration-review', 49, { outcome: 'CHANGES' })] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'integration review: CHANGES') },

  // ---- PR
  { name: 'PR1 pr.enabled false finishes on the branch', fx: { config: (c) => (c.pr.enabled = false), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }) }, want: { ...run('job', 'set', 'j', '--stage', 'done', '--state', 'done'), tell: 'j finished on branch forge/j' } },
  { name: 'PR2 an unverified HEAD is verified first', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, false)] }) }, want: run('verify', 'j') },
  { name: 'PR3 opens the PR', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }) }, want: run('pr', 'open', 'j') },

  // ---- Protected paths (PP1, PP2)
  { name: 'PP1 decide with APPROVE and an unapproved flag parks on a human', fx: { job: atDecide({ protectedPaths: FLAG() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'protected paths: package-lock.json'), rule: 'PP1' } },
  { name: 'protected paths: PP1 an approve after at, at a protected park, gives DC9', fx: { job: atDecide({ protectedPaths: FLAG() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ...ppPark(23, 25)] }, want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'DC9' } },
  { name: 'PP1 an approve before at does not count', fx: { job: atDecide({ protectedPaths: FLAG(30) }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ...ppPark(23, 25)] }, want: { rule: 'PP1' } },
  { name: "PP1 the foreman's approve does not count", fx: { job: atDecide({ protectedPaths: FLAG() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ...ppPark(23, 25, { actor: 'foreman' })] }, want: { rule: 'PP1' } },
  { name: 'PP1 a v2 foreman actor does not count', fx: { job: atDecide({ protectedPaths: FLAG() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ...ppPark(23, 25, { actor: { login: null, source: 'foreman' } })] }, want: { rule: 'PP1' } },
  { name: "protected paths: PP1 a v2 person's approve gives DC9", fx: { job: atDecide({ protectedPaths: FLAG() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ...ppPark(23, 25, { actor: { login: 'alice', source: 'gh' } })] }, want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'DC9' } },
  {
    name: 'PP1 an approve at an escalation park does not count',
    fx: {
      job: atDecide({ protectedPaths: FLAG() }),
      decision: { decision: 'ESCALATE' },
      events: [ev('decision', 22, { decision: 'ESCALATE' }), tr(23, { stage: 'decide' }, { stage: 'decide', state: 'waiting', waitingOn: 'escalation' }), ev('human', 25, { action: 'approve' }), tr(26, { stage: 'decide', state: 'waiting', waitingOn: 'escalation' }, { stage: 'decide' })],
    },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'protected paths: package-lock.json'), rule: 'PP1' },
  },
  { name: 'protected paths: PP1 no flag gives DC9', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)] }, want: { rule: 'DC9' } },
  { name: 'protected paths: PP1 an eval job does not park', fx: { job: job({ kind: 'eval', stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG() }) }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  {
    name: 'PP1 a path outside the safe class is counted, never printed',
    fx: { job: atDecide({ protectedPaths: FLAG(15, ['package-lock.json', "x'$(touch y)/yarn.lock", '-rf/yarn.lock', 'a b/Cargo.lock'], 2) }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'protected paths: package-lock.json, +5 more'), rule: 'PP1' },
  },
  { name: 'PP1 a flag raised at the pr stage parks', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG(12, ['Dockerfile']) }), events: [ev('pr-opened', 11)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'protected paths: Dockerfile'), rule: 'PP1' } },
  { name: "PP1 a member repo's path is named in the reason", fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG(12, ['lib:.github/workflows/ci.yml']) }), events: [ev('pr-opened', 11)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'protected paths: lib:.github/workflows/ci.yml'), rule: 'PP1' } },
  { name: 'protected paths: PP1 an approved flag at the pr stage goes on', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG(5) }), events: [...ppPark(6, 7), ev('pr-opened', 11)] }, want: { rule: 'PR5' } },
  {
    name: 'G4 a protected park names the diff',
    fx: { job: job({ stage: 'decide', state: 'waiting', waitingOn: 'human', reason: 'protected paths: package-lock.json' }) },
    want: { action: 'wait', waitingOn: 'human', tell: `j changed protected paths (protected paths: package-lock.json). Diff: ${path.join(JOB_DIR, 'protected.diff')}. /forge approve j once a human has reviewed them, or /forge rework j <note>` },
  },
  { name: 'PP2 a verify that failed on protected paths goes back to build', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, false, 'protected')], agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'PP2' } },
  { name: 'protected paths: PP2 a builder that ran since hands back to PR2', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, false, 'protected')], agents: { builder: ag(1, 11, 12) } }) }, want: { ...run('verify', 'j'), rule: 'PR2' } },
  { name: 'PP2 a refusal at pr open newer than the last verify goes back to build', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('pr-opened', 9), ev('protected-path', 12, { gate: 'pr', action: 'refuse', blocked: true })] }, want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'PP2' } },
  { name: 'protected paths: PP2 a refusal older than the last verify does not count', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 14, true)] }), events: [ev('protected-path', 12, { gate: 'pr', action: 'refuse', blocked: true })] }, want: { rule: 'PR3' } },
  {
    name: 'protected paths: PR4 never auto-merges protected paths',
    fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG(5) }), decision: { decision: 'APPROVE', autoMerge: true }, events: [...ppPark(6, 7), ev('pr-opened', 11)] },
    want: { action: 'run', rule: 'PR5' },
  },

  // ---- Secret scan (SC1–SC3) and the human gate
  { name: 'SC1 parks a verify the secret scan blocked', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked verify round 1'), rule: 'SC1' } },
  { name: 'SC1 parks in integrate', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 40, false, 'secrets')] }), events: [entered, ev('integrated', 31, { behind: 2 })] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked verify round 1'), rule: 'SC1' } },
  { name: 'SC1 parks in pr', fx: { job: job({ stage: 'pr', round: 2, verifyRuns: [vr(2, 10, false, 'secrets')] }) }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked verify round 2'), rule: 'SC1' } },
  { name: 'SC1 fails an eval job instead', fx: { job: job({ kind: 'eval', stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('job', 'set', 'j', '--state', 'failed', '--reason', 'eval: secret scan blocked verify round 1'), rule: 'SC1' } },
  { name: 'SC1 holds after a rework note that is not an approve', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }), events: [ev('human', 12, { action: 'note' })] }, want: { rule: 'SC1' } },
  { name: 'V1 re-verifies when the builder ended after a secret block', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 4, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('verify', 'j'), rule: 'V1' } },
  { name: 'SC2 scans again after a newer approve', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }), events: [ev('human', 12, { action: 'approve' })] }, want: { ...run('verify', 'j'), rule: 'SC2' } },
  { name: 'SC1 an approve older than the failing run does not count', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }), events: [ev('human', 8, { action: 'approve' })] }, want: { rule: 'SC1' } },
  { name: 'SC3 parks after pr open was refused', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 12, { gate: 'pr', blocked: true, count: 1 })] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked pr open'), rule: 'SC3' } },
  { name: 'SC3 fails an eval job instead', fx: { job: job({ kind: 'eval', stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 12, { gate: 'pr', blocked: true })] }, want: { ...run('job', 'set', 'j', '--state', 'failed', '--reason', 'eval: secret scan blocked pr open'), rule: 'SC3' } },
  { name: 'PR3 opens again once a human approved the SC3 park', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 12, { gate: 'pr', blocked: true }), ev('human', 14, { action: 'approve' })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  { name: 'PR3 a refusal older than the last verify does not park', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 8, { gate: 'pr', blocked: true })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  { name: 'PR3 a commit-gate event is not a pr refusal', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 12, { gate: 'commit', blocked: true })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  {
    name: 'G4 human tells how to clear a secret scan',
    fx: { job: job({ stage: 'verify', state: 'waiting', waitingOn: 'human', reason: 'secret scan blocked verify round 1' }) },
    want: { action: 'wait', waitingOn: 'human', tell: 'j stopped on a possible secret (secret scan blocked verify round 1). Masked findings and fingerprints: forge secrets scan j. Remove the value (rewrite the branch if it was committed) or add its fingerprint to .forge/secrets-allow.txt in the main checkout, then /forge approve j to scan again, or /forge rework j <note>' },
  },
  { name: 'G4 human with another reason gets the generic tell', fx: { job: job({ stage: 'build', state: 'waiting', waitingOn: 'human', reason: 'protected path edited' }) }, want: { action: 'wait', waitingOn: 'human', tell: 'j needs a human: protected path edited. /forge approve j once it is resolved, or /forge rework j <note>' } },
  { name: 'PR4 merges an eligible PR', fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE', autoMerge: true }, events: [ev('pr-opened', 11)] }, want: run('pr', 'merge', 'j') },
  { name: 'PR5 ship propose never merges (PR4 holds off)', fx: { config: (c) => Object.assign(c.foreman, { enabled: true, ship: 'propose' }), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE', autoMerge: true }, events: [ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR4 ship merge needs approver eligibility: eligible merges', fx: { config: (c) => Object.assign(c.foreman, { enabled: true, ship: 'merge' }), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE', autoMerge: true }, events: [ev('pr-opened', 11)] }, want: { ...run('pr', 'merge', 'j'), rule: 'PR4' } },
  { name: 'PR5 ship merge needs approver eligibility: not eligible waits', fx: { config: (c) => Object.assign(c.foreman, { enabled: true, ship: 'merge' }), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE', autoMerge: false }, events: [ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR5 ship merge without the foreman on never merges', fx: { config: (c) => Object.assign(c.foreman, { enabled: false, ship: 'merge' }), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE', autoMerge: true }, events: [ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR5 once a merge was tried, the PR waits', fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE', autoMerge: true }, events: [ev('pr-opened', 11), ev('pr-merge-refused', 12)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR5 waits on PR review', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('pr-updated', 11)] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review') },

  // ---- A PR job forge sync moved to integrate: the earlier episode's integrated and pr-updated don't count
  { name: 'sync-routed: IG1 integrates despite an earlier episode', fx: { job: atIntegrate({ pr: OPEN_PR }), events: routed }, want: run('integrate', 'j') },
  { name: 'sync-routed: IG2 verifies the merged base', fx: { job: atIntegrate({ pr: OPEN_PR }), events: routedMerged }, want: run('verify', 'j') },
  { name: 'sync-routed: IG3 back to pr once verified', fx: { job: atIntegrate({ pr: OPEN_PR, verifyRuns: [vr(1, 10, true), vr(1, 32, true)] }), events: routedMerged }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  { name: 'sync-routed: PR3 pushes the update', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true), vr(1, 32, true)] }), events: routedMerged }, want: run('pr', 'open', 'j') },
  { name: 'sync-routed: PR5 waits on review again', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true), vr(1, 32, true)] }), events: [...routedMerged, ev('pr-updated', 33)] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review') },

  // ---- Fallback
  { name: 'X1 a state no rule covers is parked', fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped, verdicts: { round: verdicts({ code: 'PENDING', tests: 'PASS' }) } }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'step found no rule for stage review') },

  // ---- Hostile inputs (AC11)
  { name: 'hostile: a lens name with quotes never reaches a command', fx: { job: inReview({}, { reviewers: ["a';touch x;'", 'code'] }), events: scoped }, want: { action: 'spawn', role: 'reviewer:code' } },
  { name: 'hostile: a decision reason with $(id) stays out of commands', fx: { job: atDecide({ reason: 'ship it $(id)' }), decision: { decision: 'ESCALATE' }, events: [ev('decision', 22)] }, want: { action: 'run', rule: 'DC7' } },
  { name: 'hostile: a conflicted file name stays out of commands', fx: { job: atIntegrate(), events: [entered, ev('integrate-conflicts', 31, { conflicts: ['`x`', '$(rm -rf ~)', "'; id"], behind: 1 })] }, want: { action: 'run', rule: 'IG4' } },
  // Effort: the Agent tool's `effort`, resolved like the daemon's --effort; no rule of its own.
  { name: "spawn carries the job's effort", fx: { config: (c) => (c.runtime.effort = 'medium'), files: ['spec'], job: job({ stage: 'build', round: 1, effort: 'high', agents: { builder: ag(1, 5, 6, { status: 'lost' }) } }), events: [ev('round', 4)] }, want: { action: 'spawn', role: 'builder', effort: 'high' }, check: (a) => assert.ok(a.brief.split('\n').includes('Effort: high')) },
  { name: 'spawn inherits runtime.effort', fx: { config: (c) => (c.runtime.effort = 'medium'), job: atDecide({ agents: { approver: ag(1, 20, 21, { status: 'failed' }) } }) }, want: { action: 'spawn', role: 'approver', effort: 'medium' } },
  { name: 'spawn effort is null when nothing is set', fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: true, output: 'review/round-1/code.md' }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped }, want: { action: 'spawn', role: 'reviewer:code', effort: null }, check: (a) => assert.ok(a.brief.split('\n').includes('Effort: inherit')) },
  {
    name: 'RV4 reviewer spawn takes runtime.efforts.reviewer over runtime.effort',
    fx: { config: (c) => ((c.runtime.effort = 'high'), (c.runtime.efforts.reviewer = 'medium')), job: inReview(), events: scoped },
    want: { action: 'spawn', role: 'reviewer:code', effort: 'medium' },
    check: (a) => assert.ok(a.brief.split('\n').includes('Effort: medium')),
  },
  {
    name: 'job.effort overrides a per-role effort',
    fx: { config: (c) => ((c.runtime.effort = 'high'), (c.runtime.efforts.reviewer = 'medium')), job: inReview({}, { effort: 'xhigh' }), events: scoped },
    want: { action: 'spawn', role: 'reviewer:code', effort: 'xhigh' },
    check: (a) => assert.ok(a.brief.split('\n').includes('Effort: xhigh')),
  },
  {
    name: 'a panel effort reaches its lens brief',
    fx: { config: (c) => ((c.runtime.efforts.reviewer = 'low'), ((c.review.panel.find((p) => p.name === 'security') as any).effort = 'max')), job: inReview({}, { reviewers: ['security'] }), events: scoped },
    want: { action: 'spawn', role: 'reviewer:security', effort: 'max' },
    check: (a) => assert.ok(a.brief.split('\n').includes('Effort: max')),
  },
  {
    name: 'builder round 2 spawn is one level above round 1',
    fx: { config: (c) => (c.runtime.efforts.builder = 'high'), files: ['spec'], job: job({ stage: 'build', round: 2, verdicts: { 1: { code: 'CHANGES' } }, agents: { builder: ag(1, 5, 6) } }), events: [ev('round', 7)] },
    want: { action: 'spawn', role: 'builder', effort: 'xhigh' },
    check: (a) => {
      assert.ok(a.brief.split('\n').includes('Effort: xhigh'));
      const r1 = step(fixture({ config: (c) => (c.runtime.efforts.builder = 'high'), files: ['spec', 'tasks'], job: job({ stage: 'build', round: 1 }), events: [ev('round', 4)] })) as any;
      assert.equal(r1.effort, 'high', 'round 1');
      // A verify-fail retry inside round 1 is not a rework round.
      const retry = step(fixture({ config: (c) => (c.runtime.efforts.builder = 'high'), present: [path.join(JOB_DIR, 'verify', 'round-1.md')], job: job({ stage: 'build', round: 1, verifyRuns: [vr(1, 10, false)], agents: { builder: ag(1, 5, 6) } }), events: [ev('round', 4)] })) as any;
      assert.equal(retry.effort, 'high', 'verify retry in round 1');
    },
  },
  {
    name: 'hostile: an agent id is not passed as resume',
    fx: { files: ['questions'], job: job({ stage: 'build', round: 2, agents: { builder: ag(2, 8, 9, { summary: 'NEEDS-INPUT', agentId: 'x; rm -rf' }) } }), events: [ev('round', 7), ev('human', 10, { action: 'answer', note: 'x' })] },
    want: { action: 'spawn', rule: 'N2', role: 'builder' },
    check: (a) => assert.equal(a.resume, undefined),
  },
];

const SAFE = /^[A-Za-z0-9 ._:/@=,+\-[\]"]*$/;

function assertSafe(a: StepAction, name: string) {
  const argv = a.action === 'run' ? a.command : a.action === 'spawn' ? a.start : [];
  for (const el of argv) {
    assert.match(el, SAFE, `${name}: ${el}`);
    assert.ok(!el.includes("'"), `${name}: ${el}`);
    for (const bad of ["a';touch x;'", '$(id)', '`x`', '$(rm', 'x; rm']) assert.ok(!el.includes(bad), `${name}: ${el} contains ${bad}`);
  }
  if (a.action === 'run') assert.equal(a.shell, shellLine(a.command));
  if (a.action === 'spawn') assert.equal(a.startShell, shellLine(a.start));
  if (a.action === 'spawn') for (const s of a.spawns ?? []) assertSafe(s, `${name} › ${s.role}`);
}

for (const row of rows) {
  test(row.name, () => {
    const a = step(fixture(row.fx)) as any;
    const prefix = row.name.split(' ')[0];
    if ((RULES as readonly string[]).includes(prefix)) assert.equal(a.rule, prefix, `${row.name}: decided by ${a.rule}`);
    for (const [k, v] of Object.entries(row.want)) assert.deepEqual(a[k], v, `${row.name}: ${k}`);
    row.check?.(a);
    assertSafe(a, row.name);
  });
}

// RV9's negative cases: another rule decides, so they can't be `rows` (whose name prefix is the deciding rule).
const rv9Skips: Row[] = [
  { name: 'RV9 a current panel moves on to RV2', fx: { job: inReview(), events: [panelled] }, want: { ...run('job', 'scope', 'j'), rule: 'RV2' } },
  { name: 'RV9 skipped once a reviewer of this round has started', fx: { job: inReview({ 'reviewer:code': ag(1, 12) }), events: [ev('scope', 11, { round: 1 })] }, want: { action: 'spawn', rule: 'RV4', role: 'reviewer:tests' } },
  { name: 'RV9 skipped once the verdicts are recorded', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: [ev('scope', 11, { round: 1 })] }, want: { rule: 'RV8' } },
  { name: 'RV9 skipped on a PR rework under changed', fx: { job: inReview({}, { pr: OPEN_PR }), events: [ev('scope', 11, { round: 1 })] }, want: { action: 'spawn', rule: 'RV4', role: 'reviewer:code' } },
  { name: 'RV9 skipped on a PR rework under none', fx: { config: (c) => (c.review.onPrFeedback = 'none'), job: inReview({}, { pr: OPEN_PR }) }, want: { rule: 'RV1' } },
];

for (const row of rv9Skips) {
  test(row.name, () => {
    const a = step(fixture(row.fx)) as any;
    assert.notEqual(a.rule, 'RV9', row.name);
    for (const [k, v] of Object.entries(row.want)) assert.deepEqual(a[k], v, `${row.name}: ${k}`);
    assertSafe(a, row.name);
  });
}

test('every spawn carries an effort key', () => {
  const spawns = rows.map((row) => step(fixture(row.fx))).filter((a) => a.action === 'spawn');
  assert.ok(spawns.length > 20);
  for (const a of spawns) assert.ok(Object.hasOwn(a, 'effort'), `${a.rule} ${(a as any).role}`);
});

test('spec-writer template declares Complexity', () => {
  const text = readFileSync(path.join(import.meta.dirname, '..', 'agents', 'spec-writer.md'), 'utf8');
  const fenced = /```\n(# <title>[\s\S]*?)\n```/.exec(text);
  assert.ok(fenced, 'the template is fenced');
  const header = parseSpecHeader(fenced[1]);
  assert.ok(Object.hasOwn(header, 'complexity'));
  assert.equal(header.complexity, 'low | medium | high');
  assert.match(fenced[1], /^Size: .*\nComplexity: low \| medium \| high$/m, 'under Size:');
  const after = text.slice(fenced.index + fenced[0].length).split('\n');
  const rubric = after.findIndex((l) => /^Complexity is difficulty/.test(l));
  assert.ok(rubric >= 0, 'a rubric follows the template');
  const lines = after.slice(rubric).findIndex((l) => !l.trim());
  assert.ok(lines > 0 && lines <= 4, `rubric is at most 4 lines (${lines})`);
});

test('retry and integration spawns never batch', () => {
  let checked = 0;
  for (const row of rows) {
    const a = step(fixture(row.fx));
    if (a.action !== 'spawn') continue;
    const integration = row.fx.job?.stage === 'integrate' && a.role.startsWith('reviewer:');
    if (a.rule !== 'M1' && a.rule !== 'RV5' && !integration) continue;
    assert.ok(!Object.hasOwn(a, 'spawns'), `${row.name}: ${a.rule} ${a.role} carries spawns`);
    checked++;
  }
  assert.ok(checked >= 5, `only ${checked} retry or integration spawns checked`);
});

test('every rule has a row', () => {
  const missing = RULES.filter((r) => !rows.some((row) => row.name.startsWith(`${r} `)));
  assert.deepEqual(missing, []);
});

test('emitted commands are shell-safe', () => {
  for (const row of rows) assertSafe(step(fixture(row.fx)), row.name);
  assert.equal(shellLine(['job', 'set', 'j', '--reason', 'spec ready', '--field', 'reviewers=["code"]']), `forge job set j --reason 'spec ready' --field 'reviewers=["code"]'`);
  assert.equal(shellLine(['verify', 'j']), 'forge verify j');
  for (const bad of ["it's", 'a;b', '$(id)', '`x`', 'a\nb', 'a|b', 'a&b', '~/x', 'a>b']) assert.throws(() => shellLine(['job', 'note', bad]), /unsafe argument/, bad);
});

test('a UI review starts the dev server once and stops it once', () => {
  // Plays runtime.json and the recorded verdicts through each action until step leaves the stage:
  // RV3 and RV7 must not alternate once the verdicts are in.
  const runtime: string[] = [];
  const reviewers = { 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:ui': ag(1, 12, 13, { outputMissing: false }) };
  const seen: string[] = [];
  let recorded = false;
  for (let i = 0; i < 10; i++) {
    const a = step(
      fixture({
        config: (c) => (c.commands.dev = 'npm run dev'),
        job: inReview(reviewers, { reviewers: ['code', 'ui'], ...(recorded ? { verdicts: { 1: { code: 'PASS', ui: 'PASS' } } } : {}) }),
        events: scoped,
        runtime: [...runtime],
        verdicts: { round: verdicts({ code: 'PASS', ui: 'PASS' }) },
      }),
    );
    seen.push(a.rule);
    if (a.rule === 'RV3') runtime.push('dev');
    else if (a.rule === 'RV6') recorded = true;
    else if (a.rule === 'RV7') runtime.length = 0;
    else break;
  }
  assert.deepEqual(seen, ['RV3', 'RV6', 'RV7', 'RV8']);
});

test('three lost reviewers are retried back to back, then one wait', () => {
  // Plays each M1 through as its `agent start --retry`: the record becomes running and retried.
  const roles = ['reviewer:code', 'reviewer:tests', 'reviewer:security'];
  const agents: Job['agents'] = Object.fromEntries(roles.map((r) => [r, ag(1, 12, 13, { status: 'lost', outputMissing: true })]));
  const spawned: string[] = [];
  let last: any;
  for (let i = 0; i < 10; i++) {
    last = step(fixture({ job: inReview({ ...agents }, { reviewers: ['code', 'tests', 'security'] }), events: scoped }));
    if (last.rule !== 'M1') break;
    assert.equal(last.parallel, true);
    assert.equal(last.retry, true);
    spawned.push(last.role);
    agents[last.role] = ag(1, 14, undefined, { retry: true });
  }
  assert.deepEqual(spawned, roles);
  assert.equal(last.rule, 'G5');
  assert.equal(last.action, 'wait');
  assert.equal(last.waitingOn, 'agents');
  assert.deepEqual(last.running, [...roles].sort());

  // Every retry ends; code again wrote nothing: escalate, no fourth M1.
  agents['reviewer:code'] = ag(1, 14, 15, { retry: true, outputMissing: true });
  agents['reviewer:tests'] = ag(1, 14, 15, { retry: true, outputMissing: false });
  agents['reviewer:security'] = ag(1, 14, 15, { retry: true, outputMissing: false });
  const a = step(fixture({ job: inReview(agents, { reviewers: ['code', 'tests', 'security'] }), events: scoped, verdicts: { round: verdicts({ code: 'MISSING', tests: 'PASS', security: 'PASS' }) } })) as any;
  assert.equal(a.rule, 'M2');
  assert.deepEqual(a.command, ['job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'reviewer code wrote no review', '--note', 'reviewer:code ended twice without writing code.md']);
});

test('loadStepInput parsers read plan, spec header and design deltas', () => {
  assert.deepEqual(parsePlan('PLAN: SPLIT\nSize: L\n\n## Jobs            (only for SPLIT)\n1. A — x. Depends on: -\n2. B — y. Depends on: #1\n\n## External\n- None\n'), { verdict: 'SPLIT', jobs: 2, recommendSplit: false });
  assert.deepEqual(parsePlan('PLAN: SINGLE\n## External\n- Recommend splitting: (a) x (b) y\n'), { verdict: 'SINGLE', jobs: 0, recommendSplit: true });
  assert.deepEqual(parsePlan('# no plan line\n'), { verdict: null, jobs: 0, recommendSplit: false });
  const header = parseSpecHeader('# T\n\nSize: L\nServices: -\nNeeds design: yes\nSuggested reviewers: code, tests, UI , evil;rm\n\n## Goal\nSize: S\n');
  assert.deepEqual(header, { size: 'L', complexity: null, needsDesign: true, services: [], suggested: ['code', 'tests', 'UI', 'evil;rm'] });
  assert.equal(parseSpecHeader('Size: M\nComplexity: High\n').complexity, 'high', 'stored lowercase');
  assert.equal(parseSpecHeader('Size: M\nComplexity: extreme\n').complexity, 'extreme', 'SP3 decides validity');
  assert.deepEqual(parseSpecHeader('Services: api, web\n').services, ['api', 'web']);
  assert.equal(hasSpecDeltas('## Spec deltas\n"None"\n## Open questions\nx\n'), false);
  assert.equal(hasSpecDeltas('## Spec deltas\n- None.\n'), false);
  assert.equal(hasSpecDeltas('## Spec deltas\n- AC3 needs an empty state\n'), true);
  assert.equal(hasSpecDeltas('# Design\n'), false);
});

test('roundLenses and selectPanel are pure helpers', () => {
  const f = fixture({ job: { reviewers: ['code', 'tests', 'security'] } });
  assert.deepEqual(roundLenses(f.job, f.config), ['code', 'tests', 'security']);
  assert.deepEqual(roundLenses({ reviewers: [], pr: null }, f.config), ['code', 'tests']);
  assert.deepEqual(selectPanel({ ...f, spec: { ...f.spec, suggested: ['security'] } }), ['code', 'tests', 'security']);
});

test('listLineCount counts list and heading lines inside blockquotes', () => {
  assert.equal(listLineCount('> - a\n> - b\n> ## c\nplain'), 3);
  assert.equal(listLineCount('- a\n1. b\n# c'), 3);
  assert.equal(listLineCount('>\n> plain\n>-not a list'), 0);
  const t0 = performance.now();
  assert.equal(listLineCount(`${' >'.repeat(5_000)}x`), 0);
  assert.ok(performance.now() - t0 < 1000, 'stays linear on a 10k-character hostile line');
});
