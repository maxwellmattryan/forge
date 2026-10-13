// @ts-check
// Verify's test-integrity report: what the committed diff did to the tests and to the config that
// runs them. A build can go green by deleting a test, adding `.skip`, or editing the test script;
// this makes those changes visible to reviewers and, under `verifyIntegrity: block`, fails verify.
// Must not import evals.mjs or worktree.mjs: worktree imports this module, and evals imports worktree.
import fs from 'node:fs';
import path from 'node:path';
import { jobDir } from './jobs.mjs';
import { exists } from './paths.mjs';
import { approachPaths, approachSection, realHistoryEnv, resolveBase } from './scope.mjs';
import { ForgeError, run } from './util.mjs';

export const DEFAULT_TEST_PATTERN = '(^|/)(tests?|__tests__|spec|specs)/|[._-](test|spec)s?\\.[A-Za-z0-9]+$|_test\\.(go|py|rs)$|(^|/)test_[^/]+\\.py$';

const JSON_LIST_LIMIT = 10;

const TEST_FILE_MARKERS = [
  /\b(describe|it|test|context|suite|t)\.(skip|only|todo)\b/,
  /\b(describe|it|test|context|suite|t)\s*\[\s*['"`](skip|only|todo)['"`]\s*\]/,
  /\b(xit|xdescribe|xtest|xcontext|fit|fdescribe)\s*\(/,
  /[{,]\s*(skip|only|todo)\s*:\s*(true|!0|[1-9]|['"`])/,
  // The `{ skip }` shorthand only as an options argument of a test call, not any destructuring.
  /\b(describe|it|test|suite|context)\s*\(.*,\s*\{(?:[^{}]*,)?\s*(skip|only|todo)\s*[,}]/,
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
 * @param {string} file @param {string} line @param {boolean} isTest
 */
export function markerHits(file, line, isTest) {
  if (ANY_FILE_MARKERS.some((re) => re.test(line))) return true;
  if (!isTest) return false;
  if (file.endsWith('_test.go') && GO_BUILD_IGNORE.test(line)) return true;
  return TEST_FILE_MARKERS.some((re) => re.test(line));
}

/** Declared tests; skipped ones still count, so only deletions lower the total. @param {string} text */
export function countTestDecls(text) {
  let n = 0;
  for (const re of TEST_DECLS) n += (text.match(re) ?? []).length;
  return n;
}

/**
 * The lines under every dev-dependencies table (plain, dotted or target-specific), so a Cargo.toml
 * edit counts as a test-config edit only when the dev-dependencies themselves change.
 * @param {string} tomlText
 */
export function devDepsSection(tomlText) {
  const out = [];
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
 * @param {string | null} beforeText @param {string | null} afterText
 * @returns {string | null}
 */
export function packageJsonDetail(beforeText, afterText) {
  /** @param {string | null} t */
  const parse = (t) => {
    const v = JSON.parse(t?.trim() ? t : '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  };
  let a, b;
  try {
    a = parse(beforeText);
    b = parse(afterText);
  } catch {
    return 'edited (unparseable)';
  }
  const parts = [];
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
 * @param {any} config @returns {string[]}
 */
export function commandSources(config) {
  const out = new Set();
  /** @param {any} cmds @param {string} prefix */
  const scan = (cmds, prefix) => {
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

/** Paths that are test, build or CI config whatever their content. @param {string} p */
export function isConfigPath(p) {
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

/** @param {string} line @param {RegExpMatchArray} m @param {string} last the final captured item */
const endsClause = (line, m, last) => /[.;:!?),]$/.test(last) || CLAUSE_END.test(line.slice((m.index ?? 0) + m[0].length));
// Any negation voids the whole line; that only fails safe (the deletion blocks and a human decides).
const NEGATIONS = /n't\b|\b(not|never|keeps?|avoids?|without|leaves?|cannot)\b/i;

/**
 * The Approach lines that may sanction something: curly quotes normalised, negated lines dropped.
 * @param {string} specText @returns {string[]}
 */
function sanctionLines(specText) {
  const section = approachSection(specText);
  if (section === null) return [];
  return section
    .split('\n')
    .map((l) => l.replace(/[\u2018\u2019\u02bc]/g, "'"))
    .filter((l) => !NEGATIONS.test(l));
}

/** @param {string} raw @returns {string[]} */
const tokens = (raw) => approachPaths(`## Approach\n${raw}`);

/**
 * Paths the spec's Approach explicitly says to delete: the exact path is the object of
 * delete/remove/drop (``Delete `test/old.test.mjs` ``, ``Remove the test files `a` and `b` ``).
 * A mention ("in `test/x.test.mjs`, remove the flaky case") sanctions nothing.
 * @param {string} specText @returns {string[]}
 */
export function deletionSanctions(specText) {
  const out = new Set();
  for (const line of sanctionLines(specText)) {
    for (const m of line.matchAll(DELETE_RE)) if (endsClause(line, m, m[1])) for (const p of tokens(m[1])) out.add(p);
  }
  return [...out];
}

/**
 * Test moves the spec's Approach states as ``Move `from` to `to` `` (or rename … to/into/as …); a
 * `to` ending in `/` names a directory that keeps the file name.
 * @param {string} specText @returns {[string, string][]}
 */
export function renameSanctions(specText) {
  /** @type {[string, string][]} */
  const out = [];
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

/** @param {[string, string][]} pairs @param {string} from @param {string} to */
const renameSanctioned = (pairs, from, to) => pairs.some(([f, t]) => f === from && (t === to || (t.endsWith('/') && `${t}${path.posix.basename(from)}` === to)));

/**
 * Whether an in-pattern rename may take the file out of the runner's glob: a new directory
 * (`test/a.test.mjs` → `test/old/a.test.mjs` leaves `test/*.test.mjs`), a changed test suffix
 * (`.test.mjs` → `.test.mjs.off`, `.test.js` → `.test.ts`) or a lost `test_` prefix.
 * @param {string} from @param {string} to
 */
export function renameDropsTest(from, to) {
  /** @param {string} p */
  const kind = (p) => {
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
 * @param {string} raw @returns {{status:string, from:string|null, to:string|null, oldMode:string, newMode:string}[]}
 */
function parseRaw(raw) {
  const tok = raw.split('\0');
  const out = [];
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

const C_ESCAPES = /** @type {Record<string, number>} */ ({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });

/**
 * A `---`/`+++` header path: git appends a tab after names with spaces and C-quotes names with
 * control characters, quotes or backslashes (octal escapes are UTF-8 bytes).
 * @param {string} p
 */
function unquote(p) {
  p = p.replace(/\t$/, '');
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const src = Buffer.from(p.slice(1, -1), 'utf8');
  const bytes = [];
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
 * @param {string} raw
 * @returns {Map<string, {added:{line:number, text:string}[], removed:string[]}>}
 */
export function parseDiffLines(raw) {
  /** @type {Map<string, {added:{line:number, text:string}[], removed:string[]}>} */
  const files = new Map();
  let oldPath = null;
  /** @type {{added:{line:number, text:string}[], removed:string[]} | null} */
  let cur = null;
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
 * @param {string} cwd @param {any} config @returns {string[]}
 */
export function hiddenChanges(cwd, config) {
  const git = (/** @type {string[]} */ args, /** @type {string | undefined} */ input) => run('git', args, { cwd, input }).stdout;
  const out = [];
  const files = [];
  let testRe = null;
  try {
    testRe = new RegExp(config.evals?.testPattern ?? DEFAULT_TEST_PATTERN);
  } catch {}
  const sources = new Set(commandSources(config));
  const isWatched = (/** @type {string} */ p) => Boolean(testRe?.test(p) || isConfigPath(p) || ['package.json', 'Cargo.toml'].includes(path.posix.basename(p)) || sources.has(p));
  const sparse = run('git', ['config', '--get', '--bool', 'core.sparseCheckout'], { cwd, allowFail: true }).stdout.trim() === 'true';
  for (const entry of git(['ls-files', '-v', '-z']).split('\0')) {
    if (!entry) continue;
    const tag = entry[0];
    const p = entry.slice(2);
    files.push(p);
    if (tag === 'S') {
      // Sparse checkout marks every path outside the sparse set skip-worktree and leaves it off disk;
      // that hides nothing. A skip-worktree file on disk can hold edits git won't show, and outside a
      // sparse checkout a missing watched file is a test or test config the runner silently lacks.
      const onDisk = fs.existsSync(path.join(cwd, p)) || isSymlink(path.join(cwd, p));
      if (onDisk || (!sparse && isWatched(p) && !p.startsWith('.forge/evals/'))) out.push(`skip-worktree: ${p}`);
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

/** @param {string} p */
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const LINK_MODES = /** @type {Record<string, string>} */ ({ 120000: 'symlink', 160000: 'submodule' });

/**
 * How many commits the job branch's reflog records as made on it (`commit:` entries) are already
 * in the merge-base. Honest bases never contain them; a base ref moved onto the job's work does,
 * and would otherwise shrink the diff to nothing. A heuristic until the base sha is pinned per job.
 * @param {(args: string[]) => string} git @param {string | undefined} branch @param {string} mergeBase
 */
function baseHasJobCommits(git, branch, mergeBase) {
  if (!branch) return 0;
  let log;
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
 * @param {string} root @param {any} config @param {any} job
 */
export function testIntegrity(root, config, job) {
  const mode = config.verifyIntegrity === 'block' ? 'block' : 'warn';
  /** @type {any} */
  const report = { mode, base: null, mergeBase: null, head: null, deleted: [], renamed: [], markers: [], count: { before: 0, after: 0, delta: 0, files: [] }, configEdits: [], blocking: 0, findings: 0, ok: true };
  try {
    const cwd = job.worktree;
    const env = realHistoryEnv();
    const git = (/** @type {string[]} */ args) => run('git', args, { cwd, env }).stdout;
    const { baseRef, mergeBase } = resolveBase(cwd, config, job);
    report.base = baseRef;
    report.mergeBase = mergeBase;
    report.head = git(['rev-parse', 'HEAD']).trim();
    /** @type {RegExp} */
    let testRe;
    try {
      testRe = new RegExp(config.evals?.testPattern ?? DEFAULT_TEST_PATTERN);
    } catch (e) {
      throw new ForgeError(`invalid evals.testPattern: ${/** @type {Error} */ (e).message}`);
    }
    // Repo config is writable from the job's worktree, so pin everything the parsers depend on:
    // quoting, prefixes, drivers, colour, hunk merging, blank-context rendering, relative paths and
    // submodule visibility. `--text` defeats `-diff`/`binary` attributes that would hide added lines.
    const diffArgs = [
      ...['-c', 'core.quotepath=off', '-c', 'diff.interHunkContext=0', '-c', 'diff.suppressBlankEmpty=false', '-c', 'diff.relative=false'],
      ...['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=none', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', '-M'],
    ];
    const changes = parseRaw(git([...diffArgs, '--raw', '-z', mergeBase, 'HEAD']));
    const lines = parseDiffLines(git([...diffArgs, '--text', '-U0', mergeBase, 'HEAD']));
    /** @param {string} rev @param {string | null} p @returns {string | null} */
    const read = (rev, p) => {
      if (!p) return null;
      const r = run('git', ['cat-file', 'blob', `${rev}:${p}`], { cwd, env, allowFail: true });
      return r.ok ? r.stdout : null;
    };
    // Config files with binary content are reported as unparseable rather than parsed.
    const text = (/** @type {string} */ rev, /** @type {string | null} */ p) => {
      const t = read(rev, p);
      return t !== null && !t.includes('\0') ? t : null;
    };
    const isTest = (/** @type {string | null} */ p) => Boolean(p && testRe.test(p));

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
        else if (c.status === 'R' && renameDropsTest(c.from, /** @type {string} */ (c.to)))
          report.deleted.push({ path: c.from, to: c.to, why: 'moved where the runner may not pick it up', inSpec: renameSanctioned(moves, c.from, /** @type {string} */ (c.to)) });
        else if (c.status === 'R') report.renamed.push({ from: c.from, to: c.to });
      }
      if (isTest(c.from) || isTest(c.to)) {
        const before = isTest(c.from) ? countTestDecls(read(mergeBase, c.from) ?? '') : 0;
        // A symlink, a submodule or a rename the runner may not pick up no longer runs, whatever it contains.
        const runs = isTest(c.to) && !LINK_MODES[c.newMode] && !(c.status === 'R' && isTest(c.from) && renameDropsTest(/** @type {string} */ (c.from), /** @type {string} */ (c.to)));
        const after = runs ? countTestDecls(read('HEAD', c.to) ?? '') : 0;
        report.count.before += before;
        report.count.after += after;
        if (before !== after) report.count.files.push({ path: c.to ?? c.from, before, after });
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
      const norm = (/** @type {string} */ x) => x.replace(/\s+/g, '');
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
    report.error = /** @type {Error} */ (e).message;
    report.ok = mode !== 'block';
    return report;
  }
  report.blocking = report.deleted.filter((/** @type {any} */ d) => !d.inSpec).length + report.markers.length;
  report.findings = report.deleted.length + report.renamed.length + report.markers.length + report.configEdits.length + (report.count.delta < 0 ? 1 : 0);
  report.ok = mode !== 'block' || report.blocking === 0;
  return report;
}

/**
 * @param {{status:string, from:string|null, to:string|null}} c @param {Set<string>} sources
 * @param {(rev:string, p:string|null) => string|null} show @param {string} mergeBase
 * @returns {{path:string, detail:string} | null}
 */
function configEdit(c, sources, show, mergeBase) {
  const p = /** @type {string} */ (c.to ?? c.from);
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
 * @param {string} s
 */
const clean = (s) => String(s).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** An inline code span whose delimiter is longer than any backtick run inside it. @param {string} p */
const code = (p) => {
  const c = clean(p);
  if (!c.includes('`')) return `\`${c}\``;
  const fence = '`'.repeat(Math.max(...(c.match(/`+/g) ?? ['']).map((r) => r.length)) + 1);
  return `${fence} ${c} ${fence}`;
};

/** @param {any} d */
const deletedSuffix = (d) => `${d.to ? ` → ${code(d.to)}` : ''}${d.why ? ` (${d.why})` : ''}${d.inSpec ? ' (named in spec)' : ''}`;

/** @param {any} report */
function heading(report) {
  if (report.error) return 'error';
  if (report.mode === 'block' && report.blocking > 0) return `FAILED (${report.blocking} blocking)`;
  if (report.findings > 0) return `WARN (${report.findings} finding${report.findings === 1 ? '' : 's'})`;
  return 'ok';
}

/** @param {number} n */
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

/**
 * The `## integrity` section of verify/round-N.md, with every finding listed.
 * @param {any} report @returns {string}
 */
export function renderIntegrity(report) {
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
  /** @param {string} title @param {string[]} items */
  const section = (title, items) => {
    if (items.length) lines.push(`### ${title} (${items.length})`, '', ...items, '');
  };
  section(
    'Deleted test files',
    report.deleted.map((/** @type {any} */ d) => `- ${code(d.path)}${deletedSuffix(d)}`),
  );
  section('Renamed test files', report.renamed.map((/** @type {any} */ r) => `- ${code(r.from)} → ${code(r.to)}`));
  if (report.markers.length) {
    // A text fence, so backticks in the marked line cannot break the markdown.
    const marked = report.markers.map((/** @type {any} */ m) => clean(`${m.path}:${m.line}: ${m.text.length > 160 ? `${m.text.slice(0, 160)}…` : m.text}`).replace(/```/g, "'''"));
    lines.push(`### Skip/focus markers added (${report.markers.length})`, '', '```text', ...marked, '```', '');
  }
  if (c.delta < 0) section('Test count dropped', c.files.filter((/** @type {any} */ f) => f.after < f.before).map((/** @type {any} */ f) => `- ${code(f.path)}: ${f.before} → ${f.after}`));
  section('Test, build or CI config edits', report.configEdits.map((/** @type {any} */ e) => `- ${code(e.path)}: ${clean(e.detail)}`));
  return lines.join('\n');
}

/**
 * The compact `integrity` key of verify's JSON: each list capped, `more` counts what was dropped.
 * @param {any} report
 */
export function compactIntegrity(report) {
  if (report.error) return { mode: report.mode, ok: report.ok, error: report.error };
  let more = 0;
  /** @param {string[]} xs */
  const cap = (xs) => {
    more += Math.max(0, xs.length - JSON_LIST_LIMIT);
    return xs.slice(0, JSON_LIST_LIMIT);
  };
  return {
    mode: report.mode,
    ok: report.ok,
    base: report.base,
    findings: report.findings,
    blocking: report.blocking,
    deletedTests: cap(report.deleted.map((/** @type {any} */ d) => `${d.path}${d.to ? ` -> ${d.to}` : d.why ? ` (${d.why})` : ''}${d.inSpec ? ' (in spec)' : ''}`)),
    renamedTests: cap(report.renamed.map((/** @type {any} */ r) => `${r.from} -> ${r.to}`)),
    skipMarkers: cap(report.markers.map((/** @type {any} */ m) => `${m.path}:${m.line}`)),
    testCount: { before: report.count.before, after: report.count.after, delta: report.count.delta },
    configEdits: cap(report.configEdits.map((/** @type {any} */ e) => e.path)),
    more,
  };
}

/** One line per blocking finding, for verify's `failure.tail`. @param {any} report */
export function blockingLines(report) {
  if (report.error) return report.error;
  return [
    ...report.deleted.filter((/** @type {any} */ d) => !d.inSpec).map((/** @type {any} */ d) => clean(`deleted ${d.path}${d.to ? ` (${d.why}: ${d.to})` : d.why ? ` (${d.why})` : ''}`)),
    ...report.markers.map((/** @type {any} */ m) => clean(`skip marker ${m.path}:${m.line}`)),
  ].join('\n');
}
