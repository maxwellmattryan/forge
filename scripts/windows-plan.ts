// The rule behind CI's Windows leg (scripts/windows-tests.ts): which test files run, given the
// WINDOWS_SKIP list. Its own module so the entry script has no import guard to get wrong, and
// test/ci-workflow.test.ts can hold the workflow's list to the same rule.

export const SUFFIX = '.test.ts';
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
