// CI's Windows leg: runs every test/*.test.ts except those WINDOWS_SKIP names, one per line as
// `test/<file>.test.ts: <reason>`. The list is a coverage gate, so it fails closed: a line without a
// reason, one naming anything but an existing test file (a glob or a directory included), a repeat,
// or a list that leaves nothing to run exits 1 before any test starts. Otherwise it exits with
// `node --test`'s status. Usage: node scripts/windows-tests.ts [dir] (default: test).
// main() runs with no "am I the entry point" guard: such a guard can miss a symlinked or differently
// spelled path and exit 0 having run nothing, a silent green. The rule lives in windows-plan.ts.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SUFFIX, planWindowsRun } from './windows-plan.ts';

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

main();
