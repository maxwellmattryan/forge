// `npm run test:times`: a node:test reporter that prints each test file's time, slowest first, then
// the file count and the run's wall time. Node 22's TAP output carries no file names, so the time
// per file is the sum of its top-level tests' durations, read from the reporter's own events.
import path from 'node:path';

interface TimedEvent {
  type: string;
  data?: { nesting?: number; file?: string; details?: { duration_ms?: number } };
}

/** The reporter node:test loads. It takes only the event stream: node passes other arguments after it. */
export default async function* testTimes(source: AsyncIterable<TimedEvent>): AsyncGenerator<string, void> {
  yield* timeLines(source, process.cwd());
}

/** The lines to print for `source`, node:test's event stream, with paths relative to `cwd`. */
export async function* timeLines(source: AsyncIterable<TimedEvent>, cwd: string): AsyncGenerator<string, void> {
  const start = performance.now();
  const perFile = new Map<string, number>();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data;
    // Nested tests are already inside their parent's duration.
    if (!data || data.nesting !== 0 || !data.file) continue;
    perFile.set(data.file, (perFile.get(data.file) ?? 0) + (data.details?.duration_ms ?? 0));
  }
  const rows = [...perFile].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [file, ms] of rows) {
    const rel = path.relative(cwd, file).split(path.sep).join('/');
    yield `${(ms / 1000).toFixed(1).padStart(7)} s  ${rel.startsWith('..') ? file : rel}\n`;
  }
  yield `files ${rows.length} · wall ${((performance.now() - start) / 1000).toFixed(1)} s\n`;
}
