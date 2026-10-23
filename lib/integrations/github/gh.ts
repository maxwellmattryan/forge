// The one place a gh process starts in lib/: every call has a timeout, so a hung gh (a stalled
// network, an auth prompt) can't block `pr sync` or a tracker call forever, and JSON it prints is
// parsed in one place.
import { execFile } from 'node:child_process';
import { ForgeError } from '#core/errors.ts';
import { run, timedOutMessage } from '#core/os/process.ts';
import type { RunResult } from '#core/os/process.ts';

/** The default: `pr create` and `project item-list --limit 1000` can take several seconds. */
export const GH_TIMEOUT_MS = 60_000;

export interface GhOpts {
  input?: string;
  allowFail?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function gh(cwd: string | undefined, args: string[], opts: GhOpts = {}): RunResult {
  return run('gh', args, { cwd, input: opts.input, allowFail: opts.allowFail, env: opts.env, timeoutMs: opts.timeoutMs ?? GH_TIMEOUT_MS });
}

/**
 * gh's output parsed as JSON (raw input: the caller validates what it reads). Output that is not JSON
 * throws ForgeError `external`; under `allowFail` a failed call or such output is null instead.
 */
export function ghJson<T = any>(cwd: string | undefined, args: string[], opts: GhOpts = {}): T {
  return parseJsonOutput(gh(cwd, args, opts), args, opts) as T;
}

/** ghJson's parse of one finished gh call `r` made with `args`: the one JSON.parse of gh output in lib/. */
export function parseJsonOutput(r: RunResult, args: string[], opts: Pick<GhOpts, 'allowFail'> = {}): unknown {
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    if (opts.allowFail) return null;
    throw new ForgeError(`gh ${args[0]} printed output that is not JSON`, 'external');
  }
}

/** `gh api graphql`'s argv. Strings go as `-f` (never read as a number or a file), numbers as `-F`. */
export function graphqlArgs(query: string, vars: Record<string, string | number>): string[] {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return args;
}

/** `gh api graphql`'s `.data`: graphqlArgs, run and parsed as ghJson does. */
export function ghGraphql(cwd: string | undefined, query: string, vars: Record<string, string | number>, opts: GhOpts = {}): any {
  return ghJson(cwd, graphqlArgs(query, vars), opts)?.data;
}

export interface GhAsyncResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** gh is not on PATH. */
  missing?: boolean;
  timedOut?: boolean;
}

/** gh without a shell or a blocking call, for the dashboard server: output capped, killed on timeout. */
export function ghAsync(cwd: string | undefined, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<GhAsyncResult> {
  const timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS;
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, env: opts.env ?? process.env, timeout: timeoutMs, maxBuffer: opts.maxBuffer ?? 2 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown; killed?: boolean }) | null;
      if (e?.code === 'ENOENT') return resolve({ code: null, stdout: '', stderr: '', missing: true });
      // execFile kills the child on timeout and on output past maxBuffer; only the latter has a code.
      if (e?.killed && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: null, stdout: String(stdout ?? ''), stderr: timedOutMessage('gh', args, timeoutMs), timedOut: true });
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? e?.message ?? '') });
    });
  });
}
