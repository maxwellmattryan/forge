// The rows of test/step.test.ts: fixture state → the action `step` must return. Kept apart so
// test/step-purity.test.ts runs the same fixtures without registering step.test.ts's tests.
import assert from 'node:assert/strict';
import path from 'node:path';
import { shellLine, step } from '#engine/pipeline/step.ts';
import type { Config, GateReason, Job, JobAgent, VerifyRun } from '#core/types.ts';
import type { StepInput } from '#engine/pipeline/types.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { acCoverage } from '#engine/pipeline/acs.ts';
import { REVIEWED_HEAD_NOTE } from '#engine/pipeline/step/facts.ts';
import { JOB_DIR, RECALL_HASH, ROOT, WT, ag, ev, fixture, t, verdicts } from './step-fixture.ts';
import type { FixtureOpts } from './step-fixture.ts';

export interface Row {
  name: string;
  fx: FixtureOpts;
  want: Record<string, unknown>;
  check?: (a: any) => void;
}

/**
 * A `run` row: the subcommand and job, then only the flags that decide it. Checked with argvMatch,
 * so a flag a row leaves out (or a new one) never breaks it.
 */
const run = (...command: string[]) => ({ action: 'run', command });

/** An argv as its leading positionals and its `--flag [value]` pairs; a flag followed by another flag (or nothing) has no value. */
function argvParts(argv: readonly string[]): { positional: string[]; flags: [string, string | null][] } {
  const first = argv.findIndex((el) => el.startsWith('--'));
  const positional = first < 0 ? [...argv] : argv.slice(0, first);
  const flags: [string, string | null][] = [];
  for (let i = positional.length; i < argv.length; i++) {
    const value = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
    flags.push([argv[i], value]);
    if (value !== null) i++;
  }
  return { positional, flags };
}

/**
 * The step-row matcher: `actual` has exactly `want`'s positionals (subcommand, job, …) and every
 * `--flag [value]` pair `want` names, in any order and alongside any others. A repeated flag
 * must appear as often as `want` repeats it.
 */
export function argvMatch(actual: unknown, want: readonly string[], message: string): void {
  const show = `${message}\n  actual: ${JSON.stringify(actual)}\n  wanted: ${JSON.stringify(want)}`;
  assert.ok(Array.isArray(actual), show);
  const a = argvParts(actual as string[]);
  const w = argvParts(want);
  assert.deepEqual(a.positional, w.positional, `${show}\n  (positionals differ)`);
  const left = [...a.flags];
  for (const [flag, value] of w.flags) {
    const i = left.findIndex(([f, v]) => f === flag && v === value);
    assert.ok(i >= 0, `${show}\n  (no ${value === null ? flag : `${flag} ${JSON.stringify(value)}`})`);
    left.splice(i, 1);
  }
}

/** A row's `want` against step's action: argv keys through argvMatch, every other key deepEqual. */
export function assertWant(a: Record<string, unknown>, want: Record<string, unknown>, name: string): void {
  for (const [k, v] of Object.entries(want)) {
    if ((k === 'command' || k === 'start') && Array.isArray(v)) argvMatch(a[k], v as string[], `${name}: ${k}`);
    else assert.deepEqual(a[k], v, `${name}: ${k}`);
  }
}
const vr = (round: number, at: number, ok: boolean, failure: string | null = ok ? null : 'test'): VerifyRun => ({ round, attempt: 1, sha: 's', ok, at: t(at), file: `verify/round-${round}.md`, failure });
const job = (j: Partial<Job>): Partial<Job> => ({ state: 'running', ...j });
/** The actor a foreman decision (and forge sync's CI rework) records. */
const FOREMAN = { login: null, source: 'foreman' };
// A root app that depends on member lib, lib's interim strategy from config (default local).
const twoRepoConfig = (c: any, interim?: string) => {
  c.repos = [{ name: 'lib', remote: '/x/lib.git', defaultBranch: 'main', ...(interim ? { release: { interim } } : {}) }];
  c.components = [
    { name: 'app', path: '.', kind: 'app', dependsOn: [{ component: 'lib', type: 'build' }] },
    { name: 'lib', repo: 'lib', path: '.', kind: 'library' },
  ];
};
const libRepo = (state: 'OPEN' | 'MERGED' | null): Job['repos'] => [
  { repo: null, worktree: WT, branch: 'forge/j', base: 'main', pr: null, verifyOnly: false, interim: null },
  { repo: 'lib', worktree: null, branch: 'forge/j', base: 'main', pr: state ? { number: 7, url: null, state, isDraft: false, lastSyncedAt: t(9) } : null, verifyOnly: false, interim: null },
];
// twoRepoConfig with the edge joined by a cargo link: a recorded release makes it bump-due.
const linkedConfig = (c: any, interim: string) => {
  twoRepoConfig(c, interim);
  c.components[0].dependsOn[0].link = { ecosystem: 'cargo', name: 'engine-core' };
};
const REL = (at: number, version = '1.2.0') => ev('interim-released', at, { repo: 'lib', version });
const atPr = (verifyRuns: VerifyRun[], extra: Partial<Job> = {}) => job({ stage: 'pr', round: 1, verifyRuns, repos: libRepo('MERGED'), pr: OPEN_PR, ...extra });
const SEQ = { repo: null, why: 'sequential', waitingOn: ['lib'] };
const CANARY = { repo: null, why: 'canary', waitingOn: ['lib'], name: '@acme/lib', version: '1.4.0-canary.0123456789ab' };
// Downstream verification: root `core`, members app-a and app-b each consuming it through a cmake link.
const dsConfig = (c: any) => {
  c.repos = ['app-a', 'app-b'].map((name) => ({ name, remote: `/x/${name}.git`, defaultBranch: 'main' }));
  c.components = [
    { name: 'core', path: '.', kind: 'library' },
    ...['a', 'b'].map((x) => ({ name: x, repo: `app-${x}`, path: '.', kind: 'app', commands: { test: 't' }, dependsOn: [{ component: 'core', type: 'build', link: { ecosystem: 'cmake', name: 'core' } }] })),
  ];
};
const DS_RUN = { ...run('job', 'repo', 'downstream', 'j'), rule: 'DS1' };
const DS_CHECKED = (n: number, added: string[], skipped: string[] = []) => ev('downstream-checked', n, { added, skipped: skipped.map((repo) => ({ repo, reason: 'x' })) });
const DS_MEMBER = (repo: string) => ({ repo, worktree: `/${repo}.worktrees/j`, branch: null, base: 'main', pr: null, verifyOnly: true, interim: null });
const DS_ADDED = (n: number, repo: string) => ev('job-repo-added', n, { repo, verifyOnly: true, downstream: true });
const DS_VERIFY: Partial<Job> = { stage: 'verify', round: 1, agents: { builder: ag(1, 5, 6) } };
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
/** An agent proposed member repo lib at minute n. */
const PROPOSED = (n: number) => ev('repo-proposed', n, { repo: 'lib', reason: 'core API' });
/** The job's repos once lib was added: the root mirror, then lib. */
const WITH_LIB = [{ repo: null }, { repo: 'lib', worktree: '/lib.worktrees/j', branch: 'forge/j', base: 'main', pr: null, verifyOnly: false }] as Job['repos'];
/** Two single-repo components, one with paths and notes, and the brief line they make. */
const BRIEFED_COMPONENTS: Config['components'] = [
  { name: 'cli', path: '.', kind: 'library', paths: ['lib/cli/**', 'bin/**'], notes: 'the forge command' },
  { name: 'dashboard', path: 'dashboard', kind: 'app' },
];
const BRIEFED_LINE =
  'Components (JSON): [{"name":"cli","repo":null,"kind":"library","path":".","paths":["lib/cli/**","bin/**"],"notes":"the forge command"},{"name":"dashboard","repo":null,"kind":"app","path":"dashboard","paths":null,"notes":null}]';

/** A per-role project.instructions map, with both files in the main checkout (AC5 of #433; #388). */
const ROLE_INSTRUCTIONS: Pick<FixtureOpts, 'config' | 'present'> = {
  config: (c) => (c.project.instructions = { default: ['AGENTS.md'], 'spec-writer': ['AGENTS.md', 'docs/DEVELOPING.md'], approver: [] }),
  present: [path.join(ROOT, 'AGENTS.md'), path.join(ROOT, 'docs', 'DEVELOPING.md')],
};
/** The brief's `Job paths (JSON)` instructions, and whether it has the Instructions: line. */
const briefInstructions = (brief: string): { files: unknown; line: boolean } => {
  const lines = brief.split('\n');
  const json = lines.find((l) => l.startsWith('Job paths (JSON): '))!.slice('Job paths (JSON): '.length);
  return { files: JSON.parse(json).instructions, line: lines.some((l) => l.startsWith('Instructions: ')) };
};

/** A job in review, round 1: builder done, verify passed, panel and scope written. */
const inReview = (agents: Job['agents'] = {}, more: Partial<Job> = {}): Partial<Job> =>
  job({ stage: 'review', round: 1, reviewers: ['code', 'tests'], verifyRuns: [vr(1, 10, true)], agents: { builder: ag(1, 5, 9), ...agents }, ...more });
const panelled = ev('panel', 11, { round: 1 });
const scoped = [ev('round', 4, { round: 1 }), panelled, ev('scope', 11, { round: 1 })];
/** Round 2 after round 1 asked for changes from docs; the round-2 panel event (minute 31) carries `rerun`. */
const R2_LENSES = ['code', 'security', 'docs'];
const inRework = (agents: Job['agents'] = {}, more: Partial<Job> = {}): Partial<Job> =>
  job({ stage: 'review', round: 2, reviewers: R2_LENSES, verifyRuns: [vr(1, 10, true), vr(2, 30, true)], verdicts: { 1: { code: 'PASS', security: 'PASS', docs: 'CHANGES' } }, agents: { builder: ag(2, 25, 29), ...agents }, ...more });
const reworkScoped = (rerun: unknown, at = 31) => [ev('round', 20, { round: 2 }), ev('panel', at, { round: 2, lenses: R2_LENSES, rerun }), ev('scope', 31, { round: 2 })];
const withDocsLens = (c: Config) => c.review.panel.push({ name: 'docs', paths: ['docs/**'] });
/** Role-run session ids: uuids, as a runner-started session's are. */
const BUILDER_SID = '0b0b0b0b-0000-4000-8000-000000000001';
const CODE_SID = '0c0c0c0c-0000-4000-8000-000000000002';
const CODE2_SID = '0c0c0c0c-0000-4000-8000-000000000003';
const DOCS_SID = '0d0d0d0d-0000-4000-8000-000000000004';
const SEC_SID = '05050505-0000-4000-8000-000000000005';
/** loadStepInput's lastSessions entry for a session with a transcript and a known context. */
const resumable = (session: string, context: number | null = 50_000, transcript = true) => ({ session, transcript, context });
/** The round-1 builder's start, then round 2. */
const BUILDER_EVENTS = [ev('agent-start', 5, { role: 'builder', model: 'opus' }), ev('round', 7)];
/** Round 2 after a review that asked for changes: the round-1 builder was a role run that left a resumable session. */
const resumableBuilder = (agent: Partial<JobAgent> = {}, more: Partial<FixtureOpts> = {}): FixtureOpts => ({
  files: ['spec', 'tasks', 'build'],
  present: [path.join(JOB_DIR, 'review', 'round-1', 'code.md')],
  job: job({ stage: 'build', round: 2, verdicts: { 1: { code: 'CHANGES', tests: 'PASS' } }, agents: { builder: ag(1, 5, 6, { agentId: BUILDER_SID, ...agent }) } }),
  events: BUILDER_EVENTS,
  lastSessions: { builder: resumable(BUILDER_SID) },
  ...more,
});
/** AC5: each reason a rework builder does not resume, in reworkResume's order, and the fixture that gives it. */
const RESUME_SKIP_ROWS: [string, FixtureOpts][] = [
  ['off', resumableBuilder({}, { config: (c) => (c.pipeline.resumeRework = false) })],
  ['last run failed', resumableBuilder({ status: 'failed' })],
  ['no session', resumableBuilder({ agentId: 'b1' }, { lastSessions: { builder: resumable('b1') } })],
  ['no session (no runner sidecar names it)', resumableBuilder({}, { lastSessions: {} })],
  ['no session (the sidecar names another session)', resumableBuilder({}, { lastSessions: { builder: resumable(CODE_SID) } })],
  ['model changed', resumableBuilder({}, { config: (c) => (c.runtime.reworkModel = 'haiku') })],
  ['spec changed', resumableBuilder({}, { events: [BUILDER_EVENTS[0], ev('human', 6, { action: 'revise-spec' }), BUILDER_EVENTS[1]] })],
  ['spec changed (a spec-writer ended after the run started)', resumableBuilder({}, { job: { ...resumableBuilder().job, agents: { builder: ag(1, 5, 6, { agentId: BUILDER_SID }), 'spec-writer': ag(1, 6, 6) } } })],
  ['no transcript', resumableBuilder({}, { lastSessions: { builder: resumable(BUILDER_SID, 50_000, false) } })],
  ['context unknown', resumableBuilder({}, { lastSessions: { builder: resumable(BUILDER_SID, null) } })],
  ['context over ceiling', resumableBuilder({}, { lastSessions: { builder: resumable(BUILDER_SID, 120_001) } })],
];
/** n verifier questions, named v00, v01, … in loadVerifiers' order. */
const QUESTIONS = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `v${String(i).padStart(2, '0')}`, question: `Does change ${i} hold?` }));
/** The panel's checklists: code from the plugin, docs from the repo, tests without one. */
const STANDARDS: Pick<FixtureOpts, 'checklists'> = { checklists: { code: path.join(PLUGIN_ROOT, 'reviewers', 'code.md'), tests: null, docs: path.join(ROOT, '.forge', 'reviewers', 'docs.md') } };
const CHECKLISTS_LINE = `Review checklists (JSON): ${JSON.stringify({ code: path.join(PLUGIN_ROOT, 'reviewers', 'code.md'), docs: path.join(ROOT, '.forge', 'reviewers', 'docs.md') })} · the panel reviews against these: read each before you write code`;
const QUESTIONS_SUFFIX = ' · yes/no checks the main checkout runs on files your file map names: read them before you write code';
/** The round-1 builder's brief with n matching verifiers: both standards lines directly after File map:, checklists first. */
const standardsCheck = (n: number) => (a: any) => {
  const lines: string[] = a.brief.split('\n');
  const i = lines.findIndex((l) => l.startsWith('File map: '));
  assert.ok(i >= 0, a.brief);
  assert.equal(lines[i + 1], CHECKLISTS_LINE);
  const shown = QUESTIONS(n).slice(0, 20).map((v) => `${v.name} · ${v.question}`);
  assert.equal(lines[i + 2], `Verifier questions (JSON): ${JSON.stringify(shown)}${n > 20 ? ` (+${n - 20} more)` : ''}${QUESTIONS_SUFFIX}`);
  assert.equal(lines.filter((l) => l.startsWith('Review checklists (JSON): ')).length, 1);
  assert.equal(lines.filter((l) => l.startsWith('Verifier questions (JSON): ')).length, 1);
  assert.equal(lines.length, 16);
};

/** approval-notes.md, present, and a person's actor for the notes in it. */
const NOTES_MD = path.join(JOB_DIR, 'approval-notes.md');
const PERSON = { login: 'al', source: 'gh' };
/** A review rework of round 1 (its builder started at minute 5) with approval-notes.md present and `events`. */
const noteRework = (events: FixtureOpts['events']): FixtureOpts => ({
  files: ['spec', 'tasks', 'build'],
  present: [path.join(JOB_DIR, 'review', 'round-1', 'code.md'), NOTES_MD],
  job: job({ stage: 'build', round: 2, verdicts: { 1: { code: 'CHANGES', tests: 'PASS' } }, agents: { builder: ag(1, 5, 6) } }),
  events,
});

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
/** `forge job decision` recorded an auto-merge eligible APPROVE bound to HEAD_SHA at minute 9 (PR4 reads only this). */
const decided = (decision: string, autoMerge: boolean, n = 9) => ev('decision', n, { decision, reason: null, autoMerge, head: HEAD_SHA });
const APPROVED = decided('APPROVE', true);
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
/** A post-merge score run forge sync queued at minute 20. */
const QUEUED_SCORE: NonNullable<Job['score']> = { status: 'queued', queuedAt: t(20), value: null, outOf: 5, recordedAt: null, judgeModel: null, builderModel: null };
const OPEN_PR: Job['pr'] = { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) };
type Side = { stage: string; state?: string; waitingOn?: string | null };
/** A transition event at minute n; a side's state defaults to running. */
const tr = (n: number, from: Side, to: Side) => ev('transition', n, { from: { state: 'running', waitingOn: null, ...from }, to: { state: 'running', waitingOn: null, ...to } });
/** The new order: every lens passed and RV8 sent the job straight to integrate at minute 25. */
const reviewed = tr(25, { stage: 'review' }, { stage: 'integrate' });
/** DC11 or PR12's `job set`: back to review with the reviewed-head note. */
const BACK_TO_REVIEW = run('job', 'set', 'j', '--stage', 'review', '--state', 'running', '--note', REVIEWED_HEAD_NOTE);
/** A round-2 build that RV11 opened: round 1 at 4, review → build at 30, round 2 at 32 (a `between` event goes at 31). */
const reReview = (between: ReturnType<typeof ev>[] = []) => [ev('round', 4, { round: 1 }), tr(30, { stage: 'review' }, { stage: 'build' }), ...between, ev('round', 32, { round: 2 })];
const atReReview = (more: Partial<Job> = {}): Partial<Job> => job({ stage: 'build', round: 2, reviewers: ['code'], verdicts: { 1: { code: 'PASS' } }, verifyRuns: [vr(1, 10, true)], agents: { builder: ag(1, 5, 6) }, ...more });
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

/** Decide before the approver has run. */
const freshDecide = (more: Partial<Job> = {}): Partial<Job> => job({ stage: 'decide', round: 1, reviewers: ['code'], verdicts: { 1: { code: 'PASS' } }, ...more });
const RECALL_MD = path.join(PLUGIN_ROOT, 'skills', 'forge', 'reference', 'recall.md');
const RECALL_REASON = `recall eval: no recorded run for prompts ${RECALL_HASH}`;
const recallStart = (n: number, hash = RECALL_HASH) => ev('recall', n, { phase: 'start', run: '20261020-101010-j', pluginHash: hash, head: 'a'.repeat(40) });
const recallRecord = (n: number, hash = RECALL_HASH) =>
  ev('recall', n, {
    phase: 'record',
    run: '20261020-101010-j',
    pluginHash: hash,
    head: 'a'.repeat(40),
    summary: { byLens: { code: { planted: 2, caught: 1, recall: 0.5, precision: 1 } }, total: {} },
    base: { run: '20261019-000000', head: 'b'.repeat(40), summary: { byLens: { code: { recall: 1, precision: 1 } } } },
  });
/** Two starts, the recall park at 32 in `stage` (with `reason`), a person's approve at 33 (or `human`'s), and running again at 34. */
const recallWaiver = (reason = RECALL_REASON, human: Record<string, unknown> = {}, stage = 'decide') => [
  recallStart(30),
  recallStart(31),
  ev('transition', 32, { from: { stage, state: 'running', waitingOn: null }, to: { stage, state: 'waiting', waitingOn: 'human' }, reason }),
  said('approve', 33, human),
  tr(34, { stage, state: 'waiting', waitingOn: 'human' }, { stage }),
];

// ---- The moved gates: the PR opens, then the merge waits (PR13, PR15, PR17)
/** The reasons PR15 and PR16 parked on before the merge gates collapsed into one escalation park. */
const ESCALATED = 'approver escalated: see decision.md';
const RUNBOOK = 'runbook: steps before merge';
/** The escalation park's reason listing `rules`. */
const ESC = (...rules: string[]) => `escalation: ${rules.join(', ')}`;
/** `forge job gate` logged `reasons` at minute n. */
const GATE = (n: number, reasons: GateReason[] = []) => ev('gate', n, { round: 1, head: null, reasons });
const R_RUNBOOK: GateReason = { rule: 'runbook', detail: 'runbook.md has steps for a person' };
const R_VERSION: GateReason = { rule: 'version', detail: 'version changed in 1 manifest', paths: ['package.json'] };
const R_LENS: GateReason = { rule: 'lens-escalate', detail: 'the security review of round 1 says ESCALATE' };
const R_PROTECTED: GateReason = { rule: 'protected-paths', detail: '1 escalate path no person approved', paths: ['db/migrations/0001.sql'] };
const GATE_PR: Job['pr'] = { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) };
/** In pr after the move: the approver ended at 21, verify passed at 30 and the PR is OPEN. */
const atGate = (more: Partial<Job> = {}): Partial<Job> => job({ stage: 'pr', round: 1, reviewers: ['code'], verdicts: { 1: { code: 'PASS' } }, agents: { approver: ag(1, 20, 21) }, verifyRuns: [vr(1, 30, true)], pr: GATE_PR, ...more });
/** pr open pushed at 31, after the verify at 30. */
const OPENED = ev('pr-opened', 31, { number: 7, url: GATE_PR!.url });
/** A transition at minute n into a park in `stage` on `waitingOn` with `reason`. */
const parkTr = (n: number, stage: string, waitingOn: string, reason: string) => ev('transition', n, { from: { stage, state: 'running', waitingOn: null }, to: { stage, state: 'waiting', waitingOn }, reason });
/** Parked at n on (`waitingOn`, `reason`) in `stage`, a person's (or `human`'s) approve at n+1, running in pr again at n+2. */
const approvedAt = (n: number, stage: string, waitingOn: string, reason: string, human: Record<string, unknown> = {}) => [
  parkTr(n, stage, waitingOn, reason),
  said('approve', n + 1, human),
  tr(n + 2, { stage, state: 'waiting', waitingOn }, { stage: 'pr' }),
];
/** The recorded decision at 22, bound to HEAD_SHA, then the open at 31. */
const gateEvents = (decision: string, autoMerge = true) => [decided(decision, autoMerge, 22), OPENED];
/** A protected-paths flag on db/migrations/0001.sql recorded at minute `at`. */
const MIGRATION = (at = 15) => FLAG(at, ['db/migrations/0001.sql']);
const MIGRATION_REASON = 'protected paths: db/migrations/0001.sql';
const CI_REASON = 'push held: CI config changes: .github/workflows/ci.yml [ci 0123456789abcdef]';
/** `forge pr gate` set the PR's gate section and label for (`rule`, `reason`) at minute n. */
const synced = (n: number, rule: string, reason: string, reasons?: GateReason[]) => ev('pr-gate', n, { action: 'set', rule, reason, ...(reasons ? { reasons } : {}), number: 7, label: 'forge:needs-human', labeled: true, body: true });
const PR15_SYNCED = synced(31, 'PR15', ESC('approver'));
/** pr open logged a held push at minute n. */
const held = (n: number, reason = CI_REASON) => ev('push-held', n, { kind: 'ci', reason, head: HEAD_SHA, paths: ['.github/workflows/ci.yml'] });

/** A person's (or, with `more.actor`, the foreman's) `forge job human <action>` at minute n. */
const said = (action: string, n: number, more: Record<string, unknown> = {}) => ev('human', n, { action, note: 'ok', actor: { login: 'alice', source: 'env' }, ...more });
/** The job parked on `waitingOn` in `stage` at minute 10, then `action` was logged at 12. */
const answeredAt = (stage: string, waitingOn: string, action: string, more: Partial<Job> = {}, human: Record<string, unknown> = {}): FixtureOpts => ({
  job: job({ stage: stage as Job['stage'], state: 'waiting', waitingOn: waitingOn as Job['waitingOn'], reason: 'r', round: 1, ...more }),
  events: [tr(10, { stage }, { stage, state: 'waiting', waitingOn }), said(action, 12, human)],
});
/**
 * NP1 and NP1b: a builder (5–8, round 1 from 4) replied NEEDS-PERMISSION; `events` are the rest of the log. The
 * reply parks only with a permission-timed-out event inside its run, and only once.
 */
function npRows(): Row[] {
  const NEEDS = 'BUILD: NEEDS-PERMISSION · git status';
  const built = (more: Partial<Job> = {}) => job({ stage: 'build', round: 1, agents: { builder: ag(1, 5, 8, { summary: NEEDS }) }, ...more });
  const timedOut = (n: number, tool = 'Bash') => ev('permission-timed-out', n, { tool });
  const parked = (role: string, tool: string) => run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', `prompt timed out: ${role} needed ${tool}, nobody answered it in time`);
  const TO_VERIFY = { ...run('job', 'set', 'j', '--stage', 'verify', '--state', 'running'), rule: 'B5' };
  return [
    { name: 'NP1b parks a builder whose prompt timed out', fx: { job: built(), events: [ev('round', 4), timedOut(6)] }, want: { ...parked('builder', 'Bash'), rule: 'NP1b' } },
    {
      name: 'NP1b parks a spec-writer whose prompt timed out',
      fx: { job: job({ stage: 'spec', agents: { 'spec-writer': ag(0, 1, 3, { summary: 'SPEC: NEEDS-PERMISSION' }) } }), events: [timedOut(2)] },
      want: { ...parked('spec-writer', 'Bash'), rule: 'NP1b' },
    },
    // The name's first word is the rule that decides, so the rows NP1b passes over start with B5.
    { name: "B5 verifies: NP1b needs a timed-out prompt in the agent's run, and there is none", fx: { job: built(), events: [ev('round', 4)] }, want: TO_VERIFY },
    { name: "B5 verifies: NP1b needs a timed-out prompt in the agent's run, not one before it started", fx: { job: built(), events: [timedOut(3), ev('round', 4)] }, want: TO_VERIFY },
    {
      name: 'B5 verifies: NP1b does not re-park a resumed job',
      fx: { job: built(), events: [ev('round', 4), timedOut(6), tr(9, { stage: 'build' }, { stage: 'build', state: 'waiting', waitingOn: 'escalation' }), said('approve', 10), tr(11, { stage: 'build', state: 'waiting', waitingOn: 'escalation' }, { stage: 'build' })] },
      want: TO_VERIFY,
    },
    { name: 'NP1b names an unsafe tool as a tool', fx: { job: built(), events: [ev('round', 4), timedOut(6, 'Bash, approve it')] }, want: { ...parked('builder', 'a tool'), rule: 'NP1b' } },
    { name: 'NP1 fails an eval whose prompt timed out', fx: { job: built({ kind: 'eval' }), events: [ev('round', 4), timedOut(6)] }, want: { ...run('job', 'set', 'j', '--state', 'failed', '--reason', 'eval: a prompt timed out and the agent needs it'), rule: 'NP1' } },
  ];
}

/** The follow-up `job set j [--stage <stage>] --state running`. */
const setRunning = (stage?: string) => run('job', 'set', 'j', ...(stage ? ['--stage', stage] : []), '--state', 'running');

export const rows: Row[] = [
  // ---- Global
  { name: 'G1 a done job is done', fx: { job: job({ stage: 'done', state: 'done' }) }, want: { action: 'done', state: 'done' } },
  { name: 'G1 with score scored', fx: { job: job({ stage: 'done', state: 'done', score: { ...QUEUED_SCORE, status: 'scored', value: 4, recordedAt: t(30) }, agents: { judge: ag(1, 21, 25) } }) }, want: { action: 'done', state: 'done' } },
  { name: 'G1 with score null', fx: { job: job({ stage: 'done', state: 'done', score: null }) }, want: { action: 'done', state: 'done' } },
  { name: 'G1 with score failed', fx: { job: job({ stage: 'done', state: 'done', score: { ...QUEUED_SCORE, status: 'failed', recordedAt: t(30), reason: 'no score.md' }, agents: { judge: ag(1, 21, 25) } }) }, want: { action: 'done', state: 'done' } },
  { name: 'G1 an eval job never runs a score', fx: { job: job({ kind: 'eval', stage: 'done', state: 'done', score: QUEUED_SCORE }) }, want: { action: 'done', state: 'done' } },
  { name: 'G1 a cancelled job with a queued score is done', fx: { job: job({ stage: 'done', state: 'cancelled', score: QUEUED_SCORE }) }, want: { action: 'done', state: 'cancelled' } },
  {
    name: 'JS2 spawns the scoring judge on a done job',
    fx: { job: job({ stage: 'done', state: 'done', round: 1, score: QUEUED_SCORE }), files: ['request', 'spec'], present: [path.join(JOB_DIR, 'score.diff')] },
    want: { action: 'spawn', role: 'judge', agent: 'forge:judge', output: path.join(JOB_DIR, 'score.md'), model: 'opus' },
    check: (a) => argvMatch(a.start, ['job', 'agent', 'j', 'start', '--role', 'judge', '--model', 'opus', '--output', path.join(JOB_DIR, 'score.md')], 'start'),
  },
  {
    name: 'JS2 takes scoring.model',
    fx: { config: (c) => (c.scoring.model = 'haiku'), job: job({ stage: 'done', state: 'done', score: QUEUED_SCORE }) },
    want: { action: 'spawn', role: 'judge', model: 'haiku', output: path.join(JOB_DIR, 'score.md') },
  },
  { name: 'JS2 an older judge run does not count', fx: { job: job({ stage: 'done', state: 'done', score: QUEUED_SCORE, agents: { judge: ag(1, 5, 9) } }) }, want: { action: 'spawn', role: 'judge' } },
  { name: 'JS1 waits while the scoring judge runs', fx: { job: job({ stage: 'done', state: 'done', score: QUEUED_SCORE, agents: { judge: ag(1, 21) } }) }, want: { action: 'wait', waitingOn: 'agents', running: ['judge'] } },
  { name: 'JS3 records the score once the judge ends', fx: { job: job({ stage: 'done', state: 'done', score: QUEUED_SCORE, agents: { judge: ag(1, 21, 25) } }) }, want: run('job', 'score', 'record', 'j') },
  { name: 'JS3 records a lost judge too', fx: { job: job({ stage: 'done', state: 'done', score: QUEUED_SCORE, agents: { judge: ag(1, 21, 25, { status: 'lost' }) } }) }, want: run('job', 'score', 'record', 'j') },
  { name: 'G1 a cancelled job is done', fx: { job: job({ stage: 'build', state: 'cancelled' }) }, want: { action: 'done', state: 'cancelled', tell: 'j is cancelled' } },
  { name: 'G2 a failed job reports its reason', fx: { job: job({ stage: 'backlog', state: 'failed', reason: 'worktree setup failed' }) }, want: { action: 'done', state: 'failed', tell: 'j failed: worktree setup failed' } },
  { name: 'G3 releases the claim while the PR waits', fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', lease: { driver: 's', epoch: 1, since: t(0), renewedAt: t(0), expiresAt: t(30) } }) }, want: run('job', 'release', 'j') },
  { name: 'G3b stops background processes through the environment', fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review' }), runtime: ['dev'] }, want: { ...run('environment', 'stop', 'j'), rule: 'G3b' } },
  { name: 'G3b stops a running environment', fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review' }), environment: 'running' }, want: { ...run('environment', 'stop', 'j'), rule: 'G3b' } },
  { name: 'G3 releases the claim before stopping the environment', fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', lease: { driver: 's', epoch: 1, since: t(0), renewedAt: t(0), expiresAt: t(30) } }), environment: 'running' }, want: run('job', 'release', 'j') },
  { name: 'G3c waits once the environment is stopped', fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review' }), environment: 'stopped' }, want: { action: 'wait', rule: 'G3c', waitingOn: 'pr-review' } },
  { name: 'G4 an escalation stops a running environment', fx: { job: job({ stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'r' }), environment: 'running' }, want: { ...run('environment', 'stop', 'j'), rule: 'G4' } },
  { name: 'G4 blocked stops background processes', fx: { job: job({ stage: 'build', state: 'blocked', reason: 'dependency' }), runtime: ['dev'] }, want: { ...run('environment', 'stop', 'j'), rule: 'G4' } },
  { name: 'G4b waits once the environment is stopped', fx: { job: job({ stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'r' }), environment: 'stopped' }, want: { action: 'wait', rule: 'G4b', waitingOn: 'escalation' } },
  { name: 'E1 a resumed build starts its stopped environment', fx: { job: job({ stage: 'build', round: 1 }), environment: 'stopped' }, want: { ...run('environment', 'up', 'j'), rule: 'E1', tell: 'the job resumed: start its environment' } },
  { name: 'E1 a resumed verify starts its stopped environment', fx: { job: job({ stage: 'verify', round: 1 }), environment: 'stopped' }, want: { ...run('environment', 'up', 'j'), rule: 'E1' } },
  { name: 'E1 a resumed review starts its stopped environment', fx: { job: job({ stage: 'review', round: 1 }), environment: 'stopped' }, want: { ...run('environment', 'up', 'j'), rule: 'E1' } },
  { name: 'no E1 without a record entry', fx: { job: job({ stage: 'build', round: 1 }), environment: null }, want: {}, check: (a) => assert.notEqual(a.rule, 'E1') },
  { name: 'no E1 in spec', fx: { job: job({ stage: 'spec' }), environment: 'stopped' }, want: {}, check: (a) => assert.notEqual(a.rule, 'E1') },
  { name: 'no E1 while the environment runs', fx: { job: job({ stage: 'build', round: 1 }), environment: 'running' }, want: {}, check: (a) => assert.notEqual(a.rule, 'E1') },
  {
    name: 'G3c waits on review and names a missing issue',
    fx: { config: (c) => (c.tracker.kind = 'local'), job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }) },
    want: { action: 'wait', waitingOn: 'pr-review', running: [], tell: 'j PR https://github.com/o/r/pull/7 waits on review\nj has no linked issue: `forge job link j <ref>` or `--none`' },
  },
  { name: 'G4b waiting on budget', fx: { job: job({ stage: 'build', state: 'waiting', waitingOn: 'budget', reason: 'usd 12 > 10' }) }, want: { action: 'wait', waitingOn: 'budget', tell: 'j over budget: usd 12 > 10. A human presses Approve & continue on the budget gate in the dashboard (new limits such as usd=… go in its note), or runs forge job budget j --ack (or --set usd=…) in their own terminal, then /forge approve j' } },
  {
    name: 'G4b a repo budget hold tells the ack of the current month, not the per-job budget',
    fx: { job: job({ stage: 'build', state: 'waiting', waitingOn: 'budget', reason: 'repo budget: $103.20 of $100.00 this month' }) },
    want: { action: 'wait', waitingOn: 'budget', tell: `j held by the repo budget (repo budget: $103.20 of $100.00 this month). A human runs forge budget ack --period ${new Date().toISOString().slice(0, 7)}, or raises budget.usdPerMonth in .forge/config.yml; the job resumes once the repo is under its cap` },
  },
  {
    name: 'G4b a repo budget hold on the day cap tells the ack of the current day',
    fx: { job: job({ stage: 'build', state: 'waiting', waitingOn: 'budget', reason: 'repo budget: $5.00 of $5.00 today' }) },
    want: { action: 'wait', waitingOn: 'budget', tell: `j held by the repo budget (repo budget: $5.00 of $5.00 today). A human runs forge budget ack --period ${new Date().toISOString().slice(0, 10)}, or raises budget.usdPerDay in .forge/config.yml; the job resumes once the repo is under its cap` },
  },
  { name: 'G4b blocked waits on external', fx: { job: job({ stage: 'build', state: 'blocked', reason: 'dependency' }) }, want: { action: 'wait', waitingOn: 'external', tell: 'j waits: dependency' } },
  { name: 'G4b an escalation names the decision', fx: { job: job({ stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: see decision.md' }) }, want: { action: 'wait', waitingOn: 'escalation', tell: `j escalated (approver escalated: see decision.md): see ${path.join(JOB_DIR, 'decision.md')}. /forge approve j or /forge rework j <note>` } },
  { name: 'G4b spec approval names the spec and mockup', fx: { files: ['spec', 'mockup'], job: job({ stage: 'spec', state: 'waiting', waitingOn: 'spec-approval' }) }, want: { action: 'wait', waitingOn: 'spec-approval', tell: `j spec ready: ${path.join(JOB_DIR, 'spec.md')} · mockup ${path.join(JOB_DIR, 'mockup.html')}. /forge approve j or /forge revise j <note>` } },
  { name: 'G4b running agents are listed at a gate', fx: { job: job({ stage: 'review', state: 'waiting', waitingOn: 'budget', agents: { 'reviewer:tests': ag(1, 1) } }) }, want: { action: 'wait', waitingOn: 'budget', running: ['reviewer:tests'] } },
  // ---- Answered gates: a decision logged at the current park runs its follow-up job set.
  { name: 'GA1 an approved spec resumes in its stage', fx: answeredAt('spec', 'spec-approval', 'approve-spec'), want: setRunning() },
  { name: 'GA2 an approved escalation in decide ships', fx: answeredAt('decide', 'escalation', 'approve'), want: setRunning('integrate') },
  { name: "GA2 the foreman's approve at rounds-exhausted in review ships", fx: answeredAt('review', 'rounds-exhausted', 'approve', {}, { actor: FOREMAN }), want: setRunning('integrate') },
  { name: 'GA2 answers before G4 stops a running environment', fx: { ...answeredAt('decide', 'escalation', 'approve'), environment: 'running' }, want: setRunning('integrate') },
  { name: 'GA2b an approved escalation in integrate decides again', fx: answeredAt('integrate', 'escalation', 'approve'), want: setRunning('decide') },
  { name: 'GA3 approved runbook steps go to integrate', fx: answeredAt('decide', 'infra', 'approve'), want: setRunning('integrate') },
  { name: 'GA4 approved conflicts go to the integrator', fx: answeredAt('integrate', 'conflicts', 'approve'), want: setRunning('integrate') },
  { name: 'GA4 a rework on conflicts is an approve', fx: answeredAt('integrate', 'conflicts', 'rework'), want: setRunning('integrate') },
  { name: 'GA5 an approved issue link resumes', fx: answeredAt('backlog', 'issue-link', 'approve'), want: setRunning() },
  { name: 'GA6 an approve on a human park resumes', fx: answeredAt('decide', 'human', 'approve', { reason: 'protected paths: package-lock.json' }), want: setRunning() },
  { name: 'GA6b a repo decision resumes the proposal park', fx: answeredAt('spec', 'human', 'reject-repos', { reason: 'repo proposal: lib' }), want: setRunning() },
  { name: 'GA7 an approve at a budget park with nothing still over resumes', fx: { ...answeredAt('build', 'budget', 'approve', { reason: 'budget exceeded: usd 12.00/10.00' }), budgetExceeded: [] }, want: setRunning() },
  { name: 'GA8 a rework on an escalation in build builds again', fx: answeredAt('build', 'escalation', 'rework'), want: setRunning('build') },
  { name: 'GA8 the latest decision at a park wins over an earlier approve', fx: { ...answeredAt('decide', 'escalation', 'approve'), events: [tr(10, { stage: 'decide' }, { stage: 'decide', state: 'waiting', waitingOn: 'escalation' }), said('approve', 12), said('rework', 13)] }, want: setRunning('build') },
  {
    name: 'GA8 a rework on an open PR moves to build before G3',
    fx: answeredAt('pr', 'pr-review', 'rework', { pr: OPEN_PR, lease: { driver: 's', epoch: 1, since: t(0), renewedAt: t(0), expiresAt: t(30) } }),
    want: setRunning('build'),
  },
  { name: 'GA9 a revised spec goes back to spec', fx: answeredAt('spec', 'spec-approval', 'revise-spec'), want: setRunning('spec') },
  { name: 'GA9 a revise on an escalation before build goes back to spec', fx: answeredAt('spec', 'escalation', 'revise-spec'), want: setRunning('spec') },
  { name: 'GA10 an approved split plans again', fx: answeredAt('plan', 'split-approval', 'approve-split'), want: setRunning('plan') },
  { name: 'GA10 a rejected split plans again', fx: answeredAt('plan', 'split-approval', 'revise-split'), want: setRunning('plan') },
  { name: 'GA11 an answer resumes the agent that asked', fx: answeredAt('spec', 'input', 'answer'), want: setRunning() },
  { name: 'G4b … not an answer: answer at an escalation park', fx: answeredAt('decide', 'escalation', 'answer'), want: { action: 'wait', waitingOn: 'escalation' } },
  { name: 'G4b … not an answer: approve at an escalation in spec', fx: answeredAt('spec', 'escalation', 'approve'), want: { action: 'wait', waitingOn: 'escalation' } },
  { name: 'G4b … not an answer: rework at a split-approval park', fx: answeredAt('plan', 'split-approval', 'rework'), want: { action: 'wait', waitingOn: 'split-approval' } },
  {
    name: 'G4b … not an answer: a decision logged before the park',
    fx: { ...answeredAt('decide', 'escalation', 'approve'), events: [said('approve', 8), tr(10, { stage: 'decide' }, { stage: 'decide', state: 'waiting', waitingOn: 'escalation' })] },
    want: { action: 'wait', waitingOn: 'escalation' },
  },
  { name: 'G4b … not an answer: a waiting job whose events hold no transition', fx: { ...answeredAt('decide', 'escalation', 'approve'), events: [said('approve', 12)] }, want: { action: 'wait', waitingOn: 'escalation' } },
  {
    name: 'G4b … not an answer: an approve at a budget park does not answer a later escalation',
    fx: {
      ...answeredAt('decide', 'escalation', 'approve'),
      events: [tr(10, { stage: 'decide' }, { stage: 'decide', state: 'waiting', waitingOn: 'budget' }), said('approve', 11), tr(12, { stage: 'decide', state: 'waiting', waitingOn: 'budget' }, { stage: 'decide', state: 'waiting', waitingOn: 'escalation' })],
    },
    want: { action: 'wait', waitingOn: 'escalation' },
  },
  {
    name: 'G4b … not an answer: notes, budget acks and hand-offs never answer',
    fx: { ...answeredAt('decide', 'escalation', 'approve'), events: [tr(10, { stage: 'decide' }, { stage: 'decide', state: 'waiting', waitingOn: 'escalation' }), ev('note', 11, { text: 'approve' }), ev('budget-ack', 12, { keys: ['usd'] }), ev('release-approval', 13, { action: 'approve' }), ev('foreman-handoff', 14, { gate: 'escalation', class: 'escalated', reason: 'x' })] },
    want: { action: 'wait', waitingOn: 'escalation' },
  },
  { name: 'G4b budget still exceeded', fx: { ...answeredAt('build', 'budget', 'approve', { reason: 'budget exceeded: usd 12.00/10.00' }), budgetExceeded: ['usd'] }, want: { action: 'wait', waitingOn: 'budget', tell: 'j over budget: budget exceeded: usd 12.00/10.00. A human presses Approve & continue on the budget gate in the dashboard (new limits such as usd=… go in its note), or runs forge job budget j --ack (or --set usd=…) in their own terminal, then /forge approve j' } },
  { name: 'G4b … not an answer: approve at a repo budget hold', fx: { ...answeredAt('build', 'budget', 'approve', { reason: 'repo budget: $5.00 of $5.00 today' }), budgetExceeded: [] }, want: { action: 'wait', waitingOn: 'budget' } },
  {
    name: 'G4b a shelved job waits and names the un-shelve',
    fx: { job: job({ stage: 'decide', state: 'waiting', waitingOn: 'shelved', reason: 'shelved: waiting on the billing owner' }) },
    want: { action: 'wait', rule: 'G4b', waitingOn: 'shelved', tell: "j is shelved (waiting on the billing owner). A person un-shelves it with forge job unshelve j in their own terminal, or with Approve, Rework, Un-shelve or Close in the dashboard's Shelved list" },
  },
  { name: 'G4b … not an answer: approve at a shelved park', fx: answeredAt('decide', 'shelved', 'approve'), want: { action: 'wait', rule: 'G4b', waitingOn: 'shelved' } },
  { name: 'G5 waits on running agents', fx: { job: job({ stage: 'build', round: 1, agents: { builder: ag(1, 5) } }) }, want: { action: 'wait', waitingOn: 'agents', running: ['builder'] } },
  { name: 'L1 respawns a lost builder without resume', fx: { files: ['spec'], job: job({ stage: 'build', round: 1, agents: { builder: ag(1, 5, 6, { status: 'lost' }) } }), events: [ev('round', 4)] }, want: { action: 'spawn', role: 'builder' }, check: (a) => assert.equal(a.resume, undefined) },
  { name: 'L1 respawns a failed approver', fx: { job: atDecide({ agents: { approver: ag(1, 20, 21, { status: 'failed' }) } }) }, want: { action: 'spawn', role: 'approver' } },

  // ---- Per-role generic rules
  { name: 'N1b parks a spec-writer that asked', fx: { job: job({ stage: 'spec', agents: { 'spec-writer': ag(0, 1, 2, { summary: 'SPEC: NEEDS-INPUT · 2 questions' }) } }) }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'input', '--reason', 'spec-writer has questions') },
  { name: 'N1 an eval NEEDS-INPUT fails the task', fx: { job: job({ kind: 'eval', stage: 'spec', agents: { 'spec-writer': ag(0, 1, 2, { summary: 'NEEDS-INPUT' }) } }) }, want: run('job', 'set', 'j', '--state', 'failed', '--reason', 'eval: NEEDS-INPUT fails the task') },
  ...npRows(),
  { name: 'N1b builder asked in this round', fx: { job: job({ stage: 'build', round: 1, agents: { builder: ag(1, 5, 6, { summary: 'needs-input' }) } }), events: [ev('round', 4)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'input', '--reason', 'builder has questions') },
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
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'reviewer code wrote no review'),
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
  { name: 'M2 approver twice without decision.md', fx: { job: atDecide({ agents: { approver: ag(1, 20, 21, { outputMissing: true, retry: true }) } }) }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'approver wrote no decision.md') },

  // ---- Kind gates
  { name: 'K1 a retro job starts with the procedure', fx: { job: job({ kind: 'retro', stage: 'backlog' }) }, want: { action: 'procedure', reference: path.join(path.resolve(import.meta.dirname, '..'), 'skills', 'forge', 'reference', 'retro.md') } },
  { name: 'K1 a retro that wrote no spec.md', fx: { job: job({ kind: 'retro', stage: 'backlog', agents: { retro: ag(0, 1, 2) } }) }, want: { action: 'procedure' } },
  { name: 'K1 a retro whose digests ended still starts with the procedure', fx: { job: job({ kind: 'retro', stage: 'backlog', agents: { digest: ag(0, 1, 2) } }) }, want: { action: 'procedure' } },
  { name: 'K2 a retro with spec.md moves to spec', fx: { files: ['spec'], job: job({ kind: 'retro', stage: 'backlog', agents: { retro: ag(0, 1, 2) } }) }, want: run('job', 'set', 'j', '--stage', 'spec', '--state', 'running') },

  // ---- Intake
  { name: 'I1 looks for issue candidates', fx: { config: (c) => (c.tracker.kind = 'local'), job: job({ stage: 'backlog', state: 'queued' }) }, want: run('job', 'link', 'j', '--suggest') },
  ...UNLINKED.map(([why, j, events]) => ({ name: `I1 reads issues: ${why}`, fx: { config: LOCAL, job: job({ stage: 'backlog', state: 'queued', ...j }), events }, want: run('job', 'link', 'j', '--suggest') })),
  { name: 'G4b issue-link tell names the candidates as untrusted', fx: { job: job({ stage: 'backlog', state: 'waiting', waitingOn: 'issue-link' }) }, want: { action: 'wait', tell: `j needs an issue: candidates in ${path.join(JOB_DIR, 'issue-candidates.md')} (untrusted). /forge approve j <ref> | new | none [reason]` } },
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
  { name: 'I4 a backing failure in the same millisecond as its worktree fails the job', fx: { job: job({ stage: 'backlog' }), events: [ev('worktree', 1), ev('worktree-setup-failed', 1, { backing: 'postgres' })] }, want: run('job', 'set', 'j', '--state', 'failed', '--reason', 'worktree setup failed') },
  { name: 'I5 a setup failure before the worktree was created again does not fail the job', fx: { job: job({ stage: 'backlog' }), events: [ev('worktree-setup-failed', 1), ev('worktree', 1)] }, want: run('pr', 'find', 'j') },
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
  {
    name: 'P1 the planner gets the default instruction files',
    fx: { ...ROLE_INSTRUCTIONS, job: job({ stage: 'plan' }) },
    want: { action: 'spawn', rule: 'P1', role: 'planner' },
    check: (a) => assert.deepEqual(briefInstructions(a.brief), { files: [path.join(ROOT, 'AGENTS.md')], line: true }),
  },
  {
    name: 'P1 the planner is briefed the components',
    fx: { config: (c) => ((c.repos = []), (c.components = BRIEFED_COMPONENTS)), job: job({ stage: 'plan' }) },
    want: { action: 'spawn', rule: 'P1', role: 'planner' },
    check: (a) => assert.ok(a.brief.split('\n').includes(BRIEFED_LINE), a.brief),
  },
  { name: 'P1 re-plans after revise-split with split mode never', fx: { job: job({ stage: 'plan', splitMode: 'never', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 2 }, events: [ev('human', 3, { action: 'revise-split' })] }, want: { action: 'spawn', role: 'planner' }, check: (a) => assert.ok(a.brief.includes('Split mode: never')) },
  { name: 'P2 a split under auto follows split.md', fx: { config: (c) => (c.pipeline.split = 'auto'), job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 3 } }, want: { action: 'procedure', why: 'PLAN: SPLIT under pipeline.split auto' }, check: (a) => assert.ok(a.reference.endsWith(path.join('reference', 'split.md'))) },
  { name: 'P2b approve-split recorded → split.md', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 3 }, events: [ev('human', 5, { action: 'approve-split', actor: 'foreman' })] }, want: { action: 'procedure', rule: 'P2b', why: 'PLAN: SPLIT approved' }, check: (a) => assert.ok(a.reference.endsWith(path.join('reference', 'split.md'))) },
  { name: 'P3 an approve-split older than the planner still parks', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 3, 4) } }), plan: { verdict: 'SPLIT', jobs: 3 }, events: [ev('human', 1, { action: 'approve-split' })] }, want: { action: 'run', rule: 'P3' } },
  { name: 'P3 a split under ask waits for approval', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 3 } }, want: run('job', 'set', 'j', '--stage', 'plan', '--state', 'waiting', '--waiting-on', 'split-approval', '--reason', 'planner proposes 3 jobs') },
  { name: 'P3 a split returned under never still waits', fx: { config: (c) => (c.pipeline.split = 'never'), job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 2 } }, want: { action: 'run', rule: 'P3' } },
  { name: 'G4b split-approval tell', fx: { files: ['plan'], plan: { verdict: 'SPLIT', jobs: 3 }, job: job({ stage: 'plan', state: 'waiting', waitingOn: 'split-approval' }) }, want: { action: 'wait', tell: `j planner proposes 3 jobs: ${path.join(JOB_DIR, 'plan.md')}. /forge approve j to create them, or /forge revise j [note] to keep one job` } },
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
  {
    name: 'SP1 spawns the spec-writer',
    fx: { files: ['request'], job: job({ stage: 'spec' }) },
    want: { action: 'spawn', role: 'spec-writer', agent: 'forge:spec-writer', model: 'opus', output: path.join(JOB_DIR, 'spec.md') },
    check: (a) => {
      assert.ok(a.brief.includes('Review panel: code, tests, security'));
      assert.ok(!a.brief.includes('Components (JSON)'), 'no components configured: no line');
    },
  },
  {
    name: 'SP1 the spec-writer is briefed the components',
    fx: { config: (c) => ((c.repos = []), (c.components = BRIEFED_COMPONENTS)), files: ['request'], job: job({ stage: 'spec' }) },
    want: { action: 'spawn', rule: 'SP1', role: 'spec-writer' },
    check: (a) => assert.ok(a.brief.split('\n').includes(BRIEFED_LINE), a.brief),
  },
  {
    name: "SP1 the spec-writer gets its role's instruction files",
    fx: { ...ROLE_INSTRUCTIONS, files: ['request'], job: job({ stage: 'spec' }) },
    want: { action: 'spawn', rule: 'SP1', role: 'spec-writer' },
    check: (a) => assert.deepEqual(briefInstructions(a.brief), { files: [path.join(ROOT, 'AGENTS.md'), path.join(ROOT, 'docs', 'DEVELOPING.md')], line: true }),
  },
  { name: 'SP2 a revise-spec re-runs the spec-writer with feedback', fx: { files: ['feedback'], job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET, ev('human', 4, { action: 'revise-spec' })] }, want: { action: 'spawn', role: 'spec-writer' }, check: (a) => assert.ok(a.brief.includes(path.join(JOB_DIR, 'feedback.md'))) },
  { name: 'SP3 panel always lenses', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }) }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'componentsDeclared=[]') },
  { name: 'SP3 panel adds suggested lenses that exist', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { suggested: ['security', 'docs'] } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests","security"]', '--field', 'componentsDeclared=[]') },
  { name: 'SP3 panel drops unknown and malformed names', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { suggested: ['evil;rm', 'UI ', 'Security', 'a\';touch x;\''] } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'componentsDeclared=[]') },
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
    want: run('job', 'set', 'j', '--field', 'reviewers=["ui","code","security"]', '--field', 'componentsDeclared=[]'),
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
    want: run('job', 'set', 'j', '--field', 'reviewers=["code","design","security"]', '--field', 'componentsDeclared=[]'),
  },
  {
    name: 'SP3 panel records size and known components only',
    fx: {
      config: (c) => (c.components = [{ name: 'dashboard', path: 'dashboard', kind: 'app' }, { name: 'cli', path: 'bin', kind: 'library' }]),
      job: job({ stage: 'spec', agents: SPEC_DONE }),
      spec: { size: 'L', components: ['dashboard', 'evil;x', 'web', 'cli', 'dashboard'] },
    },
    want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'size=L', '--field', 'componentsDeclared=["dashboard","cli"]', '--field', 'components=["dashboard","cli"]'),
  },
  {
    name: 'SP3 leaves a recomputed components list alone',
    fx: {
      config: (c) => (c.components = [{ name: 'dashboard', path: 'dashboard', kind: 'app' }, { name: 'cli', path: 'bin', kind: 'library' }]),
      job: job({ stage: 'spec', agents: SPEC_DONE, components: ['cli'], componentsDeclared: ['cli'], componentsFromDiff: ['cli'] }),
      spec: { components: ['dashboard', 'cli'] },
    },
    want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'componentsDeclared=["dashboard","cli"]'),
  },
  { name: 'SP3 panel ignores a size that is not S, M or L', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { size: 'XL;rm' } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'componentsDeclared=[]') },
  { name: 'SP3 panel for a retro job is code and docs', fx: { files: ['spec'], job: job({ kind: 'retro', stage: 'spec', agents: { retro: ag(0, 1, 2) } }), spec: { suggested: ['security'] } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","docs"]', '--field', 'componentsDeclared=[]') },
  { name: 'SP3 records the spec\'s complexity', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { complexity: 'high' } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'complexity=high', '--field', 'componentsDeclared=[]') },
  { name: 'SP3 without a Complexity header records none', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }) }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'componentsDeclared=[]') },
  { name: 'SP3 clears a stale complexity', fx: { job: job({ stage: 'spec', complexity: 'low', agents: SPEC_DONE }) }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'complexity=null', '--field', 'componentsDeclared=[]') },
  { name: 'SP3 ignores an invalid complexity', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), spec: { complexity: 'extreme' } }, want: run('job', 'set', 'j', '--field', 'reviewers=["code","tests"]', '--field', 'componentsDeclared=[]') },
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
  { name: 'G4b an unlinked spec gate tells the spec and the candidates', fx: { config: LOCAL, files: ['spec'], job: job({ stage: 'spec', state: 'waiting', waitingOn: 'spec-approval', reason: 'spec ready, issue unlinked' }) }, want: { action: 'wait', rule: 'G4b', waitingOn: 'spec-approval', tell: `${SPEC_TELL}\n${LINK_TELL}` } },
  { name: 'G4b a linked spec gate tells only the spec', fx: { config: LOCAL, files: ['spec'], job: job({ stage: 'spec', state: 'waiting', waitingOn: 'spec-approval', reason: 'spec ready', ...LINKED }) }, want: { action: 'wait', rule: 'G4b', waitingOn: 'spec-approval', tell: SPEC_TELL } },
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
  { name: 'N1b the fold-in spec-writer asked', fx: { job: job({ stage: 'design', agents: { 'spec-writer': ag(0, 6, 7, { summary: 'NEEDS-INPUT' }), designer: ag(0, 4, 5) } }), designDeltas: true }, want: { action: 'run', rule: 'N1b' } },

  // ---- Build
  { name: 'B1 starts round 1', fx: { job: job({ stage: 'build', round: 0 }) }, want: run('job', 'round', 'j') },
  { name: 'B1 starts the next round after CHANGES', fx: { job: job({ stage: 'build', round: 1, verdicts: { 1: { code: 'CHANGES' } }, agents: { builder: ag(1, 5, 6) } }) }, want: run('job', 'round', 'j') },
  { name: 'B1 a human rework starts a round', fx: { job: job({ stage: 'build', round: 2, agents: { builder: ag(2, 5, 6) } }), events: [ev('round', 4), ev('human', 7, { action: 'rework' })] }, want: run('job', 'round', 'j') },
  { name: 'B2 rounds exhausted', fx: { job: job({ stage: 'build', round: 4, maxRounds: 3, agents: { builder: ag(3, 5, 6) } }), events: [ev('round', 7)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 4 exceeds maxRounds 3') },
  { name: 'B2 a live job past maxRounds still parks', fx: { job: job({ stage: 'build', round: 4, maxRounds: 3, agents: { builder: ag(3, 5, 6) } }), events: [ev('round', 7)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 4 exceeds maxRounds 3'), rule: 'B2' } },
  { name: 'B4 an open security review reworks past maxRounds', fx: { job: job({ stage: 'build', round: 4, maxRounds: 3, verdicts: { 3: { code: 'PASS', security: 'CHANGES' } }, agents: { builder: ag(3, 5, 6) } }), events: [ev('round', 7)] }, want: { action: 'spawn', rule: 'B4', role: 'builder' } },
  { name: 'B2 an open security review parks at twice maxRounds', fx: { config: (c) => (c.pipeline.maxTotalRounds = 20), job: job({ stage: 'build', round: 7, maxRounds: 3, verdicts: { 6: { security: 'MALFORMED' } }, agents: { builder: ag(6, 5, 6) } }), events: [ev('round', 7)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 7 exceeds twice maxRounds 3 with the security review not PASS') },
  { name: 'B2 a security review that passed again parks at maxRounds', fx: { job: job({ stage: 'build', round: 4, maxRounds: 3, verdicts: { 2: { security: 'CHANGES' }, 3: { code: 'CHANGES', security: 'PASS' } }, agents: { builder: ag(3, 5, 6) } }), events: [ev('round', 7)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 4 exceeds maxRounds 3') },
  { name: 'B6b an eval job past maxRounds goes to decide', fx: { job: job({ kind: 'eval', eval: { run: 'r', task: 'hello' }, stage: 'build', round: 4, maxRounds: 3, agents: { builder: ag(3, 5, 6) } }), events: [ev('round', 7)] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running', '--reason', 'eval: round 4 exceeds maxRounds 3'), rule: 'B6b' } },
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
  { name: 'B7 a builder round past the total-round ceiling parks', fx: { job: job({ stage: 'build', round: 5, maxRounds: 2, agents: { builder: ag(4, 5, 6) } }), events: [ev('round', 7), ev('round', 10)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 5 exceeds the total-round ceiling 4: only a human clears it') },
  { name: 'B7 a foreman-opened round past the ceiling parks', fx: { job: job({ stage: 'build', round: 5, maxRounds: 2, agents: { builder: ag(4, 5, 6) } }), events: [ev('round', 7), ev('human', 8, { action: 'rework', actor: FOREMAN }), ev('round', 9)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 5 exceeds the total-round ceiling 4: only a human clears it') },
  { name: 'B7 a CI-rework round past the ceiling parks', fx: { job: job({ stage: 'build', round: 5, maxRounds: 2, agents: { builder: ag(4, 5, 6) } }), events: [ev('round', 7), ev('human', 8, { action: 'rework', actor: FOREMAN, ciHead: 'a'.repeat(40) }), ev('round', 9)] }, want: { rule: 'B7', action: 'run' } },
  { name: "B7 the round after a person's rework parks again", fx: { job: job({ stage: 'build', round: 6, maxRounds: 2, verdicts: { 5: { code: 'CHANGES' } }, agents: { builder: ag(5, 10, 11) } }), events: [ev('round', 7), ev('human', 8, { action: 'rework', actor: { login: 'alice', source: 'cli' } }), ev('round', 9), ev('round', 12)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 6 exceeds the total-round ceiling 4: only a human clears it') },
  { name: 'B7 pipeline.maxTotalRounds sets the ceiling', fx: { config: (c) => (c.pipeline.maxTotalRounds = 3), job: job({ stage: 'build', round: 4, maxRounds: 5, agents: { builder: ag(3, 5, 6) } }), events: [ev('round', 7)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 4 exceeds the total-round ceiling 3: only a human clears it') },
  { name: 'B6 an eval job past the total-round ceiling goes to decide', fx: { config: (c) => (c.pipeline.maxTotalRounds = 2), job: job({ kind: 'eval', eval: { run: 'r', task: 'hello' }, stage: 'build', round: 3, maxRounds: 3, agents: { builder: ag(2, 5, 6) } }), events: [ev('round', 7)] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running', '--reason', 'eval: round 3 exceeds the total-round ceiling 2'), rule: 'B6' } },
  { name: 'B7 wins over B2 past both limits', fx: { job: job({ stage: 'build', round: 7, maxRounds: 2, agents: { builder: ag(6, 5, 6) } }), events: [ev('round', 7)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 7 exceeds the total-round ceiling 4: only a human clears it'), rule: 'B7' } },
  { name: 'G4b rounds-exhausted tell', fx: { job: job({ stage: 'build', round: 4, maxRounds: 3, state: 'waiting', waitingOn: 'rounds-exhausted' }) }, want: { action: 'wait', tell: 'j used all 3 rounds. /forge approve j to ship, or /forge rework j <note>' } },
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
      assert.ok(!('resumeSkipped' in a), "a role's first run is no resume candidate");
      assert.ok(!a.start.includes('--resume') && !a.start.includes('--resume-skipped'));
      assert.ok(!a.brief.includes('Rework:'));
      assert.ok(!a.brief.includes('Rework scope:'));
      assert.ok(!a.brief.includes('Reference:'));
      assert.ok(a.brief.includes('Infra: mode human · allowed []'));
      assert.ok(a.brief.split('\n').includes('UI proof: none · no AC needs a rendered UI, so do not use browser tools'));
      assert.ok(a.brief.split('\n').includes('File map: none in spec.md · explore the code the Approach names'));
      assert.equal(a.brief.split('\n').filter((l: string) => l.startsWith('File map:')).length, 1);
      assert.equal(a.brief.split('\n').length, 14);
      assert.ok(a.brief.split('\n').includes(`Inputs: ${path.join(JOB_DIR, 'spec.md')}, ${path.join(JOB_DIR, 'tasks.md')}`));
    },
  },
  {
    name: 'B4 the round-1 builder lists approval-notes.md after tasks.md',
    fx: { files: ['spec', 'tasks'], present: [NOTES_MD], job: job({ stage: 'build', round: 1 }), events: [ev('human', 2, { action: 'approve-spec', note: 'build on main after #91', actor: PERSON, approvalNote: true }), ev('round', 4)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      const lines: string[] = a.brief.split('\n');
      assert.ok(lines.includes(`Inputs: ${[path.join(JOB_DIR, 'spec.md'), path.join(JOB_DIR, 'tasks.md'), NOTES_MD].join(', ')}`), a.brief);
      assert.equal(lines.length, 14);
    },
  },
  {
    name: "B4 the round-1 builder starts from the spec's file map",
    fx: {
      files: ['spec', 'tasks'],
      acs: acCoverage('# S\n\n## Approach\nDo it.\n\nFiles:\n| Path | Symbols | Change | Tests |\n|---|---|---|---|\n| `a.ts` | `f` | new | `a.test.ts` |\n| `b.ts` | - | reuse | - |\n', null),
      job: job({ stage: 'build', round: 1 }),
      events: [ev('round', 4)],
    },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      const lines = a.brief.split('\n');
      assert.ok(lines.includes("File map: 2 rows in spec.md's Approach › Files · start from it; explore only what it does not cover"), a.brief);
      assert.equal(lines.filter((l: string) => l.startsWith('File map:')).length, 1);
    },
  },
  {
    name: 'B4 the round-1 builder reads the folder maps first',
    fx: {
      files: ['spec', 'tasks'],
      folderMaps: { maps: [path.join(WT, 'lib', 'engine', 'AGENTS.md')], topics: [path.join(WT, 'docs', 'architecture', 'x.md')], more: 2 },
      job: job({ stage: 'build', round: 1 }),
      events: [ev('round', 4)],
    },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      const lines: string[] = a.brief.split('\n');
      const i = lines.findIndex((l) => l.startsWith('Maps (JSON): '));
      assert.ok(i >= 0, a.brief);
      assert.ok(lines[i + 1].startsWith('File map: '), 'directly before File map:');
      const json = lines[i].slice('Maps (JSON): '.length, lines[i].indexOf(' · read these before you search'));
      assert.deepEqual(JSON.parse(json), { maps: [path.join(WT, 'lib', 'engine', 'AGENTS.md')], topics: [path.join(WT, 'docs', 'architecture', 'x.md')], more: 2 });
      assert.equal(lines.length, 15);
    },
  },
  {
    name: 'B4 empty folder maps add no line',
    fx: { files: ['spec', 'tasks'], folderMaps: { maps: [], topics: [] }, job: job({ stage: 'build', round: 1 }), events: [ev('round', 4)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => assert.ok(!a.brief.includes('Maps (JSON):'), a.brief),
  },
  {
    name: 'B4 the round-1 builder sees the review standards',
    fx: { files: ['spec', 'tasks'], ...STANDARDS, verifierQuestions: QUESTIONS(23), job: job({ stage: 'build', round: 1, reviewers: ['code', 'tests', 'docs'] }), events: [ev('round', 4)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: standardsCheck(23),
  },
  {
    name: 'B4 the round-1 builder sees exactly 20 verifier questions without a suffix',
    fx: { files: ['spec', 'tasks'], ...STANDARDS, verifierQuestions: QUESTIONS(20), job: job({ stage: 'build', round: 1, reviewers: ['code', 'tests', 'docs'] }), events: [ev('round', 4)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: standardsCheck(20),
  },
  {
    name: 'B4 a review rework spawns a fresh builder with a findings-first brief',
    fx: {
      files: ['spec', 'feedback', 'tasks', 'build'],
      present: [path.join(JOB_DIR, 'review', 'round-1', 'code.md'), path.join(JOB_DIR, 'review', 'round-1', 'tests.md')],
      folderMaps: { maps: [path.join(WT, 'lib', 'AGENTS.md')], topics: [] },
      ...STANDARDS,
      verifierQuestions: QUESTIONS(3),
      job: job({ stage: 'build', round: 2, reviewers: ['code', 'tests', 'docs'], verdicts: { 1: { code: 'CHANGES', tests: 'PASS' } }, agents: { builder: ag(1, 5, 6, { agentId: 'b1' }) } }),
      events: [ev('round', 7)],
    },
    want: { action: 'spawn', rule: 'B4', role: 'builder', resumeSkipped: 'no session' },
    check: (a) => {
      assert.equal(a.resume, undefined);
      assert.ok(!('resume' in a));
      argvMatch(a.start, ['job', 'agent', 'j', 'start', '--resume-skipped', 'no session'], 'start');
      const lines = a.brief.split('\n');
      assert.ok(lines.includes(`Inputs: ${[path.join(JOB_DIR, 'review', 'round-1', 'code.md'), path.join(JOB_DIR, 'feedback.md'), path.join(JOB_DIR, 'tasks.md'), path.join(JOB_DIR, 'build.md')].join(', ')}`));
      assert.ok(lines.includes('Rework: review, feedback'));
      assert.ok(lines.some((l: string) => l.startsWith('Rework scope: ')));
      assert.ok(lines.includes(`Reference: ${path.join(JOB_DIR, 'spec.md')}`));
      assert.ok(!a.brief.includes('File map:'));
      assert.ok(!a.brief.includes('Maps (JSON):'));
      assert.ok(!a.brief.includes('Review checklists (JSON):'));
      assert.ok(!a.brief.includes('Verifier questions (JSON):'));
    },
  },
  {
    name: 'B4 a rework lists a builder note given since the last builder started',
    fx: noteRework([ev('human', 2, { action: 'approve-spec', note: 'build on main', actor: PERSON, approvalNote: true }), ev('round', 7), ev('builder-note', 8, { note: 'CI Windows is flaky', actor: PERSON })]),
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      const lines: string[] = a.brief.split('\n');
      assert.ok(lines.includes(`Inputs: ${[path.join(JOB_DIR, 'review', 'round-1', 'code.md'), path.join(JOB_DIR, 'tasks.md'), path.join(JOB_DIR, 'build.md'), NOTES_MD].join(', ')}`), a.brief);
      // Notes change only the inputs: the same rework without the hint has the same Rework: line and model.
      const without = step(fixture(noteRework([ev('round', 7)]))) as any;
      assert.ok(lines.includes('Rework: review'));
      assert.ok(without.brief.split('\n').includes('Rework: review'));
      assert.equal(a.model, without.model);
    },
  },
  {
    name: 'B4 a rework leaves out notes the last builder already had',
    fx: noteRework([ev('human', 2, { action: 'approve-spec', note: 'build on main', actor: PERSON, approvalNote: true }), ev('round', 7)]),
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      const lines: string[] = a.brief.split('\n');
      assert.ok(lines.includes(`Inputs: ${[path.join(JOB_DIR, 'review', 'round-1', 'code.md'), path.join(JOB_DIR, 'tasks.md'), path.join(JOB_DIR, 'build.md')].join(', ')}`), a.brief);
      assert.ok(lines.includes('Rework: review'));
    },
  },
  {
    // The CLI marks an approve-spec note it let into the file; one it refused (another job's session, a job not at spec-approval) is unmarked.
    name: 'B4 a rework does not list an approve-spec note the CLI did not mark, even one given since the last builder started',
    fx: noteRework([ev('human', 2, { action: 'approve-spec', note: 'build on main', actor: PERSON, approvalNote: true }), ev('round', 7), ev('human', 8, { action: 'approve-spec', note: 'planted by another job', actor: PERSON })]),
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
    check: (a) => {
      const lines: string[] = a.brief.split('\n');
      assert.ok(lines.includes(`Inputs: ${[path.join(JOB_DIR, 'review', 'round-1', 'code.md'), path.join(JOB_DIR, 'tasks.md'), path.join(JOB_DIR, 'build.md')].join(', ')}`), a.brief);
    },
  },
  {
    name: 'B4 builder model is runtime.models.builder by default',
    fx: { files: ['spec', 'tasks'], job: job({ stage: 'build', round: 1, complexity: 'low' }), events: [ev('round', 4)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder', model: 'opus' },
    check: (a) => argvMatch(a.start, ['job', 'agent', 'j', 'start', '--model', 'opus'], 'start'),
  },
  {
    name: 'B4 builder model follows modelByComplexity',
    fx: { config: (c) => (c.runtime.modelByComplexity.low = 'sonnet'), files: ['spec', 'tasks'], job: job({ stage: 'build', round: 1, complexity: 'low' }), events: [ev('round', 4)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder', model: 'sonnet' },
    check: (a) => {
      argvMatch(a.start, ['job', 'agent', 'j', 'start', '--model', 'sonnet'], 'start');
      assert.ok(a.startShell.includes(' --model sonnet'));
    },
  },
  {
    name: 'B4 review-only rework uses reworkModel',
    fx: {
      config: (c) => ((c.runtime.reworkModel = 'haiku'), (c.runtime.modelByComplexity.low = 'sonnet')),
      files: ['spec', 'tasks', 'build'],
      present: [path.join(JOB_DIR, 'review', 'round-1', 'code.md')],
      job: job({ stage: 'build', round: 2, complexity: 'low', verdicts: { 1: { code: 'CHANGES', tests: 'PASS' } }, agents: { builder: ag(1, 5, 6, { agentId: 'b1' }) } }),
      events: [ev('round', 7)],
    },
    want: { action: 'spawn', rule: 'B4', role: 'builder', model: 'haiku' },
    check: (a) => {
      assert.ok(a.brief.split('\n').includes('Rework: review'));
      argvMatch(a.start, ['job', 'agent', 'j', 'start', '--model', 'haiku'], 'start');
      // With feedback as well, the rework is not review-only: modelByComplexity applies.
      const row = rows.find((r) => r.name === 'B4 review-only rework uses reworkModel')!;
      const mixed = step(fixture({ ...row.fx, files: ['spec', 'tasks', 'build', 'feedback'] })) as any;
      assert.equal(mixed.model, 'sonnet');
      assert.ok(mixed.brief.split('\n').includes('Rework: review, feedback'));
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
      argvMatch(a.start, ['job', 'agent', 'j', 'start', '--resume', 'b9'], 'start');
      assert.ok(!('resumeSkipped' in a));
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
    name: 'B4 a rework builder resumes its last session',
    fx: resumableBuilder(),
    want: { action: 'spawn', rule: 'B4', role: 'builder', resume: BUILDER_SID },
    check: (a) => {
      assert.ok(!('resumeSkipped' in a));
      argvMatch(a.start, ['job', 'agent', 'j', 'start', '--resume', BUILDER_SID], 'start');
      assert.ok(!a.start.includes('--resume-skipped'));
      // The brief is the normal rework brief: the same as a cold run's.
      const off = step(fixture(resumableBuilder({}, { config: (c) => (c.pipeline.resumeRework = false) }))) as any;
      assert.equal(off.resumeSkipped, 'off');
      assert.equal(a.brief, off.brief);
      // Exactly the ceiling still resumes.
      const atCeiling = step(fixture(resumableBuilder({}, { lastSessions: { builder: resumable(BUILDER_SID, 120_000) } }))) as any;
      assert.equal(atCeiling.resume, BUILDER_SID);
    },
  },
  {
    name: 'B4 a builder re-run after a failed verify in the same round resumes its last session',
    fx: { ...resumableBuilder(), job: job({ stage: 'build', round: 1, verifyRuns: [vr(1, 10, false)], agents: { builder: ag(1, 5, 6, { agentId: BUILDER_SID }) } }), events: [ev('round', 4), ev('agent-start', 5, { role: 'builder', model: 'opus' })] },
    want: { action: 'spawn', rule: 'B4', role: 'builder', resume: BUILDER_SID },
  },
  ...RESUME_SKIP_ROWS.map(([reason, fx]): Row => {
    const skipped = reason.replace(/ \(.*\)$/, '');
    return {
      name: `B4 rework resume skipped: ${reason}`,
      fx,
      want: { action: 'spawn', rule: 'B4', role: 'builder', resumeSkipped: skipped },
      check: (a) => {
        assert.ok(!('resume' in a));
        argvMatch(a.start, ['job', 'agent', 'j', 'start', '--resume-skipped', skipped], 'start');
        assert.ok(!a.start.includes('--resume'));
      },
    };
  }),
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
  // B8: RV11 sent a reviewed all-PASS round back for a commit after review; the new round verifies it with no builder.
  { name: 'B8 a re-review round verifies with no builder', fx: { job: atReReview(), events: reReview() }, want: { ...run('job', 'set', 'j', '--stage', 'verify', '--state', 'running'), rule: 'B8' } },
  { name: 'B4 a human rework after the re-review entry spawns the builder', fx: { job: atReReview(), events: reReview([ev('human', 31, { action: 'rework' })]) }, want: { action: 'spawn', rule: 'B4', role: 'builder' } },
  { name: 'B4 entered from review after a CHANGES round spawns the builder', fx: { job: atReReview({ verdicts: { 1: { code: 'CHANGES' } } }), events: reReview() }, want: { action: 'spawn', rule: 'B4', role: 'builder' } },
  {
    name: 'B2 a re-review round past maxRounds parks',
    fx: { job: atReReview({ round: 4, maxRounds: 3, verdicts: { 3: { code: 'PASS' } }, agents: { builder: ag(2, 5, 6) } }), events: reReview() },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'rounds-exhausted', '--reason', 'round 4 exceeds maxRounds 3'), rule: 'B2' },
  },

  // ---- Verify
  { name: 'V1 verifies the round', fx: { job: job({ stage: 'verify', round: 1, agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('verify', 'j'), shell: "forge verify j" } },
  { name: 'V1 re-verifies after the builder fixed it', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 4, false)], agents: { builder: ag(1, 5, 6) } }) }, want: run('verify', 'j') },
  { name: 'V2b a pass goes to review', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6) } }) }, want: run('job', 'set', 'j', '--stage', 'review', '--state', 'running') },
  { name: 'V3b a failure goes back to build', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, false)], agents: { builder: ag(1, 5, 6) } }) }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
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
      argvMatch(a.start, ['job', 'agent', 'j', 'start', '--role', 'verifier', '--model', 'haiku', '--output', VF_ANSWERS], 'start');
    },
  },
  {
    name: 'VF2b retries a verifier that ended without answers',
    fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10, { outputMissing: true }) } }), events: [VF_RUN] },
    want: { action: 'spawn', role: 'verifier', retry: true },
  },
  { name: 'VF3 records the answers', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10, { outputMissing: false }) } }), events: [VF_RUN] }, want: run('verifiers', 'record', 'j') },
  { name: 'VF3 records after the retry wrote nothing either', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10, { outputMissing: true, retry: true }) } }), events: [VF_RUN] }, want: run('verifiers', 'record', 'j') },
  { name: 'V2b after a verifiers pass', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10) } }), events: [VF_RUN, ev('verifiers', 11, { phase: 'record', round: 1, sha: 's', outcome: 'PASS', blocking: 0, warned: 1, results: [] })] }, want: run('job', 'set', 'j', '--stage', 'review', '--state', 'running') },
  { name: 'V3b after a verifiers failure', fx: { verifiers: 2, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true), VF_FAIL], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10) } }), events: [VF_RUN, ev('verifiers', 11, { phase: 'record', round: 1, sha: 's', outcome: 'CHANGES' })] }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
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
      argvMatch(a.start, ['job', 'agent', 'j', 'start', '--role', 'reviewer:code', '--model', 'sonnet', '--output', path.join(JOB_DIR, 'review', 'round-1', 'code.md')], 'start');
      assert.ok(a.brief.includes('Lens: code') && a.brief.includes(`Scope: ${path.join(JOB_DIR, 'scope.md')}`) && a.brief.includes('Checklist: '));
      const diff = path.join(JOB_DIR, 'review', 'round-1', 'diff.patch');
      assert.ok(a.brief.split('\n').includes(`Diff: ${diff} (stat, then the branch's diff from its merge base)`), a.brief);
      assert.ok(a.brief.includes(`"roundDiff":${JSON.stringify(diff)}`), a.brief);
    },
  },
  {
    name: 'RV4 a job with a reviewed member names the round diff for every repo',
    fx: { job: inReview({}, { repos: [{ repo: null, worktree: WT, branch: 'forge/j', base: 'main', pr: null, verifyOnly: false }, { repo: 'lib', worktree: '/lib.worktrees/j', branch: 'forge/j', base: 'main', pr: null, verifyOnly: false }] }), events: scoped },
    want: { action: 'spawn', role: 'reviewer:code' },
    check: (a) => {
      const lines = a.brief.split('\n');
      assert.ok(lines.includes(`Diff: ${path.join(JOB_DIR, 'review', 'round-1', 'diff.patch')} (every job repo; member paths are prefixed <repo>/)`), a.brief);
      assert.equal(lines.filter((l: string) => l.startsWith('Diff: ')).length, 1);
      assert.ok(!lines.some((l: string) => l.startsWith('Diff: ') && l.includes('scope.diff')), a.brief);
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
  {
    name: 'RV4 round 1 spawns the full panel under narrow',
    fx: { config: withDocsLens, job: inReview({}, { reviewers: R2_LENSES }), events: [ev('round', 4, { round: 1 }), ev('panel', 11, { round: 1, rerun: ['code'] }), ev('scope', 11, { round: 1 })] },
    want: { action: 'spawn', rule: 'RV4', role: 'reviewer:code' },
    check: (a) => {
      assert.deepEqual(a.spawns.map((s: any) => [s.rule, s.lens]), [['RV4', 'security'], ['RV4', 'docs']]);
      assert.ok(!('why' in a));
    },
  },
  {
    name: 'RV4 round 2 spawns the full panel under onRework full',
    fx: { config: (c) => (withDocsLens(c), (c.review.onRework = 'full')), job: inRework(), events: reworkScoped(['code', 'docs']) },
    want: { action: 'spawn', rule: 'RV4', role: 'reviewer:code' },
    check: (a) => assert.deepEqual(a.spawns.map((s: any) => s.lens), ['security', 'docs']),
  },
  {
    name: 'RV10 spawns only the rework panel',
    fx: { config: withDocsLens, job: inRework(), events: reworkScoped(['code', 'docs']) },
    want: { action: 'spawn', rule: 'RV10', role: 'reviewer:code', why: 'rework round: re-review the lenses that asked for changes, the always lenses and the lenses whose paths the fix touched' },
    check: (a) => {
      assert.deepEqual(a.spawns.map((s: any) => [s.rule, s.lens]), [['RV10', 'docs']]);
      const later = step(fixture({ config: withDocsLens, job: inRework({ 'reviewer:code': ag(2, 32), 'reviewer:docs': ag(2, 32) }), events: reworkScoped(['code', 'docs']) }));
      assert.equal(later.action, 'wait', 'security is never spawned');
    },
  },
  {
    name: 'RV10 each re-run lens resumes its own last session',
    fx: {
      config: withDocsLens,
      job: inRework({ 'reviewer:code': ag(1, 12, 13, { agentId: CODE_SID, model: 'sonnet' }), 'reviewer:docs': ag(1, 12, 13, { agentId: DOCS_SID, model: 'sonnet' }) }),
      events: reworkScoped(['code', 'docs']),
      lastSessions: { 'reviewer:code': resumable(CODE_SID), 'reviewer:docs': resumable(DOCS_SID) },
    },
    want: { action: 'spawn', rule: 'RV10', role: 'reviewer:code', resume: CODE_SID },
    check: (a) => {
      argvMatch(a.start, ['job', 'agent', 'j', 'start', '--role', 'reviewer:code', '--resume', CODE_SID], 'start');
      assert.deepEqual(a.spawns.map((s: any) => [s.lens, s.resume, s.resumeSkipped]), [['docs', DOCS_SID, undefined]]);
      argvMatch(a.spawns[0].start, ['job', 'agent', 'j', 'start', '--role', 'reviewer:docs', '--resume', DOCS_SID], 'docs start');
    },
  },
  {
    name: 'RV4 under onRework full resumes each lens',
    fx: {
      config: (c) => (withDocsLens(c), (c.review.onRework = 'full')),
      job: inRework({
        'reviewer:code': ag(1, 12, 13, { agentId: CODE_SID, model: 'sonnet' }),
        'reviewer:security': ag(1, 12, 13, { agentId: SEC_SID }),
        'reviewer:docs': ag(1, 12, 13, { agentId: DOCS_SID, model: 'sonnet' }),
      }),
      events: reworkScoped(['code', 'docs']),
      // docs ran, but no runner sidecar names its session: it carries its own reason.
      lastSessions: { 'reviewer:code': resumable(CODE_SID), 'reviewer:security': resumable(SEC_SID) },
    },
    want: { action: 'spawn', rule: 'RV4', role: 'reviewer:code', resume: CODE_SID },
    check: (a) => {
      assert.ok(!('resumeSkipped' in a));
      assert.deepEqual(a.spawns.map((s: any) => [s.lens, s.resume, s.resumeSkipped]), [['security', SEC_SID, undefined], ['docs', undefined, 'no session']]);
      argvMatch(a.spawns[1].start, ['job', 'agent', 'j', 'start', '--role', 'reviewer:docs', '--resume-skipped', 'no session'], 'docs start');
    },
  },
  {
    name: 'RV10 a lens back after a narrow skip resumes its own last run',
    fx: {
      config: withDocsLens,
      job: job({
        stage: 'review',
        round: 3,
        reviewers: R2_LENSES,
        verifyRuns: [vr(1, 10, true), vr(2, 30, true), vr(3, 50, true)],
        verdicts: { 1: { code: 'PASS', security: 'PASS', docs: 'CHANGES' }, 2: { code: 'CHANGES' } },
        // docs last reviewed in round 1 (round 2's narrow panel skipped it); code reviewed round 2.
        agents: { builder: ag(3, 45, 49), 'reviewer:code': ag(2, 32, 33, { agentId: CODE2_SID, model: 'sonnet' }), 'reviewer:docs': ag(1, 12, 13, { agentId: DOCS_SID, model: 'sonnet' }) },
      }),
      events: [ev('round', 40, { round: 3 }), ev('panel', 51, { round: 3, lenses: R2_LENSES, rerun: ['code', 'docs'] }), ev('scope', 51, { round: 3 })],
      lastSessions: { 'reviewer:code': resumable(CODE2_SID), 'reviewer:docs': resumable(DOCS_SID) },
    },
    want: { action: 'spawn', rule: 'RV10', role: 'reviewer:code', resume: CODE2_SID },
    check: (a) => assert.deepEqual(a.spawns.map((s: any) => [s.lens, s.resume]), [['docs', DOCS_SID]]),
  },
  {
    // The spec called this row "RV10 records…", but RV6 decides it; the harness checks the prefix.
    name: 'RV6 records verdicts for the rework panel',
    fx: {
      config: withDocsLens,
      job: inRework({ 'reviewer:code': ag(2, 32, 33, { outputMissing: false }), 'reviewer:docs': ag(2, 32, 33, { outputMissing: false }) }),
      events: reworkScoped(['code', 'docs']),
      verdicts: { round: verdicts({ code: 'PASS', docs: 'PASS' }) },
    },
    want: run('job', 'verdicts', 'j', '--reviewers', 'code,docs'),
  },
  { name: 'RV4 ignores a rerun outside the panel', fx: { config: withDocsLens, job: inRework(), events: reworkScoped(['code', 'ui']) }, want: { action: 'spawn', rule: 'RV4', role: 'reviewer:code' }, check: (a) => assert.deepEqual(a.spawns.map((s: any) => s.lens), ['security', 'docs']) },
  { name: 'RV4 ignores an empty rerun', fx: { config: withDocsLens, job: inRework(), events: reworkScoped([]) }, want: { action: 'spawn', rule: 'RV4', role: 'reviewer:code' }, check: (a) => assert.deepEqual(a.spawns.map((s: any) => s.lens), ['security', 'docs']) },
  {
    name: 'RV4 ignores a rerun older than the last verify',
    // A reviewer already started, so RV9 doesn't re-panel; the stale event's rerun must not narrow the round.
    fx: { config: withDocsLens, job: inRework({ 'reviewer:code': ag(2, 32) }), events: reworkScoped(['code', 'docs'], 28) },
    want: { action: 'spawn', rule: 'RV4', role: 'reviewer:security' },
    check: (a) => assert.deepEqual(a.spawns.map((s: any) => s.lens), ['docs']),
  },
  { name: 'RV4 a panel model wins', fx: { job: inReview({}, { reviewers: ['security'] }), events: scoped }, want: { action: 'spawn', role: 'reviewer:security', model: 'opus' } },
  { name: 'RV4 a UI lens gets the dev server', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:code': ag(1, 12, 13) }, { reviewers: ['code', 'ui'] }), events: scoped, runtime: ['dev'] }, want: { action: 'spawn', role: 'reviewer:ui' }, check: (a) => assert.ok(a.brief.includes('Endpoints: dev http://localhost:4100')) },
  { name: 'RV4 the design lens gets the dev server', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:code': ag(1, 12, 13) }, { reviewers: ['code', 'design'] }), events: scoped, runtime: ['dev'] }, want: { action: 'spawn', role: 'reviewer:design' }, check: (a) => assert.ok(a.brief.includes('Endpoints: dev http://localhost:4100')) },
  { name: 'RV4 a needsApp false lens gets no dev server', fx: { config: (c) => { c.commands.dev = 'npm run dev'; c.review.panel.push({ name: 'ui', needsApp: false }); }, job: inReview({ 'reviewer:code': ag(1, 12, 13) }, { reviewers: ['code', 'ui'] }), events: scoped }, want: { action: 'spawn', role: 'reviewer:ui' }, check: (a) => assert.ok(!a.brief.includes('Endpoints:')) },
  { name: 'G5 waits once every lens has started', fx: { job: inReview({ 'reviewer:code': ag(1, 12), 'reviewer:tests': ag(1, 12, 13) }), events: scoped }, want: { action: 'wait', waitingOn: 'agents', running: ['reviewer:code'] } },
  {
    name: 'RV5 a malformed review gets one retry',
    fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped, verdicts: { round: verdicts({ code: 'MALFORMED', tests: 'PASS' }) } },
    want: { action: 'spawn', role: 'reviewer:code', retry: true },
    check: (a) => assert.ok(a.brief.includes(`Retry: ${path.join(JOB_DIR, 'review', 'round-1', 'code.md')} has no VERDICT line; rewrite it in the required format.`)),
  },
  { name: 'RV5b malformed twice counts as CHANGES', fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false, retry: true }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped, verdicts: { round: verdicts({ code: 'MALFORMED', tests: 'PASS' }) } }, want: run('job', 'verdicts', 'j', '--malformed', 'changes') },
  { name: 'RV6 records the verdicts', fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }), events: scoped, verdicts: { round: verdicts({ code: 'PASS', tests: 'CHANGES' }) } }, want: run('job', 'verdicts', 'j') },
  { name: 'RV7 stops the dev server once verdicts are in', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: scoped, runtime: ['dev'] }, want: run('stop', 'j') },
  { name: 'RV7 stops a UI review\'s dev server', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:ui': ag(1, 12, 13) }, { reviewers: ['ui'], verdicts: { 1: { ui: 'PASS' } } }), events: scoped, runtime: ['dev'] }, want: run('stop', 'j') },
  { name: 'RV8c a UI lens with the dev server stopped moves on, never restarting it', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:code': ag(1, 12, 13), 'reviewer:ui': ag(1, 12, 13) }, { reviewers: ['code', 'ui'], verdicts: { 1: { code: 'PASS', ui: 'PASS' } } }), events: scoped, runtime: [] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'RV3 a UI retry before the verdicts gets the app again', fx: { config: (c) => (c.commands.dev = 'npm run dev'), job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:ui': ag(1, 12, 13, { outputMissing: true }) }, { reviewers: ['code', 'ui'] }), events: scoped, runtime: [] }, want: run('run', 'j', 'dev', '--background') },
  { name: 'RV8c every lens passed: integrate', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  // RV11: DC11 or PR12 sent a recorded round back for a commit after review; build opens the next round.
  {
    name: 'RV11 a reviewed round sent back from decide goes to build',
    fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: [...scoped, reviewed, tr(27, { stage: 'integrate' }, { stage: 'decide' }), tr(30, { stage: 'decide' }, { stage: 'review' })] },
    want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'RV11' },
  },
  {
    name: 'RV11 a reviewed round sent back from pr goes to build, ahead of RV1 under onPrFeedback none',
    fx: { config: (c) => (c.review.onPrFeedback = 'none'), job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } }, pr: OPEN_PR }), events: [...scoped, tr(30, { stage: 'pr' }, { stage: 'review' })] },
    want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'RV11' },
  },
  {
    name: 'RV8c entered from verify, every lens passed: integrate',
    fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: [ev('round', 4, { round: 1 }), tr(10, { stage: 'verify' }, { stage: 'review' }), panelled, ev('scope', 11, { round: 1 })] },
    want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'RV8c' },
  },
  { name: 'RV8b an eval job goes to decide', fx: { job: inReview({}, { kind: 'eval', eval: { run: 'r', task: 'hello' }, verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'decide', '--state', 'running') },
  { name: 'RV8d a lens asked for changes: build', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'CHANGES' } } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
  { name: 'RV8 a PR rework that passed goes to pr', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } }, pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },

  // ---- PR rework under onPrFeedback
  { name: 'PR rework full: the whole panel reviews', fx: { config: (c) => (c.review.onPrFeedback = 'full'), job: inReview({ 'reviewer:code': ag(1, 12), 'reviewer:tests': ag(1, 12) }, { reviewers: ['code', 'tests', 'security'], pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }), events: scoped }, want: { action: 'spawn', role: 'reviewer:security' } },
  {
    name: 'PR rework changed: only the always lenses, recorded with --reviewers',
    fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false }) }, { reviewers: ['code', 'tests', 'security'], pr: { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: t(0) } }), events: scoped, verdicts: { round: verdicts({ code: 'PASS', tests: 'PASS' }) } },
    want: run('job', 'verdicts', 'j', '--reviewers', 'code,tests'),
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
  {
    name: 'DC1 an approver mapped to [] gets no instruction files and no Instructions: line',
    fx: { ...ROLE_INSTRUCTIONS, job: job({ stage: 'decide', round: 1 }) },
    want: { action: 'spawn', rule: 'DC1', role: 'approver' },
    check: (a) => assert.deepEqual(briefInstructions(a.brief), { files: [], line: false }),
  },
  { name: 'DC1 no integration review, no input line for it', fx: { job: job({ stage: 'decide', round: 1 }), files: ['spec'] }, want: { action: 'spawn', role: 'approver' }, check: (a) => assert.ok(!a.brief.split('\n').find((l: string) => l.startsWith('Inputs: '))!.includes(path.join('review', 'integration', 'code.md')), a.brief) },
  { name: 'DC2 records the decision', fx: { job: atDecide(), decision: { decision: 'APPROVE' } }, want: run('job', 'decision', 'j') },
  { name: 'DC3 a decision.md without a decision line escalates', fx: { job: atDecide() }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'decision.md has no APPROVE/ESCALATE line') },
  { name: 'DC4 eval mode: the judge scores a rubric task', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' } }), decision: { decision: 'ESCALATE' }, events: [ev('decision', 22)], evalTask: { rubric: 'rubric.md', reference: null } }, want: { action: 'spawn', role: 'judge', output: path.join(JOB_DIR, 'eval-judge.md') }, check: (a) => assert.ok(a.brief.includes(`Eval task: ${path.join('/repo', '.forge', 'evals', 'hello')}`)) },
  { name: 'DC5 eval mode: grade once judged', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' }, agents: { approver: ag(1, 20, 21), judge: ag(1, 23, 24) } }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], evalTask: { rubric: 'rubric.md', reference: null } }, want: run('eval', 'grade', 'j') },
  { name: 'DC5 eval mode: no rubric, no judge', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' } }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], evalTask: { rubric: null, reference: null } }, want: run('eval', 'grade', 'j') },
  { name: 'DC4 a rounds-exhausted eval skips the approver and spawns the judge', fx: { job: job({ kind: 'eval', eval: { run: 'r', task: 'hello' }, stage: 'decide', round: 4, maxRounds: 3, verdicts: { 3: { code: 'CHANGES' } } }), evalTask: { rubric: 'rubric.md', reference: null } }, want: { action: 'spawn', rule: 'DC4', role: 'judge' } },
  { name: 'DC5 a rounds-exhausted eval with no rubric grades without an approver', fx: { job: job({ kind: 'eval', eval: { run: 'r', task: 'hello' }, stage: 'decide', round: 4, maxRounds: 3, verdicts: { 3: { code: 'CHANGES' } } }), evalTask: { rubric: null, reference: null } }, want: { ...run('eval', 'grade', 'j'), rule: 'DC5' } },
  { name: 'DC1 an eval job within maxRounds still spawns the approver', fx: { job: job({ kind: 'eval', eval: { run: 'r', task: 'hello' }, stage: 'decide', round: 3, maxRounds: 3, verdicts: { 3: { code: 'PASS' } } }), evalTask: { rubric: 'rubric.md', reference: null } }, want: { action: 'spawn', rule: 'DC1', role: 'approver' } },
  { name: 'DC6 eval mode: graded is done', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' } }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ev('eval-graded', 23)] }, want: run('job', 'set', 'j', '--stage', 'done', '--state', 'done') },
  { name: 'DC9b an ESCALATE no longer parks in decide: it goes on to integrate', fx: { job: atDecide(), decision: { decision: 'ESCALATE' }, events: [ev('decision', 22)] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'DC9b a runbook gate reason does not park in decide', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], gate: [R_RUNBOOK] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'DC9b approved: integrate', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'DC9 approved on an integrated branch: pr', fx: { job: decidedLate(), decision: { decision: 'APPROVE' }, events: [reviewed, ev('integrated', 31, { behind: 0 }), tr(33, { stage: 'integrate' }, { stage: 'decide' }), ev('decision', 36)] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  { name: 'DC9b a legacy job with no integration since review integrates', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [tr(15, { stage: 'review' }, { stage: 'decide' }), ev('decision', 22)] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'DC9b an integration from an earlier round does not count', fx: { job: decidedLate({ round: 2, agents: { approver: ag(2, 34, 35) } }), decision: { decision: 'APPROVE' }, events: [tr(5, { stage: 'integrate' }, { stage: 'decide' }), tr(15, { stage: 'review' }, { stage: 'decide' }), ev('decision', 36)] }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  {
    name: 'DC9b a wait in the same millisecond as leaving integrate still counts',
    fx: {
      job: decidedLate(),
      decision: { decision: 'APPROVE' },
      events: [reviewed, ev('integrated', 31, { behind: 0 }), tr(33, { stage: 'integrate' }, { stage: 'decide' }), tr(33, { stage: 'decide' }, { stage: 'decide', state: 'waiting', waitingOn: 'budget' }), ev('human', 40, { action: 'approve' }), tr(41, { stage: 'decide', state: 'waiting', waitingOn: 'budget' }, { stage: 'decide' }), ev('decision', 42, { decision: 'APPROVE' })],
    },
    want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'),
  },
  { name: 'DC9b an escalation parked in decide before the move goes on to integrate when the job runs again', fx: { job: decidedLate(), decision: { decision: 'ESCALATE' }, events: escalated.slice(0, 5) }, want: { rule: 'DC9b' } },
  { name: 'DC9b approved after an escalation wait re-integrates', fx: { job: decidedLate(), decision: { decision: 'ESCALATE' }, events: unparked }, want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'DC9b' } },
  { name: 'cleared gate: a human-cleared escalation (the old DC7 park) re-entering decide goes on to DC9', fx: { job: decidedLate(), decision: { decision: 'ESCALATE' }, events: sentBack }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'DC9' } },
  { name: 'cleared gate: a human-cleared runbook (the old DC8 park) re-entering decide goes on to DC9', fx: { job: decidedLate(), decision: { decision: 'APPROVE' }, events: runbookSentBack, gate: [R_RUNBOOK] }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'DC9' } },
  { name: 'PR15 a budget acknowledgement after an ESCALATE does not clear it', fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED, ...approvedAt(32, 'pr', 'budget', 'job budget: 1000 tokens')] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('approver')) },
  // AC13: an approve clears only the rules its park listed, given after the review.
  { name: 'PR15 a budget approve clears nothing', fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_RUNBOOK]), synced(31, 'PR15', ESC('runbook')), ...approvedAt(32, 'pr', 'budget', 'job budget: 1000 tokens')] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('runbook')), rule: 'PR15' } },
  { name: 'PR15 an approve at a park whose reason does not list the rule clears nothing', fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_RUNBOOK]), synced(31, 'PR15', ESC('runbook')), ...approvedAt(32, 'pr', 'escalation', ESC('approver'))] }, want: { rule: 'PR15' } },
  {
    name: 'PR15 an approve before the latest review leaves the runbook open',
    fx: { job: atGate({ pr: null }), decision: { decision: 'APPROVE' }, events: [...approvedAt(10, 'pr', 'escalation', ESC('runbook')), tr(15, { stage: 'review' }, { stage: 'integrate' }), decided('APPROVE', true, 22), GATE(23, [R_RUNBOOK]), OPENED] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('runbook')), rule: 'PR15' },
  },
  { name: 'DC3 a budget acknowledgement does not clear a missing decision line', fx: { job: decidedLate(), events: budgetAck('APPROVE').slice(0, -1) }, want: { rule: 'DC3' } },
  { name: 'cleared gate: DC3 a human-cleared missing decision line goes on to DC9', fx: { job: decidedLate(), events: sentBack }, want: { rule: 'DC9' } },
  { name: 'DC10 an open PR in decide goes to pr', fx: { job: job({ stage: 'decide', round: 1, pr: OPEN_PR }) }, want: { ...run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'), rule: 'DC10' } },
  // DC11: HEAD no longer follows the head the round's review was given (reviewCurrent false).
  { name: 'DC11 a commit after review goes back to review', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], reviewCurrent: false }, want: { ...BACK_TO_REVIEW, rule: 'DC11' } },
  { name: 'DC11 wins over DC10 with an open PR and no auto-merge', fx: { job: job({ stage: 'decide', round: 1, pr: OPEN_PR }), reviewCurrent: false }, want: { ...BACK_TO_REVIEW, rule: 'DC11' } },
  { name: 'DC11 wins over DC1 before the approver starts', fx: { job: freshDecide(), files: ['spec'], reviewCurrent: false }, want: { ...BACK_TO_REVIEW, rule: 'DC11' } },
  { name: 'DC9b a round with no recorded review still integrates (reviewCurrent null)', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], reviewCurrent: null }, want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'DC9b' } },
  { name: 'DC9b a HEAD that follows the reviewed head integrates (reviewCurrent true)', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], reviewCurrent: true }, want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'DC9b' } },
  { name: 'DC1 under auto-merge a PR rework goes back to the approver', fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'decide', round: 2, pr: OPEN_PR }), files: ['spec'] }, want: { action: 'spawn', rule: 'DC1', role: 'approver' } },
  // ---- DC12: the gate reasons, once per review, before anything decides (AC5)
  { name: 'DC12 a job entering decide after a review with no gate event since computes one', fx: { job: freshDecide(), files: ['spec'], events: [tr(15, { stage: 'review' }, { stage: 'decide' })], gate: null }, want: { ...run('job', 'gate', 'j'), rule: 'DC12' } },
  { name: 'DC12 a gate event before the latest review does not count', fx: { job: freshDecide(), files: ['spec'], events: [ev('gate', 10, { round: 1, head: null, reasons: [] }), tr(15, { stage: 'review' }, { stage: 'decide' })] }, want: { rule: 'DC12' } },
  { name: 'DC12 runs before RC1', fx: { job: freshDecide(), recall: { changed: ['agents/x.md'] }, gate: null }, want: { rule: 'DC12' } },
  { name: 'DC12 runs before DC10', fx: { job: job({ stage: 'decide', round: 1, pr: OPEN_PR }), gate: null }, want: { rule: 'DC12' } },
  { name: 'DC1 with a gate event after the review, the approver spawns', fx: { job: freshDecide(), files: ['spec'], events: [tr(15, { stage: 'review' }, { stage: 'decide' }), ev('gate', 16, { round: 1, head: null, reasons: [{ rule: 'runbook', detail: 'x' }] })] }, want: { action: 'spawn', rule: 'DC1', role: 'approver' } },
  ...(
    [
      ['the gate event since the review', [tr(15, { stage: 'review' }, { stage: 'decide' }), ev('gate', 16, { round: 1, head: null, reasons: [{ rule: 'version', detail: 'version changed in 1 manifest', paths: ['package.json'] }] })], 'Gate reasons (JSON): [{"rule":"version","detail":"version changed in 1 manifest","paths":["package.json"]}]'],
      ['an empty gate event', [tr(15, { stage: 'review' }, { stage: 'decide' }), ev('gate', 16, { round: 1, head: null, reasons: [] })], 'Gate reasons: none'],
    ] as const
  ).map(([what, events, line]) => ({
    name: `DC1 brief: the approver's Gate reasons line from ${what}`,
    fx: { job: freshDecide(), files: ['spec'] as FixtureOpts['files'], events: [...events] },
    want: { action: 'spawn', rule: 'DC1', role: 'approver' },
    check: (a: any) => assert.ok(a.brief.split('\n').some((l: string) => l.startsWith(line)), a.brief),
  })),
  { name: 'DC4 an exhausted eval skips DC12', fx: { job: job({ kind: 'eval', eval: { run: 'r', task: 'hello' }, stage: 'decide', round: 4, maxRounds: 3, verdicts: { 3: { code: 'CHANGES' } } }), evalTask: { rubric: 'rubric.md', reference: null }, gate: null }, want: { rule: 'DC4' } },
  { name: 'DC12 an eval within its rounds computes the gate too', fx: { job: job({ kind: 'eval', eval: { run: 'r', task: 'hello' }, stage: 'decide', round: 3, maxRounds: 3 }), gate: null }, want: { rule: 'DC12' } },
  // AC7: a decision recorded eligible before the gate counted (or under a gate reason) never reaches PR4.
  { name: 'PR5 an eligible decision under gate reasons never reaches PR4', fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [APPROVED, ev('pr-opened', 11), ev('gate', 12, { round: 1, head: null, reasons: [{ rule: 'acs', detail: 'unmapped: AC2' }] }), ...approvedAt(13, 'pr', 'escalation', 'escalation: acs')] }, want: { rule: 'PR5' } },
  // ---- Recall eval before the approver (RC1; the old RC2 park is PR17 now)
  { name: 'RC1 a diff touching agents/ runs the recall procedure', fx: { job: freshDecide(), recall: { changed: ['agents/x.md'] } }, want: { action: 'procedure', rule: 'RC1', reference: RECALL_MD } },
  { name: 'RC1 a diff touching reviewers/code.md runs it', fx: { job: freshDecide(), recall: { changed: ['lib/x.ts', 'reviewers/code.md'] } }, want: { action: 'procedure', reference: RECALL_MD } },
  { name: 'RC1 a diff touching lib/engine/pipeline/brief.ts runs it', fx: { job: freshDecide(), recall: { changed: ['lib/engine/pipeline/brief.ts'] } }, want: { action: 'procedure', reference: RECALL_MD } },
  { name: 'RC1 one start for these prompts runs it again', fx: { job: freshDecide(), recall: { changed: ['agents/x.md'] }, events: [recallStart(30)] }, want: { action: 'procedure' } },
  { name: 'RC1 a record for another hash', fx: { job: freshDecide(), recall: { changed: ['agents/x.md'] }, events: [recallStart(30, 'ffffffffff'), recallRecord(31, 'ffffffffff')] }, want: { action: 'procedure' } },
  {
    name: 'DC1 after a recall record for this hash',
    fx: { job: freshDecide(), recall: { changed: ['agents/x.md'] }, events: [recallStart(30), recallRecord(31)] },
    want: { action: 'spawn', role: 'approver' },
    check: (a) => {
      const line = a.brief.split('\n').find((l: string) => l.startsWith('Reviewer recall: '));
      assert.equal(line, `Reviewer recall: ${JSON.stringify({ run: '20261020-101010-j', head: 'a'.repeat(12), byLens: { code: { recall: 0.5, precision: 1 } }, base: { run: '20261019-000000', head: 'b'.repeat(12), byLens: { code: { recall: 1, precision: 1 } } } })}`);
    },
  },
  { name: 'DC1 two recall starts with no record: the approver runs, and PR17 holds the merge', fx: { job: freshDecide(), recall: { changed: ['agents/x.md'] }, events: [recallStart(30), recallStart(31)] }, want: { action: 'spawn', rule: 'DC1', role: 'approver' } },
  {
    name: 'DC1 a human approve at the old RC2 park waives the recall eval',
    fx: { job: freshDecide(), recall: { changed: ['agents/x.md'] }, events: recallWaiver() },
    want: { action: 'spawn', role: 'approver' },
    check: (a) => assert.ok(a.brief.split('\n').includes('Reviewer recall: waived by a human'), a.brief),
  },
  // PR17: in pr after the push, the diff's reviewer prompts still have no recorded recall eval.
  { name: 'PR14 no recall record for the prompts: the PR is told first', fx: { job: atGate(), recall: { changed: ['agents/x.md'] }, events: [recallStart(10), recallStart(11), OPENED] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR14' } },
  { name: 'PR17 no recall record for the prompts parks on a human after the push', fx: { job: atGate(), recall: { changed: ['agents/x.md'] }, events: [recallStart(10), recallStart(11), OPENED, synced(32, 'PR17', RECALL_REASON)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', RECALL_REASON), rule: 'PR17' } },
  { name: 'PR5 a person\'s approve at the PR17 park waives the recall eval', fx: { job: atGate(), recall: { changed: ['agents/x.md'] }, events: [OPENED, ...recallWaiver(RECALL_REASON, {}, 'pr')] }, want: { rule: 'PR5' } },
  { name: 'PR5 a person\'s approve at the old decide-stage RC2 park still waives it', fx: { job: atGate(), recall: { changed: ['agents/x.md'] }, events: [...recallWaiver(), OPENED] }, want: { rule: 'PR5' } },
  { name: "PR17 the foreman's approve does not waive it", fx: { job: atGate(), recall: { changed: ['agents/x.md'] }, events: [OPENED, synced(31, 'PR17', RECALL_REASON), ...recallWaiver(RECALL_REASON, { actor: FOREMAN }, 'pr')] }, want: { rule: 'PR17' } },
  { name: 'PR17 an approve at a park naming other prompts does not waive these', fx: { job: atGate(), recall: { changed: ['agents/x.md'] }, events: [OPENED, synced(31, 'PR17', RECALL_REASON), ...recallWaiver('recall eval: no recorded run for prompts ffffffffff', {}, 'pr')] }, want: { rule: 'PR17' } },
  { name: 'PR17 a git failure fails closed', fx: { job: atGate({ pr: null }), recall: { changed: null }, events: [OPENED] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'recall eval: no recorded run for prompts unknown'), rule: 'PR17' } },
  // `start` exits before it logs on a fixture that does not load, so no start could ever be recorded.
  { name: 'PR17 fixtures that do not load park on a human after the push', fx: { job: atGate({ pr: null }), recall: { changed: ['agents/x.md'], invalid: true }, events: [OPENED] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', RECALL_REASON), rule: 'PR17' } },
  { name: 'PR4 a recall record for the prompts lets an eligible PR merge', fx: { config: (c) => (c.merge.auto = true), job: atGate(), decision: { decision: 'APPROVE' }, recall: { changed: ['agents/x.md'] }, events: [recallStart(10), recallRecord(11), ...gateEvents('APPROVE')] }, want: { rule: 'PR4' } },
  { name: 'DC1 fixtures that do not load no longer park in decide', fx: { job: freshDecide(), recall: { changed: ['agents/x.md'], invalid: true } }, want: { action: 'spawn', rule: 'DC1', role: 'approver' } },
  { name: 'DC1 a human approve at the old RC2 park waives it with fixtures that do not load', fx: { job: freshDecide(), recall: { changed: ['agents/x.md'], invalid: true }, events: recallWaiver().slice(2) }, want: { action: 'spawn', role: 'approver' } },
  {
    name: 'DC1 brief: a diff with no reviewer prompts says none',
    fx: { job: freshDecide(), recall: { changed: ['lib/step/order.ts'] } },
    want: { action: 'spawn', role: 'approver' },
    check: (a) => assert.ok(a.brief.split('\n').includes('Reviewer recall: none (the diff changes no reviewer prompts)'), a.brief),
  },
  {
    name: 'DC1 brief: no recall fixtures says not checked',
    fx: { job: freshDecide() },
    want: { action: 'spawn', role: 'approver' },
    check: (a) => assert.ok(a.brief.split('\n').includes('Reviewer recall: not checked (no recall fixtures in the main checkout)'), a.brief),
  },
  { name: 'DC5 an eval job with a PR record still grades, never DC10', fx: { job: atDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' }, pr: OPEN_PR }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)], evalTask: { rubric: null, reference: null } }, want: { rule: 'DC5' } },

  // ---- Integrate
  { name: 'IG1 integrates the base', fx: { job: atIntegrate(), events: [entered] }, want: run('integrate', 'j') },
  { name: 'IG1 without an entry transition anchors on the decision, ignoring an older integration', fx: { job: atIntegrate(), events: [ev('integrated', 5, { behind: 0 }), ev('decision', 22)] }, want: run('integrate', 'j') },
  { name: 'IG2 re-verifies new commits', fx: { job: atIntegrate(), events: [entered, ev('integrated', 31, { behind: 2, strategy: 'rebase' })] }, want: run('verify', 'j') },
  { name: 'IG2b a failing verify after integrating goes to build', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 32, false)] }), events: [entered, ev('integrated', 31, { behind: 2 })] }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
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
  // Log order, not timestamps (AC13): each of these went the other way when compared by ts.
  { name: 'IG3 an integrated event stamped before the stage entry still counts', fx: { job: atIntegrate(), events: [ev('decision', 22), entered, ev('integrated', 29, { behind: 0 })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  {
    name: 'IG3 an approve decision in the same millisecond as leaving review goes to pr',
    fx: { job: atIntegrate(), events: [tr(15, { stage: 'review' }, { stage: 'decide' }), ev('decision', 15, { decision: 'APPROVE' }), entered, ev('integrated', 31, { behind: 0 })] },
    want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running'),
  },
  { name: 'IG4 conflicts under ask wait on a human', fx: { job: atIntegrate(), events: [entered, conflicts] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'conflicts', '--reason', 'conflicts with base: 2 files') },
  { name: 'G4b conflicts tell', fx: { job: atIntegrate({ state: 'waiting', waitingOn: 'conflicts' }) }, want: { action: 'wait', tell: 'j conflicts with main. /forge approve j to have the integrator fix them' } },
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
  { name: 'IG7b a failing verify after the resolution escalates', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, false)], agents: { integrator: ag(1, 33, 36) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'integration: verify failed after conflict resolution') },
  {
    name: 'IG8 spawns the integration reviewer',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 12, 13) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })] },
    want: { action: 'spawn', role: 'reviewer:code', output: path.join(JOB_DIR, 'review', 'integration', 'code.md') },
    check: (a) => {
      assert.equal(a.parallel, undefined);
      assert.ok(a.brief.includes('Integration review: conflicted files ["a.ts","`x`"]'));
      assert.ok(a.brief.includes("Diff: use the Before/Merge shas in build.md's ## Integration block, as in "));
      assert.ok(!a.brief.split('\n').some((l: string) => l.startsWith('Diff: ') && l.includes('diff.patch')), a.brief);
    },
  },
  { name: 'IG9 records the integration review', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })], verdicts: { integration: verdicts({ code: 'PASS' }) } }, want: run('job', 'verdicts', 'j', '--round', 'integration') },
  { name: 'IG12 a malformed integration review gets one retry', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })], verdicts: { integration: verdicts({ code: 'MALFORMED' }) } }, want: { action: 'spawn', role: 'reviewer:code', retry: true } },
  { name: 'IG10 a passing integration review after a decision goes to pr', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [ev('decision', 22), entered, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'PASS' })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  { name: 'IG10 a passing integration review before a decision goes to decide', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [reviewed, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'PASS' })] }, want: run('job', 'set', 'j', '--stage', 'decide', '--state', 'running') },
  { name: 'IG10 an ask approval inside the episode still goes to decide', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [reviewed, conflicts, ev('human', 32, { action: 'approve' }), ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'PASS' })] }, want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running'), rule: 'IG10' } },
  { name: 'IG10 a passing integration review on an open PR goes to pr', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ pr: OPEN_PR, verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [...routed, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'PASS' })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'running') },
  {
    name: 'IG10b CHANGES once: the integrator fixes it',
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
  { name: 'IG10c CHANGES after two integrator runs escalates', fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 46, true)], agents: { integrator: ag(1, 41, 45), 'reviewer:code': ag(1, 47, 48, { outputMissing: false }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'CHANGES' }), ev('agent-start', 41, { role: 'integrator' }), ev('integration-review', 49, { outcome: 'CHANGES' })] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'integration review: CHANGES') },

  // ---- PR
  { name: 'PR1 pr.enabled false finishes on the branch', fx: { config: (c) => (c.pr.enabled = false), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }) }, want: { ...run('job', 'set', 'j', '--stage', 'done', '--state', 'done'), tell: 'j finished on branch forge/j' } },
  { name: 'PR2 an unverified HEAD is verified first', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, false)] }) }, want: run('verify', 'j') },
  { name: "PR2 a pass from an earlier round does not verify this round's HEAD", fx: { job: job({ stage: 'pr', round: 2, verifyRuns: [vr(1, 10, true)] }) }, want: { ...run('verify', 'j'), rule: 'PR2' } },
  { name: 'PR2b a PR branch merged in after verify is verified again', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('pr-head-pulled', 12, { pulled: 'fast-forward', head: 'a'.repeat(40) })] }, want: run('verify', 'j') },
  { name: 'PR3 a pull the last verify already covered opens the PR', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 14, true)] }), events: [ev('pr-head-pulled', 12, { pulled: 'merge', head: 'a'.repeat(40) })] }, want: run('pr', 'open', 'j') },
  {
    name: 'PR11 a conflicting pull after the last verify parks on human',
    fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('pr-head-pulled', 12, { pulled: 'conflicts', head: 'a'.repeat(40) })] },
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'the PR branch moved on the remote and conflicts with the job HEAD: a human merges it in the worktree, then runs forge verify j'),
  },
  { name: 'PR3 a conflicting pull the last verify covered opens the PR', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 14, true)] }), events: [ev('pr-head-pulled', 12, { pulled: 'conflicts', head: 'a'.repeat(40) })] }, want: run('pr', 'open', 'j') },
  { name: 'PR3 opens the PR', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }) }, want: run('pr', 'open', 'j') },

  // ---- The held push (PR13): pr open refused, step parks on its reason (AC7)
  { name: 'PR13 a held push parks on a human with its reason', fx: { job: atGate({ pr: null }), events: [held(31)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', CI_REASON), rule: 'PR13' } },
  { name: 'PR13 a held push after an update parks', fx: { job: atGate(), events: [ev('pr-updated', 31), held(33)] }, want: { rule: 'PR13' } },
  { name: "PR13 a reason outside its class falls back to a fixed one", fx: { job: atGate({ pr: null }), events: [held(31, "push held: x'$(id)")] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'push held: see forge pr open'), rule: 'PR13' } },
  { name: 'PR3 a held push older than the last verify opens again', fx: { job: atGate({ pr: null }), events: [held(29)] }, want: { rule: 'PR3' } },
  { name: "PR3 a person's approve after the held push lets pr open push (no PR13 again)", fx: { job: atGate({ pr: null }), events: [held(31), ...approvedAt(32, 'pr', 'human', CI_REASON)] }, want: { rule: 'PR3' } },
  {
    name: 'G4b a held push tells that nothing has left the machine',
    fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'human', reason: CI_REASON, pr: GATE_PR }) },
    want: { action: 'wait', waitingOn: 'human', tell: `j push held (${CI_REASON}): nothing has left this machine. Read the change in ${WT}, then /forge approve j to push, or /forge rework j <note>` },
  },
  {
    name: 'G4b a held protected push names protected.diff',
    fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'human', reason: 'push held: protected paths: .github/workflows/ci.yml' }) },
    want: { action: 'wait', tell: `j push held (push held: protected paths: .github/workflows/ci.yml): nothing has left this machine. Read the change in ${WT} and ${path.join(JOB_DIR, 'protected.diff')}, then /forge approve j to push, or /forge rework j <note>` },
  },

  // ---- The merge gates on the open PR (PR15, the one escalation park, then PR17): AC2–AC4, AC12, AC16
  { name: 'PR14 an ESCALATE on the open PR: forge pr gate says why first', fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: gateEvents('ESCALATE') }, want: { ...run('pr', 'gate', 'j'), rule: 'PR14', why: 'say on the PR why it waits on a decision before merge' } },
  { name: 'PR14 a sync of another reason syncs again', fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), synced(32, 'PR15', ESC('runbook'))] }, want: { rule: 'PR14' } },
  { name: 'PR14 a sync that listed other details under the same reason syncs again', fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_VERSION]), synced(32, 'PR15', ESC('version'), [{ rule: 'version', detail: 'version changed in 2 manifests', paths: ['a/package.json', 'package.json'] }])] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR14' } },
  { name: 'PR15 a sync that listed the same reasons parks', fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_VERSION]), synced(32, 'PR15', ESC('version'), [R_VERSION])] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('version')), rule: 'PR15' } },
  { name: 'PR14 a sync before the last push syncs again',fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: [decided('ESCALATE', true, 22), synced(29, 'PR15', ESC('approver')), OPENED] }, want: { rule: 'PR14' } },
  { name: 'PR15 an ESCALATE parks on escalation after the PR says why', fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('approver')), rule: 'PR15' } },
  // AC8: every open reason on one park, after PR14 synced that one gate.
  { name: 'PR14 syncs the collapsed gate first', fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), GATE(31, [R_RUNBOOK, R_VERSION])] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR14' } },
  {
    name: 'PR15 every open reason in one park',
    fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), GATE(31, [R_VERSION, R_RUNBOOK]), synced(32, 'PR15', ESC('approver', 'runbook', 'version'))] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'escalation: approver, runbook, version'), rule: 'PR15' },
  },
  // AC9: one person's approve there, after the review and the approver's end, clears every rule it lists.
  {
    name: 'PR18 one approve clears every reason, protected paths included',
    fx: { job: atGate({ protectedPaths: MIGRATION() }), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), GATE(31, [R_RUNBOOK, R_VERSION]), synced(31, 'PR15', ESC('approver', 'protected-paths', 'runbook', 'version')), ...approvedAt(32, 'pr', 'escalation', ESC('approver', 'protected-paths', 'runbook', 'version'))] },
    want: { ...run('pr', 'gate', 'j'), rule: 'PR18' },
  },
  {
    name: 'PR5 after that approve and PR18, the job waits on review with no second park',
    fx: { config: (c) => (c.merge.auto = true), job: atGate({ protectedPaths: MIGRATION() }), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), GATE(31, [R_RUNBOOK, R_VERSION]), synced(31, 'PR15', ESC('approver', 'protected-paths', 'runbook', 'version')), ...approvedAt(32, 'pr', 'escalation', ESC('approver', 'protected-paths', 'runbook', 'version')), ev('pr-gate', 35, { action: 'clear', rule: null, reason: null, labeled: false })] },
    want: { rule: 'PR5' },
  },
  {
    name: "PR15 an approve before the flag's at leaves protected-paths open",
    fx: { job: atGate({ pr: null, protectedPaths: MIGRATION(40) }), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), GATE(31, [R_RUNBOOK, R_VERSION]), ...approvedAt(32, 'pr', 'escalation', ESC('approver', 'protected-paths', 'runbook', 'version'))] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('protected-paths')), rule: 'PR15' },
  },
  // AC11: a human-only rule is never cleared by the Foreman, and the open rules come from facts, not the park's reason.
  {
    name: 'PR15 a Foreman approve leaves a lens-escalate park parked',
    fx: { job: atGate({ pr: null }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_LENS]), ...approvedAt(32, 'pr', 'escalation', ESC('lens-escalate'), { actor: FOREMAN })] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('lens-escalate')), rule: 'PR15' },
  },
  { name: "PR18 a person's approve clears the lens-escalate park", fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_LENS]), synced(31, 'PR15', ESC('lens-escalate')), ...approvedAt(32, 'pr', 'escalation', ESC('lens-escalate'))] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR18' } },
  { name: 'PR18 a Foreman approve clears a version-only park', fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_VERSION]), synced(31, 'PR15', ESC('version')), ...approvedAt(32, 'pr', 'escalation', ESC('version'), { actor: FOREMAN })] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR18' } },
  { name: 'PR15 a Foreman approve at a runbook park leaves it parked', fx: { job: atGate({ pr: null }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_RUNBOOK]), ...approvedAt(32, 'pr', 'escalation', ESC('runbook'), { actor: FOREMAN })] }, want: { rule: 'PR15' } },
  {
    name: 'PR15 a park reason rewritten to drop lens-escalate leaves it open',
    fx: { job: atGate({ pr: null }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_LENS, R_VERSION]), ...approvedAt(32, 'pr', 'escalation', ESC('version'))] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('lens-escalate')), rule: 'PR15' },
  },
  // AC14: a job decided before gate reasons existed, and the parks it made then.
  { name: 'PR19 a decided job with no gate event computes one', fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: gateEvents('APPROVE'), gate: null }, want: { ...run('job', 'gate', 'j'), rule: 'PR19' } },
  { name: 'PR19 a DC10 rework round reviewed after the last gate event computes one', fx: { job: atGate({ round: 2 }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(32), tr(40, { stage: 'review' }, { stage: 'decide' }), tr(41, { stage: 'decide' }, { stage: 'pr' })] }, want: { rule: 'PR19' } },
  { name: 'PR18 a legacy PR16 approve clears the runbook', fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), synced(31, 'PR16', RUNBOOK), ...approvedAt(32, 'pr', 'infra', RUNBOOK), GATE(35, [R_RUNBOOK])] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR18' } },
  { name: 'PR18 a legacy PR15 approve clears the approver reason', fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), synced(31, 'PR15', ESCALATED), ...approvedAt(32, 'pr', 'escalation', ESCALATED), GATE(35)] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR18' } },
  { name: 'PR18 a legacy PP1b approve clears protected paths', fx: { job: atGate({ protectedPaths: MIGRATION() }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), synced(31, 'PP1b', MIGRATION_REASON), ...approvedAt(32, 'pr', 'human', MIGRATION_REASON), GATE(35, [R_PROTECTED])] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR18' } },
  { name: 'G4b a job parked on the legacy PR16 park keeps waiting there', fx: { job: job({ stage: 'pr', round: 1, state: 'waiting', waitingOn: 'infra', reason: RUNBOOK, pr: GATE_PR }), events: [parkTr(32, 'pr', 'infra', RUNBOOK)] }, want: { action: 'wait', waitingOn: 'infra' } },
  { name: 'G4b a job parked on the legacy PP1b park keeps waiting there', fx: { job: job({ stage: 'pr', round: 1, state: 'waiting', waitingOn: 'human', reason: MIGRATION_REASON, pr: GATE_PR }), events: [parkTr(32, 'pr', 'human', MIGRATION_REASON)] }, want: { action: 'wait', waitingOn: 'human' } },
  { name: 'PR15 parks with merge.auto on and a current decision too', fx: { config: (c) => (c.merge.auto = true), job: atGate(), decision: { decision: 'ESCALATE' }, decisionCurrent: true, events: [...gateEvents('ESCALATE', true), PR15_SYNCED] }, want: { rule: 'PR15' } },
  { name: 'PR15 parks without a PR to tell (a deferred root)', fx: { job: atGate({ pr: null }), decision: { decision: 'ESCALATE' }, events: gateEvents('ESCALATE') }, want: { rule: 'PR15' } },
  { name: "GA2 a person's approve at the PR15 park goes to integrate", fx: answeredAt('pr', 'escalation', 'approve', { reason: ESCALATED, pr: GATE_PR }), want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'GA2' } },
  { name: 'PR15 an approve at a release-bump escalation does not clear it', fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED, ...approvedAt(32, 'pr', 'escalation', 'release bump: verify failed after the release of repo lib 1.2.0')] }, want: { rule: 'PR15' } },
  { name: 'PR5 an approve at the old decide-stage DC7 park still clears it', fx: { job: atGate(), decision: { decision: 'ESCALATE' }, events: [decided('ESCALATE', true, 22), ...approvedAt(23, 'decide', 'escalation', ESCALATED), OPENED] }, want: { rule: 'PR5' } },
  { name: "PR15 an approve before the approver's last end does not clear it", fx: { config: (c) => (c.merge.auto = true), job: atGate({ agents: { approver: ag(2, 36, 37) } }), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED, ...approvedAt(32, 'pr', 'escalation', ESCALATED), ev('decision', 38, { decision: 'ESCALATE', autoMerge: false, head: HEAD_SHA })] }, want: { rule: 'PR15' } },
  // PR18: the gate cleared while the PR still says it is open.
  { name: 'PR18 after the approve, forge pr gate clears the label and the section', fx: { config: (c) => (c.merge.auto = true), job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED, ...approvedAt(32, 'pr', 'escalation', ESCALATED)] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR18' } },
  { name: 'PR5 once the PR is told, an approved ESCALATE waits on review and never reaches PR4', fx: { config: (c) => (c.merge.auto = true), job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED, ...approvedAt(32, 'pr', 'escalation', ESCALATED), ev('pr-gate', 35, { action: 'clear', rule: null, reason: null, labeled: false })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review') },
  { name: 'PR5 no PR18 on a PR that is no longer open', fx: { job: atGate({ pr: { ...GATE_PR!, state: 'CLOSED' } }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), synced(32, 'PR15', ESC('runbook'))] }, want: { rule: 'PR5' } },
  {
    name: 'G4b an escalation park names the file behind each rule',
    fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'escalation', reason: ESC('approver', 'protected-paths', 'lens-escalate', 'runbook', 'version'), pr: GATE_PR }) },
    want: {
      action: 'wait',
      rule: 'G4b',
      tell: `j escalated (${ESC('approver', 'protected-paths', 'lens-escalate', 'runbook', 'version')}): see ${[path.join(JOB_DIR, 'decision.md'), path.join(JOB_DIR, 'protected.diff'), path.join(JOB_DIR, 'review'), path.join(JOB_DIR, 'runbook.md')].join(', ')}. /forge approve j or /forge rework j <note>\nj PR https://github.com/o/r/pull/7 is open: it waits on this decision before merge`,
    },
  },
  {
    name: 'G4b a push-held escalation park says nothing has left the machine',
    fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'escalation', reason: `push held: ${ESC('approver', 'protected-paths')}`, pr: GATE_PR }) },
    want: { tell: `j escalated (push held: ${ESC('approver', 'protected-paths')}): see ${path.join(JOB_DIR, 'decision.md')}, ${path.join(JOB_DIR, 'protected.diff')}. The push is held: nothing has left this machine. /forge approve j or /forge rework j <note>` },
  },
  {
    name: 'G4b a PR15 park on an open PR says the PR waits on the decision',
    fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'escalation', reason: ESCALATED, pr: GATE_PR }) },
    want: { action: 'wait', rule: 'G4b', waitingOn: 'escalation', tell: `j escalated (${ESCALATED}): see ${path.join(JOB_DIR, 'decision.md')}. /forge approve j or /forge rework j <note>\nj PR https://github.com/o/r/pull/7 is open: it waits on this decision before merge` },
  },
  { name: 'G4b a decide-stage escalation has no PR line', fx: { job: job({ stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: ESCALATED, pr: GATE_PR }) }, want: { tell: `j escalated (${ESCALATED}): see ${path.join(JOB_DIR, 'decision.md')}. /forge approve j or /forge rework j <note>` } },
  { name: 'PR15 a runbook parks on escalation after the push', fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_RUNBOOK]), synced(32, 'PR15', ESC('runbook'))] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('runbook')), rule: 'PR15' } },
  { name: 'PR15 an eligible APPROVE with merge.auto on never reaches PR4 before the approve', fx: { config: (c) => (c.merge.auto = true), job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_RUNBOOK]), synced(32, 'PR15', ESC('runbook'))] }, want: { rule: 'PR15' } },
  { name: "GA3 a person's approve at the PR16 park goes to integrate", fx: answeredAt('pr', 'infra', 'approve', { reason: RUNBOOK, pr: GATE_PR }), want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'GA3' } },
  { name: "GA2 a person's approve at the escalation park goes to integrate", fx: answeredAt('pr', 'escalation', 'approve', { reason: ESC('approver', 'runbook'), pr: GATE_PR }), want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'GA2' } },
  { name: 'PR5 after the runbook approve, a gated decision waits on review', fx: { config: (c) => (c.merge.auto = true), job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_RUNBOOK]), ...approvedAt(32, 'pr', 'escalation', ESC('runbook'))] }, want: { rule: 'PR5' } },
  { name: "GA6 a person's approve at the PP1b park keeps the stage", fx: answeredAt('pr', 'human', 'approve', { reason: MIGRATION_REASON, pr: GATE_PR }), want: { ...run('job', 'set', 'j', '--state', 'running'), rule: 'GA6' } },
  { name: 'GA8 a rework at the PR15 park goes to build and keeps the PR', fx: answeredAt('pr', 'escalation', 'rework', { reason: ESCALATED, pr: GATE_PR }), want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'GA8' } },
  {
    name: 'PR5 after a rework with merge.auto off, the earlier approval still clears PR15',
    fx: { job: atGate({ round: 2, verifyRuns: [vr(1, 30, true), vr(2, 44, true)] }), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), ...approvedAt(32, 'pr', 'escalation', ESC('approver')), tr(40, { stage: 'pr' }, { stage: 'build' }), tr(43, { stage: 'decide' }, { stage: 'pr' }), ev('pr-updated', 45)] },
    want: { rule: 'PR5' },
  },
  {
    name: 'PR14 after a rework with merge.auto on, a new ESCALATE on the new head syncs the PR again',
    fx: { config: (c) => (c.merge.auto = true), job: atGate({ round: 2, verifyRuns: [vr(1, 30, true), vr(2, 44, true)], agents: { approver: ag(2, 41, 42) } }), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED, ...approvedAt(32, 'pr', 'escalation', ESCALATED), ev('decision', 42, { decision: 'ESCALATE', autoMerge: false, head: HEAD_SHA }), ev('pr-updated', 45)] },
    want: { ...run('pr', 'gate', 'j'), rule: 'PR14' },
  },
  {
    name: 'PR15 after a rework with merge.auto on, a new ESCALATE parks again',
    fx: { config: (c) => (c.merge.auto = true), job: atGate({ round: 2, verifyRuns: [vr(1, 30, true), vr(2, 44, true)], agents: { approver: ag(2, 41, 42) } }), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED, ...approvedAt(32, 'pr', 'escalation', ESCALATED), ev('decision', 42, { decision: 'ESCALATE', autoMerge: false, head: HEAD_SHA }), ev('pr-updated', 45), synced(46, 'PR15', ESC('approver'))] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('approver')), rule: 'PR15' },
  },
  { name: 'PR18 after a rework with merge.auto on, a new APPROVE clears the label', fx: { config: (c) => (c.merge.auto = true), job: atGate({ round: 2, verifyRuns: [vr(1, 30, true), vr(2, 44, true)], agents: { approver: ag(2, 41, 42) } }), decision: { decision: 'APPROVE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED, decided('APPROVE', true, 42), ev('pr-updated', 45)] }, want: { ...run('pr', 'gate', 'j'), rule: 'PR18' } },
  { name: 'PR4 after a rework with merge.auto on, a new APPROVE merges', fx: { config: (c) => (c.merge.auto = true), job: atGate({ round: 2, verifyRuns: [vr(1, 30, true), vr(2, 44, true)], agents: { approver: ag(2, 41, 42) } }), decision: { decision: 'APPROVE' }, events: [...gateEvents('ESCALATE'), ...approvedAt(32, 'pr', 'escalation', ESCALATED), decided('APPROVE', true, 42), ev('pr-updated', 45)] }, want: { rule: 'PR4' } },

  // ---- Protected paths (PP1, PP2)
  { name: 'DC9b decide with APPROVE and an unapproved flag on db/migrations/0001.sql goes on to integrate', fx: { job: atDecide({ protectedPaths: MIGRATION() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)] }, want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'DC9b' } },
  { name: 'protected paths: PP1 an approve after at, at a protected park, gives DC9', fx: { job: atDecide({ protectedPaths: FLAG() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ...ppPark(23, 25)] }, want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'DC9b' } },
  // PR15: after the push, escalate paths no human approved hold the merge on the escalation park (AC5).
  { name: 'PR15 an unapproved flag on db/migrations/0001.sql parks on escalation after the push', fx: { job: atGate({ protectedPaths: MIGRATION() }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), synced(32, 'PR15', ESC('protected-paths'))] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('protected-paths')), rule: 'PR15' } },
  { name: "PR5 a person's approve at the PP1b park clears it, and PR4 stays out while hits exist", fx: { config: (c) => (c.merge.auto = true), job: atGate({ protectedPaths: MIGRATION() }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), ...approvedAt(32, 'pr', 'human', MIGRATION_REASON)] }, want: { rule: 'PR5' } },
  { name: "PR15 the foreman's approve at the PP1b park does not clear it", fx: { job: atGate({ protectedPaths: MIGRATION() }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), synced(31, 'PR15', ESC('protected-paths')), ...approvedAt(32, 'pr', 'human', MIGRATION_REASON, { actor: FOREMAN })] }, want: { rule: 'PR15' } },
  { name: "PR15 the foreman's approve at the escalation park does not clear protected paths", fx: { job: atGate({ pr: null, protectedPaths: MIGRATION() }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), ...approvedAt(32, 'pr', 'escalation', ESC('protected-paths'), { actor: FOREMAN })] }, want: { rule: 'PR15' } },
  { name: 'PR15 an approve before at does not count', fx: { job: atGate({ pr: null, protectedPaths: MIGRATION(40) }), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), ...approvedAt(32, 'pr', 'human', MIGRATION_REASON)] }, want: { rule: 'PR15' } },
  { name: 'PR15 a v1 foreman actor does not count', fx: { job: atGate({ pr: null, protectedPaths: FLAG() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ...ppPark(23, 25, { actor: 'foreman' }), OPENED] }, want: { rule: 'PR15' } },
  { name: 'PR15 a v2 foreman actor does not count', fx: { job: atGate({ pr: null, protectedPaths: FLAG() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ...ppPark(23, 25, { actor: { login: null, source: 'foreman' } }), OPENED] }, want: { rule: 'PR15' } },
  { name: "protected paths: PP1 a v2 person's approve gives DC9", fx: { job: atDecide({ protectedPaths: FLAG() }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22), ...ppPark(23, 25, { actor: { login: 'alice', source: 'gh' } })] }, want: { ...run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running'), rule: 'DC9b' } },
  {
    name: 'PR15 an approve at the legacy approver park clears the escalation, not the protected paths',
    fx: { job: atGate({ protectedPaths: FLAG() }), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), ...approvedAt(32, 'pr', 'escalation', ESCALATED), synced(35, 'PR15', ESC('protected-paths'))] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('protected-paths')), rule: 'PR15' },
  },
  { name: 'protected paths: PP1 no flag gives DC9', fx: { job: atDecide(), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)] }, want: { rule: 'DC9b' } },
  { name: 'protected paths: PP1 an eval job does not park', fx: { job: job({ kind: 'eval', stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG() }) }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  {
    name: 'PP1 a path outside the safe class never reaches the reason',
    fx: { job: atGate({ pr: null, protectedPaths: FLAG(15, ['package-lock.json', "x'$(touch y)/yarn.lock", '-rf/yarn.lock', 'a b/Cargo.lock'], 2) }), decision: { decision: 'APPROVE' }, events: [ev('decision', 22)] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', `push held: ${ESC('protected-paths')}`), rule: 'PP1' },
  },
  { name: 'PR15 a flag raised at the pr stage parks after the push', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG(12, ['Dockerfile']) }), events: [ev('pr-opened', 11)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('protected-paths')), rule: 'PR15' } },
  { name: "PP1 a member repo's CI path holds the push", fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG(12, ['lib:.github/workflows/ci.yml']) }), events: [ev('pr-opened', 11)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', `push held: ${ESC('protected-paths')}`), rule: 'PP1' } },
  // PP1: a CI path stays before the push (AC6).
  { name: 'PP1 an unapproved CI path parks before PR3 with the push held', fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['.github/workflows/ci.yml']) }), decision: { decision: 'APPROVE' } }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', `push held: ${ESC('protected-paths')}`), rule: 'PP1' } },
  { name: 'PP1 a CI path in another spelling holds the push too', fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['.GitHub/Workflows/CI.yml']) }) }, want: { rule: 'PP1' } },
  { name: 'PP1 hits past the stored ones hold the push', fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['Dockerfile'], 3) }) }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', `push held: ${ESC('protected-paths')}`), rule: 'PP1' } },
  {
    name: "PP1 parks when only pr open's blocked escalate event names the CI path",
    fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['Dockerfile']) }), events: [ev('protected-path', 33, { gate: 'pr', action: 'escalate', blocked: true, paths: [{ path: '.github/workflows/ci.yml' }], more: 0, head: HEAD_SHA })] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', `push held: ${ESC('protected-paths')}`), rule: 'PP1' },
  },
  // AC10: the held push lists every open rule, and its one approve covers the merge too.
  {
    name: 'PP1 the held push lists every open reason',
    fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['.github/workflows/ci.yml']) }), decision: { decision: 'ESCALATE' }, events: [decided('ESCALATE', true, 22)] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'push held: escalation: approver, protected-paths'), rule: 'PP1' },
  },
  {
    name: 'PP1 lists the gate reasons found before the park too',
    fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['.github/workflows/ci.yml']) }), decision: { decision: 'APPROVE' }, events: [decided('APPROVE', true, 22), GATE(23, [R_RUNBOOK])] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', `push held: ${ESC('protected-paths', 'runbook')}`), rule: 'PP1' },
  },
  {
    name: "PR19 computes this review's gate event before PP1 holds the push",
    fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['.github/workflows/ci.yml']) }), decision: { decision: 'APPROVE' }, events: [decided('APPROVE', true, 22)], gate: null },
    want: { ...run('job', 'gate', 'j'), rule: 'PR19' },
  },
  {
    name: 'PR15 a later gate event that lists fewer reasons does not shrink the park',
    fx: { job: atGate(), decision: { decision: 'APPROVE' }, events: [...gateEvents('APPROVE'), GATE(31, [R_RUNBOOK, R_VERSION]), GATE(33, [R_VERSION]), synced(34, 'PR15', ESC('runbook', 'version'))] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', ESC('runbook', 'version')), rule: 'PR15' },
  },
  {
    name: 'PR5 a later empty gate event does not make an eligible decision mergeable',
    fx: { config: (c) => (c.merge.auto = true), job: atGate(), decision: { decision: 'APPROVE' }, decisionCurrent: true, events: [...gateEvents('APPROVE'), GATE(31, [R_VERSION]), ...approvedAt(32, 'pr', 'escalation', ESC('version')), GATE(35)] },
    want: { rule: 'PR5' },
  },
  {
    name: 'PR18 the PP1 approve covers the merge too',
    fx: {
      job: atGate({ protectedPaths: FLAG(12, ['.github/workflows/ci.yml']) }),
      decision: { decision: 'ESCALATE' },
      events: [decided('ESCALATE', true, 22), ev('pr-opened', 24), synced(25, 'PR15', ESC('approver')), ...approvedAt(32, 'pr', 'escalation', 'push held: escalation: approver, protected-paths'), ev('pr-updated', 35)],
    },
    want: { ...run('pr', 'gate', 'j'), rule: 'PR18' },
  },
  { name: "PP1 the foreman's approve at the held escalation park does not count", fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['.github/workflows/ci.yml']) }), events: [...approvedAt(32, 'pr', 'escalation', `push held: ${ESC('protected-paths')}`, { actor: FOREMAN })] }, want: { rule: 'PP1' } },
  { name: 'PR3 a blocked escalate event older than the last verify opens again', fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['Dockerfile']) }), events: [ev('protected-path', 29, { gate: 'pr', action: 'escalate', blocked: true })] }, want: { rule: 'PR3' } },
  { name: "PR3 a person's approve at the push-held protected park lets pr open push", fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['.github/workflows/ci.yml']) }), events: [...approvedAt(32, 'pr', 'human', 'push held: protected paths: .github/workflows/ci.yml')] }, want: { rule: 'PR3' } },
  { name: "PP1 the foreman's approve at the push-held protected park does not count", fx: { job: atGate({ pr: null, protectedPaths: FLAG(12, ['.github/workflows/ci.yml']) }), events: [...approvedAt(32, 'pr', 'human', 'push held: protected paths: .github/workflows/ci.yml', { actor: FOREMAN })] }, want: { rule: 'PP1' } },
  { name: 'protected paths: PP1 an approved flag at the pr stage goes on', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG(5) }), events: [...ppPark(6, 7), ev('pr-opened', 11)] }, want: { rule: 'PR5' } },
  {
    name: 'G4b a protected park names the diff',
    fx: { job: job({ stage: 'decide', state: 'waiting', waitingOn: 'human', reason: 'protected paths: package-lock.json' }) },
    want: { action: 'wait', waitingOn: 'human', tell: `j changed protected paths (protected paths: package-lock.json). Diff: ${path.join(JOB_DIR, 'protected.diff')}. /forge approve j once a human has reviewed them, or /forge rework j <note>` },
  },
  { name: 'PP2 a verify that failed on protected paths goes back to build', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, false, 'protected')], agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'PP2' } },
  { name: 'protected paths: PP2 a builder that ran since hands back to PR2', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, false, 'protected')], agents: { builder: ag(1, 11, 12) } }) }, want: { ...run('verify', 'j'), rule: 'PR2' } },
  { name: 'PP2b a refusal at pr open newer than the last verify goes back to build', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('pr-opened', 9), ev('protected-path', 12, { gate: 'pr', action: 'refuse', blocked: true })] }, want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), rule: 'PP2b' } },
  { name: 'protected paths: PP2 a refusal older than the last verify does not count', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 14, true)] }), events: [ev('protected-path', 12, { gate: 'pr', action: 'refuse', blocked: true })] }, want: { rule: 'PR3' } },
  {
    name: 'protected paths: PR4 never auto-merges protected paths',
    fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], protectedPaths: FLAG(5) }), decision: { decision: 'APPROVE' }, events: [APPROVED,...ppPark(6, 7), ev('pr-opened', 11)] },
    want: { action: 'run', rule: 'PR5' },
  },

  // ---- Repo proposals (RP1, RP2)
  ...(['plan', 'spec', 'design', 'build', 'verify', 'review', 'decide', 'integrate'] as const).map((stage) => ({
    name: `RP1 parks a pending proposal at ${stage}`,
    fx: { job: job({ stage, round: 1, agents: { builder: ag(1, 5, 6) } }), events: [PROPOSED(7)] },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'repo proposal: lib'), rule: 'RP1' },
  })),
  { name: 'RP1 parks before the spec gate', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET, PROPOSED(4)] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'repo proposal: lib'), rule: 'RP1' } },
  {
    name: 'SP5 after an approved proposal',
    fx: { job: job({ stage: 'spec', agents: SPEC_DONE, repos: WITH_LIB }), events: [PANEL_SET, PROPOSED(4), ev('human', 5, { action: 'approve-repos', repos: ['lib'], note: null })] },
    want: { ...run('job', 'set', 'j', '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'spec-approval', '--reason', 'spec ready'), rule: 'SP5' },
  },
  { name: 'repo proposals: RP1 a generic approve on the park re-parks', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET, PROPOSED(4), ev('human', 6, { action: 'approve' })] }, want: { rule: 'RP1' } },
  { name: 'repo proposals: RP1 a name outside REPO_NAME is never pending', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET, ev('repo-proposed', 4, { repo: "x'$(touch y)", reason: 'r' }), ev('repo-proposed', 4, { repo: '-rf', reason: 'r' })] }, want: { rule: 'SP5' } },
  {
    name: 'RP1 names at most five repos and counts the rest',
    fx: { job: job({ stage: 'build', round: 1, agents: { builder: ag(1, 5, 6) } }), events: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((r, i) => ev('repo-proposed', 7 + i, { repo: r, reason: 'x' })) },
    want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'repo proposal: a, b, c, d, e +2 more'), rule: 'RP1' },
  },
  { name: 'repo proposals: RP1 waits for a running agent', fx: { job: job({ stage: 'spec', agents: { 'spec-writer': ag(0, 1) } }), events: [PROPOSED(2)] }, want: { action: 'wait', rule: 'G5' } },
  { name: 'repo proposals: RP1 not at backlog', fx: { job: job({ stage: 'backlog' }), events: [PROPOSED(2)] }, want: { rule: 'I5' } },
  { name: 'repo proposals: RP1 not at pr', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [PROPOSED(12)] }, want: { rule: 'PR3' } },
  { name: 'repo proposals: RP1 a rejected proposal is not pending', fx: { job: job({ stage: 'spec', agents: { 'spec-writer': ag(0, 5, 6) } }), events: [PROPOSED(2), ev('human', 3, { action: 'reject-repos', repos: ['lib'] }), ev('fields', 7, { fields: { reviewers: ['code'] } })] }, want: { rule: 'SP5' } },
  { name: 'RP2 creates the worktree of an approved repo', fx: { job: job({ stage: 'spec', agents: SPEC_DONE, repos: WITH_LIB }), memberWorktreesMissing: true, events: [PANEL_SET, PROPOSED(4), ev('human', 5, { action: 'approve-repos', repos: ['lib'] })] }, want: { ...run('worktree', 'create', 'j'), rule: 'RP2' } },
  { name: 'SP2 re-specs after a rejected repo proposal', fx: { job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET, PROPOSED(2), ev('human', 4, { action: 'reject-repos', repos: ['lib'], note: 'no' })] }, want: { action: 'spawn', rule: 'SP2', role: 'spec-writer' } },
  { name: 'P1 re-plans after a rejected repo proposal', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SINGLE' }, events: [PROPOSED(2), ev('human', 4, { action: 'reject-repos', repos: ['lib'] })] }, want: { action: 'spawn', rule: 'P1', role: 'planner' } },
  { name: 'repo proposals: P4 a reject older than the planner run does not re-plan', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 5, 6) } }), plan: { verdict: 'SINGLE' }, events: [PROPOSED(2), ev('human', 4, { action: 'reject-repos', repos: ['lib'] })] }, want: { rule: 'P4' } },
  {
    name: 'G4b a repo proposal park names repo-proposals.md',
    fx: { job: job({ stage: 'spec', state: 'waiting', waitingOn: 'human', reason: 'repo proposal: lib' }), events: [PROPOSED(2)] },
    want: { action: 'wait', waitingOn: 'human', tell: `j proposes repos (repo proposal: lib): ${path.join(JOB_DIR, 'repo-proposals.md')}. Approve or reject in the dashboard, or in your own terminal: forge job human j approve-repos|reject-repos --repo <names> --note …` },
  },

  // ---- Secret scan (SC1–SC3) and the human gate
  { name: 'SC1b parks a verify the secret scan blocked', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked verify round 1'), rule: 'SC1b' } },
  { name: 'SC1b parks in integrate', fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 40, false, 'secrets')] }), events: [entered, ev('integrated', 31, { behind: 2 })] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked verify round 1'), rule: 'SC1b' } },
  { name: 'SC1b parks in pr', fx: { job: job({ stage: 'pr', round: 2, verifyRuns: [vr(2, 10, false, 'secrets')] }) }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked verify round 2'), rule: 'SC1b' } },
  { name: 'SC1 fails an eval job instead', fx: { job: job({ kind: 'eval', stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('job', 'set', 'j', '--state', 'failed', '--reason', 'eval: secret scan blocked verify round 1'), rule: 'SC1' } },
  { name: 'SC1b holds after a rework note that is not an approve', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }), events: [ev('human', 12, { action: 'note' })] }, want: { rule: 'SC1b' } },
  { name: 'V1 re-verifies when the builder ended after a secret block', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 4, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }) }, want: { ...run('verify', 'j'), rule: 'V1' } },
  { name: 'SC2 scans again after a newer approve', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }), events: [ev('human', 12, { action: 'approve' })] }, want: { ...run('verify', 'j'), rule: 'SC2' } },
  { name: 'SC1b an approve older than the failing run does not count', fx: { job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 10, false, 'secrets')], agents: { builder: ag(1, 5, 6) } }), events: [ev('human', 8, { action: 'approve' })] }, want: { rule: 'SC1b' } },
  { name: 'SC3b parks after pr open was refused', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 12, { gate: 'pr', blocked: true, count: 1 })] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked pr open'), rule: 'SC3b' } },
  { name: 'SC3b parks after a pr open scan error', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 12, { gate: 'pr', blocked: true, count: 0, error: 'base x not found' })] }, want: { ...run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked pr open'), rule: 'SC3b' } },
  { name: 'SC3 fails an eval job instead', fx: { job: job({ kind: 'eval', stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 12, { gate: 'pr', blocked: true })] }, want: { ...run('job', 'set', 'j', '--state', 'failed', '--reason', 'eval: secret scan blocked pr open'), rule: 'SC3' } },
  { name: 'PR3 opens again once a human approved the SC3 park', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 12, { gate: 'pr', blocked: true }), ev('human', 14, { action: 'approve' })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  { name: 'PR3 a refusal older than the last verify does not park', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 8, { gate: 'pr', blocked: true })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  { name: 'PR3 a commit-gate event is not a pr refusal', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('secret-found', 12, { gate: 'commit', blocked: true })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  {
    name: 'G4b human tells how to clear a secret scan',
    fx: { job: job({ stage: 'verify', state: 'waiting', waitingOn: 'human', reason: 'secret scan blocked verify round 1' }) },
    want: { action: 'wait', waitingOn: 'human', tell: 'j stopped on a possible secret (secret scan blocked verify round 1). Masked findings and fingerprints: forge secrets scan j. Remove the value (rewrite the branch if it was committed) or add its fingerprint to .forge/secrets-allow.txt in the main checkout, then /forge approve j to scan again, or /forge rework j <note>' },
  },
  { name: 'G4b human with another reason gets the generic tell', fx: { job: job({ stage: 'build', state: 'waiting', waitingOn: 'human', reason: 'protected path edited' }) }, want: { action: 'wait', waitingOn: 'human', tell: 'j needs a human: protected path edited. /forge approve j once it is resolved, or /forge rework j <note>' } },
  { name: 'PR4 merges an eligible PR', fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11)] }, want: run('pr', 'merge', 'j') },
  { name: 'PR5 ship propose never merges (PR4 holds off)', fx: { config: (c) => Object.assign(c.foreman, { enabled: true, ship: 'propose' }), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR4 ship merge needs approver eligibility: eligible merges', fx: { config: (c) => Object.assign(c.foreman, { enabled: true, ship: 'merge' }), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11)] }, want: { ...run('pr', 'merge', 'j'), rule: 'PR4' } },
  { name: 'PR4 ship release merges like merge', fx: { config: (c) => Object.assign(c.foreman, { enabled: true, ship: 'release' }), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11)] }, want: { ...run('pr', 'merge', 'j'), rule: 'PR4' } },
  { name: 'PR5 ship merge needs approver eligibility: not eligible waits', fx: { config: (c) => Object.assign(c.foreman, { enabled: true, ship: 'merge' }), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [decided('APPROVE', false), ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR5 an ESCALATE marked eligible never merges, even after a human cleared it', fx: { config: (c) => (c.merge.auto = true), job: atGate(), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), ...approvedAt(32, 'pr', 'escalation', ESCALATED)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR5 a yes written into decision.md after a recorded no waits', fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [decided('APPROVE', false), ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  {
    name: 'PR5 a reviewed integrate episode after the decision waits (reviewCurrent true, decisionCurrent false)',
    fx: {
      config: (c) => (c.merge.auto = true),
      job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 12, true)] }),
      decision: { decision: 'APPROVE' },
      reviewCurrent: true,
      decisionCurrent: false,
      events: [APPROVED, ev('integrate-conflicts', 10, { strategy: 'merge', conflicts: ['a.ts'], behind: 1, head: HEAD_SHA, upstream: BASE_SHA }), tr(13, { stage: 'integrate' }, { stage: 'pr' }), ev('pr-opened', 14)],
    },
    want: { action: 'run', rule: 'PR5' },
  },
  // PR12: the round's review covered X, verify passed on Y; a plain commit between them is unreviewed.
  {
    name: 'PR12 a commit after review goes back to review, ahead of PR4',
    fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verdicts: { 1: { code: 'PASS' } }, verifyRuns: [{ ...vr(1, 10, true), sha: HEAD_SHA }] }), decision: { decision: 'APPROVE' }, reviewCurrent: false, events: [APPROVED, ev('pr-opened', 11)] },
    want: { ...BACK_TO_REVIEW, rule: 'PR12' },
  },
  { name: 'PR12 wins over PR1 with PRs off', fx: { config: (c) => (c.pr.enabled = false), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), reviewCurrent: false }, want: { ...BACK_TO_REVIEW, rule: 'PR12' } },
  {
    name: "PR3 only integrate's clean merges between the reviewed and verified heads open the PR (reviewCurrent true)",
    fx: { job: job({ stage: 'pr', round: 1, verdicts: { 1: { code: 'PASS' } }, verifyRuns: [{ ...vr(1, 10, true), sha: HEAD_SHA }] }), reviewCurrent: true, events: [ev('integrated', 8, { behind: 1, strategy: 'merge' })] },
    want: { ...run('pr', 'open', 'j'), rule: 'PR3' },
  },
  { name: 'PR5 an APPROVE recorded before the head binding waits', fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [ev('decision', 9, { decision: 'APPROVE', reason: null }), ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR5 ship merge without the foreman on never merges', fx: { config: (c) => Object.assign(c.foreman, { enabled: false, ship: 'merge' }), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR5 once a merge was tried, the PR waits', fx: { config: (c) => (c.merge.auto = true), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11), ev('pr-merge-refused', 12)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR5 waits on PR review', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('pr-updated', 11)] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review') },
  // ---- Interim strategies: a local edge holds off PR4; a deferral parks (PR6, PR8) or reopens (PR7)
  { name: 'local: PR4 skipped while an edge is local', fx: { config: (c) => (twoRepoConfig(c), (c.merge.auto = true)), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo(null) }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'release gate: PR4 skipped while a sequential release is unrecorded', fx: { config: (c) => (twoRepoConfig(c, 'sequential'), (c.merge.auto = true)), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('MERGED') }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11)] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review', '--reason', 'the root repo PR stays a draft until the release of repo lib is recorded [interim: sequential]: a human runs forge job interim release j lib VERSION') },
  { name: 'release gate: PR4 merges once the release is recorded', fx: { config: (c) => (twoRepoConfig(c, 'sequential'), (c.merge.auto = true)), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('MERGED') }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11), ev('interim-released', 12, { repo: 'lib', version: '1.2.0' })] }, want: { ...run('pr', 'merge', 'j'), rule: 'PR4' } },
  { name: 'release gate: a malformed release record keeps PR4 off', fx: { config: (c) => (twoRepoConfig(c, 'sequential'), (c.merge.auto = true)), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('MERGED') }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11), ev('interim-released', 12, { repo: 'lib', version: '1.2.0-canary.abc' })] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'release gate: PR4 never merges a draft PR', fx: { config: (c) => (twoRepoConfig(c, 'sequential'), (c.merge.auto = true)), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('OPEN').map((r) => (r.repo === 'lib' ? { ...r, pr: { ...r.pr!, isDraft: true } } : r)) }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11), ev('interim-released', 12, { repo: 'lib', version: '1.2.0' })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review') },
  { name: 'release gate: a single-repo draft PR still auto-merges', fx: { config: (c) => ((c.pr.draft = true), (c.merge.auto = true)), job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], pr: { ...OPEN_PR, isDraft: true } }), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11)] }, want: { ...run('pr', 'merge', 'j'), rule: 'PR4' } },
  // ---- A recorded release: PR9 bumps the consumers through verify, PR10 takes an all-released draft out of draft
  { name: 'PR9 runs verify for a bump due', fx: { config: (c) => linkedConfig(c, 'git-ref'), job: atPr([vr(1, 10, true)]), events: [ev('pr-opened', 11), REL(12)] }, want: { ...run('verify', 'j'), rule: 'PR9', why: 'release of repo lib 1.2.0 recorded: bump its consumers and verify' } },
  { name: 'PR9b parks on escalation after a failed verify past the release', fx: { config: (c) => linkedConfig(c, 'local'), job: atPr([vr(1, 10, true), vr(1, 13, false)]), events: [ev('pr-opened', 11), REL(12)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'release bump: verify failed after the release of repo lib 1.2.0') },
  { name: 'PR2 after a release: a human approve after the failed bump verify verifies again (PR9 lets it through)', fx: { config: (c) => linkedConfig(c, 'git-ref'), job: atPr([vr(1, 10, true), vr(1, 13, false)]), events: [ev('pr-opened', 11), REL(12), ev('human', 14, { action: 'approve' })] }, want: { ...run('verify', 'j'), rule: 'PR2' } },
  { name: 'PR9c parks when verify passed without bumping', fx: { config: (c) => linkedConfig(c, 'git-ref'), job: atPr([vr(1, 10, true), vr(1, 13, true)]), events: [ev('pr-opened', 11), REL(12)] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'release bump: verify passed without bumping the root repo') },
  { name: 'PR9 a newer version is due again', fx: { config: (c) => linkedConfig(c, 'git-ref'), job: atPr([vr(1, 10, true), vr(1, 14, true)]), events: [ev('pr-opened', 11), REL(12), ev('interim-bumped', 13, { repo: null, dependency: 'lib', version: '1.2.0' }), REL(15, '1.3.0')] }, want: { ...run('verify', 'j'), rule: 'PR9', why: 'release of repo lib 1.3.0 recorded: bump its consumers and verify' } },
  { name: 'PR3 pushes the bumped commit once verify bumped the consumer', fx: { config: (c) => linkedConfig(c, 'git-ref'), job: atPr([vr(1, 10, true), vr(1, 14, true)]), events: [ev('pr-opened', 11), REL(12), ev('interim-bumped', 13, { repo: null, dependency: 'lib', version: '1.2.0' })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  { name: 'PR5 after a release: a merged consumer is not bumped (no PR9)', fx: { config: (c) => linkedConfig(c, 'git-ref'), job: atPr([vr(1, 10, true)], { pr: { ...OPEN_PR, state: 'MERGED' } }), events: [ev('pr-opened', 11), REL(12)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR10 readies the root once every gate is released', fx: { config: (c) => twoRepoConfig(c, 'local'), job: atPr([vr(1, 10, true)], { pr: { ...OPEN_PR, isDraft: true } }), events: [ev('pr-opened', 11), REL(12)] }, want: { ...run('pr', 'ready', 'j', '--root'), rule: 'PR10', why: 'release recorded and consumers bumped: mark the consumer ready for review' } },
  { name: 'PR10 readies a member consumer with --repo', fx: { config: (c) => (twoRepoConfig(c), (c.components[0].dependsOn = []), (c.components[1].dependsOn = [{ component: 'app', type: 'build' }]), (c.release = { ...c.release, interim: 'sequential' })), job: atPr([vr(1, 10, true)], { pr: { ...OPEN_PR, state: 'MERGED' }, repos: libRepo('OPEN').map((r) => (r.repo === 'lib' ? { ...r, pr: { ...r.pr!, isDraft: true } } : r)) }), events: [ev('pr-opened', 11), ev('interim-released', 12, { repo: null, version: '2.0.0' })] }, want: { ...run('pr', 'ready', 'j', '--repo', 'lib'), rule: 'PR10' } },
  { name: 'PR5 a held gate keeps the draft (no PR10)', fx: { config: (c) => twoRepoConfig(c, 'local'), job: atPr([vr(1, 10, true)], { pr: { ...OPEN_PR, isDraft: true } }), events: [ev('pr-opened', 11)] }, want: { action: 'run', rule: 'PR5' } },
  { name: 'PR4 after a release: auto-merges once the local gate is released', fx: { config: (c) => (twoRepoConfig(c, 'local'), (c.merge.auto = true)), job: atPr([vr(1, 10, true)]), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11), REL(12)] }, want: { ...run('pr', 'merge', 'j'), rule: 'PR4' } },
  { name: 'PR2 after a release: PR4 holds off while a gate is bump-due', fx: { config: (c) => (linkedConfig(c, 'local'), (c.merge.auto = true)), job: atPr([vr(1, 10, true), vr(1, 13, false)]), decision: { decision: 'APPROVE' }, events: [APPROVED,ev('pr-opened', 11), REL(12), ev('human', 14, { action: 'approve' })] }, want: { ...run('verify', 'j'), rule: 'PR2' } },
  { name: 'PR3 counts pr-deferred as an open attempt', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true), vr(1, 14, true)], repos: libRepo('OPEN') }), events: [ev('pr-deferred', 11, { deferred: [SEQ] })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR3' } },
  { name: 'PR6 canary deferral waits on a human', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('OPEN') }), events: [ev('pr-deferred', 11, { deferred: [CANARY] })] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'the root repo waits on a canary of repo lib [@acme/lib@1.4.0-canary.0123456789ab]: a human runs forge job interim publish j lib --confirm') },
  { name: 'PR6 another version published does not count', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('OPEN') }), events: [ev('pr-deferred', 11, { deferred: [CANARY] }), ev('canary-published', 12, { repo: 'lib', name: '@acme/lib', version: '1.4.0-canary.ffffffffffff' })] }, want: { action: 'run', rule: 'PR6' } },
  { name: 'PR7 reopens once the canary is published', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('OPEN') }), events: [ev('pr-deferred', 11, { deferred: [CANARY] }), ev('canary-published', 12, { repo: 'lib', name: '@acme/lib', version: CANARY.version, sha: 'a'.repeat(40) })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR7' } },
  { name: 'PR7 reopens once dependencies merged', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('MERGED') }), events: [ev('pr-deferred', 11, { deferred: [SEQ] })] }, want: { ...run('pr', 'open', 'j'), rule: 'PR7' } },
  { name: 'PR8 sequential deferral waits on pr-review', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('OPEN') }), events: [ev('pr-deferred', 11, { deferred: [SEQ] })] }, want: run('job', 'set', 'j', '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review', '--reason', 'the root repo PR opens after repo lib merges [interim: sequential]') },
  { name: 'PR8 a forged deferral entry is ignored', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)], repos: libRepo('OPEN') }), events: [ev('pr-deferred', 11, { deferred: [SEQ, { repo: "x';id", why: 'sequential', waitingOn: ['lib'] }, { repo: null, why: 'canary', waitingOn: ['lib'] }] })] }, want: { action: 'run', rule: 'PR8' } },

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
  { name: 'hostile: a decision reason with $(id) stays out of commands', fx: { job: atDecide({ reason: 'ship it $(id)' }), decision: { decision: 'ESCALATE' }, events: [ev('decision', 22)] }, want: { action: 'run', rule: 'DC9b' } },
  { name: 'hostile: a decision reason with $(id) stays out of the PR15 park', fx: { job: atGate({ reason: 'ship it $(id)' }), decision: { decision: 'ESCALATE' }, events: [...gateEvents('ESCALATE'), PR15_SYNCED] }, want: { action: 'run', rule: 'PR15' } },
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
  // ---- Downstream verification (DS1)
  { name: 'DS1 adds consumers in build', fx: { config: dsConfig, job: job({ stage: 'build', round: 1 }) }, want: DS_RUN },
  { name: 'DS1 adds consumers in verify', fx: { config: dsConfig, job: job(DS_VERIFY) }, want: DS_RUN },
  { name: 'DS1 runs again for a candidate the last check does not name', fx: { config: dsConfig, job: job(DS_VERIFY), events: [DS_CHECKED(4, ['app-a'])] }, want: DS_RUN },
  { name: 'RP1 parks a pending proposal before DS1', fx: { config: dsConfig, job: job(DS_VERIFY), events: [ev('repo-proposed', 4, { repo: 'app-b', reason: 'x' })] }, want: { rule: 'RP1' } },
  { name: 'RP2 creates the worktrees DS1 added', fx: { config: dsConfig, job: job({ ...DS_VERIFY, repos: [{ repo: null } as any, DS_MEMBER('app-a'), DS_MEMBER('app-b')] }), memberWorktreesMissing: true, events: [DS_ADDED(3, 'app-a'), DS_ADDED(3, 'app-b'), DS_CHECKED(4, ['app-a', 'app-b'])] }, want: { ...run('worktree', 'create', 'j'), rule: 'RP2' } },
  {
    name: 'V3 names a failing downstream consumer',
    fx: {
      config: dsConfig,
      job: job({ ...DS_VERIFY, repos: [{ repo: null } as any, DS_MEMBER('app-a'), DS_MEMBER('app-b')], verifyRuns: [{ ...vr(1, 7, false, 'test'), repos: [{ repo: 'app-a', sha: 's', ok: true, failure: null }, { repo: 'app-b', sha: 's', ok: false, failure: 'test' }] }] }),
      events: [DS_ADDED(3, 'app-a'), DS_ADDED(3, 'app-b'), DS_CHECKED(4, ['app-a', 'app-b'])],
    },
    want: { ...run('job', 'set', 'j', '--stage', 'build', '--state', 'running'), why: 'verify failed: downstream consumer app-b failed test' },
  },
  {
    name: 'V3b keeps its reason when only an edited member failed',
    fx: {
      config: dsConfig,
      job: job({ ...DS_VERIFY, repos: [{ repo: null } as any, { ...DS_MEMBER('app-a'), verifyOnly: false, branch: 'forge/j' }, DS_MEMBER('app-b')], verifyRuns: [{ ...vr(1, 7, false, 'test'), repos: [{ repo: 'app-a', sha: 's', ok: false, failure: 'test' }, { repo: 'app-b', sha: 's', ok: true, failure: null }] }] }),
      events: [DS_ADDED(3, 'app-b'), DS_CHECKED(4, ['app-b'])],
    },
    want: { why: 'verify failed: back to the builder' },
  },

  // ---- One more row for each ID split off its family (issue #347), asserting its action and command
  { name: 'G3b stops a running environment and background processes while the PR waits', fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', pr: OPEN_PR }), environment: 'running', runtime: ['dev'] }, want: { ...run('environment', 'stop', 'j'), rule: 'G3b' } },
  { name: 'G3c waits on review once nothing holds the PR', fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', pr: OPEN_PR }) }, want: { action: 'wait', rule: 'G3c', waitingOn: 'pr-review', running: [], tell: 'j PR https://github.com/o/r/pull/3 waits on review' } },
  { name: 'G4b waits on a human answer', fx: { job: job({ stage: 'spec', state: 'waiting', waitingOn: 'input' }) }, want: { action: 'wait', rule: 'G4b', waitingOn: 'input', running: [], tell: `j has questions: ${path.join(JOB_DIR, 'questions.md')}. /forge answer j <text>` } },
  { name: 'N1b parks a planner that asked', fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2, { summary: 'PLAN: NEEDS-INPUT' }) } }) }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'input', '--reason', 'planner has questions') },
  {
    name: "P2b a person's approve-split after the planner follows split.md",
    fx: { job: job({ stage: 'plan', agents: { planner: ag(0, 1, 2) } }), plan: { verdict: 'SPLIT', jobs: 2 }, events: [ev('human', 3, { action: 'approve-split', actor: { login: 'alice', source: 'cli' } })] },
    want: { action: 'procedure', rule: 'P2b', why: 'PLAN: SPLIT approved', reference: path.join(path.resolve(import.meta.dirname, '..'), 'skills', 'forge', 'reference', 'split.md') },
  },
  { name: 'B6b an eval job one round past maxRounds goes to decide', fx: { job: job({ kind: 'eval', eval: { run: 'r', task: 'hello' }, stage: 'build', round: 3, maxRounds: 2, agents: { builder: ag(2, 5, 6) } }), events: [ev('round', 7)] }, want: run('job', 'set', 'j', '--stage', 'decide', '--state', 'running', '--reason', 'eval: round 3 exceeds maxRounds 2') },
  {
    name: 'VF2b retries the verifier with --retry and its answers as output',
    fx: { verifiers: 1, job: job({ stage: 'verify', round: 1, verifyRuns: [vr(1, 7, true)], agents: { builder: ag(1, 5, 6), verifier: ag(1, 9, 10, { outputMissing: true }) } }), events: [VF_RUN] },
    want: { action: 'spawn', role: 'verifier', retry: true, start: ['job', 'agent', 'j', 'start', '--role', 'verifier', '--model', 'haiku', '--output', VF_ANSWERS, '--retry'] },
  },
  { name: 'V2b a passing PR rework under onPrFeedback changed goes to review', fx: { job: job({ stage: 'verify', round: 2, verifyRuns: [vr(2, 7, true)], agents: { builder: ag(2, 5, 6) }, pr: OPEN_PR }) }, want: run('job', 'set', 'j', '--stage', 'review', '--state', 'running') },
  { name: 'V3b a failure in round 2 goes back to build', fx: { job: job({ stage: 'verify', round: 2, verifyRuns: [vr(1, 4, true), vr(2, 7, false)], agents: { builder: ag(2, 5, 6) } }) }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
  {
    name: 'RV5b two lenses malformed after their retries count as CHANGES',
    fx: { job: inReview({ 'reviewer:code': ag(1, 12, 13, { outputMissing: false, retry: true }), 'reviewer:tests': ag(1, 12, 13, { outputMissing: false, retry: true }) }), events: scoped, verdicts: { round: verdicts({ code: 'MALFORMED', tests: 'MALFORMED' }) } },
    want: run('job', 'verdicts', 'j', '--malformed', 'changes'),
  },
  { name: 'RV8b an eval job with a one-lens pass skips integrate', fx: { job: inReview({}, { kind: 'eval', eval: { run: 'r', task: 'hello' }, reviewers: ['code'], verdicts: { 1: { code: 'PASS' } } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'decide', '--state', 'running') },
  { name: 'RV8c a three-lens pass goes to integrate', fx: { job: inReview({}, { reviewers: ['code', 'tests', 'security'], verdicts: { 1: { code: 'PASS', tests: 'PASS', security: 'PASS' } } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'integrate', '--state', 'running') },
  { name: 'RV8d one CHANGES among three lenses starts the next round', fx: { job: inReview({}, { reviewers: ['code', 'tests', 'security'], verdicts: { 1: { code: 'PASS', tests: 'PASS', security: 'CHANGES' } } }), events: scoped }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
  { name: 'IG2b a failing verify after a merge on an open PR goes to build', fx: { job: atIntegrate({ pr: OPEN_PR, verifyRuns: [vr(1, 10, true), vr(1, 32, false)] }), events: routedMerged }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
  {
    name: 'IG7b the last of two verifies after the resolution failed escalates',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true), vr(1, 38, false)], agents: { integrator: ag(1, 33, 36) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })] },
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'integration: verify failed after conflict resolution'),
  },
  {
    name: 'IG12 the integration reviewer retries with --retry and the integration review as output',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })], verdicts: { integration: verdicts({ code: 'MALFORMED' }) } },
    want: { action: 'spawn', role: 'reviewer:code', retry: true, start: ['job', 'agent', 'j', 'start', '--role', 'reviewer:code', '--model', 'sonnet', '--output', path.join(JOB_DIR, 'review', 'integration', 'code.md'), '--retry'] },
  },
  {
    name: 'IG13 a malformed integration review after its retry counts as CHANGES',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false, retry: true }) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })], verdicts: { integration: verdicts({ code: 'MALFORMED' }) } },
    want: run('job', 'verdicts', 'j', '--round', 'integration', '--malformed', 'changes'),
  },
  {
    name: 'IG10b CHANGES on an open PR: the integrator resumes',
    fx: { config: (c) => (c.pr.conflicts = 'fix'), job: atIntegrate({ pr: OPEN_PR, verifyRuns: [vr(1, 10, true), vr(1, 37, true)], agents: { integrator: ag(1, 33, 36), 'reviewer:code': ag(1, 38, 39, { outputMissing: false }) } }), events: [...routed, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'CHANGES' })] },
    want: { action: 'spawn', role: 'integrator', resume: 'a33', start: ['job', 'agent', 'j', 'start', '--role', 'integrator', '--model', 'sonnet'] },
  },
  {
    name: 'IG10c CHANGES after two integrator runs on an open PR escalates',
    fx: {
      config: (c) => (c.pr.conflicts = 'fix'),
      job: atIntegrate({ pr: OPEN_PR, verifyRuns: [vr(1, 10, true), vr(1, 46, true)], agents: { integrator: ag(1, 41, 45), 'reviewer:code': ag(1, 47, 48, { outputMissing: false }) } }),
      events: [...routed, conflicts, ev('agent-start', 33, { role: 'integrator' }), ev('integration-review', 40, { outcome: 'CHANGES' }), ev('agent-start', 41, { role: 'integrator' }), ev('integration-review', 49, { outcome: 'CHANGES' })],
    },
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'integration review: CHANGES'),
  },
  { name: 'PR2b a merge pull after verify verifies the merged HEAD', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('pr-head-pulled', 12, { pulled: 'merge', head: 'a'.repeat(40) })] }, want: { ...run('verify', 'j'), why: 'the PR branch moved on the remote and was merged in: verify the merged HEAD' } },
  {
    name: 'PR9b an approve before the failed bump verify still parks',
    fx: { config: (c) => linkedConfig(c, 'git-ref'), job: atPr([vr(1, 10, true), vr(1, 13, false)]), events: [ev('pr-opened', 11), REL(12), ev('human', 12, { action: 'approve' })] },
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'release bump: verify failed after the release of repo lib 1.2.0'),
  },
  {
    name: 'PR9c two passing verifies after the release without a bump park',
    fx: { config: (c) => linkedConfig(c, 'git-ref'), job: atPr([vr(1, 10, true), vr(1, 13, true), vr(1, 14, true)]), events: [ev('pr-opened', 11), REL(12)] },
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'release bump: verify passed without bumping the root repo'),
  },
  {
    name: 'SC1b parks a blocked verify in integrate after an earlier integrator run',
    fx: { job: atIntegrate({ verifyRuns: [vr(1, 10, true), vr(1, 40, false, 'secrets')], agents: { integrator: ag(1, 33, 36) } }), events: [entered, conflicts, ev('agent-start', 33, { role: 'integrator' })] },
    want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked verify round 1'),
  },
  { name: 'SC3b parks a refused pr open newer than the last update', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('pr-updated', 11), ev('secret-found', 12, { gate: 'pr', blocked: true, count: 2 })] }, want: run('job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'secret scan blocked pr open') },
  { name: 'PP2b a refusal after the last pr update goes back to build', fx: { job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }), events: [ev('pr-updated', 11), ev('protected-path', 12, { gate: 'pr', action: 'refuse', blocked: true })] }, want: run('job', 'set', 'j', '--stage', 'build', '--state', 'running') },
];

/** RC1's negative cases: another rule decides, so they can't be `rows`; run by test/step.test.ts. */
export const recallSkips: Row[] = [
  { name: 'recall: lib/step/order.ts is no reviewer prompt', fx: { job: freshDecide(), recall: { changed: ['lib/step/order.ts'] } }, want: { action: 'spawn', rule: 'DC1' } },
  { name: 'recall: docs/CLI.md is no reviewer prompt', fx: { job: freshDecide(), recall: { changed: ['docs/CLI.md'] } }, want: { action: 'spawn', rule: 'DC1' } },
  { name: "recall: the repo's .forge/reviewers/code.md is not a gate path", fx: { job: freshDecide(), recall: { changed: ['.forge/reviewers/code.md'] } }, want: { action: 'spawn', rule: 'DC1' } },
  { name: 'recall: no fixtures in the main checkout, no gate', fx: { job: freshDecide(), recall: { changed: ['agents/x.md'], fixtures: false } }, want: { action: 'spawn', rule: 'DC1' } },
  { name: 'recall: an eval job has no gate', fx: { job: freshDecide({ kind: 'eval', eval: { run: 'r', task: 'hello' } }), recall: { changed: ['agents/x.md'] }, evalTask: { rubric: null, reference: null } }, want: { action: 'spawn', rule: 'DC1' } },
];

// Helpers the other step tests build their own rows from.
export { job, run, vr, ag, ev, panelled, scoped, inReview, OPEN_PR, dsConfig, DS_VERIFY, DS_CHECKED, SPEC_DONE, PANEL_SET, atIntegrate, entered };
