// `forge job gate`: the mechanical reasons a job needs a person before merge (gate reasons), computed
// from job facts once per review and logged as a `gate` event that DC12, PR19, the briefs and the
// escalation park read. Every detail is CLI-composed (fixed words, numbers, lens, AC and repo names);
// review, runbook and decision text never reaches one. Only `paths` come from the branch.
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_TEXT_MAX, readRegular, readRegularText } from '#core/os/fs.ts';
import { exists } from '#core/paths.ts';
import { jobDir, loadJob, logEvent, readEvents, reviewDir } from '#core/job/store.ts';
import { isLens, reviewFileName, reviewedRepoNames } from '#core/job/lens.ts';
import { isMap } from '#core/shape.ts';
import { git, gitSpawnSync, historyEnv } from '#integrations/git/runner.ts';
import type { Config, GateReason, Job, JobEvent } from '#core/types.ts';
import { acCoverage } from '../acs.ts';
import { resolveBase } from '../scope.ts';
import { diffEntries, protectedApproved } from '../../guard/protected.ts';
import type { DiffEntry } from '../../guard/protected.ts';
import { PACKAGE_DEP_KEYS } from '../../guard/integrity.ts';
import { memberWorktree } from '../../project/job-repos.ts';
import { REPO_NAME } from '../../project/member-repos.ts';
import { sections } from './foreman-gates.ts';
import { REASON_PATHS, protectedGateReason } from './escalation.ts';

/** What `forge job gate` computes: the job's round, the root worktree's HEAD and the reasons in table order. */
export interface GateResult {
  id: string;
  round: number;
  head: string | null;
  reasons: GateReason[];
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const AC_ID = /^AC\d+$/;
/** A manifest blob is read up to this; a larger one can't be parsed, which fails closed. */
const BLOB_MAX = 4 * 1024 * 1024;
/** How deep packageDeps sorts a dependency value's keys; anything deeper is compared as written. */
const DEPTH_MAX = 20;
/** Git modes of a regular file; a link or gitlink on either side of a manifest fails closed. */
const FILE_MODES = new Set(['100644', '100755']);
const ABSENT = '000000';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- manifest parsers (pure) ----------

/** A JSON manifest's top-level object; {} for an absent file. Throws when it is not a JSON object. */
function manifestJson(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
  return v as Record<string, unknown>;
}

/** A JSON manifest's `version` as canonical JSON, null when it has none. Throws when the text is not a JSON object. */
export function versionOf(text: string | null): string | null {
  const v = manifestJson(text).version;
  return v === undefined ? null : JSON.stringify(v);
}

/** `v` with every object's keys sorted, so reordering keys changes nothing. */
function canonical(v: unknown, depth = 0): unknown {
  if (!v || typeof v !== 'object' || depth > DEPTH_MAX) return v;
  if (Array.isArray(v)) return v.map((x) => canonical(x, depth + 1));
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k], depth + 1)]));
}

/** A package.json's dependency tables (PACKAGE_DEP_KEYS) as one canonical JSON string. Throws when the text is not a JSON object. */
export function packageDeps(text: string | null): string {
  const doc = manifestJson(text);
  return JSON.stringify(PACKAGE_DEP_KEYS.map((k) => [k, canonical(Object.hasOwn(doc, k) ? doc[k] : null)]));
}

/** A TOML key or table-name segment that holds dependencies: one ending in `dependencies`, or `dependency-groups`. */
const isDependencyWord = (segment: string): boolean => {
  const s = segment.trim().replace(/^["']|["']$/g, '');
  return s.endsWith('dependencies') || s === 'dependency-groups';
};

/** Whether a TOML table name is a dependency table: some dotted segment is a dependency word. */
const isDependencyTable = (name: string): boolean => name.split('.').some(isDependencyWord);

/**
 * One TOML line without its trailing `# comment`, trimmed, and the `[`/`{` it opens minus the `]`/`}`
 * it closes, both read outside strings (`"…"` with escapes, `'…'`), so a bracket in a comment or a
 * string neither closes nor opens a value. A multi-line string is not tracked past its line.
 */
function scanLine(raw: string): { code: string; delta: number } {
  let quote = '';
  let delta = 0;
  let end = raw.length;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') {
      end = i;
      break;
    } else if (c === '[' || c === '{') delta++;
    else if (c === ']' || c === '}') delta--;
  }
  return { code: raw.slice(0, end).trim(), delta };
}

/** A `[table]` header line's name: what sits between the `[` and the first `]` outside quotes; '' when it never closes. */
function headerName(code: string): string {
  let quote = '';
  for (let i = 1; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ']') return code.slice(1, i).trim();
  }
  return '';
}

/** Whether a `key = value` line's dotted key (before the first `=` outside quotes) has a dependency-word segment. */
function hasDependencyKey(code: string): boolean {
  let quote = '';
  let segment = '';
  for (const c of code) {
    if (quote) {
      if (c === quote) quote = '';
      segment += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      segment += c;
    } else if (c === '=') return isDependencyWord(segment);
    else if (c === '.') {
      if (isDependencyWord(segment)) return true;
      segment = '';
    } else segment += c;
  }
  return false;
}

/**
 * The dependency content of a Cargo.toml or pyproject.toml, sorted: every non-blank line, comments
 * dropped and trimmed, that is under a dependency table (not `[[`), or is a `key = value` line anywhere
 * (the root, `[project]`, `[workspace]`, `[tool.poetry]`) whose dotted key has a dependency-word
 * segment (`dependencies = { … }`, `optional-dependencies.dev = [ … ]`, `dependencies.serde = "1"`).
 * A value that opens a bracket or brace continues through its closing one, so a comment or a string
 * holding a bracket can't end it early. Each line carries its table's name, so moving a dependency
 * between tables counts while reordering does not.
 */
export function tomlDependencyLines(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  let table = '';
  let inside = false;
  let open = 0;
  for (const raw of text.split(/\r?\n/)) {
    const { code, delta } = scanLine(raw);
    if (open > 0) {
      if (code) out.push(`${table}\t${code}`);
      open = Math.max(0, open + delta);
      continue;
    }
    if (!code) continue;
    if (code.startsWith('[')) {
      table = code.startsWith('[[') ? '' : headerName(code);
      inside = table !== '' && isDependencyTable(table);
      continue;
    }
    if (inside || hasDependencyKey(code)) {
      out.push(`${table}\t${code}`);
      open = Math.max(0, delta);
    }
  }
  return out.sort();
}

/** A go.mod's `require` and `replace` directives, single or in a `( … )` block, comments dropped, sorted. */
export function goModRequires(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  let block: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const cut = raw.indexOf('//');
    const line = (cut < 0 ? raw : raw.slice(0, cut)).trim();
    if (!line) continue;
    if (block !== null) {
      if (line === ')') block = null;
      else out.push(`${block} ${line.split(/\s+/).join(' ')}`);
      continue;
    }
    const [word, ...rest] = line.split(/\s+/);
    const kw = word.startsWith('require(') ? 'require' : word.startsWith('replace(') ? 'replace' : word;
    if (kw !== 'require' && kw !== 'replace') continue;
    const tail = (word.length > kw.length ? [word.slice(kw.length), ...rest] : rest).join(' ');
    if (tail === '(') block = kw;
    else out.push(`${kw} ${tail}`);
  }
  return out.sort();
}

/** A requirements file's non-blank, non-comment lines, trimmed and sorted. */
export function requirementLines(text: string | null): string[] {
  if (text === null) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .sort();
}

type ManifestKind = 'package' | 'plugin' | 'toml' | 'gomod' | 'requirements';

/** The manifests the version and dependencies rules read; lockfiles are left to the protected-paths policy. */
export function manifestKind(p: string): ManifestKind | null {
  const base = path.posix.basename(p);
  if (base === 'package.json') return 'package';
  if (p === '.claude-plugin/plugin.json') return 'plugin';
  if (base === 'Cargo.toml' || base === 'pyproject.toml') return 'toml';
  if (base === 'go.mod') return 'gomod';
  if (base.startsWith('requirements') && base.endsWith('.txt')) return 'requirements';
  return null;
}

/** Every rule a manifest kind has: what a side that can't be read or parsed fires. */
const failClosed = (kind: ManifestKind): { version: boolean; dependencies: boolean } => ({ version: kind === 'package' || kind === 'plugin', dependencies: kind !== 'plugin' });

/** Which rules one manifest's two sides (null: absent) fire. A side that does not parse fires every rule its kind has. */
export function manifestChange(kind: ManifestKind, before: string | null, after: string | null): { version: boolean; dependencies: boolean } {
  const same = (f: (t: string | null) => unknown): boolean => JSON.stringify(f(before)) === JSON.stringify(f(after));
  try {
    switch (kind) {
      case 'package':
        return { version: !same(versionOf), dependencies: !same(packageDeps) };
      case 'plugin':
        return { version: !same(versionOf), dependencies: false };
      case 'toml':
        return { version: false, dependencies: !same(tomlDependencyLines) };
      case 'gomod':
        return { version: false, dependencies: !same(goModRequires) };
      case 'requirements':
        return { version: false, dependencies: !same(requirementLines) };
    }
  } catch {
    return failClosed(kind);
  }
}

// ---------- git ----------

/** One repo's manifests whose version or dependency tables changed between its merge base and HEAD. Throws when git can't say. */
function repoManifests(cwd: string, config: Config, base: Pick<Job, 'base'>, label: (p: string) => string): { version: string[]; dependencies: string[] } {
  const env = historyEnv();
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], { env }).stdout.trim();
  if (!FULL_SHA.test(head)) throw new Error('HEAD is not a commit id');
  const mergeBase = resolveBase(cwd, config, base, head).mergeBase;
  if (!FULL_SHA.test(mergeBase)) throw new Error('the merge base is not a commit id');
  const blob = (sha: string | null): string | null => {
    if (sha === null) return null;
    if (!FULL_SHA.test(sha)) throw new Error('not a blob id');
    const r = gitSpawnSync(cwd, ['cat-file', 'blob', sha], { env, encoding: 'utf8', maxBuffer: BLOB_MAX });
    if (r.status !== 0 || typeof r.stdout !== 'string') throw new Error('blob unreadable');
    return r.stdout;
  };
  const out = { version: [] as string[], dependencies: [] as string[] };
  for (const e of diffEntries(cwd, mergeBase, head, env)) {
    const kind = manifestKind(e.path);
    if (!kind) continue;
    const fired = sideChange(kind, e, blob);
    if (fired.version) out.version.push(label(e.path));
    if (fired.dependencies) out.dependencies.push(label(e.path));
  }
  return out;
}

/** manifestChange over a diff entry's blobs; a link, a gitlink or an unreadable blob on either side fails closed. */
function sideChange(kind: ManifestKind, e: DiffEntry, blob: (sha: string | null) => string | null): { version: boolean; dependencies: boolean } {
  const plain = (mode: string) => mode === ABSENT || FILE_MODES.has(mode);
  if (!plain(e.oldMode) || !plain(e.newMode)) return failClosed(kind);
  try {
    return manifestChange(kind, e.oldMode === ABSENT ? null : blob(e.oldBlob), e.newMode === ABSENT ? null : blob(e.newBlob));
  } catch {
    return failClosed(kind);
  }
}

/** The version and dependencies reasons over the root's and each reviewed member's committed diff; [] without a worktree. */
function manifestReasons(root: string, config: Config, job: Job): GateReason[] {
  if (!job.worktree || !exists(job.worktree)) return [];
  const changed = { version: [] as string[], dependencies: [] as string[] };
  const failed: string[] = [];
  const take = (where: string, read: () => { version: string[]; dependencies: string[] }) => {
    try {
      const r = read();
      changed.version.push(...r.version);
      changed.dependencies.push(...r.dependencies);
    } catch {
      failed.push(where);
    }
  };
  take('the root repo', () => repoManifests(job.worktree!, config, job, (p) => p));
  for (const name of reviewedRepoNames(job)) {
    const where = REPO_NAME.test(name) ? `repo ${name}` : 'a member repo';
    take(where, () => {
      const { member, worktree } = memberWorktree(root, config, job, name);
      return repoManifests(worktree, config, { base: member.base }, (p) => `${name}:${p}`);
    });
  }
  const reasons: GateReason[] = [];
  for (const [rule, what] of [
    ['version', 'version changed in'],
    ['dependencies', 'dependency tables changed in'],
  ] as const) {
    const paths = changed[rule];
    if (paths.length) reasons.push({ rule, detail: `${what} ${plural(paths.length, 'manifest')}`, paths: paths.slice(0, REASON_PATHS) });
    for (const where of failed) reasons.push({ rule, detail: `could not be checked in ${where}` });
  }
  return reasons;
}

// ---------- job facts ----------

/** Whether a review's `## Summary` says `ESCALATE:`, case-sensitive; false without text. */
export function summaryEscalates(text: string | null): boolean {
  return text !== null && sections(text, ['Summary']).some((s) => s.includes('ESCALATE:'));
}

/**
 * One reason per lens whose latest recorded review says `ESCALATE:` inside `## Summary`. A review is
 * recorded by `forge job verdicts`, whose `verdicts` event notes for each lens it read whether the
 * Summary said it at that moment (`escalate`), so a review file edited or planted afterwards, a round
 * the CLI never recorded and a lens that did not review can't clear one. A lens's latest record is
 * the highest round (n ≤ the job's round) that reviewed it, so a narrowed rework panel keeps an
 * earlier round's ESCALATE. An event recorded before `escalate` existed falls back to that round's
 * file for each lens `job.verdicts` names. The integration review never counts. No review text
 * reaches a reason.
 */
function lensReasons(root: string, job: Job, events: readonly JobEvent[]): GateReason[] {
  const recorded = new Map<number, Record<string, any> | null>();
  for (const e of events) {
    const n = Number(e.round);
    if (e.type === 'verdicts' && Number.isInteger(n) && n >= 1 && n <= job.round) recorded.set(n, isMap(e.escalate) ? e.escalate : null);
  }
  const latest = new Map<string, { round: number; escalate: boolean }>();
  for (const n of [...recorded.keys()].sort((a, b) => b - a)) {
    const flags = recorded.get(n) ?? null;
    for (const lens of Object.keys(flags ?? job.verdicts?.[n] ?? {})) {
      if (!isLens(lens) || latest.has(lens)) continue;
      if (flags) latest.set(lens, { round: n, escalate: flags[lens] === true });
      else {
        const text = readRegularText(path.join(reviewDir(root, job.id, n), reviewFileName(lens)), AGENT_TEXT_MAX);
        if (text !== null) latest.set(lens, { round: n, escalate: summaryEscalates(text) });
      }
    }
  }
  return [...latest]
    .filter(([, v]) => v.escalate)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([lens, v]) => ({ rule: 'lens-escalate' as const, detail: `the ${lens} review of round ${v.round} says ESCALATE` }));
}

/** runbook.md has text for a person: a regular file with non-blank text, whatever its `When:` line. One that exists but can't be read fails closed. */
function runbookOpen(dir: string): boolean {
  const file = path.join(dir, 'runbook.md');
  try {
    fs.lstatSync(file);
  } catch {
    return false;
  }
  const b = readRegular(file, AGENT_TEXT_MAX);
  return typeof b === 'string' || b.toString('utf8').trim() !== '';
}

/** `unmapped: AC2, AC4; failing: AC5`, only the parts that apply, AC ids only. */
function acsReason(dir: string): GateReason | null {
  const read = (f: string) => readRegularText(path.join(dir, f), AGENT_TEXT_MAX);
  const cov = acCoverage(read('spec.md'), read('build.md'));
  const ids = (list: string[]) => list.filter((id) => AC_ID.test(id)).slice(0, 20);
  const parts = [
    ...(cov.unmapped.length ? [`unmapped: ${ids(cov.unmapped).join(', ') || plural(cov.unmapped.length, 'criterion')}`] : []),
    ...(cov.failing.length ? [`failing: ${ids(cov.failing).join(', ') || plural(cov.failing.length, 'criterion')}`] : []),
  ];
  return parts.length ? { rule: 'acs', detail: parts.join('; ') } : null;
}

/** The worktree's HEAD, or null without one (or when git can't read it). */
function headOf(job: Job): string | null {
  if (!job.worktree || !exists(job.worktree)) return null;
  const out = git(job.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'], { env: historyEnv(), allowFail: true }).stdout.trim();
  return FULL_SHA.test(out) ? out : null;
}

/** Every gate reason the job's facts give now, in ESCALATION_RULES order. Reads, never writes. */
export function computeGate(root: string, config: Config, id: string): GateResult {
  const job = loadJob(root, id);
  const dir = jobDir(root, job.id);
  const events = readEvents(root, job.id);
  const reasons: GateReason[] = [];
  const flag = job.protectedPaths;
  if (flag?.hits?.length && !protectedApproved(flag, events)) reasons.push(protectedGateReason(flag));
  reasons.push(...lensReasons(root, job, events));
  if (runbookOpen(dir)) reasons.push({ rule: 'runbook', detail: 'runbook.md has steps for a person' });
  const acs = acsReason(dir);
  if (acs) reasons.push(acs);
  reasons.push(...manifestReasons(root, config, job));
  return { id: job.id, round: job.round, head: headOf(job), reasons };
}

/** `forge job gate`: computeGate, logged as one `gate` event {round, head, reasons} on every call. */
export function recordGate(root: string, config: Config, id: string): { id: string; round: number; reasons: GateReason[] } {
  const g = computeGate(root, config, id);
  logEvent(root, g.id, 'gate', { round: g.round, head: g.head, reasons: g.reasons });
  return { id: g.id, round: g.round, reasons: g.reasons };
}
