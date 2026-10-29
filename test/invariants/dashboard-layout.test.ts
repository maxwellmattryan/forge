// dashboard/src/lib/ folders follow the layout rules root lib/ follows (test/invariants/layout.test.ts and
// file-size.test.ts): no source files at the root, no index files, no stutter, 3–12 entries per folder, an
// AGENTS.md map in every folder, and no source over 600 lines unless pinned. No public function exposes the
// tree's shape or a file's length, so this lists folder and file names under each root in ROOTS and counts
// each source's lines (docs/TESTING.md › Allowed source-text tests, entry 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const MIN = 3;
const MAX = 12;
const CAP = 600;

/** One checked tree and its exemptions. Paths in `small`, `registries` and `allowed` are root-relative. */
interface Root {
  /** Repo-relative folder, without a trailing `/`. */
  root: string;
  /** The file names that count as entries; `*.test.ts` never does. */
  entry: RegExp;
  /** Whether source files may sit in the root itself rather than in a module folder. */
  filesAtRoot: boolean;
  /** Whether `.svelte` entries must have PascalCase stems (`/^[A-Z][A-Za-z0-9]*$/`). */
  pascal: boolean;
  /** Folders allowed under MIN entries for now. The list only shrinks. */
  small: string[];
  /** Folders whose files are entries in one table, so they may hold more than MAX. */
  registries: string[];
  /** Source → its line count when pinned over CAP. Lower a pin when a file shrinks; never raise one. */
  allowed: Record<string, number>;
}

const ROOTS: Root[] = [
  { root: 'dashboard/src/lib', entry: /\.ts$/, filesAtRoot: false, pascal: false, small: [], registries: [], allowed: { 'core/app.svelte.ts': 675 } },
];

/** A folder under a root: its root-relative path (`''` for the root, else ending in `/`) and its names, subfolders ending in `/`. */
interface Dir { path: string; entries: string[] }

/** The names that count toward a folder's size: subfolders and source files, not AGENTS.md, README.md or tests. */
const counted = (entries: string[], entry: RegExp): string[] =>
  entries.filter((e) => e.endsWith('/') || (entry.test(e) && !e.endsWith('.test.ts')));

/** An entry's name without its trailing `/` or its `.svelte.ts`, `.ts` or `.svelte` extension. */
const stem = (entry: string): string => entry.replace(/\/$/, '').replace(/\.svelte\.ts$|\.ts$|\.svelte$/, '');

/**
 * Everything wrong with a root's folders: files at the root, index files, entries that repeat their folder's
 * name (case-insensitively), components whose names aren't PascalCase when `pascal` is on, folders over MAX
 * or under MIN entries, missing maps, and stale `small` or `registries` entries. Each message names the path,
 * prefixed with the root.
 */
function layoutProblems(rootLabel: string, dirs: Dir[], cfg: Pick<Root, 'entry' | 'filesAtRoot' | 'pascal' | 'small' | 'registries'>): string[] {
  const problems: string[] = [];
  const sizes = new Map(dirs.map((d) => [d.path, counted(d.entries, cfg.entry).length]));
  for (const d of [...dirs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const shown = `${rootLabel}/${d.path}`;
    const entries = counted(d.entries, cfg.entry);
    if (!d.path && !cfg.filesAtRoot) for (const e of entries) if (!e.endsWith('/')) problems.push(`${shown}${e}: files belong in a module folder`);
    for (const e of entries) if (stem(e) === 'index') problems.push(`${shown}${e}: no index files: name it for what it holds`);
    const name = d.path.split('/').filter(Boolean).pop();
    if (name) {
      const names = new Set([name, name.replace(/s$/, '')]);
      for (const e of entries) {
        const s = stem(e).toLowerCase();
        if ([...names].some((n) => s === n || s.startsWith(`${n}-`))) problems.push(`${shown}${e}: repeats its folder's name`);
      }
    }
    if (cfg.pascal) {
      for (const e of entries) if (e.endsWith('.svelte') && !/^[A-Z][A-Za-z0-9]*$/.test(stem(e))) problems.push(`${shown}${e}: a component's name is PascalCase`);
    }
    if (entries.length > MAX && !cfg.registries.includes(d.path)) problems.push(`${shown}: ${entries.length} entries, over ${MAX}: split it into modules`);
    if (entries.length < MIN && d.path && !cfg.small.includes(d.path)) problems.push(`${shown}: ${entries.length} entries, under ${MIN}: fold it into its parent`);
    if (!d.entries.includes('AGENTS.md')) problems.push(`${shown}: no AGENTS.md map`);
  }
  for (const p of cfg.small) {
    const n = sizes.get(p);
    if (n === undefined) problems.push(`SMALL '${p}' matches no folder: drop it`);
    else if (n >= MIN) problems.push(`SMALL '${p}' has ${n} entries: drop it`);
  }
  for (const p of cfg.registries) if (!sizes.has(p)) problems.push(`REGISTRIES '${p}' matches no folder: drop it`);
  return problems;
}

/** Lines as `wc -l` counts them for a newline-terminated file. */
const lineCount = (text: string): number => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/**
 * Sources over CAP and off the list, sources past their pin, pins that now fit, and pins for missing files,
 * with file-size.test.ts's semantics and messages. `sizes` is keyed root-relative; messages carry the root.
 */
function sizeProblems(rootLabel: string, sizes: Map<string, number>, allowed: Record<string, number>): string[] {
  const problems: string[] = [];
  for (const [file, lines] of [...sizes].sort(([a], [b]) => a.localeCompare(b))) {
    const pin = allowed[file];
    const shown = `${rootLabel}/${file}`;
    if (pin === undefined) {
      if (lines > CAP) problems.push(`${shown}: ${lines} lines, over the ${CAP}-line cap: split it`);
    } else if (lines > pin) {
      problems.push(`${shown}: ${lines} lines, over its pin of ${pin}: split it rather than raise the pin`);
    } else if (lines <= CAP) {
      problems.push(`${shown}: ${lines} lines, within the ${CAP}-line cap: drop it from the list`);
    }
  }
  for (const file of Object.keys(allowed).sort()) {
    if (!sizes.has(file)) problems.push(`${rootLabel}/${file}: pinned but not found: drop it from the list`);
  }
  return problems;
}

/** Every folder under `cfg.root` (skipping node_modules) and the line count of every entry source in it. */
function scan(cfg: Root): { dirs: Dir[]; sizes: Map<string, number> } {
  const base = path.join(REPO, cfg.root);
  const dirs: Dir[] = [];
  const sizes = new Map<string, number>();
  const walk = (rel: string): void => {
    const list = fs.readdirSync(path.join(base, rel), { withFileTypes: true }).filter((e) => e.name !== 'node_modules');
    dirs.push({ path: rel, entries: list.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)) });
    for (const e of list) {
      if (e.isDirectory()) walk(`${rel}${e.name}/`);
      else if (cfg.entry.test(e.name) && !e.name.endsWith('.test.ts')) sizes.set(`${rel}${e.name}`, lineCount(fs.readFileSync(path.join(base, rel, e.name), 'utf8')));
    }
  };
  walk('');
  return { dirs, sizes };
}

test('dashboard/src/lib folders follow the layout rules', () => {
  for (const cfg of ROOTS) {
    const { dirs, sizes } = scan(cfg);
    const problems = [...layoutProblems(cfg.root, dirs, cfg), ...sizeProblems(cfg.root, sizes, cfg.allowed)];
    assert.deepEqual(problems, [], problems.join('\n'));
  }
});

test('the dashboard layout check refuses planted violations', () => {
  const files = (n: number, prefix = 'f'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}.ts`);
  const ok = ['AGENTS.md', 'a.ts', 'b.svelte.ts', 'c.ts'];
  const dirs: Dir[] = [
    { path: '', entries: ['AGENTS.md', 'README.md', 'loose.ts', 'core/', 'idx/', 'sidx/', 'toast/', 'jobs/', 'big/', 'tiny/', 'bare/'] },
    { path: 'core/', entries: [...ok, 'a.test.ts', 'README.md'] },
    { path: 'idx/', entries: [...ok, 'index.ts'] },
    { path: 'sidx/', entries: [...ok, 'index.svelte.ts'] },
    { path: 'toast/', entries: [...ok, 'toast.svelte.ts'] },
    { path: 'jobs/', entries: [...ok, 'job-state.ts'] },
    { path: 'big/', entries: ['AGENTS.md', ...files(13)] },
    { path: 'tiny/', entries: ['AGENTS.md', 'a.ts', 'b.ts', 'a.test.ts', 'b.test.ts', 'README.md'] },
    { path: 'bare/', entries: ['a.ts', 'b.ts', 'c.ts'] },
  ];
  const cfg = { entry: /\.ts$/, filesAtRoot: false, pascal: false, small: [], registries: [] };
  assert.deepEqual(layoutProblems('dashboard/src/lib', dirs, cfg), [
    'dashboard/src/lib/loose.ts: files belong in a module folder',
    'dashboard/src/lib/bare/: no AGENTS.md map',
    'dashboard/src/lib/big/: 13 entries, over 12: split it into modules',
    'dashboard/src/lib/idx/index.ts: no index files: name it for what it holds',
    "dashboard/src/lib/jobs/job-state.ts: repeats its folder's name",
    'dashboard/src/lib/sidx/index.svelte.ts: no index files: name it for what it holds',
    'dashboard/src/lib/tiny/: 2 entries, under 3: fold it into its parent',
    "dashboard/src/lib/toast/toast.svelte.ts: repeats its folder's name",
  ]);
  assert.deepEqual(layoutProblems('dashboard/src/lib', dirs, { ...cfg, filesAtRoot: true }).filter((p) => p.includes('loose.ts')), [], 'filesAtRoot lets sources sit at the root');
  assert.deepEqual(layoutProblems('dashboard/src/lib', [{ path: '', entries: ['AGENTS.md', 'a/'] }, { path: 'a/', entries: ['AGENTS.md', 'x.ts'] }],
    { ...cfg, small: ['a/', 'gone/'], registries: ['missing/'] }), [
    "SMALL 'gone/' matches no folder: drop it",
    "REGISTRIES 'missing/' matches no folder: drop it",
  ], 'stale exemptions are named');

  const components: Dir[] = [
    { path: '', entries: ['AGENTS.md', 'Loose.svelte', 'drawer/', 'statusbar/', 'jobs/', 'ui/'] },
    { path: 'drawer/', entries: ['AGENTS.md', 'Drawer.svelte', 'A.svelte', 'B.svelte'] },
    { path: 'statusbar/', entries: ['AGENTS.md', 'StatusBar.svelte', 'A.svelte', 'B.svelte'] },
    { path: 'jobs/', entries: ['AGENTS.md', 'JobCard.svelte', 'JobsTable.svelte', 'A.svelte'] },
    { path: 'ui/', entries: ['AGENTS.md', 'chip.svelte', 'A.svelte', 'B.svelte'] },
  ];
  assert.deepEqual(layoutProblems('dashboard/src/components', components, { entry: /\.(svelte|ts)$/, filesAtRoot: false, pascal: true, small: [], registries: [] }), [
    'dashboard/src/components/Loose.svelte: files belong in a module folder',
    "dashboard/src/components/drawer/Drawer.svelte: repeats its folder's name",
    "dashboard/src/components/statusbar/StatusBar.svelte: repeats its folder's name",
    "dashboard/src/components/ui/chip.svelte: a component's name is PascalCase",
  ], 'a component may keep a feature prefix, but not equal its folder or skip PascalCase');

  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(lineCount('a\nb'), 2);
  const sizes = new Map([['jobs/long.ts', 601], ['core/grown.svelte.ts', 700], ['core/fits.ts', 600], ['core/held.ts', 650], ['core/small.ts', 10]]);
  assert.deepEqual(sizeProblems('dashboard/src/lib', sizes, { 'core/grown.svelte.ts': 690, 'core/fits.ts': 640, 'core/held.ts': 660, 'core/gone.ts': 900 }), [
    'dashboard/src/lib/core/fits.ts: 600 lines, within the 600-line cap: drop it from the list',
    'dashboard/src/lib/core/grown.svelte.ts: 700 lines, over its pin of 690: split it rather than raise the pin',
    'dashboard/src/lib/jobs/long.ts: 601 lines, over the 600-line cap: split it',
    'dashboard/src/lib/core/gone.ts: pinned but not found: drop it from the list',
  ]);
});
