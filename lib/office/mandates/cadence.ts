// When the pool runs the Office pass (`forge office pass`, ./pass.ts): every
// `foreman.cadence` minutes, at start, when a mandate file changes and when a job in a mandate settles.
// Pure rules plus one cheap stat of the mandates dir, so the pool's tick can ask them every poll, and
// the scheduler that runs one pass child at a time on them.
// docs/architecture/daemon.md › Periodic Office pass.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import type { Config, Job } from '#core/types.ts';

const MINUTE_MS = 60 * 1000;
const DEFAULT_CADENCE = 10;

/** foreman.cadence in minutes: an integer 1-1440, else 10. */
export function cadenceMinutes(config: Pick<Config, 'foreman'>): number {
  const c = config.foreman?.cadence;
  return Number.isInteger(c) && (c as number) >= 1 && (c as number) <= 1440 ? (c as number) : DEFAULT_CADENCE;
}

/** foreman.cadence in milliseconds. */
export const cadenceMs = (config: Pick<Config, 'foreman'>): number => cadenceMinutes(config) * MINUTE_MS;

/** A pass is due when something asked for one, or a cadence has gone by since the last. */
export function passDue(o: { now: number; last: number; cadenceMs: number; wanted: boolean }): boolean {
  return o.wanted || o.now - o.last >= o.cadenceMs;
}

const SETTLED = new Set(['done', 'cancelled', 'failed', 'waiting']);

/** A job session's result asks for a pass when its job is in a mandate and has settled: done, cancelled, failed or waiting. */
export function passWantedAfter(job: Pick<Job, 'mandate' | 'state'> | null | undefined): boolean {
  return typeof job?.mandate === 'string' && job.mandate !== '' && SETTLED.has(job.state);
}

/** The pool's Office pass: what it asks of the scheduler (createPassScheduler). */
export interface PassScheduler {
  /** A pass is wanted at the next check: the pool started. */
  want(): void;
  /** A job session's result: a pass is wanted when the job is in a mandate and has settled (passWantedAfter). */
  after(job: Pick<Job, 'mandate' | 'state'> | null): void;
  /** One tick, under this tick's config: starts a pass child when one is due, the foreman is on and none runs. */
  check(c: Pick<Config, 'foreman'>, now?: number): void;
}

/**
 * The pool's Office pass schedule: one child at a time (`run`), at start, when a mandate file changes,
 * after a mandate job settles and every foreman.cadence minutes. When the child ends, `done` runs (the
 * pool ticks, so the direct request it queued turns the office at once), and a failure is logged once
 * per distinct message.
 */
export function createPassScheduler(root: string, o: { run: (root: string) => Promise<string | null>; done: () => void; log: (message: string) => void }): PassScheduler {
  let passing = false;
  let wanted = false;
  let last = 0;
  let print: string | null = null;
  let lastError: string | null = null;
  return {
    want: () => void (wanted = true),
    after: (job) => void (passWantedAfter(job) && (wanted = true)),
    check(c, now = Date.now()) {
      if (c.foreman?.enabled !== true || passing) return;
      const p = mandatesPrint(root);
      if (print !== null && p !== print) wanted = true;
      print = p;
      if (!passDue({ now, last, cadenceMs: cadenceMs(c), wanted })) return;
      wanted = false;
      passing = true;
      void o
        .run(root)
        .catch((e: unknown) => (e as Error)?.message ?? String(e))
        .then((err) => {
          passing = false;
          last = Date.now();
          if (err !== null && err !== lastError) o.log(`office pass failed: ${err}`);
          lastError = err;
          o.done();
        });
    },
  };
}

/** The names, sizes and mtimes of the mandate files: it changes when a mandate is added, rewritten or removed. */
export function mandatesPrint(root: string): string {
  const dir = paths(root).mandates;
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return '';
  }
  return names
    .map((n) => {
      try {
        const st = fs.lstatSync(path.join(dir, n));
        return `${n}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${n}:-`;
      }
    })
    .join('|');
}
