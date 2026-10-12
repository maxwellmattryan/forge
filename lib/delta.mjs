// @ts-check
// The human delta: what people changed on a PR branch after Forge's last push. It is the
// escape rate that review threads only approximate, and the retro's strongest signal.
import { run } from './util.mjs';

const MAX_FILES = 100;
// Shas reach git as arguments, and the head comes from GitHub: anything else could read as an option.
const SHA = /^[0-9a-f]{7,64}$/i;

/**
 * @typedef {{status:'measured'|'rewritten'|'unavailable', reason?:string, commits:number|null,
 *   linesAdded:number|null, linesDeleted:number|null, lines:number|null, fileCount:number|null, files:string[]}} HumanDelta
 */

/** @param {'rewritten'|'unavailable'} status @param {string} [reason] @returns {HumanDelta} */
const empty = (status, reason) => ({
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
 * @param {string} cwd @param {string|null|undefined} base @param {string|null|undefined} head
 * @returns {HumanDelta}
 */
export function measureHumanDelta(cwd, base, head) {
  if (!base) return empty('unavailable', 'no pushed sha');
  if (!head || !SHA.test(base) || !SHA.test(head)) return empty('unavailable', 'missing commits');
  for (const sha of [base, head]) {
    if (!run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, allowFail: true }).ok) return empty('unavailable', 'missing commits');
  }
  if (!run('git', ['merge-base', '--is-ancestor', base, head], { cwd, allowFail: true }).ok) return empty('rewritten');
  const range = `${base}..${head}`;
  const commits = Number(run('git', ['rev-list', '--count', '--first-parent', '--no-merges', range], { cwd }).stdout.trim());
  // -z keeps paths with spaces, tabs or newlines intact instead of git's quoted form.
  const out = run('git', ['log', '--first-parent', '--no-merges', '--no-renames', '--numstat', '-z', '--format=', range], { cwd }).stdout;
  let linesAdded = 0, linesDeleted = 0;
  const seen = new Set();
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

/** Measure once, on the first sync that sees the merge. @param {string|undefined} prState @param {any} existing */
export const shouldMeasureDelta = (prState, existing) => prState === 'MERGED' && !existing;

/** The compact form carried on the `pr-synced` event. @param {any} d */
export const deltaSummary = (d) => ({ status: d.status, commits: d.commits, lines: d.lines, fileCount: d.fileCount });
