// The config-time half of lib/endpoints.ts: the env name of a component and the problems with the
// `{endpoint.<c>}` / `{backing.<n>.*}` placeholders a config's templates use. Imports nothing that
// reads job state, so config.ts can import it (endpoints.ts would cycle through jobs.ts).
import { isManaged } from './backing-config.ts';

/** FORGE_PORT_<C> / FORGE_ENDPOINT_<C>'s `<C>`: the name upper-cased, anything outside A-Z 0-9 as `_`. */
export const envName = (component: string): string => component.toUpperCase().replace(/[^A-Z0-9]/g, '_');

const isMap = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const PLACEHOLDER = /\{(endpoint|backing)\.([^{}]*)\}/g;

/**
 * Config problems with the endpoint placeholders and env names, for `forge config validate`,
 * doctor, init and Settings: an `{endpoint.X}` naming no service or app component, a
 * `{backing.X.url|port}` naming no entry, `{backing.X.port}` on an entry with no port, and two
 * components whose env names collide. Never shows a url.
 */
export function placeholderProblems(c: any): string[] {
  const problems: string[] = [];
  const components: any[] = Array.isArray(c?.components) ? c.components.filter((x: unknown) => isMap(x) && typeof x.name === 'string') : [];
  const bearing = components.filter((x) => x.kind === 'service' || x.kind === 'app').map((x) => x.name as string);
  const backing: any[] = Array.isArray(c?.backing) ? c.backing.filter((x: unknown) => isMap(x) && typeof x.name === 'string') : [];
  const templates: [string, unknown][] = [
    ...Object.entries(isMap(c?.commands) ? c.commands : {}).map(([k, v]): [string, unknown] => [`commands.${k}`, v]),
    ...components.flatMap((x) => Object.entries(isMap(x.commands) ? x.commands : {}).map(([k, v]): [string, unknown] => [`components "${x.name}".commands.${k}`, v])),
    ...(Array.isArray(c?.worktrees?.setup) ? c.worktrees.setup.map((v: unknown, i: number): [string, unknown] => [`worktrees.setup[${i}]`, v]) : []),
  ];
  for (const [at, template] of templates) {
    if (typeof template !== 'string') continue;
    for (const m of template.matchAll(PLACEHOLDER)) {
      const [whole, kind, rest] = m;
      if (kind === 'endpoint') {
        if (!bearing.includes(rest)) problems.push(`${at} uses ${whole}, which is not a service or app component`);
        continue;
      }
      const dot = rest.lastIndexOf('.');
      const name = dot < 0 ? rest : rest.slice(0, dot);
      const field = dot < 0 ? '' : rest.slice(dot + 1);
      if (field !== 'url' && field !== 'port') {
        problems.push(`${at} uses ${whole}; a backing placeholder is {backing.<name>.url} or {backing.<name>.port}`);
        continue;
      }
      const entry = backing.find((e) => e.name === name);
      if (!entry) problems.push(`${at} uses ${whole}, which names no backing entry`);
      else if (field === 'port' && (!isManaged(entry) || !Array.isArray(entry.ports) || !entry.ports.length))
        problems.push(`${at} uses ${whole}, but backing "${name}" is ${isManaged(entry) ? 'managed with no ports' : 'external'} and has no host port`);
    }
  }
  const byEnv = new Map<string, string>();
  for (const name of bearing) {
    const env = envName(name);
    const prev = byEnv.get(env);
    if (prev !== undefined && prev !== name) problems.push(`components "${prev}" and "${name}" share the environment name FORGE_PORT_${env}`);
    else byEnv.set(env, name);
  }
  return problems;
}
