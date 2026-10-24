// The PATH configured commands get: sanitised, and captured once from the login shell at `forge dash`
// start (docs/CONFIG.md "Command environment"). A relative or empty entry resolves in the command's
// cwd, the job's worktree, where the job's own code could plant a binary, so none survives.
import path from 'node:path';

/** The PATH `forge dash` captured from the login shell; daemon sessions and their `forge` calls inherit it. */
export const COMMAND_PATH_ENV = 'FORGE_COMMAND_PATH';
/** Where COMMAND_PATH_ENV came from: `login-shell (<shell>)` or `inherited: <reason>` (forge doctor shows it). */
export const COMMAND_PATH_SOURCE_ENV = 'FORGE_COMMAND_PATH_SOURCE';

/**
 * `value` without empty, relative or repeated entries (compared case-insensitively on win32), joined
 * with the platform's delimiter; `first`, when given, goes in front and its later copy is dropped.
 */
export function sanitizePath(value: string | null | undefined, platform: NodeJS.Platform = process.platform, first?: string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...(first ? [first] : []), ...String(value ?? '').split(p.delimiter)]) {
    if (!entry || !p.isAbsolute(entry)) continue;
    const key = platform === 'win32' ? entry.toUpperCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.join(p.delimiter);
}
