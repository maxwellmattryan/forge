// backing: validation, apart from lib/engine/environment/backing.ts so lib/core/config/validate.ts and lib/core/job/schema.ts can import it
// without pulling in the job store (which imports config/load.ts). Every value here reaches `docker` as an
// argument or an env-file line, so the shapes are strict: no leading `-`, a fixed charset, no newlines.
import { globProblem } from './policy-check.ts';
import { isMap, kind, show } from '../../shape.ts';

/** How a backing service is shared: a container per job, one per project, or an address run elsewhere. */
export const BACKING_ISOLATIONS = ['per-job', 'shared', 'external'] as const;

/** The database engines a shared entry's `database` can name (lib/engine/environment/backing-db.ts). */
export const BACKING_DB_ENGINES = ['postgres'] as const;
/** A Postgres role or database name Forge writes into SQL, always double-quoted after this check. */
export const PG_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const DB_KEYS = new Set(['engine', 'migrate', 'seed', 'inputs']);
const MAX_DB_COMMAND = 2000;
const MAX_DB_INPUTS = 64;

const BACKING_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VOLUME = /^\/[A-Za-z0-9._/-]*$/;
const MAX_PORTS = 8;
const MAX_VOLUMES = 8;
const MAX_URL = 500;
const KEYS = new Set(['name', 'isolation', 'image', 'ports', 'env', 'volumes', 'url', 'database']);
const MANAGED_ONLY = ['image', 'ports', 'env', 'volumes'] as const;


/** Whether an entry runs a container Forge manages (per-job or shared). */
export function isManaged(e: { isolation?: unknown }): boolean {
  return e.isolation === 'per-job' || e.isolation === 'shared';
}

/** Why a url string is unusable, or null: empty, too long, or holding whitespace or a control character. Never echoes the url. */
function urlProblem(url: unknown): string | null {
  if (typeof url !== 'string' || !url || url.length > MAX_URL || /[\s\x00-\x1f\x7f]/.test(url))
    return `must be a non-empty string of at most ${MAX_URL} characters with no whitespace or control characters (got ${kind(url)})`;
  return null;
}

function portsProblems(at: string, ports: unknown): string[] {
  if (ports === undefined) return [];
  if (!Array.isArray(ports) || ports.length > MAX_PORTS) return [`${at}.ports must be a list of at most ${MAX_PORTS} ports (got ${show(ports)})`];
  const problems: string[] = [];
  const seen = new Set<number>();
  ports.forEach((p, i) => {
    if (!Number.isInteger(p) || p < 1 || p > 65535) problems.push(`${at}.ports[${i}] must be an integer from 1 to 65535 (got ${show(p)})`);
    else if (seen.has(p)) problems.push(`${at}.ports[${i}] repeats ${p}`);
    else seen.add(p);
  });
  return problems;
}

function envProblems(at: string, env: unknown): string[] {
  if (env === undefined) return [];
  if (!isMap(env)) return [`${at}.env must be a map of names to values`];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    // The key is shown; a value never is, since env values are where credentials live.
    if (!ENV_KEY.test(k)) problems.push(`${at}.env key ${show(k)} must match ${ENV_KEY.source}`);
    else if (!(typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) problems.push(`${at}.env.${k} must be a string, number or boolean`);
    else if (/[\0\r\n]/.test(String(v))) problems.push(`${at}.env.${k} must not contain a NUL, CR or LF`);
  }
  return problems;
}

function volumesProblems(at: string, volumes: unknown): string[] {
  if (volumes === undefined) return [];
  if (!Array.isArray(volumes) || volumes.length > MAX_VOLUMES) return [`${at}.volumes must be a list of at most ${MAX_VOLUMES} container paths (got ${show(volumes)})`];
  const problems: string[] = [];
  const seen = new Set<string>();
  volumes.forEach((v, i) => {
    if (typeof v !== 'string' || !VOLUME.test(v) || v.split('/').includes('..')) problems.push(`${at}.volumes[${i}] must be an absolute container path of letters, digits and ._/- with no .. segment (got ${show(v)})`);
    else if (seen.has(v)) problems.push(`${at}.volumes[${i}] repeats ${show(v)}`);
    else seen.add(v);
  });
  return problems;
}

/**
 * A managed url template may name {host}, {port} (with at least one port) and {port_<n>} for n in
 * ports; with `withDatabase` also {user}, {password} and {database}, which Forge fills per job.
 */
function templateProblems(at: string, url: unknown, ports: unknown, withDatabase = false): string[] {
  if (url === undefined) return [];
  const bad = urlProblem(url);
  if (bad) return [`${at}.url ${bad}`];
  const list = Array.isArray(ports) ? ports : [];
  const problems: string[] = [];
  for (const m of (url as string).matchAll(/\{([^{}]*)\}/g)) {
    const name = m[1];
    if (name === 'host') continue;
    if (withDatabase && (name === 'user' || name === 'password' || name === 'database')) continue;
    if (name === 'port') {
      if (!list.length) problems.push(`${at}.url uses {port} but the entry has no ports`);
      continue;
    }
    const n = /^port_(\d+)$/.exec(name);
    if (n && list.includes(Number(n[1]))) continue;
    // The placeholder is part of the url, so it is named only when it looks like one.
    const shown = /^[a-z0-9_]{1,20}$/.test(name) ? `{${name}}` : '(not shown)';
    problems.push(`${at}.url placeholder ${shown} is not {host}, {port} or {port_<n>} for a port in ports${withDatabase ? ', {user}, {password} or {database}' : ''}`);
  }
  return problems;
}

/** A migrate or seed command: one line, bounded; the value is never echoed (it may carry credentials). */
const dbCommandOk = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_DB_COMMAND && !/[\0\r\n]/.test(v);

/** Every problem with a shared entry's `database` (absent: none). */
function databaseProblems(at: string, e: Record<string, any>): string[] {
  const db = e.database;
  if (db === undefined) return [];
  if (e.isolation !== 'shared') return [`${at}.database is only for a shared entry`];
  if (!isMap(db) || db.engine === undefined) return [`${at}.database must be a map with engine`];
  const problems: string[] = [];
  for (const k of Object.keys(db)) if (!DB_KEYS.has(k)) problems.push(`${at}.database has unknown key ${show(k)}`);
  if (!(BACKING_DB_ENGINES as readonly unknown[]).includes(db.engine)) problems.push(`${at}.database.engine must be one of ${BACKING_DB_ENGINES.join(' | ')} (got ${show(db.engine)})`);
  for (const k of ['migrate', 'seed'] as const)
    if (db[k] !== undefined && !dbCommandOk(db[k])) problems.push(`${at}.database.${k} must be a non-empty string of at most ${MAX_DB_COMMAND} characters with no NUL, CR or LF`);
  if (db.inputs !== undefined) {
    if (!Array.isArray(db.inputs) || db.inputs.length > MAX_DB_INPUTS) problems.push(`${at}.database.inputs must be a list of at most ${MAX_DB_INPUTS} paths or globs`);
    else
      for (const g of db.inputs) {
        const p = globProblem(g, `${at}.database.inputs`);
        if (p) problems.push(p);
      }
  }
  if (!Array.isArray(e.ports) || !e.ports.length) problems.push(`${at}.database needs ports`);
  if (typeof e.url !== 'string' || !['{user}', '{password}', '{database}'].every((p) => e.url.includes(p))) problems.push(`${at}.database needs a url with {user}, {password} and {database}`);
  const user = isMap(e.env) ? e.env.POSTGRES_USER : undefined;
  if (user !== undefined && (typeof user !== 'string' || !PG_IDENT.test(user))) problems.push(`${at}.env.POSTGRES_USER must match ${PG_IDENT.source} when database is set`);
  return problems;
}

/** Every problem with `backing`, in the form validateConfig reports. */
export function backingProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const list = cfg.backing;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return [`backing must be a list (got ${kind(list)})`];
  const problems: string[] = [];
  const names = new Map<string, number>();
  list.forEach((e: unknown, i: number) => {
    const at = `backing[${i}]`;
    if (!isMap(e)) return problems.push(`${at} must be a map with name and isolation`);
    for (const k of Object.keys(e)) if (!KEYS.has(k)) problems.push(`${at} has unknown key ${show(k)}`);
    if (typeof e.name !== 'string' || !BACKING_NAME.test(e.name)) problems.push(`${at}.name must match ${BACKING_NAME.source} (got ${show(e.name)})`);
    else if (names.has(e.name)) problems.push(`${at}.name repeats backing[${names.get(e.name)}].name ${show(e.name)}`);
    else names.set(e.name, i);
    if (!(BACKING_ISOLATIONS as readonly unknown[]).includes(e.isolation)) {
      problems.push(`${at}.isolation must be one of ${BACKING_ISOLATIONS.join(' | ')} (got ${show(e.isolation)})`);
      return;
    }
    problems.push(...databaseProblems(at, e));
    if (e.isolation === 'external') {
      for (const k of MANAGED_ONLY) if (e[k] !== undefined) problems.push(`${at}.${k} is only for a per-job or shared entry`);
      const bad = urlProblem(e.url);
      if (bad) problems.push(`${at}.url ${e.url === undefined ? 'is required for an external entry' : bad}`);
      return;
    }
    if (typeof e.image !== 'string' || !IMAGE.test(e.image)) problems.push(`${at}.image must be an image reference matching ${IMAGE.source} (got ${show(e.image)})`);
    problems.push(...portsProblems(at, e.ports), ...envProblems(at, e.env), ...volumesProblems(at, e.volumes), ...templateProblems(at, e.url, e.ports, e.isolation === 'shared' && e.database !== undefined));
  });
  // An empty list keeps today's shape-only check of dependsOn backing edges.
  if (list.length && Array.isArray(cfg.components)) {
    cfg.components.forEach((comp: unknown, i: number) => {
      if (!isMap(comp) || !Array.isArray(comp.dependsOn)) return;
      comp.dependsOn.forEach((d: unknown, j: number) => {
        if (isMap(d) && typeof d.backing === 'string' && !names.has(d.backing.trim()))
          problems.push(`components[${i}].dependsOn[${j}].backing names no backing entry ${show(d.backing)}`);
      });
    });
  }
  return problems;
}
