// Argument parsing and output helpers shared by every command module.
import fs from 'node:fs';
import { loadJob } from '../jobs.ts';
import { ForgeError } from '../util.ts';
import type { LoadedJob } from '../types.ts';

export function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, any> } {
  const pos: string[] = [];
  const flags: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq > 0 ? a.slice(eq + 1) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (key in flags) flags[key] = ([] as unknown[]).concat(flags[key], val);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

/** Comma-split list flags (not `--field`, whose values may be JSON arrays). */
export const list = (v: any): string[] => (v === undefined || v === true ? [] : ([] as unknown[]).concat(v).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean));

/** Strings print raw, everything else as compact JSON. */
export function out(data: unknown, flags: Record<string, any>): void {
  if (typeof data === 'string') return void process.stdout.write(data.endsWith('\n') ? data : data + '\n');
  process.stdout.write(JSON.stringify(data, null, flags.pretty ? 2 : 0) + '\n');
}

export function bodyFrom(flags: Record<string, any>): string {
  if (flags['body-file']) return flags['body-file'] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(String(flags['body-file']), 'utf8');
  return flags.body ? String(flags.body) : '';
}

export function req(v: any, what: string): string {
  if (v === undefined || v === null || v === '' || v === true) throw new ForgeError(`missing ${what}`);
  return String(v);
}

/**
 * A string flag. A bare `--flag` (its value swallowed because it started with --) or `--flag=`
 * would otherwise be stored as `true` or "", and a repeated flag as an array.
 */
export function str(v: unknown, flag: string): string | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === '') throw new ForgeError(`missing value for ${flag} (write ${flag}=<value> if the value starts with --)`);
  if (Array.isArray(v)) throw new ForgeError(`${flag} given more than once`);
  return String(v);
}

/** A count flag: Number() alone turns "abc" into NaN and lets negatives through into job state. */
export function num(v: unknown, flag: string, opts: { integer?: boolean } = {}): number | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === '') throw new ForgeError(`missing value for ${flag}`);
  const n = Array.isArray(v) ? NaN : Number(v);
  if (!Number.isFinite(n) || n < 0 || (opts.integer && !Number.isInteger(n))) throw new ForgeError(`${flag} must be a non-negative ${opts.integer ? 'integer' : 'number'} (got ${JSON.stringify(String(v))})`);
  return n;
}

/** A closed set of words, so an invented value fails instead of being logged as if it meant something. */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  const s = req(v, `${what} (${allowed.join('|')})`);
  if (!(allowed as readonly string[]).includes(s)) throw new ForgeError(`unknown ${what} ${JSON.stringify(s)} (${allowed.join(', ')})`);
  return s as T;
}

/** Checked before any write: updateJob's lock would otherwise create a ghost job directory. */
export function requireJob(root: string, id: unknown): LoadedJob {
  return loadJob(root, req(id, 'job id'));
}
