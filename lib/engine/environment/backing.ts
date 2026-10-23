// Backing services (docs/CONFIG.md "Backing services"): databases, caches and queues jobs run
// against, as a container per job, one per project, or an address run elsewhere, driven through the
// Docker CLI. Every docker call is argv only. Env values reach `docker run` only through a 0600 env
// file in a fresh temp dir, and no error, event or result ever carries one. Teardown derives names
// from the job id and config, never from backing.json (agent-writable), and touches only containers
// and volumes whose labels say they are this root's and this job's.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backingProblems, isManaged } from '#core/config/validators/backing.ts';
import { adminOf, dbEntries, dbRecordFile, dropJobDatabase, fillDbUrl, jobDbName, jobDbPasswords, readDbRecord, removeDbRecord, upDatabase, type DatabaseOpts } from './backing-db.ts';
import { isActive, jobDir, listJobs, loadJob } from '#core/job/store.ts';
import { paths } from '#core/paths.ts';
import type { BackingEntry, BackingHealth, BackingIsolation, Config, DoctorCheck } from '#core/types.ts';
import type { BackingDbRecord, BackingDownResult, BackingRecord, BackingUpEntry } from './types.ts';
import type { DockerResult, DockerRunner } from '#integrations/docker/types.ts';
import { DOCKER_TIMEOUT_MS, dockerRun, dockerStateOf, type DockerStateName } from '#integrations/docker/runner.ts';
import { ForgeError } from '#core/errors.ts';
import { readJson, writeJsonAtomic } from '#core/os/fs.ts';
import { withLock } from '#core/os/lock.ts';
import { tail } from '#core/text.ts';

export { backingProblems, isManaged, jobDbPasswords };
export type { DatabaseOpts, DockerResult, DockerRunner };

const TIMEOUT_MS = DOCKER_TIMEOUT_MS;
/** `docker run` pulls the image on demand. */
const RUN_TIMEOUT_MS = 600_000;
const DOCTOR_TIMEOUT_MS = 5_000;
const BACKING_HOST = '127.0.0.1';

const defaultRunner: DockerRunner = dockerRun;

let activeRunner: DockerRunner = defaultRunner;

/** Swaps the runner the CLI paths use (worktree create/remove, run, doctor); returns the previous one. Tests only. */
export function setDockerRunner(runner: DockerRunner | null): DockerRunner {
  const prev = activeRunner;
  activeRunner = runner ?? defaultRunner;
  return prev;
}

// ---------- names ----------

const slugOf = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `project.name`, else the repo root's basename, lowercased to Docker's name charset. */
export function projectSlug(root: string, config: Config): string {
  return slugOf(String(config.project?.name ?? '')) || slugOf(path.basename(root)) || 'project';
}

/** The first 12 hex of sha256(realpath(root)): which checkout a container belongs to. */
export function rootLabel(root: string): string {
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // An unresolvable root still gets a stable label from its own path.
  }
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 12);
}

/** `forge-<owner>-<name>`: the owner is the job id for per-job entries and the project slug for shared ones. */
export function containerName(owner: string, name: string): string {
  return `forge-${owner}-${name}`;
}

function volumeName(owner: string, name: string, i: number): string {
  return `${containerName(owner, name)}-${i}`;
}

/** FORGE_BACKING_<NAME>: upper-cased, `-` as `_`. */
export const envPrefix = (name: string): string => `FORGE_BACKING_${name.toUpperCase().replaceAll('-', '_')}`;

/** The validated entries; an invalid backing config is refused before any docker call. */
function entries(config: Config): BackingEntry[] {
  const list = Array.isArray(config.backing) ? config.backing : [];
  if (!list.length) return [];
  const problems = backingProblems(config);
  if (problems.length) throw new ForgeError(`backing config is invalid: ${problems.join('; ')}`);
  return list;
}

/** entries() without throwing: an invalid config contributes nothing (validation reports it). */
export function entriesOrNone(config: Config): BackingEntry[] {
  try {
    return entries(config);
  } catch {
    return [];
  }
}

// ---------- records ----------

const jobRecordFile = (root: string, id: string): string => path.join(jobDir(root, id), 'backing.json');
const sharedRecordFile = (root: string): string => path.join(paths(root).runtime, 'backing.json');
const emptyRecord = (): BackingRecord => ({ v: 1, ports: {} });

/** A record file's JSON, or null when it is missing or unreadable (the session can write it). */
function readRaw(file: string): any {
  try {
    return readJson(file, null);
  } catch {
    return null;
  }
}

function inRange(config: Config, p: unknown): p is number {
  return Number.isInteger(p) && (p as number) >= config.ports.base && (p as number) < config.ports.base + config.ports.span;
}

/**
 * A record read tolerantly: an entry is kept only when its name is a current managed entry of the
 * right isolation, every port key is in that entry's ports, and every host port is in range and
 * not already used in this record. Anything else is dropped, to be allocated again.
 */
function readRecord(file: string, config: Config, isolation: BackingIsolation): BackingRecord {
  const raw = readRaw(file);
  const out = emptyRecord();
  if (!raw || typeof raw !== 'object' || !raw.ports || typeof raw.ports !== 'object') return out;
  const seen = new Set<number>();
  for (const e of entriesOrNone(config).filter((x) => x.isolation === isolation)) {
    const m = raw.ports[e.name];
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    const want = (e.ports ?? []).map(String);
    const keys = Object.keys(m);
    if (keys.length !== want.length || !want.every((k) => keys.includes(k))) continue;
    const ports: Record<string, number> = {};
    const here = new Set<number>();
    for (const k of want) if (inRange(config, m[k]) && !seen.has(m[k]) && !here.has(m[k])) here.add((ports[k] = m[k]));
    if (here.size !== want.length) continue;
    for (const p of here) seen.add(p);
    out.ports[e.name] = ports;
  }
  return out;
}

export function readJobRecord(root: string, id: string, config: Config): BackingRecord {
  return readRecord(jobRecordFile(root, id), config, 'per-job');
}

export function readSharedRecord(root: string, config: Config): BackingRecord {
  return readRecord(sharedRecordFile(root), config, 'shared');
}

/** Every in-range integer port a record file names, read raw: a stale entry may still hold a running container. */
function rawPorts(file: string, config: Config): number[] {
  const raw = readRaw(file);
  const out: number[] = [];
  if (!raw || typeof raw !== 'object' || !raw.ports || typeof raw.ports !== 'object') return out;
  for (const m of Object.values(raw.ports)) if (m && typeof m === 'object') for (const p of Object.values(m)) if (inRange(config, p)) out.push(p);
  return out;
}

function jobIds(root: string): string[] {
  const dir = paths(root).jobs;
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9._-]*$/i.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * The host ports backing services hold: every port in any job's backing.json (active or not, since a
 * cancelled job's container may still run), except `exceptId`'s, and every port in the shared record.
 */
export function takenPorts(root: string, config: Config, exceptId?: string): Set<number> {
  const taken = new Set<number>();
  for (const id of jobIds(root)) if (id !== exceptId) for (const p of rawPorts(jobRecordFile(root, id), config)) taken.add(p);
  for (const p of rawPorts(sharedRecordFile(root), config)) taken.add(p);
  return taken;
}

/** The lock every host port is handed out under: job ports (lib/engine/workspace/worktree.ts) and backing ports alike. */
export const portsLock = (root: string): string => path.join(paths(root).locks, 'ports');

/**
 * Host ports for the job's per-job entries and the project's shared ones, reusing every valid
 * existing assignment, under portsLock (which job ports take too), so no port is handed out twice. Skips every
 * active job's `port` and `ports`, every other job's backing ports and the job's own.
 */
export function allocateBacking(root: string, config: Config, job: { id: string; port?: number | null; ports?: Record<string, number> }): { job: BackingRecord; shared: BackingRecord } {
  const list = entries(config);
  return withLock(portsLock(root), () => {
    const taken = new Set<number>(takenPorts(root, config, job.id));
    // The shared record is re-validated below, so its raw ports must not block its own reuse.
    for (const p of rawPorts(sharedRecordFile(root), config)) taken.delete(p);
    for (const j of listJobs(root)) {
      if (!isActive(j)) continue;
      if (j.port) taken.add(j.port);
      for (const p of Object.values(j.ports)) taken.add(p);
    }
    if (job.port) taken.add(job.port);
    for (const p of Object.values(job.ports ?? {})) taken.add(p);
    const oldShared = readSharedRecord(root, config);
    const oldJob = readJobRecord(root, job.id, config);
    const shared = emptyRecord();
    const mine = emptyRecord();
    const plan: [BackingEntry, BackingRecord, BackingRecord][] = list.filter(isManaged).map((e) => (e.isolation === 'shared' ? [e, oldShared, shared] : [e, oldJob, mine]));
    // Keep first, so a new assignment never takes a port a kept one still needs.
    for (const [e, old, rec] of plan) {
      const prev = old.ports[e.name];
      if (prev && Object.values(prev).every((p) => !taken.has(p))) {
        rec.ports[e.name] = prev;
        for (const p of Object.values(prev)) taken.add(p);
      }
    }
    const end = config.ports.base + config.ports.span;
    let next = config.ports.base;
    const free = (): number => {
      while (next < end && taken.has(next)) next++;
      if (next >= end) throw new ForgeError(`no free port in ${config.ports.base}-${end - 1} for backing services`);
      taken.add(next);
      return next;
    };
    for (const [e, , rec] of plan) {
      if (rec.ports[e.name]) continue;
      rec.ports[e.name] = Object.fromEntries((e.ports ?? []).map((p) => [String(p), free()]));
    }
    const write = (file: string, rec: BackingRecord) => {
      if (JSON.stringify(rec) !== JSON.stringify(readRaw(file))) writeJsonAtomic(file, rec);
    };
    if (list.some((e) => e.isolation === 'per-job')) write(jobRecordFile(root, job.id), mine);
    if (list.some((e) => e.isolation === 'shared')) write(sharedRecordFile(root), shared);
    return { job: mine, shared };
  });
}

// ---------- env and briefs ----------

function fillUrl(template: string, ports: Record<string, number>, order: number[]): string {
  return template.replace(/\{(host|port|port_\d+)\}/g, (m, k: string) => {
    if (k === 'host') return BACKING_HOST;
    if (k === 'port') return order.length ? String(ports[String(order[0])]) : m;
    const v = ports[k.slice('port_'.length)];
    return v === undefined ? m : String(v);
  });
}

/**
 * An entry's FORGE_BACKING_<NAME>_* variables. An entry with `database` gets its url only once the
 * job's record holds that entry: then {user} and {database} are the job's derived names and
 * {password} its generated password.
 */
function entryEnv(e: BackingEntry, rec: BackingRecord | null, db: { id: string; rec: BackingDbRecord } | null): Record<string, string> {
  const pre = envPrefix(e.name);
  if (e.isolation === 'external') return e.url ? { [`${pre}_URL`]: e.url } : {};
  const ports = rec?.ports[e.name];
  // Never allocated: the services are not up yet, so there is nothing to point at.
  if (!ports) return {};
  const order = e.ports ?? [];
  const env: Record<string, string> = { [`${pre}_HOST`]: BACKING_HOST };
  if (order.length) env[`${pre}_PORT`] = String(ports[String(order[0])]);
  for (const p of order) env[`${pre}_PORT_${p}`] = String(ports[String(p)]);
  if (e.url && !e.database) env[`${pre}_URL`] = fillUrl(e.url, ports, order);
  const mine = e.database && db ? db.rec.databases[e.name] : undefined;
  if (e.url && mine) env[`${pre}_URL`] = fillDbUrl(fillUrl(e.url, ports, order), jobDbName(db!.id), mine.password, jobDbName(db!.id));
  return env;
}

/** The job's database record, or null when no entry has `database` (then nothing is read). */
const dbRecordFor = (root: string, config: Config, id: string): { id: string; rec: BackingDbRecord } | null => (dbEntries(config).length ? { id, rec: readDbRecord(root, id, config) } : null);

/** FORGE_BACKING_<NAME>_{HOST,PORT,PORT_<n>,URL} for every entry; `{}` when there are none. */
export function backingEnv(root: string, config: Config, job: { id: string }): Record<string, string> {
  const list = entriesOrNone(config);
  if (!list.length) return {};
  const mine = list.some((e) => e.isolation === 'per-job') ? readJobRecord(root, job.id, config) : null;
  const shared = list.some((e) => e.isolation === 'shared') ? readSharedRecord(root, config) : null;
  const db = dbRecordFor(root, config, job.id);
  return Object.assign({}, ...list.map((e) => entryEnv(e, e.isolation === 'shared' ? shared : mine, db)));
}

/** The brief line naming each entry, its isolation and its loopback port; never an env value or a url. */
export function backingLine(config: Config, jobRecord: BackingRecord | null, sharedRecord: BackingRecord | null): string | null {
  const list = entriesOrNone(config);
  if (!list.length) return null;
  const parts = list.map((e) => {
    const rec = e.isolation === 'shared' ? sharedRecord : e.isolation === 'per-job' ? jobRecord : null;
    const first = e.ports?.[0];
    const host = first !== undefined ? rec?.ports[e.name]?.[String(first)] : undefined;
    return `${e.name} ${e.isolation}${host ? ` ${BACKING_HOST}:${host}` : ''}`;
  });
  return `Backing services: ${parts.join('; ')}. Reach them through $FORGE_BACKING_<NAME>_* in configured commands.`;
}

// ---------- docker ----------

export type DockerState = { state: DockerStateName; version?: string };

export function dockerState(runner: DockerRunner = activeRunner, timeoutMs = TIMEOUT_MS): DockerState {
  const r = runner(['version', '--format', '{{.Server.Version}}'], { timeoutMs });
  const state = dockerStateOf(r);
  return state === 'ok' ? { state, version: r.stdout.trim() } : { state };
}

const managedNames = (list: BackingEntry[]): string => list.filter(isManaged).map((e) => e.name).join(', ');

/** Docker missing or stopped as an error whose code says which, so callers never read the message. */
function dockerError(s: DockerState, list: BackingEntry[]): ForgeError {
  return s.state === 'missing'
    ? new ForgeError(`docker not found on PATH: install Docker to run backing services ${managedNames(list)}`, 'docker_missing')
    : new ForgeError('docker is installed but its daemon is not reachable: start Docker (e.g. Docker Desktop, colima start) and retry', 'docker_stopped');
}

/** A failed docker call in plain words: the subcommand and the last 5 lines of its stderr, never the argv. */
function failure(sub: string, r: DockerResult): string {
  const why = tail(r.stderr || r.stdout || `exited ${r.status}`, 5).trim();
  return `docker ${sub} failed: ${why}`;
}

class DockerFailure extends Error {}

type Labels = Record<string, string>;
type Found = { exists: false } | { exists: true; running: boolean; health: BackingHealth; labels: Labels };

const HEALTH: readonly string[] = ['healthy', 'unhealthy', 'starting'];

function inspectContainer(runner: DockerRunner, name: string): Found {
  const r = runner(['inspect', '--type', 'container', '--format', '{{json .State.Running}} {{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}} {{json .Config.Labels}}', name]);
  if (!r.ok) {
    if (/No such/i.test(r.stderr)) return { exists: false };
    throw new DockerFailure(failure('inspect', r));
  }
  // Split on the first two spaces only: label values may contain spaces.
  const line = r.stdout.trim();
  const a = line.indexOf(' ');
  const b = a < 0 ? -1 : line.indexOf(' ', a + 1);
  try {
    const running = JSON.parse(a < 0 ? line : line.slice(0, a)) === true;
    const status = a < 0 ? null : JSON.parse(b < 0 ? line.slice(a + 1) : line.slice(a + 1, b));
    const labels = b < 0 ? null : JSON.parse(line.slice(b + 1));
    // Docker's `none` and anything unknown read as no healthcheck.
    const health = typeof status === 'string' && HEALTH.includes(status) ? (status as BackingHealth) : null;
    return { exists: true, running, health, labels: labels && typeof labels === 'object' ? labels : {} };
  } catch {
    throw new DockerFailure(`docker inspect failed: unreadable output for ${name}`);
  }
}

function inspectVolume(runner: DockerRunner, name: string): { exists: false } | { exists: true; labels: Labels } {
  const r = runner(['volume', 'inspect', '--format', '{{json .Labels}}', name]);
  if (!r.ok) {
    if (/No such/i.test(r.stderr)) return { exists: false };
    throw new DockerFailure(failure('volume inspect', r));
  }
  try {
    const labels = JSON.parse(r.stdout.trim());
    return { exists: true, labels: labels && typeof labels === 'object' ? labels : {} };
  } catch {
    return { exists: true, labels: {} };
  }
}

/** The labels Forge puts on everything it creates for this entry. */
function ownLabels(root: string, e: BackingEntry, jobId: string | null): Labels {
  return { 'forge.root': rootLabel(root), 'forge.backing': e.name, 'forge.isolation': e.isolation, ...(jobId ? { 'forge.job': jobId } : {}) };
}

const matches = (have: Labels, want: Labels): boolean => Object.entries(want).every(([k, v]) => have[k] === v);
const labelArgs = (labels: Labels): string[] => Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);

/** `docker run` with env only through a 0600 file in a fresh temp dir, removed whatever happens. */
function runContainer(runner: DockerRunner, args: string[], env: BackingEntry['env'], image: string): DockerResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-backing-'));
  try {
    const file = path.join(dir, 'env');
    const body = Object.entries(env ?? {})
      .map(([k, v]) => `${k}=${String(v)}\n`)
      .join('');
    fs.writeFileSync(file, body, { mode: 0o600 });
    return runner([...args, '--env-file', file, image], { timeoutMs: RUN_TIMEOUT_MS });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One managed service brought up: run when missing, start when stopped, nothing when running.
 * `attempt.action` says what it set out to do, so a failure reports that rather than a guess.
 */
function ensure(root: string, runner: DockerRunner, e: BackingEntry, owner: string, jobId: string | null, ports: Record<string, number>, attempt: { action: BackingUpEntry['action'] }): BackingUpEntry['action'] {
  const name = containerName(owner, e.name);
  const labels = ownLabels(root, e, jobId);
  const whose = jobId ? "this job's" : "this project's";
  const found = inspectContainer(runner, name);
  if (found.exists) {
    if (!matches(found.labels, labels)) throw new DockerFailure(`container ${name} exists and is not ${whose}`);
    if (found.running) return 'running';
    attempt.action = 'started';
    const r = runner(['start', name]);
    if (!r.ok) throw new DockerFailure(failure('start', r));
    return 'started';
  }
  attempt.action = 'created';
  // Volumes are created with the same labels first, so a same-named volume of another checkout is never mounted.
  const vols = (e.volumes ?? []).map((p, i) => ({ vol: volumeName(owner, e.name, i), path: p }));
  for (const { vol } of vols) {
    const v = inspectVolume(runner, vol);
    if (v.exists && !matches(v.labels, labels)) throw new DockerFailure(`volume ${vol} exists and is not ${whose}`);
    if (!v.exists) {
      const r = runner(['volume', 'create', ...labelArgs(labels), vol]);
      if (!r.ok) throw new DockerFailure(failure('volume create', r));
    }
  }
  const args = [
    'run',
    '-d',
    '--name',
    name,
    ...labelArgs(labels),
    ...(e.ports ?? []).flatMap((p) => ['-p', `${BACKING_HOST}:${ports[String(p)]}:${p}`]),
    ...vols.flatMap(({ vol, path: p }) => ['-v', `${vol}:${p}`]),
  ];
  const r = runContainer(runner, args, e.env, e.image!);
  if (!r.ok) throw new DockerFailure(failure('run', r));
  return 'created';
}

/**
 * Brings every entry up for the job, idempotently. Probes Docker once; shared entries serialise on
 * a lock so they start at most once. One failure is reported and the rest still run. Then, once
 * every service is up (migrate and seed may need them all), each shared entry with `database` that
 * came up gets the job's database (lib/engine/environment/backing-db.ts), with build commands run through `db`.
 */
export function backingUp(
  root: string,
  config: Config,
  job: { id: string; port?: number | null; ports?: Record<string, number> },
  runner: DockerRunner = activeRunner,
  db?: DatabaseOpts,
): BackingUpEntry[] {
  const list = entries(config);
  if (!list.length) return [];
  const external = (e: BackingEntry): BackingUpEntry => ({ name: e.name, isolation: e.isolation, action: 'external', ok: true });
  if (!list.some(isManaged)) return list.map(external);
  const noDb = (r: BackingUpEntry, e: BackingEntry): BackingUpEntry => (e.database ? { ...r, database: { name: jobDbName(job.id), template: null, action: 'none', template_action: 'none' } } : r);
  // Failed before any container was touched: every managed entry reports `none` with the reason.
  const unreached = (error: string) => list.map((e): BackingUpEntry => (isManaged(e) ? noDb({ name: e.name, isolation: e.isolation, action: 'none', ok: false, error }, e) : external(e)));
  const state = dockerState(runner);
  if (state.state !== 'ok') return unreached(dockerError(state, list).message);
  let recs: ReturnType<typeof allocateBacking>;
  try {
    recs = allocateBacking(root, config, job);
  } catch (err) {
    // No free port (or a lock timeout): a failed entry, so worktree create fails the job through I4 instead of throwing after the worktree is saved.
    if (!(err instanceof ForgeError)) throw err;
    return unreached(err.message);
  }
  const slug = projectSlug(root, config);
  const results = upServices(root, runner, list, job.id, slug, recs, external);
  for (const e of dbEntries(config)) {
    const i = list.indexOf(e);
    const r = results[i];
    if (!r.ok) {
      results[i] = noDb(r, e);
      continue;
    }
    const ports = recs.shared.ports[e.name] ?? {};
    const server = { runner, container: containerName(slug, e.name), admin: adminOf(e), secrets: [] };
    const up = upDatabase(root, config, job.id, e, server, fillUrl(e.url!, ports, e.ports ?? []), `${envPrefix(e.name)}_URL`, db);
    results[i] = { ...r, ...(up.error ? { ok: false, error: up.error } : {}), database: up.database, ...(up.build ? { build: up.build } : {}) };
  }
  return results;
}

/** backingUp's first pass: each container run, started or left running. */
function upServices(
  root: string,
  runner: DockerRunner,
  list: BackingEntry[],
  jobId: string,
  slug: string,
  recs: ReturnType<typeof allocateBacking>,
  external: (e: BackingEntry) => BackingUpEntry,
): BackingUpEntry[] {
  const job = { id: jobId };
  return list.map((e): BackingUpEntry => {
    if (!isManaged(e)) return external(e);
    const shared = e.isolation === 'shared';
    const attempt: { action: BackingUpEntry['action'] } = { action: 'none' };
    try {
      const go = () => ensure(root, runner, e, shared ? slug : job.id, shared ? null : job.id, (shared ? recs.shared : recs.job).ports[e.name] ?? {}, attempt);
      // A pull can take minutes, so the shared lock waits on that scale.
      const action = shared ? withLock(path.join(paths(root).locks, 'backing-shared'), go, { timeoutMs: RUN_TIMEOUT_MS + 60_000 }) : go();
      return { name: e.name, isolation: e.isolation, action, ok: true };
    } catch (err) {
      if (!(err instanceof DockerFailure) && !(err instanceof ForgeError)) throw err;
      return { name: e.name, isolation: e.isolation, action: attempt.action, ok: false, error: err.message };
    }
  });
}

/** Whether teardown has anything to do for the job: per-job entries or a job database configured, or a record left behind. */
export function hasJobBacking(root: string, config: Config, id: string): boolean {
  return (
    (Array.isArray(config.backing) && config.backing.some((e) => e?.isolation === 'per-job' || (e && typeof e === 'object' && e.database !== undefined))) ||
    fs.existsSync(jobRecordFile(root, id)) ||
    fs.existsSync(dbRecordFile(root, id))
  );
}

/**
 * Removes the job's per-job containers and their volumes, only those labelled with this root and
 * job, and drops its job databases (names derived from the job id, never read from a record), then
 * deletes backing.json and backing-db.json. On any docker or psql failure, or a stopped shared
 * container, the records are kept so a retry still works; a shared container that no longer exists
 * holds nothing to drop.
 */
export function backingDown(root: string, config: Config, id: string, runner: DockerRunner = activeRunner): BackingDownResult {
  const file = jobRecordFile(root, id);
  const all = entries(config);
  const list = all.filter((e) => e.isolation === 'per-job');
  const dbs = dbEntries(config);
  const removed: string[] = [];
  const volumes: string[] = [];
  const databases: string[] = [];
  const withDbs = dbs.length > 0 || fs.existsSync(dbRecordFile(root, id));
  const result = (ok: boolean, error?: string): BackingDownResult => ({ removed, volumes, ...(withDbs ? { databases } : {}), ok, ...(error === undefined ? {} : { error }) });
  if (list.length || dbs.length) {
    const state = dockerState(runner);
    if (state.state !== 'ok') return result(false, dockerError(state, [...list, ...dbs]).message);
    try {
      for (const e of list) {
        const labels = ownLabels(root, e, id);
        const name = containerName(id, e.name);
        const found = inspectContainer(runner, name);
        if (found.exists && matches(found.labels, labels)) {
          const r = runner(['rm', '-f', name]);
          if (!r.ok) throw new DockerFailure(failure('rm', r));
          removed.push(name);
        }
        for (let i = 0; i < (e.volumes ?? []).length; i++) {
          const vol = volumeName(id, e.name, i);
          const v = inspectVolume(runner, vol);
          if (!v.exists || !matches(v.labels, labels)) continue;
          const r = runner(['volume', 'rm', vol]);
          if (!r.ok && !/No such/i.test(r.stderr)) throw new DockerFailure(failure('volume rm', r));
          volumes.push(vol);
        }
      }
      const slug = projectSlug(root, config);
      for (const e of dbs) {
        const name = containerName(slug, e.name);
        const found = inspectContainer(runner, name);
        // Gone: the server and every database on it went with it.
        if (!found.exists) continue;
        if (!matches(found.labels, ownLabels(root, e, null))) throw new DockerFailure(`container ${name} exists and is not this project's`);
        if (!found.running) throw new DockerFailure(`container ${name} is stopped: start it (docker start ${name}) and retry to drop the job database`);
        databases.push(dropJobDatabase(root, e.name, { runner, container: name, admin: adminOf(e), secrets: jobDbPasswords(root, id, config) }, id));
      }
    } catch (err) {
      if (!(err instanceof DockerFailure) && !(err instanceof ForgeError)) throw err;
      return result(false, err.message);
    }
  }
  fs.rmSync(file, { force: true });
  removeDbRecord(root, id);
  return result(true);
}

/** Removes this root's shared containers, keeping their volumes and port record. */
export function backingDownShared(root: string, config: Config, runner: DockerRunner = activeRunner): { removed: string[] } {
  const list = entries(config).filter((e) => e.isolation === 'shared');
  const removed: string[] = [];
  if (!list.length) return { removed };
  const state = dockerState(runner);
  if (state.state !== 'ok') throw dockerError(state, list);
  const slug = projectSlug(root, config);
  try {
    for (const e of list) {
      const name = containerName(slug, e.name);
      const found = inspectContainer(runner, name);
      if (!found.exists || !matches(found.labels, ownLabels(root, e, null))) continue;
      const r = runner(['rm', '-f', name]);
      if (!r.ok) throw new DockerFailure(failure('rm', r));
      removed.push(name);
    }
  } catch (err) {
    if (err instanceof DockerFailure) throw new ForgeError(err.message, 'external');
    throw err;
  }
  return { removed };
}

/** What `forge backing stop <id>` did: containers stopped, and those it left alone and why. */
export interface BackingStopResult {
  stopped: string[];
  skipped: { name: string; reason: string }[];
  ok: boolean;
  error?: string;
}

/**
 * `docker stop` on the job's per-job containers, only those labelled with this root and job. Volumes,
 * records and shared containers are never touched. Idempotent: a missing or stopped container is skipped.
 */
export function backingStop(root: string, config: Config, id: string, runner: DockerRunner = activeRunner): BackingStopResult {
  const list = entries(config).filter((e) => e.isolation === 'per-job' && isManaged(e));
  const stopped: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  if (!list.length) return { stopped, skipped, ok: true };
  const state = dockerState(runner);
  if (state.state !== 'ok') return { stopped, skipped, ok: false, error: dockerError(state, list).message };
  try {
    for (const e of list) {
      const name = containerName(id, e.name);
      const found = inspectContainer(runner, name);
      if (!found.exists) skipped.push({ name, reason: 'missing' });
      else if (!matches(found.labels, ownLabels(root, e, id))) skipped.push({ name, reason: "not this job's" });
      else if (!found.running) skipped.push({ name, reason: 'already stopped' });
      else {
        const r = runner(['stop', '--time', '10', '--', name]);
        if (!r.ok) throw new DockerFailure(failure('stop', r));
        stopped.push(name);
      }
    }
  } catch (err) {
    if (!(err instanceof DockerFailure)) throw err;
    return { stopped, skipped, ok: false, error: err.message };
  }
  return { stopped, skipped, ok: true };
}

export interface BackingServiceStatus {
  name: string;
  isolation: BackingIsolation;
  container: string | null;
  state: 'running' | 'stopped' | 'missing' | 'external' | 'unknown';
  /** The container's healthcheck status while running; null without one, or when not running. */
  health: BackingHealth;
  host: string | null;
  ports: Record<string, number>;
  env: string[];
  /** Entries with `database`: the job database and the template its record names (null without one). */
  database?: { name: string; template: string | null };
}

export interface BackingContainer {
  name: string;
  job: string | null;
  backing: string;
  isolation: string;
  state: 'running' | 'stopped';
  orphan: boolean;
}

/** `docker ps --format '{{json .}}'` gives Labels as `k=v,k=v`. */
function parseLabels(s: unknown): Labels {
  const out: Labels = {};
  if (typeof s !== 'string') return out;
  for (const part of s.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export function backingStatus(root: string, config: Config, id?: undefined, runner?: DockerRunner): { containers: BackingContainer[] };
export function backingStatus(root: string, config: Config, id: string, runner?: DockerRunner): { job: string; docker: DockerStateName | null; services: BackingServiceStatus[] };
/**
 * With a job: Docker's state (null when no entry is managed, so Docker was not asked) and each entry's
 * container, state, ports and env names (never values); `unknown` when Docker is unreachable. Without
 * one: every container labelled with this root, and which are orphans.
 */
export function backingStatus(root: string, config: Config, id?: string, runner: DockerRunner = activeRunner): any {
  const list = entries(config);
  if (id === undefined) {
    const state = dockerState(runner);
    if (state.state !== 'ok') throw dockerError(state, list);
    const r = runner(['ps', '-a', '--filter', `label=forge.root=${rootLabel(root)}`, '--format', '{{json .}}']);
    if (!r.ok) throw new ForgeError(failure('ps', r), 'external');
    const containers: BackingContainer[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const labels = parseLabels(row?.Labels);
      const job = labels['forge.job'] ?? null;
      const isolation = labels['forge.isolation'] ?? 'unknown';
      containers.push({
        name: String(row?.Names ?? ''),
        job,
        backing: labels['forge.backing'] ?? '',
        isolation,
        state: row?.State === 'running' ? 'running' : 'stopped',
        orphan: isolation === 'per-job' && !liveJob(root, job),
      });
    }
    return { containers: containers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
  }
  const mine = readJobRecord(root, id, config);
  const shared = readSharedRecord(root, config);
  const db = dbRecordFor(root, config, id);
  const state = list.some(isManaged) ? dockerState(runner) : null;
  const slug = projectSlug(root, config);
  const services = list.map((e): BackingServiceStatus => {
    const rec = e.isolation === 'shared' ? shared : mine;
    const env = Object.keys(entryEnv(e, rec, db));
    const database = e.database ? { database: { name: jobDbName(id), template: db?.rec.databases[e.name]?.template ?? null } } : {};
    if (!isManaged(e)) return { name: e.name, isolation: e.isolation, container: null, state: 'external', health: null, host: null, ports: {}, env };
    const container = containerName(e.isolation === 'shared' ? slug : id, e.name);
    let st: BackingServiceStatus['state'] = 'unknown';
    let health: BackingHealth = null;
    if (state?.state === 'ok') {
      try {
        const found = inspectContainer(runner, container);
        st = !found.exists ? 'missing' : !matches(found.labels, ownLabels(root, e, e.isolation === 'shared' ? null : id)) ? 'unknown' : found.running ? 'running' : 'stopped';
        if (found.exists && st === 'running') health = found.health;
      } catch {
        st = 'unknown';
      }
    }
    return { name: e.name, isolation: e.isolation, container, state: st, health, host: BACKING_HOST, ports: rec.ports[e.name] ?? {}, env, ...database };
  });
  return { job: id, docker: state?.state ?? null, services };
}

/** A job that exists and is neither done nor cancelled. */
function liveJob(root: string, id: string | null): boolean {
  if (!id) return false;
  try {
    return isActive(loadJob(root, id));
  } catch {
    return false;
  }
}

/** The doctor's `docker` check, or null when no entry needs Docker (then Docker is never called). */
export function dockerCheck(config: Config, runner: DockerRunner = activeRunner): DoctorCheck | null {
  const list = entriesOrNone(config).filter(isManaged);
  if (!list.length) return null;
  const s = dockerState(runner, DOCTOR_TIMEOUT_MS);
  const names = managedNames(list);
  if (s.state === 'missing') return { name: 'docker', ok: false, detail: `docker not found on PATH: install Docker to run backing services ${names}` };
  if (s.state === 'stopped') return { name: 'docker', ok: false, detail: `docker is installed but its daemon is not reachable: start Docker (e.g. Docker Desktop, colima start); needed by backing services ${names}` };
  return { name: 'docker', ok: true, detail: `Docker ${s.version}; backing: ${list.map((e) => `${e.name} (${e.isolation})`).join(', ')}` };
}
