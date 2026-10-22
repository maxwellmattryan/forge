// Small file helpers: JSON and text reads with fallbacks, atomic and owner-only writes, and the check
// that a path stays inside the checkout.
import fs from 'node:fs';
import path from 'node:path';
import { ForgeError } from '../errors.ts';

export function readJson(file: string, fallback?: any): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && (e as any).code === 'ENOENT') return fallback;
    throw new ForgeError(`cannot read ${file}: ${(e as Error).message}`);
  }
}

/**
 * Write-then-rename so readers (the dashboard, other sessions) never see a half-written file.
 */
export function writeJsonAtomic(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** writeJsonAtomic for a file only its owner may read (mode 0600 from creation, never wider): credentials. */
export function writeJsonPrivate(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  // `wx` refuses a planted file or symlink at the temp path.
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readText(file: string, fallback = ''): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * A component's path becomes the cwd of its shell commands (path.join(worktree, path)), so it must
 * stay inside the checkout: no absolute path, drive letter or `..` segment on either separator.
 * Here rather than in components.ts so config-sinks.ts can use it without a cycle.
 */
export function isInsidePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (path.isAbsolute(p) || /^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[/\\]/).includes('..');
}
