// `npm run coverage`: runs the whole suite under Node's built-in coverage and writes a per-file line
// summary of lib/ and dashboard/src/lib/ to node_modules/.cache/forge/coverage.txt, so a change that
// deletes tests can show it dropped no file's coverage (docs/TESTING.md › Coverage).
// It parses the lcov report rather than the text table: the table's layout changes between Node versions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cache = path.join(root, 'node_modules', '.cache', 'forge');
const lcov = path.join(cache, 'lcov.info');
const summary = path.join(cache, 'coverage.txt');
const INCLUDE = ['lib/**', 'dashboard/src/lib/**'];

fs.mkdirSync(cache, { recursive: true });
fs.rmSync(lcov, { force: true });

const run = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  ...INCLUDE.map((glob) => `--test-coverage-include=${glob}`),
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=lcov', `--test-reporter-destination=${lcov}`,
  'test/**/*.test.ts',
], { cwd: root, stdio: 'inherit' });

interface FileCoverage { file: string; hit: number; found: number }

/** Line hits per source file from an lcov report, paths made relative to `base`. */
function parseLcov(text: string, base: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) current = { file: path.relative(base, line.slice(3)).split(path.sep).join('/'), hit: 0, found: 0 };
    else if (current && line.startsWith('LH:')) current.hit = Number(line.slice(3));
    else if (current && line.startsWith('LF:')) current.found = Number(line.slice(3));
    else if (current && line === 'end_of_record') { files.push(current); current = null; }
  }
  return files;
}

const pct = (hit: number, found: number) => (found === 0 ? 100 : (hit / found) * 100).toFixed(1);

if (fs.existsSync(lcov)) {
  const files = parseLcov(fs.readFileSync(lcov, 'utf8'), root)
    .filter((f) => !f.file.startsWith('test/') && !f.file.startsWith('..'))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  let hit = 0;
  let found = 0;
  const lines = files.map((f) => {
    hit += f.hit;
    found += f.found;
    return `${f.file}\t${pct(f.hit, f.found)}\t${f.hit}/${f.found}`;
  });
  lines.push(`total\t${pct(hit, found)}\t${hit}/${found}`);
  fs.writeFileSync(summary, `${lines.join('\n')}\n`);
  process.stdout.write(`coverage: ${path.relative(root, summary)} (${files.length} files, total ${pct(hit, found)}%)\n`);
} else {
  process.stderr.write('coverage: no lcov report was written\n');
}
process.exit(run.status ?? 1);
