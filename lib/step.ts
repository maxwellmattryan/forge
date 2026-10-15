// `forge job step`: the one decider of pipeline transitions, the way the CLI is already the one
// writer of state. `step` is pure: it reads a StepInput (everything loadStepInput read once) and
// returns the next action, so the same state always gives the same answer and every rule is a
// table row in test/step.test.ts. It never writes; the orchestrator runs what it returns.
//
// Rule IDs follow the spec of issue #68. Every command it emits is built from ids, numbers, config
// names and fixed templates, never from file contents or agent replies, and shellLine refuses an
// argument outside a strict class, so an unattended daemon can run the result as-is.
import path from 'node:path';
import { acCoverage } from './acs.ts';
import { jobPathMap, renderBrief, roleBrief } from './brief.ts';
import type { RoleContext } from './brief.ts';
import { resolveEffort, reviewerChecklist } from './config.ts';
import { loadTask } from './evals.ts';
import { issueLinkStatus, prLinkNote } from './issue-link.ts';
import { jobDir, loadJob, parseDecision, readEvents, requestBody, roundVerdicts } from './jobs.ts';
import { PLUGIN_ROOT, exists } from './paths.ts';
import { approachPaths, inSpec } from './scope.ts';
import type { Config, Job, JobAgent, JobEvent, StepAction, StepDone, StepFile, StepInput, StepProcedure, StepRun, StepSpawn, StepVerdicts, StepWait, StepWaitingOn, VerifyRun, WaitingOn } from './types.ts';
import { ForgeError, SAFE_REF, readJson, readText } from './util.ts';

export const RULES = [
  'G1', 'G2', 'G3', 'G4', 'G5', 'L1', 'N1', 'N2', 'M1', 'M2', 'K1', 'K2',
  'I1', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8',
  'P1', 'P2', 'P3', 'P4', 'P5',
  'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
  'D1', 'D2', 'D3',
  'B1', 'B2', 'B3', 'B4', 'B5',
  'V1', 'V2', 'V3',
  'RV1', 'RV2', 'RV3', 'RV4', 'RV5', 'RV6', 'RV7', 'RV8',
  'DC1', 'DC2', 'DC3', 'DC4', 'DC5', 'DC6', 'DC7', 'DC8', 'DC9',
  'IG1', 'IG2', 'IG3', 'IG4', 'IG5', 'IG6', 'IG7', 'IG8', 'IG9', 'IG10',
  'PR1', 'PR2', 'PR3', 'PR4', 'PR5',
  // No rule matched: a state step can't advance, parked visibly instead of looping.
  'X1',
] as const;

export type RuleId = (typeof RULES)[number];

/** Request bodies above this, or with this many list or heading lines, get a planner under `pipeline.plan: auto`. */
export const PLAN_AUTO_CHARS = 600;
export const PLAN_AUTO_LINES = 3;

const LENS_NAME = /^[a-z0-9][a-z0-9-]*$/;
const NEEDS_INPUT = /\bNEEDS-INPUT\b/i;
const UI_LENSES = ['ui', 'ux', 'accessibility'];
const SAFE_ELEMENT = /^[A-Za-z0-9 ._:/@=,+\-[\]"]*$/;
const BARE_ELEMENT = /^[A-Za-z0-9._:/@=,+-]+$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/;

/** Events loadStepInput keeps; everything else in events.jsonl is noise to step. */
const STEP_EVENTS = new Set([
  'human', 'round', 'worktree', 'worktree-setup-failed', 'pr-find', 'pr-adopted', 'scope', 'integrated', 'integrate-conflicts',
  'integration-review', 'decision', 'fields', 'pr-opened', 'pr-updated', 'pr-merged', 'pr-auto-merge', 'pr-merge-deferred',
  'pr-merge-refused', 'pr-merge-failed', 'eval-graded', 'transition', 'agent-start', 'agent-end',
]);
const MERGE_EVENTS = ['pr-merged', 'pr-auto-merge', 'pr-merge-deferred', 'pr-merge-refused', 'pr-merge-failed'];

// ---------- shell rendering ----------

/**
 * One ready-to-run command line. Every element is checked against the class the spec allows, so a
 * value that would need escaping is a bug in step, not something to quote around.
 */
export function shellLine(argv: string[]): string {
  for (const a of argv) {
    if (!SAFE_ELEMENT.test(a) || a.includes("'")) throw new ForgeError(`forge job step built an unsafe argument ${JSON.stringify(a)}; this is a bug in Forge`);
  }
  return 'forge ' + argv.map((a) => (BARE_ELEMENT.test(a) ? a : `'${a}'`)).join(' ');
}

// ---------- reading ----------

/**
 * List and heading lines in a request, for `pipeline.plan: auto`. Imported issue bodies are
 * blockquoted, so `> - item` and `> ## Heading` count as well.
 */
export function listLineCount(body: string): number {
  return body.split('\n').filter((l) => /^[\s>]*(?:[-*]|\d+\.)\s|^[\s>]*#/.test(l)).length;
}

/** Every read step needs, and nothing else: no directory is created and no file or event is written. */
export function loadStepInput(root: string, config: Config, id: string): StepInput {
  const job = loadJob(root, id);
  const dir = jobDir(root, job.id);
  const at = (name: string) => path.join(dir, name);
  const read = (name: string) => (exists(at(name)) ? readText(at(name)) : null);
  const paths = jobPathMap(root, config, job);
  const files: Record<StepFile, boolean> = {
    request: exists(at('request.md')),
    plan: exists(at('plan.md')),
    spec: exists(at('spec.md')),
    design: exists(at('design.md')),
    mockup: exists(at('mockup.html')),
    build: exists(at('build.md')),
    tasks: exists(at('tasks.md')),
    questions: exists(at('questions.md')),
    feedback: exists(at('feedback.md')),
    prFeedback: exists(at('pr-feedback.md')),
    runbook: exists(at('runbook.md')),
    decision: exists(at('decision.md')),
    scope: exists(at('scope.md')),
    issueCandidates: exists(at('issue-candidates.md')),
    evalJudge: exists(at('eval-judge.md')),
  };
  const present = Object.values(paths).filter((v): v is string => typeof v === 'string' && exists(v));
  const body = requestBody(root, job.id);
  const specText = read('spec.md') ?? '';
  const lenses = roundLenses(job, config);
  const compact = (v: ReturnType<typeof roundVerdicts>): StepVerdicts => ({
    complete: v.complete,
    outcome: v.outcome,
    reviewers: Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, { verdict: String(r.verdict) }])),
  });
  let runtime: string[] = [];
  try {
    const rt = readJson(at('runtime.json'), {});
    runtime = rt && typeof rt === 'object' ? Object.keys(rt).filter((k) => rt[k] && typeof rt[k] === 'object') : [];
  } catch {}
  let evalTask: StepInput['evalTask'] = null;
  if (job.eval?.task) {
    try {
      const t = loadTask(root, job.eval.task);
      evalTask = { rubric: t.rubric, reference: t.reference };
    } catch {}
  }
  const names = [...new Set([...config.review.panel.map((p) => p.name), ...job.reviewers])];
  return {
    job,
    config,
    root,
    jobDir: dir,
    pluginRoot: PLUGIN_ROOT,
    paths,
    files,
    present,
    worktreeExists: Boolean(job.worktree && exists(job.worktree)),
    request: { length: body.length, listLines: listLineCount(body) },
    plan: parsePlan(read('plan.md') ?? ''),
    spec: { ...parseSpecHeader(specText), approachPaths: approachPaths(specText) },
    designDeltas: hasSpecDeltas(read('design.md') ?? ''),
    decision: { decision: parseDecision(root, job.id).decision, autoMerge: /^\s*(?:[-*]\s*)?Auto-merge eligible:\s*yes\b/im.test(read('decision.md') ?? '') },
    runbookBeforeMerge: /^\s*(?:[-*]\s*)?When:\s*before merge\b/im.test(read('runbook.md') ?? ''),
    verdicts: {
      round: job.round >= 1 && lenses.length ? compact(roundVerdicts(root, job.id, job.round, lenses, config.review.blockOn)) : null,
      integration: job.stage === 'integrate' ? compact(roundVerdicts(root, job.id, 'integration', ['code'], config.review.blockOn)) : null,
    },
    acs: acCoverage(read('spec.md'), read('build.md')),
    runtime,
    events: readEvents(root, job.id).filter((e) => STEP_EVENTS.has(e.type)),
    evalTask,
    checklists: Object.fromEntries(names.map((n) => [n, reviewerChecklist(root, n, config.review.panel.find((p) => p.name === n)?.checklist)])),
  };
}

export function parsePlan(text: string): StepInput['plan'] {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const m = /^\s*PLAN:\s*(SINGLE|SPLIT)\b/i.exec(first);
  let jobs = 0;
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) inJobs = /^##\s+Jobs\b/i.test(line);
    else if (inJobs && /^\s*\d+[.)]\s/.test(line)) jobs++;
  }
  return { verdict: m ? (m[1].toUpperCase() as 'SINGLE' | 'SPLIT') : null, jobs, recommendSplit: /^\s*- Recommend splitting:/m.test(text) };
}

/** The header lines above the first `## ` heading; list values are split and trimmed but not filtered. */
export function parseSpecHeader(text: string): Omit<StepInput['spec'], 'approachPaths'> {
  const head = text.split(/^## /m)[0];
  const value = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'mi').exec(head)?.[1].trim() ?? null;
  const items = (v: string | null) => (!v || v === '-' ? [] : v.split(',').map((s) => s.trim()).filter((s) => s && s !== '-'));
  return {
    size: value('Size'),
    needsDesign: /^yes\b/i.test(value('Needs design') ?? ''),
    services: items(value('Services')),
    suggested: items(value('Suggested reviewers')),
  };
}

export function hasSpecDeltas(text: string): boolean {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+Spec deltas\b/i.test(l));
  if (start < 0) return false;
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(l)) break;
    const t = l.replace(/^\s*[-*]\s*/, '').trim().replace(/^["'`*_]+|["'`*_]+$/g, '');
    if (t) body.push(t);
  }
  return body.length > 0 && !(body.length === 1 && /^(none|n\/a|-)\.?$/i.test(body[0]));
}

// ---------- panel and lenses ----------

const alwaysLenses = (config: Config) => config.review.panel.filter((p) => p.always).map((p) => p.name);

/**
 * The lenses this round reviews. A PR rework (`pr.state` OPEN) follows `review.onPrFeedback`:
 * `changed` means the always-on lenses, because what changed needs the diff and step stays pure.
 */
export function roundLenses(job: Pick<Job, 'reviewers' | 'pr'>, config: Config): string[] {
  // job.reviewers is settable with --field, so a name that isn't a plain lens is dropped, never quoted.
  const base = (job.reviewers.length ? job.reviewers : alwaysLenses(config)).filter((l) => LENS_NAME.test(l));
  if (job.pr?.state !== 'OPEN') return base;
  if (config.review.onPrFeedback === 'none') return [];
  return config.review.onPrFeedback === 'full' ? base : alwaysLenses(config).filter((l) => LENS_NAME.test(l));
}

/** Path-like tokens in a lens's `when` text; prose-only `when`s are left to the spec-writer's suggestion. */
export function whenTokens(when: string | undefined): string[] {
  return String(when ?? '')
    .split(/[,\s]+/)
    .map((t) => t.replace(/^["'`([]+/, '').replace(/["'`)\];:.,]+$/, ''))
    .filter((t) => t && (t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t)));
}

/** SP3: always lenses, the suggested ones in the panel, and the ones whose `when` paths the Approach names, in panel order. */
export function selectPanel(x: Pick<StepInput, 'job' | 'config' | 'spec'>): string[] {
  if (x.job.kind === 'retro') return ['code', 'docs'];
  const panel = x.config.review.panel.filter((p) => LENS_NAME.test(p.name));
  const names = panel.map((p) => p.name);
  const suggested = new Set(x.spec.suggested.filter((n) => LENS_NAME.test(n) && names.includes(n)));
  return panel
    .filter((p) => {
      if (p.always || suggested.has(p.name)) return true;
      const tokens = whenTokens(p.when);
      return tokens.length > 0 && x.spec.approachPaths.some((ap) => inSpec(ap, tokens));
    })
    .map((p) => p.name);
}

function modelOf(config: Config, role: string): string {
  if (role.startsWith('reviewer:')) {
    const lens = role.slice('reviewer:'.length);
    return config.review.panel.find((p) => p.name === lens)?.model ?? config.runtime.models.reviewer ?? 'inherit';
  }
  return config.runtime.models[role] ?? 'inherit';
}

// ---------- state helpers ----------

const ended = (a: JobAgent | undefined): a is JobAgent => Boolean(a?.endedAt && a.status !== 'running');
const endedIn = (a: JobAgent | undefined, round: number): a is JobAgent => ended(a) && a.round === round;
const startedIn = (a: JobAgent | undefined, round: number) => Boolean(a?.startedAt && a.round === round);
/** `ts` happened, after `than` (or `than` never did). ISO timestamps from now() order as strings. */
const after = (ts: string | null | undefined, than: string | null | undefined): boolean => Boolean(ts) && (!than || (ts as string) > than);
const safe = (v: string | null | undefined, re: RegExp, fallback: string) => (v && re.test(v) ? v : fallback);

const agent = (x: StepInput, role: string): JobAgent | undefined => x.job.agents[role];
const lastEvent = (x: StepInput, pred: (e: JobEvent) => boolean): JobEvent | undefined => x.events.findLast(pred);
const human = (x: StepInput, action: string) => lastEvent(x, (e) => e.type === 'human' && e.action === action);
const lastVerify = (x: StepInput): VerifyRun | undefined => x.job.verifyRuns.filter((r) => r.round === x.job.round).at(-1);
const p = (x: StepInput, key: string) => String(x.paths[key]);
const ref = (x: StepInput, name: string) => path.join(x.pluginRoot, 'skills', 'forge', 'reference', name);

/** When the job last entered its current stage from another one: transitions within a stage (a gate and back) don't count. */
function stageSince(x: StepInput): string | null {
  const t = lastEvent(x, (e) => {
    if (e.type !== 'transition') return false;
    const to = e.to as { stage?: string } | null;
    const from = e.from as { stage?: string } | null;
    return to?.stage === x.job.stage && from?.stage !== x.job.stage;
  });
  return t?.ts ?? null;
}

const splitMode = (x: StepInput) => x.job.splitMode ?? x.config.pipeline.split;

function planningNeeded(x: StepInput): boolean {
  const mode = x.config.pipeline.plan;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return x.request.length > PLAN_AUTO_CHARS || x.request.listLines >= PLAN_AUTO_LINES;
}

const isPrRework = (x: StepInput) => x.job.pr?.state === 'OPEN';

// ---------- action builders ----------

function run(x: StepInput, rule: RuleId, command: string[], why: string, tell?: string): StepRun {
  return { action: 'run', rule, id: x.job.id, command, shell: shellLine(command), why, ...(tell ? { tell } : {}) };
}

/** `job set` with only the flags given, in a fixed order. */
function set(x: StepInput, rule: RuleId, c: { stage?: string; state?: string; waitingOn?: WaitingOn; reason?: string; note?: string; fields?: string[] }, why: string, tell?: string): StepRun {
  const argv = ['job', 'set', x.job.id];
  for (const f of c.fields ?? []) argv.push('--field', f);
  if (c.stage) argv.push('--stage', c.stage);
  if (c.state) argv.push('--state', c.state);
  if (c.waitingOn) argv.push('--waiting-on', c.waitingOn);
  if (c.reason) argv.push('--reason', c.reason);
  if (c.note) argv.push('--note', c.note);
  return run(x, rule, argv, why, tell);
}

const toStage = (x: StepInput, rule: RuleId, stage: string, why: string, extra: { note?: string; tell?: string } = {}) =>
  set(x, rule, { stage, state: stage === 'done' ? 'done' : 'running', note: extra.note }, why, extra.tell);

const park = (x: StepInput, rule: RuleId, waitingOn: WaitingOn, reason: string, note?: string) =>
  set(x, rule, { state: 'waiting', waitingOn, reason, note }, `wait on ${waitingOn}`);

const runningRoles = (x: StepInput) => Object.keys(x.job.agents).filter((r) => x.job.agents[r].status === 'running').sort();

function wait(x: StepInput, rule: RuleId, waitingOn: StepWaitingOn, tell?: string): StepWait {
  return { action: 'wait', rule, id: x.job.id, waitingOn, running: runningRoles(x), ...(tell ? { tell } : {}) };
}

function procedure(x: StepInput, rule: RuleId, name: string, why: string): StepProcedure {
  return { action: 'procedure', rule, id: x.job.id, reference: ref(x, name), why };
}

function done(x: StepInput, rule: RuleId, tell?: string): StepDone {
  return { action: 'done', rule, id: x.job.id, state: x.job.state, ...(tell ? { tell } : {}) };
}

/** The single output step names for a role, absolute; builders and integrators have none. */
function outputFor(x: StepInput, role: string): string | undefined {
  if (role.startsWith('reviewer:')) {
    const lens = role.slice('reviewer:'.length);
    return x.job.stage === 'integrate' ? p(x, 'integrationReview') : path.join(x.jobDir, 'review', `round-${x.job.round}`, `${lens}.md`);
  }
  const fixed: Record<string, string> = { planner: 'plan.md', 'spec-writer': 'spec.md', designer: 'design.md', approver: 'decision.md', judge: 'eval-judge.md' };
  return fixed[role] ? path.join(x.jobDir, fixed[role]) : undefined;
}

/** The builder's rework inputs this spawn, in the order its brief lists them. */
function builderRework(x: StepInput): NonNullable<RoleContext['rework']> {
  const j = x.job;
  const b = agent(x, 'builder');
  const lv = lastVerify(x);
  const reworkEv = human(x, 'rework');
  const out: NonNullable<RoleContext['rework']> = [];
  const prev = j.verdicts[String(j.round - 1)];
  if (j.round > 1 && prev && Object.values(prev).some((v) => v !== 'PASS')) out.push('review');
  if (lv && !lv.ok && after(lv.at, b?.endedAt)) out.push('verify');
  if (isPrRework(x) && x.files.prFeedback) out.push('pr-feedback');
  if (x.files.feedback && (j.round > 1 || reworkEv)) out.push('feedback');
  if (x.files.questions && human(x, 'answer')) out.push('answer');
  return out;
}

function lastConflicts(x: StepInput): JobEvent | undefined {
  return lastEvent(x, (e) => e.type === 'integrate-conflicts');
}

/** A spawn of `role` with the context its stage implies. */
function spawn(x: StepInput, rule: RuleId, role: string, o: { resume?: boolean; retry?: boolean; retryLine?: string; answered?: boolean } = {}): StepSpawn {
  const j = x.job;
  const base = role.split(':')[0];
  const lens = base === 'reviewer' ? role.slice('reviewer:'.length) : undefined;
  const output = outputFor(x, role);
  const ctx: RoleContext = { lens, output: base === 'reviewer' ? output : undefined, answered: o.answered };
  if (o.retry) ctx.retry = o.retryLine ?? `Retry: ${output} was not written last time; write it before you reply.`;
  const conflicts = lastConflicts(x);
  const conflictFiles = Array.isArray(conflicts?.conflicts) ? (conflicts.conflicts as unknown[]).map(String) : [];
  const regenerated = Array.isArray(conflicts?.regenerated) ? (conflicts.regenerated as unknown[]).map(String) : [];
  if (base === 'planner') ctx.splitMode = splitMode(x);
  if (base === 'spec-writer') ctx.foldIn = j.stage === 'design';
  if (base === 'designer') ctx.mode = x.config.pipeline.design === 'mockup' && j.kind !== 'eval' ? 'mockup' : 'reference';
  if (base === 'builder') ctx.rework = builderRework(x);
  if (base === 'reviewer' && j.stage === 'integrate') ctx.integration = { conflicts: conflictFiles };
  if (base === 'integrator') {
    // The fix pass: an integration review of this episode's resolution asked for changes.
    const review = lastEvent(x, (e) => e.type === 'integration-review');
    ctx.integration = { conflicts: conflictFiles, regenerated, fix: Boolean(review && review.outcome === 'CHANGES' && after(review.ts, conflicts?.ts)) };
    ctx.strategy = j.pr?.state === 'OPEN' ? x.config.pr.updateStrategy : 'rebase';
  }
  const model = modelOf(x.config, role);
  const a = agent(x, role);
  const resume = o.resume && a?.agentId && AGENT_ID.test(a.agentId) ? a.agentId : undefined;
  const parallel = base === 'reviewer' && j.stage === 'review';
  const start = ['job', 'agent', j.id, 'start', '--role', role, '--model', model, ...(output ? ['--output', output] : []), ...(o.retry ? ['--retry'] : [])];
  return {
    action: 'spawn',
    rule,
    id: j.id,
    role,
    agent: `forge:${base}`,
    ...(lens ? { lens } : {}),
    model,
    round: j.round,
    ...(output ? { output } : {}),
    ...(o.retry ? { retry: true as const } : {}),
    ...(resume ? { resume } : {}),
    ...(parallel ? { parallel: true as const } : {}),
    start,
    startShell: shellLine(start),
    brief: renderBrief(x, roleBrief(x, role, ctx)),
    // Always present, so the orchestrator can tell "pass none" from an older Forge that never said.
    effort: resolveEffort(x.config, x.job).level,
  };
}

// ---------- generic per-role rules ----------

/** N1/N2: an agent that replied NEEDS-INPUT parks the job until a human answers, then resumes. */
function needsInput(x: StepInput, role: string): StepAction | null {
  const a = agent(x, role);
  if (!ended(a) || !a.summary || !NEEDS_INPUT.test(a.summary)) return null;
  if (!after(human(x, 'answer')?.ts, a.endedAt)) {
    if (x.job.kind === 'eval') return set(x, 'N1', { state: 'failed', reason: 'eval: NEEDS-INPUT fails the task' }, 'an eval agent asked a question');
    return park(x, 'N1', 'input', `${role} has questions`);
  }
  return spawn(x, 'N2', role, { resume: true, answered: true });
}

function outputMissing(x: StepInput, role: string): boolean {
  const a = agent(x, role);
  if (!ended(a)) return false;
  if (a.outputMissing !== undefined) return a.outputMissing;
  // A record from before agent end checked outputs: fall back to the review file's own state.
  if (role.startsWith('reviewer:')) {
    const v = x.job.stage === 'integrate' ? x.verdicts.integration : x.verdicts.round;
    return v?.reviewers[role.slice('reviewer:'.length)]?.verdict === 'MISSING';
  }
  return false;
}

/** M1/M2: a role that ended without its output gets one retry, then the job escalates. */
function missingOutput(x: StepInput, role: string, retryLine?: string): StepAction | null {
  if (!outputMissing(x, role)) return null;
  const a = agent(x, role)!;
  if (!a.retry) return spawn(x, 'M1', role, { retry: true, retryLine });
  const file = path.basename(outputFor(x, role) ?? 'output');
  const reason = role.startsWith('reviewer:') ? `reviewer ${role.slice('reviewer:'.length)} wrote no review` : `${role} wrote no ${file}`;
  return park(x, 'M2', 'escalation', reason, `${role} ended twice without writing ${file}`);
}

const generic = (x: StepInput, role: string) => needsInput(x, role) ?? missingOutput(x, role);

// ---------- gates ----------

function escalationFile(x: StepInput): string {
  switch (x.job.stage) {
    case 'plan':
      return p(x, 'plan');
    case 'spec':
    case 'design':
      return p(x, 'spec');
    case 'build':
    case 'verify':
      return p(x, 'verify');
    case 'review':
      return p(x, 'reviewDir');
    case 'integrate':
      return x.present.includes(p(x, 'integrationReview')) ? p(x, 'integrationReview') : p(x, 'build');
    default:
      return p(x, 'decision');
  }
}

/** What to tell the human at a gate: fixed text around ids, absolute paths, numbers and config names. */
export function gateTell(x: StepInput, waitingOn: WaitingOn): string {
  const j = x.job;
  const id = j.id;
  const reason = j.reason ?? 'no reason recorded';
  switch (waitingOn) {
    case 'spec-approval': {
      const line = `${id} spec ready: ${p(x, 'spec')}${x.files.mockup ? ` · mockup ${p(x, 'mockup')}` : ''}. /forge approve ${id} or /forge revise ${id} <note>`;
      // Computed live, so a job linked while it waits drops back to the one line.
      return issueLinkStatus(j, x.config) === 'missing' ? `${line}\n${gateTell(x, 'issue-link')}` : line;
    }
    case 'split-approval':
      return `${id} planner proposes ${x.plan.jobs} jobs: ${p(x, 'plan')}. /forge approve ${id} to create them, or /forge revise ${id} [note] to keep one job`;
    case 'issue-link':
      return `${id} needs an issue: candidates in ${path.join(x.jobDir, 'issue-candidates.md')} (untrusted). /forge approve ${id} <ref> | new | none [reason]`;
    case 'input':
      return `${id} has questions: ${p(x, 'questions')}. /forge answer ${id} <text>`;
    case 'escalation':
      return `${id} escalated (${reason}): see ${escalationFile(x)}. /forge approve ${id} or /forge rework ${id} <note>`;
    case 'rounds-exhausted':
      return `${id} used all ${j.maxRounds} rounds. /forge approve ${id} to ship, or /forge rework ${id} <note>`;
    case 'infra':
      return `${id} waits on runbook steps before merge: ${p(x, 'runbook')}. /forge continue ${id} when done`;
    case 'conflicts':
      return `${id} conflicts with ${safe(j.base, SAFE_REF, 'its base branch')}. /forge approve ${id} to have the integrator fix them`;
    case 'budget':
      return `${id} over budget: ${reason}. /forge approve ${id} to acknowledge, or raise it: forge job budget ${id} --set usd=…`;
    case 'pr-review':
      return prReviewTell(x);
    default:
      return `${id} waits: ${reason}`;
  }
}

function prReviewTell(x: StepInput): string {
  const j = x.job;
  const lines = [`${j.id} PR ${safe(j.pr?.url, SAFE_URL, `#${Number(j.pr?.number) || '?'}`)} waits on review`];
  if (prLinkNote(j, x.config).unlinked) lines.push(`${j.id} has no linked issue: \`forge job link ${j.id} <ref>\` or \`--none\``);
  return lines.join('\n');
}

// ---------- the decision ----------

/** The next action for the job. Pure: reads only `x`. */
export function step(x: StepInput): StepAction {
  return decide(x);
}

/** The role whose lost or failed run blocks the current stage (L1); reviewers go through M1/M2 instead. */
function blockedRole(x: StepInput): string | null {
  const j = x.job;
  const a = (r: string) => agent(x, r);
  const latest = (roles: string[]) => roles.filter((r) => a(r)?.startedAt).sort((m, n) => String(a(n)!.startedAt).localeCompare(String(a(m)!.startedAt)))[0] ?? null;
  let role: string | null = null;
  switch (j.stage) {
    case 'plan':
      role = 'planner';
      break;
    case 'spec':
      role = a('spec-writer') ? 'spec-writer' : null;
      break;
    case 'design':
      role = latest(['designer', 'spec-writer']);
      break;
    case 'build':
      role = a('builder')?.round === j.round ? 'builder' : null;
      break;
    case 'decide':
      role = latest(['approver', 'judge']);
      if (role === 'approver' && a('approver')?.round !== j.round) role = null;
      break;
    case 'integrate':
      role = after(a('integrator')?.startedAt, stageSince(x)) ? 'integrator' : null;
      break;
  }
  return role && ['lost', 'failed'].includes(String(a(role)?.status)) ? role : null;
}

function decide(x: StepInput): StepAction {
  const j = x.job;

  // Global
  if (j.state === 'done' || j.state === 'cancelled' || j.stage === 'done') {
    const tell = j.state === 'cancelled' ? `${j.id} is cancelled` : j.pr?.url ? `${j.id} is done: ${safe(j.pr.url, SAFE_URL, `PR #${Number(j.pr.number) || '?'}`)}` : `${j.id} finished on branch ${safe(j.branch, SAFE_REF, 'its branch')}`;
    return done(x, 'G1', tell);
  }
  if (j.state === 'failed') return done(x, 'G2', `${j.id} failed: ${j.reason ?? 'no reason recorded'}`);
  if (j.state === 'waiting' && j.waitingOn === 'pr-review') {
    if (j.owner) return run(x, 'G3', ['job', 'release', j.id], 'the PR waits on human review; let the claim go');
    if (x.runtime.length) return run(x, 'G3', ['stop', j.id], 'stop background processes while the PR waits');
    return wait(x, 'G3', 'pr-review', prReviewTell(x));
  }
  if (j.state === 'waiting' || j.state === 'blocked') {
    const on: WaitingOn = j.state === 'blocked' ? 'external' : (j.waitingOn ?? 'external');
    return wait(x, 'G4', on, gateTell(x, on));
  }
  if (runningRoles(x).length && !(j.stage === 'review' && (nextLens(x) || retryLens(x)))) return wait(x, 'G5', 'agents');
  const blocked = blockedRole(x);
  if (blocked) return spawn(x, 'L1', blocked);

  // Kind gates
  if (j.kind === 'retro') {
    const retro = agent(x, 'retro');
    if (!ended(retro) || !x.files.spec) return procedure(x, 'K1', 'retro.md', 'a retro job starts with the retro agent');
    if (j.stage === 'backlog') return toStage(x, 'K2', 'spec', 'the retro wrote spec.md');
  }

  switch (j.stage) {
    case 'backlog':
      return intake(x);
    case 'plan':
      return plan(x);
    case 'spec':
      return spec(x);
    case 'design':
      return design(x);
    case 'build':
      return build(x);
    case 'verify':
      return verify(x);
    case 'review':
      return review(x);
    case 'decide':
      return decideStage(x);
    case 'integrate':
      return integrate(x);
    case 'pr':
      return pr(x);
  }
  return stuck(x);
}

function stuck(x: StepInput): StepRun {
  return park(x, 'X1', 'escalation', `step found no rule for stage ${x.job.stage}`);
}

function intake(x: StepInput): StepAction {
  const j = x.job;
  // Intake only searches: the human picks the issue at the spec gate (SP5), or before build (SP7).
  if (issueLinkStatus(j, x.config) === 'missing' && !x.files.issueCandidates) return run(x, 'I1', ['job', 'link', j.id, '--suggest'], 'every job needs an issue: look for candidates');
  if (!x.worktreeExists) return run(x, 'I3', ['worktree', 'create', j.id], 'the job needs its worktree');
  const wt = lastEvent(x, (e) => e.type === 'worktree');
  const failed = lastEvent(x, (e) => e.type === 'worktree-setup-failed');
  if (failed && after(failed.ts, wt?.ts)) return set(x, 'I4', { state: 'failed', reason: 'worktree setup failed' }, 'the worktree setup command failed');
  if (x.config.pr.enabled && j.kind !== 'eval' && !j.pr && !lastEvent(x, (e) => e.type === 'pr-find' || e.type === 'pr-adopted')) return run(x, 'I5', ['pr', 'find', j.id], 'continue an existing PR instead of forking it');
  if (j.pr) return procedure(x, 'I6', 'pr-lifecycle.md', 'PR exists');
  if (planningNeeded(x)) return toStage(x, 'I7', 'plan', 'the request needs a plan');
  return toStage(x, 'I8', 'spec', 'the request is small enough to spec directly');
}

function plan(x: StepInput): StepAction {
  const j = x.job;
  const planner = agent(x, 'planner');
  if (!ended(planner) || after(human(x, 'revise-split')?.ts, planner.startedAt)) return spawn(x, 'P1', 'planner');
  const g = generic(x, 'planner');
  if (g) return g;
  if (x.plan.verdict === 'SPLIT') {
    if (splitMode(x) === 'auto') return procedure(x, 'P2', 'split.md', 'PLAN: SPLIT under pipeline.split auto');
    return set(x, 'P3', { stage: 'plan', state: 'waiting', waitingOn: 'split-approval', reason: `planner proposes ${x.plan.jobs} jobs` }, 'a human decides the split');
  }
  if (x.plan.verdict === 'SINGLE') return toStage(x, 'P4', 'spec', 'one job: write the spec', { tell: x.plan.recommendSplit ? `${j.id} plan recommends splitting: ${p(x, 'plan')}` : undefined });
  return park(x, 'P5', 'escalation', 'plan.md has no PLAN line');
}

/** When the spec was last written: the spec-writer's or the retro's end, whichever is later. */
function specAuthorEnd(x: StepInput): string | null {
  const ends = ['spec-writer', 'retro'].map((r) => agent(x, r)).filter(ended).map((a) => String(a.endedAt));
  return ends.sort().at(-1) ?? null;
}

function spec(x: StepInput): StepAction {
  const j = x.job;
  const c = x.config;
  const sw = agent(x, 'spec-writer');
  if (j.kind !== 'retro' && !ended(sw)) return spawn(x, 'SP1', 'spec-writer');
  if (after(human(x, 'revise-spec')?.ts, sw?.startedAt)) return spawn(x, 'SP2', 'spec-writer');
  if (sw) {
    const g = generic(x, 'spec-writer');
    if (g) return g;
  }
  const authored = specAuthorEnd(x);
  const panelEv = lastEvent(x, (e) => e.type === 'fields' && Boolean(e.fields && typeof e.fields === 'object' && 'reviewers' in (e.fields as object)));
  if (!after(panelEv?.ts, authored)) {
    const fields = [`reviewers=${JSON.stringify(selectPanel(x))}`];
    if (x.spec.size && /^[SML]$/.test(x.spec.size)) fields.push(`size=${x.spec.size}`);
    const services = x.spec.services.filter((s) => SAFE_REF.test(s) && c.services.some((cs) => cs.name === s));
    if (services.length) fields.push(`services=${JSON.stringify(services)}`);
    return set(x, 'SP3', { fields }, 'record the review panel the spec implies');
  }
  if (c.pipeline.design !== 'none' && x.spec.needsDesign && !ended(agent(x, 'designer'))) return toStage(x, 'SP4', 'design', 'the spec needs design');
  const size = j.size ?? x.spec.size;
  const gated = c.pipeline.specApproval === 'always' || (c.pipeline.specApproval === 'large' && size === 'L') || j.kind === 'retro';
  const missing = issueLinkStatus(j, c) === 'missing';
  if (gated && j.kind !== 'eval' && !after(human(x, 'approve-spec')?.ts, authored)) {
    // `, ` not ` · `: shellLine refuses characters outside its safe class.
    const reason = missing ? 'spec ready, issue unlinked' : 'spec ready';
    return set(x, 'SP5', { stage: 'spec', state: 'waiting', waitingOn: 'spec-approval', reason }, 'a human approves the spec');
  }
  // The builder never starts on an unlinked job: a spec approved without a link, or one no gate stopped.
  if (missing) return park(x, 'SP7', 'issue-link', 'link an issue before build');
  return toStage(x, 'SP6', 'build', 'the spec is ready to build');
}

function design(x: StepInput): StepAction {
  const d = agent(x, 'designer');
  if (!ended(d)) return spawn(x, 'D1', 'designer');
  const m = missingOutput(x, 'designer');
  if (m) return m;
  const sw = agent(x, 'spec-writer');
  const folding = after(sw?.startedAt, d.endedAt);
  if (x.designDeltas && !folding) return spawn(x, 'D2', 'spec-writer');
  if (folding) {
    const g = generic(x, 'spec-writer');
    if (g) return g;
  }
  return toStage(x, 'D3', 'spec', 'back to the spec gate with the design');
}

function build(x: StepInput): StepAction {
  const j = x.job;
  const b = agent(x, 'builder');
  const rework = human(x, 'rework');
  const lv = lastVerify(x);
  if (j.round === 0 || j.verdicts[String(j.round)] || after(rework?.ts, lastEvent(x, (e) => e.type === 'round')?.ts)) return run(x, 'B1', ['job', 'round', j.id], 'start the next build round');
  // A rework that came after the previous round started is the one that opened this round (B1), so the whole round is exempt. Comparing with the builder's start lost the exemption once the builder ran.
  if (j.round > j.maxRounds && !after(rework?.ts, x.events.filter((e) => e.type === 'round').at(-2)?.ts)) return park(x, 'B2', 'rounds-exhausted', `round ${j.round} exceeds maxRounds ${j.maxRounds}`);
  if (endedIn(b, j.round)) {
    const n = needsInput(x, 'builder');
    if (n) return n;
  }
  const runs = j.verifyRuns.filter((r) => r.round === j.round);
  const prev = runs.at(-2);
  if (lv && prev && !lv.ok && !prev.ok && lv.failure === 'integrity' && prev.failure === 'integrity' && b?.endedAt && after(b.endedAt, prev.at) && !after(b.endedAt, lv.at)) {
    return park(x, 'B3', 'escalation', 'integrity: verify failed twice on test integrity');
  }
  if (!startedIn(b, j.round) || (lv && !lv.ok && after(lv.at, b?.endedAt)) || after(rework?.ts, b?.startedAt)) return spawn(x, 'B4', 'builder', { resume: true });
  if (endedIn(b, j.round)) return toStage(x, 'B5', 'verify', 'the builder committed this round');
  return stuck(x);
}

function verify(x: StepInput): StepAction {
  const b = agent(x, 'builder');
  const lv = lastVerify(x);
  if (!lv || (b?.endedAt && !after(lv.at, b.endedAt))) return run(x, 'V1', ['verify', x.job.id], `verify the builder's round-${x.job.round} commits`);
  if (lv.ok) return isPrRework(x) && x.config.review.onPrFeedback === 'none' ? toStage(x, 'V2', 'pr', 'verify passed; PR feedback skips review') : toStage(x, 'V2', 'review', 'verify passed');
  return toStage(x, 'V3', 'build', 'verify failed: back to the builder');
}

/** RV4: the first lens of this round whose reviewer has not started yet; none once the round's verdicts are recorded. */
function nextLens(x: StepInput): string | null {
  if (x.job.verdicts[String(x.job.round)]) return null;
  return roundLenses(x.job, x.config).find((l) => !startedIn(agent(x, `reviewer:${l}`), x.job.round)) ?? null;
}

/** M1 in the review stage: the first lens of this round whose reviewer ended without its review and has not had its retry; none once the round's verdicts are recorded. */
function retryLens(x: StepInput): string | null {
  const j = x.job;
  if (j.verdicts[String(j.round)]) return null;
  return roundLenses(j, x.config).find((l) => {
    const a = agent(x, `reviewer:${l}`);
    // outputMissing(), not a.outputMissing: a pre-v6 record falls back to the MISSING verdict.
    return endedIn(a, j.round) && !a.retry && outputMissing(x, `reviewer:${l}`);
  }) ?? null;
}

function review(x: StepInput): StepAction {
  const j = x.job;
  const lenses = roundLenses(j, x.config);
  if (!lenses.length) return toStage(x, 'RV1', 'pr', 'no lens reviews this round');
  const lv = lastVerify(x);
  if (!x.events.some((e) => e.type === 'scope' && e.round === j.round && after(e.ts, lv?.at))) return run(x, 'RV2', ['job', 'scope', j.id], 'reviewers read the scope report');
  // Only until the round's verdicts are recorded: after that RV7 stops the server, and starting it
  // again here would alternate with that stop forever. Retries before then still get the app.
  const recordedVerdicts = Boolean(j.verdicts[String(j.round)]);
  if (!recordedVerdicts && lenses.some((l) => UI_LENSES.includes(l)) && x.config.commands.dev && !x.runtime.includes('dev')) return run(x, 'RV3', ['run', j.id, 'dev', '--background'], 'UI lenses review the running app');
  const next = nextLens(x);
  if (next) return spawn(x, 'RV4', `reviewer:${next}`);
  // Retries go out back to back like first spawns, even while other reviewers run (G5 lets them through).
  const retry = retryLens(x);
  if (retry) return missingOutput(x, `reviewer:${retry}`)!;
  for (const l of lenses) {
    const m = missingOutput(x, `reviewer:${l}`);
    if (m) return m;
  }
  const differs = lenses.join(',') !== j.reviewers.join(',');
  const verdictsCmd = (extra: string[]) => ['job', 'verdicts', j.id, '--compact', ...extra, ...(differs ? ['--reviewers', lenses.join(',')] : [])];
  const v = x.verdicts.round;
  const malformed = lenses.filter((l) => v?.reviewers[l]?.verdict === 'MALFORMED');
  if (malformed.length && !j.verdicts[String(j.round)]) {
    const fresh = malformed.find((l) => !agent(x, `reviewer:${l}`)?.retry);
    if (fresh) {
      const file = path.join(x.jobDir, 'review', `round-${j.round}`, `${fresh}.md`);
      return spawn(x, 'RV5', `reviewer:${fresh}`, { retry: true, retryLine: `Retry: ${file} has no VERDICT line; rewrite it in the required format.` });
    }
    return run(x, 'RV5', verdictsCmd(['--malformed', 'changes']), 'a lens failed the review format twice: count it as CHANGES');
  }
  if (!j.verdicts[String(j.round)]) {
    if (v?.complete) return run(x, 'RV6', verdictsCmd([]), 'record this round\'s verdicts');
    return stuck(x);
  }
  if (x.runtime.length) return run(x, 'RV7', ['stop', j.id], 'the review is over: stop the dev server');
  const recorded = j.verdicts[String(j.round)];
  if (Object.values(recorded).every((r) => r === 'PASS')) return isPrRework(x) ? toStage(x, 'RV8', 'pr', 'the PR rework passed review') : toStage(x, 'RV8', 'decide', 'every lens passed');
  return toStage(x, 'RV8', 'build', 'a lens asked for changes: next round');
}

function decideStage(x: StepInput): StepAction {
  const j = x.job;
  const ap = agent(x, 'approver');
  if (!startedIn(ap, j.round) || !ended(ap)) return spawn(x, 'DC1', 'approver');
  const m = missingOutput(x, 'approver');
  if (m) return m;
  if (x.decision.decision && !after(lastEvent(x, (e) => e.type === 'decision')?.ts, ap.endedAt)) return run(x, 'DC2', ['job', 'decision', j.id], 'record the approver\'s decision');
  if (j.kind === 'eval') {
    const judge = agent(x, 'judge');
    const needsJudge = Boolean(x.evalTask && (x.evalTask.rubric || x.evalTask.reference));
    // No M1/M2 for the judge: a missing eval-judge.md grades as `judge: null`, which is the honest result.
    if (needsJudge && !(ended(judge) && after(judge.endedAt, ap.endedAt))) return spawn(x, 'DC4', 'judge');
    if (!lastEvent(x, (e) => e.type === 'eval-graded')) return run(x, 'DC5', ['eval', 'grade', j.id], 'grade the eval task');
    return toStage(x, 'DC6', 'done', 'the eval task is graded');
  }
  if (!x.decision.decision) return park(x, 'DC3', 'escalation', 'decision.md has no APPROVE/ESCALATE line');
  if (x.decision.decision === 'ESCALATE') return park(x, 'DC7', 'escalation', 'approver escalated: see decision.md');
  if (x.runbookBeforeMerge) return park(x, 'DC8', 'infra', 'runbook: steps before merge');
  return toStage(x, 'DC9', 'integrate', 'approved: bring the branch up to date');
}

function integrate(x: StepInput): StepAction {
  const j = x.job;
  // A job set to integrate before transitions were logged has no entry event; anchor on the
  // decision that sent it here (or the last passing verify), so an earlier episode's events don't count.
  const since = stageSince(x) ?? lastEvent(x, (e) => e.type === 'decision')?.ts ?? j.verifyRuns.filter((r) => r.ok).at(-1)?.at ?? null;
  // The first integrate event since the job entered this stage is step's own `forge integrate`;
  // later ones are the integrator's `--keep-conflicts` and `--continue`.
  const first = x.events.find((e) => (e.type === 'integrated' || e.type === 'integrate-conflicts') && after(e.ts, since));
  if (!first) return run(x, 'IG1', ['integrate', j.id], 'bring the branch up to date with its base');
  const verifiesAfter = (ts: string | null | undefined) => j.verifyRuns.filter((r) => after(r.at, ts));
  if (first.type === 'integrated') {
    if (Number(first.behind) > 0) {
      const runs = verifiesAfter(first.ts);
      if (!runs.length) return run(x, 'IG2', ['verify', j.id], 'the integration brought in new commits');
      if (!runs.at(-1)!.ok) return toStage(x, 'IG2', 'build', 'verify failed after integrating the base');
    }
    return toStage(x, 'IG3', 'pr', 'the branch is up to date');
  }
  const policy = x.config.pr.conflicts;
  const files = Array.isArray(first.conflicts) ? first.conflicts.length : 0;
  const approved = after(human(x, 'approve')?.ts, first.ts);
  if (policy === 'ask' && !approved) return set(x, 'IG4', { state: 'waiting', waitingOn: 'conflicts', reason: `conflicts with base: ${files} files` }, 'a human decides how to resolve conflicts');
  if (policy === 'defer') return toStage(x, 'IG5', 'pr', 'conflicts deferred by pr.conflicts', { note: 'conflicts with base deferred' });
  const integrator = agent(x, 'integrator');
  const runs = x.events.filter((e) => e.type === 'agent-start' && e.role === 'integrator' && after(e.ts, first.ts)).length;
  if (!integrator || !after(integrator.startedAt, first.ts)) return spawn(x, 'IG6', 'integrator');
  const n = needsInput(x, 'integrator');
  if (n) return n;
  const checks = verifiesAfter(integrator.endedAt);
  if (!checks.length) return run(x, 'IG7', ['verify', j.id], 'verify the conflict resolution');
  if (!checks.at(-1)!.ok) return park(x, 'IG7', 'escalation', 'integration: verify failed after conflict resolution');
  const reviewer = agent(x, 'reviewer:code');
  if (!after(reviewer?.startedAt, integrator.endedAt)) return spawn(x, 'IG8', 'reviewer:code');
  const m = missingOutput(x, 'reviewer:code');
  if (m) return m;
  const reviewEv = lastEvent(x, (e) => e.type === 'integration-review');
  const fresh = reviewEv && after(reviewEv.ts, reviewer?.endedAt) ? reviewEv : null;
  if (!fresh) {
    if (x.verdicts.integration?.reviewers.code?.verdict === 'MALFORMED') {
      if (!reviewer?.retry) return spawn(x, 'RV5', 'reviewer:code', { retry: true, retryLine: `Retry: ${p(x, 'integrationReview')} has no VERDICT line; rewrite it in the required format.` });
      return run(x, 'RV5', ['job', 'verdicts', j.id, '--round', 'integration', '--compact', '--malformed', 'changes'], 'the integration review failed the format twice: count it as CHANGES');
    }
    return run(x, 'IG9', ['job', 'verdicts', j.id, '--round', 'integration', '--compact'], 'record the integration review');
  }
  if (fresh.outcome === 'PASS') return toStage(x, 'IG10', 'pr', 'the integration review passed');
  if (runs === 1) return spawn(x, 'IG10', 'integrator', { resume: true });
  return park(x, 'IG10', 'escalation', 'integration review: CHANGES');
}

function pr(x: StepInput): StepAction {
  const j = x.job;
  if (!x.config.pr.enabled) return toStage(x, 'PR1', 'done', 'PRs are off: the branch is the result', { tell: `${j.id} finished on branch ${safe(j.branch, SAFE_REF, 'its branch')}` });
  const last = j.verifyRuns.at(-1);
  if (!last?.ok) return run(x, 'PR2', ['verify', j.id], 'pr open needs a verified HEAD');
  const opened = lastEvent(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated');
  if (!after(opened?.ts, last.at)) return run(x, 'PR3', ['pr', 'open', j.id], 'push and open or update the PR');
  if (x.decision.autoMerge && x.config.merge.auto && !lastEvent(x, (e) => MERGE_EVENTS.includes(e.type) && after(e.ts, opened!.ts))) return run(x, 'PR4', ['pr', 'merge', j.id], 'the approver marked it auto-merge eligible');
  return set(x, 'PR5', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review' }, 'the PR waits on human review');
}
