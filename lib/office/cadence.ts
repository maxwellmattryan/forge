// When the pool runs the Office pass (`forge office pass`, lib/office/mandates/pass.ts): every
// `foreman.cadence` minutes, at start, when a mandate file changes and when a job in a mandate settles.
// Pure rules plus one cheap stat of the mandates dir, so the pool's tick can ask them every second.
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
