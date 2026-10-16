// `policy.protectedPaths`: paths only a human may change. Paths are code, judgement calls are prose:
// the CLI enforces these rules when a change is staged or committed (`forge git add|commit`), again
// over the whole branch at `forge verify` and `forge pr open`, and `forge job step` parks a job whose
// escalate paths no human approved (PP1). docs/CONFIG.md "Protected paths" has the user-facing rules.
// No imports from worktree.ts or evals.ts: worktree.ts imports this module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { globProblem } from './config.ts';
import { PINNED_GIT_CONFIG } from './integrity.ts';
import { jobDir, loadJob, logEvent, updateJob } from './jobs.ts';
import { globToRegExp, inSpec, resolveBase } from './scope.ts';
import type { Config, Job, JobEvent, ProtectedHit, ProtectedPaths, ProtectedRule } from './types.ts';
import { ForgeError, now, run, writeTextAtomic } from './util.ts';

export type ProtectedAction = ProtectedRule['action'];
export type ProtectedGate = ProtectedPaths['gate'];

/** A rule that matched a path: `rule` is 1-based, `glob` is the configured glob that matched. */
export interface PolicyMatch {
  rule: number;
  glob: string;
  action: ProtectedAction;
  reason: string;
}

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
const REASON_MAX = 200;
const LINK_MAX = 4096;
const LINK_MODES = new Set(['120000', '160000']);
const NULL_SHA = /^0+$/;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Paths printed in the PP1 reason: shellLine's safe class, never an option. */
const REASON_PATH = /^[A-Za-z0-9._/@+-]+$/;

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- the policy ----------

/** Every problem with `policy`, for validateConfig; an empty list means the policy is usable. */
export function policyProblems(c: any): string[] {
  const pol = c?.policy;
  if (pol === undefined) return [];
  if (!isMap(pol)) return [`policy must be a map (got ${JSON.stringify(pol)})`];
  const list = pol.protectedPaths;
  if (!Array.isArray(list)) return [`policy.protectedPaths must be a list of rules (got ${JSON.stringify(list)})`];
  const problems: string[] = [];
  list.forEach((r: unknown, i) => {
    const key = `policy.protectedPaths rule ${i + 1}`;
    if (!isMap(r)) return problems.push(`${key} must be a map with paths, action and reason (got ${JSON.stringify(r)})`);
    if (!Array.isArray(r.paths) || !r.paths.length) problems.push(`${key}: paths must be a non-empty list of globs (got ${JSON.stringify(r.paths)})`);
    else for (const g of r.paths) {
      const p = globProblem(g, `${key}: paths`);
      if (p) problems.push(p);
    }
    if (r.action !== 'escalate' && r.action !== 'refuse') problems.push(`${key}: action must be one of escalate | refuse (got ${JSON.stringify(r.action)})`);
    if (typeof r.reason !== 'string' || !r.reason.length || r.reason.length > REASON_MAX || /[\r\n]/.test(r.reason))
      problems.push(`${key}: reason must be a string of 1 to ${REASON_MAX} characters with no newline (got ${JSON.stringify(r.reason)?.slice(0, 80)})`);
  });
  return problems;
}

/** The rules to enforce. An invalid policy fails closed: every gate refuses until a human fixes it. */
export function policyRules(config: Config): ProtectedRule[] {
  const problems = policyProblems(config);
  if (problems.length) throw new ForgeError(`invalid policy in .forge/config.yml, so Forge refuses to check protected paths: ${problems.join('; ')}`, 'config_invalid');
  return (config.policy?.protectedPaths ?? []) as ProtectedRule[];
}

/** refuse beats escalate; within one action the lowest rule number wins. */
function better(a: PolicyMatch | null, b: PolicyMatch | null): PolicyMatch | null {
  if (!a || !b) return a ?? b;
  if (a.action !== b.action) return a.action === 'refuse' ? a : b;
  return a.rule <= b.rule ? a : b;
}

function matchWith(rules: ProtectedRule[], test: (glob: string) => boolean): PolicyMatch | null {
  let best: PolicyMatch | null = null;
  rules.forEach((r, i) => {
    for (const glob of r.paths) {
      if (!test(glob.toLowerCase())) continue;
      best = better(best, { rule: i + 1, glob, action: r.action, reason: r.reason });
      break;
    }
  });
  return best;
}

/** The rule a path falls under, or null. Case-insensitive, so `.GitHub/Workflows/x.yml` still counts. */
export function matchPolicy(file: string, rules: ProtectedRule[]): PolicyMatch | null {
  const p = file.toLowerCase();
  return matchWith(rules, (g) => inSpec(p, [g]));
}

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
 * A link's target, resolved against the link's directory, as a repo-relative path; null when it
 * leaves the repo or can't be read. `readBlob` returns the blob's bytes (at most 4 KiB).
 */
function linkTarget(entryPath: string, blob: string | null, cwd: string | null, readBlob: (sha: string) => string | null): string | null {
  if (!blob || !FULL_SHA.test(blob)) return null;
  let target = readBlob(blob);
  if (target === null || !target || target.length > LINK_MAX) return null;
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
    best = better(best, matchWith(rules, (g) => leadsInto(p, g)));
    if (mode === '120000') {
      const target = linkTarget(entry.path, blob, cwd, readBlob);
      if (target === null) continue;
      const t = target.toLowerCase();
      best = better(best, better(matchPolicy(target, rules), matchWith(rules, (g) => leadsInto(t, g))));
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
  return `${clean(h.path)}: rule ${h.rule} (${clean(h.glob)}): ${clean(h.reason)}`;
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
}

function writeDiff(file: string, hits: ProtectedHit[], src: DiffSource): void {
  const range = src.to === 'index' ? ['--cached', src.from] : [src.from, src.to];
  const r = spawnSync('git', ['--literal-pathspecs', ...PINNED_GIT_CONFIG, 'diff', ...PATCH_OPTS, ...range, '--', ...hits.map((h) => h.path)], {
    cwd: src.cwd,
    env: src.env,
    encoding: 'buffer',
    maxBuffer: DIFF_CAP * 2,
  });
  const out = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.alloc(0);
  let text: string;
  if (r.status !== 0 && !out.length) text = `# forge could not produce the diff of the protected paths (git exited ${r.status ?? 'abnormally'})\n`;
  else if (out.length > DIFF_CAP || r.error) text = `${out.subarray(0, DIFF_CAP).toString('utf8')}\n# truncated: the diff is larger than ${DIFF_CAP} bytes; read the rest in the worktree\n`;
  else text = out.toString('utf8');
  writeTextAtomic(file, text);
}

/**
 * Records the escalate set S a gate found. An empty S clears the flag and protected.diff. Otherwise
 * `at` moves only when S holds a (path, blob) the previous hits didn't, or `more` grew, so a human
 * approval stays bound to the exact content it saw. Only the CLI calls this.
 */
export function recordProtected(root: string, id: string, gate: ProtectedGate, s: ProtectedHit[], head: string | null, diff: DiffSource | null): ProtectedPaths | null {
  const file = path.join(jobDir(root, id), 'protected.diff');
  if (!s.length) {
    if (loadJob(root, id).protectedPaths) updateJob(root, id, (j) => void (j.protectedPaths = null));
    fs.rmSync(file, { force: true });
    return null;
  }
  const hits = s.slice(0, MAX_HITS);
  const more = Math.max(0, s.length - MAX_HITS);
  let flag: ProtectedPaths | null = null;
  updateJob(root, id, (j) => {
    const prev = j.protectedPaths;
    const key = (h: Pick<ProtectedHit, 'path' | 'blob'>) => `${h.path}\0${h.blob ?? ''}`;
    const known = new Set((prev?.hits ?? []).map(key));
    const fresh = !prev || !prev.at || hits.some((h) => !known.has(key(h))) || more > (Number(prev.more) || 0);
    flag = { hits, more, at: fresh ? now() : prev.at, gate, head };
    j.protectedPaths = flag;
  });
  if (diff) writeDiff(file, hits, diff);
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
    if (e.type !== 'human' || e.action !== 'approve' || e.actor === 'foreman' || typeof e.ts !== 'string' || !(e.ts > at)) return false;
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
