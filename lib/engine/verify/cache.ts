// The check cache: passes of configured commands on a clean committed tree, which `forge verify`
// reuses instead of running the command again.
// The file sits in `.forge/runtime/checks/`. Claude Code's file tools can't edit it (the
// `Edit(.forge/runtime/**)` deny rule), but code a configured command runs can append to it, unattended
// too (docs/architecture/daemon-security.md: configured commands are not sandboxed), so it is read as
// hostile: without following links, size-capped, every field checked, and nothing here throws on a bad
// shape (a bad line is no pass). Only hashes are stored, never env values or the command line. Imports
// nothing in lib/engine/verify/ and never ../workspace/run.ts, which imports it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATUS_ARGV, git } from '#integrations/git/runner.ts';
import { hiddenChanges } from '../guard/integrity.ts';
import { paths } from '#core/paths.ts';
import { openAppend } from '#core/job/session-files.ts';
import { confinedDir, readRegularText, writeTextAtomic } from '#core/os/fs.ts';
import type { Config } from '#core/types.ts';
import { now } from '#core/utils.ts';

/** A pass is reused only this long: it bounds a toolchain change outside the tree. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Past this many lines the file is rewritten with the newest KEEP_LINES. */
export const MAX_LINES = 200;
export const KEEP_LINES = 100;
const MAX_BYTES = 256 * 1024;
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const TREE = /^[0-9a-f]{40,64}$/;
const LOG = /^logs\/[A-Za-z0-9._-]{1,200}\.log$/;
const JOB_ID = /^[A-Za-z0-9._-]{1,200}$/;
/** The one shape `now()` writes: `at` flows into the verify report and the events, so it is never free text. */
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const REDACTED = '\u0000redacted';

/** Why verify ran a command it could have reused: the first key part that differs, in this order. */
export type CacheMiss = 'none' | 'tree' | 'command' | 'config' | 'env' | 'dirty' | 'unsupported';

/** A pass's key: the command name, and sha256 hex of its arguments, command line, environment and config. */
export interface CheckKey {
  name: string;
  args: string;
  cmd: string;
  env: string;
  config: string;
}

/** One recorded pass, as stored. */
export interface CheckPass extends CheckKey {
  v: 1;
  tree: string;
  at: string;
  durationMs: number;
  log: string;
}

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** What a key is built from: everything that decides what the command does, besides the tree. */
export interface KeyParts {
  name: string;
  args: string[];
  cmd: string;
  prelude: string;
  cwd: string;
  login: boolean;
  env: NodeJS.ProcessEnv;
  redact: readonly string[];
  config: Config;
}

/** The key of a run: a value equal to a redact entry is hashed as a fixed marker, so no secret is ever hashed alone. */
export function checkKey(p: KeyParts): CheckKey {
  const secrets = new Set(p.redact.filter((v) => typeof v === 'string' && v !== ''));
  const env = Object.entries(p.env)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([k, v]) => [k, secrets.has(v) ? REDACTED : v])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    name: p.name,
    args: sha(JSON.stringify(p.args)),
    cmd: sha(JSON.stringify([p.cmd, p.prelude, p.cwd, p.login])),
    env: sha(JSON.stringify(env)),
    config: sha(JSON.stringify(p.config)),
  };
}

/**
 * The worktree's committed tree when it is clean, as verify's `worktree-clean` reads clean: `git
 * status` prints nothing and hiddenChanges finds nothing. Anything that can't be read is dirty.
 */
export function treeState(worktree: string, config: Pick<Config, 'commands' | 'components' | 'evals'>): { tree: string } | { dirty: true } {
  try {
    if (git(worktree, [...STATUS_ARGV]).stdout.trim()) return { dirty: true };
    if (hiddenChanges(worktree, config).length) return { dirty: true };
    const tree = git(worktree, ['rev-parse', '--verify', 'HEAD^{tree}']).stdout.trim();
    return TREE.test(tree) ? { tree } : { dirty: true };
  } catch {
    return { dirty: true };
  }
}

function cacheFile(root: string, id: string): string {
  return path.join(paths(root).runtime, 'checks', `${id}.jsonl`);
}

/** A stored line as a pass, or null when any field has the wrong shape. */
function parsePass(line: string): CheckPass | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const e = v as Record<string, unknown>;
  if (e.v !== 1 || typeof e.name !== 'string' || !NAME.test(e.name)) return null;
  for (const k of ['args', 'cmd', 'env', 'config'] as const) if (typeof e[k] !== 'string' || !HASH.test(e[k])) return null;
  if (typeof e.tree !== 'string' || !TREE.test(e.tree) || typeof e.log !== 'string' || !LOG.test(e.log)) return null;
  if (typeof e.at !== 'string' || !AT.test(e.at) || !Number.isFinite(Date.parse(e.at))) return null;
  if (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs < 0) return null;
  return { v: 1, name: e.name, args: e.args as string, cmd: e.cmd as string, env: e.env as string, config: e.config as string, tree: e.tree, at: e.at, durationMs: e.durationMs, log: e.log };
}

/** Every well-formed line of the job's file, oldest first; none when the file is a link, not regular or too large. */
function readPasses(root: string, id: string): CheckPass[] {
  if (!JOB_ID.test(id)) return [];
  const text = readRegularText(cacheFile(root, id), MAX_BYTES);
  if (text === null) return [];
  return text.split('\n').flatMap((l) => {
    const p = l.trim() ? parsePass(l) : null;
    return p ? [p] : [];
  });
}

/**
 * The newest pass of the last MAX_AGE_MS whose key and tree match, or why there is none: `none` when
 * no pass has this name and these arguments, else the first of tree, command, config and env that
 * differs from the newest such pass. An entry from the future or past the age cap is no pass.
 */
export function findPass(root: string, id: string, key: CheckKey, tree: string, nowMs: number = Date.now()): { pass: CheckPass } | { miss: CacheMiss } {
  const fresh = readPasses(root, id).filter((p) => {
    const at = Date.parse(p.at);
    return at <= nowMs && nowMs - at <= MAX_AGE_MS && p.name === key.name && p.args === key.args;
  });
  const hit = fresh.findLast((p) => p.tree === tree && p.cmd === key.cmd && p.config === key.config && p.env === key.env);
  if (hit) return { pass: hit };
  const newest = fresh.at(-1);
  if (!newest) return { miss: 'none' };
  if (newest.tree !== tree) return { miss: 'tree' };
  if (newest.cmd !== key.cmd) return { miss: 'command' };
  if (newest.config !== key.config) return { miss: 'config' };
  return { miss: 'env' };
}

/**
 * Appends one pass to `.forge/runtime/checks/<id>.jsonl`, reached only through real directories
 * (confinedDir: a linked `checks/` throws). A result whose name or log has the wrong shape records
 * nothing. Past MAX_LINES the file is rewritten atomically with the newest KEEP_LINES; an append
 * another process made during that rewrite is lost, which is only a later miss.
 */
export function recordPass(root: string, id: string, key: CheckKey, tree: string, result: { durationMs: number; log: string }): void {
  if (!JOB_ID.test(id) || !NAME.test(key.name) || !TREE.test(tree) || !LOG.test(result.log)) return;
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) return;
  const dir = confinedDir(paths(root).dir, path.join(paths(root).runtime, 'checks'));
  const file = path.join(dir, `${id}.jsonl`);
  const line = JSON.stringify({ v: 1, ...key, tree, at: now(), durationMs: result.durationMs, log: result.log } satisfies CheckPass) + '\n';
  const text = readRegularText(file, MAX_BYTES);
  const lines = text === null ? [] : text.split('\n').filter((l) => l.trim());
  // A link, a FIFO or an oversized file is replaced by a regular one, never written through; so is a full one.
  if ((text === null && present(file)) || lines.length + 1 > MAX_LINES) {
    writeTextAtomic(file, [...lines.slice(-(KEEP_LINES - 1)), line].join('\n'), { root: paths(root).dir });
    return;
  }
  // openAppend: no link followed, no block on a FIFO swapped in since the read above, and a non-regular file refused.
  const fd = openAppend(file);
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether anything, a dangling link included, sits at `p`. */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
