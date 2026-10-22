// The support matrix (docs/SUPPORT.md) as code: one definition of the platform tiers that doctor
// reports and the daemon and `forge update` refusals enforce, plus the POSIX sh resolver every
// configured command template runs through.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ForgeError } from './util.ts';

/** A full URL, not a relative path: doctor runs in other repos, where docs/ is not Forge's. */
export const SUPPORT_URL = 'https://github.com/maxwellmattryan/forge/blob/main/docs/SUPPORT.md';

const TIERS = ['supported', 'supported-with-notes', 'unsupported'] as const;
export type Tier = (typeof TIERS)[number];

export interface HostInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** /proc/version on Linux (it names Microsoft under WSL); null elsewhere or when unreadable. */
  procVersion: string | null;
}

export function hostInfo(): HostInfo {
  let procVersion: string | null = null;
  if (process.platform === 'linux') {
    try {
      procVersion = fs.readFileSync('/proc/version', 'utf8');
    } catch {
      procVersion = null;
    }
  }
  return { platform: process.platform, arch: process.arch, procVersion };
}

export function platformTier(host: HostInfo): Tier {
  if (host.platform === 'darwin') return 'supported';
  if (host.platform === 'linux') return /microsoft/i.test(host.procVersion ?? '') ? 'supported-with-notes' : 'supported';
  return 'unsupported';
}

/** The `platform` check's detail: the tier first, so the verdict reads at the start of the line. */
export function tierDetail(host: HostInfo): string {
  const where = `${host.platform} ${host.arch}`;
  switch (platformTier(host)) {
    case 'supported':
      return `supported: ${host.platform === 'darwin' ? 'macOS' : 'Linux'} (${where})`;
    case 'supported-with-notes':
      return `supported with notes: WSL2 (${where}); best effort, not tested in CI; keep the repo and its worktrees on the Linux filesystem, not under /mnt/: ${SUPPORT_URL}`;
    default:
      if (host.platform === 'win32')
        return `unsupported: native Windows (${where}); the daemon and forge update are refused, the rest of the CLI runs but is not supported; use WSL2 for full support: ${SUPPORT_URL}`;
      return `unsupported: ${where}; nothing is refused, but Forge is tested only on macOS and Linux: ${SUPPORT_URL}`;
  }
}

export const WINDOWS_DAEMON_REFUSAL = `the daemon is not supported on native Windows (it needs POSIX process groups and ps); run Forge under WSL2 to use it: ${SUPPORT_URL}`;
export const WINDOWS_UPDATE_REFUSAL = `forge update is not supported on native Windows; update the plugin from Claude Code or git pull your clone: ${SUPPORT_URL}`;

/** Why the daemon can't start on this platform, or null when it can. */
export function daemonPlatformProblem(platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'win32' ? WINDOWS_DAEMON_REFUSAL : null;
}

/** Whether the first `major.minor` in `text` (e.g. `git --version` output) is at least `min`. */
export function versionAtLeast(text: string, [major, minor]: [number, number]): boolean {
  const m = /(\d+)\.(\d+)/.exec(String(text ?? ''));
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}

/** What templates run under off Windows when $SHELL is unset. */
const DEFAULT_SH = '/bin/sh';

export interface PosixShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The first absolute path `where` finds for `cmd`, or null. */
  where?: (cmd: string) => string | null;
  exists?: (p: string) => boolean;
}

/**
 * where.exe by absolute path: spawning a bare `where` would itself search the current directory
 * first on Windows, and run a `where.exe` planted in the repo.
 */
export function whereExe(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
}

/**
 * `where $PATH:sh` searches PATH only: plain `where sh` looks in the current directory first, which
 * would run a `sh.exe` planted in the repo. Only an absolute `.exe` counts, because spawn refuses a
 * .bat or .cmd without a shell.
 */
function defaultWhere(cmd: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync(whereExe(env), [`$PATH:${cmd}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l) && path.win32.isAbsolute(l)) ?? null;
  } catch {
    return null;
  }
}

/**
 * The shell configured command templates run under, as `<shell> -lc <cmd>`. Off Windows that is
 * $SHELL or /bin/sh. On Windows $SHELL is ignored, because Git Bash exports an MSYS path
 * (`/usr/bin/bash`) that spawn can't use; Git for Windows' sh is found on PATH or where its
 * installer puts it, and without one the templates can't run at all.
 */
export function posixShell(opts: PosixShellOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== 'win32') return env.SHELL || DEFAULT_SH;
  const found = opts.where ? opts.where('sh') : defaultWhere('sh', env);
  if (found) return found;
  const bundled = path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'sh.exe');
  if ((opts.exists ?? fs.existsSync)(bundled)) return bundled;
  throw new ForgeError(
    `command templates are POSIX sh, and no sh was found on PATH or at ${bundled}; install Git for Windows (Git Bash) or run Forge under WSL2: ${SUPPORT_URL}`,
  );
}
