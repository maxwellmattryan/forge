// Job databases (docs/CONFIG.md "Backing services"): a shared Postgres entry with `database` gives
// each job its own database and login role on the one server, cloned from a template database the
// project's migrate and seed commands build. A leaf beside lib/backing.ts, which passes in the docker
// runner, the container and a command callback, so this module never imports backing.ts or worktree.ts.
//
// Every name is derived (from the job id, or the hash of what builds the template), checked against
// PG_IDENT and double-quoted; SQL reaches psql only on stdin; Postgres only ever gets a SCRAM-SHA-256
// verifier, never a password. The plaintext job password lives only in the 0600 backing-db.json and
// in the env of the commands Forge runs for the job. backing-db.json is agent-writable, so it never
// names what teardown drops, and a field that fails its regex is ignored.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PG_IDENT, backingProblems } from './backing-config.ts';
import { jobDir } from './jobs.ts';
import { redact } from './known-secrets.ts';
import { paths } from './paths.ts';
import type { BackingBuildStep, BackingDbRecord, BackingEntry, BackingUpEntry, Config, DockerResult, DockerRunner } from './types.ts';
import { ForgeError, run, sleepSync, tail, withLock, writeJsonPrivate } from './util.ts';

export const TEMPLATE_NAME = /^forge_tpl_[0-9a-f]{12}$/;
export const JOB_DB_NAME = /^forge_j_[a-z0-9_]{1,40}_[0-9a-f]{8}$/;
export const PASSWORD = /^[A-Za-z0-9_-]{32}$/;
/** What scramVerifier makes: the only literal besides checked names that reaches SQL. */
const VERIFIER = /^SCRAM-SHA-256\$\d{1,7}:[A-Za-z0-9+/=]{1,64}\$[A-Za-z0-9+/=]{1,64}:[A-Za-z0-9+/=]{1,64}$/;
/**
 * The role that owns a template while migrate and seed build it. No job role is a member: a member
 * could reach a template mid-build, which every later job is cloned from. A clone's objects are
 * reassigned from it to the job's role instead.
 */
export const TEMPLATE_ROLE = 'forge_tpl';
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;
/** A clone of a large template is a file copy; give it minutes, not docker's default 30 s. */
const PSQL_TIMEOUT_MS = 300_000;
const BUILD_LOCK = { timeoutMs: 15 * 60_000, staleMs: 20 * 60_000 };
const MAX_RECORD = 64 * 1024;

const sha256 = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer, text: string): Buffer => crypto.createHmac('sha256', key).update(text).digest();

// ---------- names ----------

function ident(name: string): string {
  if (!PG_IDENT.test(name)) throw new ForgeError(`not a safe Postgres identifier: ${JSON.stringify(name).slice(0, 80)}`);
  return name;
}
/** A checked identifier, double-quoted. */
const q = (name: string): string => `"${ident(name)}"`;
/** A checked identifier as a string literal, for catalog lookups. */
const lit = (name: string): string => `'${ident(name)}'`;

/** The job's database and its role: `forge_j_<slug>_<8 hex of sha256(id)>`, so ids differing only in punctuation still differ. */
export function jobDbName(id: string): string {
  const slug =
    id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'job';
  return ident(`forge_j_${slug}_${sha256(id).slice(0, 8)}`);
}

/** The superuser the official image creates: env.POSTGRES_USER, else postgres. */
export const adminOf = (e: BackingEntry): string => ident(String(e.env?.POSTGRES_USER ?? 'postgres'));

/** Shared entries with `database`, from a valid config only (validation reports the rest). */
export function dbEntries(config: Config): BackingEntry[] {
  const list = Array.isArray(config.backing) ? config.backing : [];
  if (!list.some((e) => e && typeof e === 'object' && e.database !== undefined)) return [];
  if (backingProblems(config).length) return [];
  return list.filter((e) => e.isolation === 'shared' && e.database);
}

// ---------- secrets ----------

/** 24 random bytes as base64url: 32 characters of [A-Za-z0-9_-], safe in a url and in a SQL literal. */
export const newPassword = (): string => crypto.randomBytes(24).toString('base64url');

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 5802 / 7677), so the password itself
 * never reaches the server, its log or `pg_authid`.
 */
export function scramVerifier(password: string, salt: Buffer = crypto.randomBytes(16), iterations = 4096): string {
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const storedKey = crypto.createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

function verifierLit(v: string): string {
  if (!VERIFIER.test(v)) throw new ForgeError('internal: malformed SCRAM verifier');
  return `'${v}'`;
}

// Moved to known-secrets.ts, which redacts every known value; kept here for existing callers.
export { redact };

// ---------- template name ----------

/**
 * The files `inputs` match in the worktree, tracked or untracked-but-not-ignored, each as
 * `[path, sha256]` (`l:<target>` for a symlink). Git config that could run a program or reshape the
 * output is pinned: the worktree is agent-writable.
 */
function inputFiles(worktree: string, inputs: string[]): [string, string][] {
  const pins = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.untrackedCache=false', '-c', 'core.quotepath=off'];
  const r = run('git', ['-C', worktree, ...pins, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs.map((g) => `:(glob)${g}`)], { allowFail: true });
  if (!r.ok) throw new ForgeError(`git ls-files failed for database inputs: ${tail(r.stderr || `exited ${r.status}`, 3).trim()}`);
  const out: [string, string][] = [];
  for (const rel of [...new Set(r.stdout.split('\0').filter(Boolean))].sort()) {
    const file = path.join(worktree, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) out.push([rel, `l:${fs.readlinkSync(file)}`]);
    else if (st.isFile()) {
      const digest = hashRegular(file);
      if (digest !== null) out.push([rel, digest]);
    }
  }
  return out;
}

/**
 * `forge_tpl_<12 hex>` over the engine, image, migrate, seed, inputs and the content of every file
 * inputs match in the job's worktree: anything that changes what the template holds changes its name.
 */
export function templateName(e: BackingEntry, worktree: string): string {
  const db = e.database!;
  const inputs = db.inputs ?? [];
  const files = inputs.length ? inputFiles(worktree, inputs) : [];
  return `forge_tpl_${sha256(JSON.stringify({ engine: db.engine, image: e.image ?? null, migrate: db.migrate ?? null, seed: db.seed ?? null, inputs, files })).slice(0, 12)}`;
}

// ---------- record ----------

export const dbRecordFile = (root: string, id: string): string => path.join(jobDir(root, id), 'backing-db.json');

/** `fn` on a regular file, opened without following a symlink or blocking on a FIFO; null otherwise. */
function withRegular<T>(file: string, fn: (fd: number, st: fs.Stats) => T | null): T | null {
  let fd: number;
  let link: fs.Stats;
  try {
    // Windows has no O_NOFOLLOW, so lstat refuses a link or FIFO before the open, and the
    // descriptor must still be that same file (no swap in between).
    link = fs.lstatSync(file);
    if (!link.isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    return st.isFile() && st.dev === link.dev && st.ino === link.ino ? fn(fd, st) : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** A regular file's bytes, at most `max` of them; null otherwise. */
const readRegular = (file: string, max: number): Buffer | null => withRegular(file, (fd, st) => (st.size > max ? null : fs.readFileSync(fd)));

/** A regular file's sha256, read in chunks: an input file in the worktree may be any size. */
const hashRegular = (file: string): string | null =>
  withRegular(file, (fd) => {
    const h = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
    return h.digest('hex');
  });

function readRaw(file: string): any {
  const body = readRegular(file, MAX_RECORD);
  if (!body) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

const validEntry = (m: unknown): m is { template: string; password: string } =>
  Boolean(m) && typeof m === 'object' && typeof (m as any).template === 'string' && TEMPLATE_NAME.test((m as any).template) && typeof (m as any).password === 'string' && PASSWORD.test((m as any).password);

/** The job's record read tolerantly: an entry survives only when it names a current database entry and both fields match. */
export function readDbRecord(root: string, id: string, config: Config): BackingDbRecord {
  const out: BackingDbRecord = { v: 1, databases: {} };
  const list = dbEntries(config);
  if (!list.length) return out;
  const raw = readRaw(dbRecordFile(root, id));
  const dbs = raw && typeof raw === 'object' && raw.databases && typeof raw.databases === 'object' ? raw.databases : null;
  if (!dbs) return out;
  for (const e of list) {
    const m = Object.hasOwn(dbs, e.name) ? dbs[e.name] : null;
    if (validEntry(m)) out.databases[e.name] = { template: m.template, password: m.password };
  }
  return out;
}

function writeDbRecord(root: string, id: string, rec: BackingDbRecord): void {
  if (Object.keys(rec.databases).length) writeJsonPrivate(dbRecordFile(root, id), rec);
  else fs.rmSync(dbRecordFile(root, id), { force: true });
}

/** Every password in the job's record: what Forge redacts from the tails it stores. */
export function jobDbPasswords(root: string, id: string, config: Config): string[] {
  return Object.values(readDbRecord(root, id, config).databases).map((d) => d.password);
}

/** Every template any job's record names (valid names only): pruning keeps these. */
function recordedTemplates(root: string): Set<string> {
  const named = new Set<string>();
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(paths(root).jobs);
  } catch {
    return named;
  }
  for (const id of ids) {
    const raw = readRaw(path.join(paths(root).jobs, id, 'backing-db.json'));
    const dbs = raw && typeof raw === 'object' && raw.databases && typeof raw.databases === 'object' ? raw.databases : {};
    for (const m of Object.values(dbs)) if (m && typeof m === 'object' && typeof (m as any).template === 'string' && TEMPLATE_NAME.test((m as any).template)) named.add((m as any).template);
  }
  return named;
}

// ---------- psql ----------

/** One Postgres server: the shared container, its superuser, and the secrets to keep out of any error. */
export interface PgServer {
  runner: DockerRunner;
  container: string;
  admin: string;
  secrets: string[];
}

function failure(s: PgServer, sub: string, r: DockerResult): string {
  return redact(`docker ${sub} failed: ${tail(r.stderr || r.stdout || `exited ${r.status}`, 5).trim()}`, s.secrets);
}

const script = (...statements: string[]): string => statements.map((x) => `${x};\n`).join('');

/** Runs SQL through psql inside the container, on stdin, stopping at the first error; returns the non-empty output lines. */
function psql(s: PgServer, sql: string, db = 'postgres'): string[] {
  const r = s.runner(['exec', '-i', s.container, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', ident(s.admin), '-d', ident(db)], { input: sql, timeoutMs: PSQL_TIMEOUT_MS });
  if (!r.ok) throw new ForgeError(failure(s, 'exec', r), 'external');
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

const terminate = (db: string): string => `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${lit(db)} AND pid <> pg_backend_pid()`;

/**
 * Waits until the server accepts TCP connections inside the container. TCP on purpose: the image's
 * init-time server, which runs before the real one, listens on the socket only.
 */
export function waitReady(s: PgServer, containerPort: number, timeoutMs = READY_TIMEOUT_MS): void {
  const start = Date.now();
  for (;;) {
    const r = s.runner(['exec', s.container, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', String(containerPort), '-U', ident(s.admin)], { timeoutMs: 10_000 });
    if (r.ok) return;
    if (Date.now() - start >= timeoutMs) throw new ForgeError(`postgres in ${s.container} did not accept connections within ${Math.round(timeoutMs / 1000)} s`, 'external');
    sleepSync(READY_POLL_MS);
  }
}

// ---------- template ----------

/** A failed template build, with the migrate and seed runs so far. */
class BuildFailed extends ForgeError {
  declare build: BackingBuildStep[];
  constructor(message: string, build: BackingBuildStep[]) {
    super(message, 'external');
    this.build = build;
  }
}

/** What runs migrate and seed: a command in the job's worktree with extra env, and the url to give them. */
export interface TemplateCommands {
  run: (cmd: string, envOverride: Record<string, string>) => { ok: boolean; output: string };
  /** The url env name (FORGE_BACKING_<NAME>_URL). */
  envName: string;
  /** The entry's url with host and port filled; {user}, {password} and {database} still to fill. */
  url: string;
}

export const fillDbUrl = (url: string, user: string, password: string, database: string): string =>
  url.replace(/\{(user|password|database)\}/g, (_m, k: string) => (k === 'user' ? user : k === 'password' ? password : database));

function dropUnfinished(s: PgServer, t: string): void {
  psql(s, script(terminate(t), `DROP DATABASE IF EXISTS ${q(t)}`));
}

/**
 * Makes sure template `t` exists: reused when it is a finished template, else built (a leftover
 * partial build is dropped first). Building runs migrate, then seed, as the forge_tpl role with a
 * one-off password, then hands the database to the superuser and freezes it as a template that
 * takes no connections. CONNECT is revoked from PUBLIC from the start, so while it builds only
 * forge_tpl and the superuser reach it. Any failure drops the half-built database; forge_tpl always
 * loses its login.
 */
export function ensureTemplate(s: PgServer, e: BackingEntry, t: string, cmds: TemplateCommands): { action: 'built' | 'reused'; build: BackingBuildStep[] } {
  const state = psql(s, script(`SELECT datistemplate FROM pg_database WHERE datname = ${lit(t)}`))[0];
  if (state === 't') return { action: 'reused', build: [] };
  if (state === 'f') dropUnfinished(s, t);
  const pw = newPassword();
  s.secrets.push(pw);
  const build: BackingBuildStep[] = [];
  try {
    const hasRole = psql(s, script(`SELECT 1 FROM pg_roles WHERE rolname = ${lit(TEMPLATE_ROLE)}`)).length > 0;
    psql(s, script(...(hasRole ? [] : [`CREATE ROLE ${q(TEMPLATE_ROLE)} NOLOGIN`]), `ALTER ROLE ${q(TEMPLATE_ROLE)} LOGIN PASSWORD ${verifierLit(scramVerifier(pw))}`, `CREATE DATABASE ${q(t)} OWNER ${q(TEMPLATE_ROLE)}`, `REVOKE CONNECT ON DATABASE ${q(t)} FROM PUBLIC`));
    const env = { [cmds.envName]: fillDbUrl(cmds.url, TEMPLATE_ROLE, pw, t) };
    for (const [step, cmd] of [['migrate', e.database!.migrate], ['seed', e.database!.seed]] as const) {
      if (!cmd) continue;
      const r = cmds.run(cmd, env);
      build.push({ cmd, ok: r.ok, tail: redact(tail(r.output, 15), s.secrets) });
      if (!r.ok) throw new BuildFailed(`template ${t}: ${step} failed (see build)`, build);
    }
    psql(s, script(terminate(t), `ALTER DATABASE ${q(t)} OWNER TO ${q(s.admin)}`, `ALTER DATABASE ${q(t)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`));
  } catch (err) {
    try {
      dropUnfinished(s, t);
    } catch {
      // The build's own error says what went wrong; the leftover is dropped by the next build.
    }
    if (err instanceof ForgeError && !(err instanceof BuildFailed)) throw new BuildFailed(err.message, build);
    throw err;
  } finally {
    try {
      psql(s, script(`ALTER ROLE ${q(TEMPLATE_ROLE)} NOLOGIN PASSWORD NULL`));
    } catch {
      // Best effort: its password was never stored, so nothing can log in with it.
    }
  }
  return { action: 'built', build };
}

/** Drops every `forge_tpl_<12 hex>` on the server other than `keep` that no job's record names; returns them. */
export function pruneTemplates(root: string, s: PgServer, keep: string): string[] {
  const named = recordedTemplates(root);
  const dropped: string[] = [];
  for (const d of psql(s, script(`SELECT datname FROM pg_database WHERE datname ~ '^forge_tpl_[0-9a-f]{12}$'`))) {
    if (!TEMPLATE_NAME.test(d) || d === keep || named.has(d)) continue;
    psql(s, script(`ALTER DATABASE ${q(d)} WITH IS_TEMPLATE false`, `DROP DATABASE ${q(d)}`));
    dropped.push(d);
  }
  return dropped;
}

// ---------- job database ----------

/** How backingUp runs the database step: the job's computed worktree (null when missing) and a command runner there. */
export interface DatabaseOpts {
  worktree: string | null;
  runCommand: (cmd: string, envOverride: Record<string, string>) => { ok: boolean; output: string };
  /** Tests only: how long to wait for the server. */
  readyTimeoutMs?: number;
}

export interface DatabaseUp {
  database: NonNullable<BackingUpEntry['database']>;
  build?: BackingBuildStep[];
  error?: string;
}

/** `fn` under the entry's lock, which every template build, job database creation and drop on that server holds. */
const withDbLock = <T>(root: string, entry: string, fn: () => T): T => withLock(path.join(paths(root).locks, `backing-db-${entry}`), fn, BUILD_LOCK);

/**
 * Gives the job's role every object in its database that migrate and seed created as forge_tpl.
 * REASSIGN OWNED also moves the databases forge_tpl owns, so first any it still owns, which under the
 * lock can only be a build that stopped part way, is dropped.
 */
function handOver(s: PgServer, j: string): void {
  for (const d of psql(s, script(`SELECT datname FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = ${lit(TEMPLATE_ROLE)})`))) {
    if (!TEMPLATE_NAME.test(d)) throw new ForgeError(`role ${TEMPLATE_ROLE} owns database ${JSON.stringify(d).slice(0, 80)}, which Forge did not build: drop it or change its owner, then retry`, 'external');
    dropUnfinished(s, d);
  }
  psql(s, script(`REASSIGN OWNED BY ${q(TEMPLATE_ROLE)} TO ${q(j)}`), j);
}

/**
 * The job's database on a running shared server: kept when it exists (a missing or invalid record
 * gets a new password), else cloned from the template, which is built first when missing. Under a
 * per-entry lock, so concurrent jobs build a template once.
 */
export function upDatabase(root: string, config: Config, id: string, e: BackingEntry, s: PgServer, url: string, envName: string, opts: DatabaseOpts | undefined): DatabaseUp {
  const j = jobDbName(id);
  const database: DatabaseUp['database'] = { name: j, template: null, action: 'none', template_action: 'none' };
  let build: BackingBuildStep[] | undefined;
  const worktree = opts?.worktree ?? null;
  if (!worktree || !fs.existsSync(worktree)) return { database, error: `job ${id} has no worktree: run forge worktree create ${id}` };
  try {
    waitReady(s, e.ports![0], opts?.readyTimeoutMs);
    withDbLock(root, e.name, () => {
      const rec = readDbRecord(root, id, config);
      const mine = rec.databases[e.name];
      if (mine) s.secrets.push(mine.password);
      const exists = psql(s, script(`SELECT 1 FROM pg_database WHERE datname = ${lit(j)}`)).length > 0;
      if (exists && mine) {
        Object.assign(database, { template: mine.template, action: 'kept' });
        return;
      }
      // A kept database without a record is recorded against today's template name, which only keeps that template from being pruned.
      const t = templateName(e, worktree);
      if (!exists) {
        database.template = t;
        const tpl = ensureTemplate(s, e, t, { run: opts!.runCommand, envName, url });
        database.template_action = tpl.action;
        if (tpl.action === 'built') {
          build = tpl.build;
          // Before this job's record names t, so its own template is kept by `keep`, not the record.
          try {
            pruneTemplates(root, s, t);
          } catch {
            // A stale template only costs disk; the next build prunes it again.
          }
        }
      }
      const pw = newPassword();
      s.secrets.push(pw);
      const v = verifierLit(scramVerifier(pw));
      const hasRole = psql(s, script(`SELECT 1 FROM pg_roles WHERE rolname = ${lit(j)}`)).length > 0;
      psql(s, script(hasRole ? `ALTER ROLE ${q(j)} LOGIN PASSWORD ${v}` : `CREATE ROLE ${q(j)} LOGIN PASSWORD ${v}`));
      if (!exists) psql(s, script(`CREATE DATABASE ${q(j)} TEMPLATE ${q(t)} OWNER ${q(j)}`, `REVOKE CONNECT ON DATABASE ${q(j)} FROM PUBLIC`));
      // Also for a kept database without a record: a run that stopped between the clone and this left forge_tpl owning its objects.
      handOver(s, j);
      writeDbRecord(root, id, { v: 1, databases: { ...rec.databases, [e.name]: { template: t, password: pw } } });
      Object.assign(database, { template: t, action: exists ? 'kept' : 'created' });
    });
    return { database, ...(build ? { build } : {}) };
  } catch (err) {
    if (!(err instanceof ForgeError)) throw err;
    if (err instanceof BuildFailed) {
      database.template_action = 'none';
      build = err.build;
    }
    return { database, ...(build ? { build } : {}), error: redact(err.message, s.secrets) };
  }
}

/**
 * Terminates the job database's connections and drops it and its role, under the entry's lock so a
 * concurrent `backing up` for the job cannot interleave; the names come from the job id only.
 */
export function dropJobDatabase(root: string, entry: string, s: PgServer, id: string): string {
  const j = jobDbName(id);
  withDbLock(root, entry, () => psql(s, script(terminate(j), `DROP DATABASE IF EXISTS ${q(j)}`, `DROP ROLE IF EXISTS ${q(j)}`)));
  return j;
}

/** Deletes the job's record (teardown, once the databases are gone or unreachable for good). */
export function removeDbRecord(root: string, id: string): void {
  fs.rmSync(dbRecordFile(root, id), { force: true });
}
