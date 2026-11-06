// Opening the login link in the human's browser: when `forge dash` opens it, the opener for each platform, and the redirect file that keeps the key out of every argv.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { machinePaths } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { splitWords } from '#core/text.ts';
import { writeAtomic } from '#core/os/fs.ts';

export type OpenDecision = { open: boolean; explicit: boolean; note?: string };

/**
 * Whether this `forge dash` run opens the browser, in the order the CLI documents: flag conflicts are usage errors,
 * FORGE_BROWSER=none turns it off for the whole machine (even with --open), then --no-open, then --open, and with
 * neither only a person's terminal (human mode, a TTY stdout, no --dev) opens. A daemon session is refused before this,
 * in `dash()`.
 */
export function shouldOpen(flags: Record<string, any>, opts: { env: NodeJS.ProcessEnv; mode: 'human' | 'agent'; isTTY: boolean }): OpenDecision {
  const open = Boolean(flags.open);
  const noOpen = Boolean(flags['no-open']);
  if (open && noOpen) throw new ForgeError('--open and --no-open contradict each other; pass one', 'usage', 'forge help dash');
  if ((open || noOpen) && (flags.service || flags.stop)) {
    throw new ForgeError(`--${open ? 'open' : 'no-open'} only applies to a dashboard this run reports or starts for a person, so it takes no --service or --stop`, 'usage', 'forge help dash');
  }
  if (opts.env.FORGE_BROWSER?.trim() === 'none') {
    return open ? { open: false, explicit: true, note: 'FORGE_BROWSER=none turned off --open; open the login link yourself' } : { open: false, explicit: false };
  }
  if (noOpen) return { open: false, explicit: true };
  if (open) return { open: true, explicit: true };
  return { open: opts.mode === 'human' && opts.isTTY === true && !flags.dev, explicit: false };
}

export type BrowserArgv = { argv: string[] } | { reason: 'none' | 'no display' | 'not found' | 'unsupported platform' };

/** A regular file this user may execute. */
function executable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The opener's argv for `file`, without a shell: FORGE_BROWSER from the human's own environment (split like
 * FORGE_EDITOR), else the platform's opener by absolute path. On Linux the opener is looked up only in absolute PATH
 * entries, so a checkout can never plant one through `.` or an empty entry.
 */
export function browserArgv(file: string, opts: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; isExecutable?: (p: string) => boolean }): BrowserArgv {
  const { env, platform } = opts;
  const isExecutable = opts.isExecutable ?? executable;
  const chosen = env.FORGE_BROWSER?.trim();
  if (chosen === 'none') return { reason: 'none' };
  if (chosen) {
    const argv = splitWords(chosen, 'FORGE_BROWSER');
    if (!argv.length || !argv[0]) throw new ForgeError('FORGE_BROWSER names no command');
    return { argv: [...argv, file] };
  }
  if (platform === 'darwin') return { argv: ['/usr/bin/open', file] };
  if (platform === 'win32') return { argv: [path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), 'url.dll,FileProtocolHandler', file] };
  if (platform !== 'linux') return { reason: 'unsupported platform' };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { reason: 'no display' };
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  for (const name of ['xdg-open', 'wslview']) {
    for (const dir of dirs) {
      const p = path.join(dir, name);
      if (isExecutable(p)) return { argv: [p, file] };
    }
  }
  return { reason: 'not found' };
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** The redirect page: a meta refresh to `url` and a fallback link, `url` escaped, no script, no Referer. */
export function redirectHtml(url: string): string {
  const esc = url.replace(/[&<>"']/g, (c) => ENTITIES[c]!);
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${esc}"><title>Forge dashboard</title><a href="${esc}">Open the Forge dashboard</a>\n`;
}

/** `<FORGE_HOME>/runtime/dashboard-open.html`. */
export function dashboardOpenFile(home: string): string {
  return machinePaths(home).dashboardOpen;
}

const REASONS: Record<string, string> = {
  'no display': 'no display',
  'not found': 'opener not found',
  'unsupported platform': 'no opener for this platform',
};

/**
 * Writes the redirect file (0600, in a 0700 runtime dir) and hands its path, never the link, to the opener: detached,
 * no shell, stdio ignored. Never throws: a failure is one stderr line, skipped when the open was implicit and the
 * machine simply has no display or opener (an SSH session, a headless box).
 */
export function openDashboard(
  home: string,
  url: string,
  opts: { explicit: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; spawn?: typeof nodeSpawn; isExecutable?: (p: string) => boolean; stderr?: (line: string) => void },
): Promise<void> {
  const env = opts.env ?? process.env;
  const write = opts.stderr ?? ((line: string) => void process.stderr.write(line));
  const fail = (reason: string, quietWhenImplicit = false): void => {
    if (quietWhenImplicit && !opts.explicit) return;
    write(`could not open a browser (${reason}); open the login link above, or run forge dash url\n`);
  };
  const file = dashboardOpenFile(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeAtomic(file, redirectHtml(url), { mode: 0o600 });
  } catch (e) {
    fail(`the redirect file could not be written: ${(e as Error).message}`);
    return Promise.resolve();
  }
  let found: BrowserArgv;
  try {
    found = browserArgv(file, { platform: opts.platform ?? process.platform, env, ...(opts.isExecutable ? { isExecutable: opts.isExecutable } : {}) });
  } catch (e) {
    fail((e as Error).message);
    return Promise.resolve();
  }
  if ('reason' in found) {
    if (found.reason !== 'none') fail(REASONS[found.reason]!, found.reason === 'no display' || found.reason === 'not found');
    return Promise.resolve();
  }
  const [cmd, ...args] = found.argv;
  return new Promise((resolve) => {
    try {
      const child = (opts.spawn ?? nodeSpawn)(cmd!, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', (e) => {
        fail((e as Error).message);
        resolve();
      });
    } catch (e) {
      fail((e as Error).message);
      resolve();
    }
  });
}

/** `forge dash --stop`: removes the redirect file; a missing one is fine. */
export function clearDashboardOpen(home: string): void {
  try {
    fs.rmSync(dashboardOpenFile(home), { force: true });
  } catch {}
}
