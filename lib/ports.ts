// Job ports: one stable port per port-bearing component (lib/endpoints.ts turns them into
// placeholders and env), chosen with the worktree under the same lock as backing ports.
import { takenPorts } from './backing.ts';
import { jobComponent } from './core/config/components.ts';
import { isActive, listJobs } from './core/job/store.ts';
import type { Config, Job } from './core/types.ts';
import { ForgeError } from './core/errors.ts';

/**
 * The names a job holds a port under, in config order, with the job's own component first so
 * `job.port` is the port of the component the job builds. Libraries listen on nothing; a repo with
 * no service or app component gets the single `dev` entry, which is what every job had before.
 */
export function portBearing(config: Pick<Config, 'components'>, job: Pick<Job, 'services'>): string[] {
  const names = (config.components ?? []).filter((c) => c && (c.kind === 'service' || c.kind === 'app') && typeof c.name === 'string').map((c) => c.name);
  const own = jobComponent(config, job)?.name;
  const ordered = own !== undefined && names.includes(own) ? [own, ...names.filter((n) => n !== own)] : names;
  return ordered.length ? [...new Set(ordered)] : ['dev'];
}

const inRange = (config: Config, p: unknown): p is number => Number.isInteger(p) && (p as number) >= config.ports.base && (p as number) < config.ports.base + config.ports.span;

/**
 * One port per entry of portBearing, under the caller's portsLock. Every other active job's `port`
 * and `ports` and every backing port are taken; an entry keeps its port while it is free and in
 * range, a job with `port` but no `ports` (a v13 job) keeps it as its first entry's, and a key
 * naming no current entry is dropped. Throws, recording nothing, when the range is short.
 */
export function allocatePorts(root: string, config: Config, job: Pick<Job, 'id' | 'port' | 'ports' | 'services'>): Record<string, number> {
  const names = portBearing(config, job);
  const taken = new Set<number>(takenPorts(root, config));
  for (const j of listJobs(root)) {
    if (!isActive(j) || j.id === job.id) continue;
    if (j.port) taken.add(j.port);
    for (const p of Object.values(j.ports)) taken.add(p);
  }
  const out: Record<string, number> = {};
  // Kept first, so a new assignment never takes a port a kept entry still needs.
  names.forEach((name, i) => {
    const prev = job.ports[name] ?? (i === 0 && !Object.keys(job.ports).length ? job.port : undefined);
    if (inRange(config, prev) && !taken.has(prev)) taken.add((out[name] = prev));
  });
  const end = config.ports.base + config.ports.span;
  let next = config.ports.base;
  for (const name of names) {
    if (out[name] !== undefined) continue;
    while (next < end && taken.has(next)) next++;
    if (next >= end) throw new ForgeError(`no free port in ${config.ports.base}-${end - 1} for ${job.id} (${names.length} needed): raise ports.span in .forge/config.yml or finish jobs holding ports`);
    taken.add((out[name] = next));
  }
  // In entry order, whatever order the kept ones were found in.
  return Object.fromEntries(names.map((n) => [n, out[n]]));
}
