// What a configured command inherits (docs/CONFIG.md "Daemon" and "Secret references"): the
// environment every spawn site builds on, and the shell argv it runs under. Under the daemon,
// session code a reviewer has not read yet runs through these, so credentials and the login
// profile stay out of it.
import { posixShell } from '#core/os/platform.ts';
import type { PosixShellOptions } from '#core/os/platform.ts';
import type { Config } from '#core/types.ts';

// The daemon's trust check guards the session's own `forge` calls; a configured command that
// calls `forge` (a test suite on scratch repos) must behave as it does for a human.
const DAEMON_MARKER = /^FORGE_DAEMON(_|$)/;
// An outer job's per-component and backing variables would otherwise reach a nested job's
// commands (the suite run by `forge verify` driving scratch jobs) beside that job's own.
const JOB_VARS = /^FORGE_(PORT|ENDPOINT|BACKING)_/;

const DROP_PATTERNS = [/_(TOKEN|KEY|PAT)$/, /PASSWORD/, /(^|_)SECRET/, /^AWS_/, /^OP_SESSION_/];
const DROP_EXACT = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'CARGO_REGISTRY_TOKEN',
  'DATABASE_URL',
  'DOCKER_AUTH_CONFIG',
  'SSH_AUTH_SOCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'KUBECONFIG',
  'GH_CONFIG_DIR',
  'NETRC',
  // Start-up files a non-login shell still sources: they could put back what this filter removed.
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
]);
// Regions and a profile name select, they do not authenticate.
const KEEP = new Set(['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE']);

/**
 * Whether the daemon filter removes `name` from a command's inherited environment, case-insensitively.
 * The one function #393 swaps for an allowlist.
 */
export function daemonDrops(name: string): boolean {
  const upper = name.toUpperCase();
  if (KEEP.has(upper)) return false;
  return DROP_EXACT.has(upper) || DROP_PATTERNS.some((re) => re.test(upper));
}

/** The source variable of every declared `env` secret, malformed entries included: strip more, never less. */
function envSources(config: Pick<Config, 'secrets'>): string[] {
  const all: unknown = config?.secrets;
  if (!all || typeof all !== 'object') return [];
  const out: string[] = [];
  for (const entry of Object.values(all)) {
    const env = entry && typeof entry === 'object' ? (entry as { env?: unknown }).env : undefined;
    if (typeof env === 'string') out.push(env);
  }
  return out;
}

/**
 * A configured command's inherited environment: `base` without the daemon markers, an outer job's
 * variables or any declared secret's source variable (a sink passes the value), and under the daemon
 * (`base.FORGE_DAEMON === '1'`) without what daemonDrops matches. Callers add the job's own
 * variables after it, unfiltered. `base` is never mutated.
 */
export function commandEnv(config: Pick<Config, 'secrets'>, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const daemon = base.FORGE_DAEMON === '1';
  // Windows variable names are case-insensitive, so `Db_Src` there is the same variable as `DB_SRC`.
  const fold = (k: string) => (platform === 'win32' ? k.toUpperCase() : k);
  const sources = new Set(envSources(config).map(fold));
  for (const k of Object.keys(env)) {
    if (DAEMON_MARKER.test(k) || JOB_VARS.test(k) || sources.has(fold(k)) || (daemon && daemonDrops(k))) delete env[k];
  }
  return env;
}

export interface CommandShellOptions extends Pick<PosixShellOptions, 'where' | 'exists'> {
  /** Where the mode is read: the Forge process's own environment, never the command's. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** false: `-c` instead of `-lc` outside the daemon (notify.command). */
  login?: boolean;
}

/**
 * The program and arguments a configured command runs under. Under the daemon it is `/bin/sh -c`,
 * so no login profile, `.zshenv`, BASH_ENV or ENV file is sourced; otherwise `posixShell() -lc`
 * (`-c` with `login: false`). The daemon is refused on native Windows, so there it is always posixShell().
 */
export function commandShell(cmd: string, opts: CommandShellOptions = {}): { file: string; args: string[] } {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (env.FORGE_DAEMON === '1' && platform !== 'win32') return { file: '/bin/sh', args: ['-c', cmd] };
  return { file: posixShell({ env, platform, where: opts.where, exists: opts.exists }), args: [opts.login === false ? '-c' : '-lc', cmd] };
}
