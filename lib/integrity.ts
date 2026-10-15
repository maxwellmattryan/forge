// Verify's test-integrity report: what the committed diff did to the tests and to the config that
// runs them. A build can go green by deleting a test, adding `.skip`, or editing the test script;
// this makes those changes visible to reviewers and, under `verifyIntegrity: block`, fails verify.
// Must not import evals.ts or worktree.ts: worktree imports this module, and evals imports worktree.
import fs from 'node:fs';
import path from 'node:path';
import { jobDir } from './jobs.ts';
import { exists } from './paths.ts';
import { approachPaths, approachSection, realHistoryEnv, resolveBase } from './scope.ts';
import type { Config, Job } from './types.ts';
import { ForgeError, run } from './util.ts';

export const DEFAULT_TEST_PATTERN = '(^|/)(tests?|__tests__|spec|specs)/|[._-](test|spec)s?\\.[A-Za-z0-9]+$|_test\\.(go|py|rs)$|(^|/)test_[^/]+\\.py$';

const JSON_LIST_LIMIT = 10;

// Repo config is writable from the job's worktree, so pin everything the diff parsers depend on:
// quoting, prefixes, drivers, colour, hunk merging, blank-context rendering, relative paths and
// submodule visibility. Callers add `--text`, which defeats `-diff`/`binary` attributes that would
// hide added lines. Shared with the secret scanner (lib/secrets.ts), which reads the same diffs.
export const PINNED_GIT_CONFIG: readonly string[] = ['-c', 'core.quotepath=off', '-c', 'diff.interHunkContext=0', '-c', 'diff.suppressBlankEmpty=false', '-c', 'diff.relative=false'];
export const PINNED_DIFF_OPTS: readonly string[] = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', '-M'];

/** A test file the diff deleted, or made stop running: an entry of IntegrityReport.deleted. */
export interface DeletedTest {
  path: string;
  to?: string | null;
  why?: string;
  inSpec: boolean;
}

/** Verify's test-integrity report: testIntegrity. */
export interface IntegrityReport {
  mode: 'block' | 'warn';
  base: string | null;
  mergeBase: string | null;
  head: string | null;
  deleted: DeletedTest[];
  renamed: { from: string; to: string }[];
  markers: { path: string; line: number; text: string }[];
  count: { before: number; after: number; delta: number; files: { path: string; before: number; after: number }[] };
  configEdits: { path: string; detail: string }[];
  blocking: number;
  findings: number;
  ok: boolean;
  error?: string;
}

/** The `integrity` key of verify's JSON: compactIntegrity. */
export type CompactIntegrity =
  | { mode: IntegrityReport['mode']; ok: boolean; error: string }
  | {
      mode: IntegrityReport['mode'];
      ok: boolean;
      base: string | null;
      findings: number;
      blocking: number;
      deletedTests: string[];
      renamedTests: string[];
      skipMarkers: string[];
      testCount: { before: number; after: number; delta: number };
      configEdits: string[];
      more: number;
    };

/** One `git diff --raw -z` entry: parseRaw. */
interface RawChange {
  status: string;
  from: string | null;
  to: string | null;
  oldMode: string;
  newMode: string;
}

/** Added and removed lines of one file: a value of parseDiffLines's map. */
export interface FileLines {
  added: { line: number; text: string }[];
  removed: string[];
}

const TEST_FILE_MARKERS = [
  /\b(describe|it|test|context|suite|t)\.(skip|only|todo)\b/,
  /\b(describe|it|test|context|suite|t)\s*\[\s*['"`](skip|only|todo)['"`]\s*\]/,
  /\b(xit|xdescribe|xtest|xcontext|fit|fdescribe)\s*\(/,
  /[{,]\s*(skip|only|todo)\s*:\s*(true|!0|[1-9]|['"`])/,
  // The `{ skip }` shorthand only as an options argument of a test call, not any destructuring.
  /\b(describe|it|test|suite|context)\s*\(.*,\s*\{(?:[^{}]*,)?\s*(skip|only|todo)\s*[,}]/,
  // …or an options object alone on its line, as formatters print a test call's arguments one per line.
  /^\s*\{(?:[^{}]*,)?\s*(skip|only|todo)\s*(?:,[^{}]*)?\}\s*[,)]?\s*$/,
  // …or options built ahead of the call (`const opts = { skip }`); not `todo`, a common field name.
  /=\s*\{(?:[^{}]*,)?\s*(skip|only)\s*[,}]/,
  /^\s*\.(skip|only|todo)\s*\(/,
  /\b(describe|it|test|suite|context)\.(skipIf|runIf)\s*\(/,
  /\bthis\.skip\s*\(/,
  /\bself\.skipTest\s*\(/,
  /\bt\.Skip(Now|f)?\s*\(/,
  /@(Disabled|Ignore)\b/,
];
// These spell a skip in any file: Rust tests live in `src/`, and pytest/unittest markers are unambiguous
// (`pytestmark = pytest.mark.skip` skips a whole module without an `@`).
const ANY_FILE_MARKERS = [/#\[ignore\b/, /\bpytest\.mark\.(skip|skipif|xfail)\b/, /\bpytest\.skip\s*\(/, /@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b/, /\bunittest\.SkipTest\b/];
// A build constraint that excludes a Go test file from every build.
const GO_BUILD_IGNORE = /^\/\/\s*(go:build|\+build)\b.*\bignore\b/;

const TEST_DECLS = [/^\s*(?:it|test|t\.test|xit|fit)(?:\.\w+)*\s*\(/gm, /^\s*(?:async\s+)?def\s+test\w*\s*\(/gm, /^\s*#\[(?:\w+::)*test\]/gm, /^func\s+Test\w*\s*\(/gm];

const INTERPRETERS = new Set(['node', 'bash', 'sh', 'zsh', 'python', 'python3', 'ruby', 'deno', 'bun', 'tsx', 'ts-node', 'perl']);

/**
 * Whether one added or removed line (without its `+`/`-`) is a skip or focus marker.
 */
export function markerHits(file: string, line: string, isTest: boolean): boolean {
  if (ANY_FILE_MARKERS.some((re) => re.test(line))) return true;
  if (!isTest) return false;
  if (file.endsWith('_test.go') && GO_BUILD_IGNORE.test(line)) return true;
  return TEST_FILE_MARKERS.some((re) => re.test(line));
}

/** Declared tests; skipped ones still count, so only deletions lower the total. */
export function countTestDecls(text: string): number {
  let n = 0;
  for (const re of TEST_DECLS) n += (text.match(re) ?? []).length;
  return n;
}

/**
 * The lines under every dev-dependencies table (plain, dotted or target-specific), so a Cargo.toml
 * edit counts as a test-config edit only when the dev-dependencies themselves change.
 */
export function devDepsSection(tomlText: string): string {
  const out: string[] = [];
  let inside = false;
  for (const raw of tomlText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const name = /^\[\s*([^\]]*?)\s*\]/.exec(line)?.[1] ?? '';
      inside = !line.startsWith('[[') && /^(?:target\..+\.)?dev-dependencies(?:\..+)?$/.test(name);
      if (inside) out.push(`[${name}]`);
      continue;
    }
    if (inside && line) out.push(line);
  }
  return out.join('\n');
}

/**
 * What changed in the keys of package.json that decide how tests run, or null when none did.
 * A missing file or key counts as empty.
 */
export function packageJsonDetail(beforeText: string | null, afterText: string | null): string | null {
  // Parsed package.json: raw input.
  const parse = (t: string | null): any => {
    const v = JSON.parse(t?.trim() ? t : '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  };
  let a: any, b: any;
  try {
    a = parse(beforeText);
    b = parse(afterText);
  } catch {
    return 'edited (unparseable)';
  }
  const parts: string[] = [];
  const sa = a.scripts && typeof a.scripts === 'object' ? a.scripts : {};
  const sb = b.scripts && typeof b.scripts === 'object' ? b.scripts : {};
  if (JSON.stringify(sa) !== JSON.stringify(sb)) {
    const keys = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].filter((k) => JSON.stringify(sa[k]) !== JSON.stringify(sb[k])).sort();
    parts.push(keys.length ? `scripts changed: ${keys.join(', ')}` : 'scripts changed');
  }
  for (const k of ['jest', 'mocha', 'ava']) if (JSON.stringify(a[k] ?? {}) !== JSON.stringify(b[k] ?? {})) parts.push(`${k} config changed`);
  return parts.length ? parts.join('; ') : null;
}

/**
 * Script files the configured commands run, so editing `scripts/test.sh` shows up as a test-config
 * edit. Only the program each command segment runs is taken, never its arguments or lint targets.
 */
export function commandSources(config: Pick<Config, 'commands' | 'services'>): string[] {
  const out = new Set<string>();
  // Commands come from YAML, so a value need not be a string.
  const scan = (cmds: Record<string, unknown> | undefined, prefix: string) => {
    for (const cmd of Object.values(cmds ?? {})) {
      if (typeof cmd !== 'string') continue;
      for (const segment of cmd.split(/&&|\|\||;|\|/)) {
        const words = segment.trim().split(/\s+/).filter(Boolean);
        while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
        if (!words.length) continue;
        const prog = INTERPRETERS.has(words[0]) ? words.slice(1).find((w) => !w.startsWith('-')) : words[0];
        if (!prog) continue;
        const file = prog.replace(/["']/g, '').replace(/^\.\//, '');
        if (file && (file.includes('/') || /\.(sh|bash|mjs|cjs|js|ts|py|rb|pl|ps1)$/.test(file))) out.add(prefix + file);
      }
    }
  };
  scan(config.commands, '');
  for (const s of config.services ?? []) if (s?.commands) scan(s.commands, s.path ? `${String(s.path).replace(/\/+$/, '')}/` : '');
  return [...out];
}

/** Paths that are test, build or CI config whatever their content. */
export function isConfigPath(p: string): boolean {
  const base = path.posix.basename(p);
  if (/^(Makefile|makefile|GNUmakefile|justfile|Justfile)$/.test(base) || base.endsWith('.mk')) return true;
  if (/^(\.github\/workflows|\.circleci|\.buildkite)\//.test(p) || ['.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.forge/config.yml'].includes(p)) return true;
  if (/^(jest\.config|vitest\.config|vitest\.workspace|playwright\.config|karma\.conf)\./.test(base) || /^\.(mocharc|nycrc)/.test(base)) return true;
  // Attributes can mark test files `-diff`/`binary`, which would hide their changed lines.
  return base === 'pytest.ini' || base === 'tox.ini' || base === '.gitattributes';
}

// A path token in a sanction: a backtick span, or one bare word right after the verb.
const ITEM = '`[^`\\n]+`';
const OBJECT = `(?:the\\s+)?(?:(?:test\\s+)?files?\\s+)?`;
const BARE = '[^\\s`]+';
const DELETE_RE = new RegExp(`\\b(?:delete|deletes|remove|removes|drop|drops)\\s+${OBJECT}(${ITEM}(?:\\s*(?:,\\s*and|,|and)\\s*${ITEM})*|${BARE})`, 'gi');
const MOVE_RE = new RegExp(`\\b(?:move|moves|rename|renames)\\s+${OBJECT}(${ITEM}|${BARE})\\s+(?:to|into|as)\\s+(${ITEM}|${BARE})`, 'gi');
// The object must end the clause: "Remove `x` from the glob", "Drop `x` coverage of …" and
// "Remove `x`'s assertion" name a part of the file, not the file.
const CLAUSE_END = /^(?:\s*$|\s*[.;:!?),]|\s*[\u2013\u2014]|\s+-\s|\s+(?:and|or|but|because|since|as|entirely|outright|completely)\b)/i;

/** `last` is the final captured item. */
const endsClause = (line: string, m: RegExpMatchArray, last: string): boolean => /[.;:!?),]$/.test(last) || CLAUSE_END.test(line.slice((m.index ?? 0) + m[0].length));
// Any negation voids the whole line; that only fails safe (the deletion blocks and a human decides).
const NEGATIONS = /n't\b|\b(not|never|keeps?|avoids?|without|leaves?|cannot)\b/i;

/**
 * The Approach lines that may sanction something: curly quotes normalised, negated lines dropped.
 */
function sanctionLines(specText: string): string[] {
  const section = approachSection(specText);
  if (section === null) return [];
  return section
    .split('\n')
    .map((l) => l.replace(/[\u2018\u2019\u02bc]/g, "'"))
    .filter((l) => !NEGATIONS.test(l));
}

const tokens = (raw: string): string[] => approachPaths(`## Approach\n${raw}`);

/**
 * Paths the spec's Approach explicitly says to delete: the exact path is the object of
 * delete/remove/drop (``Delete `test/old.test.mjs` ``, ``Remove the test files `a` and `b` ``).
 * A mention ("in `test/x.test.mjs`, remove the flaky case") sanctions nothing.
 */
export function deletionSanctions(specText: string): string[] {
  const out = new Set<string>();
  for (const line of sanctionLines(specText)) {
    for (const m of line.matchAll(DELETE_RE)) if (endsClause(line, m, m[1])) for (const p of tokens(m[1])) out.add(p);
  }
  return [...out];
}

/**
 * Test moves the spec's Approach states as ``Move `from` to `to` `` (or rename … to/into/as …); a
 * `to` ending in `/` names a directory that keeps the file name.
 */
export function renameSanctions(specText: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of sanctionLines(specText)) {
    for (const m of line.matchAll(MOVE_RE)) {
      if (!endsClause(line, m, m[2])) continue;
      const [from] = tokens(m[1]);
      const toRaw = m[2].replace(/^`|`$/g, '');
      const [to] = toRaw.endsWith('/') ? [toRaw.replace(/^\.\//, '')] : tokens(m[2]);
      if (from && to) out.push([from, to]);
    }
  }
  return out;
}

const renameSanctioned = (pairs: [string, string][], from: string, to: string): boolean => pairs.some(([f, t]) => f === from && (t === to || (t.endsWith('/') && `${t}${path.posix.basename(from)}` === to)));

/**
 * Whether an in-pattern rename may take the file out of the runner's glob: a new directory
 * (`test/a.test.mjs` → `test/old/a.test.mjs` leaves `test/*.test.mjs`), a changed test suffix
 * (`.test.mjs` → `.test.mjs.off`, `.test.js` → `.test.ts`) or a lost `test_` prefix.
 */
export function renameDropsTest(from: string, to: string): boolean {
  const kind = (p: string) => {
    const b = path.posix.basename(p);
    return { dir: path.posix.dirname(p), suffix: /(?:[._-](?:test|spec)s?)?(?:\.[^.]*)?$/.exec(b)?.[0] ?? '', prefixed: /^test_/.test(b) };
  };
  const a = kind(from);
  const b = kind(to);
  return a.dir !== b.dir || a.suffix !== b.suffix || (a.prefixed && !b.prefixed);
}

/**
 * `git diff --raw -z` entries. `from` is null for an added file, `to` for a deleted one; modes tell
 * a regular file (100644/100755) from a symlink (120000) or a submodule (160000).
 */
function parseRaw(raw: string): RawChange[] {
  const tok = raw.split('\0');
  const out: RawChange[] = [];
  for (let i = 0; i < tok.length && tok[i]; ) {
    const [oldMode, newMode, , , st] = tok[i].replace(/^:/, '').split(' ');
    const status = (st ?? '')[0];
    if (status === 'R' || status === 'C') {
      out.push({ status, from: status === 'R' ? tok[i + 1] : null, to: tok[i + 2], oldMode, newMode });
      i += 3;
    } else {
      out.push({ status, from: status === 'A' ? null : tok[i + 1], to: status === 'D' ? null : tok[i + 1], oldMode, newMode });
      i += 2;
    }
  }
  return out;
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * A `---`/`+++` header path: git appends a tab after names with spaces and C-quotes names with
 * control characters, quotes or backslashes (octal escapes are UTF-8 bytes).
 */
function unquote(p: string): string {
  p = p.replace(/\t$/, '');
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const src = Buffer.from(p.slice(1, -1), 'utf8');
  const bytes: number[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== 92) {
      bytes.push(src[i]);
      continue;
    }
    const oct = /^[0-7]{3}/.exec(src.subarray(i + 1, i + 4).toString('latin1'));
    if (oct) {
      bytes.push(parseInt(oct[0], 8) & 0xff);
      i += 3;
    } else {
      const ch = String.fromCharCode(src[i + 1] ?? 92);
      bytes.push(C_ESCAPES[ch] ?? src[i + 1] ?? 92);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Added and removed lines per file from a `-U0` diff. Hunk line counts are honoured, so an added
 * line that itself reads `++ b/x` cannot be mistaken for a file header.
 */
export function parseDiffLines(raw: string): Map<string, FileLines> {
  const files = new Map<string, FileLines>();
  let oldPath: string | null = null;
  let cur: FileLines | null = null;
  let minus = 0;
  let plus = 0;
  let next = 0;
  for (const line of raw.split('\n')) {
    if (minus > 0 || plus > 0) {
      if (line.startsWith('\\')) continue;
      // Context lines appear even with -U0 when hunks are merged (diff.interHunkContext); an empty
      // line is blank context under diff.suppressBlankEmpty. Both count against both sides.
      if ((line === '' || line.startsWith(' ')) && minus > 0 && plus > 0) {
        minus--;
        plus--;
        next++;
        continue;
      }
      if (line.startsWith('-') && minus > 0) {
        minus--;
        cur?.removed.push(line.slice(1));
        continue;
      }
      if (line.startsWith('+') && plus > 0) {
        plus--;
        cur?.added.push({ line: next++, text: line.slice(1) });
        continue;
      }
      minus = plus = 0;
    }
    if (line.startsWith('diff --git ')) {
      oldPath = null;
      cur = null;
    } else if (line.startsWith('--- ')) {
      const p = unquote(line.slice(4));
      oldPath = p === '/dev/null' ? null : p.replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const p = unquote(line.slice(4));
      const key = p === '/dev/null' ? oldPath : p.replace(/^b\//, '');
      if (key) {
        if (!files.has(key)) files.set(key, { added: [], removed: [] });
        cur = files.get(key) ?? null;
      }
    } else {
      const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (h) {
        minus = h[1] === undefined ? 1 : Number(h[1]);
        plus = h[3] === undefined ? 1 : Number(h[3]);
        next = Number(h[2]);
      }
    }
  }
  return files;
}

/**
 * Ways the files on disk can differ from HEAD while `git status` stays empty: index flags that tell
 * git not to look (assume-unchanged, skip-worktree), and clean/smudge filters on the files this
 * report vouches for (tests and test/CI config). Verify treats any of these as an unclean worktree,
 * since the commands would run on files the report never saw. Forge's own eval checkouts
 * sparse-exclude `.forge/evals/`, and the standard git-lfs filter is trusted.
 */
export function hiddenChanges(cwd: string, config: Pick<Config, 'commands' | 'services' | 'evals'>): string[] {
  const git = (args: string[], input?: string) => run('git', args, { cwd, input }).stdout;
  const out: string[] = [];
  const files: string[] = [];
  let testRe: RegExp | null = null;
  try {
    testRe = new RegExp(config.evals?.testPattern ?? DEFAULT_TEST_PATTERN);
  } catch {}
  const sources = new Set(commandSources(config));
  const isWatched = (p: string) => Boolean(testRe?.test(p) || isConfigPath(p) || ['package.json', 'Cargo.toml'].includes(path.posix.basename(p)) || sources.has(p));
  const sparse = sparseSet(cwd);
  for (const entry of git(['ls-files', '-v', '-z']).split('\0')) {
    if (!entry) continue;
    const tag = entry[0];
    const p = entry.slice(2);
    files.push(p);
    if (tag === 'S') {
      // A skip-worktree file on disk can hold edits git won't show. One missing from disk is a file
      // the runner silently lacks, unless a real sparse checkout leaves it out: then it is fine.
      const onDisk = fs.existsSync(path.join(cwd, p)) || isSymlink(path.join(cwd, p));
      const excused = p.startsWith('.forge/evals/') || (sparse && (sparse.cone ? sparse.excludes(p) : !isWatched(p)));
      if (onDisk || !excused) out.push(`skip-worktree: ${p}`);
    } else if (tag !== tag.toUpperCase()) out.push(`assume-unchanged: ${p}`);
  }
  const watched = files.filter(isWatched);
  if (!watched.length) return out;
  const lfs = /^git-lfs\s/.test(run('git', ['config', '--get', 'filter.lfs.process'], { cwd, allowFail: true }).stdout.trim() || run('git', ['config', '--get', 'filter.lfs.smudge'], { cwd, allowFail: true }).stdout.trim());
  const attrs = git(['check-attr', '--stdin', '-z', 'filter'], `${watched.join('\0')}\0`).split('\0');
  for (let i = 0; i + 2 < attrs.length; i += 3) {
    const [p, , value] = [attrs[i], attrs[i + 1], attrs[i + 2]];
    if (value === 'unspecified' || value === 'unset' || (value === 'lfs' && lfs)) continue;
    const blob = git(['rev-parse', `:${p}`]).trim();
    const disk = run('git', ['hash-object', '--no-filters', '--', p], { cwd, allowFail: true });
    if (!disk.ok || disk.stdout.trim() !== blob) out.push(`filter ${value} changes the checked-out file: ${p}`);
  }
  return out;
}

const CONE_LINE = /^(?:\/\*|!\/\*\/|\/.+\/|!\/.+\/\*\/)$/;

/**
 * The worktree's sparse checkout, if it really has one: `core.sparseCheckout`, cone mode, and a
 * patterns file that is entirely in cone form. Then a path is excluded when it lies outside every
 * recursive directory and is not a file directly in one of their ancestors. Anything else (no
 * patterns, non-cone patterns, patterns git would refuse as cone) gets `cone: false`, and only
 * paths that are not tests or test config may be missing. Every failure here falls back to the
 * stricter answer.
 */
function sparseSet(cwd: string): { cone: boolean; excludes: (p: string) => boolean } | null {
  const cfg = (key: string) => run('git', ['config', '--get', '--bool', key], { cwd, allowFail: true }).stdout.trim() === 'true';
  if (!cfg('core.sparseCheckout')) return null;
  const file = path.resolve(cwd, run('git', ['rev-parse', '--git-path', 'info/sparse-checkout'], { cwd }).stdout.trim());
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {}
  if (!lines.length) return null;
  if (!cfg('core.sparseCheckoutCone') || !lines.every((l) => CONE_LINE.test(l))) return { cone: false, excludes: () => false };
  const dirs = run('git', ['sparse-checkout', 'list'], { cwd }).stdout.split('\n').map((d) => d.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return {
    cone: true,
    excludes: (p) => {
      const dir = path.posix.dirname(p);
      if (dir === '.') return false;
      return !dirs.some((d) => p.startsWith(`${d}/`) || `${d}/`.startsWith(`${dir}/`));
    },
  };
}

/**
 * Turns a report into an integrity error (fails `block`, printed under `warn`), for checks verify
 * could not complete; an unfinished check must never read as "no findings".
 */
export function integrityError(report: IntegrityReport, message: string): IntegrityReport {
  return { ...report, error: report.error ? `${report.error}; ${message}` : message, ok: report.mode !== 'block' };
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const LINK_MODES: Record<string, string> = { 120000: 'symlink', 160000: 'submodule' };

/**
 * How many commits the job branch's reflog records as made on it (`commit:` entries) are already
 * in the merge-base. Honest bases never contain them; a base ref moved onto the job's work does,
 * and would otherwise shrink the diff to nothing. A heuristic until the base sha is pinned per job.
 */
function baseHasJobCommits(git: (args: string[]) => string, branch: string | null | undefined, mergeBase: string): number {
  if (!branch) return 0;
  let log: string;
  try {
    log = git(['reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`, '--']);
  } catch {
    return 0;
  }
  const shas = [...new Set(log.split('\n').filter((l) => /^[0-9a-f]+ commit(?: \([a-z]+\))?:/.test(l)).map((l) => l.split(' ')[0]))].slice(0, 200);
  if (!shas.length) return 0;
  // Reflog entries can outlive their objects; only commits that still exist can be checked.
  const present = shas.filter((sha) => {
    try {
      git(['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  });
  if (!present.length) return 0;
  const outside = new Set(git(['rev-list', ...present, '--not', mergeBase]).split('\n'));
  return present.filter((sha) => !outside.has(sha)).length;
}

/**
 * The integrity report for `merge-base(base, HEAD)..HEAD` in the job's worktree. Never throws:
 * a report that cannot be computed carries `error`, and fails only under `block`.
 */
export function testIntegrity(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'base'> & { branch?: string | null }): IntegrityReport {
  const mode = config.verifyIntegrity === 'block' ? 'block' : 'warn';
  const report: IntegrityReport = { mode, base: null, mergeBase: null, head: null, deleted: [], renamed: [], markers: [], count: { before: 0, after: 0, delta: 0, files: [] }, configEdits: [], blocking: 0, findings: 0, ok: true };
  try {
    // verify runs this only for a job with a worktree.
    const cwd = job.worktree!;
    const env = realHistoryEnv();
    const git = (args: string[]) => run('git', args, { cwd, env }).stdout;
    const { baseRef, mergeBase } = resolveBase(cwd, config, job);
    report.base = baseRef;
    report.mergeBase = mergeBase;
    report.head = git(['rev-parse', 'HEAD']).trim();
    let testRe: RegExp;
    try {
      testRe = new RegExp(config.evals?.testPattern ?? DEFAULT_TEST_PATTERN);
    } catch (e) {
      throw new ForgeError(`invalid evals.testPattern: ${(e as Error).message}`);
    }
    const diffArgs = [...PINNED_GIT_CONFIG, 'diff', ...PINNED_DIFF_OPTS];
    const changes = parseRaw(git([...diffArgs, '--raw', '-z', mergeBase, 'HEAD']));
    const lines = parseDiffLines(git([...diffArgs, '--text', '-U0', mergeBase, 'HEAD']));
    const read = (rev: string, p: string | null): string | null => {
      if (!p) return null;
      const r = run('git', ['cat-file', 'blob', `${rev}:${p}`], { cwd, env, allowFail: true });
      return r.ok ? r.stdout : null;
    };
    // Config files with binary content are reported as unparseable rather than parsed.
    const text = (rev: string, p: string | null) => {
      const t = read(rev, p);
      return t !== null && !t.includes('\0') ? t : null;
    };
    const isTest = (p: string | null) => Boolean(p && testRe.test(p));

    const jobCommits = baseHasJobCommits(git, job.branch, mergeBase);
    if (jobCommits) throw new ForgeError(`base ${baseRef} already contains ${jobCommits} commit(s) made on ${job.branch}; its ref may have been moved, so the diff cannot be trusted`);

    const specFile = path.join(jobDir(root, job.id), 'spec.md');
    const specText = exists(specFile) ? fs.readFileSync(specFile, 'utf8') : '';
    const sanctioned = new Set(deletionSanctions(specText));
    const moves = renameSanctions(specText);
    const sources = new Set(commandSources(config));

    for (const c of changes) {
      if (c.from && isTest(c.from)) {
        const gone = c.to && LINK_MODES[c.newMode];
        if (c.status === 'D') report.deleted.push({ path: c.from, inSpec: sanctioned.has(c.from) });
        else if (gone) report.deleted.push({ path: c.from, why: `now a ${gone}`, inSpec: false });
        else if (c.status === 'R' && !isTest(c.to)) report.deleted.push({ path: c.from, to: c.to, why: 'renamed out of the test pattern', inSpec: false });
        // Only an explicit "Move `from` to `to`" in the spec sanctions this; a rename out of the pattern never.
        else if (c.status === 'R' && renameDropsTest(c.from, c.to as string))
          report.deleted.push({ path: c.from, to: c.to, why: 'moved where the runner may not pick it up', inSpec: renameSanctioned(moves, c.from, c.to as string) });
        // A rename has both sides.
        else if (c.status === 'R') report.renamed.push({ from: c.from, to: c.to! });
      }
      if (isTest(c.from) || isTest(c.to)) {
        const before = isTest(c.from) ? countTestDecls(read(mergeBase, c.from) ?? '') : 0;
        // A symlink, a submodule or a rename the runner may not pick up no longer runs, whatever it contains.
        const runs = isTest(c.to) && !LINK_MODES[c.newMode] && !(c.status === 'R' && isTest(c.from) && renameDropsTest(c.from as string, c.to as string));
        const after = runs ? countTestDecls(read('HEAD', c.to) ?? '') : 0;
        report.count.before += before;
        report.count.after += after;
        // One side is a test, so at least one path is set.
        if (before !== after) report.count.files.push({ path: c.to ?? c.from!, before, after });
      }
      const edit = configEdit(c, sources, text, mergeBase);
      if (edit) report.configEdits.push(edit);
    }
    report.count.delta = report.count.after - report.count.before;

    for (const [file, { added, removed }] of lines) {
      const t = isTest(file);
      const hits = added.filter((a) => markerHits(file, a.text, t));
      if (!hits.length) continue;
      // Only the same marker moved or reindented cancels out; an unrelated removed line does not.
      const norm = (x: string) => x.replace(/\s+/g, '');
      const pool = removed.filter((r) => markerHits(file, r, t)).map(norm);
      const unmatched = hits.filter((h) => {
        const i = pool.indexOf(norm(h.text));
        if (i < 0) return true;
        pool.splice(i, 1);
        return false;
      });
      // No exemption for binary content: `--text` produced these lines, and rustc and pytest accept a NUL in a comment.
      if (!unmatched.length) continue;
      for (const h of hits) report.markers.push({ path: file, line: h.line, text: h.text.trim() });
    }
  } catch (e) {
    report.error = (e as Error).message;
    report.ok = mode !== 'block';
    return report;
  }
  report.blocking = report.deleted.filter((d) => !d.inSpec).length + report.markers.length;
  report.findings = report.deleted.length + report.renamed.length + report.markers.length + report.configEdits.length + (report.count.delta < 0 ? 1 : 0);
  report.ok = mode !== 'block' || report.blocking === 0;
  return report;
}

function configEdit(
  c: { status: string; from: string | null; to: string | null },
  sources: Set<string>,
  show: (rev: string, p: string | null) => string | null,
  mergeBase: string,
): { path: string; detail: string } | null {
  const p = (c.to ?? c.from) as string;
  const detail = c.status === 'A' || c.status === 'C' ? 'added' : c.status === 'D' ? 'deleted' : c.status === 'R' ? `renamed from ${c.from}` : 'edited';
  const names = [c.from, c.to].filter((x) => x !== null);
  const base = path.posix.basename(p);
  if (base === 'package.json') {
    const before = c.from ? show(mergeBase, c.from) : '';
    const after = c.to ? show('HEAD', c.to) : '';
    if (before === null || after === null) return { path: p, detail: 'edited (unparseable)' };
    const d = packageJsonDetail(before, after);
    return d ? { path: p, detail: d } : null;
  }
  if (base === 'Cargo.toml') {
    const before = devDepsSection((c.from && show(mergeBase, c.from)) || '');
    const after = devDepsSection((c.to && show('HEAD', c.to)) || '');
    return before !== after ? { path: p, detail: '[dev-dependencies] changed' } : null;
  }
  if (names.some((n) => isConfigPath(n) || sources.has(n))) return { path: p, detail };
  return null;
}

/**
 * Paths and details come from the builder's commits: escape control characters so a file name
 * with a newline cannot start a heading or a fake instruction line in agent-read markdown.
 */
const clean = (s: string): string => String(s).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** An inline code span whose delimiter is longer than any backtick run inside it. */
const code = (p: string): string => {
  const c = clean(p);
  if (!c.includes('`')) return `\`${c}\``;
  const fence = '`'.repeat(Math.max(...(c.match(/`+/g) ?? ['']).map((r) => r.length)) + 1);
  return `${fence} ${c} ${fence}`;
};

const deletedSuffix = (d: DeletedTest): string => `${d.to ? ` → ${code(d.to)}` : ''}${d.why ? ` (${d.why})` : ''}${d.inSpec ? ' (named in spec)' : ''}`;

function heading(report: IntegrityReport): string {
  if (report.error) return 'error';
  if (report.mode === 'block' && report.blocking > 0) return `FAILED (${report.blocking} blocking)`;
  if (report.findings > 0) return `WARN (${report.findings} finding${report.findings === 1 ? '' : 's'})`;
  return 'ok';
}

const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

/**
 * The `## integrity` section of verify/round-N.md, with every finding listed.
 */
export function renderIntegrity(report: IntegrityReport): string {
  const c = report.count;
  const base = report.base ? `base ${code(report.base)}${report.mergeBase ? ` @ ${report.mergeBase.slice(0, 7)}` : ''}` : 'base unresolved';
  const lines = [`## integrity: ${heading(report)}`, '', `Mode \`${report.mode}\` · ${base} · test declarations ${c.before} → ${c.after} (${signed(c.delta)})`, ''];
  if (report.error) {
    lines.push(`The report could not be computed${report.mode === 'block' ? ', which fails verify under `block`' : ''}:`, '', '```text', String(report.error).replace(/```/g, "'''"), '```', '');
    return lines.join('\n');
  }
  if (!report.findings) {
    lines.push('No deleted or renamed tests, skip/focus markers, test-count drop or test/CI config edits.', '');
    return lines.join('\n');
  }
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push(`### ${title} (${items.length})`, '', ...items, '');
  };
  section(
    'Deleted test files',
    report.deleted.map((d) => `- ${code(d.path)}${deletedSuffix(d)}`),
  );
  section('Renamed test files', report.renamed.map((r) => `- ${code(r.from)} → ${code(r.to)}`));
  if (report.markers.length) {
    // A text fence, so backticks in the marked line cannot break the markdown.
    const marked = report.markers.map((m) => clean(`${m.path}:${m.line}: ${m.text.length > 160 ? `${m.text.slice(0, 160)}…` : m.text}`).replace(/```/g, "'''"));
    lines.push(`### Skip/focus markers added (${report.markers.length})`, '', '```text', ...marked, '```', '');
  }
  if (c.delta < 0) section('Test count dropped', c.files.filter((f) => f.after < f.before).map((f) => `- ${code(f.path)}: ${f.before} → ${f.after}`));
  section('Test, build or CI config edits', report.configEdits.map((e) => `- ${code(e.path)}: ${clean(e.detail)}`));
  return lines.join('\n');
}

/**
 * The compact `integrity` key of verify's JSON: each list capped, `more` counts what was dropped.
 */
export function compactIntegrity(report: IntegrityReport): CompactIntegrity {
  if (report.error) return { mode: report.mode, ok: report.ok, error: report.error };
  let more = 0;
  const cap = (xs: string[]) => {
    more += Math.max(0, xs.length - JSON_LIST_LIMIT);
    return xs.slice(0, JSON_LIST_LIMIT);
  };
  return {
    mode: report.mode,
    ok: report.ok,
    base: report.base,
    findings: report.findings,
    blocking: report.blocking,
    deletedTests: cap(report.deleted.map((d) => `${d.path}${d.to ? ` -> ${d.to}` : d.why ? ` (${d.why})` : ''}${d.inSpec ? ' (in spec)' : ''}`)),
    renamedTests: cap(report.renamed.map((r) => `${r.from} -> ${r.to}`)),
    skipMarkers: cap(report.markers.map((m) => `${m.path}:${m.line}`)),
    testCount: { before: report.count.before, after: report.count.after, delta: report.count.delta },
    configEdits: cap(report.configEdits.map((e) => e.path)),
    more,
  };
}

/** One line per blocking finding, for verify's `failure.tail`. */
export function blockingLines(report: IntegrityReport): string {
  if (report.error) return report.error;
  return [
    ...report.deleted.filter((d) => !d.inSpec).map((d) => clean(`deleted ${d.path}${d.to ? ` (${d.why}: ${d.to})` : d.why ? ` (${d.why})` : ''}`)),
    ...report.markers.map((m) => clean(`skip marker ${m.path}:${m.line}`)),
  ].join('\n');
}
