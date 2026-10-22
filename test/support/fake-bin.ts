// A stub executable that records how it was called. POSIX only, as the per-file stubs it replaced were.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unit and record separators: argv entries can hold spaces and newlines, never these.
const ARG_END = '\x1f';
const CALL_END = '\x1e';

const made = new Set<string>();
let cleanupHooked = false;

/** A fresh temp dir that is removed when the test process exits (one exit listener for all of them). */
export function stubDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.add(dir);
  if (!cleanupHooked) {
    cleanupHooked = true;
    process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
  }
  return dir;
}

/**
 * Writes `dir/name`, a shell script that appends its argv to `log` and then runs `script`. Put
 * `dir` first on PATH in the child env; `calls()` returns each call's argv, oldest first.
 */
export function fakeBin(name: string, script = 'exit 0'): { dir: string; bin: string; log: string; calls(): string[][] } {
  const dir = stubDir('forge-fake-bin-');
  const bin = path.join(dir, name);
  const log = path.join(dir, `${name}.calls`);
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    `{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\036'; } >> '${log}'`,
    script,
    '',
  ].join('\n'), { mode: 0o755 });
  return {
    dir,
    bin,
    log,
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').split(CALL_END).slice(0, -1)
        .map((call) => call.split(ARG_END).slice(0, -1));
    },
  };
}
