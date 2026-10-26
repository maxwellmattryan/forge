// A repo's release strategy (docs/CONFIG.md "Release strategy"): how it versions, which tool cuts a
// release, where it publishes and how often. Validation here, and doctor's check that the declared
// mechanism's tool is on this machine. Doctor only looks: it never runs `command`, `script` or the
// tool (`forge release run` does, lib/engine/release/run.ts).

import fs from 'node:fs';
import path from 'node:path';
import { show } from '../shape.ts';
import type { DoctorCheck, ReleaseStrategy } from '../types.ts';
import { findOnPath } from '../os/process.ts';
import { splitWords } from '../text.ts';

export const RELEASE_VERSIONINGS = ['semver', 'calver'] as const;
export const RELEASE_MECHANISMS = ['release-please', 'cargo-release', 'changesets', 'tag', 'script'] as const;
export const RELEASE_REGISTRIES = ['crates.io', 'npm', 'none'] as const;
export const RELEASE_CADENCES = ['on-merge', 'scheduled', 'manual'] as const;
export const RELEASE_PUBLISH = ['confirm', 'allow'] as const;
const COMMAND_MAX = 1000;
const SCRIPT_MAX = 200;
const SCRIPT_CHARS = /^[A-Za-z0-9._/-]+$/;

const unset = (v: unknown): boolean => v === undefined || v === null;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A `release.script` Forge may pass to `node` as its first argument: a relative path inside the repo with no
 * `.`, `..` or empty segment, never an option (`-r…`, `--require=…`), so the argv can only name a file there.
 */
export function isReleaseScript(s: unknown): s is string {
  if (typeof s !== 'string' || !s || s.length > SCRIPT_MAX || !SCRIPT_CHARS.test(s) || s.startsWith('-')) return false;
  // `node inspect` (and the old `node debug`) starts the debugger instead of reading a file.
  if (s === 'inspect' || s === 'debug') return false;
  return s.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Problems with the strategy keys of one `release` map (already known to be a map). */
export function strategyProblems(r: Record<string, any>, at: string): string[] {
  const problems: string[] = [];
  const enums: [string, readonly string[]][] = [
    ['versioning', RELEASE_VERSIONINGS],
    ['mechanism', RELEASE_MECHANISMS],
    ['registry', RELEASE_REGISTRIES],
    ['cadence', RELEASE_CADENCES],
    ['publish', RELEASE_PUBLISH],
  ];
  for (const [key, values] of enums)
    if (!unset(r[key]) && !values.includes(r[key])) problems.push(`${at}.${key} must be one of ${values.join(' | ')} (got ${show(r[key])})`);
  const c = r.command;
  if (r.mechanism === 'tag') {
    if (typeof c !== 'string' || !c.trim() || c.length > COMMAND_MAX || CONTROL.test(c))
      problems.push(`${at}.command must be a one-line command of at most ${COMMAND_MAX} characters when mechanism is tag (got ${show(c)})`);
  } else if (!unset(c)) problems.push(`${at}.command is only read when mechanism is tag; remove it or set mechanism: tag`);
  const s = r.script;
  if (r.mechanism === 'script') {
    if (!isReleaseScript(s))
      problems.push(`${at}.script must be a relative path inside the repo of at most ${SCRIPT_MAX} characters, using letters, digits and . _ / - (got ${show(s)})`);
  } else if (!unset(s)) problems.push(`${at}.script is only read when mechanism is script; remove it or set mechanism: script`);
  return problems;
}

// Characters that mean the shell, not the first word, decides what runs.
const SHELL_OPS = /[$`();|&<>]/;
const GLOB = /[*?[\]{}~]/;
const BUILTINS = new Set(['cd', '.', 'source', 'exec', 'eval', 'export', 'set', 'unset', 'if', 'for', 'while', 'until', 'case', 'command', 'builtin', 'time', '!']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program a tag `command` runs, or why that can't be told without a shell. */
export function commandProgram(command: string): { word: string } | { unknown: string } {
  let words: string[];
  try {
    words = splitWords(command, 'release.command');
  } catch (e) {
    return { unknown: (e as Error).message.replace(/^release\.command: /, '').replace(/ in ".*$/s, '') };
  }
  if (SHELL_OPS.test(command)) return { unknown: 'it uses shell syntax' };
  const word = words.find((w) => !ASSIGNMENT.test(w));
  if (word === undefined) return { unknown: 'no program after the variable assignments' };
  if (GLOB.test(word)) return { unknown: 'the program name uses shell syntax' };
  if (BUILTINS.has(word)) return { unknown: `${word} is a shell builtin` };
  return { word };
}

interface Tool {
  tool: string;
  hint: string;
  /** Looked up in `<dir>/node_modules/.bin` before PATH. */
  local?: boolean;
  /** A path from the command, resolved against the repo dir instead of PATH. */
  file?: string;
  /** `file` is `release.script`, which `node` reads: a regular file, executable or not. */
  script?: true;
}

const TOOLS: Record<Exclude<ReleaseStrategy['mechanism'], null | undefined | 'tag' | 'script'>, Tool> = {
  'release-please': { tool: 'release-please', hint: 'npm install --save-dev release-please', local: true },
  changesets: { tool: 'changeset', hint: 'npm install --save-dev @changesets/cli', local: true },
  'cargo-release': { tool: 'cargo-release', hint: 'cargo install cargo-release' },
};

/** What the script mechanism runs: the script under the Node that runs Forge, and the git and gh it calls. */
const SCRIPT_TOOLS: Tool[] = [
  { tool: 'node', hint: 'install Node.js' },
  { tool: 'git', hint: 'install git' },
  { tool: 'gh', hint: 'install the GitHub CLI: https://cli.github.com' },
];

function regularFile(file: string, platform: NodeJS.Platform, exec = true): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (exec && platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Doctor's check that `release.mechanism`'s tool is on this machine for the repo at `dir`. A missing
 * tool fails, or only warns when the cadence says releases run from CI.
 */
export function releaseMechanismCheck(name: string, dir: string, release: ReleaseStrategy, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DoctorCheck {
  const mechanism = release.mechanism;
  if (!mechanism) return { name, ok: true, detail: 'no release mechanism declared' };
  const bin = path.join(dir, 'node_modules', '.bin');
  const tools: Tool[] = [];
  const bad: string[] = [];
  let note = '';
  if (mechanism === 'tag') {
    tools.push({ tool: 'git', hint: 'install git' });
    const prog = commandProgram(String(release.command ?? ''));
    // Stat'ing a UNC path on Windows opens an SMB connection (and can leak the user's NTLM hash): doctor only looks locally.
    const unknown = 'unknown' in prog ? prog.unknown : platform === 'win32' && /^[\\/]{2}/.test(prog.word) ? 'it names a network path' : null;
    if (unknown !== null) note = `tag: cannot tell which program release.command runs (${unknown}); checked git only`;
    else if ('word' in prog) {
      const sep = platform === 'win32' ? /[\\/]/ : /\//;
      const hint = `install ${prog.word} or fix release.command`;
      tools.push(sep.test(prog.word) ? { tool: prog.word, hint, file: path.resolve(dir, prog.word) } : { tool: prog.word, hint });
    }
  } else if (mechanism === 'script') {
    tools.push(...SCRIPT_TOOLS);
    // Only a path validation accepts is stat'ed, so this never looks outside `dir`; nothing runs it.
    const script = release.script;
    if (isReleaseScript(script)) tools.push({ tool: script, hint: 'fix release.script', file: path.resolve(dir, script), script: true });
    else bad.push(`release.script ${show(script)} is not a relative path inside the repo; fix release.script`);
  } else tools.push(TOOLS[mechanism]);
  const found: string[] = [];
  const missing: string[] = [...bad];
  for (const t of tools) {
    const at = t.file
      ? regularFile(t.file, platform, !t.script)
        ? t.file
        : null
      : ((t.local ? findOnPath(t.tool, { PATH: bin, PATHEXT: env.PATHEXT }, platform) : null) ?? findOnPath(t.tool, env, platform));
    if (at) found.push(`${t.tool} at ${at}`);
    else if (t.script) missing.push(`release.script ${t.tool} is not a regular file at ${t.file}; ${t.hint}`);
    else {
      const where = t.file ? `at ${t.file}` : t.local ? `in ${bin} or on PATH` : 'on PATH';
      missing.push(`${t.tool} not found ${where}; install it: ${t.hint}`);
    }
  }
  if (missing.length) {
    const detail = `${mechanism}: ${missing.join('; ')}`;
    const c = release.cadence;
    if (c === 'on-merge' || c === 'scheduled')
      return { name, ok: true, warn: true, detail: `${detail}; cadence ${c} usually releases from CI, so this matters only to release from this machine` };
    return { name, ok: false, detail };
  }
  if (note) return { name, ok: true, warn: true, detail: note };
  return { name, ok: true, detail: `${mechanism}: ${found.join(', ')}` };
}
