// The human's browser: the opener for each platform, and the redirect file that hands it a link without putting the link (and its key) in any argv.
import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { ForgeError } from '#core/errors.ts';
import { splitWords } from '#core/text.ts';
import { writeAtomic } from '#core/os/fs.ts';

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
 * FORGE_EDITOR; `none` is no opener), else the platform's opener by absolute path. On Linux the opener is looked up
 * only in absolute PATH entries, so a checkout can never plant one through `.` or an empty entry.
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

/** Why a browser did not open; `headless` when the machine simply has no display or opener (an SSH session). */
export type OpenFailure = { reason: string; headless: boolean };

const REASONS: Record<string, string> = { 'no display': 'no display', 'not found': 'opener not found', 'unsupported platform': 'no opener for this platform' };

/**
 * Writes the redirect page for `url` to `file` (0600 from creation, atomically; its directory made 0700 when missing)
 * and starts the opener on that path: detached, no shell, stdio ignored, unref'd once it spawned. Resolves with why it
 * could not, or null (opened, or FORGE_BROWSER=none); never rejects. Nothing here starts a process by itself: the
 * caller passes `spawn`, and only `forge dash` passes the real one.
 */
export function openViaRedirect(
  file: string,
  url: string,
  opts: { spawn: typeof spawn; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; isExecutable?: (p: string) => boolean },
): Promise<OpenFailure | null> {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeAtomic(file, redirectHtml(url), { mode: 0o600 });
  } catch (e) {
    return Promise.resolve({ reason: `the redirect file could not be written: ${(e as Error).message}`, headless: false });
  }
  let found: BrowserArgv;
  try {
    found = browserArgv(file, { platform: opts.platform, env: opts.env, ...(opts.isExecutable ? { isExecutable: opts.isExecutable } : {}) });
  } catch (e) {
    return Promise.resolve({ reason: (e as Error).message, headless: false });
  }
  if ('reason' in found) {
    if (found.reason === 'none') return Promise.resolve(null);
    return Promise.resolve({ reason: REASONS[found.reason]!, headless: found.reason !== 'unsupported platform' });
  }
  const [cmd, ...args] = found.argv;
  return new Promise((resolve) => {
    try {
      const child = opts.spawn(cmd!, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => {
        child.unref();
        resolve(null);
      });
      child.once('error', (e) => resolve({ reason: (e as Error).message, headless: false }));
    } catch (e) {
      resolve({ reason: (e as Error).message, headless: false });
    }
  });
}
