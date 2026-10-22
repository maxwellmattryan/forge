// The human delta: what people changed on a PR branch after Forge's last push. It is the
// escape rate that review threads only approximate, and the retro's strongest signal.
import { git } from './git.ts';
import type { HumanDelta } from './types.ts';

const MAX_FILES = 100;
// Shas reach git as arguments, and the head comes from GitHub: anything else could read as an option.
const SHA = /^[0-9a-f]{7,64}$/i;
// A missing commit can be a transient fetch failure, so a merged PR gets a few more syncs to find it.
const MAX_ATTEMPTS = 3;

export const isSha = (s: unknown): s is string => typeof s === 'string' && SHA.test(s);

/**
 * Fetches one commit by sha. GitHub keeps serving a PR's head after its branch is deleted.
 * Returns false without running git when `sha` is not a sha, so outside input never becomes an option.
 */
export function fetchCommit(cwd: string, remote: string, sha: unknown): boolean {
  if (!isSha(sha)) return false;
  return git(cwd, ['fetch', '--quiet', remote, '--', sha], { allowFail: true, write: true }).ok;
}

const empty = (status: 'rewritten' | 'unavailable', reason?: string): HumanDelta => ({
  status,
  ...(reason ? { reason } : {}),
  commits: null,
  linesAdded: null,
  linesDeleted: null,
  lines: null,
  fileCount: null,
  files: [],
});

/**
 * Counts commits and lines added on top of `base` along the branch's first-parent line.
 * Merge commits are skipped so base-branch work pulled in by "Update branch" never counts as
 * human edits; the price is that conflict fixes made inside a merge are not counted either.
 */
export function measureHumanDelta(cwd: string, base: string | null | undefined, head: string | null | undefined): HumanDelta {
  if (!base) return empty('unavailable', 'no pushed sha');
  if (!isSha(base) || !isSha(head)) return empty('unavailable', 'missing commits');
  for (const sha of [base, head]) {
    if (!git(cwd, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).ok) return empty('unavailable', 'missing commits');
  }
  if (!git(cwd, ['merge-base', '--is-ancestor', base, head], { allowFail: true }).ok) return empty('rewritten');
  const range = `${base}..${head}`;
  const commits = Number(git(cwd, ['rev-list', '--count', '--first-parent', '--no-merges', range]).stdout.trim());
  // -z keeps paths with spaces, tabs or newlines intact instead of git's quoted form.
  const out = git(cwd, ['log', '--first-parent', '--no-merges', '--no-renames', '--numstat', '-z', '--format=', range]).stdout;
  let linesAdded = 0, linesDeleted = 0;
  const seen = new Set<string>();
  for (const rec of out.split('\0')) {
    const m = rec.replace(/^\n+/, '').match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (!m) continue;
    // Binary files report "-": they still count as a changed file, with no lines.
    if (m[1] !== '-') linesAdded += Number(m[1]);
    if (m[2] !== '-') linesDeleted += Number(m[2]);
    seen.add(m[3]);
  }
  const all = [...seen].sort();
  return { status: 'measured', commits, linesAdded, linesDeleted, lines: linesAdded + linesDeleted, fileCount: all.length, files: all.slice(0, MAX_FILES) };
}

/** Whether this result may still change on a later sync (the commits were not found yet). */
const isRetryable = (d: Pick<HumanDelta, 'status' | 'reason' | 'attempts'> | null | undefined): boolean => d?.status === 'unavailable' && d.reason === 'missing commits' && (d.attempts ?? 1) < MAX_ATTEMPTS;

/**
 * Measure on the first sync that sees the merge, and again only while the commits could not be
 * found, up to MAX_ATTEMPTS, so one failed fetch does not settle the result for good.
 */
export const shouldMeasureDelta = (prState: string | undefined, existing: Pick<HumanDelta, 'status' | 'reason' | 'attempts'> | null | undefined): boolean => prState === 'MERGED' && (!existing || isRetryable(existing));

/** The compact form carried on the `pr-synced` event. */
export const deltaSummary = (d: Partial<HumanDelta> & Pick<HumanDelta, 'status' | 'commits' | 'lines' | 'fileCount'>): Pick<HumanDelta, 'status' | 'commits' | 'lines' | 'fileCount'> => ({ status: d.status, commits: d.commits, lines: d.lines, fileCount: d.fileCount });
