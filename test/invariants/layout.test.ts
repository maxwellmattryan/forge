// lib/ folders follow the layout rules in docs/design/lib-layout.md › Conventions: no index files, no
// stutter, 3–12 entries per folder (registries, integrations/<system>/ and the shrinking SMALL list
// apart), and an AGENTS.md map in lib/, each layer folder and each module folder. No public function
// exposes the tree's shape, so this lists lib/ folder and file names; it reads no file text
// (docs/TESTING.md › Allowed source-text tests, entry 12).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LAYERS } from './layer-map.ts';

const LIB = path.resolve(import.meta.dirname, '..', '..', 'lib');
const MAX = 12;
const MIN = 3;

/** Folders whose files are entries in one table, so they may hold more than MAX. */
const REGISTRIES = ['cli/commands/', 'cli/commands/render/'];

/** Folders allowed under MIN entries for now. The list only shrinks: each comment says what grows or removes the folder. */
const SMALL = [
  'engine/pr/', // #414 splits lifecycle.ts
  'office/session/', // #416 splits lifecycle.ts
  'server/', // #415 splits start.ts
  'trackers/', // the deprecated status re-exports, removed one minor release after the move
];

/** A folder under lib/: its lib-relative path (`''` for lib/, else ending in `/`) and its names, subfolders ending in `/`. */
interface Dir { path: string; entries: string[] }

/** The names that count toward a folder's size: subfolders and source or data files, not AGENTS.md or tests. */
const counted = (entries: string[]): string[] =>
  entries.filter((e) => e.endsWith('/') || (/\.(ts|mjs|json)$/.test(e) && !e.endsWith('.test.ts')));

const stem = (entry: string): string => entry.replace(/\/$/, '').replace(/\.(ts|mjs|json)$/, '');

/** Whether `dir` is lib/, a layer folder or a folder directly inside a layer: the ones that need a map. */
function needsMap(dir: string): boolean {
  const parts = dir.split('/').filter(Boolean);
  return parts.length === 0 || ((LAYERS as readonly string[]).includes(parts[0]!) && parts.length <= 2);
}

/**
 * Everything wrong with lib/'s folders: index files, entries that repeat their folder's name, folders over
 * MAX or under MIN entries, missing maps, and stale SMALL or REGISTRIES entries. Each message names the path.
 */
function layoutProblems(dirs: Dir[], small: string[] = SMALL, registries: string[] = REGISTRIES): string[] {
  const problems: string[] = [];
  const sizes = new Map(dirs.map((d) => [d.path, counted(d.entries).length]));
  for (const d of [...dirs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const shown = `lib/${d.path}`;
    const entries = counted(d.entries);
    for (const e of entries) if (e === 'index.ts' || e === 'index.mjs') problems.push(`${shown}${e}: no index files: name it for what it holds`);
    const name = d.path.split('/').filter(Boolean).pop();
    if (name) {
      const names = new Set([name, name.replace(/s$/, '')]);
      for (const e of entries) {
        const s = stem(e);
        if ([...names].some((n) => s === n || s.startsWith(`${n}-`))) problems.push(`${shown}${e}: repeats its folder's name`);
      }
    }
    if (entries.length > MAX && !registries.includes(d.path)) problems.push(`${shown}: ${entries.length} entries, over ${MAX}: split it into modules`);
    const system = /^integrations\/[^/]+\/$/.test(d.path);
    if (entries.length < MIN && d.path && !system && !small.includes(d.path)) problems.push(`${shown}: ${entries.length} entries, under ${MIN}: fold it into its parent`);
    if (needsMap(d.path) && !d.entries.includes('AGENTS.md')) problems.push(`${shown}: no AGENTS.md map`);
  }
  for (const p of small) {
    const n = sizes.get(p);
    if (n === undefined) problems.push(`SMALL '${p}' matches no folder: drop it`);
    else if (n >= MIN) problems.push(`SMALL '${p}' has ${n} entries: drop it`);
  }
  for (const p of registries) if (!sizes.has(p)) problems.push(`REGISTRIES '${p}' matches no folder: drop it`);
  return problems;
}

/** Every folder under lib/, its names listed as layoutProblems reads them. */
function libDirs(): Dir[] {
  const dirs: Dir[] = [];
  const walk = (rel: string): void => {
    const list = fs.readdirSync(path.join(LIB, rel), { withFileTypes: true });
    dirs.push({ path: rel, entries: list.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)) });
    for (const e of list) if (e.isDirectory()) walk(`${rel}${e.name}/`);
  };
  walk('');
  return dirs;
}

test('lib/ folders follow the layout rules', () => {
  const problems = layoutProblems(libDirs());
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the layout check refuses planted violations', () => {
  const files = (n: number, prefix = 'f'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}.ts`);
  const dirs: Dir[] = [
    { path: '', entries: ['AGENTS.md', 'core/', 'engine/', 'integrations/', 'loose/'] },
    { path: 'core/', entries: ['AGENTS.md', 'job/', 'index.ts', 'a.ts', 'b.test.ts'] },
    { path: 'core/job/', entries: ['job.ts', 'job-fields.ts', 'jobs.ts', 'notes.md', 'b.ts', 'c.json'] },
    { path: 'engine/', entries: ['AGENTS.md', 'big/', 'tiny/', 'pr/', 'evals/'] },
    { path: 'engine/big/', entries: ['AGENTS.md', ...files(13)] },
    { path: 'engine/tiny/', entries: ['AGENTS.md', 'a.ts', 'a.test.ts', 'README.md'] },
    { path: 'engine/pr/', entries: ['AGENTS.md', 'a.ts', 'b.ts', 'c.ts'] },
    { path: 'engine/evals/', entries: ['AGENTS.md', 'eval-stats.ts', 'run.ts', 'index.mjs'] },
    { path: 'integrations/', entries: ['AGENTS.md', 'git/', 'docker/', 'github/'] },
    { path: 'integrations/git/', entries: ['AGENTS.md', 'runner.ts'] },
    { path: 'loose/', entries: ['a.ts', 'b.ts', 'c.ts', 'deep/'] },
    { path: 'loose/deep/', entries: files(14) },
  ];
  assert.deepEqual(layoutProblems(dirs, ['engine/pr/', 'gone/'], ['loose/deep/', 'missing/']), [
    'lib/core/index.ts: no index files: name it for what it holds',
    "lib/core/job/job.ts: repeats its folder's name",
    "lib/core/job/job-fields.ts: repeats its folder's name",
    'lib/core/job/: no AGENTS.md map',
    'lib/engine/big/: 13 entries, over 12: split it into modules',
    'lib/engine/evals/index.mjs: no index files: name it for what it holds',
    "lib/engine/evals/eval-stats.ts: repeats its folder's name",
    'lib/engine/tiny/: 1 entries, under 3: fold it into its parent',
    "SMALL 'engine/pr/' has 3 entries: drop it",
    "SMALL 'gone/' matches no folder: drop it",
    "REGISTRIES 'missing/' matches no folder: drop it",
  ]);
});
