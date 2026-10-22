// Review lens names. A plain name (`code`) is a lens of the root panel or the plugin catalog; a
// qualified name (`lib:realtime`) is a lens a member repo of the job defines for itself. Both reach
// shell lines, file names and job.json keys, so every caller checks names here first.
import { REPO_NAME } from '../../engine/project/member-repos.ts';
import type { Job } from '../types.ts';

export const LENS_NAME = /^[a-z0-9][a-z0-9-]*$/;
// REPO_NAME's body, so a repo name never starts with `-` and the whole name stays one shell word.
const REPO_BODY = REPO_NAME.source.replace(/^\^/, '').replace(/\$$/, '');
export const QUALIFIED_LENS = new RegExp(`^(${REPO_BODY}):([a-z0-9][a-z0-9-]*)$`);

/** A plain or qualified lens name. */
export function isLens(s: unknown): s is string {
  return typeof s === 'string' && (LENS_NAME.test(s) || QUALIFIED_LENS.test(s));
}

/** The repo (null for a plain name) and the lens name, or null when `s` is not a lens. */
export function splitLens(s: unknown): { repo: string | null; name: string } | null {
  if (typeof s !== 'string') return null;
  if (LENS_NAME.test(s)) return { repo: null, name: s };
  const m = QUALIFIED_LENS.exec(s);
  return m ? { repo: m[1], name: m[2] } : null;
}

/**
 * A lens's review file in its round directory. Windows forbids `:` in file names, so a qualified
 * lens maps to `<repo>.<name>.md`; plain names never contain `.`, so the mapping stays reversible.
 */
export function reviewFileName(lens: string): string {
  const q = QUALIFIED_LENS.exec(lens);
  return q ? `${q[1]}.${q[2]}.md` : `${lens}.md`;
}

/** The lens a review file belongs to, or null: the reverse of reviewFileName, split at the last `.`. */
export function lensFromReviewFile(file: string): string | null {
  if (!file.endsWith('.md')) return null;
  const stem = file.slice(0, -3);
  const dot = stem.lastIndexOf('.');
  if (dot < 0) return LENS_NAME.test(stem) ? stem : null;
  const lens = `${stem.slice(0, dot)}:${stem.slice(dot + 1)}`;
  return QUALIFIED_LENS.test(lens) ? lens : null;
}

/** The names of the job's reviewed members: every `repos` entry after the root mirror that is not verify-only. */
export function reviewedRepoNames(job: { repos?: Job['repos'] }): string[] {
  const repos = Array.isArray(job.repos) ? job.repos.slice(1) : [];
  return repos.filter((r) => typeof r?.repo === 'string' && !r.verifyOnly).map((r) => r.repo as string);
}

/** Whether `lens` may review this job: a plain lens always, a qualified one only for a reviewed member. */
export function lensRepoAllowed(job: { repos?: Job['repos'] }, lens: string): boolean {
  const s = splitLens(lens);
  if (!s) return false;
  return s.repo === null || reviewedRepoNames(job).includes(s.repo);
}
