// Argument parsing and output helpers shared by every command module.
import fs from 'node:fs';
import { ForgeError } from '../util.ts';

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {string[]} */
  const pos = [];
  /** @type {Record<string, any>} */
  const flags = {};
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
      if (key in flags) flags[key] = [].concat(flags[key], val);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

/** Comma-split list flags (not `--field`, whose values may be JSON arrays). @param {any} v */
export const list = (v) => (v === undefined || v === true ? [] : [].concat(v).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean));

/** Strings print raw, everything else as compact JSON. @param {any} data @param {Record<string, any>} flags */
export function out(data, flags) {
  if (typeof data === 'string') return void process.stdout.write(data.endsWith('\n') ? data : data + '\n');
  process.stdout.write(JSON.stringify(data, null, flags.pretty ? 2 : 0) + '\n');
}

/** @param {Record<string, any>} flags */
export function bodyFrom(flags) {
  if (flags['body-file']) return flags['body-file'] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(String(flags['body-file']), 'utf8');
  return flags.body ? String(flags.body) : '';
}

/** @param {any} v @param {string} what @returns {string} */
export function req(v, what) {
  if (v === undefined || v === null || v === '' || v === true) throw new ForgeError(`missing ${what}`);
  return String(v);
}
