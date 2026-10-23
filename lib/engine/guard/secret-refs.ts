// Secret references (docs/CONFIG.md "Secret references"): the value of a declared secret, read from
// its source only when a config sink renders `{secret.NAME}`. Tools run without a shell, with every
// field in argv after validation refused a leading `-`. An error names the secret, its source kind
// and the tool's last stderr line, never stdout or the value. Must not import run.ts or
// dev-server.ts: both reach this module through config-sinks-apply.ts.
import fs from 'node:fs';
import path from 'node:path';
import { MIN_SECRET } from './known-secrets.ts';
import { git } from '#integrations/git/runner.ts';
import { secretEntryProblems, secretSourceOf } from '#core/config/validators/secret-refs.ts';
import type { SecretSourceKind } from '#core/config/validators/secret-refs.ts';
import type { Config, SecretSource } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { findOnPath, run } from '#core/os/process.ts';
import { isInsidePath } from '#core/os/fs.ts';

const MAX_FILE = 64 * 1024;
const TOOL_TIMEOUT_MS = 30_000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Values read in this process, keyed by name and source, so a verify with several steps reads each source once. */
const memo = new Map<string, string>();

/** Forgets every value read so far (tests). */
export function clearSecretMemo(): void {
  memo.clear();
}

/** The declared entry for `name` and its source kind; throws for an undeclared or malformed one. */
function entryOf(config: Pick<Config, 'secrets'>, name: string): { entry: SecretSource; kind: SecretSourceKind } {
  const all = config.secrets && typeof config.secrets === 'object' ? config.secrets : {};
  if (!Object.hasOwn(all, name)) throw new ForgeError(`secret ${name} is not declared in secrets`);
  const entry = all[name];
  const kind = secretSourceOf(entry);
  const problems = secretEntryProblems(name, entry);
  if (!kind || problems.length) throw new ForgeError(`secret ${name} is invalid: ${problems.join('; ')}`, 'config_invalid');
  return { entry, kind };
}

/** The last non-empty line of a tool's stderr, capped: what an error may quote. */
const lastLine = (s: string): string =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 200) ?? '';

/** One tool's stdout; a failure to start or a non-zero exit throws with its last stderr line only. */
function tool(name: string, kind: SecretSourceKind, cmd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const r = run(cmd, args, { allowFail: true, env, timeoutMs: TOOL_TIMEOUT_MS });
  if (r.status === null) throw new ForgeError(`secret ${name} (${kind}) failed: ${cmd} could not run (${lastLine(r.stderr) || 'no output'})`);
  if (!r.ok) throw new ForgeError(`secret ${name} (${kind}) failed: ${cmd} exited ${r.status}${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ''}`);
  return r.stdout;
}

/** A regular file's text through one descriptor that follows no link and never blocks; throws a reason. */
function readConfined(file: string, realRoot: string): string {
  const link = fs.lstatSync(file);
  if (link.isSymbolicLink()) throw new ForgeError('is a symlink');
  if (!link.isFile()) throw new ForgeError('is not a regular file');
  // A hard link stays inside the repo by path while reading a file from anywhere.
  if (link.nlink > 1) throw new ForgeError('is a hard link');
  if (link.size > MAX_FILE) throw new ForgeError(`is larger than ${MAX_FILE / 1024} KiB`);
  const real = fs.realpathSync.native(file);
  const rel = path.relative(realRoot, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new ForgeError('resolves outside the repo');
  const fd = fs.openSync(real, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== link.dev || st.ino !== link.ino || st.size > MAX_FILE) throw new ForgeError('changed while it was read');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The repo-relative real path of a file source when git ignores it and does not track it; throws a reason. */
function ignoredRel(root: string, rel: string): { abs: string; realRoot: string; realRel: string } {
  if (!isInsidePath(rel)) throw new ForgeError('is not a relative path inside the repo');
  const realRoot = fs.realpathSync.native(root);
  const abs = path.join(realRoot, rel);
  let parentReal: string;
  try {
    parentReal = fs.realpathSync.native(path.dirname(abs));
  } catch {
    throw new ForgeError('does not exist');
  }
  const relParent = path.relative(realRoot, parentReal);
  if (relParent.startsWith('..') || path.isAbsolute(relParent)) throw new ForgeError('resolves outside the repo');
  const realRel = path.join(relParent, path.basename(abs)).split(path.sep).join('/');
  // Tracked files are not ignored (no --no-index), so one check refuses both.
  const ignored = git(realRoot, ['check-ignore', '-q', '--', realRel], { allowFail: true });
  if (!ignored.ok) throw new ForgeError('must be git-ignored and untracked');
  return { abs: path.join(parentReal, path.basename(abs)), realRoot, realRel };
}

/** The value of `key` in dotenv text: `#` comments and blanks skipped, `export ` and one pair of quotes stripped. */
export function dotenvValue(text: string, key: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const eq = body.indexOf('=');
    if (eq <= 0 || body.slice(0, eq).trim() !== key) continue;
    const v = body.slice(eq + 1).trim();
    return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0] ? v.slice(1, -1) : v;
  }
  return null;
}

function readSource(root: string, name: string, kind: SecretSourceKind, entry: SecretSource, opts: ResolveOptions): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if ('env' in entry) {
    const v = env[entry.env];
    if (v === undefined) throw new ForgeError(`secret ${name} (env): ${entry.env} is not set`);
    return v;
  }
  if ('keychain' in entry) {
    const { service, account } = entry.keychain;
    if (platform === 'darwin') return tool(name, kind, 'security', ['find-generic-password', '-s', service, ...(account ? ['-a', account] : []), '-w'], env);
    if (platform === 'linux') return tool(name, kind, 'secret-tool', ['lookup', 'service', service, ...(account ? ['account', account] : [])], env);
    throw new ForgeError(`secret ${name}: the keychain source is not supported on ${platform}`);
  }
  if ('op' in entry) return tool(name, kind, 'op', ['read', entry.op], env);
  try {
    const where = ignoredRel(root, entry.file);
    const text = readConfined(where.abs, where.realRoot);
    if (entry.key === undefined) return text;
    const v = dotenvValue(text, entry.key);
    if (v === null) throw new ForgeError(`has no ${entry.key}= line`);
    return v;
  } catch (e) {
    // ForgeError's `code` is Forge's own, not an errno: its reason is the message, and its code stays.
    if (e instanceof ForgeError) throw new ForgeError(`secret ${name} (file): ${entry.file} ${e.message}`, e.code);
    const code = (e as NodeJS.ErrnoException).code;
    throw new ForgeError(`secret ${name} (file): ${entry.file} ${code === 'ENOENT' ? 'does not exist' : code ? `is unreadable (${code})` : (e as Error).message}`);
  }
}

/**
 * The value of declared secret `name`, read from its source at most once per process. One trailing
 * newline is stripped, and a value under MIN_SECRET characters fails closed. Throws a ForgeError
 * naming the secret and its source kind, never the value.
 */
export function resolveSecret(root: string, config: Pick<Config, 'secrets'>, name: string, opts: ResolveOptions = {}): string {
  const { entry, kind } = entryOf(config, name);
  const key = `${name}\0${JSON.stringify(entry)}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const raw = readSource(root, name, kind, entry, opts);
  const v = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (v.length < MIN_SECRET) throw new ForgeError(`secret ${name} (${kind}) resolved to fewer than ${MIN_SECRET} characters; Forge can't redact a value that short`);
  memo.set(key, v);
  return v;
}

/** `forge secrets check`: whether `name` resolves, with the error when it doesn't. Never the value. */
export function checkSecret(root: string, config: Pick<Config, 'secrets'>, name: string, opts: ResolveOptions = {}): { ok: boolean; error?: string } {
  try {
    resolveSecret(root, config, name, opts);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * What `forge doctor` can see without reading a value: an unset env var, a missing tool, an
 * unsupported platform, a missing or unignored file. Never runs `security`, `secret-tool` or `op`,
 * which can prompt. One line per problem, labelled with the secret's name.
 */
export function secretAvailability(root: string, config: Pick<Config, 'secrets'>, opts: ResolveOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const out: string[] = [];
  for (const [name, entry] of Object.entries(config.secrets ?? {})) {
    const kind = secretSourceOf(entry);
    if (!kind || secretEntryProblems(name, entry).length) continue;
    if ('env' in entry) {
      if (env[entry.env] === undefined) out.push(`${name} (env): ${entry.env} is not set`);
    } else if ('keychain' in entry) {
      const bin = platform === 'darwin' ? 'security' : platform === 'linux' ? 'secret-tool' : null;
      if (!bin) out.push(`${name} (keychain): not supported on ${platform}`);
      else if (!findOnPath(bin, env, platform)) out.push(`${name} (keychain): ${bin} is not on PATH`);
    } else if ('op' in entry) {
      if (!findOnPath('op', env, platform)) out.push(`${name} (op): op is not on PATH`);
    } else {
      try {
        const where = ignoredRel(root, entry.file);
        const st = fs.lstatSync(where.abs);
        if (!st.isFile()) out.push(`${name} (file): ${entry.file} is not a regular file`);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        out.push(`${name} (file): ${entry.file} ${code === 'ENOENT' ? 'does not exist' : (e as Error).message}`);
      }
    }
  }
  return out;
}
