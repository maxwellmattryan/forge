// The machine's login service and uptime record: which per-user unit starts the machine dashboard at
// login on each platform, the environment it carries, `forge service install|uninstall|status`, the
// doctor row, and `<FORGE_HOME>/runtime/uptime.json` (the sleep assertion and the last restart).
// Every function takes all of ServiceOptions, so no test can reach the real home or launchctl; only
// lib/cli/commands/service.ts and doctor fill them from the process (defaultServiceOptions).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { PLUGIN_ROOT, forgeHome, machinePaths } from '#core/paths.ts';
import { SUPPORT_URL, daemonPlatformProblem } from '#core/os/platform.ts';
import { run } from '#core/os/process.ts';
import { readRegular, readRegularText, writeAtomic, writeJsonPrivate } from '#core/os/fs.ts';
import { launchAgentFile, launchdSteps, readLaunchAgentProgram, renderLaunchAgent } from '#integrations/os-service/launchd.ts';
import { readSystemdProgram, renderSystemdUnit, systemdSteps, systemdUnitFile } from '#integrations/os-service/systemd.ts';
import type { ServiceRun, ServiceUnit } from '#integrations/os-service/types.ts';
import type { DoctorCheck } from '#core/types.ts';
import { allowlisted, sanitizePath } from '../guard/command-env.ts';
import { machineDashboardFile, provenDashboard, systemProbe, type DashboardProbe } from '../ops/dashboard-record.ts';
import { PROJECT_NAME, ensureMachineDirs } from './machine-index.ts';

/** Everything the service functions read from the machine. All required: tests pass temp homes and a fake runner. */
export interface ServiceOptions {
  platform: NodeJS.Platform;
  /** The user's home: where the unit file goes. */
  userHome: string;
  /** The machine index directory: where the log and the uptime record go. */
  forgeHome: string;
  /** The installing shell's environment, filtered by serviceEnv. */
  env: NodeJS.ProcessEnv;
  /** The node the unit runs. */
  execPath: string;
  /** The Forge whose bin/forge the unit runs. */
  pluginRoot: string;
  uid: number;
  /** Runs launchctl or systemctl. */
  run: ServiceRun;
  /** Proves the running machine dashboard (lib/engine/ops/dashboard-record.ts). */
  probe: DashboardProbe;
}

/** The real machine: only lib/cli/commands/service.ts and doctor call this. */
export function defaultServiceOptions(): ServiceOptions {
  return {
    platform: process.platform,
    userHome: os.homedir(),
    forgeHome: forgeHome(),
    env: process.env,
    execPath: process.execPath,
    pluginRoot: PLUGIN_ROOT,
    uid: process.getuid?.() ?? 0,
    run: (file, args) => run(file, args, { allowFail: true, timeoutMs: 15_000 }),
    probe: systemProbe,
  };
}

export type ServiceManager = 'launchd' | 'systemd';

/** The manager for `platform`, or null where `forge service` is not supported yet (native Windows, the BSDs). */
function managerOf(platform: NodeJS.Platform): ServiceManager | null {
  if (daemonPlatformProblem(platform)) return null;
  return platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : null;
}

function unsupported(platform: NodeJS.Platform): ForgeError {
  return new ForgeError(
    `forge service is not supported on ${platform} yet: it installs a LaunchAgent on macOS and a systemd user unit on Linux; start forge dash by hand${platform === 'win32' ? ', or run Forge under WSL2' : ''} (${SUPPORT_URL})`,
  );
}

/** The names the unit may carry from the installing shell, besides the LC_* family. */
const SERVICE_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ', 'TMPDIR', 'FORGE_HOME'];
const LC_NAME = /^LC_[A-Za-z0-9_]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A control character could add a directive to the unit, so it refuses, naming the variable but never its value. */
function refuseControl(name: string, value: string): void {
  if (CONTROL.test(value)) throw new ForgeError(`${name} holds a control character, which a login service can't carry; fix it in this shell and run forge service install again`, 'usage');
}

/**
 * The unit's environment: of SERVICE_NAMES and LC_*, each one set (non-empty) in `env` that the strict
 * command environment passes (allowlisted), never a credential-like name, NODE_OPTIONS or Forge's
 * internal markers. PATH is sanitised (no empty or relative entries) and FORGE_HOME made absolute.
 * A value with a control character throws, naming the variable.
 */
export function serviceEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (!SERVICE_NAMES.includes(name) && !LC_NAME.test(name)) continue;
    if (!allowlisted(name, platform)) continue;
    refuseControl(name, value);
    const kept = name === 'PATH' ? sanitizePath(value, platform) : name === 'FORGE_HOME' ? path.resolve(value) : value;
    if (kept) out[name] = kept;
  }
  return out;
}

/** `[node, <pluginRoot>/bin/forge, dash, --service]`: what the unit runs and status compares against. */
function serviceProgram(opts: Pick<ServiceOptions, 'execPath' | 'pluginRoot'>): string[] {
  return [opts.execPath, path.join(opts.pluginRoot, 'bin', 'forge'), 'dash', '--service'];
}

const logFile = (home: string): string => path.join(machinePaths(home).runtime, 'service.log');

/** Where the unit file goes for this platform. */
function unitFile(opts: ServiceOptions, manager: ServiceManager): string {
  return manager === 'launchd' ? launchAgentFile(opts.userHome) : systemdUnitFile(opts.userHome, opts.env);
}

/** The unit: the program from `/`, the filtered environment, the log. Throws, naming the input, on a control character. */
export function serviceUnit(opts: ServiceOptions): ServiceUnit {
  refuseControl("node's path (process.execPath)", opts.execPath);
  refuseControl('the plugin root', opts.pluginRoot);
  refuseControl('FORGE_HOME', opts.forgeHome);
  return { program: serviceProgram(opts), env: serviceEnv(opts.env, opts.platform), workingDirectory: '/', log: logFile(opts.forgeHome) };
}

/** `<home>/runtime`, created private (0700) and refused when it is a link or a file. */
function ensureRuntime(home: string): string {
  ensureMachineDirs(home);
  const dir = machinePaths(home).runtime;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (!fs.lstatSync(dir).isDirectory()) throw new ForgeError(`${dir} is not a directory (a link or a file); remove it and run the command again`);
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return dir;
}

/** The first non-empty line of a failed step's output, capped: the `error` install reports. */
const firstLine = (r: { stderr: string; stdout: string; status: number | null }, argv: string[]): string =>
  (r.stderr || r.stdout).split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? `${argv.slice(0, 3).join(' ')} exited ${r.status}`;

export interface InstallResult {
  installed: true;
  manager: ServiceManager;
  file: string;
  log: string;
  loaded: boolean;
  replaced: boolean;
  error?: string;
  note?: string;
}

/**
 * Writes the unit for the current user (renamed over whatever is at the path, never through a link)
 * and loads it: launchctl bootout then bootstrap, or systemctl --user daemon-reload then enable --now
 * (and try-restart when it replaced a unit), so a running service dashboard restarts on the new unit.
 * Nothing is written or run when the platform is unsupported or a value holds a control character. A
 * failed load keeps the file and reports `loaded: false` with the first line of its output.
 */
export function installService(opts: ServiceOptions): InstallResult {
  const manager = managerOf(opts.platform);
  if (!manager) throw unsupported(opts.platform);
  if (!Number.isInteger(opts.uid) || opts.uid < 0) throw new ForgeError(`uid ${opts.uid} is not a user id`);
  const unit = serviceUnit(opts);
  const file = unitFile(opts, manager);
  refuseControl(manager === 'launchd' ? 'HOME' : 'XDG_CONFIG_HOME or HOME', file);
  const text = manager === 'launchd' ? renderLaunchAgent(unit) : renderSystemdUnit(unit);
  ensureRuntime(opts.forgeHome);
  const replaced = fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 0644 whatever the umask: launchd refuses a group- or world-writable agent.
  writeAtomic(file, text, { mode: 0o644 });
  const steps =
    manager === 'launchd'
      ? launchdSteps(opts.uid, file).install.map((argv, i) => ({ argv, must: i > 0 }))
      : [...systemdSteps().install, ...(replaced ? systemdSteps().restart : [])].map((argv) => ({ argv, must: true }));
  let error: string | undefined;
  for (const { argv, must } of steps) {
    const r = opts.run(argv[0]!, argv.slice(1));
    // An agent that isn't loaded yet makes the first bootout fail; only the load itself counts.
    if (!r.ok && must) {
      error = firstLine(r, argv);
      break;
    }
  }
  const note = takeoverNote(opts);
  return { installed: true, manager, file, log: unit.log, loaded: error === undefined, replaced, ...(error ? { error } : {}), ...(note ? { note } : {}) };
}

/** A proven machine dashboard that isn't the service's own: the service's start finds it and exits 0, so it waits. */
function takeoverNote(opts: ServiceOptions): string | null {
  const dash = provenDashboard(machineDashboardFile(opts.forgeHome), opts.probe);
  if (!dash) return null;
  const command = opts.probe.command(dash.pid) ?? '';
  if (/\s--service(\s|$)/.test(command)) return null;
  return `a dashboard you started (pid ${dash.pid}) is running, so the service takes over at the next login, or after forge dash --stop and forge service install`;
}

/**
 * Unloads the unit (launchctl bootout, or systemctl --user disable --now then daemon-reload) and removes
 * exactly its file: a link there is removed itself, never its target; the log stays. With no file it
 * runs nothing and returns `removed: false`.
 */
export function uninstallService(opts: ServiceOptions): { manager: ServiceManager; file: string; removed: boolean } {
  const manager = managerOf(opts.platform);
  if (!manager) throw unsupported(opts.platform);
  const file = unitFile(opts, manager);
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return { manager, file, removed: false };
  if (st.isDirectory()) throw new ForgeError(`${file} is a directory, not Forge's unit; remove it by hand`);
  const before = manager === 'launchd' ? launchdSteps(opts.uid, file).uninstall : systemdSteps().uninstall;
  const after = manager === 'launchd' ? [] : systemdSteps().afterUninstall;
  // A unit that is not loaded fails to unload; its file goes all the same.
  for (const argv of before) opts.run(argv[0]!, argv.slice(1));
  fs.unlinkSync(file);
  for (const argv of after) opts.run(argv[0]!, argv.slice(1));
  return { manager, file, removed: true };
}

export interface ServiceStatus {
  platform: NodeJS.Platform;
  supported: boolean;
  manager: ServiceManager | null;
  file: string | null;
  installed: boolean;
  /** null when nothing is installed (then nothing is run). */
  loaded: boolean | null;
  /** false when the unit names another bin/forge or node; null when nothing is installed. */
  current: boolean | null;
  log: string;
}

const UNIT_MAX = 64 * 1024;

/**
 * Whether the unit is installed, loaded and current. Runs only read-only calls (launchctl print,
 * systemctl --user is-active), and only when a unit file exists.
 */
export function serviceStatus(opts: ServiceOptions): ServiceStatus {
  const log = logFile(opts.forgeHome);
  const manager = managerOf(opts.platform);
  if (!manager) return { platform: opts.platform, supported: false, manager: null, file: null, installed: false, loaded: null, current: null, log };
  const file = unitFile(opts, manager);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { platform: opts.platform, supported: true, manager, file, installed: false, loaded: null, current: null, log };
  // A link or an unreadable file names no program, so it is never current.
  const text = readRegularText(file, UNIT_MAX);
  const program = text === null ? null : manager === 'launchd' ? readLaunchAgentProgram(text) : readSystemdProgram(text);
  const want = serviceProgram(opts);
  const current = program !== null && program.length === want.length && program.every((w, i) => w === want[i]);
  const [argv] = manager === 'launchd' ? launchdSteps(opts.uid, file).status : systemdSteps().status;
  const r = opts.run(argv![0]!, argv!.slice(1));
  const loaded = manager === 'launchd' ? r.ok : r.stdout.trim() === 'active';
  return { platform: opts.platform, supported: true, manager, file, installed: true, loaded, current, log };
}

// ---------- the uptime record ----------

/** One project's boot pass: its running jobs, open Office requests and active mandates. */
export interface UptimeProject {
  name: string;
  jobs: number;
  office: number;
  mandates: number;
}

export interface UptimeKeepAwake {
  /** The machine dashboard that wrote it: believed only while that pid is the proven dashboard. */
  pid: number;
  held: boolean;
  since: string | null;
  projects: string[];
  error: string | null;
  at: string;
}

export interface UptimeRestart {
  at: string;
  pid: number;
  projects: UptimeProject[];
}

/** `<FORGE_HOME>/runtime/uptime.json`: a runtime record (`v: 1`, read tolerantly), not a persisted shape. */
export interface Uptime {
  v: 1;
  keepAwake: UptimeKeepAwake | null;
  restart: UptimeRestart | null;
}

export const uptimeFile = (home: string): string => path.join(machinePaths(home).runtime, 'uptime.json');

const LIST_MAX = 200;
const COUNT_MAX = 100_000;
const ERROR_MAX = 300;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= COUNT_MAX;
const isPid = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 1;
const isName = (v: unknown): v is string => typeof v === 'string' && PROJECT_NAME.test(v);

function keepAwakeOf(v: unknown): UptimeKeepAwake | null {
  if (!isObj(v) || !isPid(v.pid) || typeof v.held !== 'boolean' || !isTime(v.at) || !Array.isArray(v.projects)) return null;
  const s: unknown = v.since;
  const e: unknown = v.error;
  const since = s === null ? null : isTime(s) ? s : undefined;
  const raw = e === null ? null : typeof e === 'string' ? e : undefined;
  if (since === undefined || raw === undefined) return null;
  // The error came from a helper's exit, but the file is writable by anyone with this user's shell: only a capped, one-line string survives.
  const error = raw === null ? null : raw.replace(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/gu, ' ').slice(0, ERROR_MAX);
  return { pid: v.pid, held: v.held, since, projects: v.projects.slice(0, LIST_MAX).filter(isName), error, at: v.at };
}

function restartOf(v: unknown): UptimeRestart | null {
  if (!isObj(v) || !isTime(v.at) || !isPid(v.pid) || !Array.isArray(v.projects)) return null;
  const projects = v.projects
    .slice(0, LIST_MAX)
    .filter((p): p is UptimeProject => isObj(p) && isName(p.name) && isCount(p.jobs) && isCount(p.office) && isCount(p.mandates))
    .map((p) => ({ name: p.name, jobs: p.jobs, office: p.office, mandates: p.mandates }));
  return { at: v.at, pid: v.pid, projects };
}

/** The record, tolerantly: a missing, malformed or linked file reads as empty, and anything malformed inside it is dropped. */
export function readUptime(home: string): Uptime {
  const empty: Uptime = { v: 1, keepAwake: null, restart: null };
  const bytes = readRegular(uptimeFile(home), 256 * 1024);
  if (typeof bytes === 'string') return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return empty;
  }
  if (!isObj(raw) || raw.v !== 1) return empty;
  return { v: 1, keepAwake: keepAwakeOf(raw.keepAwake), restart: restartOf(raw.restart) };
}

/** Replaces `keepAwake` and/or `restart` (0600, in a 0700 runtime dir). Only the one machine dashboard writes it, synchronously, so no lock. */
export function writeUptime(home: string, patch: Partial<Pick<Uptime, 'keepAwake' | 'restart'>>): Uptime {
  ensureRuntime(home);
  const next: Uptime = { ...readUptime(home), ...patch, v: 1 };
  writeJsonPrivate(uptimeFile(home), next);
  return next;
}

// ---------- doctor ----------

/** The sleep-assertion clause: from the record, believed only while its pid is the proven machine dashboard. */
/** Project names joined; for a support bundle, which goes to public issues, only their count (another project's name says what this machine works on). */
const names = (list: string[], bundle: boolean): string => (bundle ? `${list.length} project${list.length === 1 ? '' : 's'}` : list.join(', '));

function sleepClause(opts: ServiceOptions, bundle: boolean): { text: string; warn: boolean } {
  const dash = provenDashboard(machineDashboardFile(opts.forgeHome), opts.probe);
  if (!dash) return { text: 'dashboard not running', warn: false };
  const k = readUptime(opts.forgeHome).keepAwake;
  if (!k || k.pid !== dash.pid) return { text: 'sleep assertion not held', warn: false };
  if (k.held) return { text: `sleep assertion held for ${names(k.projects, bundle)}`, warn: false };
  if (k.error && k.projects.length) return { text: `sleep assertion failed: ${k.error}`, warn: true };
  return { text: 'sleep assertion not held', warn: false };
}

function restartClause(home: string, bundle: boolean): string {
  const r = readUptime(home).restart;
  if (!r) return 'no restart recorded';
  const resumed = r.projects.filter((p) => p.jobs + p.office > 0).map((p) => p.name);
  return `last restart ${r.at}: ${resumed.length ? `resumed ${names(resumed, bundle)}` : 'nothing in flight'}`;
}

/**
 * Doctor's one `service` row, whatever the number of projects: the unit, the sleep assertion and the
 * last restart, joined with `; ` (unsupported platforms show only the first). Always ok; a warning for
 * a unit that is not loaded or runs another Forge or node, and for a failed sleep assertion. With
 * `bundle`, project names are counted instead.
 */
export function serviceCheck(opts: ServiceOptions, { bundle = false }: { bundle?: boolean } = {}): DoctorCheck {
  const s = serviceStatus(opts);
  if (!s.supported) return { name: 'service', ok: true, detail: `not supported on ${opts.platform} yet` };
  let unit: string;
  let warn = false;
  if (!s.installed) unit = 'not installed (forge service install starts the dashboard at login)';
  else if (s.current === false) {
    unit = `${s.file} runs another Forge or node: run forge service install again`;
    warn = true;
  } else if (s.loaded === false) {
    unit = `installed but not loaded (${s.file}): log in again or run forge service install`;
    warn = true;
  } else unit = `installed and loaded (${s.file}); log ${s.log}`;
  const sleep = sleepClause(opts, bundle);
  const detail = [unit, sleep.text, restartClause(opts.forgeHome, bundle)].join('; ');
  return { name: 'service', ok: true, detail, ...(warn || sleep.warn ? { warn: true } : {}) };
}
