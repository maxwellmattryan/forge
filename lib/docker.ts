// The one place a docker process starts in lib/: a sync runner (lib/backing.ts), an async one and a
// streaming spawn (the dashboard server). Docker's state is read from the result's fields, never
// from its message text.
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { DockerResult, DockerRunner } from './core/types.ts';
import { run } from './core/os/process.ts';

export type DockerStateName = 'ok' | 'missing' | 'stopped';

export const DOCKER_TIMEOUT_MS = 30_000;

/**
 * Always allowFail: run()'s throwing path puts the whole argv into the error message. A spawn error
 * (no status) whose message says ENOENT is a missing binary.
 */
export const dockerRun: DockerRunner = (args, opts = {}) => {
  const res = run('docker', args, { allowFail: true, timeoutMs: opts.timeoutMs ?? DOCKER_TIMEOUT_MS, input: opts.input });
  return { ...res, missing: res.status === null && !res.timedOut && /ENOENT/.test(res.stderr) };
};

/** dockerRun without blocking the event loop: argv only, output capped at `maxBuffer`. */
export function dockerRunAsync(args: string[], opts: { timeoutMs: number; maxBuffer?: number }): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer ?? 2 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
      const status = e ? (typeof e.code === 'number' ? e.code : null) : 0;
      resolve({ ok: !e, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), status, missing: e?.code === 'ENOENT' });
    });
  });
}

/** A long-running docker child (`logs --follow`) whose output the caller streams. */
export function dockerSpawn(args: string[]): ChildProcessByStdio<null, Readable, Readable> {
  return spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Docker's state from a `docker version` result: no binary, no daemon answering, or ok. */
export function dockerStateOf(r: DockerResult): DockerStateName {
  if (r.missing) return 'missing';
  return r.ok ? 'ok' : 'stopped';
}
