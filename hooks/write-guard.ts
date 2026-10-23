#!/usr/bin/env node
// PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit): confines a daemon session's file writes to its
// write roots, the job folders under .forge/jobs/<id>/ and the job worktrees, which `forge dash` passes
// as FORGE_DAEMON_WRITE_ROOTS. Outside a daemon session (no FORGE_DAEMON=1) it allows everything, so a
// human's own sessions are unchanged. It fails closed: anything it can't check is refused. Node
// built-ins only and no lib/ import, so a broken lib module can't change its verdict.
// docs/architecture/daemon-security.md describes the layers around it.
import fs from 'node:fs';
import path from 'node:path';

/** Job folder entries only the CLI writes, matched case-insensitively at the folder's top. */
const CLI_OWNED = ['job.json', 'events.jsonl', '.lock'];
/** Instructions a later agent would load, refused at any depth of a job folder. */
const INSTRUCTIONS = ['claude.md', 'claude.local.md'];

/** A `.git` segment, ignoring case: git's control path, refused anywhere inside a write root. */
const isGit = (segment: string): boolean => segment.toLowerCase() === '.git';

function refuse(text: string): never {
  process.stderr.write(`Blocked by Forge: ${text}\n`);
  process.exit(2);
}

function outside(given: string, real: string): never {
  const shown = given === real ? JSON.stringify(given) : `${JSON.stringify(given)} (resolving to ${JSON.stringify(real)})`;
  refuse(
    `a daemon session may write only inside a job folder under .forge/jobs/<id>/ (not job.json, events.jsonl, .lock or CLAUDE.md, which only the CLI writes) or a job worktree (not a .git path or a ~ path); ${shown} is outside them. ` +
      'Write job outputs to the job folder and code to the worktree, and change Forge state through forge.',
  );
}

/** The roots from the environment, or null when they are missing or malformed. */
function writeRoots(raw: string | undefined): { jobs: string; worktrees: string[] } | null {
  if (!raw) return null;
  const v = JSON.parse(raw);
  const abs = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && path.isAbsolute(p);
  if (!v || typeof v !== 'object' || !abs(v.jobs) || !Array.isArray(v.worktrees) || !v.worktrees.every(abs)) return null;
  return { jobs: v.jobs, worktrees: v.worktrees };
}

/**
 * Where a write to `abs` lands: the realpath of the file when it exists (a dangling link throws),
 * else the realpath of its deepest existing ancestor with the rest re-appended. Any error but
 * ENOENT throws, and so is refused.
 */
function landing(abs: string): string {
  let present = true;
  try {
    fs.lstatSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    present = false;
  }
  // A dangling link exists to lstat but not to realpath, which throws: refused, never walked past.
  if (present) return fs.realpathSync.native(abs);
  let dir = abs;
  const rest: string[] = [];
  for (;;) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`no existing ancestor of ${abs}`);
    rest.unshift(path.basename(dir));
    dir = up;
    try {
      fs.lstatSync(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return path.join(fs.realpathSync.native(dir), ...rest);
}

/** The segments of `child` under `parent`, or null when it isn't strictly inside. */
function under(parent: string, child: string): string[] | null {
  const rel = path.relative(parent, child);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

function check(input: string): void {
  let event: any;
  try {
    event = JSON.parse(input);
  } catch {
    refuse('the write guard got input that is not JSON, so it refuses the write.');
  }
  const tool = event?.tool_input ?? {};
  const given = event?.tool_name === 'NotebookEdit' ? (tool.notebook_path ?? tool.file_path) : tool.file_path;
  if (typeof given !== 'string' || !given || given.includes('\0')) refuse('the write guard found no file path in this call, so it refuses the write.');
  let roots: ReturnType<typeof writeRoots> = null;
  try {
    roots = writeRoots(process.env.FORGE_DAEMON_WRITE_ROOTS);
  } catch {}
  if (!roots) refuse('FORGE_DAEMON_WRITE_ROOTS is missing or malformed, so the write guard refuses every write; a human restarts the daemon from forge dash.');
  // The OS resolves `..` physically, through a symlink, while path.resolve collapses it lexically.
  if (given.split(/[/\\]/).includes('..')) outside(given, given);
  // Claude Code's file tools expand a leading `~` (and `~user`) to a home directory before writing, but
  // path.resolve takes it as a directory called `~` under the cwd, which may sit inside a write root.
  if (given.startsWith('~')) outside(given, given);
  const cwd = typeof event?.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  let real: string;
  try {
    real = landing(path.resolve(cwd, given));
  } catch {
    // A dangling link, or a path that can't be resolved: nowhere it lands can be checked.
    outside(given, given);
  }
  const job = under(roots.jobs, real);
  if (job) {
    // A job id and a file: .forge/jobs/stray.json is no job's.
    if (job.length < 2 || CLI_OWNED.includes(job[1].toLowerCase()) || job.some((s) => INSTRUCTIONS.includes(s.toLowerCase()) || isGit(s))) outside(given, real);
    return;
  }
  // A worktree's own `.git` file points git at its gitdir, and a rewritten one could name a config with a filter driver.
  const worktree = roots.worktrees.map((w) => under(w, real)).find((s) => s);
  if (worktree && !worktree.some(isGit)) return;
  outside(given, real);
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  if (process.env.FORGE_DAEMON !== '1') process.exit(0);
  try {
    check(input);
  } catch (e) {
    refuse(`the write guard could not check this write (${(e as Error)?.message ?? 'unknown error'}), so it refuses it.`);
  }
  process.exit(0);
});
