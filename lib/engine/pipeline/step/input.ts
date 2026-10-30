// loadStepInput: the one place `forge job step` reads disk. Everything step decides from is read
// here once, so step itself stays a pure function of the StepInput.
import fs from 'node:fs';
import path from 'node:path';
import { acCoverage, specFileMapPaths, specUiAcs } from '../acs.ts';
import { readJobRecord, readSharedRecord } from '../../environment/backing.ts';
import { effectiveLimits, exceededKeys, measureJob } from '../../metrics/budget.ts';
import { jobPathMap } from '../brief.ts';
import { environmentState } from '../../environment/record.ts';
import { configForJob } from '../../evals/overlay.ts';
import { loadTask } from '../../evals/run.ts';
import { jobDir, loadJob, parseDecision, readEvents, requestBody, roundVerdicts } from '#core/job/store.ts';
import { jobEndpoints } from '../../environment/endpoints.ts';
import { memberRepos, trustedMemberWorktree } from '../../project/job-repos.ts';
import { lensChecklists } from '../member-panel.ts';
import { PLUGIN_ROOT, exists } from '#core/paths.ts';
import { pluginHash } from '../../evals/provenance.ts';
import { hasFixtures, loadFixtures } from '../../evals/recall.ts';
import { inSpec } from '#core/glob.ts';
import { approachPaths, committedChanges, integrationTouched, resolveBase, reviewedSha } from '../scope.ts';
import { reviewedRepoNames } from '#core/job/lens.ts';
import type { Config, Job, JobEvent } from '#core/types.ts';
import type { StepFile, StepInput, StepVerdicts } from '../types.ts';
import { isInsidePath, readJson, readText } from '#core/os/fs.ts';
import { INSTRUCTION_ROLES, changedInstructionFiles, instructionsFor } from '#core/config/validators/instructions.ts';
import { loadVerifiers, verifierCount } from '../verifiers.ts';
import { currentRerun, reworkReviewFiles, roundLenses } from './panel.ts';
import { lastRun } from '../../verify/record.ts';
import { decisionCurrent, decisionEligible, lastDecision, reviewCurrent } from '../../pr/eligible.ts';
import { autoMerge, worktreeRoot } from '#core/config/load.ts';
import { UUID, readInfo, roleRunFiles } from '#core/job/session-files.ts';
import { roleRunTranscriptById } from '#integrations/claude/transcripts.ts';
import { ended } from './facts.ts';

/** Request bodies above this, or with this many list or heading lines, get a planner under `pipeline.plan: auto`. */
export const PLAN_AUTO_CHARS = 600;
export const PLAN_AUTO_LINES = 3;

/** Events loadStepInput keeps; everything else in events.jsonl is noise to step. */
const STEP_EVENTS = new Set([
  'human', 'round', 'worktree', 'worktree-setup-failed', 'pr-find', 'pr-adopted', 'scope', 'panel', 'integrated', 'integrate-conflicts',
  'integration-review', 'decision', 'fields', 'pr-opened', 'pr-updated', 'pr-merged', 'pr-auto-merge', 'pr-merge-deferred',
  'pr-merge-refused', 'pr-merge-failed', 'eval-graded', 'transition', 'agent-start', 'agent-end', 'secret-found', 'verifiers',
  'protected-path', 'repo-proposed', 'pr-deferred', 'canary-published', 'interim-released', 'interim-bumped', 'pr-ready', 'downstream-checked', 'job-repo-added',
  'job-repo-removed', 'pr-head-pulled', 'recall', 'permission-timed-out', 'push-held', 'pr-gate', 'gate', 'builder-note',
]);

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
  // Every role's instruction files, so renderBrief picks its role's list without reading disk. The
  // main checkout's copies: the worktree's are the branch's edits, data to review.
  for (const r of [undefined, ...INSTRUCTION_ROLES])
    for (const f of instructionsFor(config, r)) {
      const abs = path.join(root, f);
      if (!present.includes(abs) && exists(abs)) present.push(abs);
    }
  const body = requestBody(root, job.id);
  const specText = read('spec.md') ?? '';
  // reviewCurrent reads the full log: the `verdicts` event stays out of step's own events.
  const all = readEvents(root, job.id);
  const events = all.filter((e) => STEP_EVENTS.has(e.type));
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
    decision: { decision: parseDecision(root, job.id).decision },
    // Only where PR4 can use it: the check runs git in every job repo.
    decisionCurrent: job.stage === 'pr' && autoMerge(config) && decisionEligible(lastDecision(events)) ? decisionCurrent(root, config, job, events) : null,
    // Only where DC11 and PR12 read it: the check runs git in every job repo.
    reviewCurrent: ['decide', 'pr'].includes(job.stage) && job.state === 'running' && job.kind !== 'eval' ? reviewCurrent(root, config, job, all) : null,
    // The full log: `verdicts` stays out of step's own events, as for reviewCurrent.
    reviewedShas: loadReviewedShas(job, all),
    verdicts: {
      round: job.round >= 1 && lenses.length ? compact(roundVerdicts(root, job.id, job.round, lenses, config.review.blockOn)) : null,
      integration: job.stage === 'integrate' ? compact(roundVerdicts(root, job.id, 'integration', ['code'], config.review.blockOn)) : null,
    },
    acs: acCoverage(read('spec.md'), read('build.md')),
    // Only at build: the walk reads the worktree, and only the fresh builder brief uses it.
    folderMaps: job.stage === 'build' && job.worktree && exists(job.worktree) && specText ? folderMaps(job.worktree, specFileMapPaths(specText)) : null,
    // The main checkout's verifiers, the same root verifierCount reads, so a branch can't add or weaken one.
    verifierQuestions: job.stage === 'build' && specText ? verifierQuestions(root, specFileMapPaths(specText)) : null,
    instructionsChanged: loadInstructionsChanged(config, job),
    runtime,
    environment: environmentState(root, job.id),
    events,
    evalTask,
    checklists: lensChecklists(root, config, job, names),
    integrationTouched: loadIntegrationTouched(job, config, events),
    // Fixtures and the paths come from the main checkout and its config, never the branch's.
    recall: loadRecall(root, config, job),
    // The main checkout's, never the worktree's: a branch can't switch the gate on or off.
    verifiers: verifierCount(root),
    ...(config.backing?.length ? { backing: { job: readJobRecord(root, job.id, config), shared: readSharedRecord(root, config) } } : {}),
    now: new Date().toISOString(),
    endpoints: config.commands.dev ? jobEndpoints(root, config, job).components.map((e) => ({ name: e.name, url: e.url })) : [],
    // The computed path, never job.json's: the session can write job.json, and verdicts trusts the same value.
    memberWorktrees: Object.fromEntries(memberRepos(job).map((m) => [m.repo, trustedMemberWorktree(root, config, job, m.repo)])),
    // Only at a budget park: measuring runs git, and only GA7 reads it.
    budgetExceeded: job.state === 'waiting' && job.waitingOn === 'budget' ? exceededKeys(effectiveLimits(config, job), measureJob(root, config, job), job.budget.ack, job.round).map((e) => e.key) : null,
    lastSessions: loadLastSessions(root, config, job),
  };
}

/** The stages whose spawns may resume a role's last session: B4's builder and the review panel's lenses. */
const RESUME_STAGES: readonly string[] = ['build', 'review'];

/**
 * Each rework role's last run as a session a resume could continue: a `builder` or `reviewer:*` record that ended with
 * a uuid `agentId` whose runner sidecar (outside every write root) has `v: 1` and names that same role. job.json is
 * agent-writable, so the sidecar is what binds a session to its role: an id planted on another role finds a sidecar
 * naming the role that ran it, and gets no entry. The uuid check comes before any path is built from the id.
 */
export function loadLastSessions(root: string, config: Config, job: Job): StepInput['lastSessions'] {
  const out: StepInput['lastSessions'] = {};
  if (!RESUME_STAGES.includes(job.stage) || !job.worktree || !exists(job.worktree)) return out;
  const worktrees = worktreeRoot(root, config);
  for (const [role, a] of Object.entries(job.agents)) {
    if (role !== 'builder' && !role.startsWith('reviewer:')) continue;
    const id = a?.agentId;
    if (!ended(a) || typeof id !== 'string' || !UUID.test(id)) continue;
    let info: any;
    try {
      info = readInfo(roleRunFiles(root, job.id, id).cum);
    } catch {
      continue;
    }
    if (info?.v !== 1 || info.role !== role) continue;
    const context = typeof info.context === 'number' && Number.isFinite(info.context) && info.context >= 0 ? info.context : null;
    out[role] = { session: id, transcript: roleRunTranscriptById(root, job, id, { worktrees }) !== null, context };
  }
  return out;
}

const MAP_READ_CAP = 64 * 1024;
const MAX_FOLDER_MAPS = 8;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
// Bounded and with no adjacent quantifiers: a map is builder-writable on its branch.
const DESIGN_LINK = /\]\(([^()\s]{1,300})\)/g;

/** The first MAP_READ_CAP bytes of a regular file, through one descriptor that follows no symlink and never blocks on a FIFO; null on any failure. */
function readCapped(abs: string): string | null {
  let fd: number | undefined;
  try {
    const link = fs.lstatSync(abs);
    if (!link.isFile()) return null;
    fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== link.dev || st.ino !== link.ino) return null;
    const buf = Buffer.alloc(Math.min(st.size, MAP_READ_CAP));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The fresh builder brief's `Maps (JSON)` line: for each file-map path, the nearest `AGENTS.md`
 * above it short of the root one (already in every session's context), then the `.md` targets of
 * each map's `- Design:` bullet. Both the spec and the maps are agent-written, so only regular files
 * whose real path is inside the worktree count, and only paths are returned, never file text.
 */
export function folderMaps(worktree: string, files: readonly string[]): { maps: string[]; topics: string[]; more?: number } {
  let real: string;
  try {
    real = fs.realpathSync(worktree);
  } catch {
    return { maps: [], topics: [] };
  }
  // A worktree-relative posix path that is a regular file (no symlink, no FIFO) whose real path stays inside.
  const regular = (rel: string): boolean => {
    const abs = path.join(worktree, rel);
    try {
      if (!fs.lstatSync(abs).isFile()) return false;
      const r = path.relative(real, fs.realpathSync(abs));
      return r !== '' && !path.isAbsolute(r) && r.split(path.sep)[0] !== '..';
    } catch {
      return false;
    }
  };
  const nearest = new Map<string, string | null>();
  const mapFor = (dir: string): string | null => {
    const seen: string[] = [];
    let found: string | null = null;
    for (let d = dir; d && d !== '.' && d !== '/'; d = path.posix.dirname(d)) {
      const known = nearest.get(d);
      if (known !== undefined) {
        found = known;
        break;
      }
      seen.push(d);
      if (regular(`${d}/AGENTS.md`)) {
        found = `${d}/AGENTS.md`;
        break;
      }
    }
    for (const d of seen) nearest.set(d, found);
    return found;
  };
  const maps: string[] = [];
  for (const f of files) {
    if (!isInsidePath(f)) continue;
    const p = path.posix.normalize(f);
    let isDir = p.endsWith('/');
    if (!isDir) {
      try {
        isDir = fs.statSync(path.join(worktree, p)).isDirectory();
      } catch {}
    }
    const map = mapFor(isDir ? p.replace(/\/+$/, '') : path.posix.dirname(p));
    if (map && !maps.includes(map)) maps.push(map);
  }
  const topics: string[] = [];
  for (const map of maps) {
    const line = (readCapped(path.join(worktree, map)) ?? '').split('\n').find((l) => l.startsWith('- Design:'));
    if (!line) continue;
    const dir = path.posix.dirname(map);
    for (const m of line.matchAll(DESIGN_LINK)) {
      const target = m[1].split('#')[0];
      if (!target.endsWith('.md') || path.posix.isAbsolute(target) || /^[A-Za-z]:|^\\/.test(target)) continue;
      const rel = path.posix.normalize(path.posix.join(dir, target));
      if (isInsidePath(rel) && !topics.includes(rel) && regular(rel)) topics.push(rel);
    }
  }
  const more = Math.max(0, maps.length - MAX_FOLDER_MAPS) + Math.max(0, topics.length - MAX_FOLDER_MAPS);
  const abs = (list: string[]) => list.slice(0, MAX_FOLDER_MAPS).map((rel) => path.join(worktree, rel));
  return { maps: abs(maps), topics: abs(topics), ...(more ? { more } : {}) };
}

/**
 * The fresh builder brief's `Verifier questions (JSON)` line: the main checkout's valid verifiers
 * (never problem files) with a `paths` glob matching a file-map path, in loadVerifiers' order, as
 * name and parsed question only. The file-map paths only select; none is returned.
 */
export function verifierQuestions(root: string, files: readonly string[]): { name: string; question: string }[] {
  return loadVerifiers(root)
    .verifiers.filter((v) => files.some((f) => inSpec(f, v.paths)))
    .map(({ name, question }) => ({ name, question }));
}

/**
 * Earlier round → the validated sha its review saw (reviewedSha), for the round 2+ reviewer brief's
 * `Changed since:` line; {} unless the job is in review at round 2+, with no open PR, no reviewed
 * member and an existing worktree.
 */
export function loadReviewedShas(job: Job, events: JobEvent[]): Record<string, string> {
  // Only where a reviewer brief reads it: one git call per earlier round.
  if (job.stage !== 'review' || job.round < 2 || job.pr?.state === 'OPEN' || reviewedRepoNames(job).length || !job.worktree || !exists(job.worktree)) return {};
  const out: Record<string, string> = {};
  for (let r = 1; r < job.round; r++) {
    const sha = reviewedSha(events, r, job.worktree);
    if (sha) out[String(r)] = sha;
  }
  return out;
}

/** Only when a skip is possible: integrate, code-only, the last verify passed, and the last conflicts event names both sides. */
export function loadIntegrationTouched(job: Job, config: Config, events: JobEvent[]): StepInput['integrationTouched'] {
  if (job.stage !== 'integrate' || config.pr.integrationReview !== 'code-only' || !job.worktree || !exists(job.worktree)) return null;
  const last = lastRun(job);
  const ev = events.findLast((e) => e.type === 'integrate-conflicts');
  if (!last?.ok || !last.sha || !ev || typeof ev.head !== 'string' || typeof ev.upstream !== 'string') return null;
  return { head: ev.head, upstream: ev.upstream, sha: last.sha, files: integrationTouched(job.worktree, ev.head, ev.upstream, last.sha) };
}

/**
 * The instruction files the branch's committed diff (merge base up to HEAD) changed: [] without a
 * worktree, null when git fails or the base does not resolve. Not gated on round: an adopted PR
 * branch has commits before round 1.
 */
export function loadInstructionsChanged(config: Config, job: Job): string[] | null {
  const wt = job.worktree;
  if (!wt || !exists(wt)) return [];
  try {
    return changedInstructionFiles(config, committedChanges(wt, resolveBase(wt, config, job).mergeBase));
  } catch {
    return null;
  }
}

/** The recall gate's paths when a config predates evals.recall. */
const RECALL_PATHS = ['agents/', 'reviewers/', 'lib/engine/pipeline/brief.ts'];

/** The stages the recall gate reads in: RC1 runs the eval before the approver, PR17 holds the merge without a record. */
const RECALL_STAGES: readonly string[] = ['decide', 'pr'];

/**
 * The recall gate from what was read: null unless the job is a non-eval job in decide or pr with a
 * worktree and the main checkout has fixtures. `changed` null means git failed, which fails closed.
 */
export function recallGate(
  job: Pick<Job, 'stage' | 'kind'>,
  config: Config,
  seen: { worktree: boolean; fixtures: boolean; changed: string[] | null; pluginHash: string | null; invalid?: boolean },
): StepInput['recall'] {
  if (!RECALL_STAGES.includes(job.stage) || job.kind === 'eval' || !seen.worktree || !seen.fixtures) return null;
  if (seen.changed === null) return { required: true, pluginHash: null };
  const tokens = config.evals?.recall?.paths ?? RECALL_PATHS;
  const required = seen.changed.some((f) => inSpec(f, tokens));
  return required && seen.invalid ? { required, pluginHash: seen.pluginHash, invalidFixtures: true } : { required, pluginHash: seen.pluginHash };
}

/** loadStepInput's recall read: the committed diff since the merge base, the worktree's pluginHash, and whether the fixtures load. */
export function loadRecall(root: string, config: Config, job: Job): StepInput['recall'] {
  const worktree = Boolean(job.worktree && exists(job.worktree));
  // Nothing below runs unless the gate can apply: git and the hash cost a few ms on every step.
  if (!RECALL_STAGES.includes(job.stage) || job.kind === 'eval' || !worktree || !hasFixtures(root)) return recallGate(job, config, { worktree, fixtures: false, changed: [], pluginHash: null });
  let changed: string[] | null = null;
  let hash: string | null = null;
  try {
    changed = committedChanges(job.worktree!, resolveBase(job.worktree!, config, job).mergeBase);
    hash = pluginHash(job.worktree!);
  } catch {
    changed = null;
    hash = null;
  }
  // A fixture that does not load makes `start` exit before it logs, so RC1 could never count two starts.
  const invalid = changed !== null && loadFixtures(root).problems.length > 0;
  return recallGate(job, config, { worktree, fixtures: true, changed, pluginHash: changed === null ? null : hash, invalid });
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
    // `Services:` is the header's old name: a spec written before the rename reads the same way.
    components: items(value('Components') ?? value('Services')),
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
