// Argument parsing and output helpers shared by every command module.
import fs from 'node:fs';
import { ForgeError } from '../util.ts';

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
export function out(data: any, flags: Record<string, any>): void {
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
