// Two hole families the security lens kept raising stay closed (docs/TESTING.md › Allowed source-text
// tests, entry 16). Every regex literal in a lib/ source (not *.test.ts) compiles and stays linear on
// hostile 10k-character lines, with no allowlist. No public function exposes which regex literals or git
// argv a source holds, so this reads lib/ sources with the typescript parser. A tripwire for careless or
// steered builder code, not a security boundary: what it can't see is listed in the spec of job 300.
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

const parse = (file: string, text: string): ts.SourceFile => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
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
