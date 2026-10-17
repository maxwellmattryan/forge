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
import { backingProblems, isManaged } from './backing-config.ts';
import { isActive, jobDir, listJobs, loadJob } from './jobs.ts';
import { paths } from './paths.ts';
import type { BackingDownResult, BackingEntry, BackingIsolation, BackingRecord, BackingUpEntry, Config, DoctorCheck } from './types.ts';
import { ForgeError, readJson, run, tail, withLock, writeJsonAtomic } from './util.ts';

export { backingProblems, isManaged };

export interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  /** The docker binary is not on PATH. */
  missing?: boolean;
}

/** Runs `docker <args>`; tests inject an in-memory fake. */
export type DockerRunner = (args: string[], opts?: { timeoutMs?: number }) => DockerResult;

const TIMEOUT_MS = 30_000;
/** `docker run` pulls the image on demand. */
const RUN_TIMEOUT_MS = 600_000;
const DOCTOR_TIMEOUT_MS = 5_000;
export const BACKING_HOST = '127.0.0.1';

/**
 * Always allowFail: run()'s throwing path puts the whole argv into the error message. A spawn error
 * (no status) whose message says ENOENT is a missing binary.
 */
export const defaultRunner: DockerRunner = (args, opts = {}) => {
  const res = run('docker', args, { allowFail: true, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS });
  return { ...res, missing: res.status === null && /ENOENT/.test(res.stderr) };
};

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

export function volumeName(owner: string, name: string, i: number): string {
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
function entriesOrNone(config: Config): BackingEntry[] {
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

/** The lock every host port is handed out under: job ports (lib/worktree.ts) and backing ports alike. */
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

function entryEnv(e: BackingEntry, rec: BackingRecord | null): Record<string, string> {
  const pre = envPrefix(e.name);
  if (e.isolation === 'external') return e.url ? { [`${pre}_URL`]: e.url } : {};
  const ports = rec?.ports[e.name];
  // Never allocated: the services are not up yet, so there is nothing to point at.
  if (!ports) return {};
  const order = e.ports ?? [];
  const env: Record<string, string> = { [`${pre}_HOST`]: BACKING_HOST };
  if (order.length) env[`${pre}_PORT`] = String(ports[String(order[0])]);
  for (const p of order) env[`${pre}_PORT_${p}`] = String(ports[String(p)]);
  if (e.url) env[`${pre}_URL`] = fillUrl(e.url, ports, order);
  return env;
}

/** FORGE_BACKING_<NAME>_{HOST,PORT,PORT_<n>,URL} for every entry; `{}` when there are none. */
export function backingEnv(root: string, config: Config, job: { id: string }): Record<string, string> {
  const list = entriesOrNone(config);
  if (!list.length) return {};
  const mine = list.some((e) => e.isolation === 'per-job') ? readJobRecord(root, job.id, config) : null;
  const shared = list.some((e) => e.isolation === 'shared') ? readSharedRecord(root, config) : null;
  return Object.assign({}, ...list.map((e) => entryEnv(e, e.isolation === 'shared' ? shared : mine)));
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

export type DockerState = { state: 'missing' | 'stopped' | 'ok'; version?: string };

export function dockerState(runner: DockerRunner = activeRunner, timeoutMs = TIMEOUT_MS): DockerState {
  const r = runner(['version', '--format', '{{.Server.Version}}'], { timeoutMs });
  if (r.missing) return { state: 'missing' };
  if (!r.ok) return { state: 'stopped' };
  return { state: 'ok', version: r.stdout.trim() };
}

const managedNames = (list: BackingEntry[]): string => list.filter(isManaged).map((e) => e.name).join(', ');

function stateError(s: DockerState, list: BackingEntry[]): string {
  return s.state === 'missing'
    ? `docker not found on PATH: install Docker to run backing services ${managedNames(list)}`
    : 'docker is installed but its daemon is not reachable: start Docker (e.g. Docker Desktop, colima start) and retry';
}

/** A failed docker call in plain words: the subcommand and the last 5 lines of its stderr, never the argv. */
function failure(sub: string, r: DockerResult): string {
  const why = tail(r.stderr || r.stdout || `exited ${r.status}`, 5).trim();
  return `docker ${sub} failed: ${why}`;
}

class DockerFailure extends Error {}

type Labels = Record<string, string>;
type Found = { exists: false } | { exists: true; running: boolean; labels: Labels };

function inspectContainer(runner: DockerRunner, name: string): Found {
  const r = runner(['inspect', '--type', 'container', '--format', '{{json .State.Running}} {{json .Config.Labels}}', name]);
  if (!r.ok) {
    if (/No such/i.test(r.stderr)) return { exists: false };
    throw new DockerFailure(failure('inspect', r));
  }
  const line = r.stdout.trim();
  const sp = line.indexOf(' ');
  try {
    const running = JSON.parse(sp < 0 ? line : line.slice(0, sp)) === true;
    const labels = sp < 0 ? null : JSON.parse(line.slice(sp + 1));
    return { exists: true, running, labels: labels && typeof labels === 'object' ? labels : {} };
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
 * a lock so they start at most once. One failure is reported and the rest still run.
 */
export function backingUp(root: string, config: Config, job: { id: string; port?: number | null; ports?: Record<string, number> }, runner: DockerRunner = activeRunner): BackingUpEntry[] {
  const list = entries(config);
  if (!list.length) return [];
  const external = (e: BackingEntry): BackingUpEntry => ({ name: e.name, isolation: e.isolation, action: 'external', ok: true });
  if (!list.some(isManaged)) return list.map(external);
  // Failed before any container was touched: every managed entry reports `none` with the reason.
  const unreached = (error: string) => list.map((e): BackingUpEntry => (isManaged(e) ? { name: e.name, isolation: e.isolation, action: 'none', ok: false, error } : external(e)));
  const state = dockerState(runner);
  if (state.state !== 'ok') return unreached(stateError(state, list));
  let recs: ReturnType<typeof allocateBacking>;
  try {
    recs = allocateBacking(root, config, job);
  } catch (err) {
    // No free port (or a lock timeout): a failed entry, so worktree create fails the job through I4 instead of throwing after the worktree is saved.
    if (!(err instanceof ForgeError)) throw err;
    return unreached(err.message);
  }
  const slug = projectSlug(root, config);
  return list.map((e): BackingUpEntry => {
    if (!isManaged(e)) return external(e);
    const shared = e.isolation === 'shared';
    const attempt: { action: BackingUpEntry['action'] } = { action: 'none' };
    try {
      const go = () => ensure(root, runner, e, shared ? slug : job.id, shared ? null : job.id, (shared ? recs.shared : recs.job).ports[e.name] ?? {}, attempt);
      // A pull can take minutes, so the shared lock waits and goes stale on that scale.
      const action = shared ? withLock(path.join(paths(root).locks, 'backing-shared'), go, { timeoutMs: RUN_TIMEOUT_MS + 60_000, staleMs: RUN_TIMEOUT_MS + 120_000 }) : go();
      return { name: e.name, isolation: e.isolation, action, ok: true };
    } catch (err) {
      if (!(err instanceof DockerFailure) && !(err instanceof ForgeError)) throw err;
      return { name: e.name, isolation: e.isolation, action: attempt.action, ok: false, error: err.message };
    }
  });
}

/** Whether teardown has anything to do for the job: per-job entries configured, or a record left behind. */
export function hasJobBacking(root: string, config: Config, id: string): boolean {
  return (Array.isArray(config.backing) && config.backing.some((e) => e?.isolation === 'per-job')) || fs.existsSync(jobRecordFile(root, id));
}

/**
 * Removes the job's per-job containers and their volumes, only those labelled with this root and
 * job, then deletes backing.json. On any docker failure the record is kept so a retry still works.
 */
export function backingDown(root: string, config: Config, id: string, runner: DockerRunner = activeRunner): BackingDownResult {
  const file = jobRecordFile(root, id);
  const list = entries(config).filter((e) => e.isolation === 'per-job');
  const removed: string[] = [];
  const volumes: string[] = [];
  if (list.length) {
    const state = dockerState(runner);
    if (state.state !== 'ok') return { removed, volumes, ok: false, error: stateError(state, list) };
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
    } catch (err) {
      if (!(err instanceof DockerFailure)) throw err;
      return { removed, volumes, ok: false, error: err.message };
    }
  }
  fs.rmSync(file, { force: true });
  return { removed, volumes, ok: true };
}

/** Removes this root's shared containers, keeping their volumes and port record. */
export function backingDownShared(root: string, config: Config, runner: DockerRunner = activeRunner): { removed: string[] } {
  const list = entries(config).filter((e) => e.isolation === 'shared');
  const removed: string[] = [];
  if (!list.length) return { removed };
  const state = dockerState(runner);
  if (state.state !== 'ok') throw new ForgeError(stateError(state, list), 'external');
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

export interface BackingServiceStatus {
  name: string;
  isolation: BackingIsolation;
  container: string | null;
  state: 'running' | 'stopped' | 'missing' | 'external' | 'unknown';
  host: string | null;
  ports: Record<string, number>;
  env: string[];
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
export function backingStatus(root: string, config: Config, id: string, runner?: DockerRunner): { job: string; services: BackingServiceStatus[] };
/**
 * With a job: each entry's container, state, ports and env names (never values); `unknown` when
 * Docker is unreachable. Without one: every container labelled with this root, and which are orphans.
 */
export function backingStatus(root: string, config: Config, id?: string, runner: DockerRunner = activeRunner): any {
  const list = entries(config);
  if (id === undefined) {
    const state = dockerState(runner);
    if (state.state !== 'ok') throw new ForgeError(stateError(state, list), 'external');
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
  const state = list.some(isManaged) ? dockerState(runner) : null;
  const slug = projectSlug(root, config);
  const services = list.map((e): BackingServiceStatus => {
    const rec = e.isolation === 'shared' ? shared : mine;
    const env = Object.keys(entryEnv(e, rec));
    if (!isManaged(e)) return { name: e.name, isolation: e.isolation, container: null, state: 'external', host: null, ports: {}, env };
    const container = containerName(e.isolation === 'shared' ? slug : id, e.name);
    let st: BackingServiceStatus['state'] = 'unknown';
    if (state?.state === 'ok') {
      try {
        const found = inspectContainer(runner, container);
        st = !found.exists ? 'missing' : !matches(found.labels, ownLabels(root, e, e.isolation === 'shared' ? null : id)) ? 'unknown' : found.running ? 'running' : 'stopped';
      } catch {
        st = 'unknown';
      }
    }
    return { name: e.name, isolation: e.isolation, container, state: st, host: BACKING_HOST, ports: rec.ports[e.name] ?? {}, env };
  });
  return { job: id, services };
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
