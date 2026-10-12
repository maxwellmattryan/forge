// @ts-check
// Verify's test-integrity report: what the committed diff did to the tests and to the config that
// runs them. A build can go green by deleting a test, adding `.skip`, or editing the test script;
// this makes those changes visible to reviewers and, under `verifyIntegrity: block`, fails verify.
// Must not import evals.mjs or worktree.mjs: worktree imports this module, and evals imports worktree.
import fs from 'node:fs';
import path from 'node:path';
import { jobDir } from './jobs.mjs';
import { exists } from './paths.mjs';
import { approachPaths, resolveBase } from './scope.mjs';
import { ForgeError, run } from './util.mjs';

export const DEFAULT_TEST_PATTERN = '(^|/)(tests?|__tests__|spec|specs)/|[._-](test|spec)s?\\.[A-Za-z0-9]+$|_test\\.(go|py|rs)$|(^|/)test_[^/]+\\.py$';

const JSON_LIST_LIMIT = 10;

const TEST_FILE_MARKERS = [
  /\b(describe|it|test|context|suite|t)\.(skip|only|todo)\b/,
  /\b(xit|xdescribe|xtest|xcontext|fit|fdescribe)\s*\(/,
  /[{,]\s*(skip|only|todo)\s*:\s*(true|['"`])/,
  /\bt\.Skip(Now|f)?\s*\(/,
  /@(Disabled|Ignore)\b/,
];
// These spell a skip in any file: Rust tests live in `src/`, and pytest markers are unambiguous.
const ANY_FILE_MARKERS = [/#\[ignore\b/, /@pytest\.mark\.(skip|skipif|xfail)\b/, /\bpytest\.skip\s*\(/, /@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b/];

const TEST_DECLS = [/^\s*(?:it|test|t\.test|xit|fit)(?:\.\w+)*\s*\(/gm, /^\s*(?:async\s+)?def\s+test\w*\s*\(/gm, /^\s*#\[(?:\w+::)*test\]/gm, /^func\s+Test\w*\s*\(/gm];

const INTERPRETERS = new Set(['node', 'bash', 'sh', 'zsh', 'python', 'python3', 'ruby', 'deno', 'bun', 'tsx', 'ts-node', 'perl']);

/**
 * Whether one added or removed line (without its `+`/`-`) is a skip or focus marker.
 * @param {string} _path @param {string} line @param {boolean} isTest
 */
export function markerHits(_path, line, isTest) {
  if (ANY_FILE_MARKERS.some((re) => re.test(line))) return true;
  return isTest && TEST_FILE_MARKERS.some((re) => re.test(line));
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
  return base === 'pytest.ini' || base === 'tox.ini';
}

/**
 * `git diff --name-status -z` entries. `from` is null for an added file, `to` for a deleted one.
 * @param {string} raw @returns {{status:string, from:string|null, to:string|null}[]}
 */
function parseNameStatus(raw) {
  const tok = raw.split('\0');
  const out = [];
  for (let i = 0; i < tok.length && tok[i]; ) {
    const status = tok[i][0];
    if (status === 'R' || status === 'C') {
      out.push({ status, from: status === 'R' ? tok[i + 1] : null, to: tok[i + 2] });
      i += 3;
    } else {
      out.push({ status, from: status === 'A' ? null : tok[i + 1], to: status === 'D' ? null : tok[i + 1] });
      i += 2;
    }
  }
  return out;
}

/** A `---`/`+++` header path: git appends a tab after names with spaces and C-quotes odd ones. @param {string} p */
function unquote(p) {
  p = p.replace(/\t$/, '');
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p);
  } catch {
    return p.slice(1, -1);
  }
}

/**
 * Added and removed lines per file from a `-U0` diff. Hunk line counts are honoured, so an added
 * line that itself reads `++ b/x` cannot be mistaken for a file header.
 * @param {string} raw
 * @returns {Map<string, {added:{line:number, text:string}[], removed:string[]}>}
 */
function parseDiffLines(raw) {
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
    const { baseRef, mergeBase } = resolveBase(cwd, config, job);
    report.base = baseRef;
    report.mergeBase = mergeBase;
    report.head = run('git', ['rev-parse', 'HEAD'], { cwd }).stdout.trim();
    /** @type {RegExp} */
    let testRe;
    try {
      testRe = new RegExp(config.evals?.testPattern ?? DEFAULT_TEST_PATTERN);
    } catch (e) {
      throw new ForgeError(`invalid evals.testPattern: ${/** @type {Error} */ (e).message}`);
    }
    // Pin prefixes and disable drivers so user git config cannot change what gets parsed.
    const diffArgs = ['-c', 'core.quotepath=off', 'diff', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M'];
    const changes = parseNameStatus(run('git', [...diffArgs, '--name-status', '-z', mergeBase, 'HEAD'], { cwd }).stdout);
    const lines = parseDiffLines(run('git', [...diffArgs, '--no-color', '-U0', mergeBase, 'HEAD'], { cwd }).stdout);
    /** @param {string} rev @param {string | null} p @returns {string | null} */
    const show = (rev, p) => {
      if (!p) return null;
      const r = run('git', ['cat-file', 'blob', `${rev}:${p}`], { cwd, allowFail: true });
      return r.ok && !r.stdout.includes('\0') ? r.stdout : null;
    };
    const isTest = (/** @type {string | null} */ p) => Boolean(p && testRe.test(p));

    const specFile = path.join(jobDir(root, job.id), 'spec.md');
    const sanctioned = new Set(exists(specFile) ? approachPaths(fs.readFileSync(specFile, 'utf8')) : []);
    const sources = new Set(commandSources(config));

    for (const c of changes) {
      if (c.from && isTest(c.from)) {
        if (c.status === 'D') report.deleted.push({ path: c.from, inSpec: sanctioned.has(c.from) });
        else if (c.status === 'R' && !isTest(c.to)) report.deleted.push({ path: c.from, to: c.to, inSpec: false });
        else if (c.status === 'R') report.renamed.push({ from: c.from, to: c.to });
      }
      if (isTest(c.from) || isTest(c.to)) {
        const before = isTest(c.from) ? countTestDecls(show(mergeBase, c.from) ?? '') : 0;
        const after = isTest(c.to) ? countTestDecls(show('HEAD', c.to) ?? '') : 0;
        report.count.before += before;
        report.count.after += after;
        if (before !== after) report.count.files.push({ path: c.to ?? c.from, before, after });
      }
      const edit = configEdit(c, sources, show, mergeBase);
      if (edit) report.configEdits.push(edit);
    }
    report.count.delta = report.count.after - report.count.before;

    for (const [file, { added, removed }] of lines) {
      const t = isTest(file);
      const hits = added.filter((a) => markerHits(file, a.text, t));
      if (hits.length > removed.filter((r) => markerHits(file, r, t)).length) {
        for (const h of hits) report.markers.push({ path: file, line: h.line, text: h.text.trim() });
      }
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

/** @param {string} p */
const code = (p) => (p.includes('`') ? `\`\` ${p} \`\`` : `\`${p}\``);

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
    lines.push(`The report could not be computed${report.mode === 'block' ? ', which fails verify under `block`' : ''}:`, '', '```text', report.error, '```', '');
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
    report.deleted.map((/** @type {any} */ d) => `- ${code(d.path)}${d.to ? ` → ${code(d.to)} (renamed out of the test pattern)` : ''}${d.inSpec ? ' (named in spec)' : ''}`),
  );
  section('Renamed test files', report.renamed.map((/** @type {any} */ r) => `- ${code(r.from)} → ${code(r.to)}`));
  if (report.markers.length) {
    // A text fence, so backticks in the marked line cannot break the markdown.
    const marked = report.markers.map((/** @type {any} */ m) => `${m.path}:${m.line}: ${m.text.length > 160 ? `${m.text.slice(0, 160)}…` : m.text}`.replace(/```/g, "'''"));
    lines.push(`### Skip/focus markers added (${report.markers.length})`, '', '```text', ...marked, '```', '');
  }
  if (c.delta < 0) section('Test count dropped', c.files.map((/** @type {any} */ f) => `- ${code(f.path)}: ${f.before} → ${f.after}`));
  section('Test, build or CI config edits', report.configEdits.map((/** @type {any} */ e) => `- ${code(e.path)}: ${e.detail}`));
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
    deletedTests: cap(report.deleted.map((/** @type {any} */ d) => `${d.path}${d.to ? ` -> ${d.to}` : ''}${d.inSpec ? ' (in spec)' : ''}`)),
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
    ...report.deleted.filter((/** @type {any} */ d) => !d.inSpec).map((/** @type {any} */ d) => `deleted ${d.path}${d.to ? ` (renamed to ${d.to}, outside the test pattern)` : ''}`),
    ...report.markers.map((/** @type {any} */ m) => `skip marker ${m.path}:${m.line}`),
  ].join('\n');
}
