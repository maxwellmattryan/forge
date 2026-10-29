// Two hole families the security lens kept raising stay closed (docs/TESTING.md › Allowed source-text
// tests, entry 16). Every regex literal in a lib/ source (not *.test.ts) compiles and stays linear on
// hostile 10k-character lines, with no allowlist. Only lib/integrations/git/runner.ts starts git, so its
// config pins can't be skipped, and a runner call that parses diff, log, show or status output spreads
// PINNED_DIFF_OPTS or STATUS_ARGV unless GIT_ALLOWED pins its file's count with a reviewed reason. No
// public function exposes which regex literals or git argv a source holds, so this reads lib/ sources
// with the typescript parser. It is a tripwire, not a security boundary: argv built in a variable, a
// local wrapper under another name and git started through a variable command name stay the panel's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const LIB = path.resolve(import.meta.dirname, '..', '..', 'lib');

/** Lib-relative path (`engine/pr/merge.ts`) → text, for every lib/ source that is not a test. */
function libSources(): Map<string, string> {
  const files = (fs.readdirSync(LIB, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
  return new Map(files.map((f) => [f, fs.readFileSync(path.join(LIB, f), 'utf8')]));
}

/** Parsed once per text: the regex and git checks read the same tree. */
const PARSED = new Map<string, ts.SourceFile>();
function parse(file: string, text: string): ts.SourceFile {
  let sf = PARSED.get(text);
  if (!sf) PARSED.set(text, (sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)));
  return sf;
}
const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function visit(sf: ts.SourceFile, fn: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    fn(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

// ---- Regexes stay linear --------------------------------------------------------------------------

/**
 * Every prefix × run × tail: 32 lines of 10,000 repeated characters. `# a` + `#`… + `\n!` is what
 * drives the old approach heading regex into minutes of backtracking; without that prefix it finishes
 * in under 1 ms, so keep every prefix.
 */
const HOSTILE: string[] = ['', 'a', '# a', '- '].flatMap((prefix) =>
  [' ', '\t', '#', 'a'].flatMap((run) => ['\n!', '\u0000'].map((tail) => prefix + run.repeat(10_000) + tail)),
);
/** Wall time for one regex over all of HOSTILE; a linear one takes under 5 ms on a laptop. */
const REGEX_BUDGET_MS = 100;
/** Node's vm timeout interrupts irregexp, so a catastrophic regex stops here instead of hanging. */
const HARD_LIMIT_MS = 1000;

const SANDBOX = vm.createContext({});
const RUN = new vm.Script('for (const s of inputs) { re.lastIndex = 0; re.exec(s); }');

/** Milliseconds `re` takes over HOSTILE, or null when the hard limit stopped it. */
function timeRegex(re: RegExp): number | null {
  SANDBOX.re = re;
  SANDBOX.inputs = HOSTILE;
  const start = performance.now();
  try {
    RUN.runInContext(SANDBOX, { timeout: HARD_LIMIT_MS });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
    throw err;
  }
  return performance.now() - start;
}

/** The regex literals in one source that don't compile or are slow on HOSTILE. */
function regexProblems(file: string, text: string): string[] {
  const sf = parse(file, text);
  const problems: string[] = [];
  visit(sf, (node) => {
    if (node.kind !== ts.SyntaxKind.RegularExpressionLiteral) return;
    const literal = (node as ts.RegularExpressionLiteral).text;
    const slash = literal.lastIndexOf('/');
    const source = literal.slice(1, slash);
    const flags = literal.slice(slash + 1);
    const at = `${file}:${lineOf(sf, node)} /${source}/${flags}`;
    let re: RegExp;
    try {
      re = new RegExp(source, flags);
    } catch (err) {
      problems.push(`${at}: does not compile: ${(err as Error).message}`);
      return;
    }
    // One re-run absorbs a GC pause or a loaded CI runner; a hard-limit stop is never retried.
    let ms = timeRegex(re);
    if (ms !== null && ms > REGEX_BUDGET_MS) ms = timeRegex(re);
    if (ms === null) problems.push(`${at}: stopped after ${HARD_LIMIT_MS} ms`);
    else if (ms > REGEX_BUDGET_MS) problems.push(`${at}: took ${Math.round(ms)} ms (budget ${REGEX_BUDGET_MS} ms)`);
  });
  return problems;
}

test('every lib regex is linear on hostile input', () => {
  const sources = libSources();
  assert.ok(sources.size > 100, `found only ${sources.size} lib sources`);
  const problems = [...sources].flatMap(([file, text]) => regexProblems(file, text));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the regex check flags a backtracking regex and a broken one', () => {
  assert.equal(HOSTILE.length, 32);
  const [old] = regexProblems('engine/pipeline/acs.ts', 'const HEADING = /^(#{1,6})\\s+(.*?)\\s*#*\\s*$/;\n');
  assert.equal(old, 'engine/pipeline/acs.ts:1 /^(#{1,6})\\s+(.*?)\\s*#*\\s*$/: stopped after 1000 ms');
  const broken = regexProblems('x.ts', 'export const a = 1;\nconst bad = /(/;\n');
  assert.equal(broken.length, 1);
  assert.match(broken[0], /^x\.ts:2 \/\(\/: does not compile: /);
  assert.deepEqual(regexProblems('engine/pipeline/acs.ts', 'export const HEADING = /^(#{1,6})\\s+(.*)$/;\n'), []);
});

// ---- Git starts only in the runner, and parsed output is pinned -----------------------------------

const RUNNER = 'integrations/git/runner.ts';
/** Calls that start a process: core/os/process.ts `run` and node:child_process. */
const STARTERS = new Set(['run', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']);
/** The starters that take a whole shell command line. */
const SHELL_STARTERS = new Set(['exec', 'execSync']);
/** What the runner exports that starts git. */
const RUNNER_CALLS = new Set(['git', 'gitSpawnSync']);
/** Subcommands whose output callers parse, and which config can reshape. */
const PARSING = new Set(['diff', 'show', 'log', 'diff-tree', 'status']);
/** The spreads that pin a parsing call: integrity.ts's diff options and runner.ts's status argv. */
const PINS = new Set(['PINNED_DIFF_OPTS', 'STATUS_ARGV']);

const literal = (node: ts.Node | undefined): string | null =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
const isName = (node: ts.Node, names: Set<string>): boolean => ts.isIdentifier(node) && names.has(node.text);

/** `f` in `f(…)`, `x.f(…)` and `x['f'](…)`. */
function calleeName(call: ts.CallExpression): string | null {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  if (ts.isElementAccessExpression(c)) return literal(c.argumentExpression);
  return null;
}

/** Rule A: calls outside the runner that start git themselves, so they skip its config pins. */
function gitStartProblems(file: string, text: string): string[] {
  if (file === RUNNER) return [];
  const sf = parse(file, text);
  const problems: string[] = [];
  visit(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node);
    if (name === null || !STARTERS.has(name)) return;
    const first = literal(node.arguments[0]);
    if (first === 'git' || (first !== null && SHELL_STARTERS.has(name) && /^git\s/.test(first)))
      problems.push(`${file}:${lineOf(sf, node)}: starts git outside lib/${RUNNER}; call git() or gitSpawnSync()`);
  });
  return problems;
}

/** The names a file calls the runner by: the usual local names, plus whatever it imports git under. */
function runnerNames(sf: ts.SourceFile): { calls: Set<string>; namespaces: Set<string> } {
  const calls = new Set(['git', 'runGit', 'gitSpawnSync']);
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.endsWith('git/runner.ts')) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) if (RUNNER_CALLS.has((el.propertyName ?? el.name).text)) calls.add(el.name.text);
  }
  return { calls, namespaces };
}

/** The subcommand: the first literal past global options (`-c k=v` and `-C dir` take a value), or null when a computed value comes first. */
function subcommand(args: readonly ts.Expression[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const e = args[i];
    if (ts.isSpreadElement(e)) {
      if (ts.isIdentifier(e.expression) && e.expression.text === 'STATUS_ARGV') return 'status';
      continue;
    }
    const lit = literal(e);
    if (lit === null) return null;
    if (lit === '-c' || lit === '-C') i++;
    else if (!lit.startsWith('-')) return lit;
  }
  return null;
}

interface Site { file: string; sub: string; line: number }

/** Rule B: runner calls with a literal subcommand that parse output and spread no pin. */
function gitParseSites(file: string, text: string): Site[] {
  const sf = parse(file, text);
  const names = runnerNames(sf);
  const sites: Site[] = [];
  visit(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const c = node.expression;
    const runner = ts.isIdentifier(c)
      ? names.calls.has(c.text)
      : ts.isPropertyAccessExpression(c) && isName(c.expression, names.namespaces) && RUNNER_CALLS.has(c.name.text);
    if (!runner) return;
    // The argv array, or the arguments themselves for a variadic local wrapper (`git('status', …)`).
    const args = node.arguments.find(ts.isArrayLiteralExpression)?.elements ?? node.arguments;
    const sub = subcommand(args);
    if (sub === null) return;
    if (args.some((e) => ts.isSpreadElement(e) && isName(e.expression, PINS))) return;
    const flags = args.map((e) => literal(e) ?? (ts.isTemplateExpression(e) ? e.head.text : '')).filter(Boolean);
    const parses =
      PARSING.has(sub) ||
      (sub === 'ls-files' && !flags.includes('-z')) ||
      (sub === 'rev-list' && flags.some((f) => f.startsWith('--format') || f.startsWith('--pretty')));
    if (parses) sites.push({ file, sub, line: lineOf(sf, node) });
  });
  return sites;
}

interface Allowed { sites: number; reason: string }

/** Unpinned sites off the list, counts that grew, shrank or went stale, and reasons that aren't one line. */
function allowProblems(sites: Site[], allowed: Record<string, Allowed>): string[] {
  const byKey = new Map<string, Site[]>();
  for (const s of sites) byKey.set(`${s.file} ${s.sub}`, [...(byKey.get(`${s.file} ${s.sub}`) ?? []), s]);
  const problems: string[] = [];
  for (const [key, found] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = allowed[key];
    if (!entry) {
      for (const s of found)
        problems.push(`${s.file}:${s.line}: git ${s.sub} parses output without ...PINNED_DIFF_OPTS or ...STATUS_ARGV: spread one, or add '${key}' to GIT_ALLOWED with a reason`);
    } else if (found.length > entry.sites) {
      problems.push(`${key}: ${found.length} unpinned sites, over its count of ${entry.sites}: pin the new one, or raise the count and say why`);
    } else if (found.length < entry.sites) {
      problems.push(`${key}: ${found.length} unpinned sites, under its count of ${entry.sites}: lower it`);
    }
  }
  for (const [key, entry] of Object.entries(allowed).sort(([a], [b]) => a.localeCompare(b))) {
    if (!byKey.has(key)) problems.push(`${key}: listed but no unpinned site found: drop it`);
    if (!entry.reason.trim() || /[\r\n]/.test(entry.reason)) problems.push(`${key}: give it a one-line reason`);
  }
  return problems;
}

/**
 * Reviewed unpinned sites: `<lib-relative file> <subcommand>` → how many, and why config can't reshape
 * what the site reads in a way that matters (or that pinning it is follow-up work). A new site spreads a
 * pin; raising a count is the security lens's call.
 */
const GIT_ALLOWED: Record<string, Allowed> = {
  'cli/commands/git.ts diff': { sites: 1, reason: '`diff --cached --quiet`: reads the exit code only, never the output' },
  'cli/commands/git.ts diff-tree': { sites: 1, reason: '`diff-tree --name-only` of the commit just made: names for the JSON reply only; GIT_PINS sets quotepath off' },
  'engine/evals/outcome.ts diff': { sites: 1, reason: '`--name-only -z --no-renames --no-ext-diff` of a checked sha: paths only; GIT_PINS sets quotepath off and diff.relative=false' },
  'engine/evals/outcome.ts log': { sites: 2, reason: '`--format=%H` kept only where isSha passes, and `--numstat -z` churn for an eval metric; log.showSignature is unpinned: follow-up' },
  'engine/evals/run.ts diff': { sites: 3, reason: 'two `--name-only -z --no-ext-diff` path lists in the eval clone; the merged PR patch read in the main checkout lacks --no-ext-diff and --no-textconv: follow-up' },
  'engine/guard/protected.ts diff': { sites: 2, reason: '`RAW_OPTS`/`PATCH_OPTS` carry the same flags as `PINNED_DIFF_OPTS` without `-M`; GIT_PINS sets diff.interHunkContext=0' },
  'engine/guard/secrets.ts log': { sites: 1, reason: 'the message scan pins its own: LOG_PINS sets the output encoding, `--no-show-signature`, and a rev-list count fails it closed' },
  'engine/metrics/budget.ts diff': { sites: 1, reason: '`--numstat` line counts for a budget metric, never a guard; rename or textconv config can skew a count: follow-up' },
  'engine/ops/detect.ts ls-files': { sites: 1, reason: "init's suggestions only: ignored AGENTS.md/CLAUDE.md by name; GIT_PINS sets quotepath off, so a newline in a name only drops it" },
  'engine/ops/update.ts status': { sites: 1, reason: "`forge update`'s clean check of the Forge clone, emptiness only; status.showUntrackedFiles there is the user's own config" },
  'engine/pipeline/scope.ts diff': { sites: 3, reason: 'two `--name-only -z --no-renames` path lists, and the round diff with DIFF_PINS (the PINNED_DIFF_OPTS flags with `--no-renames` and per-repo prefixes)' },
  'engine/pr/branch.ts diff': { sites: 2, reason: '`--name-only -z` unmerged and staged path lists: paths only, verbatim' },
  'engine/pr/branch.ts status': { sites: 2, reason: 'emptiness checks before a pull or rebase; worktree config can hide untracked files there (git still refuses to overwrite them): STATUS_ARGV is follow-up' },
  'engine/pr/delta.ts log': { sites: 1, reason: '`--numstat -z --no-renames --format=` line counts for the PR size; signature or textconv config can skew a count: follow-up' },
  'engine/pr/merge.ts log': { sites: 1, reason: '`log -1 --format=%ct` of a checked sha under historyEnv(): one timestamp, and any extra line makes it NaN, read as null' },
  'engine/project/member-repos.ts status': { sites: 1, reason: "STATUS_ARGV's flags written inline, for a doctor warning's path count" },
  'engine/release/run.ts status': { sites: 1, reason: 'the release clean check pins untracked files but not `--ignore-submodules=none`: STATUS_ARGV is follow-up' },
  'engine/verify/e2e.ts diff': { sites: 1, reason: '`--name-only --no-renames` matched against UI globs to pick whether e2e runs; without -z a name with a newline misses: follow-up' },
  'engine/workspace/regenerate.ts status': { sites: 1, reason: '`--porcelain -z --untracked-files=all`: porcelain v1 is a fixed format and -z paths are verbatim' },
  'engine/workspace/related-tests.ts diff': { sites: 1, reason: '`--name-only -z --no-renames --no-relative --no-ext-diff` path list under historyEnv()' },
  'engine/workspace/worktree.ts ls-files': { sites: 2, reason: "the main checkout's ignored files matched against copy globs; GIT_PINS sets quotepath off, so a newline in a name only misses a copy" },
  'engine/workspace/worktree.ts status': { sites: 2, reason: 'emptiness checks: one pins submodules and skips untracked on purpose; the eval-checkout removal guard takes worktree config as is: follow-up' },
  'office/session/confine.ts status': { sites: 1, reason: '`--porcelain=v1 -z` with untracked files and submodules pinned, hashed into a digest and never parsed further' },
};

test('git starts only in the runner', () => {
  const problems = [...libSources()].flatMap(([file, text]) => gitStartProblems(file, text));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('git output parsing is pinned or reviewed', () => {
  const sites = [...libSources()].flatMap(([file, text]) => gitParseSites(file, text));
  assert.ok(sites.length > 0, 'found no unpinned sites: the scan stopped seeing runner calls');
  const problems = allowProblems(sites, GIT_ALLOWED);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the git check flags what it should', () => {
  const unpinned = (line: number, sub: string) =>
    `x.ts:${line}: git ${sub} parses output without ...PINNED_DIFF_OPTS or ...STATUS_ARGV: spread one, or add 'x.ts ${sub}' to GIT_ALLOWED with a reason`;
  const starts = (line: number) => `x.ts:${line}: starts git outside lib/integrations/git/runner.ts; call git() or gitSpawnSync()`;
  const imp = (names: string) => `import { ${names} } from '#integrations/git/runner.ts';\n`;
  const two = "git(cwd, ['diff']);\ngit(cwd, ['diff', '--stat']);";
  const listed = (sites: number, reason = 'reviewed') => ({ 'x.ts diff': { sites, reason } });
  const rows: [string, string, Record<string, Allowed>, string[]][] = [
    ['unpinned diff', "git(cwd, ['diff', '--name-only', base, '--']);", {}, [unpinned(1, 'diff')]],
    ['spawnSync', "spawnSync('git', ['diff']);", {}, [starts(1)]],
    ['execFileSync as a property', "cp.execFileSync('git', ['log']);", {}, [starts(1)]],
    ['execSync command line', "execSync('git diff HEAD');", {}, [starts(1)]],
    ['run with a template literal', 'run(`git`, args);', {}, [starts(1)]],
    ['aliased import', `${imp('git as g')}g(cwd, ['show', sha]);`, {}, [unpinned(2, 'show')]],
    ['aliased gitSpawnSync', `${imp('gitSpawnSync as spawnGit')}spawnGit(cwd, ['diff-tree', '-r', sha]);`, {}, [unpinned(2, 'diff-tree')]],
    ['namespace import', "import * as runner from '#integrations/git/runner.ts';\nrunner.git(cwd, ['log']);", {}, [unpinned(2, 'log')]],
    ['-c and --literal-pathspecs first', "git(cwd, ['-c', 'a=b', '--literal-pathspecs', 'diff']);", {}, [unpinned(1, 'diff')]],
    ['-C dir first', "git(cwd, ['-C', dir, 'log', '--format=%H']);", {}, [unpinned(1, 'log')]],
    ['variadic local wrapper', "git('status', '--porcelain');", {}, [unpinned(1, 'status')]],
    ['ls-files without -z', "runGit(root, ['ls-files', '--others']);", {}, [unpinned(1, 'ls-files')]],
    ['rev-list --format', "git(cwd, ['rev-list', '--format=%s', range]);", {}, [unpinned(1, 'rev-list')]],
    ['count too high', two, listed(1), ['x.ts diff: 2 unpinned sites, over its count of 1: pin the new one, or raise the count and say why']],
    ['count too low', two, listed(3), ['x.ts diff: 2 unpinned sites, under its count of 3: lower it']],
    ['stale entry', "git(cwd, ['fetch']);", listed(1), ['x.ts diff: listed but no unpinned site found: drop it']],
    ['empty reason', "git(cwd, ['diff']);", listed(1, ' '), ['x.ts diff: give it a one-line reason']],
    ['two-line reason', "git(cwd, ['diff']);", listed(1, 'a\nb'), ['x.ts diff: give it a one-line reason']],
    ['count matches', two, listed(2), []],
    ['PINNED_DIFF_OPTS', "git(cwd, ['diff', ...PINNED_DIFF_OPTS, a, b, '--']);", {}, []],
    ['STATUS_ARGV', 'git(cwd, [...STATUS_ARGV]);', {}, []],
    ['ls-files -z', "git(cwd, ['ls-files', '-z', '--others']);", {}, []],
    ['rev-list --count', "git(cwd, ['rev-list', '--count', range]);", {}, []],
    ['fetch', "git(cwd, ['fetch', remote]);", {}, []],
    ['gh', "run('gh', ['pr', 'diff']);", {}, []],
    ['computed argv', "git(cwd, args);\ngit(cwd, [sub, 'x']);", {}, []],
  ];
  for (const [name, src, allowed, want] of rows) {
    const got = [...gitStartProblems('x.ts', src), ...allowProblems(gitParseSites('x.ts', src), allowed)];
    assert.deepEqual(got, want, name);
  }
  assert.deepEqual(gitStartProblems(RUNNER, "spawnSync('git', argv);"), [], 'the runner itself starts git');
});
