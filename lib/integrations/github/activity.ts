// What is in flight on GitHub, for the overlap check (lib/engine/project/overlap.ts): the open PR list's
// extra fields, a branch's recent commits and their parsers. Every value here may come from a fork PR's
// author, so paths, refs, oids, logins and dates are checked once in the parsers and the rest is dropped.
// The gh calls are createGhGitHub's (pull-requests.ts), which imports this file.
import { sanitizeLogin } from '#core/job/schema.ts';
import { isInsidePath } from '#core/os/fs.ts';
import { SAFE_REF, isSha } from '#core/text.ts';
import type { BranchCommit, BranchHistory, OpenPr, PrSnapshot } from './types.ts';

/** `gh pr list --json` for openPrs: parsePr's fields plus who opened it, when, its files and its commits. */
export const OPEN_PR_FIELDS = 'number,url,state,isDraft,isCrossRepository,headRefName,baseRefName,headRefOid,statusCheckRollup,mergedAt,author,createdAt,files,changedFiles,commits';

/** The longest diff prDiff and commitDiff return; past it they throw `external`. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** The commits branchHistory reads per call. */
export const HISTORY_PAGE = 50;

/** A branch's commits since `$since`, newest first, each with the PR GitHub associates with it. Ref and since are variables, never query text. */
export const BRANCH_HISTORY_QUERY = `query($owner:String!,$name:String!,$ref:String!,$since:GitTimestamp!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){target{... on Commit{history(first:${HISTORY_PAGE},since:$since){pageInfo{hasNextPage} nodes{oid committedDate author{user{login}} associatedPullRequests(first:1){nodes{number headRefName isCrossRepository}}}}}}}}}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function dig(v: unknown, ...keys: string[]): unknown {
  let cur = v;
  for (const k of keys) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

const MAX_PATH = 300;
// C0, DEL and C1: a terminal escape in a path would reach the CLI's human output.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A repo-relative path from GitHub, or null: 1–300 characters, no control character, not absolute, no `..` segment. */
export function safePath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH || CONTROL.test(p) || !isInsidePath(p)) return null;
  return p;
}

/** A GitHub login, or null when sanitizeLogin would change it. */
export function safeLogin(v: unknown): string | null {
  return typeof v === 'string' && v && sanitizeLogin(v) === v ? v : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 timestamp GitHub prints, or null. */
export function safeDate(v: unknown): string | null {
  return typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** The paths of gh's `files` entries that pass safePath, in order, and how many were dropped. */
export function safePaths(entries: unknown): { files: string[]; dropped: number } {
  const files: string[] = [];
  let dropped = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const p = safePath(dig(e, 'path') ?? e);
    if (p === null) dropped++;
    else if (!files.includes(p)) files.push(p);
  }
  return { files, dropped };
}

/**
 * gh's open PR JSON (OPEN_PR_FIELDS) as an OpenPr, over `pr`, the snapshot parsePr built from the same
 * record. `filesComplete` is false when gh listed fewer files than the PR changes (it stops at 100).
 */
export function parseOpenPr(raw: unknown, pr: PrSnapshot): OpenPr {
  const r = isRecord(raw) ? raw : {};
  const { files, dropped } = safePaths(r.files);
  const changed = typeof r.changedFiles === 'number' && Number.isSafeInteger(r.changedFiles) && r.changedFiles >= 0 ? r.changedFiles : null;
  const commits = (Array.isArray(r.commits) ? r.commits : []).filter(isRecord).map((c) => ({
    oid: isSha(c.oid) ? c.oid : null,
    committedAt: safeDate(c.committedDate),
    authors: (Array.isArray(c.authors) ? c.authors : []).map((a) => safeLogin(dig(a, 'login'))).filter((l): l is string => l !== null),
  }));
  return {
    ...pr,
    author: safeLogin(dig(r, 'author', 'login')),
    createdAt: safeDate(r.createdAt),
    files,
    filesComplete: changed !== null && Array.isArray(r.files) && r.files.length >= changed,
    dropped,
    commits,
  };
}

/** BRANCH_HISTORY_QUERY's `.data` as checked commits: an oid that is not a sha, a bad date or login, or a bad PR ref becomes null. */
export function parseBranchHistory(data: unknown): BranchHistory {
  const history = dig(data, 'repository', 'ref', 'target', 'history');
  const nodes = dig(history, 'nodes');
  const commits: BranchCommit[] = (Array.isArray(nodes) ? nodes : []).filter(isRecord).map((n) => {
    const p = dig(n, 'associatedPullRequests', 'nodes');
    const first = Array.isArray(p) && isRecord(p[0]) ? p[0] : null;
    const number = first && typeof first.number === 'number' && Number.isSafeInteger(first.number) && first.number > 0 ? first.number : null;
    return {
      oid: isSha(n.oid) ? n.oid : null,
      committedAt: safeDate(n.committedDate),
      author: safeLogin(dig(n, 'author', 'user', 'login')),
      pr:
        first && number !== null
          ? { number, headRefName: typeof first.headRefName === 'string' && SAFE_REF.test(first.headRefName) ? first.headRefName : null, isCrossRepository: first.isCrossRepository !== false }
          : null,
    };
  });
  return { commits, complete: dig(history, 'pageInfo', 'hasNextPage') === false };
}
