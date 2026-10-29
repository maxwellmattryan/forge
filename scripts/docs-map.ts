// `npm run docs:map`: regenerates the file table in every AGENTS.md under lib/ and dashboard/src/lib/
// from the first sentence of each file's header comment, so a folder map can't drift from the code it describes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAP_START = '<!-- forge:map:start (generated from each file\'s header comment by npm run docs:map; edit those) -->';
export const MAP_END = '<!-- forge:map:end -->';

/** The repo-relative folders whose AGENTS.md maps this writes. */
export const MAP_ROOTS = ['lib'] as const;

const SOURCE = /\.(ts|mjs)$/;

/** The first sentence of `paragraph`: up to a `.`, `!` or `?` outside backticks that ends a word. */
function firstSentence(paragraph: string): string {
  let code = false;
  for (let i = 0; i < paragraph.length; i++) {
    const c = paragraph[i]!;
    if (c === '`') code = !code;
    else if (!code && '.!?'.includes(c) && (i + 1 === paragraph.length || /\s/.test(paragraph[i + 1]!))) return paragraph.slice(0, i + 1);
  }
  return paragraph;
}

/** The first paragraph of `lines`: leading blanks skipped, up to the next blank line, whitespace collapsed. */
function firstParagraph(lines: string[]): string {
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const para: string[] = [];
  for (; i < lines.length && lines[i]!.trim(); i++) para.push(lines[i]!.trim());
  return para.join(' ').replace(/\s+/g, ' ');
}

/**
 * The first sentence of a source file's leading `//` or `/* … *\/` comment, after any shebang and
 * `/// <reference … />` directives; null without one.
 */
export function headerSentence(text: string): string | null {
  const lines = text.split('\n');
  let i = lines[0]?.startsWith('#!') ? 1 : 0;
  while (i < lines.length && (!lines[i]!.trim() || lines[i]!.trimStart().startsWith('/// <'))) i++;
  const first = lines[i]?.trimStart() ?? '';
  const body: string[] = [];
  if (first.startsWith('//')) {
    for (; i < lines.length && lines[i]!.trimStart().startsWith('//'); i++) body.push(lines[i]!.trimStart().slice(2));
  } else if (first.startsWith('/*')) {
    for (; i < lines.length; i++) {
      let line = lines[i]!;
      const end = line.indexOf('*/');
      if (end >= 0) line = line.slice(0, end);
      line = line.trimStart().replace(/^\/\*\*?/, '').replace(/^\s*\*(?!\/)/, '');
      body.push(line);
      if (end >= 0) break;
    }
  } else {
    return null;
  }
  const paragraph = firstParagraph(body);
  return paragraph ? firstSentence(paragraph) : null;
}

/** The first sentence of the first paragraph after an AGENTS.md's `#` heading. */
function agentsSentence(text: string): string | null {
  const lines = text.split('\n');
  const heading = lines.findIndex((l) => l.startsWith('# '));
  if (heading < 0) return null;
  const rest = lines.slice(heading + 1);
  const stop = rest.findIndex((l) => l.startsWith('<!--'));
  const paragraph = firstParagraph(stop < 0 ? rest : rest.slice(0, stop));
  return paragraph ? firstSentence(paragraph) : null;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|');

/**
 * The folder map for `dir`: one row per source file (not `*.test.ts`) here and in subfolders without
 * their own AGENTS.md, and one row per subfolder with one. Throws naming every file without a header.
 */
export function renderMap(dir: string): string {
  const rows: [string, string][] = [];
  const missing: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const file = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, file);
      if (entry.isDirectory()) {
        const agents = path.join(full, 'AGENTS.md');
        if (!fs.existsSync(agents)) { walk(file); continue; }
        const sentence = agentsSentence(fs.readFileSync(agents, 'utf8'));
        if (sentence === null) missing.push(`${file}/AGENTS.md`);
        else rows.push([`${file}/`, sentence]);
      } else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        const sentence = headerSentence(fs.readFileSync(full, 'utf8'));
        if (sentence === null) missing.push(file);
        else rows.push([file, sentence]);
      }
    }
  };
  walk('');
  if (missing.length) throw new Error(`no header comment in ${dir}: ${missing.sort().join(', ')}`);
  rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return ['| File | What it holds |', '|---|---|', ...rows.map(([file, text]) => `| \`${cell(file)}\` | ${cell(text)} |`)].join('\n');
}

/** `agentsText` with the region between the map markers replaced by `table`. */
export function syncMap(agentsText: string, table: string): string {
  const start = agentsText.indexOf(MAP_START);
  const end = agentsText.indexOf(MAP_END);
  if (start < 0 || end < start) throw new Error(`missing the map markers ${MAP_START} … ${MAP_END}`);
  return `${agentsText.slice(0, start + MAP_START.length)}\n${table}\n${agentsText.slice(end)}`;
}

/** Every AGENTS.md under `libDir`, sorted. */
export function mapFiles(libDir: string): string[] {
  return (fs.readdirSync(libDir, { recursive: true }) as string[])
    .filter((f) => path.basename(f) === 'AGENTS.md')
    .map((f) => path.join(libDir, f))
    .sort();
}

function main(): void {
  const root = path.resolve(import.meta.dirname, '..');
  const updates: [string, string][] = [];
  for (const file of MAP_ROOTS.flatMap((dir) => mapFiles(path.join(root, dir)))) {
    const rel = path.relative(root, file);
    try {
      const before = fs.readFileSync(file, 'utf8');
      const after = syncMap(before, renderMap(path.dirname(file)));
      if (after !== before) updates.push([file, after]);
    } catch (err) {
      process.stderr.write(`${rel}: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }
  for (const [file, text] of updates) fs.writeFileSync(file, text);
  process.stdout.write(updates.length ? `updated ${updates.map(([f]) => path.relative(root, f)).join(', ')}\n` : 'folder maps are up to date\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
