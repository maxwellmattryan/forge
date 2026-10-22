// lib/ keeps its import layering: no runtime import cycle, and only lib/commands/ and lib/cli.ts reach
// the CLI layer. No public function exposes the module graph, so this reads the import declarations of
// lib/ sources (docs/TESTING.md › Allowed source-text tests, entry 10).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const LIB = path.resolve(import.meta.dirname, '..', 'lib');

interface Edge { target: string; typeOnly: boolean; dynamic: boolean }

/** The lib/ files `file` (a path relative to lib/) imports, as Node loads them. */
function importsOf(file: string, text: string): Edge[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];
  const add = (spec: string, typeOnly: boolean, dynamic: boolean): void => {
    if (!spec.startsWith('.')) return;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (target.startsWith('../') || target === '..') return;
    edges.push({ target, typeOnly, dynamic });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node.importClause?.isTypeOnly ?? false, false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node.isTypeOnly, false);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) add(arg.text, false, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

/** Strongly connected components of more than one node, plus self-loops; each one sorted. */
function cycles(graph: Map<string, string[]>): string[][] {
  // Tarjan's algorithm, iterative so a deep graph can't overflow the stack.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let next = 0;
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const work: [string, number][] = [[start, 0]];
    index.set(start, next); low.set(start, next); next++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const [node, i] = frame;
      const out = graph.get(node) ?? [];
      if (i < out.length) {
        frame[1]++;
        const to = out[i]!;
        if (!index.has(to)) {
          index.set(to, next); low.set(to, next); next++;
          stack.push(to); onStack.add(to);
          work.push([to, 0]);
        } else if (onStack.has(to)) {
          low.set(node, Math.min(low.get(node)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]![0];
        low.set(parent, Math.min(low.get(parent)!, low.get(node)!));
      }
      if (low.get(node) !== index.get(node)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || out.includes(node)) found.push(component.sort());
    }
  }
  return found;
}

let scanned: Map<string, Edge[]> | undefined;
function libEdges(): Map<string, Edge[]> {
  if (scanned) return scanned;
  const files = (fs.readdirSync(LIB, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => /\.(ts|mjs)$/.test(f))
    .sort();
  scanned = new Map(files.map((f) => [f, importsOf(f, fs.readFileSync(path.join(LIB, f), 'utf8'))]));
  return scanned;
}

test('lib/ has no runtime import cycles', () => {
  const graph = new Map([...libEdges()].map(([file, edges]) => [file, edges.filter((e) => !e.typeOnly).map((e) => e.target)]));
  const found = cycles(graph);
  assert.deepEqual(found, [], `import cycles in lib/:\n${found.map((c) => c.join(' → ')).join('\n')}`);
});

test('only commands/ and cli.ts import lib/commands/', () => {
  const cli = (f: string): boolean => f === 'cli.ts' || f.startsWith('commands/');
  const bad = [...libEdges()].flatMap(([file, edges]) =>
    cli(file) ? [] : edges.filter((e) => e.target.startsWith('commands/')).map((e) => `${file} → ${e.target}`));
  assert.deepEqual(bad, []);
});

test('the import scan reads what Node loads and finds a planted cycle', () => {
  const fixture = [
    "import x from './default.ts';",
    "import { a, type B } from './mixed.ts';",
    "import { type A } from './inline-type.ts';",
    "export * from './star.ts';",
    "export { a } from './named.ts';",
    "import './side.ts';",
    "const lazy = () => import('./lazy.ts');",
    "import type { T } from './type-only.ts';",
    "export type { U } from './type-export.ts';",
    "import fs from 'node:fs';",
    "import ts from 'typescript';",
    "import up from '../../outside.ts';",
  ].join('\n');
  const edges = importsOf('sub/file.ts', fixture);
  assert.deepEqual(edges.filter((e) => !e.typeOnly).map((e) => e.target), [
    'sub/default.ts', 'sub/mixed.ts', 'sub/inline-type.ts', 'sub/star.ts', 'sub/named.ts', 'sub/side.ts', 'sub/lazy.ts',
  ]);
  assert.deepEqual(edges.filter((e) => e.typeOnly).map((e) => e.target), ['sub/type-only.ts', 'sub/type-export.ts']);
  assert.deepEqual(edges.filter((e) => e.dynamic).map((e) => e.target), ['sub/lazy.ts']);
  assert.deepEqual(importsOf('file.ts', "import y from '../lib-sibling.ts';"), [], 'targets outside lib/ are dropped');

  assert.deepEqual(cycles(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']], ['d.ts', ['a.ts']]])), [['a.ts', 'b.ts', 'c.ts']]);
  assert.deepEqual(cycles(new Map([['self.ts', ['self.ts']], ['other.ts', []]])), [['self.ts']]);
  assert.deepEqual(cycles(new Map([['a.ts', ['b.ts', 'c.ts']], ['b.ts', ['c.ts']], ['c.ts', []]])), []);
});
