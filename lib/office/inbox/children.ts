// The `forge` children of `forge dash`: the periodic `forge sync` and Office pass (`forge office pass`), outside
// any daemon scope, as the human who started the dashboard, with git pinned (SYNC_PINS) so a hook or program
// the checkout's config names never runs on their fetches; and the intake runner's calls (runForgeCall), in the
// `_inbox` scope with the session env, whose JSON and exit code are the request's answer. Each is its own
// process, killed after 10 minutes and stopped on the pool's signal. docs/architecture/daemon.md "Periodic
// sync", "Periodic Office pass" and "Intake runner" describe them. runChildOutput (which keeps stdout) also
// runs an office run's CLI children (lib/office/foreman/runs/cli.ts), under their own env.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { TRUST_ENV } from '#core/config/load.ts';
import { INBOX_SCOPE, SCOPE_ENV } from '#core/job/requests.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { oneLineTitle } from '#core/text.ts';
import { sessionEnv } from '#integrations/claude/argv.ts';
import { SYNC_PINS, pinEnv } from '#integrations/git/runner.ts';
import { spawnConfinement } from '../session/confine.ts';
import type { Config } from '#core/types.ts';

/** A child that runs longer than this is killed; the next interval tries again. */
const CHILD_TIMEOUT_MS = 10 * 60_000;
/** An intake call's stdout past this is not read: the child is killed and the call fails. */
const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 2000;
/** An intake call's error is cut to this many characters. */
const ERROR_MAX = 200;

/** The child's env: `env` pinned to `root` in agent mode, with no daemon marker or scope, and SYNC_PINS after any git config the caller set. */
export function syncChildEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, FORGE_ROOT: root, FORGE_MODE: 'agent' };
  for (const k of Object.keys(out)) if (k.startsWith('FORGE_DAEMON')) delete out[k];
  return pinEnv(out, SYNC_PINS);
}

/** How a caller stops a running child: when `signal` aborts it gets SIGTERM, then SIGKILL after `graceMs`. */
export interface ChildStop {
  signal: AbortSignal;
  graceMs: number;
}

/** One `forge sync` in a child process (runForgeChild). */
export const runSyncChild = (root: string, env: NodeJS.ProcessEnv = process.env, stop?: ChildStop): Promise<string | null> => runForgeChild(root, ['sync'], env, stop);

/** One Office pass in a child process (runForgeChild): it may call gh once per mandate milestone. */
export const runPassChild = (root: string, env: NodeJS.ProcessEnv = process.env, stop?: ChildStop): Promise<string | null> => runForgeChild(root, ['office', 'pass'], env, stop);

/**
 * One `forge <args>` in a child process: sync and the pass call gh synchronously, which would stall every
 * session's pipe if they ran in the server. Resolves with null on success or the failure's message.
 */
export function runForgeChild(root: string, args: string[], env: NodeJS.ProcessEnv = process.env, stop?: ChildStop): Promise<string | null> {
  return runChild(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), ...args], { cwd: root, env: syncChildEnv(root, env), stop });
}

/** How a supervised child ended: its exit, or `error` when it could not be started (or its process failed). */
interface Exited {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  /** It ran past its timeout and was killed. */
  timedOut: boolean;
}

/**
 * Spawns one child, killed after CHILD_TIMEOUT_MS, and stopped (SIGTERM, then SIGKILL after `stop.graceMs`) once
 * `stop.signal` aborts, at once when it already has. `exited` settles once, when the child closed or failed to start.
 */
function supervise(file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; stop?: ChildStop | undefined; stdout: boolean; timeoutMs?: number | undefined }): { child: ChildProcess; exited: Promise<Exited> } {
  const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', o.stdout ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
  const exited = new Promise<Exited>((resolve) => {
    let settled = false;
    let grace: NodeJS.Timeout | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, o.timeoutMs ?? CHILD_TIMEOUT_MS);
    timer.unref?.();
    // Not spawn's own `signal` option: that sends one signal and never escalates to SIGKILL.
    const onAbort = () => {
      child.kill('SIGTERM');
      grace ??= setTimeout(() => child.kill('SIGKILL'), o.stop!.graceMs);
    };
    const finish = (r: Omit<Exited, 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      o.stop?.signal.removeEventListener('abort', onAbort);
      resolve({ ...r, timedOut });
    };
    child.on('error', (e) => finish({ code: null, signal: null, error: e.message }));
    child.on('close', (code, signal) => finish({ code, signal, error: null }));
    if (o.stop?.signal.aborted) onAbort();
    else o.stop?.signal.addEventListener('abort', onAbort, { once: true });
  });
  return { child, exited };
}

/** Collects a child's stderr, up to MAX_STDERR characters. */
function stderrOf(child: ChildProcess): () => string {
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += d.toString('utf8');
  });
  return () => stderr;
}

/**
 * One child process, killed after CHILD_TIMEOUT_MS, and stopped (SIGTERM, then SIGKILL after `stop.graceMs`)
 * once `stop.signal` aborts, at once when it already has. Resolves once the child has exited, with null on a
 * zero exit or the failure's message: its last stderr line, else `exit <code or signal>`.
 */
export async function runChild(file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; stop?: ChildStop | undefined }): Promise<string | null> {
  const { child, exited } = supervise(file, args, { ...o, stdout: false });
  const stderr = stderrOf(child);
  const r = await exited;
  if (r.error !== null) return r.error;
  return r.code === 0 ? null : stderr().trim().split('\n').pop() || `exit ${r.code ?? r.signal}`;
}

/** The most stdout runChildOutput keeps; a child that prints more is killed and reported as cut. */
export const STDOUT_MAX = 4 * 1024 * 1024;

/** How a child ended: its code or signal, its stdout, its first 2000 characters of stderr, and a spawn error or a cut stdout. */
export interface ChildOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The spawn's error message, or why stdout was cut; null otherwise. */
  error: string | null;
  /** It ran past CHILD_TIMEOUT_MS (or `timeoutMs`) and was killed. */
  timedOut: boolean;
}

/**
 * runChild's process, with its stdout kept (at most STDOUT_MAX: a child that prints more is killed) when
 * `stdout` is true: the office runs' CLI children print one JSON value there.
 */
export async function runChildOutput(
  file: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; stop?: ChildStop | undefined; stdout?: boolean; timeoutMs?: number },
): Promise<ChildOutput> {
  const { child, exited } = supervise(file, args, { cwd: o.cwd, env: o.env, stop: o.stop, stdout: o.stdout === true, timeoutMs: o.timeoutMs });
  const out: Buffer[] = [];
  let outBytes = 0;
  let cut: string | null = null;
  child.stdout?.on('data', (d: Buffer) => {
    if (cut !== null) return;
    outBytes += d.length;
    if (outBytes > STDOUT_MAX) {
      cut = `stdout passed ${STDOUT_MAX / 1024 / 1024} MiB`;
      child.kill('SIGKILL');
      return;
    }
    out.push(d);
  });
  const stderr = stderrOf(child);
  const r = await exited;
  return { code: r.code, signal: r.signal, error: r.error ?? cut, stdout: Buffer.concat(out).toString('utf8'), stderr: stderr(), timedOut: r.timedOut };
}

/** One intake call's answer: its exit, its stdout as JSON (null when it is not), its error line and its wall time. */
export interface ForgeCall {
  code: number | null;
  signal: string | null;
  json: unknown;
  error: string | null;
  ms: number;
}

/** Runs one `forge <args>` for the intake runner; tests stand in for it through PoolOptions.runForge. */
export type ForgeCaller = (args: string[], o: { env: NodeJS.ProcessEnv; stop: ChildStop }) => Promise<ForgeCall>;

/** A child's error text as an ack may carry it: one line, `forge: ` dropped, at most ERROR_MAX characters; null when empty. */
export function callError(text: unknown): string | null {
  const line = oneLineTitle(text).replace(/^forge: /, '');
  return line ? line.slice(0, ERROR_MAX) : null;
}

/** The `error` of stderr's last line when that line is JSON with one, else the line itself. */
function lastLineError(stderr: string): string | null {
  const last = stderr.trim().split('\n').pop() ?? '';
  try {
    const v = JSON.parse(last);
    if (v && typeof v === 'object' && typeof v.error === 'string') return callError(v.error);
    if (v && typeof v === 'object' && typeof v.error?.message === 'string') return callError(v.error.message);
  } catch {}
  return callError(last);
}

/**
 * One `forge <args>` as its own process in `root`, with `o.env` as given (intakeEnv): the same timeout and stop as
 * runChild. stdout is read up to MAX_STDOUT (past it the child is killed and the call fails) and parsed as JSON.
 */
export async function runForgeCall(root: string, args: string[], o: { env: NodeJS.ProcessEnv; stop: ChildStop }): Promise<ForgeCall> {
  const t0 = Date.now();
  const { child, exited } = supervise(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge'), ...args], { cwd: root, env: o.env, stop: o.stop, stdout: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let over = false;
  child.stdout?.on('data', (d: Buffer) => {
    if (over) return;
    bytes += d.length;
    if (bytes > MAX_STDOUT) {
      over = true;
      chunks.length = 0;
      child.kill('SIGKILL');
      return;
    }
    chunks.push(d);
  });
  const stderr = stderrOf(child);
  const r = await exited;
  const ms = Date.now() - t0;
  if (r.error !== null) return { code: null, signal: null, json: null, error: callError(r.error) ?? 'the child failed to start', ms };
  let json: unknown = null;
  if (!over) {
    try {
      json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {}
  }
  return { code: r.code, signal: r.signal, json, error: over ? 'output over 1 MiB' : lastLineError(stderr()), ms };
}

/**
 * An intake call's environment: the session env (FORGE_DAEMON=1, agent mode, the plugin's bin/ first, SESSION_PINS),
 * the write roots, the root, the pool's trusted digest and the `_inbox` scope, so every inbox refusal applies.
 */
export function intakeEnv(root: string, env: NodeJS.ProcessEnv, config: Config, trusted: string): NodeJS.ProcessEnv {
  return { ...sessionEnv(env, config.daemon.auth), ...spawnConfinement(root, config).env, FORGE_ROOT: root, [TRUST_ENV]: trusted, [SCOPE_ENV]: INBOX_SCOPE };
}
