// `forge job panel`: this round's review lenses, computed from recorded inputs and the branch diff.
// It runs once per build round, after verify and before any reviewer starts (step's RV9), so a build
// that wanders into files the spec never named still gets the lenses whose `paths` cover them.
import fs from 'node:fs';
import path from 'node:path';
import { configForJob } from './eval-overlay.ts';
import { STATUS_ARGV, git, historyEnv } from './git.ts';
import { jobDir, loadJob, logEvent, readEvents, setJob } from './jobs.ts';
import { exists } from './paths.ts';
import { readMemberPanel } from './member-panel.ts';
import { approachPaths, committedChanges, resolveBase, reviewedRepoDiffs } from './scope.ts';
import type { RepoScope } from './scope.ts';
import { choosePanel, parseSpecHeader, reworkPanel } from './step.ts';
import type { Config } from './types.ts';
import { ForgeError } from './util.ts';

/** What `forge job panel` prints: jobPanel. */
export interface PanelReport {
  id: string;
  round: number;
  base: string;
  mergeBase: string;
  head: string;
  dirty: boolean;
  changed: number;
  lenses: string[];
  reasons: Record<string, string[]>;
  added: string[];
  /** Only in a job with a reviewed member: each member's comparison point and counts, and its HEAD. */
  repos?: RepoScope[];
  heads?: Record<string, string>;
  /** Member panel entries that were dropped, as `repo <name>: …`; omitted when empty. */
  problems?: string[];
  /** Only on a narrowed rework round: the lenses that re-run, and the ones that keep their last PASS. */
  rerun?: string[];
  skipped?: string[];
}

// The stored sha is agent-reachable job state: only a full object name ever reaches git's argv.
const SHA = /^[0-9a-f]{40,64}$/;

/**
 * Files changed between the commit round `round`'s review saw (its `verdicts` event sha) and HEAD,
 * or null when that sha is missing, malformed, or not an ancestor of HEAD (history was rewritten,
 * so a small diff could hide work the passed lenses never saw).
 */
function changedSinceReview(root: string, id: string, round: number, cwd: string): string[] | null {
  const sha = readEvents(root, id).findLast((e) => e.type === 'verdicts' && e.round === round)?.sha;
  if (typeof sha !== 'string' || !SHA.test(sha)) return null;
  const env = historyEnv();
  if (!git(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD'], { env, allowFail: true }).ok) return null;
  try {
    return committedChanges(cwd, sha);
  } catch {
    return null;
  }
}

/**
 * Records this round's lenses on `job.reviewers` (only when they changed, so an unchanged panel
 * writes no `fields` event) and always logs one `panel` event with the reasons, which step reads
 * to know this round's panel is current. The previous reviewers are carried, so a lens never drops.
 */
export function jobPanel(root: string, base: Config, id: string): PanelReport {
  const job = loadJob(root, id);
  // An eval job's overlay decides its panel, as it does everything else step reads.
  const config = configForJob(root, base, job);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree yet; run: forge worktree create ${id}`);
  const specFile = path.join(jobDir(root, job.id), 'spec.md');
  if (!exists(specFile)) throw new ForgeError(`job ${id} has no spec.md`);
  const cwd = job.worktree;
  const env = historyEnv();
  const { baseRef, mergeBase } = resolveBase(cwd, config, job);
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], { env }).stdout.trim();
  const dirty = git(cwd, [...STATUS_ARGV], { env }).stdout.trim() !== '';
  const changed = committedChanges(cwd, mergeBase);
  // Before any write: a member whose worktree or panel config can't be used fails the command, so
  // the round never reviews with one of its lenses silently missing.
  const diffs = reviewedRepoDiffs(root, config, job);
  const problems: string[] = [];
  const members = diffs.map((d) => {
    const mp = readMemberPanel(root, config, d.repo);
    problems.push(...mp.problems);
    return { repo: d.repo, lenses: mp.entries, changed: d.changed };
  });

  const specText = fs.readFileSync(specFile, 'utf8');
  const previous = job.reviewers;
  const { lenses, reasons } = choosePanel({
    kind: job.kind,
    config,
    suggested: parseSpecHeader(specText).suggested,
    approachPaths: approachPaths(specText),
    changed,
    carried: previous,
    ...(members.length ? { members } : {}),
  });
  const added = lenses.filter((l) => !previous.includes(l));
  if (lenses.join(',') !== previous.join(',')) setJob(root, job.id, { fields: { reviewers: lenses } });
  const heads = Object.fromEntries(diffs.map((d) => [d.repo, d.head]));
  const multi = diffs.length > 0;
  const rework =
    config.review.onRework === 'narrow' && job.round >= 2 && !multi
      ? reworkPanel({ job, config, lenses, changedSince: changedSinceReview(root, job.id, job.round - 1, cwd), members: diffs.length })
      : null;
  logEvent(root, job.id, 'panel', { round: job.round, head, mergeBase, lenses, reasons, added, ...(multi ? { heads } : {}), ...(rework ? { rerun: rework.rerun, rerunReasons: rework.reasons } : {}) });
  const total = changed.length + diffs.reduce((n, d) => n + d.changed.length, 0);
  return {
    id: job.id,
    round: job.round,
    base: baseRef,
    mergeBase,
    head,
    dirty,
    changed: total,
    lenses,
    reasons,
    added,
    ...(rework ? { rerun: rework.rerun, skipped: rework.skipped } : {}),
    ...(multi
      ? { repos: diffs.map((d) => ({ repo: d.repo, base: d.baseRef, mergeBase: d.mergeBase, head: d.head, dirty: d.dirty, changed: d.changed.length })), heads, ...(problems.length ? { problems } : {}) }
      : {}),
  };
}
