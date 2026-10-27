// A job's endpoints: the address of each port-bearing component (lib/engine/environment/ports.ts) and the host port of
// each backing service (lib/engine/environment/backing.ts), as the `{endpoint.<c>}` / `{backing.<n>.*}` placeholders
// and the FORGE_PORT_<C> / FORGE_ENDPOINT_<C> variables configured commands get, as the briefs and
// the dashboard list them, and as the config sinks of #196 will read them.
import { entriesOrNone, envPrefix, readJobRecord, readSharedRecord } from './backing.ts';
import { isManaged } from '#core/config/validators/backing.ts';
import { dbEntries, readDbRecord } from './backing-db.ts';
import { envName, placeholderProblems } from '#core/config/validators/endpoints.ts';
import { portBearing } from './ports.ts';
import type { ComponentConfig, Config, Job } from '#core/types.ts';

// The config-time half lives in endpoints-config.ts, a leaf module config.ts can import without
// a cycle through backing.ts and jobs.ts; both names stay reachable from here.
export { envName, placeholderProblems };

export interface JobEndpoints {
  /** Every port-bearing component whose port is allocated, in portBearing order. */
  components: { name: string; port: number; url: string }[];
  /** Every `backing:` entry; `port` is the host port of its first container port, null until allocated or for an external entry. */
  backing: { name: string; port: number | null; hasUrl: boolean }[];
}

const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;

/** The port `name` holds: `job.ports[name]`, or `job.port` for the first entry of a job with `port` but no `ports` (a v13 job). */
function portOf(job: Pick<Job, 'port' | 'ports'>, name: string, first: boolean): number | null {
  const p = job.ports[name] ?? (first && !Object.keys(job.ports).length ? job.port : null);
  return validPort(p) ? p : null;
}

/** The job's endpoints from job state, config and the backing records; nothing is probed. */
export function jobEndpoints(root: string, config: Config, job: Pick<Job, 'id' | 'port' | 'ports' | 'components'>): JobEndpoints {
  const components: JobEndpoints['components'] = [];
  portBearing(config, job).forEach((name, i) => {
    const port = portOf(job, name, i === 0);
    if (port !== null) components.push({ name, port, url: `http://localhost:${port}` });
  });
  const list = entriesOrNone(config);
  const mine = list.some((e) => e.isolation === 'per-job') ? readJobRecord(root, job.id, config) : null;
  const shared = list.some((e) => e.isolation === 'shared') ? readSharedRecord(root, config) : null;
  // A job database's url exists only once its record does (lib/engine/environment/backing-db.ts).
  const dbs = dbEntries(config).length ? readDbRecord(root, job.id, config).databases : {};
  const backing = list.map((e) => {
    if (!isManaged(e)) return { name: e.name, port: null, hasUrl: Boolean(e.url) };
    const rec = (e.isolation === 'shared' ? shared : mine)?.ports[e.name];
    const first = e.ports?.[0];
    const p = rec && first !== undefined ? rec[String(first)] : undefined;
    return { name: e.name, port: validPort(p) ? p : null, hasUrl: Boolean(rec && e.url && (!e.database || dbs[e.name])) };
  });
  return { components, backing };
}

/**
 * The placeholder values: `endpoint.<c>` (`http://localhost:<port>`, no trailing slash) and
 * `backing.<n>.port`. With `shell`, `backing.<n>.url` is a quoted reference to the env variable,
 * never the url's text (it can hold credentials, and command text is logged); without it the
 * key is left out, and the reader takes the url from the environment.
 */
export function endpointPlaceholders(ep: JobEndpoints, opts: { shell: boolean }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of ep.components) out[`endpoint.${c.name}`] = c.url;
  for (const b of ep.backing) {
    if (b.port !== null) out[`backing.${b.name}.port`] = String(b.port);
    if (opts.shell && b.hasUrl) out[`backing.${b.name}.url`] = `"$${envPrefix(b.name)}_URL"`;
  }
  return out;
}

/** FORGE_PORT_<C> and FORGE_ENDPOINT_<C> per allocated component. */
export function endpointEnv(ep: JobEndpoints): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of ep.components) {
    out[`FORGE_PORT_${envName(c.name)}`] = String(c.port);
    out[`FORGE_ENDPOINT_${envName(c.name)}`] = c.url;
  }
  return out;
}

/**
 * What `{port}`, `$PORT` and `$FORGE_PORT` hold for a command: the port of the component it runs
 * for when that component has one, else `job.port` for a root command, and nothing for a member
 * repo's command (its component is in another repo and holds no job port).
 */
export function commandPort(config: Config, job: Pick<Job, 'port' | 'ports' | 'components'>, component: ComponentConfig | null): number | null {
  if (component) {
    const names = portBearing(config, job);
    const i = names.indexOf(component.name);
    if (i >= 0) {
      const p = portOf(job, component.name, i === 0);
      if (p !== null) return p;
    }
    if (component.repo !== undefined && component.repo !== null) return null;
  }
  return validPort(job.port) ? job.port : null;
}
