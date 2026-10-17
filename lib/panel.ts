// `forge job panel`: this round's review lenses, computed from recorded inputs and the branch diff.
// It runs once per build round, after verify and before any reviewer starts (step's RV9), so a build
// that wanders into files the spec never named still gets the lenses whose `paths` cover them.
import fs from 'node:fs';
import path from 'node:path';
import { configForJob } from './eval-overlay.ts';
import { jobDir, loadJob, logEvent, setJob } from './jobs.ts';
import { exists } from './paths.ts';
import { readMemberPanel } from './member-panel.ts';
import { approachPaths, committedChanges, realHistoryEnv, resolveBase, reviewedRepoDiffs } from './scope.ts';
import type { RepoScope } from './scope.ts';
import { choosePanel, parseSpecHeader } from './step.ts';
import type { Config } from './types.ts';
import { ForgeError, run } from './util.ts';

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
  const env = realHistoryEnv();
  const { baseRef, mergeBase } = resolveBase(cwd, config, job);
  const head = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd, env }).stdout.trim();
  const dirty = run('git', ['status', '--porcelain'], { cwd, env }).stdout.trim() !== '';
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
  logEvent(root, job.id, 'panel', { round: job.round, head, mergeBase, lenses, reasons, added, ...(multi ? { heads } : {}) });
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
    ...(multi
      ? { repos: diffs.map((d) => ({ repo: d.repo, base: d.baseRef, mergeBase: d.mergeBase, head: d.head, dirty: d.dirty, changed: d.changed.length })), heads, ...(problems.length ? { problems } : {}) }
      : {}),
  };
}
