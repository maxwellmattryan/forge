// The overlap check (`forge overlap`, docs/architecture/overlap.md): which other jobs, open PRs and people's
// recent pushes touch the files a job or PR changes, and one timing from a fixed rule. Read-only apart from
// its own report under .forge/runtime/overlap/: no fetch, checkout, adoption or agent. Job diffs run in the
// main checkout on committed history only; everything GitHub returns was checked by the adapter's parsers.
import fs from 'node:fs';
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { jobDir, listJobs, loadJob } from '#core/job/store.ts';
import { isMap } from '#core/shape.ts';
import { readRegularText, writeJsonAtomic } from '#core/os/fs.ts';
import { paths } from '#core/paths.ts';
import { SAFE_REF, isSha } from '#core/text.ts';
import { OVERLAP_SCHEMA_VERSION, OVERLAP_STEPS } from '#core/versions/overlap.ts';
import { runSteps } from '#core/versions/steps.ts';
import { diffPaths, diffSpans, sharedSpans } from '#integrations/git/hunks.ts';
import type { Span } from '#integrations/git/hunks.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { safePath } from '#integrations/github/activity.ts';
import type { GitHub, OpenPr } from '#integrations/github/types.ts';
import { PINNED_DIFF_OPTS } from '../guard/integrity.ts';
import { specFileMapPaths } from '../pipeline/acs.ts';
import { resolveBase } from '../pipeline/scope.ts';
import type { Config, LoadedJob, OverlapCounterpart, OverlapGap, OverlapKind, OverlapReason, OverlapReport, OverlapSource, OverlapTiming, Stage } from '#core/types.ts';

/** The open PRs one check reads; a full page adds a `truncated` gap. */
const PR_LIMIT = 50;
const MAX_FILES = 100;
const MAX_HUNKS = 50;
/** Commit diffs read for people's pushes, across every branch. */
const MAX_COMMIT_DIFFS = 50;
/** A job's `-U0` diff longer than this is not parsed for spans (`hunks-unread`). */
const MAX_LOCAL_DIFF = 8 * 1024 * 1024;
const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

const READY_STAGES: ReadonlySet<string> = new Set(['review', 'integrate', 'decide']);
const EARLY_STAGES: ReadonlySet<string> = new Set(['plan', 'spec', 'design']);
/** The timing table's order (docs/architecture/overlap.md), which `reasons` follows. */
const REASON_ORDER: readonly OverlapReason[] = ['github-unread', 'outside-pr', 'human-push', 'job-ahead', 'job-early', 'job-building', 'job-behind', 'no-overlap'];

export type OverlapSubject = { job: string } | { pr: number };

/** What `forge overlap` prints in agent mode: the report cut down, and where the full one is. */
export interface OverlapSummary {
  subject: OverlapReport['subject'];
  timing: OverlapReport['timing'];
  idle: boolean;
  reasons: OverlapReason[];
  counterparts: { kind: OverlapKind; ref: string; source: OverlapSource; human: boolean; stage: Stage | null; files: string[]; fileCount: number; sharedHunks: number }[];
  gaps: OverlapReport['gaps'];
  /** The full report, relative to the repo root. */
  report: string;
}

/** One side of a comparison: its paths (a file-map entry ending in `/` covers what is under it) and, read on demand, its base-side spans. */
interface Side {
  source: OverlapSource;
  files: string[];
  spans: () => Map<string, Span[]> | null;
}

/** A counterpart before the timing rule: the report's fields plus what the rule reads. */
interface Found extends OverlapCounterpart {
  ready: boolean;
  createdAt: string | null;
}

export interface TimingInput {
  /** The check tried GitHub and failed. */
  githubUnread: boolean;
  subject: { ref: string; ready: boolean; createdAt: string | null };
  counterparts: { kind: OverlapKind; ref: string; human: boolean; stage: Stage | null; ready: boolean; createdAt: string | null }[];
}

/** A job is ready at review, integrate or decide, or at pr with its PR open and checks passing or none. */
export function jobReady(job: Pick<LoadedJob, 'stage' | 'pr'>): boolean {
  if (READY_STAGES.has(job.stage)) return true;
  const checks = job.pr?.checks?.state;
  return job.stage === 'pr' && job.pr?.state === 'OPEN' && (checks === 'passing' || checks === 'none');
}

const createdMs = (at: string | null): number => {
  const t = at === null ? NaN : Date.parse(at);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/** `a` was created before `b`; ties go to the smaller ref. */
function older(a: { ref: string; createdAt: string | null }, b: { ref: string; createdAt: string | null }): boolean {
  const ta = createdMs(a.createdAt);
  const tb = createdMs(b.createdAt);
  return ta !== tb ? ta < tb : a.ref < b.ref;
}

/** The timing rule (docs/architecture/overlap.md): the first matching row wins, and `reasons` names every category present. */
export function overlapTiming(input: TimingInput): { timing: OverlapReport['timing']; reasons: OverlapReason[] } {
  const present = new Map<OverlapReason, string[]>();
  const add = (code: OverlapReason, ref: string) => present.set(code, [...(present.get(code) ?? []), ref]);
  for (const c of input.counterparts) {
    if (c.human) add(c.kind === 'push' ? 'human-push' : 'outside-pr', c.ref);
    else if (c.kind !== 'job') continue;
    else if (c.ready) add(!input.subject.ready || older(c, input.subject) ? 'job-ahead' : 'job-behind', c.ref);
    else add(c.stage !== null && EARLY_STAGES.has(c.stage) ? 'job-early' : 'job-building', c.ref);
  }
  if (input.githubUnread) present.set('github-unread', []);
  else if (!input.counterparts.length) present.set('no-overlap', []);
  const reasons = REASON_ORDER.filter((r) => present.has(r));
  const refs = (...codes: OverlapReason[]) => codes.flatMap((c) => present.get(c) ?? []);
  const kind: OverlapTiming = input.githubUnread || present.has('outside-pr') || present.has('human-push') ? 'needs-human' : present.has('job-ahead') ? 'wait-for' : input.counterparts.some((c) => c.kind === 'job') ? 'merge-first' : 'merge-now';
  const timingRefs =
    kind === 'needs-human' ? refs('outside-pr', 'human-push') : kind === 'wait-for' ? refs('job-ahead') : kind === 'merge-first' ? refs('job-early', 'job-building', 'job-behind') : [];
  return { timing: { kind, refs: [...new Set(timingRefs)].sort() }, reasons };
}

/** The paths `a` and `b` share, sorted: equal paths, and paths under a `/`-ending entry of the other side. */
function sharedFiles(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  const scan = (xs: readonly string[], ys: readonly string[]) => {
    const exact = new Set(ys);
    const dirs = ys.filter((p) => p.endsWith('/'));
    for (const p of xs) {
      if (exact.has(p)) out.add(p);
      for (const d of dirs) if (p !== d && p.startsWith(d)) out.add(p);
    }
  };
  scan(a, b);
  scan(b, a);
  return [...out].sort();
}

/** Base-side spans both sides change in the shared files, at most MAX_HUNKS; none when either side has no spans. */
function sharedHunks(a: Side, b: Side, files: readonly string[]): OverlapCounterpart['sharedHunks'] {
  if (a.source !== 'diff' || b.source !== 'diff') return [];
  const sa = a.spans();
  const sb = sa === null ? null : b.spans();
  if (sa === null || sb === null) return [];
  const out: OverlapCounterpart['sharedHunks'] = [];
  for (const p of files) for (const [start, end] of sharedSpans(sa.get(p) ?? [], sb.get(p) ?? [])) if (out.length < MAX_HUNKS) out.push({ path: p, start, end });
  return out;
}

/** Memoised: a span read runs at most once, and only when some counterpart shares a file. */
function once<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

/** The ways one check records what it could not read; deduplicated by code and ref. */
class Gaps {
  declare list: { code: OverlapGap; ref: string | null }[];
  constructor() {
    this.list = [];
  }
  add(code: OverlapGap, ref: string | null): void {
    if (!this.list.some((g) => g.code === code && g.ref === ref)) this.list.push({ code, ref });
  }
  has(code: OverlapGap): boolean {
    return this.list.some((g) => g.code === code);
  }
}

/** The paths that pass safePath, deduplicated; a drop is a `paths-dropped` gap for `ref`. */
function keepSafe(ps: readonly string[], ref: string, gaps: Gaps): string[] {
  const out = new Set<string>();
  for (const p of ps) {
    if (safePath(p) === null) gaps.add('paths-dropped', ref);
    else out.add(p);
  }
  return [...out].sort();
}

/** The commit `refs/heads/<branch>` names in the main checkout, or null: the branch must be a plain ref name. */
function branchSha(root: string, branch: string | null): string | null {
  if (!branch || !SAFE_REF.test(branch) || branch.includes('..')) return null;
  const r = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { env: historyEnv(), allowFail: true });
  const sha = r.ok ? r.stdout.trim() : '';
  return isSha(sha) ? sha : null;
}

/** A job branch's committed diff against its merge base, read in the main checkout; null when the base can't be resolved. */
function branchSide(root: string, config: Config, job: LoadedJob, sha: string, gaps: Gaps): Side | null {
  const env = historyEnv();
  let mergeBase: string;
  try {
    mergeBase = resolveBase(root, config, job, sha).mergeBase;
  } catch {
    return null;
  }
  if (!isSha(mergeBase)) return null;
  const names = git(root, ['diff', ...PINNED_DIFF_OPTS, '--no-renames', '--name-only', '-z', mergeBase, sha, '--'], { env, allowFail: true });
  if (!names.ok) return null;
  const files = keepSafe(names.stdout.split('\0').filter(Boolean), job.id, gaps);
  const spans = once(() => {
    // No pathspec: `:(…)` magic never applies, and the spans cover every file at once.
    const r = git(root, ['diff', ...PINNED_DIFF_OPTS, '--no-renames', '-U0', mergeBase, sha, '--'], { env, allowFail: true });
    if (!r.ok || r.stdout.length > MAX_LOCAL_DIFF) {
      gaps.add('hunks-unread', job.id);
      return null;
    }
    return diffSpans(r.stdout);
  });
  return { source: 'diff', files, spans };
}

/** What one check read from GitHub; null when it was off or unread. */
interface Remote {
  slug: string;
  prs: OpenPr[];
  /** A PR's diff, read once. */
  diff: (n: number) => string | null;
}

/** A PR's side: its listed files, plus the paths its diff names when the list stopped short; spans from the same diff. */
function prSide(remote: Remote, pr: OpenPr, ref: string, gaps: Gaps): Side {
  if (pr.dropped > 0) gaps.add('paths-dropped', ref);
  let files = pr.files;
  if (!pr.filesComplete) {
    const text = remote.diff(pr.number as number);
    if (text === null) gaps.add('truncated', ref);
    else files = keepSafe([...files, ...diffPaths(text)], ref, gaps);
  }
  const spans = once(() => {
    const text = remote.diff(pr.number as number);
    if (text === null) {
      gaps.add('hunks-unread', ref);
      return null;
    }
    return diffSpans(text);
  });
  return { source: 'diff', files: [...new Set(files)].sort(), spans };
}

/** A job read as a subject or counterpart reads it: its branch, else its open PR, else its spec's file map, else null. */
function jobSide(root: string, config: Config, job: LoadedJob, remote: Remote | null, gaps: Gaps): Side | null {
  const sha = branchSha(root, job.branch);
  const fromBranch = sha === null ? null : branchSide(root, config, job, sha, gaps);
  if (fromBranch) return fromBranch;
  // Only a PR GitHub lists with this job's branch as its same-repo head: job.json's PR number is never trusted.
  const pr = remote?.prs.find((p) => p.number !== null && !p.isCrossRepository && p.headRefName === job.branch);
  if (remote && pr) return prSide(remote, pr, job.id, gaps);
  const map = specFileMapPaths(readRegularText(path.join(jobDir(root, job.id), 'spec.md'), MAX_SPEC_BYTES) ?? '');
  return map.length ? { source: 'file-map', files: map, spans: () => null } : null;
}

const inFlight = (j: LoadedJob): boolean => !['done', 'cancelled'].includes(j.state) && !['backlog', 'done'].includes(j.stage) && j.kind !== 'eval';

const external = (e: unknown): boolean => e instanceof ForgeError && e.code === 'external';

/** One person's push group: a branch and the commits on it that no Forge job made. */
interface Push {
  branch: string;
  commits: { oid: string | null; at: number }[];
}

/** The `push` counterparts' sides, one per branch: the union of each commit's diff, at most MAX_COMMIT_DIFFS diffs in all. */
function pushSides(github: GitHub, root: string, remote: Remote, pushes: Push[], gaps: Gaps): { ref: string; side: Side; at: number }[] {
  let budget = MAX_COMMIT_DIFFS;
  const out: { ref: string; side: Side; at: number }[] = [];
  for (const push of pushes) {
    const newest = [...push.commits].sort((a, b) => b.at - a.at)[0];
    const ref = `${push.branch}@${newest.oid ? newest.oid.slice(0, 12) : 'unknown'}`;
    const files = new Set<string>();
    const spans = new Map<string, Span[]>();
    for (const c of push.commits) {
      if (c.oid === null) {
        gaps.add('github-unread', ref);
        continue;
      }
      if (budget-- <= 0) {
        gaps.add('truncated', ref);
        break;
      }
      let text: string;
      try {
        text = github.commitDiff(root, remote.slug, c.oid);
      } catch (e) {
        if (!external(e)) throw e;
        // A person's commit whose files are unknown can't be ruled out: fail closed.
        gaps.add('github-unread', ref);
        continue;
      }
      for (const p of keepSafe(diffPaths(text), ref, gaps)) files.add(p);
      for (const [p, s] of diffSpans(text)) spans.set(p, [...(spans.get(p) ?? []), ...s].sort((x, y) => x[0] - y[0]));
    }
    if (files.size) out.push({ ref, side: { source: 'diff', files: [...files].sort(), spans: () => spans }, at: newest.at });
  }
  return out;
}

/**
 * The overlap check for one subject: a job (`{ job }`) or an open PR (`{ pr }`). Writes the full report to
 * `.forge/runtime/overlap/{jobs,prs}/<ref>.json` and returns it with the agent-mode summary. Throws
 * `not_found` for an unknown job or a PR that is not open, `failed` for a job with nothing to compare,
 * and `external` when a PR subject's GitHub reads fail; a job subject records GitHub failures as gaps.
 */
export function overlap(root: string, config: Config, github: GitHub, subject: OverlapSubject, opts: { now?: () => number } = {}): { report: OverlapReport; summary: OverlapSummary; file: string } {
  const nowMs = (opts.now ?? Date.now)();
  const since = nowMs - config.overlap.recentHours * 3_600_000;
  const sinceIso = new Date(since).toISOString();
  const jobs = listJobs(root);
  const forgeBranches = new Set(jobs.map((j) => j.branch).filter((b): b is string => typeof b === 'string' && b.length > 0));
  const gaps = new Gaps();
  const isPr = 'pr' in subject;
  let job: LoadedJob | null = null;
  let prNumber: number | null = null;
  let base: string;
  let remote: Remote | null = null;
  let history: { oid: string | null; at: number; forge: boolean }[] = [];

  const connect = (): string => {
    github.require();
    return github.repoSlug(root, config);
  };
  const remoteOf = (slug: string, prs: OpenPr[]): Remote => {
    const diffs = new Map<number, string | null>();
    return {
      slug,
      prs,
      diff(n) {
        if (!diffs.has(n)) {
          try {
            diffs.set(n, github.prDiff(root, slug, n));
          } catch (e) {
            if (!external(e)) throw e;
            diffs.set(n, null);
          }
        }
        return diffs.get(n) ?? null;
      },
    };
  };
  const readHistory = (slug: string, branch: string) => {
    const h = github.branchHistory(root, slug, branch, sinceIso);
    if (!h.complete) gaps.add('truncated', branch);
    history = h.commits.map((c) => ({
      oid: c.oid,
      at: createdMs(c.committedAt),
      forge: c.pr !== null && !c.pr.isCrossRepository && c.pr.headRefName !== null && forgeBranches.has(c.pr.headRefName),
    }));
  };

  if (isPr) {
    prNumber = subject.pr;
    const slug = connect();
    let snap: ReturnType<GitHub['view']>;
    try {
      snap = github.view(root, slug, prNumber);
    } catch (e) {
      if (external(e) && /could not resolve to a pullrequest|no pull requests? found|no pr #/i.test((e as Error).message)) throw new ForgeError(`PR #${prNumber} is not open in ${slug}`, 'not_found');
      throw e;
    }
    if (snap.state !== 'OPEN' || snap.baseRefName === null) throw new ForgeError(`PR #${prNumber} is not open in ${slug}`, 'not_found');
    const owner = !snap.isCrossRepository && snap.headRefName !== null ? jobs.find((j) => j.branch === snap.headRefName) : undefined;
    if (owner) return overlap(root, config, github, { job: owner.id }, opts);
    base = snap.baseRefName;
    const prs = github.openPrs(root, slug, base, PR_LIMIT);
    if (prs.length >= PR_LIMIT) gaps.add('truncated', null);
    remote = remoteOf(slug, prs);
    readHistory(slug, base);
  } else {
    job = loadJob(root, subject.job);
    base = job.base ?? config.git.base;
    if (config.pr.enabled === false) gaps.add('github-off', null);
    else {
      try {
        const slug = connect();
        const prs = github.openPrs(root, slug, base, PR_LIMIT);
        if (prs.length >= PR_LIMIT) gaps.add('truncated', null);
        readHistory(slug, base);
        remote = remoteOf(slug, prs);
      } catch (e) {
        if (!external(e)) throw e;
        gaps.add('github-unread', null);
        remote = null;
        history = [];
      }
    }
  }

  // The subject's own side.
  const subjectRef = job ? job.id : `#${prNumber}`;
  let subjectSide: Side;
  let subjectReady = true;
  let subjectCreated: string | null = null;
  if (job) {
    const side = jobSide(root, config, job, remote, gaps);
    if (!side) throw new ForgeError(`job ${job.id} has no diff and no file map yet`, 'failed');
    subjectSide = side;
    subjectReady = jobReady(job);
    subjectCreated = job.createdAt;
  } else {
    const r = remote as Remote;
    const self = r.prs.find((p) => p.number === prNumber);
    if (self) subjectSide = prSide(r, self, subjectRef, gaps);
    else {
      // Past the first page of open PRs: its diff names its files.
      const text = r.diff(prNumber as number);
      if (text === null) throw new ForgeError(`gh pr diff #${prNumber} failed`, 'external');
      subjectSide = { source: 'diff', files: keepSafe(diffPaths(text), subjectRef, gaps), spans: once(() => diffSpans(text)) };
    }
    subjectCreated = self?.createdAt ?? null;
  }

  const found: Found[] = [];
  const consider = (kind: OverlapKind, ref: string, side: Side, extra: { human: boolean; stage: Stage | null; url: string | null; ready: boolean; createdAt: string | null }) => {
    const files = sharedFiles(subjectSide.files, side.files);
    if (!files.length) return;
    found.push({ kind, ref, source: side.source, files: files.slice(0, MAX_FILES), sharedHunks: sharedHunks(subjectSide, side, files), ...extra });
  };

  // Jobs in flight.
  const others = jobs.filter((j) => inFlight(j) && j.id !== job?.id);
  for (const other of others) {
    const side = jobSide(root, config, other, remote, gaps);
    if (!side) {
      gaps.add('job-unread', other.id);
      continue;
    }
    consider('job', other.id, side, { human: false, stage: other.stage, url: null, ready: jobReady(other), createdAt: other.createdAt });
  }

  // Open PRs and people's commits on them.
  let humanActivity = false;
  const pushes: Push[] = [];
  const inWindow = (at: number) => at >= since && at <= nowMs + 3_600_000;
  if (remote) {
    for (const pr of remote.prs) {
      if (pr.number === null || pr.number === prNumber) continue;
      const forgeJob = !pr.isCrossRepository && pr.headRefName !== null && forgeBranches.has(pr.headRefName) ? jobs.find((j) => j.branch === pr.headRefName) : undefined;
      if (!forgeJob) {
        if (pr.commits.some((c) => inWindow(createdMs(c.committedAt)))) humanActivity = true;
        consider('pr', `#${pr.number}`, prSide(remote, pr, `#${pr.number}`, gaps), { human: true, stage: null, url: pr.url, ready: true, createdAt: pr.createdAt });
        continue;
      }
      // A Forge job's PR: commits after the last push Forge recorded are a person's.
      const pushed = forgeJob.pr?.pushedSha ?? null;
      const at = pushed === null ? -1 : pr.commits.findIndex((c) => c.oid === pushed);
      const theirs = pr.commits.slice(at + 1).filter((c) => inWindow(createdMs(c.committedAt)));
      if (!theirs.length || pr.headRefName === null) continue;
      humanActivity = true;
      pushes.push({ branch: pr.headRefName, commits: theirs.map((c) => ({ oid: c.oid, at: createdMs(c.committedAt) })) });
    }
    // The base branch: commits no Forge job's PR brought, and not already in a job subject's branch.
    const subjectSha = job ? branchSha(root, job.branch) : null;
    const baseCommits = history.filter((c) => {
      if (c.forge || !inWindow(c.at)) return false;
      if (subjectSha && c.oid && git(root, ['merge-base', '--is-ancestor', c.oid, subjectSha], { env: historyEnv(), allowFail: true }).ok) return false;
      return true;
    });
    if (baseCommits.length) {
      humanActivity = true;
      pushes.unshift({ branch: base, commits: baseCommits.map((c) => ({ oid: c.oid, at: c.at })) });
    }
    for (const p of pushSides(github, root, remote, pushes, gaps)) consider('push', p.ref, p.side, { human: true, stage: null, url: null, ready: true, createdAt: null });
  }

  const order: Record<OverlapKind, number> = { push: 0, pr: 1, job: 2 };
  found.sort((a, b) => order[a.kind] - order[b.kind] || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const { timing, reasons } = overlapTiming({
    githubUnread: gaps.has('github-unread'),
    subject: { ref: subjectRef, ready: subjectReady, createdAt: subjectCreated },
    counterparts: found,
  });
  const githubRead = remote !== null && !gaps.has('github-unread');
  const report: OverlapReport = {
    schemaVersion: OVERLAP_SCHEMA_VERSION,
    checkedAt: new Date(nowMs).toISOString(),
    subject: { kind: job ? 'job' : 'pr', ref: subjectRef, source: subjectSide.source, files: subjectSide.files.length },
    base,
    recentHours: config.overlap.recentHours,
    counterparts: found.map(({ ready: _r, createdAt: _c, ...c }) => c),
    idle: others.length === 0 && !humanActivity && githubRead,
    timing,
    reasons,
    gaps: gaps.list,
  };
  const file = path.join(paths(root).overlap, job ? 'jobs' : 'prs', `${job ? job.id : prNumber}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, report);
  const summary: OverlapSummary = {
    subject: report.subject,
    timing,
    idle: report.idle,
    reasons,
    counterparts: report.counterparts.map((c) => ({ kind: c.kind, ref: c.ref, source: c.source, human: c.human, stage: c.stage, files: c.files.slice(0, 5), fileCount: c.files.length, sharedHunks: c.sharedHunks.length })),
    gaps: report.gaps,
    report: path.relative(root, file).split(path.sep).join('/'),
  };
  return { report, summary, file };
}

/**
 * Job `jobId`'s cached report, or null: no file, not JSON, not an object, a schemaVersion that is not an
 * integer from 1 to OVERLAP_SCHEMA_VERSION (a newer Forge wrote it), or no counterparts list.
 */
export function readOverlapReport(root: string, jobId: string): OverlapReport | null {
  try {
    jobDir(root, jobId);
  } catch {
    return null;
  }
  const text = readRegularText(path.join(paths(root).overlap, 'jobs', `${jobId}.json`), MAX_REPORT_BYTES);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isMap(raw)) return null;
  const v = raw.schemaVersion;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > OVERLAP_SCHEMA_VERSION) return null;
  const r = runSteps(OVERLAP_STEPS, raw, v as number) as Record<string, unknown>;
  if (!Array.isArray(r.counterparts) || !isMap(r.timing)) return null;
  return { ...(r as unknown as OverlapReport), schemaVersion: OVERLAP_SCHEMA_VERSION };
}
