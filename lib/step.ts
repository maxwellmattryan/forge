// `forge job step`: the one decider of pipeline transitions, the way the CLI is already the one
// writer of state. `step` is pure: it reads a StepInput (everything loadStepInput read once) and
// returns the next action, so the same state always gives the same answer and every rule is a
// table row in test/step.test.ts. It never writes; the orchestrator runs what it returns.
//
// Rule IDs follow the spec of issue #68. Every command it emits is built from ids, numbers, config
// names and fixed templates, never from file contents or agent replies, and shellLine refuses an
// argument outside a strict class, so an unattended daemon can run the result as-is.
import path from 'node:path';
import { acCoverage, specUiAcs } from './acs.ts';
import { readJobRecord, readSharedRecord } from './backing.ts';
import { jobPathMap, renderBrief, roleBrief } from './brief.ts';
import type { RoleContext } from './brief.ts';
import { autoMerge, lensAlwaysOnRework, lensNeedsApp, resolveEffort, resolveModel } from './config.ts';
import { environmentState } from './environment-record.ts';
import { configForJob } from './eval-overlay.ts';
import { latestSecurityVerdict, pastTotalCeiling, totalRoundCeiling } from './foreman.ts';
import { loadTask } from './evals.ts';
import { issueLinkStatus, prLinkNote } from './issue-link.ts';
import { isForemanActor, jobDir, loadJob, parseDecision, readEvents, requestBody, roundVerdicts } from './jobs.ts';
import { memberRepos } from './job-repos.ts';
import { deferralStatus, readDeferrals, releaseGates, releaseIndex, resolveInterim } from './interim.ts';
import { LENS_NAME, isLens, lensRepoAllowed, reviewFileName, splitLens } from './lens.ts';
import { lensChecklists } from './member-panel.ts';
import type { MemberLens } from './member-panel.ts';
import { pendingRepoProposals } from './repo-proposals.ts';
import { downstreamMembers, downstreamRepos } from './downstream.ts';
import { PLUGIN_ROOT, exists } from './paths.ts';
import { COMPLEXITIES } from './schema.ts';
import { generatedConfig } from './regenerate.ts';
import { protectedApproved, protectedReason } from './protected.ts';
import { approachPaths, inSpec, integrationTouched } from './scope.ts';
import { AGENT_ID } from './transcripts.ts';
import { verifierCount } from './verifiers.ts';
import type { Config, Job, JobAgent, PanelEntry, JobEvent, StepAction, StepDone, StepFile, StepInput, StepProcedure, StepRun, StepSpawn, StepVerdicts, StepWait, StepWaitingOn, VerifyRun, WaitingOn } from './types.ts';
import { ForgeError, SAFE_REF, readJson, readText } from './util.ts';

export const RULES = [
  'G1', 'G2', 'G3', 'G4', 'G5', 'L1', 'N1', 'N2', 'M1', 'M2', 'K1', 'K2',
  'I1', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8',
  'P1', 'P2', 'P3', 'P4', 'P5',
  'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7',
  'D1', 'D2', 'D3',
  'B1', 'B2', 'B3', 'B4', 'B5',
  // An eval job past maxRounds goes to decide to be graded: no human clears rounds-exhausted. Appended, as IDs are stable.
  'B6',
  'V1', 'V2', 'V3',
  // Verifiers between a passing verify and the panel: run, spawn the verifier agent, record its answers.
  'VF1', 'VF2', 'VF3',
  'RV1', 'RV2', 'RV3', 'RV4', 'RV5', 'RV6', 'RV7', 'RV8',
  // Runs first in review, but IDs are stable, so it was appended rather than renumbering the rest.
  'RV9',
  // Rounds 2+ under review.onRework narrow: spawn only the rework panel. Appended, as IDs are stable.
  'RV10',
  'DC1', 'DC2', 'DC3', 'DC4', 'DC5', 'DC6', 'DC7', 'DC8', 'DC9', 'DC10',
  'IG1', 'IG2', 'IG3', 'IG4', 'IG5', 'IG6', 'IG7', 'IG8', 'IG9', 'IG10', 'IG11',
  'PR1', 'PR2', 'PR3', 'PR4', 'PR5',
  // Interim strategies deferred a PR: park on a human canary publish (PR6), reopen (PR7), or wait for a merge (PR8).
  'PR6', 'PR7', 'PR8',
  // A recorded release: verify bumps its consumers (PR9, run before PR2), then an all-released draft
  // consumer leaves draft (PR10, run before PR4). Appended, as IDs are stable.
  'PR9', 'PR10',
  // A secret scan stopped the job: park on `human` (SC1, SC3), or scan again once a human approved (SC2).
  'SC1', 'SC2', 'SC3',
  // Protected paths: park on `human` until a human approves the current content (PP1), or send a
  // refused path back to build (PP2).
  'PP1', 'PP2',
  // Repo proposals: park on `human` while an agent's proposal waits (RP1), then create an approved
  // repo's worktree (RP2). Appended, though they run before the stage rules, as IDs are stable.
  'RP1', 'RP2',
  // Downstream verification: add a changed library's linked consumers as verify-only repos (DS1).
  // Appended, though it runs before the stage rules, as IDs are stable.
  'DS1',
  // A sampled merged job's post-merge score run: wait, spawn the judge, record. Appended, as IDs are stable.
  'JS1', 'JS2', 'JS3',
  // A resumed job whose environment a park stopped: start it again (E1). Appended, though it runs
  // right after G4, as IDs are stable.
  'E1',
  // A pull of the PR's remote branch conflicted after the last verify: park on a human (PR11).
  // Appended, as IDs are stable.
  'PR11',
  // A build round past the total-round ceiling that no person reopened parks for a human (B7, run
  // before B2). Appended, as IDs are stable.
  'B7',
  // No rule matched: a state step can't advance, parked visibly instead of looping.
  'X1',
] as const;

export type RuleId = (typeof RULES)[number];

/** Request bodies above this, or with this many list or heading lines, get a planner under `pipeline.plan: auto`. */
export const PLAN_AUTO_CHARS = 600;
export const PLAN_AUTO_LINES = 3;

const NEEDS_INPUT = /\bNEEDS-INPUT\b/i;
const SAFE_ELEMENT = /^[A-Za-z0-9 ._:/@=,+\-[\]"]*$/;
const BARE_ELEMENT = /^[A-Za-z0-9._:/@=,+-]+$/;
const SAFE_URL = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/;
const CI_CAP_REASON = /^CI rework cap: [A-Za-z0-9 ._/,:#?-]{1,600}$/;

/** Events loadStepInput keeps; everything else in events.jsonl is noise to step. */
const STEP_EVENTS = new Set([
  'human', 'round', 'worktree', 'worktree-setup-failed', 'pr-find', 'pr-adopted', 'scope', 'panel', 'integrated', 'integrate-conflicts',
  'integration-review', 'decision', 'fields', 'pr-opened', 'pr-updated', 'pr-merged', 'pr-auto-merge', 'pr-merge-deferred',
  'pr-merge-refused', 'pr-merge-failed', 'eval-graded', 'transition', 'agent-start', 'agent-end', 'secret-found', 'verifiers',
  'protected-path', 'repo-proposed', 'pr-deferred', 'canary-published', 'interim-released', 'interim-bumped', 'pr-ready', 'downstream-checked', 'job-repo-added',
  'job-repo-removed', 'pr-head-pulled',
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
export function loadStepInput(root: string, base: Config, id: string): StepInput {
  const job = loadJob(root, id);
  // An eval job's overlay applies to everything below: lenses, panel, models, effort and briefs.
  const config = configForJob(root, base, job);
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
    score: exists(at('score.md')),
  };
  const present = Object.values(paths).filter((v): v is string => typeof v === 'string' && exists(v));
  // The only I/O for the rework brief's review inputs, so step itself stays pure.
  for (const f of reworkReviewFiles(job, (paths.previousReviewDir as string | null) ?? null)) if (exists(f)) present.push(f);
  const body = requestBody(root, job.id);
  const specText = read('spec.md') ?? '';
  const events = readEvents(root, job.id).filter((e) => STEP_EVENTS.has(e.type));
  // The same list review() reads, or a narrowed round's verdicts would never complete.
  const lenses = roundLenses(job, config, currentRerun({ job, config, events }));
  const compact =(v: ReturnType<typeof roundVerdicts>): StepVerdicts => ({
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
    // Every job repo's worktree: a missing member worktree sends the job back to I3 (worktree create).
    worktreeExists: Boolean(job.worktree && exists(job.worktree)) && memberRepos(job).every((m) => Boolean(m.worktree && exists(m.worktree))),
    memberWorktreesMissing: memberRepos(job).some((m) => !(m.worktree && exists(m.worktree))),
    request: { length: body.length, listLines: listLineCount(body) },
    plan: parsePlan(read('plan.md') ?? ''),
    spec: { ...parseSpecHeader(specText), approachPaths: approachPaths(specText), uiAcs: specUiAcs(specText) },
    designDeltas: hasSpecDeltas(read('design.md') ?? ''),
    decision: { decision: parseDecision(root, job.id).decision, autoMerge: /^\s*(?:[-*]\s*)?Auto-merge eligible:\s*yes\b/im.test(read('decision.md') ?? '') },
    runbookBeforeMerge: /^\s*(?:[-*]\s*)?When:\s*before merge\b/im.test(read('runbook.md') ?? ''),
    verdicts: {
      round: job.round >= 1 && lenses.length ? compact(roundVerdicts(root, job.id, job.round, lenses, config.review.blockOn)) : null,
      integration: job.stage === 'integrate' ? compact(roundVerdicts(root, job.id, 'integration', ['code'], config.review.blockOn)) : null,
    },
    acs: acCoverage(read('spec.md'), read('build.md')),
    runtime,
    environment: environmentState(root, job.id),
    events,
    evalTask,
    checklists: lensChecklists(root, config, job, names),
    integrationTouched: loadIntegrationTouched(job, config, events),
    // The main checkout's, never the worktree's: a branch can't switch the gate on or off.
    verifiers: verifierCount(root),
    ...(config.backing?.length ? { backing: { job: readJobRecord(root, job.id, config), shared: readSharedRecord(root, config) } } : {}),
  };
}

/** Only when a skip is possible: integrate, code-only, the last verify passed, and the last conflicts event names both sides. */
export function loadIntegrationTouched(job: Job, config: Config, events: JobEvent[]): StepInput['integrationTouched'] {
  if (job.stage !== 'integrate' || config.pr.integrationReview !== 'code-only' || !job.worktree || !exists(job.worktree)) return null;
  const last = job.verifyRuns.at(-1);
  const ev = events.findLast((e) => e.type === 'integrate-conflicts');
  if (!last?.ok || !last.sha || !ev || typeof ev.head !== 'string' || typeof ev.upstream !== 'string') return null;
  return { head: ev.head, upstream: ev.upstream, sha: last.sha, files: integrationTouched(job.worktree, ev.head, ev.upstream, last.sha) };
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
export function parseSpecHeader(text: string): Omit<StepInput['spec'], 'approachPaths' | 'uiAcs'> {
  const head = text.split(/^## /m)[0];
  const value = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'mi').exec(head)?.[1].trim() ?? null;
  const items = (v: string | null) => (!v || v === '-' ? [] : v.split(',').map((s) => s.trim()).filter((s) => s && s !== '-'));
  return {
    size: value('Size'),
    complexity: value('Complexity')?.toLowerCase() ?? null,
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
 * `changed` still means the always-on lenses, and `full` reads the panel that RV9's
 * `forge job panel` recomputes from the diff. Step stays pure: the diff is read by that command.
 */
export function roundLenses(job: Pick<Job, 'reviewers' | 'pr'> & { repos?: Job['repos'] }, config: Config, rerun?: string[] | null): string[] {
  // job.reviewers is settable with --field, so a name that isn't a lens is dropped, never quoted, and
  // a qualified lens counts only while its repo is a reviewed member of the job.
  const base = (job.reviewers.length ? job.reviewers : alwaysLenses(config)).filter((l) => isLens(l) && lensRepoAllowed(job, l));
  // A rework panel (currentRerun) narrows a build-loop round; a PR rework keeps onPrFeedback's rule.
  if (job.pr?.state !== 'OPEN') return rerun?.length ? base.filter((l) => rerun.includes(l)) : base;
  if (config.review.onPrFeedback === 'none') return [];
  return config.review.onPrFeedback === 'full' ? base : alwaysLenses(config).filter((l) => LENS_NAME.test(l));
}

/**
 * This round's rework panel from the latest `panel` event of the round, when it postdates the
 * round's last verify and its `rerun` names only lenses of the full round panel; null means the
 * full panel. Every check fails toward more review: the event is in agent-reachable job state.
 */
export function currentRerun(x: Pick<StepInput, 'job' | 'config' | 'events'>): string[] | null {
  const j = x.job;
  if (j.round < 2 || x.config.review?.onRework !== 'narrow' || j.pr?.state === 'OPEN') return null;
  const lv = j.verifyRuns.filter((r) => r.round === j.round).at(-1);
  const ev = x.events.findLast((e) => e.type === 'panel' && e.round === j.round);
  if (!ev || !after(ev.ts, lv?.at)) return null;
  const rerun: unknown = ev.rerun;
  if (!Array.isArray(rerun) || !rerun.length || rerun.some((l) => typeof l !== 'string')) return null;
  const full = roundLenses(j, x.config);
  return rerun.every((l: string) => full.includes(l)) ? full.filter((l) => rerun.includes(l)) : null;
}

/** A lens's latest verdict before `round`, and the round it came from; null when it never had one. */
function lastVerdict(verdicts: Job['verdicts'], lens: string, round: number): { verdict: string; round: number } | null {
  for (let r = round - 1; r >= 1; r--) {
    const v = verdicts[String(r)]?.[lens];
    if (typeof v === 'string') return { verdict: v, round: r };
  }
  return null;
}

/**
 * The rework panel for round N ≥ 2 under `review.onRework: narrow`, in panel order: `always` and
 * always-on-rework lenses (lensAlwaysOnRework: `security` unless it opts out), lenses whose latest verdict isn't PASS or that never had one, and lenses whose panel `paths` match
 * a file changed since the sha round N−1's review saw (`changedSince`, null when that sha is
 * unusable). Null, meaning the full panel, whenever narrowing isn't safe or wouldn't skip anything.
 */
export function reworkPanel(x: { job: Pick<Job, 'round' | 'verdicts' | 'pr' | 'kind'>; config: Config; lenses: string[]; changedSince: string[] | null; members: number }): { rerun: string[]; reasons: Record<string, string[]>; skipped: string[] } | null {
  const j = x.job;
  if (x.config.review?.onRework !== 'narrow' || j.round < 2 || j.pr?.state === 'OPEN' || j.kind === 'retro' || x.members > 0 || !x.changedSince) return null;
  const prev = j.verdicts[String(j.round - 1)];
  // No verdicts, or all PASS: a human sent the job back, so nothing says which lenses to trust.
  if (!prev || !Object.keys(prev).length || Object.values(prev).every((v) => v === 'PASS')) return null;
  const reasons: Record<string, string[]> = {};
  for (const lens of x.lenses) {
    const entry = x.config.review.panel.find((p) => p.name === lens);
    const why: string[] = [];
    if (entry?.always) why.push('always');
    else if (lensAlwaysOnRework(x.config, lens)) why.push('always on rework');
    const last = lastVerdict(j.verdicts, lens, j.round);
    if (!last) why.push('new this round');
    else if (last.verdict !== 'PASS') why.push(`changes requested in round ${last.round}`);
    const globs = Array.isArray(entry?.paths) ? entry.paths.filter((g): g is string => typeof g === 'string' && g !== '') : [];
    for (const g of globs) {
      const hit = x.changedSince.find((f) => inSpec(f, [g]));
      if (hit !== undefined) why.push(`paths ${g}: ${hit}`);
    }
    if (why.length) reasons[lens] = why;
  }
  const rerun = x.lenses.filter((l) => reasons[l]);
  if (!rerun.length || rerun.length === x.lenses.length) return null;
  return { rerun, reasons, skipped: x.lenses.filter((l) => !reasons[l]) };
}

/** Path-like tokens in a lens's `when` text; prose-only `when`s are left to the spec-writer's suggestion. */
export function whenTokens(when: string | undefined): string[] {
  return String(when ?? '')
    .split(/[,\s]+/)
    .map((t) => t.replace(/^["'`([]+/, '').replace(/["'`)\];:.,]+$/, ''))
    .filter((t) => t && (t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t)));
}

/** A review panel and why each lens is on it: `forge job panel`'s result, and SP3's lenses. */
export interface PanelChoice {
  lenses: string[];
  reasons: Record<string, string[]>;
}

/** One reviewed member for choosePanel: its usable panel entries and its changed files, repo-relative. */
export interface PanelMember {
  repo: string;
  lenses: MemberLens[];
  changed: string[];
}

/**
 * The review panel from recorded inputs, in panel order: `always` lenses, the spec's suggestions
 * that are in the panel, lenses whose `when` paths or `paths` cover an Approach path, lenses whose
 * `paths` match a changed file (skipped when `changed` is null, at spec time), then `carried`
 * lenses, which can only add, so a lens never drops within a build loop. A lens gets every reason
 * that applies, in that order. Names that aren't plain lens names are dropped wherever they come from.
 * `members` adds each reviewed member's own lenses as `<repo>:<name>` after the root's, matched
 * against Approach paths under `<repo>/` and the member's changed files; an entry subsumed by a root
 * lens adds its reasons to that lens instead. A carried qualified lens stays only while its repo is a member.
 */
export function choosePanel(x: { kind: Job['kind']; config: Config; suggested: string[]; approachPaths: string[]; changed: string[] | null; carried: string[]; members?: PanelMember[] }): PanelChoice {
  if (x.kind === 'retro') return { lenses: ['code', 'docs'], reasons: { code: ['retro'], docs: ['retro'] } };
  const panel = x.config.review.panel.filter((p) => LENS_NAME.test(p.name));
  const names = panel.map((p) => p.name);
  const members = x.members ?? [];
  const memberNames = members.map((m) => m.repo);
  const qualified = members.flatMap((m) => m.lenses.filter((l) => !l.subsumed).map((l) => l.lens));
  const suggested = new Set(x.suggested.filter((n) => (LENS_NAME.test(n) && names.includes(n)) || qualified.includes(n)));
  const ofMember = (n: string) => {
    const s = splitLens(n);
    return Boolean(s?.repo && memberNames.includes(s.repo));
  };
  const carried = [...new Set(x.carried.filter((n) => typeof n === 'string' && (LENS_NAME.test(n) || ofMember(n))))];
  // A member entry's Approach and diff reasons, with paths written `<repo>/<path>`.
  const memberWhy = (m: PanelMember, e: PanelEntry): string[] => {
    const why: string[] = [];
    const prefix = `${m.repo}/`;
    const globs = Array.isArray(e.paths) ? e.paths.filter((g): g is string => typeof g === 'string' && g !== '') : [];
    const tokens = e.pathsOnly === true ? [] : [...whenTokens(e.when), ...globs];
    const covered = tokens.length ? x.approachPaths.find((ap) => ap.startsWith(prefix) && inSpec(ap.slice(prefix.length), tokens)) : undefined;
    if (covered !== undefined) why.push(`approach ${covered}`);
    for (const g of x.changed ? globs : []) {
      const hits = m.changed.filter((f) => inSpec(f, [g]));
      if (hits.length) why.push(`paths ${g}: ${prefix}${hits[0]}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`);
    }
    return why;
  };
  const subsumed = new Map<string, string[]>();
  for (const m of members)
    for (const l of m.lenses)
      if (l.subsumed && names.includes(l.lens)) subsumed.set(l.lens, [...(subsumed.get(l.lens) ?? []), ...memberWhy(m, l.entry)]);
  // A Map, not an object: a digits-only lens name would sort first among an object's keys.
  const chosen = new Map<string, string[]>();
  for (const p of panel) {
    if (chosen.has(p.name)) continue;
    const why: string[] = [];
    // pathsOnly: a spec can't pull the lens in; only always, the diff or carry can.
    const pathsOnly = p.pathsOnly === true;
    if (p.always) why.push('always');
    if (suggested.has(p.name) && !pathsOnly) why.push('suggested');
    const globs = Array.isArray(p.paths) ? p.paths.filter((g): g is string => typeof g === 'string' && g !== '') : [];
    const tokens = pathsOnly ? [] : [...whenTokens(p.when), ...globs];
    const covered = tokens.length ? x.approachPaths.find((ap) => inSpec(ap, tokens)) : undefined;
    if (covered !== undefined) why.push(`approach ${covered}`);
    for (const g of x.changed ? globs : []) {
      const hits = (x.changed ?? []).filter((f) => inSpec(f, [g]));
      if (hits.length) why.push(`paths ${g}: ${hits[0]}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}`);
    }
    for (const r of subsumed.get(p.name) ?? []) if (!why.includes(r)) why.push(r);
    if (carried.includes(p.name)) why.push('carried');
    if (why.length) chosen.set(p.name, why);
  }
  for (const m of members) {
    for (const l of m.lenses) {
      if (l.subsumed || chosen.has(l.lens)) continue;
      const why: string[] = [];
      if (l.entry.always) why.push('always');
      if (suggested.has(l.lens) && l.entry.pathsOnly !== true) why.push('suggested');
      why.push(...memberWhy(m, l.entry));
      if (carried.includes(l.lens)) why.push('carried');
      if (why.length) chosen.set(l.lens, why);
    }
  }
  for (const n of carried) if (!chosen.has(n) && !names.includes(n)) chosen.set(n, ['carried']);
  return { lenses: [...chosen.keys()], reasons: Object.fromEntries(chosen) };
}

/** SP3: always lenses, the suggested ones in the panel, and the ones whose `when` paths or `paths` the Approach names, in panel order. */
export function selectPanel(x: Pick<StepInput, 'job' | 'config' | 'spec'>): string[] {
  // Never carries: a revised spec re-records the panel from scratch.
  return choosePanel({ kind: x.job.kind, config: x.config, suggested: x.spec.suggested, approachPaths: x.spec.approachPaths, changed: null, carried: [] }).lenses;
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

const isPrRework = (x: StepInput) => x.job.pr?.state === 'OPEN';

const stageOf = (side: unknown) => (side as { stage?: string; state?: string; waitingOn?: string | null } | null) ?? {};

/** When the job last left review for another stage, or null for a job whose transitions predate the log. */
function reviewedAt(x: StepInput): string | null {
  return lastEvent(x, (e) => e.type === 'transition' && stageOf(e.from).stage === 'review' && stageOf(e.to).stage !== 'review')?.ts ?? null;
}

/** A gate (any waiting or blocked state) was entered after `ts`. */
const waitedSince = (x: StepInput, ts: string) =>
  x.events.some((e) => e.type === 'transition' && after(e.ts, ts) && ['waiting', 'blocked'].includes(String(stageOf(e.to).state)));

/**
 * The human `approve` events that answered one of the gates in `on`: the job was parked there (in
 * `stage`, when given) when the human approved. An approve answers the gate it was given at, so a
 * budget acknowledgement never clears an escalation or a runbook.
 */
function gateApprovals(x: StepInput, on: readonly WaitingOn[], stage?: string): JobEvent[] {
  return x.events.filter((e, i) => {
    if (e.type !== 'human' || e.action !== 'approve') return false;
    const park = stageOf(x.events.slice(0, i).findLast((t) => t.type === 'transition')?.to);
    return park.state === 'waiting' && on.includes(park.waitingOn as WaitingOn) && (!stage || park.stage === stage);
  });
}

/** Gates whose human approve means "ship it": an escalation, exhausted rounds, an infra runbook. */
const SHIP_GATES: readonly WaitingOn[] = ['escalation', 'rounds-exhausted', 'infra'];

/**
 * Someone already said ship it since the last review: the approver (a non-ESCALATE `decision`), or
 * a human `approve` at a ship gate that sent the job into this integrate episode, such as one
 * clearing a rounds-exhausted or approver escalation. An approve inside the episode (IG4 `ask`)
 * only lets the integrator fix conflicts.
 */
function approvedSinceReview(x: StepInput): boolean {
  const reviewed = reviewedAt(x);
  if (x.events.some((e) => e.type === 'decision' && e.decision !== 'ESCALATE' && after(e.ts, reviewed))) return true;
  const since = stageSince(x);
  return gateApprovals(x, SHIP_GATES).some((e) => after(e.ts, reviewed) && !after(e.ts, since));
}

/** Where an up-to-date branch goes: the approver judges it first, unless it was approved already or its PR is open. */
const afterIntegration = (x: StepInput) => (isPrRework(x) || approvedSinceReview(x) ? 'pr' : 'decide');

const splitMode = (x: StepInput) => x.job.splitMode ?? x.config.pipeline.split;

function planningNeeded(x: StepInput): boolean {
  const mode = x.config.pipeline.plan;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return x.request.length > PLAN_AUTO_CHARS || x.request.listLines >= PLAN_AUTO_LINES;
}

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

/** A parked job still holding something to stop: a running environment record or a background process. */
const parkedRunning = (x: StepInput): boolean => x.environment === 'running' || x.runtime.length > 0;
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
    return x.job.stage === 'integrate' ? p(x, 'integrationReview') : path.join(x.jobDir, 'review', `round-${x.job.round}`, reviewFileName(lens));
  }
  if (role === 'verifier') return path.join(x.jobDir, 'verify', `round-${x.job.round}-verifier-answers.md`);
  const fixed: Record<string, string> = { planner: 'plan.md', 'spec-writer': 'spec.md', designer: 'design.md', approver: 'decision.md', judge: x.job.kind === 'eval' ? 'eval-judge.md' : 'score.md' };
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
  if (lv && !lv.ok && after(lv.at, b?.endedAt)) out.push(lv.failure === 'verifiers' ? 'verifiers' : 'verify');
  if (isPrRework(x) && x.files.prFeedback) out.push('pr-feedback');
  if (x.files.feedback && (j.round > 1 || reworkEv)) out.push('feedback');
  if (x.files.questions && human(x, 'answer')) out.push('answer');
  return out;
}

/** The previous round's review files that asked for changes, sorted by lens; pure, so callers decide what exists. */
export function reworkReviewFiles(job: Job, previousReviewDir: string | null): string[] {
  if (job.round <= 1 || !previousReviewDir) return [];
  const prev = job.verdicts[String(job.round - 1)] ?? {};
  return Object.keys(prev)
    .filter((lens) => isLens(lens) && lensRepoAllowed(job, lens) && prev[lens] !== 'PASS')
    .sort()
    .map((lens) => path.join(previousReviewDir, reviewFileName(lens)));
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
  if (base === 'builder') {
    ctx.rework = builderRework(x);
    if (ctx.rework.includes('review')) ctx.reworkReviews = reworkReviewFiles(j, (x.paths.previousReviewDir as string | null) ?? null);
  }
  if (base === 'reviewer' && j.stage === 'integrate') ctx.integration = { conflicts: conflictFiles };
  if (base === 'verifier') {
    const sel = pendingVerifiers(x)?.selected;
    ctx.verifiers = Array.isArray(sel) ? sel.length : 0;
  }
  if (base === 'integrator') {
    // The fix pass: an integration review of this episode's resolution asked for changes.
    const review = lastEvent(x, (e) => e.type === 'integration-review');
    ctx.integration = { conflicts: conflictFiles, regenerated, fix: Boolean(review && review.outcome === 'CHANGES' && after(review.ts, conflicts?.ts)) };
    ctx.strategy = x.config.pr.updateStrategy;
  }
  const model = resolveModel(x.config, x.job, role, ctx.rework ?? []);
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
    effort: resolveEffort(x.config, x.job, role).level,
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
      if (pastTotalCeiling(x.config, j))
        return `${id} reached the total-round ceiling (${totalRoundCeiling(x.config, j)} rounds): only a human may clear it. /forge approve ${id} to ship, or /forge rework ${id} <note>`;
      return `${id} used all ${j.maxRounds} rounds. /forge approve ${id} to ship, or /forge rework ${id} <note>`;
    case 'infra':
      return `${id} waits on runbook steps before merge: ${p(x, 'runbook')}. /forge continue ${id} when done`;
    case 'conflicts':
      return `${id} conflicts with ${safe(j.base, SAFE_REF, 'its base branch')}. /forge approve ${id} to have the integrator fix them`;
    case 'budget': {
      if (!reason.startsWith('repo budget:'))
        return `${id} over budget: ${reason}. /forge approve ${id} to acknowledge, or raise it: forge job budget ${id} --set usd=…`;
      // The repo cap is lifted by a human's ack of the period, never by approving or a per-job budget.
      const at = new Date().toISOString();
      const month = reason.includes('this month');
      return `${id} held by the repo budget (${reason}). A human runs forge budget ack --period ${month ? at.slice(0, 7) : at.slice(0, 10)}, or raises budget.${month ? 'usdPerMonth' : 'usdPerDay'} in .forge/config.yml; the job resumes once the repo is under its cap`;
    }
    case 'pr-review':
      return prReviewTell(x);
    case 'human':
      if (reason.startsWith('repo proposal:'))
        return `${id} proposes repos (${reason}): ${path.join(x.jobDir, 'repo-proposals.md')}. Approve or reject in the dashboard, or in your own terminal: forge job human ${id} approve-repos|reject-repos --repo <names> --note …`;
      if (reason.startsWith('protected paths'))
        return `${id} changed protected paths (${reason}). Diff: ${path.join(x.jobDir, 'protected.diff')}. /forge approve ${id} once a human has reviewed them, or /forge rework ${id} <note>`;
      if (reason.startsWith('secret scan'))
        return `${id} stopped on a possible secret (${reason}). Masked findings and fingerprints: forge secrets scan ${id}. Remove the value (rewrite the branch if it was committed) or add its fingerprint to .forge/secrets-allow.txt in the main checkout, then /forge approve ${id} to scan again, or /forge rework ${id} <note>`;
      return `${id} needs a human: ${reason}. /forge approve ${id} once it is resolved, or /forge rework ${id} <note>`;
    default:
      return `${id} waits: ${reason}`;
  }
}

function prReviewTell(x: StepInput): string {
  const j = x.job;
  const lines = [`${j.id} PR ${safe(j.pr?.url, SAFE_URL, `#${Number(j.pr?.number) || '?'}`)} waits on review`];
  if (prLinkNote(j, x.config).unlinked) lines.push(`${j.id} has no linked issue: \`forge job link ${j.id} <ref>\` or \`--none\``);
  // The reason's check names passed lib/pr.ts CHECK_NAME; this pattern holds it to that class again.
  if (j.reason?.startsWith('CI rework cap:'))
    lines.push(`${j.id}: ${safe(j.reason, CI_CAP_REASON, 'CI rework cap reached')}. /forge rework ${j.id} <note> once a human has looked`);
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
    case 'verify':
      role = pendingVerifiers(x) && after(a('verifier')?.startedAt, pendingVerifiers(x)!.ts) ? 'verifier' : null;
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

/**
 * JS1-JS3: a done job's queued post-merge score run. Only a judge started after the queue counts,
 * so an older judge record never stands in for it; record then makes the score terminal.
 */
function scoreRun(x: StepInput): StepAction {
  const j = x.job;
  const judge = agent(x, 'judge');
  if (!after(judge?.startedAt, j.score!.queuedAt)) return spawn(x, 'JS2', 'judge');
  if (judge!.status === 'running') return wait(x, 'JS1', 'agents');
  return run(x, 'JS3', ['job', 'score', 'record', j.id], "record the judge's post-merge score");
}

function decide(x: StepInput): StepAction {
  const j = x.job;

  // Global
  if (j.state === 'done' && j.kind !== 'eval' && j.score?.status === 'queued') return scoreRun(x);
  if (j.state === 'done' || j.state === 'cancelled' || j.stage === 'done') {
    const tell = j.state === 'cancelled' ? `${j.id} is cancelled` : j.pr?.url ? `${j.id} is done: ${safe(j.pr.url, SAFE_URL, `PR #${Number(j.pr.number) || '?'}`)}` : `${j.id} finished on branch ${safe(j.branch, SAFE_REF, 'its branch')}`;
    return done(x, 'G1', tell);
  }
  if (j.state === 'failed') return done(x, 'G2', `${j.id} failed: ${j.reason ?? 'no reason recorded'}`);
  if (j.state === 'waiting' && j.waitingOn === 'pr-review') {
    if (j.lease.driver) return run(x, 'G3', ['job', 'release', j.id], 'the PR waits on human review; let the claim go');
    if (parkedRunning(x)) return run(x, 'G3', ['environment', 'stop', j.id], 'stop the environment while the PR waits');
    return wait(x, 'G3', 'pr-review', prReviewTell(x));
  }
  if (j.state === 'waiting' || j.state === 'blocked') {
    if (parkedRunning(x)) return run(x, 'G4', ['environment', 'stop', j.id], 'the job is parked: stop its environment');
    const on: WaitingOn = j.state === 'blocked' ? 'external' : (j.waitingOn ?? 'external');
    return wait(x, 'G4', on, gateTell(x, on));
  }
  // Only a job whose environment Forge stopped: one never started has no entry and starts on demand.
  if (j.state === 'running' && x.environment === 'stopped' && ['build', 'verify', 'review'].includes(j.stage))
    return run(x, 'E1', ['environment', 'up', j.id], 'a park stopped the environment', 'the job resumed: start its environment');
  if (runningRoles(x).length && !(j.stage === 'review' && (nextLenses(x).length || retryLens(x)))) return wait(x, 'G5', 'agents');
  const blocked = blockedRole(x);
  if (blocked) return spawn(x, 'L1', blocked);

  // Kind gates
  if (j.kind === 'retro') {
    const retro = agent(x, 'retro');
    if (!ended(retro) || !x.files.spec) return procedure(x, 'K1', 'retro.md', 'a retro job starts with the retro agent');
    if (j.stage === 'backlog') return toStage(x, 'K2', 'spec', 'the retro wrote spec.md');
  }

  const secret = secretGate(x);
  if (secret) return secret;
  const guarded = protectedGate(x);
  if (guarded) return guarded;
  const proposal = repoProposalGate(x);
  if (proposal) return proposal;
  const downstream = downstreamGate(x);
  if (downstream) return downstream;

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

/**
 * SC1–SC3: a likely credential stopped verify or `pr open`. No agent retry gets past it: the job
 * parks on `human` until a human removes or allowlists the value and approves, and then the scan
 * runs again (SC2, or PR3 after SC3), which parks it again if the value is still there. A builder or
 * integrator that ran since the failing verify (a rework) hands the decision back to V1/IG7.
 */
function secretGate(x: StepInput): StepAction | null {
  const j = x.job;
  if (j.stage !== 'verify' && j.stage !== 'integrate' && j.stage !== 'pr') return null;
  const stop = (rule: RuleId, reason: string) =>
    j.kind === 'eval' ? set(x, rule, { state: 'failed', reason: `eval: ${reason}` }, 'an eval job has no human to clear a secret') : park(x, rule, 'human', reason);
  const last = j.verifyRuns.at(-1);
  if (last && !last.ok && last.failure === 'secrets' && !['builder', 'integrator'].some((r) => after(agent(x, r)?.endedAt, last.at))) {
    if (after(human(x, 'approve')?.ts, last.at)) return run(x, 'SC2', ['verify', j.id], 'a human cleared the secret scan: scan again');
    return stop('SC1', `secret scan blocked verify round ${Number(last.round) || 0}`);
  }
  if (j.stage === 'pr') {
    const refused = lastEvent(x, (e) => e.type === 'secret-found' && e.gate === 'pr' && e.blocked === true);
    const opened = lastEvent(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated');
    if (refused && after(refused.ts, opened?.ts) && after(refused.ts, last?.at) && !after(human(x, 'approve')?.ts, refused.ts)) return stop('SC3', 'secret scan blocked pr open');
  }
  return null;
}

/** PP1: the job changes escalate paths no human approved since their current content was recorded. */
function protectedPark(x: StepInput): StepAction | null {
  const flag = x.job.protectedPaths;
  if (!flag?.hits?.length || x.job.kind === 'eval' || protectedApproved(flag, x.events)) return null;
  return park(x, 'PP1', 'human', protectedReason(flag));
}

/**
 * PP2 then PP1 in the pr stage. A path the policy refuses is on the branch (verify failed on it, or
 * pr open refused it since the last open and verify): back to build, so PR2 and PR3 can't loop on
 * it. Then a flag raised after decide (by pr open, say) parks the job like PP1 in decide.
 */
function protectedGate(x: StepInput): StepAction | null {
  const j = x.job;
  if (j.stage !== 'pr') return null;
  const last = j.verifyRuns.at(-1);
  const back = () => toStage(x, 'PP2', 'build', 'a path the protected-paths policy refuses is on the branch');
  if (last && !last.ok && last.failure === 'protected' && !after(agent(x, 'builder')?.endedAt, last.at)) return back();
  const refused = lastEvent(x, (e) => e.type === 'protected-path' && e.gate === 'pr' && e.action === 'refuse');
  const opened = lastEvent(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated');
  if (refused && after(refused.ts, opened?.ts) && after(refused.ts, last?.at)) return back();
  return protectedPark(x);
}

/** At most this many repo names in RP1's reason; the rest are counted. */
const RP1_NAMES = 5;

/**
 * RP1: an agent proposed a member repo and no decision covers it yet, so the job waits on a human
 * (or the foreman, when allowed) before anything else in the stage runs. RP2: an approved repo, or
 * one a human added mid-job, has no worktree yet. Names come from events but pass REPO_NAME, which
 * sits inside shellLine's safe class.
 */
function repoProposalGate(x: StepInput): StepAction | null {
  const j = x.job;
  if (j.stage === 'backlog' || j.stage === 'pr' || j.stage === 'done') return null;
  const names = pendingRepoProposals(j, x.events).map((r) => r.repo);
  if (names.length) {
    const shown = names.slice(0, RP1_NAMES).join(', ') + (names.length > RP1_NAMES ? ` +${names.length - RP1_NAMES} more` : '');
    return park(x, 'RP1', 'human', `repo proposal: ${shown}`);
  }
  if (x.memberWorktreesMissing) return run(x, 'RP2', ['worktree', 'create', j.id], 'an approved repo needs its worktree');
  return null;
}

/**
 * DS1: in build and verify, a changed repo has a linked consumer to add that the latest
 * `downstream-checked` event does not name, so `forge job repo downstream` runs (once per new
 * candidate: one it skipped, a failing clone included, waits for a human to run it again).
 */
function downstreamGate(x: StepInput): StepAction | null {
  const j = x.job;
  if ((j.stage !== 'build' && j.stage !== 'verify') || j.kind === 'eval' || x.config.downstream?.enabled !== true) return null;
  const { add } = downstreamRepos(x.config, j, x.events, path.basename(x.root));
  if (!add.length) return null;
  const checked = lastEvent(x, (e) => e.type === 'downstream-checked');
  const named = new Set<unknown>([...(Array.isArray(checked?.added) ? checked.added : []), ...(Array.isArray(checked?.skipped) ? checked.skipped.map((s: any) => s?.repo) : [])]);
  if (add.every((name) => named.has(name))) return null;
  return run(x, 'DS1', ['job', 'repo', 'downstream', j.id], 'a changed library has consumers to verify');
}

function stuck(x: StepInput): StepRun {
  return park(x, 'X1', 'escalation', `step found no rule for stage ${x.job.stage}`);
}

function intake(x: StepInput): StepAction {
  const j = x.job;
  // Intake only searches: the human picks the issue at the spec gate (SP5), or before build (SP7).
  if (issueLinkStatus(j, x.config) === 'missing' && !x.files.issueCandidates) return run(x, 'I1', ['job', 'link', j.id, '--suggest'], 'every job needs an issue: look for candidates');
  if (!x.worktreeExists) return run(x, 'I3', ['worktree', 'create', j.id], 'the job needs its worktree');
  // By position, not timestamp: a backing failure can land in the same millisecond as its worktree event.
  const wt = x.events.findLastIndex((e) => e.type === 'worktree');
  const failed = x.events.findLastIndex((e) => e.type === 'worktree-setup-failed');
  if (failed >= 0 && failed > wt) return set(x, 'I4', { state: 'failed', reason: 'worktree setup failed' }, 'the worktree setup command failed');
  if (x.config.pr.enabled && j.kind !== 'eval' && !j.pr && !lastEvent(x, (e) => e.type === 'pr-find' || e.type === 'pr-adopted')) return run(x, 'I5', ['pr', 'find', j.id], 'continue an existing PR instead of forking it');
  if (j.pr) return procedure(x, 'I6', 'pr-lifecycle.md', 'PR exists');
  if (planningNeeded(x)) return toStage(x, 'I7', 'plan', 'the request needs a plan');
  return toStage(x, 'I8', 'spec', 'the request is small enough to spec directly');
}

function plan(x: StepInput): StepAction {
  const j = x.job;
  const planner = agent(x, 'planner');
  if (!ended(planner) || after(human(x, 'revise-split')?.ts, planner.startedAt) || after(human(x, 'reject-repos')?.ts, planner.startedAt)) return spawn(x, 'P1', 'planner');
  const g = generic(x, 'planner');
  if (g) return g;
  if (x.plan.verdict === 'SPLIT') {
    if (splitMode(x) === 'auto') return procedure(x, 'P2', 'split.md', 'PLAN: SPLIT under pipeline.split auto');
    // An approved split (a human's or the foreman's) sends the job back to plan/running: create the jobs.
    if (after(human(x, 'approve-split')?.ts, planner.endedAt)) return procedure(x, 'P2', 'split.md', 'PLAN: SPLIT approved');
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
  if (after(human(x, 'revise-spec')?.ts, sw?.startedAt) || (sw && after(human(x, 'reject-repos')?.ts, sw.startedAt))) return spawn(x, 'SP2', 'spec-writer');
  if (sw) {
    const g = generic(x, 'spec-writer');
    if (g) return g;
  }
  const authored = specAuthorEnd(x);
  const panelEv = lastEvent(x, (e) => e.type === 'fields' && Boolean(e.fields && typeof e.fields === 'object' && 'reviewers' in (e.fields as object)));
  if (!after(panelEv?.ts, authored)) {
    const fields = [`reviewers=${JSON.stringify(selectPanel(x))}`];
    if (x.spec.size && /^[SML]$/.test(x.spec.size)) fields.push(`size=${x.spec.size}`);
    const complexity = (COMPLEXITIES as readonly (string | null)[]).includes(x.spec.complexity) ? x.spec.complexity : null;
    // A revised spec without the line must not keep a stale level-picking value.
    if (complexity) fields.push(`complexity=${complexity}`);
    else if (j.complexity != null) fields.push('complexity=null');
    const services = x.spec.services.filter((s) => SAFE_REF.test(s) && c.components.some((cs) => cs.name === s));
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
  const previousRound = x.events.filter((e) => e.type === 'round').at(-2)?.ts;
  // The total-round ceiling counts every round, whoever opened it: past it only a person's rework or
  // revise-spec since the previous round started opens this one. The foreman's (CI reworks included) never does.
  const personRework = lastEvent(x, (e) => e.type === 'human' && (e.action === 'rework' || e.action === 'revise-spec') && !isForemanActor(e));
  if (pastTotalCeiling(x.config, j) && !after(personRework?.ts, previousRound)) {
    const ceiling = totalRoundCeiling(x.config, j);
    if (j.kind === 'eval') return set(x, 'B6', { stage: 'decide', state: 'running', reason: `eval: round ${j.round} exceeds the total-round ceiling ${ceiling}` }, 'an eval job has no human to clear rounds-exhausted: grade it');
    return park(x, 'B7', 'rounds-exhausted', `round ${j.round} exceeds the total-round ceiling ${ceiling}: only a human clears it`);
  }
  // Security always has to pass: while the latest security review isn't PASS, rounds run past
  // maxRounds, up to twice it, before the park (where the foreman may only rework or revise).
  const security = latestSecurityVerdict(j);
  const securityOpen = j.kind !== 'eval' && security !== null && security !== 'PASS';
  const limit = securityOpen ? j.maxRounds * 2 : j.maxRounds;
  if (j.round > limit && !after(rework?.ts, previousRound)) {
    if (j.kind === 'eval') return set(x, 'B6', { stage: 'decide', state: 'running', reason: `eval: round ${j.round} exceeds maxRounds ${j.maxRounds}` }, 'an eval job has no human to clear rounds-exhausted: grade it');
    return park(x, 'B2', 'rounds-exhausted', securityOpen ? `round ${j.round} exceeds twice maxRounds ${j.maxRounds} with the security review not PASS` : `round ${j.round} exceeds maxRounds ${j.maxRounds}`);
  }
  if (endedIn(b, j.round)) {
    const n = needsInput(x, 'builder');
    if (n) return n;
  }
  const runs = j.verifyRuns.filter((r) => r.round === j.round);
  const prev = runs.at(-2);
  if (lv && prev && !lv.ok && !prev.ok && lv.failure === 'integrity' && prev.failure === 'integrity' && b?.endedAt && after(b.endedAt, prev.at) && !after(b.endedAt, lv.at)) {
    return park(x, 'B3', 'escalation', 'integrity: verify failed twice on test integrity');
  }
  if (!startedIn(b, j.round) || (lv && !lv.ok && after(lv.at, b?.endedAt)) || after(rework?.ts, b?.startedAt)) return spawn(x, 'B4', 'builder'); // Never resumed: a rework builder is expendable and its brief carries the findings, so it need not drag the last round's context along.
  if (endedIn(b, j.round)) return toStage(x, 'B5', 'verify', 'the builder committed this round');
  return stuck(x);
}

/** This round's latest `verifiers` event newer than the round's last verify run. */
function latestVerifiers(x: StepInput): JobEvent | undefined {
  const lv = lastVerify(x);
  return lastEvent(x, (e) => e.type === 'verifiers' && e.round === x.job.round && after(e.ts, lv?.at));
}

/** The `run` event the verifier agent answers, while its answers are not recorded yet. */
function pendingVerifiers(x: StepInput): JobEvent | null {
  const e = latestVerifiers(x);
  return e?.phase === 'run' ? e : null;
}

/**
 * VF1–VF3, after a passing verify when the main checkout has verifiers: run them, have the
 * verifier agent answer, then record the answers. A PASS record falls through to V2; a CHANGES
 * record appended a failing verify run, so the caller never gets here for it.
 */
function verifierStep(x: StepInput): StepAction | null {
  if (!x.verifiers) return null;
  const j = x.job;
  const e = latestVerifiers(x);
  if (!e) return run(x, 'VF1', ['verifiers', 'run', j.id], 'check the verified diff against the verifiers');
  if (e.phase !== 'run') return null;
  const a = agent(x, 'verifier');
  if (!a || !after(a.startedAt, e.ts)) return spawn(x, 'VF2', 'verifier');
  if (ended(a) && outputMissing(x, 'verifier') && !a.retry) return spawn(x, 'VF2', 'verifier', { retry: true });
  return run(x, 'VF3', ['verifiers', 'record', j.id], 'record the verifier answers');
}

function verify(x: StepInput): StepAction {
  const b = agent(x, 'builder');
  const lv = lastVerify(x);
  if (!lv || (b?.endedAt && !after(lv.at, b.endedAt))) return run(x, 'V1', ['verify', x.job.id], `verify the builder's round-${x.job.round} commits`);
  if (lv.ok) {
    const vf = verifierStep(x);
    if (vf) return vf;
  }
  if (lv.ok) return isPrRework(x) && x.config.review.onPrFeedback === 'none' ? toStage(x, 'V2', 'pr', 'verify passed; PR feedback skips review') : toStage(x, 'V2', 'review', 'verify passed');
  // A break only a downstream consumer saw is named against it: the builder fixes the library or proposes the consumer.
  const downstream = downstreamMembers(x.job, x.events);
  const broke = (Array.isArray(lv.repos) ? lv.repos : []).find((r) => !r.ok && downstream.has(r.repo));
  if (broke) {
    const step = typeof broke.failure === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(broke.failure) ? broke.failure : 'a step';
    return toStage(x, 'V3', 'build', `verify failed: downstream consumer ${broke.repo} failed ${step}`);
  }
  return toStage(x, 'V3', 'build', 'verify failed: back to the builder');
}

/** RV4: every lens of this round whose reviewer has not started yet, in panel order; none once the round's verdicts are recorded. */
function nextLenses(x: StepInput): string[] {
  if (x.job.verdicts[String(x.job.round)]) return [];
  return roundLenses(x.job, x.config, currentRerun(x)).filter((l) => !startedIn(agent(x, `reviewer:${l}`), x.job.round));
}

/** M1 in the review stage: the first lens of this round whose reviewer ended without its review and has not had its retry; none once the round's verdicts are recorded. */
function retryLens(x: StepInput): string | null {
  const j = x.job;
  if (j.verdicts[String(j.round)]) return null;
  return roundLenses(j, x.config, currentRerun(x)).find((l) => {
    const a = agent(x, `reviewer:${l}`);
    // outputMissing(), not a.outputMissing: a pre-v6 record falls back to the MISSING verdict.
    return endedIn(a, j.round) && !a.retry && outputMissing(x, `reviewer:${l}`);
  }) ?? null;
}

function review(x: StepInput): StepAction {
  const j = x.job;
  const lv = lastVerify(x);
  // Once per round, after verify and before any reviewer starts, so the panel matches the diff the
  // reviewers read. A PR rework under `changed` or `none` keeps its always-only or skip rule.
  const prSkip = isPrRework(x) && x.config.review.onPrFeedback !== 'full';
  const panelled = x.events.some((e) => e.type === 'panel' && e.round === j.round && after(e.ts, lv?.at));
  const reviewing = Object.keys(j.agents).some((k) => k.startsWith('reviewer:') && startedIn(j.agents[k], j.round));
  if (!prSkip && !panelled && !reviewing && !j.verdicts[String(j.round)]) return run(x, 'RV9', ['job', 'panel', j.id], "pick this round's lenses from the diff");
  const rerun = currentRerun(x);
  const lenses = roundLenses(j, x.config, rerun);
  if (!lenses.length) return toStage(x, 'RV1', 'pr', 'no lens reviews this round');
  if (!x.events.some((e) => e.type === 'scope' && e.round === j.round && after(e.ts, lv?.at))) return run(x, 'RV2', ['job', 'scope', j.id], 'reviewers read the scope report');
  // Only until the round's verdicts are recorded: after that RV7 stops the server, and starting it
  // again here would alternate with that stop forever. Retries before then still get the app.
  const recordedVerdicts = Boolean(j.verdicts[String(j.round)]);
  if (!recordedVerdicts && lenses.some((l) => lensNeedsApp(x.config, l)) && x.config.commands.dev && !x.runtime.includes('dev')) return run(x, 'RV3', ['run', j.id, 'dev', '--background'], 'app-needing lenses review the running app');
  // The whole remaining panel in one action so the orchestrator launches it in one message. Each
  // lens is still recorded by its own `agent start`, so a re-step never lists a started lens.
  const [first, ...rest] = nextLenses(x);
  if (first) {
    const rule = rerun ? 'RV10' : 'RV4';
    const a = spawn(x, rule, `reviewer:${first}`);
    const why = rerun ? { why: 'rework round: re-review the lenses that asked for changes, the always lenses and the lenses whose paths the fix touched' } : {};
    return rest.length ? { ...a, ...why, spawns: rest.map((l) => spawn(x, rule, `reviewer:${l}`)) } : { ...a, ...why };
  }
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
      const file = path.join(x.jobDir, 'review', `round-${j.round}`, reviewFileName(fresh));
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
  if (Object.values(recorded).every((r) => r === 'PASS')) {
    if (isPrRework(x)) return toStage(x, 'RV8', 'pr', 'the PR rework passed review');
    // Evals never integrate: base drift would skew their scores.
    if (j.kind === 'eval') return toStage(x, 'RV8', 'decide', 'every lens passed');
    return toStage(x, 'RV8', 'integrate', 'every lens passed: bring the branch up to date');
  }
  return toStage(x, 'RV8', 'build', 'a lens asked for changes: next round');
}

function decideStage(x: StepInput): StepAction {
  const j = x.job;
  if (j.kind !== 'eval' && isPrRework(x)) return toStage(x, 'DC10', 'pr', 'the PR is open: nothing to decide');
  const ap = agent(x, 'approver');
  // B6 sent a rounds-exhausted eval job here: the approver would only ESCALATE a branch that never
  // passed review, and skipping it keeps escalationRate an approver-only metric.
  const exhausted = j.kind === 'eval' && (j.round > j.maxRounds || pastTotalCeiling(x.config, j));
  if (!exhausted) {
    if (!startedIn(ap, j.round) || !ended(ap)) return spawn(x, 'DC1', 'approver');
    const m = missingOutput(x, 'approver');
    if (m) return m;
    if (x.decision.decision && !after(lastEvent(x, (e) => e.type === 'decision')?.ts, ap.endedAt)) return run(x, 'DC2', ['job', 'decision', j.id], 'record the approver\'s decision');
  }
  if (j.kind === 'eval') {
    const judge = agent(x, 'judge');
    const needsJudge = Boolean(x.evalTask && (x.evalTask.rubric || x.evalTask.reference));
    // No M1/M2 for the judge: a missing eval-judge.md grades as `judge: null`, which is the honest result.
    if (needsJudge && !(ended(judge) && after(judge.endedAt, ap?.endedAt))) return spawn(x, 'DC4', 'judge');
    if (!lastEvent(x, (e) => e.type === 'eval-graded')) return run(x, 'DC5', ['eval', 'grade', j.id], 'grade the eval task');
    return toStage(x, 'DC6', 'done', 'the eval task is graded');
  }
  // A human approve given at this gate after the approver ended cleared it, so a job sent back here
  // (an integrate-stage escalation) isn't parked again on the same stale ESCALATE or runbook. Only
  // an approve at that gate counts: acknowledging a budget stop clears neither.
  const cleared = (on: WaitingOn) => gateApprovals(x, [on], 'decide').some((e) => after(e.ts, ap?.endedAt));
  if (!x.decision.decision && !cleared('escalation')) return park(x, 'DC3', 'escalation', 'decision.md has no APPROVE/ESCALATE line');
  if (x.decision.decision === 'ESCALATE' && !cleared('escalation')) return park(x, 'DC7', 'escalation', 'approver escalated: see decision.md');
  if (x.runbookBeforeMerge && !cleared('infra')) return park(x, 'DC8', 'infra', 'runbook: steps before merge');
  // An APPROVE, or a cleared escalation, still waits for a human on protected paths.
  const guarded = protectedPark(x);
  if (guarded) return guarded;
  // No loop: after integrate → decide with no wait since, this goes to pr. After a wait (or for an
  // older job that never integrated since review), integrate's IG3/IG5/IG10 reach pr, because the
  // decision or approval now counts there.
  const left = lastEvent(x, (e) => e.type === 'transition' && stageOf(e.from).stage === 'integrate' && stageOf(e.to).stage === 'decide');
  if (left && after(left.ts, reviewedAt(x)) && !waitedSince(x, left.ts)) return toStage(x, 'DC9', 'pr', 'approved on an up-to-date branch');
  return toStage(x, 'DC9', 'integrate', 'approved: bring the branch up to date');
}

// The builder, integrator or base branch names the conflicted files, so anything odd counts as code.
const SAFE_CONFLICT = (p: unknown): p is string =>
  typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.includes('\\') && !/[\x00-\x1f\x7f]/.test(p) && !p.split('/').includes('..');
const isDocs = (p: string) => p.toLowerCase().endsWith('.md') || p.startsWith('docs/');

/**
 * How many files this episode's conflicts and resolution touched when every one is docs or generated and
 * `pr.integrationReview: code-only` lets the integration review be skipped; 0 keeps the review.
 */
export function integrationReviewSkippable(x: StepInput, first: JobEvent): number {
  if (x.config.pr.integrationReview !== 'code-only') return 0;
  // A review already ran this episode: its outcome governs.
  if (x.events.some((e) => e.type === 'agent-start' && e.role === 'reviewer:code' && after(e.ts, first.ts))) return 0;
  const events = x.events.filter((e) => e.type === 'integrate-conflicts' && (e === first || after(e.ts, first.ts)));
  const conflicted = new Set<string>();
  const regenerated = new Set<string>();
  for (const e of events) {
    for (const [key, into] of [['conflicts', conflicted], ['regenerated', regenerated]] as const) {
      const list: unknown = e[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.every(SAFE_CONFLICT)) return 0;
      for (const p of list) into.add(p);
    }
  }
  if (!conflicted.size && !regenerated.size) return 0;
  // Conflict names are only where git stopped; the integrator may change any file while resolving or
  // after. What it actually changed must be known, for the sides this episode merged and the sha the
  // passing verify checked, or the review stays.
  const touched = x.integrationTouched;
  const verified = x.job.verifyRuns.at(-1);
  if (!touched || !Array.isArray(touched.files) || touched.head !== first.head || touched.upstream !== first.upstream || !verified?.ok || touched.sha !== verified.sha) return 0;
  if (!touched.files.every(SAFE_CONFLICT)) return 0;
  const all = new Set([...conflicted, ...regenerated, ...touched.files]);
  const globs = generatedConfig(x.config)?.globs ?? [];
  const skippable = (p: string) => regenerated.has(p) || isDocs(p) || (globs.length > 0 && inSpec(p, globs));
  return [...all].every(skippable) ? all.size : 0;
}

function integrate(x: StepInput): StepAction {
  const j = x.job;
  // A job set to integrate before transitions were logged has no entry event; anchor on the later of
  // the decision that sent it here and the round's first passing verify, so an earlier episode's
  // events don't count while this episode's integration (and the verify after it) still do.
  const decided = lastEvent(x, (e) => e.type === 'decision')?.ts ?? null;
  const verified = j.verifyRuns.find((r) => r.round === j.round && r.ok)?.at ?? null;
  const since = stageSince(x) ?? (after(decided, verified) ? decided : verified);
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
    const next = afterIntegration(x);
    return toStage(x, 'IG3', next, next === 'pr' ? 'the branch is up to date: open the PR' : 'the branch is up to date: the approver decides');
  }
  const policy = x.config.pr.conflicts;
  const files = Array.isArray(first.conflicts) ? first.conflicts.length : 0;
  const approved = after(human(x, 'approve')?.ts, first.ts);
  if (policy === 'ask' && !approved) return set(x, 'IG4', { state: 'waiting', waitingOn: 'conflicts', reason: `conflicts with base: ${files} files` }, 'a human decides how to resolve conflicts');
  if (policy === 'defer') {
    const next = afterIntegration(x);
    return toStage(x, 'IG5', next, next === 'pr' ? 'conflicts deferred by pr.conflicts: open the PR' : 'conflicts deferred by pr.conflicts: the approver decides', { note: 'conflicts with base deferred' });
  }
  const integrator = agent(x, 'integrator');
  const runs = x.events.filter((e) => e.type === 'agent-start' && e.role === 'integrator' && after(e.ts, first.ts)).length;
  if (!integrator || !after(integrator.startedAt, first.ts)) return spawn(x, 'IG6', 'integrator');
  const n = needsInput(x, 'integrator');
  if (n) return n;
  const checks = verifiesAfter(integrator.endedAt);
  if (!checks.length) return run(x, 'IG7', ['verify', j.id], 'verify the conflict resolution');
  if (!checks.at(-1)!.ok) return park(x, 'IG7', 'escalation', 'integration: verify failed after conflict resolution');
  const reviewer = agent(x, 'reviewer:code');
  if (!after(reviewer?.startedAt, integrator.endedAt)) {
    const skipped = integrationReviewSkippable(x, first);
    if (skipped > 0) {
      const next = afterIntegration(x);
      // The note carries only a count: conflicted names are untrusted and never reach the command.
      return toStage(x, 'IG11', next, next === 'pr' ? 'only docs or generated files conflicted: open the PR' : 'only docs or generated files conflicted: the approver decides', {
        note: `integration review skipped: only docs or generated files conflicted, ${skipped} files`,
      });
    }
    return spawn(x, 'IG8', 'reviewer:code');
  }
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
  if (fresh.outcome === 'PASS') {
    const next = afterIntegration(x);
    return toStage(x, 'IG10', next, next === 'pr' ? 'the integration review passed: open the PR' : 'the integration review passed: the approver decides');
  }
  if (runs === 1) return spawn(x, 'IG10', 'integrator', { resume: true });
  return park(x, 'IG10', 'escalation', 'integration review: CHANGES');
}

function pr(x: StepInput): StepAction {
  const j = x.job;
  if (!x.config.pr.enabled) return toStage(x, 'PR1', 'done', 'PRs are off: the branch is the result', { tell: `${j.id} finished on branch ${safe(j.branch, SAFE_REF, 'its branch')}` });
  const res = resolveInterim(x.config, j);
  const edges = res.edges;
  const gates = releaseGates(edges, x.events, j);
  const bump = releaseBump(x, gates);
  if (bump) return bump;
  const last = j.verifyRuns.at(-1);
  if (!last?.ok) return run(x, 'PR2', ['verify', j.id], 'pr open needs a verified HEAD');
  // pr open pulled a PR branch that moved on the remote: a merged HEAD is not the one verified, and a
  // conflicting one needs a person (integrate merges the base, not the PR's remote branch).
  const pulled = lastEvent(x, (e) => e.type === 'pr-head-pulled');
  if (after(pulled?.ts, last.at)) {
    if (pulled!.pulled === 'conflicts')
      return park(x, 'PR11', 'human', `the PR branch moved on the remote and conflicts with the job HEAD: a human merges it in the worktree, then runs forge verify ${j.id}`);
    return run(x, 'PR2', ['verify', j.id], 'the PR branch moved on the remote and was merged in: verify the merged HEAD');
  }
  // The last open attempt: a deferral counts, so PR3 doesn't run pr open again on the same verify.
  const opened = lastEvent(x, (e) => e.type === 'pr-opened' || e.type === 'pr-updated' || e.type === 'pr-deferred');
  if (!after(opened?.ts, last.at)) return run(x, 'PR3', ['pr', 'open', j.id], 'push and open or update the PR');
  if (opened!.type === 'pr-deferred') return deferredPr(x, opened!);
  // The first draft consumer in merge order whose every gate is released leaves draft.
  for (const k of res.order) {
    const p = k === null ? j.pr : memberRepos(j).find((m) => m.repo === k)?.pr;
    const mine = gates.filter((g) => g.consumer === k);
    if (p?.state !== 'OPEN' || p.isDraft !== true || !mine.length || !mine.every((g) => g.gate === 'released')) continue;
    if (k !== null && !REPO_WORD.test(k)) continue;
    return run(x, 'PR10', ['pr', 'ready', j.id, ...(k === null ? ['--root'] : ['--repo', k])], 'release recorded and consumers bumped: mark the consumer ready for review');
  }
  // A local edge holds a consumer PR as a draft that nothing CI can build until its release is
  // recorded and bumped, a held or bump-due gate keeps it a draft, and a draft PR in a job with
  // interim edges is never merged: none of them merges unattended. A job without edges keeps its old
  // behaviour, so a single-repo `pr.draft: true` job still auto-merges (gh un-drafts it).
  const local = edges.some((e, i) => e.strategy === 'local' && gates[i].gate !== 'released');
  const held = gates.find((g) => g.gate === 'held' || g.gate === 'bump-due');
  const draft = edges.length > 0 && (j.pr?.isDraft === true || memberRepos(j).some((m) => m.pr?.isDraft === true));
  if (!local && !held && !draft && x.decision.autoMerge && autoMerge(x.config) && !j.protectedPaths?.hits?.length && !lastEvent(x, (e) => MERGE_EVENTS.includes(e.type) && after(e.ts, opened!.ts)))
    return run(x, 'PR4', ['pr', 'merge', j.id], 'the approver marked it auto-merge eligible');
  // Plain words only: the reason goes through shellLine, which allows no quote, pipe or angle bracket.
  const reason =
    held?.gate === 'held'
      ? `${repoWord(held.consumer)} PR stays a draft until the release of ${repoWord(held.dependency)} is recorded [interim: ${held.strategy}]: a human runs forge job interim release ${j.id} ${held.dependency === null ? '--root' : safe(held.dependency, REPO_WORD, '<repo>')} VERSION`
      : held
        ? `${repoWord(held.consumer)} PR waits on its release bump: forge verify ${j.id}`
        : undefined;
  return set(x, 'PR5', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', ...(reason ? { reason } : {}) }, 'the PR waits on human review');
}

const SAFE_VERSION = /^[0-9A-Za-z.+-]{1,120}$/;

/**
 * PR9: a release is recorded and some consumer is not bumped to it yet (a bump-due gate). Verify
 * bumps it, unless a verify newer than the record failed (park, until a human approves after it) or
 * passed without bumping (park).
 */
function releaseBump(x: StepInput, gates: ReturnType<typeof releaseGates>): StepAction | null {
  const due = gates.filter((g) => g.gate === 'bump-due');
  if (!due.length) return null;
  const j = x.job;
  let since: string | null = null;
  let first = due[0];
  for (const g of due) {
    const at = x.events[releaseIndex(x.events, g.dependency)]?.ts ?? null;
    if (at && (!since || at > since)) {
      since = at;
      first = g;
    }
  }
  const what = `${repoWord(first.dependency)} ${safe(first.version, SAFE_VERSION, 'version')}`;
  const runs = j.verifyRuns.filter((r) => after(r.at, since));
  if (!runs.length) return run(x, 'PR9', ['verify', j.id], `release of ${what} recorded: bump its consumers and verify`);
  const latest = runs.at(-1)!;
  if (!latest.ok) {
    if (after(human(x, 'approve')?.ts, latest.at)) return null;
    return park(x, 'PR9', 'escalation', `release bump: verify failed after the release of ${what}`);
  }
  return park(x, 'PR9', 'escalation', `release bump: verify passed without bumping ${repoWord(first.consumer)}`);
}

const REPO_WORD = /^[A-Za-z0-9._-]+$/;
const repoWord = (k: string | null): string => (k === null ? 'the root repo' : `repo ${safe(k, REPO_WORD, 'a member')}`);

/** PR6–PR8: the last pr open deferred some PRs; recorded PR states and canary events say what happens next. */
function deferredPr(x: StepInput, deferral: JobEvent): StepAction {
  const j = x.job;
  const deferred = readDeferrals(deferral.deferred);
  const state = (k: string | null) => (k === null ? j.pr?.state : memberRepos(j).find((m) => m.repo === k)?.pr?.state);
  const s = deferralStatus(deferred, state, x.events);
  if (s.canary) {
    const dep = s.canary.waitingOn[0];
    const pkg = safe(`${s.canary.name}@${s.canary.version}`, SAFE_ELEMENT, 'its package');
    const cmd = `forge job interim publish ${j.id} ${dep === null ? '--root' : safe(dep, REPO_WORD, '<repo>')} --confirm`;
    return park(x, 'PR6', 'human', `${repoWord(s.canary.repo)} waits on a canary of ${repoWord(dep)} [${pkg}]: a human runs ${cmd}`);
  }
  if (s.openable) return run(x, 'PR7', ['pr', 'open', j.id], 'every deferred PR can open now: its dependencies merged or the canary is published');
  const wait = s.sequential ?? deferred[0];
  const reason = wait ? `${repoWord(wait.repo)} PR opens after ${wait.waitingOn.map(repoWord).join(', ')} merges [interim: sequential]` : 'a deferred PR waits on its dependencies';
  return set(x, 'PR8', { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', reason }, 'a deferred PR opens once its dependencies merge');
}
