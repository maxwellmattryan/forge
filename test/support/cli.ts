// The CLI as tests start it. Import it through test/helpers.ts, whose import side effects pin git
// config, SHELL, FORGE_MODE and NODE_OPTIONS for every spawn.
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const BIN = path.resolve(import.meta.dirname, '..', '..', 'bin', 'forge');

/** What forgeSync returns and forgeAsync resolves to: the exit status (null when killed) and both streams. */
export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The env a spawned CLI gets: the inherited one, FORGE_ROOT pinned, then `env`, where an `undefined` value deletes the key. */
export function cliEnv(root: string, env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, FORGE_ROOT: root, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  return merged;
}

/**
 * The synchronous twin of forgeAsync, for tests that need the result before going on. FORGE_ROOT
 * pins it to `root`; `env` adds to (or overrides) the inherited environment.
 */
export function forgeSync(root: string, args: string[], env: NodeJS.ProcessEnv = {}, opts: { cwd?: string; input?: string; timeout?: number } = {}): CliResult {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? root,
    env: cliEnv(root, env),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input: opts.input,
    timeout: opts.timeout,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
