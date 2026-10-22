// `policy.protectedPaths`: paths only a human may change. Paths are code, judgement calls are prose:
// the CLI enforces these rules when a change is staged or committed (`forge git add|commit`), again
// over the whole branch at `forge verify` and `forge pr open`, and `forge job step` parks a job whose
// escalate paths no human approved (PP1). docs/CONFIG.md "Protected paths" has the user-facing rules.
// No imports from worktree.ts or evals.ts: worktree.ts imports this module.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { betterMatch, matchPolicy, matchWith, policyRules } from './policy-check.ts';
import type { PolicyMatch } from './policy-check.ts';
import { PINNED_GIT_CONFIG } from './git-pins.ts';
import { globToRegExp } from './glob.ts';
import { isForemanActor, jobDir, loadJob, logEvent, updateJob } from './jobs.ts';
import { resolveBase } from './scope.ts';
import type { Config, Job, JobEvent, ProtectedHit, ProtectedPaths, ProtectedRule } from './types.ts';
import { ForgeError, now, run, writeTextAtomic } from './util.ts';

export type ProtectedAction = ProtectedRule['action'];
export type ProtectedGate = ProtectedPaths['gate'];

/** One `git diff --raw` entry: with `--no-renames`, a rename is a delete plus an add. */
export interface DiffEntry {
  path: string;
  status: string;
  oldMode: string;
  newMode: string;
  oldBlob: string | null;
  newBlob: string | null;
}

/** What checkProtected finds: refused and escalated hits, sorted by path. */
export interface ProtectedCheck {
  refused: ProtectedHit[];
  escalated: ProtectedHit[];
}

/** Hits kept on the job flag; `more` counts the rest. */
export const MAX_HITS = 200;
/** Paths named in an event, a brief or a JSON reply. */
export const LIST_LIMIT = 20;
/** protected.diff is capped here, with a note, so a lockfile rewrite can't fill the job dir. */
export const DIFF_CAP = 1024 * 1024;
const LINK_MAX = 4096;
/** Bytes of paths per `git diff` call when writing protected.diff, so argv stays bounded. */
const ARGV_CHUNK = 64 * 1024;
const LINK_MODES = new Set(['120000', '160000']);
const NULL_SHA = /^0+$/;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Paths printed in the PP1 reason: shellLine's safe class (with `:` for a member repo's `<repo>:<path>`), never an option. */
const REASON_PATH = /^[A-Za-z0-9._:/@+-]+$/;

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- links ----------

/**
 * Whether `dir` could stand in for a directory a glob reaches into: a symlink named `.github`
 * replaces everything under `.github/workflows/**`. Leading parts that are only `**` don't count,
 * or every symlink would match `**\/*.tf`.
 */
function leadsInto(dir: string, glob: string): boolean {
  const segs = glob.split('/');
  for (let k = 1; k < segs.length; k++) {
    const prefix = segs.slice(0, k);
    if (prefix.every((s) => s === '**')) continue;
    if (globToRegExp(prefix.join('/')).test(dir)) return true;
  }
  return false;
}

/**
 * A link whose target can't be read, or is longer than any real link, matches this: refused, since
 * an unread target could point anywhere, `.forge/config.yml` included. Rule 0 is no configured rule.
 */
export const UNCHECKED_LINK: PolicyMatch = { rule: 0, glob: '', action: 'refuse', reason: 'link target could not be checked' };

/**
 * A link's target, resolved against the link's directory, as a repo-relative path; null when it
 * leaves the repo, false when it can't be read. `readBlob` returns the blob's bytes (at most 4 KiB).
 */
function linkTarget(entryPath: string, blob: string | null, cwd: string | null, readBlob: (sha: string) => string | null): string | null | false {
  if (!blob || !FULL_SHA.test(blob)) return false;
  let target = readBlob(blob);
  if (target === null || !target || target.length > LINK_MAX) return false;
  if (path.posix.isAbsolute(target)) {
    if (!cwd || !target.startsWith(`${cwd}/`)) return null;
    target = target.slice(cwd.length + 1);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  return resolved === '.' || resolved.startsWith('../') || resolved === '..' ? null : resolved.replace(/\/$/, '');
}

/**
 * matchPolicy, plus links: a symlink or gitlink matches a rule when its target does, or when its
 * path is a leading directory of one of the rule's globs.
 */
export function matchEntry(entry: DiffEntry, rules: ProtectedRule[], readBlob: (sha: string) => string | null, cwd: string | null = null): PolicyMatch | null {
  let best = matchPolicy(entry.path, rules);
  const sides: [string, string | null][] = [
    [entry.newMode, entry.newBlob],
    [entry.oldMode, entry.oldBlob],
  ];
  for (const [mode, blob] of sides) {
    if (!LINK_MODES.has(mode)) continue;
    const p = entry.path.toLowerCase();
    best = betterMatch(best, matchWith(rules, (g) => leadsInto(p, g)));
    if (mode === '120000') {
      const target = linkTarget(entry.path, blob, cwd, readBlob);
      if (target === false) best = betterMatch(best, UNCHECKED_LINK);
      if (target === null || target === false) continue;
      const t = target.toLowerCase();
      best = betterMatch(best, betterMatch(matchPolicy(target, rules), matchWith(rules, (g) => leadsInto(t, g))));
    }
  }
  return best;
}

// ---------- git ----------

/** realHistoryEnv over a given environment: replace objects and grafts can't reshape the diff. */
export function historyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: path.join(os.devNull, 'forge-no-grafts') };
}

/** Options that pin every diff here against builder-writable config: no external diff, textconv, relative paths, renames or abbreviation. */
const RAW_OPTS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none', '--raw', '-z', '--no-abbrev', '--no-renames'];
const PATCH_OPTS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];

/**
 * The point a job's changes are measured from: the merge-base of the base ref with `head`, or with
 * MERGE_HEAD while a merge is in progress, so what the base brings in never counts against the job.
 */
export function comparisonPoint(cwd: string, config: Config, job: Pick<Job, 'base'>, head = 'HEAD', env: NodeJS.ProcessEnv = historyEnv()): string {
  const merging = run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD^{commit}'], { cwd, env, allowFail: true });
  const tip = merging.ok ? merging.stdout.trim() : head;
  if (tip !== 'HEAD' && !FULL_SHA.test(tip)) throw new ForgeError(`${JSON.stringify(tip.slice(0, 80))} is not a commit id`);
  const m = resolveBase(cwd, config, job, tip).mergeBase;
  if (!FULL_SHA.test(m)) throw new ForgeError(`merge-base ${JSON.stringify(m.slice(0, 80))} is not a commit id`);
  return m;
}

/** Parses `git diff --raw -z --no-renames --no-abbrev`; unmerged entries are left for the add that resolves them. */
export function parseRawZ(out: string): DiffEntry[] {
  const parts = out.split('\0');
  const entries: DiffEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(parts[i]);
    if (!m) throw new ForgeError(`git diff printed ${JSON.stringify(parts[i].slice(0, 80))} where a raw entry belongs; the protected-paths check cannot be trusted`);
    const [, oldMode, newMode, oldBlob, newBlob, status] = m;
    if (status === 'U') continue;
    entries.push({ path: parts[i + 1], status, oldMode, newMode, oldBlob: NULL_SHA.test(oldBlob) ? null : oldBlob, newBlob: NULL_SHA.test(newBlob) ? null : newBlob });
  }
  return entries;
}

/** Entries that differ between `from` and `to` (a commit, or `index` for the index GIT_INDEX_FILE names). */
export function diffEntries(cwd: string, from: string, to: string, env: NodeJS.ProcessEnv): DiffEntry[] {
  if (!FULL_SHA.test(from) && from !== 'HEAD') throw new ForgeError(`${JSON.stringify(from.slice(0, 80))} is not a commit id`);
  const range = to === 'index' ? ['--cached', from] : [from, to];
  if (to !== 'index' && to !== 'HEAD' && !FULL_SHA.test(to)) throw new ForgeError(`${JSON.stringify(to.slice(0, 80))} is not a commit id`);
  return parseRawZ(run('git', [...PINNED_GIT_CONFIG, 'diff', ...RAW_OPTS, ...range, '--'], { cwd, env }).stdout);
}

/** A blob's bytes, at most 4 KiB, for a link target. */
export function blobReader(cwd: string, env: NodeJS.ProcessEnv): (sha: string) => string | null {
  return (sha) => {
    if (!FULL_SHA.test(sha)) return null;
    const r = spawnSync('git', ['cat-file', 'blob', sha], { cwd, env, encoding: 'utf8', maxBuffer: LINK_MAX + 1 });
    return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null;
  };
}

/** Splits `entries` by the action of the rule each falls under; entries no rule matches are dropped. */
export function checkProtected(entries: DiffEntry[], rules: ProtectedRule[], readBlob: (sha: string) => string | null, cwd: string | null = null): ProtectedCheck {
  const out: ProtectedCheck = { refused: [], escalated: [] };
  if (!rules.length) return out;
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const m = matchEntry(e, rules, readBlob, cwd);
    if (!m) continue;
    const hit: ProtectedHit = { path: e.path, rule: m.rule, glob: m.glob, reason: m.reason, blob: e.newMode === '000000' ? null : e.newBlob };
    (m.action === 'refuse' ? out.refused : out.escalated).push(hit);
  }
  return out;
}

// ---------- the job flag ----------

/** `<path>: rule <n> (<glob>): <reason>`, with control characters escaped so a path can't start a line. */
export function hitLine(h: Pick<ProtectedHit, 'path' | 'rule' | 'glob' | 'reason'>): string {
  return `${clean(h.path)}: ${ruleText(h)}`;
}

/** `rule <n> (<glob>): <reason>`, or the bare reason for UNCHECKED_LINK, which no configured rule names. */
function ruleText(h: Pick<ProtectedHit, 'rule' | 'glob' | 'reason'>): string {
  return h.rule ? `rule ${h.rule} (${clean(h.glob)}): ${clean(h.reason)}` : clean(h.reason);
}

export const clean = (s: string): string => String(s).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

const eventPaths = (hits: ProtectedHit[]) => ({
  paths: hits.slice(0, LIST_LIMIT).map(({ path: p, rule, glob, reason }) => ({ path: p, rule, glob, reason })),
  more: Math.max(0, hits.length - LIST_LIMIT),
});

/** Logs a refusal: `protected-path` with action refuse, blocked. */
export function logRefused(root: string, id: string, gate: ProtectedGate, hits: ProtectedHit[], extra: Record<string, unknown> = {}): void {
  logEvent(root, id, 'protected-path', { gate, action: 'refuse', blocked: true, ...eventPaths(hits), ...extra });
}

/** Logs escalate paths a gate saw: `protected-path` with action escalate. */
export function logEscalated(root: string, id: string, gate: ProtectedGate, hits: ProtectedHit[], head: string | null, blocked = false): void {
  logEvent(root, id, 'protected-path', { gate, action: 'escalate', blocked, ...eventPaths(hits), head });
}

/** The refusal message a CLI gate throws. */
export function refusalText(what: string, hits: ProtectedHit[]): string {
  const lines = hits.slice(0, LIST_LIMIT).map((h) => `  ${hitLine(h)}`);
  if (hits.length > LIST_LIMIT) lines.push(`  … and ${hits.length - LIST_LIMIT} more`);
  return `${what} refuses protected paths:\n${lines.join('\n')}`;
}

/** How to write protected.diff: the patch of the flagged paths, `from` against `to` (a commit, or `index`). */
export interface DiffSource {
  cwd: string;
  from: string;
  to: string;
  env: NodeJS.ProcessEnv;
  /** The paths to diff in `cwd` when they are not S's own (a member repo's part of S, unprefixed). */
  paths?: string[];
  /** A member repo's name: its part of protected.diff gets a `# repo <name>` header. */
  repo?: string;
}

/** Paths split so no `git diff` call's argv passes ARGV_CHUNK bytes. */
function chunks(paths: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const p of paths) {
    if (cur.length && size + Buffer.byteLength(p) + 1 > ARGV_CHUNK) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += Buffer.byteLength(p) + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The patch of every S path (git diff has no --pathspec-from-file, so in chunks), capped at DIFF_CAP. */
function writeDiff(file: string, s: ProtectedHit[], sources: DiffSource[]): void {
  const parts: Buffer[] = [];
  let size = 0;
  let note = '';
  for (const src of sources) {
    if (note) break;
    const paths = src.paths ?? s.map((h) => h.path);
    if (!paths.length) continue;
    if (src.repo !== undefined) parts.push(Buffer.from(`# repo ${clean(src.repo)}\n`));
    note = writeSource(src, paths, parts, size);
    size = parts.reduce((n, b) => n + b.length, 0);
  }
  writeTextAtomic(file, `${Buffer.concat(parts).subarray(0, DIFF_CAP).toString('utf8')}${note}`);
}

/** One source's part of protected.diff, appended to `parts`; the note to end the file with, if any. */
function writeSource(src: DiffSource, paths: string[], parts: Buffer[], size: number): string {
  const range = src.to === 'index' ? ['--cached', src.from] : [src.from, src.to];
  let note = '';
  for (const group of chunks(paths)) {
    const r = spawnSync('git', ['--literal-pathspecs', ...PINNED_GIT_CONFIG, 'diff', ...PATCH_OPTS, ...range, '--', ...group], {
      cwd: src.cwd,
      env: src.env,
      encoding: 'buffer',
      maxBuffer: DIFF_CAP * 2,
    });
    const out = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0);
    if (r.status !== 0 && !out.length) {
      note = `# forge could not produce the diff of the protected paths (git exited ${r.status ?? 'abnormally'})\n`;
      break;
    }
    parts.push(out);
    size += out.length;
    if (size > DIFF_CAP || r.error) {
      note = `\n# truncated: the diff is larger than ${DIFF_CAP} bytes; read the rest in the worktree\n`;
      break;
    }
  }
  return note;
}

/** sha256 over every (path, blob) of S, so a change past the stored MAX_HITS still moves `at`. */
export function protectedDigest(s: Pick<ProtectedHit, 'path' | 'blob'>[]): string {
  const h = createHash('sha256');
  for (const k of s.map((x) => `${x.path}\0${x.blob ?? ''}\0`).sort()) h.update(k);
  return h.digest('hex');
}

/**
 * Records the escalate set S a gate found. An empty S clears the flag and protected.diff. Otherwise
 * `at` moves only when S holds a (path, blob) the previous hits didn't, or `more` grew, so a human
 * approval stays bound to the exact content it saw. Past MAX_HITS the stored hits can't show that,
 * so there `at` also moves whenever the digest of the whole of S changes. Only the CLI calls this.
 */
export function recordProtected(root: string, id: string, gate: ProtectedGate, s: ProtectedHit[], head: string | null, diff: DiffSource | DiffSource[] | null): ProtectedPaths | null {
  const file = path.join(jobDir(root, id), 'protected.diff');
  if (!s.length) {
    if (loadJob(root, id).protectedPaths) updateJob(root, id, (j) => void (j.protectedPaths = null));
    fs.rmSync(file, { force: true });
    return null;
  }
  const hits = s.slice(0, MAX_HITS);
  const more = Math.max(0, s.length - MAX_HITS);
  const digest = protectedDigest(s);
  let flag: ProtectedPaths | null = null;
  updateJob(root, id, (j) => {
    const prev = j.protectedPaths;
    const key = (h: Pick<ProtectedHit, 'path' | 'blob'>) => `${h.path}\0${h.blob ?? ''}`;
    const known = new Set((prev?.hits ?? []).map(key));
    const fresh = !prev || !prev.at || hits.some((h) => !known.has(key(h))) || more > (Number(prev.more) || 0) || (more > 0 && prev.digest !== digest);
    flag = { hits, more, at: fresh ? now() : prev.at, gate, head, digest };
    j.protectedPaths = flag;
  });
  if (diff) writeDiff(file, s, Array.isArray(diff) ? diff : [diff]);
  return flag;
}

/**
 * Whether a human approved the flag's current content: a `human` approve not recorded by the foreman,
 * after `flag.at`, given while the job was parked on `human` for protected paths (PP1). Pure, so
 * `forge job step` and `forge pr open` share it.
 */
export function protectedApproved(flag: ProtectedPaths | null | undefined, events: JobEvent[]): boolean {
  if (!flag || !Array.isArray(flag.hits) || !flag.hits.length) return true;
  const at = typeof flag.at === 'string' ? flag.at : '';
  return events.some((e, i) => {
    if (e.type !== 'human' || e.action !== 'approve' || isForemanActor(e) || typeof e.ts !== 'string' || !(e.ts > at)) return false;
    const park = events.slice(0, i).findLast((t) => t.type === 'transition');
    const to = (park?.to ?? {}) as { state?: string; waitingOn?: string | null };
    return to.state === 'waiting' && to.waitingOn === 'human' && typeof park?.reason === 'string' && park.reason.startsWith('protected paths');
  });
}

/** PP1's reason: at most 3 shell-safe paths, the rest counted, so the reason stays inside shellLine's class. */
export function protectedReason(flag: ProtectedPaths): string {
  const total = flag.hits.length + (Number(flag.more) || 0);
  const shown = flag.hits.map((h) => h.path).filter((p) => typeof p === 'string' && REASON_PATH.test(p) && !p.startsWith('-')).slice(0, 3);
  const rest = total - shown.length;
  return `protected paths: ${[...shown, ...(rest > 0 ? [`+${rest} more`] : [])].join(', ')}`;
}

// ---------- the branch check (verify and pr open) ----------

/** What verify and pr open found over the whole branch; `error` when it could not be computed. */
export interface BranchCheck extends ProtectedCheck {
  flag: ProtectedPaths | null;
  error: string | null;
}

/** verify's JSON key: at most 10 paths of each kind. */
export interface CompactProtected {
  ok: boolean;
  refused: string[];
  escalated: string[];
  more: number;
  error?: string;
}

/**
 * The committed diff from the comparison point (bound to `head`) to `head`, checked against the
 * policy, with the flag recorded and a refusal logged. Recomputed from git every time: the stored
 * flag is never trusted. An invalid policy throws config_invalid; anything else that stops the
 * check comes back as `error`, never as a clean result.
 */
export function checkBranch(
  root: string,
  config: Config,
  job: Pick<Job, 'id' | 'worktree' | 'base'>,
  head: string,
  gate: 'verify' | 'pr',
  members: MemberBranch[] = [],
): BranchCheck {
  const rules = policyRules(config);
  const empty: BranchCheck = { refused: [], escalated: [], flag: null, error: null };
  // The policy is off: nothing to compare, and a flag from before it was turned off is cleared.
  if (!rules.length) return { ...empty, flag: recordProtected(root, job.id, gate, [], head, null) };
  try {
    if (!job.worktree) throw new ForgeError(`job ${job.id} has no worktree`);
    const env = historyEnv();
    const branch = (wt: string, base: Pick<Job, 'base'>, tip: string, repo?: string) => {
      if (!FULL_SHA.test(tip)) throw new ForgeError(`${JSON.stringify(tip.slice(0, 80))} is not a commit id`);
      const cwd = fs.realpathSync(wt);
      const m = resolveBase(cwd, config, base, tip).mergeBase;
      if (!FULL_SHA.test(m)) throw new ForgeError(`merge-base ${JSON.stringify(m.slice(0, 80))} is not a commit id`);
      const found = checkProtected(diffEntries(cwd, m, tip, env), rules, blobReader(cwd, env), cwd);
      const src: DiffSource = { cwd, from: m, to: tip, env, paths: found.escalated.map((h) => h.path), ...(repo === undefined ? {} : { repo }) };
      return { found: repo === undefined ? found : prefixHits(repo, found), src };
    };
    // Member repos get the same policy over their own branch, so one job flag (and one human
    // approval) covers every repo the job pushes.
    const parts = [branch(job.worktree, job, head), ...members.map((b) => branch(b.worktree, { base: b.base }, b.head, b.repo))];
    const found: ProtectedCheck = { refused: parts.flatMap((p) => p.found.refused), escalated: parts.flatMap((p) => p.found.escalated) };
    const flag = recordProtected(root, job.id, gate, found.escalated, head, parts.map((p) => p.src));
    if (found.refused.length) logRefused(root, job.id, gate, found.refused, { head });
    return { ...found, flag, error: null };
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  }
}

/** A member repo's branch for checkBranch: its checked worktree, base and the head to check. */
export interface MemberBranch {
  repo: string;
  worktree: string;
  base: string | null;
  head: string;
}

/** `<repo>:<path>`: how a member repo's hit is named on the job flag, in events and in messages. */
export function memberHitPath(repo: string, p: string): string {
  return `${repo}:${p}`;
}

/**
 * A member's hits named `<repo>:<path>` for people, and tagged with `repo` for code: a root path can
 * itself begin with `<repo>:`, so the name alone can't say which repo a hit came from.
 */
export function prefixHits(repo: string, c: ProtectedCheck): ProtectedCheck {
  const pre = (h: ProtectedHit): ProtectedHit => ({ ...h, path: memberHitPath(repo, h.path), repo });
  return { refused: c.refused.map(pre), escalated: c.escalated.map(pre) };
}

export function compactProtected(c: Pick<BranchCheck, 'refused' | 'escalated' | 'error'>): CompactProtected {
  const n = 10;
  return {
    ok: !c.error && !c.refused.length,
    refused: c.refused.slice(0, n).map((h) => h.path),
    escalated: c.escalated.slice(0, n).map((h) => h.path),
    more: Math.max(0, c.refused.length - n) + Math.max(0, c.escalated.length - n),
    ...(c.error ? { error: c.error } : {}),
  };
}

/** verify/round-N.md's `## protected` section. Paths come from the branch: control characters are escaped and backticks can't close the span. */
export function renderProtected(c: Pick<BranchCheck, 'refused' | 'escalated' | 'error'>): string {
  const ok = !c.error && !c.refused.length;
  const line = (h: ProtectedHit) => `- \`${clean(h.path).replace(/`/g, "'")}\`: ${ruleText(h)}`;
  const list = (hits: ProtectedHit[]) => {
    const shown = hits.slice(0, MAX_HITS).map(line);
    if (hits.length > MAX_HITS) shown.push(`- … and ${hits.length - MAX_HITS} more`);
    return shown.length ? shown : ['- none'];
  };
  const out = [`## protected: ${ok ? 'ok' : 'FAILED'}`, ''];
  if (c.error) out.push(`The check could not run, so it does not pass: ${clean(c.error)}`, '');
  out.push(`Refused (${c.refused.length}): the branch must put these back to their merge-base content`, ...list(c.refused), '');
  out.push(`Escalated (${c.escalated.length}): a human approves these before the job ships`, ...list(c.escalated), '');
  return out.join('\n');
}
