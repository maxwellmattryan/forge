// CI's Windows leg: runs every test/*.test.ts except those WINDOWS_SKIP names, one per line as
// `test/<file>.test.ts: <reason>`. The list is a coverage gate, so it fails closed: a line without a
// reason, one naming anything but an existing test file (a glob or a directory included), a repeat,
// or a list that leaves nothing to run exits 1 before any test starts. Otherwise it exits with
// `node --test`'s status. Usage: node scripts/windows-tests.ts [dir] (default: test).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUFFIX = '.test.ts';
// One file directly in test/: no further slash, backslash, glob character or control character.
const ENTRY = /^test\/[^/\\*?[\]{}\x00-\x1f]+\.test\.ts$/;

export interface WindowsPlan {
  run: string[];
  skipped: [string, string][];
  problems: string[];
}

/** Splits `skipText` against `files` (posix `test/<name>` paths). Any problem means nothing may run. */
export function planWindowsRun(skipText: string, files: string[]): WindowsPlan {
  const problems: string[] = [];
  const skipped: [string, string][] = [];
  const seen = new Set<string>();
  const known = new Set(files);
  for (const raw of skipText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const end = line.indexOf(SUFFIX);
    const sep = end === -1 ? -1 : line.indexOf(': ', end + SUFFIX.length);
    const file = (sep === -1 ? line.replace(/:$/, '') : line.slice(0, sep)).trim();
    const reason = sep === -1 ? '' : line.slice(sep + 2).trim();
    if (!ENTRY.test(file)) {
      problems.push(`${JSON.stringify(line)}: not one test/<name>.test.ts file`);
      continue;
    }
    if (!reason) problems.push(`${file}: no reason given`);
    if (!known.has(file)) problems.push(`${file}: no such test file`);
    if (seen.has(file)) problems.push(`${file}: listed twice`);
    seen.add(file);
    if (reason && known.has(file)) skipped.push([file, reason]);
  }
  const run = files.filter((f) => !seen.has(f));
  if (!run.length) problems.push('the skip list leaves no test file to run');
  return { run, skipped, problems };
}

function main(): void {
  const dir = process.argv[2] ?? 'test';
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(SUFFIX))
    .map((e) => e.name)
    .sort();
  const plan = planWindowsRun(process.env.WINDOWS_SKIP ?? '', names.map((n) => `test/${n}`));
  if (plan.problems.length) {
    process.stderr.write(`WINDOWS_SKIP is invalid; no tests ran:\n${plan.problems.map((p) => `  ${p}\n`).join('')}`);
    process.exit(1);
  }
  for (const [file, reason] of plan.skipped) process.stdout.write(`skip ${file}: ${reason}\n`);
  const files = plan.run.map((f) => path.join(dir, f.slice('test/'.length)));
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  // A child killed by a signal has no status: that is a failure, never a pass.
  process.exit(r.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
