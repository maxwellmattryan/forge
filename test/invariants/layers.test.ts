// lib/ keeps its layers: every file has one lib layer, imports point down the order in
// test/invariants/layer-map.ts (docs/design/lib-layout.md) except the shrinking ALLOWED_EDGES, `api`
// imports nothing outside `api`, no runtime import cycle exists, and only the CLI reaches
// lib/cli/commands/, and imports across layers (from lib/, test/ and dashboard/src/) go through the
// package.json "imports" aliases. No public function exposes the module graph, so this reads the import
// declarations of lib/, test/ and dashboard/src/ sources, package.json "imports" and the tsconfigs' `paths`
// (docs/TESTING.md › Allowed source-text tests, entry 10). A test beside its module (lib/**/<name>.test.ts)
// is no part of the graph: it keeps its folder's layer direction and reaches outside lib/ only for test/helpers.ts.
// Runtime code (lib/ and bin/) never imports dashboard sources, which only Vite builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ALLOWED_EDGES, FLAT_LAYERS, LAYERS, UNALIASED } from './layer-map.ts';
import type { Layer } from './layer-map.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LIB = path.join(ROOT, 'lib');
const readJson = (file: string): any => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

interface Edge { target: string; typeOnly: boolean; dynamic: boolean }
interface Spec { spec: string; typeOnly: boolean; dynamic: boolean }

/** An alias prefix and the lib-relative folder it names: `#core/` → `core/`. */
type Aliases = Map<string, string>;

/** package.json `imports` as a prefix table; only `#<name>/*` → `./lib/<folder>/*` entries count. */
function aliasesFrom(pkg: { imports?: Record<string, unknown> }): Aliases {
  const table: Aliases = new Map();
  for (const [key, target] of Object.entries(pkg.imports ?? {})) {
    const from = /^(#[\w-]+\/)\*$/.exec(key)?.[1];
    const to = typeof target === 'string' ? /^\.\/lib\/([\w-]+\/)\*$/.exec(target)?.[1] : undefined;
    if (from && to) table.set(from, to);
  }
  return table;
}
const ALIASES = aliasesFrom(readJson('package.json'));

/** The lib-relative target an aliased specifier names, or null when no alias prefix matches. */
function unalias(spec: string, aliases: Aliases): string | null {
  for (const [prefix, folder] of aliases) {
    if (spec.startsWith(prefix)) return path.posix.normalize(folder + spec.slice(prefix.length));
  }
  return null;
}

/** Every module specifier `text` names, as Node loads them: imports, re-exports, side effects, `import()`. */
function walk(file: string, text: string, add: (spec: string, typeOnly: boolean, dynamic: boolean) => void): void {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
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
}

function specsOf(file: string, text: string): Spec[] {
  const found: Spec[] = [];
  walk(file, text, (spec, typeOnly, dynamic) => found.push({ spec, typeOnly, dynamic }));
  return found;
}

const isExternal = (spec: string): boolean => !spec.startsWith('.') && !spec.startsWith('#');

/** The lib/ files `file` (a path relative to lib/) reaches through `specs`, relative or aliased. */
function edgesFrom(file: string, specs: Spec[], aliases: Aliases): Edge[] {
  const edges: Edge[] = [];
  for (const { spec, typeOnly, dynamic } of specs) {
    // An unknown `#` prefix is left to aliasProblems, which names it.
    const target = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
      : spec.startsWith('#') ? unalias(spec, aliases) : null;
    if (target === null || target.startsWith('../') || target === '..') continue;
    edges.push({ target, typeOnly, dynamic });
  }
  return edges;
}

/** The lib/ files `file` (a path relative to lib/) imports, as Node loads them. */
function importsOf(file: string, text: string, aliases: Aliases = ALIASES): Edge[] {
  return edgesFrom(file, specsOf(file, text), aliases);
}

/** The specifiers `file` imports that are neither relative nor aliases (Node built-ins, packages). */
function externalsOf(file: string, text: string): string[] {
  return specsOf(file, text).filter((s) => isExternal(s.spec)).map((s) => s.spec);
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

type Flat = Record<Layer, string[]>;

const rank = (layer: Layer): number => LAYERS.indexOf(layer);
const pathLayer = (file: string): Layer | null => {
  const first = file.split('/')[0]!;
  return (LAYERS as readonly string[]).includes(first) && file.includes('/') ? first as Layer : null;
};

/** Every layer that claims `file`: its lib/<layer>/ path, then exact flat keys, then the longest folder keys. */
function claims(file: string, flat: Flat): Layer[] {
  const own = pathLayer(file);
  const exact = LAYERS.flatMap((l) => flat[l].filter((k) => k === file).map(() => l));
  const folders = LAYERS.flatMap((l) => flat[l].filter((k) => k.endsWith('/') && file.startsWith(k)).map((k) => ({ l, k })));
  const longest = Math.max(0, ...folders.map((f) => f.k.length));
  const byFolder = exact.length ? [] : folders.filter((f) => f.k.length === longest).map((f) => f.l);
  return [...(own ? [own] : []), ...exact, ...byFolder];
}

/** The layer of a lib-relative path: its first segment when that names a layer, else the flat table. */
function layerOf(file: string, flat: Flat): Layer | null {
  return claims(file, flat)[0] ?? null;
}

/**
 * Everything wrong with lib/'s layering: files with no layer or two, flat keys matching no file, upward
 * edges not on `allowed`, `allowed` entries that are absent or no longer upward, and `api` files that
 * import anything outside lib/. Each message names the file or the edge.
 */
function layerProblems(files: string[], edges: [string, string][], flat: Flat, allowed: string[], externals: [string, string][] = []): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const layers = claims(file, flat);
    if (!layers.length) problems.push(`${file}: no layer (put it under lib/<layer>/ or in FLAT_LAYERS)`);
    else if (layers.length > 1) problems.push(`${file}: listed twice (${layers.join(', ')})`);
  }
  for (const layer of LAYERS) {
    for (const key of flat[layer]) {
      const hit = key.endsWith('/') ? files.some((f) => f.startsWith(key)) : files.includes(key);
      if (!hit) problems.push(`FLAT_LAYERS.${layer} '${key}' matches no file: drop it`);
    }
  }
  const upward = new Set<string>();
  for (const [from, to] of edges) {
    const a = layerOf(from, flat);
    const b = layerOf(to, flat);
    if (a && b && rank(b) > rank(a)) upward.add(`${from} → ${to}`);
  }
  for (const edge of [...upward].sort()) {
    if (!allowed.includes(edge)) problems.push(`${edge}: imports a higher layer`);
  }
  for (const entry of allowed) {
    if (!upward.has(entry)) problems.push(`ALLOWED_EDGES '${entry}' is absent or no longer upward: drop it`);
  }
  for (const [file, spec] of externals) {
    if (layerOf(file, flat) === 'api') problems.push(`${file} → ${spec}: api files import only api files`);
  }
  return problems;
}

/**
 * Specifiers that break the alias rules, as `${file} → ${spec}: …` with `file` repo-relative: a relative
 * import that crosses into an aliased lib/<layer>/ folder, an alias into the importer's own layer, and a
 * `#` prefix that is no alias. Files outside lib/ have no layer, so all their imports into aliased layers
 * cross.
 */
function aliasProblems(pairs: [file: string, spec: string][], aliases: Aliases): string[] {
  const keyOf = new Map([...aliases].map(([prefix, folder]) => [folder, prefix]));
  const known = [...aliases.keys()].join(', ');
  const problems: string[] = [];
  for (const [file, spec] of pairs) {
    const own = file.startsWith('lib/') ? layerOf(file.slice('lib/'.length), FLAT_LAYERS) : null;
    if (spec.startsWith('#')) {
      const target = unalias(spec, aliases);
      if (target === null) problems.push(`${file} → ${spec}: no such alias (the aliases are ${known})`);
      else if (pathLayer(target) === own) problems.push(`${file} → ${spec}: same layer: use a relative import`);
    } else if (spec.startsWith('.')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!target.startsWith('lib/')) continue;
      const rest = target.slice('lib/'.length);
      const layer = pathLayer(rest);
      const prefix = layer && keyOf.get(`${layer}/`);
      if (prefix && layer !== own) problems.push(`${file} → ${spec}: crosses into lib/${layer}/: import ${prefix}${rest.slice(layer.length + 1)}`);
    }
  }
  return problems;
}

/**
 * Everything wrong with the imports of tests beside their modules, as `lib/${file} → ${spec}: …`: an import
 * up the layers from the test's own folder, or a file outside lib/ other than test/helpers.ts. Node and
 * package imports stay allowed, since a test needs node:test and the api rule is about shipped code.
 */
function colocatedProblems(tests: [file: string, specs: Spec[]][], flat: Flat, aliases: Aliases): string[] {
  const problems: string[] = [];
  for (const [file, specs] of tests) {
    const own = layerOf(file, flat);
    for (const { spec } of specs) {
      const target = spec.startsWith('#') ? unalias(spec, aliases)
        : spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : null;
      if (target === null) continue;
      if (target.startsWith('../')) {
        if (target !== '../test/helpers.ts') problems.push(`lib/${file} → ${spec}: from outside lib/ a test imports only test/helpers.ts`);
        continue;
      }
      const layer = layerOf(target, flat);
      if (own && layer && rank(layer) > rank(own)) problems.push(`lib/${file} → ${spec}: imports a higher layer`);
    }
  }
  return problems;
}

interface Scan { edges: Map<string, Edge[]>; externals: Map<string, string[]>; specs: [string, string][]; tests: [string, Spec[]][] }

const listFiles = (dir: string, pattern: RegExp): string[] => (fs.readdirSync(dir, { recursive: true }) as string[])
  .map((f) => f.split(path.sep).join('/'))
  .filter((f) => pattern.test(f) && !f.split('/').includes('node_modules'))
  .sort();

let scanned: Scan | undefined;
function scan(): Scan {
  if (scanned) return scanned;
  const all = listFiles(LIB, /\.(ts|mjs)$/);
  const isTest = (f: string): boolean => f.endsWith('.test.ts');
  const files = all.filter((f) => !isTest(f));
  const specs = new Map(all.map((f) => [f, specsOf(f, fs.readFileSync(path.join(LIB, f), 'utf8'))]));
  scanned = {
    edges: new Map(files.map((f) => [f, edgesFrom(f, specs.get(f)!, ALIASES)])),
    externals: new Map(files.map((f) => [f, specs.get(f)!.filter((s) => isExternal(s.spec)).map((s) => s.spec)])),
    specs: all.flatMap((f) => specs.get(f)!.map((s): [string, string] => [`lib/${f}`, s.spec])),
    tests: all.filter(isTest).map((f): [string, Spec[]] => [f, specs.get(f)!]),
  };
  return scanned;
}
const libEdges = (): Map<string, Edge[]> => scan().edges;

/** The text of a Svelte component's `<script>` blocks, which is all of it that imports anything. */
const scripts = (svelte: string): string => [...svelte.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

let outside: [string, string][] | undefined;
/** Every `[file, specifier]` in test/ and dashboard/src/, with `file` repo-relative. */
function outsideSpecs(): [string, string][] {
  if (outside) return outside;
  const roots: [string, RegExp][] = [['test', /\.(ts|mjs)$/], ['dashboard/src', /\.(ts|svelte)$/]];
  outside = roots.flatMap(([dir, pattern]) => listFiles(path.join(ROOT, dir), pattern).flatMap((f) => {
    const file = `${dir}/${f}`;
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return specsOf(file, file.endsWith('.svelte') ? scripts(text) : text).map((s): [string, string] => [file, s.spec]);
  }));
  return outside;
}

test('every lib/ file has one layer', () => {
  const problems = layerProblems([...libEdges().keys()], [], FLAT_LAYERS, []);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('lib/ imports point down the layers', () => {
  const { edges, externals } = scan();
  const pairs = [...edges].flatMap(([file, list]) => list.map((e): [string, string] => [file, e.target]));
  const outside = [...externals].flatMap(([file, specs]) => specs.map((s): [string, string] => [file, s]));
  const problems = layerProblems([...edges.keys()], pairs, FLAT_LAYERS, ALLOWED_EDGES, outside);
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.deepEqual(ALLOWED_EDGES, [...ALLOWED_EDGES].sort(), 'ALLOWED_EDGES stays sorted');
});

test('the layer check reads post-move paths and refuses planted violations', () => {
  const flat: Flat = { api: [], core: [], integrations: [], engine: ['old/', 'old/keep.ts', 'gone.ts'], office: ['old/keep.ts'], server: [], cli: ['legacy.ts', 'commands/'] };
  assert.equal(layerOf('engine/pipeline/a.ts', flat), 'engine');
  assert.equal(layerOf('legacy.ts', flat), 'cli');
  assert.equal(layerOf('commands/render/x.ts', flat), 'cli', 'a folder key covers nested files');
  assert.equal(layerOf('loose.ts', flat), null);

  const files = [
    'api/a.ts', 'api/b.ts', 'api/c.ts', 'cli/commands/dash.ts', 'cli/y.ts', 'core/a.ts', 'core/d.ts', 'engine/c.ts',
    'engine/pipeline/a.ts', 'legacy.ts', 'loose.ts', 'office/b.ts', 'old/keep.ts', 'server/start.ts', 'server/x.ts',
  ];
  const edges: [string, string][] = [
    ['engine/pipeline/a.ts', 'office/b.ts'],
    ['server/x.ts', 'cli/y.ts'],
    ['cli/commands/dash.ts', 'server/start.ts'],
    ['core/a.ts', 'api/b.ts'],
    ['core/d.ts', 'engine/c.ts'],
  ];
  const allowed = ['core/d.ts → engine/c.ts', 'core/a.ts → api/b.ts', 'core/a.ts → gone.ts'];
  const externals: [string, string][] = [
    ...externalsOf('api/a.ts', "import fs from 'node:fs';").map((s): [string, string] => ['api/a.ts', s]),
    ...externalsOf('api/c.ts', "import type { Stats } from 'node:fs';\nimport type { B } from './b.ts';").map((s): [string, string] => ['api/c.ts', s]),
    ['engine/c.ts', 'node:fs'],
  ];
  assert.deepEqual(layerProblems(files, edges, flat, allowed, externals), [
    'loose.ts: no layer (put it under lib/<layer>/ or in FLAT_LAYERS)',
    'old/keep.ts: listed twice (engine, office)',
    "FLAT_LAYERS.engine 'gone.ts' matches no file: drop it",
    "FLAT_LAYERS.cli 'commands/' matches no file: drop it",
    'engine/pipeline/a.ts → office/b.ts: imports a higher layer',
    'server/x.ts → cli/y.ts: imports a higher layer',
    "ALLOWED_EDGES 'core/a.ts → api/b.ts' is absent or no longer upward: drop it",
    "ALLOWED_EDGES 'core/a.ts → gone.ts' is absent or no longer upward: drop it",
    'api/a.ts → node:fs: api files import only api files',
    'api/c.ts → node:fs: api files import only api files',
  ]);
});

test('tests beside their modules keep their layer and reach outside lib/ only for test/helpers.ts', () => {
  const problems = colocatedProblems(scan().tests, FLAT_LAYERS, ALIASES);
  assert.deepEqual(problems, [], problems.join('\n'));
  const spec = (s: string): Spec => ({ spec: s, typeOnly: false, dynamic: false });
  assert.deepEqual(colocatedProblems([
    ['core/job/a.test.ts', ['node:test', '../../../test/helpers.ts', './a.ts', '#api/types.ts', '#nope/x.ts'].map(spec)],
    ['core/job/b.test.ts', ['../../../test/support/cli.ts', '#engine/c.ts', '../../server/start.ts'].map(spec)],
  ], FLAT_LAYERS, ALIASES), [
    'lib/core/job/b.test.ts → ../../../test/support/cli.ts: from outside lib/ a test imports only test/helpers.ts',
    'lib/core/job/b.test.ts → #engine/c.ts: imports a higher layer',
    'lib/core/job/b.test.ts → ../../server/start.ts: imports a higher layer',
  ]);
});

test('package.json aliases each lib layer below server, and no tsconfig uses paths', () => {
  const expected = Object.fromEntries(LAYERS.filter((l) => !UNALIASED.includes(l)).map((l) => [`#${l}/*`, `./lib/${l}/*`]));
  assert.deepEqual(readJson('package.json').imports, expected);
  for (const file of ['tsconfig.json', 'test/tsconfig.json', 'dashboard/tsconfig.json']) {
    assert.equal(readJson(file).compilerOptions?.paths, undefined, `${file} sets compilerOptions.paths: use package.json "imports"`);
  }
});

test('cross-layer imports go through the aliases', () => {
  const problems = aliasProblems([...scan().specs, ...outsideSpecs()], ALIASES);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the alias check refuses planted violations', () => {
  const aliases = aliasesFrom({ imports: { '#api/*': './lib/api/*', '#core/*': './lib/core/*', '#engine/*': './lib/engine/*', '#odd': './x.ts' } });
  assert.deepEqual([...aliases], [['#api/', 'api/'], ['#core/', 'core/'], ['#engine/', 'engine/']], 'only #<name>/* → ./lib/<folder>/* entries count');
  const refused: [string, string][] = [
    ['lib/engine/x/a.ts', '../../core/b.ts'],
    ['test/a.test.ts', '../lib/engine/c.ts'],
    ['dashboard/src/lib/t.ts', '../../../lib/api/types.ts'],
    ['lib/engine/x/a.ts', '#engine/y.ts'],
    ['lib/engine/x/a.ts', '#server/start.ts'],
    ['test/a.test.ts', '#cli/main.ts'],
    ['test/a.test.ts', '#nope/x.ts'],
  ];
  const accepted: [string, string][] = [
    ['lib/cli/commands/dash.ts', '../../server/start.ts'],
    ['test/a.test.ts', '../lib/cli/main.ts'],
    ['test/a.test.ts', '../lib/trackers/status.mjs'],
    ['lib/trackers/status.ts', '../api/tracker.ts'],
    ['lib/engine/x/a.ts', '#core/b.ts'],
    ['lib/engine/x/a.ts', './y.ts'],
    ['test/a.test.ts', 'node:fs'],
  ];
  const none = 'no such alias (the aliases are #api/, #core/, #engine/)';
  assert.deepEqual(aliasProblems([...refused, ...accepted], aliases), [
    'lib/engine/x/a.ts → ../../core/b.ts: crosses into lib/core/: import #core/b.ts',
    'test/a.test.ts → ../lib/engine/c.ts: crosses into lib/engine/: import #engine/c.ts',
    'dashboard/src/lib/t.ts → ../../../lib/api/types.ts: crosses into lib/api/: import #api/types.ts',
    'lib/engine/x/a.ts → #engine/y.ts: same layer: use a relative import',
    `lib/engine/x/a.ts → #server/start.ts: ${none}`,
    `test/a.test.ts → #cli/main.ts: ${none}`,
    `test/a.test.ts → #nope/x.ts: ${none}`,
  ]);
});

test('lib/ has no runtime import cycles', () => {
  const graph = new Map([...libEdges()].map(([file, edges]) => [file, edges.filter((e) => !e.typeOnly).map((e) => e.target)]));
  const found = cycles(graph);
  assert.deepEqual(found, [], `import cycles in lib/:\n${found.map((c) => c.join(' → ')).join('\n')}`);
});

test('only cli/commands/ and cli/main.ts import cli/commands/', () => {
  const cli = (f: string): boolean => f === 'cli/main.ts' || f.startsWith('cli/commands/');
  const bad = [...libEdges()].flatMap(([file, edges]) =>
    cli(file) ? [] : edges.filter((e) => e.target.startsWith('cli/commands/')).map((e) => `${file} → ${e.target}`));
  assert.deepEqual(bad, []);
});

test('runtime code never imports dashboard sources', () => {
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'bin'));
  assert.ok(files.length > 10, 'walked lib/ and bin/');
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    assert.ok(!text.includes('dashboard/src'), `${rel} mentions dashboard/src`);
    // The engine is TypeScript too now, so only a .ts import that reaches into dashboard/ is refused
    // (a path segment, so an engine module merely named dashboard-*.ts is not one).
    assert.doesNotMatch(text, /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*dashboard\/[^'"]*\.ts['"]/, `${rel} imports a dashboard .ts file`);
  }
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
    "import { c } from '#core/x.ts';",
    "import type { K } from '#integrations/k.ts';",
    "const late = () => import('#engine/late.ts');",
    "import n from '#nope/n.ts';",
  ].join('\n');
  const edges = importsOf('sub/file.ts', fixture);
  assert.deepEqual(edges.filter((e) => !e.typeOnly).map((e) => e.target), [
    'sub/default.ts', 'sub/mixed.ts', 'sub/inline-type.ts', 'sub/star.ts', 'sub/named.ts', 'sub/side.ts', 'sub/lazy.ts',
    'core/x.ts', 'engine/late.ts',
  ]);
  assert.deepEqual(edges.filter((e) => e.typeOnly).map((e) => e.target), ['sub/type-only.ts', 'sub/type-export.ts', 'integrations/k.ts']);
  assert.deepEqual(edges.filter((e) => e.dynamic).map((e) => e.target), ['sub/lazy.ts', 'engine/late.ts']);
  assert.deepEqual(importsOf('sub/file.ts', "import x from '#core/x.ts'"), [{ target: 'core/x.ts', typeOnly: false, dynamic: false }]);
  assert.deepEqual(importsOf('file.ts', "import y from '../lib-sibling.ts';"), [], 'targets outside lib/ are dropped');
  assert.deepEqual(externalsOf('sub/file.ts', fixture), ['node:fs', 'typescript']);

  assert.deepEqual(cycles(new Map([['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']], ['d.ts', ['a.ts']]])), [['a.ts', 'b.ts', 'c.ts']]);
  assert.deepEqual(cycles(new Map([['self.ts', ['self.ts']], ['other.ts', []]])), [['self.ts']]);
  assert.deepEqual(cycles(new Map([['a.ts', ['b.ts', 'c.ts']], ['b.ts', ['c.ts']], ['c.ts', []]])), []);
});
