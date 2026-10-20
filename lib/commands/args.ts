// Argument parsing and output helpers shared by every command module.
import fs from 'node:fs';
import { loadJob } from '../jobs.ts';
import { ForgeError } from '../util.ts';
import { colorEnabled, render } from './render.ts';
import { RENDERERS } from './render/index.ts';
import type { HelpGroup, LoadedJob } from '../types.ts';

/**
 * Flags that take no value, so `forge --json job list` doesn't read `job` as the value of --json,
 * `forge doctor --include-text <job>` doesn't read the job as the flag's, `forge job audit --csv <id>` keeps its id,
 * `forge job archive --done <id>` is refused as a usage error instead of reading the id as --done's value,
 * `forge focus --clear <id>` is refused rather than reading the id as --clear's,
 * and `forge dash --quiet` never swallows the argument after it.
 */
const BOOLEAN_FLAGS = new Set(['json', 'help', 'pretty', 'include-text', 'csv', 'done', 'dry-run', 'clear', 'no-issue', 'verify-only', 'confirm', 'quiet']);

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
      const val = eq > 0 ? a.slice(eq + 1) : !BOOLEAN_FLAGS.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (key in flags) flags[key] = ([] as unknown[]).concat(flags[key], val);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

/** Comma-split list flags (not `--field`, whose values may be JSON arrays). */
export const list = (v: any): string[] => (v === undefined || v === true ? [] : ([] as unknown[]).concat(v).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean));

/** The tokens Forge reads its own flags from: everything before the first `--`, which starts paths. */
const head = (argv: readonly string[]): readonly string[] => {
  const end = argv.indexOf('--');
  return end < 0 ? argv : argv.slice(0, end);
};

/** Whether the call asked for JSON: a bare `--json` before the first `--`. */
export function jsonFlag(argv: readonly string[]): boolean {
  return head(argv).includes('--json');
}

/**
 * argv without Forge's `--json`, for `forge git`: git never sees it. Only exact `--json` tokens before
 * `--` go, so a refused git option stays in place to be refused and a path after `--` is untouched.
 */
export function withoutJson(argv: readonly string[]): string[] {
  const end = argv.indexOf('--');
  return argv.filter((a, i) => a !== '--json' || (end >= 0 && i > end));
}

/** Output for a terminal (human) or a program (agent): docs/CLI.md "Output mode". */
export const OUTPUT_MODES = ['human', 'agent'] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

// Agent by default, so in-process callers (tests, dispatch) keep the JSON contract; only main() sets it.
let mode: OutputMode = 'agent';
export function setOutputMode(m: OutputMode): void {
  mode = m;
}
export function outputMode(): OutputMode {
  return mode;
}

// The outer call's renderer key (renderKey in lib/commands/render/index.ts), set once by main()
// beside the mode, so a command printing through out() itself gets its renderer without a new argument.
let renderKeyed: string | undefined;
export function setRenderKey(k: string | undefined): void {
  renderKeyed = k;
}
export function renderKeyOf(): string | undefined {
  return renderKeyed;
}

const MODES = OUTPUT_MODES.join(', ');

/** The --mode flag's value, or undefined when absent; a bare, repeated or unknown value is a usage error. */
function modeFlag(argv: readonly string[]): OutputMode | undefined {
  const v = parseArgs([...head(argv)]).flags.mode;
  if (v === undefined) return undefined;
  if (v === true || v === '') throw new ForgeError(`missing value for --mode (${MODES})`, 'usage');
  if (Array.isArray(v)) throw new ForgeError(`--mode given more than once (${MODES})`, 'usage');
  return oneOf(v, OUTPUT_MODES, 'output mode');
}

/** FORGE_MODE, or undefined when unset or empty; an unknown value is a usage error. */
function modeEnv(env: NodeJS.ProcessEnv): OutputMode | undefined {
  return env.FORGE_MODE ? oneOf(env.FORGE_MODE, OUTPUT_MODES, 'FORGE_MODE') : undefined;
}

/**
 * The call's output mode: --json, then --mode, then FORGE_MODE, then human only on a terminal.
 * Both values are validated before --json wins, so a bad one always fails.
 */
export function resolveOutputMode(argv: readonly string[], env: NodeJS.ProcessEnv, isTTY: boolean): OutputMode {
  const flag = modeFlag(argv);
  const fromEnv = modeEnv(env);
  if (jsonFlag(argv)) return 'agent';
  return flag ?? fromEnv ?? (isTTY ? 'human' : 'agent');
}

/** resolveOutputMode for reporting an error: an invalid value is skipped rather than thrown. */
export function lenientOutputMode(argv: readonly string[], env: NodeJS.ProcessEnv, isTTY: boolean): OutputMode {
  const safe = (f: () => OutputMode | undefined): OutputMode | undefined => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  if (jsonFlag(argv)) return 'agent';
  return safe(() => modeFlag(argv)) ?? safe(() => modeEnv(env)) ?? (isTTY ? 'human' : 'agent');
}

/**
 * argv without Forge's `--mode`, so help, `forge git` (git would read it as its own option),
 * `forge run`'s forwarded args and every command see the call as if it was never typed. Only tokens
 * before `--` go: `--mode=<v>`, and a bare `--mode` with the next token when parseArgs would take it
 * as the value (it exists and does not start with `--`).
 */
export function withoutMode(argv: readonly string[]): string[] {
  const end = argv.indexOf('--');
  const stop = end < 0 ? argv.length : end;
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (i >= stop) kept.push(a);
    else if (a.startsWith('--mode=')) continue;
    else if (a === '--mode') {
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) i++;
    } else kept.push(a);
  }
  return kept;
}

/**
 * Strings print raw (JSON-encoded under --json). Everything else is compact JSON in agent mode, or
 * in human mode the outer command's own renderer's text, else the generic renderer's.
 */
export function out(data: unknown, flags: Record<string, any>): void {
  if (typeof data === 'string' && !flags.json) return void process.stdout.write(data.endsWith('\n') ? data : data + '\n');
  if (mode === 'human' && !flags.json) {
    const opts = { color: colorEnabled(process.stdout.isTTY === true, process.env), now: Date.now(), all: flags.all === true };
    const own = renderKeyed === undefined ? null : RENDERERS[renderKeyed](data, opts);
    return void process.stdout.write((own ?? render(data, opts)) + '\n');
  }
  process.stdout.write(JSON.stringify(data, null, flags.pretty ? 2 : 0) + '\n');
}

export function bodyFrom(flags: Record<string, any>): string {
  if (flags['body-file']) return flags['body-file'] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(String(flags['body-file']), 'utf8');
  return flags.body ? String(flags.body) : '';
}

export function req(v: any, what: string): string {
  if (v === undefined || v === null || v === '' || v === true) throw new ForgeError(`missing ${what}`, 'usage');
  return String(v);
}

/**
 * A string flag. A bare `--flag` (its value swallowed because it started with --) or `--flag=`
 * would otherwise be stored as `true` or "", and a repeated flag as an array.
 */
export function str(v: unknown, flag: string): string | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === '') throw new ForgeError(`missing value for ${flag} (write ${flag}=<value> if the value starts with --)`, 'usage');
  if (Array.isArray(v)) throw new ForgeError(`${flag} given more than once`, 'usage');
  return String(v);
}

/** A count flag: Number() alone turns "abc" into NaN and lets negatives through into job state. */
export function num(v: unknown, flag: string, opts: { integer?: boolean } = {}): number | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === '') throw new ForgeError(`missing value for ${flag}`, 'usage');
  const n = Array.isArray(v) ? NaN : Number(v);
  if (!Number.isFinite(n) || n < 0 || (opts.integer && !Number.isInteger(n))) throw new ForgeError(`${flag} must be a non-negative ${opts.integer ? 'integer' : 'number'} (got ${JSON.stringify(String(v))})`, 'usage');
  return n;
}

/** A closed set of words, so an invented value fails instead of being logged as if it meant something. */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  const s = req(v, `${what} (${allowed.join('|')})`);
  if (!(allowed as readonly string[]).includes(s)) throw new ForgeError(`unknown ${what} ${JSON.stringify(s)} (${allowed.join(', ')})`, 'usage');
  return s as T;
}

/** Checked before any write: updateJob's lock would otherwise create a ghost job directory. */
export function requireJob(root: string, id: unknown): LoadedJob {
  return loadJob(root, req(id, 'job id'));
}

/**
 * A `usage:` error built from the group's help table: the group's subcommands, or with `sub` known,
 * that subcommand's arguments. The hint names the help that explains it.
 */
export function usageError(group: HelpGroup, sub?: string): ForgeError {
  const words = sub === undefined ? null : group.commands.find((c) => c.command === `${group.name} ${sub}`);
  if (words) return new ForgeError(`usage: ${['forge', words.command, words.args].filter(Boolean).join(' ')}; run \`forge help ${words.command}\``, 'usage', `forge help ${words.command}`);
  const subs = group.commands.map((c) => c.command.slice(group.name.length + 1)).filter(Boolean).join('|');
  return new ForgeError(`usage: forge ${group.name} ${subs}; run \`forge help ${group.name}\``, 'usage', `forge help ${group.name}`);
}
