// Claude Code transcripts of this repo's sessions and their agents, located from job state only.
// Every id that becomes a path segment comes from job.json, which an agent or a checkout can write,
// so ids are validated, only this repo's project dirs are tried, and each hit is resolved and
// confined under the projects dir before it is opened (one non-blocking, no-follow descriptor).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, worktreeRoot } from './config.ts';
import { UUID } from './daemon-files.ts';
import type { Job, TranscriptActivity } from './types.ts';

/** A Claude Code agent id: what `--agent-id` and job.json's `agentId` must look like before use. */
export const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** How many of a job's past orchestrator sessions are tried for an agent's transcript, newest first. */
export const MAX_RUN_SESSIONS = 5;
/** lastActivity reads at most this much of a transcript's end. */
export const ACTIVITY_TAIL_BYTES = 64 * 1024;
export const ACTIVITY_CHARS = 160;
const CACHE_MAX = 64;
const TARGET_KEYS = ['file_path', 'notebook_path', 'path', 'pattern', 'command', 'url', 'query', 'description', 'skill'];
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path']);

type JobRefs = Pick<Job, 'id' | 'lease' | 'runs' | 'agents' | 'worktree'>;

/** A located transcript: its resolved path and the project dir (`<projects>/<slug>`) it was confined to. */
export interface TranscriptHit {
  path: string;
  dir: string;
}

export interface TranscriptOpts {
  /** The projects dir; defaults to claudeProjectsDir(). */
  projects?: string;
  /** The worktrees dir; defaults to worktrees.root from the repo's config. */
  worktrees?: string;
}

/** Where Claude Code keeps transcripts: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR;
  return base ? path.resolve(base, 'projects') : path.join(os.homedir(), '.claude', 'projects');
}

/** Claude Code's project dir name for a cwd: every character outside [A-Za-z0-9] becomes `-`. */
export function projectSlug(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

/** The repo's worktrees dir (worktrees.root), or null when the config can't be read. */
export function worktreesDir(root: string): string | null {
  try {
    return worktreeRoot(root, loadConfig(root).config);
  } catch {
    return null;
  }
}

/** `child` is under `parent`, both as written and after resolving whichever of them exist. */
function under(parent: string, child: string): boolean {
  const inside = (a: string, b: string) => {
    const rel = path.relative(a, b);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  return inside(path.resolve(parent), path.resolve(child)) && inside(realOrSelf(parent), realOrSelf(child));
}

/**
 * The job's worktree when it is this repo's: exactly `<worktrees>/<id>` or under the worktrees dir.
 * job.json is agent-writable, so a worktree pointing at another repo would otherwise add that repo's
 * project dir to the lookup.
 */
function ownWorktree(root: string, job: Pick<Job, 'id' | 'worktree'>, worktrees: string | null | undefined): string | null {
  const wt = job.worktree;
  if (typeof wt !== 'string' || !wt || !path.isAbsolute(wt)) return null;
  const dir = worktrees === undefined ? worktreesDir(root) : worktrees;
  if (!dir) return null;
  if (path.resolve(wt) === path.join(path.resolve(dir), job.id) || under(dir, wt)) return wt;
  return null;
}

/** The project dirs this repo's sessions write to: the slugs of root, its realpath and the job's own worktree. */
export function transcriptProjectDirs(root: string, job: Pick<Job, 'id' | 'worktree'> | null, projects = claudeProjectsDir(), worktrees?: string | null): string[] {
  const cwds = [root];
  try {
    cwds.push(fs.realpathSync(root));
  } catch {}
  const wt = job ? ownWorktree(root, job, worktrees) : null;
  if (wt) cwds.push(wt);
  return [...new Set(cwds.map((c) => path.join(projects, projectSlug(c))))];
}

/** The sessions an agent of this job may have run under: the owner's, then past runs newest first. */
function jobSessions(job: JobRefs): string[] {
  const runs = (Array.isArray(job.runs) ? job.runs : []).map((r) => r?.session).reverse().slice(0, MAX_RUN_SESSIONS);
  const ids = [job.lease?.driver, ...runs].filter((s): s is string => typeof s === 'string' && UUID.test(s));
  return [...new Set(ids)];
}

const SLUG = /^[A-Za-z0-9-]+$/;

/** The resolved project dir when `dir` is a slug dir that resolves to exactly `<real projects>/<slug>`, else null. */
function realSlugDir(projectsReal: string, dir: string): string | null {
  try {
    const slug = path.basename(dir);
    if (!SLUG.test(slug)) return null;
    const dirReal = fs.realpathSync(dir);
    return dirReal === path.join(projectsReal, slug) ? dirReal : null;
  } catch {
    return null;
  }
}

/**
 * `<dir>/<...segments>` resolved, when dir is exactly `<real projects>/<slug>` (not a symlink to
 * elsewhere), the file resolves inside it, and it is a regular file. Null otherwise.
 */
function confined(projectsReal: string, dir: string, segments: string[]): TranscriptHit | null {
  try {
    const dirReal = realSlugDir(projectsReal, dir);
    if (!dirReal) return null;
    const real = fs.realpathSync(path.join(dir, ...segments));
    if (!real.startsWith(dirReal + path.sep)) return null;
    return fs.statSync(real).isFile() ? { path: real, dir: dirReal } : null;
  } catch {
    return null;
  }
}

function realProjects(projects: string): string | null {
  try {
    return fs.realpathSync(projects);
  } catch {
    return null;
  }
}

/** The transcript of agent `agentId` under one of this job's sessions, or null. */
export function agentTranscriptById(root: string, job: JobRefs, agentId: unknown, opts: TranscriptOpts = {}): TranscriptHit | null {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return null;
  const projects = opts.projects ?? claudeProjectsDir();
  const projectsReal = realProjects(projects);
  if (!projectsReal) return null;
  const sessions = jobSessions(job);
  for (const dir of transcriptProjectDirs(root, job, projects, opts.worktrees)) {
    for (const s of sessions) {
      const hit = confined(projectsReal, dir, [s, 'subagents', `agent-${agentId}.jsonl`]);
      if (hit) return hit;
    }
  }
  return null;
}

/** The transcript of the agent recorded for `role`, or null (no such role, no valid id, no file). */
export function agentTranscript(root: string, job: JobRefs, role: string, opts: TranscriptOpts = {}): TranscriptHit | null {
  const agents = job.agents ?? {};
  if (!Object.hasOwn(agents, role)) return null;
  return agentTranscriptById(root, job, agents[role]?.agentId, opts);
}

/** The transcript of the job's owner session, or null. */
export function ownerTranscript(root: string, job: JobRefs, opts: TranscriptOpts = {}): TranscriptHit | null {
  const sid = job.lease?.driver;
  if (typeof sid !== 'string' || !UUID.test(sid)) return null;
  const projects = opts.projects ?? claudeProjectsDir();
  const projectsReal = realProjects(projects);
  if (!projectsReal) return null;
  for (const dir of transcriptProjectDirs(root, job, projects, opts.worktrees)) {
    const hit = confined(projectsReal, dir, [`${sid}.jsonl`]);
    if (hit) return hit;
  }
  return null;
}

/**
 * A descriptor for a located transcript, or null. Checked again at open: the hit's project dir must
 * still resolve to exactly `<real projects>/<slug>`, and the file's realpath must sit inside that
 * slug dir, not merely anywhere under the projects dir. O_NONBLOCK so a planted FIFO can't hang the
 * server (fstat rejects it); the path is resolved first, so O_NOFOLLOW only refuses a link swapped
 * in since. The caller closes the descriptor.
 */
export function openTranscript(hit: TranscriptHit, projects = claudeProjectsDir()): { fd: number; size: number; mtimeMs: number; path: string } | null {
  let fd: number | undefined;
  try {
    const dir = realSlugDir(fs.realpathSync(projects), hit.dir);
    if (!dir) return null;
    const real = fs.realpathSync(hit.path);
    if (!real.startsWith(dir + path.sep)) return null;
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      fs.closeSync(fd);
      return null;
    }
    return { fd, size: st.size, mtimeMs: st.mtimeMs, path: real };
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    return null;
  }
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const capText = (s: string): string => (s.length > ACTIVITY_CHARS ? `${s.slice(0, ACTIVITY_CHARS - 1)}…` : s);

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** A path shown relative to the worktree or root it sits under. */
function relativeTo(p: string, bases: string[]): string {
  for (const b of bases) if (b && p.startsWith(b + path.sep)) return p.slice(b.length + 1);
  return p;
}

function toolTarget(input: unknown, bases: string[]): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const i = input as Record<string, unknown>;
  for (const k of TARGET_KEYS) {
    const v = i[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (k === 'command') return v.trim().split('\n')[0];
    return PATH_KEYS.has(k) ? relativeTo(v, bases) : v;
  }
  return '';
}

/**
 * What the transcript's agent did last, from at most its last 64 KiB: the newest assistant line's
 * last tool call as `<Tool> <target>`, or else the first line of its text. Plain text, whitespace
 * collapsed, at most 160 characters. Null for an empty or unparseable tail.
 */
export function lastActivity(fd: number, size: number, opts: { worktree?: string | null; root?: string | null } = {}): TranscriptActivity | null {
  const len = Math.min(size, ACTIVITY_TAIL_BYTES);
  if (len <= 0) return null;
  const buf = Buffer.alloc(len);
  const read = fs.readSync(fd, buf, 0, len, size - len);
  const lines = buf.subarray(0, read).toString('utf8').split('\n');
  // A tail that starts mid-file starts mid-line.
  if (size > len) lines.shift();
  // Sessions log resolved paths (/private/tmp on macOS), so each base is tried as given and resolved.
  const given = [opts.worktree, opts.root].filter((b): b is string => typeof b === 'string' && b.length > 0);
  const bases = [...new Set(given.flatMap((b) => [b, realOrSelf(b)]))];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || o.type !== 'assistant') continue;
    const blocks: any[] = Array.isArray(o.message?.content) ? o.message.content : [];
    const at = typeof o.timestamp === 'string' ? o.timestamp : null;
    const tool = blocks.filter((b) => b?.type === 'tool_use' && typeof b.name === 'string').at(-1);
    if (tool) {
      const text = capText(collapse(`${tool.name} ${toolTarget(tool.input, bases)}`));
      if (text) return { kind: 'tool', text, at };
    }
    const prose = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).at(-1);
    if (prose) {
      const first = String(prose.text).split('\n').find((l) => l.trim()) ?? '';
      return { kind: 'text', text: capText(collapse(first)), at };
    }
  }
  return null;
}

const activityCache = new Map<string, TranscriptActivity | null>();

/** lastActivity for a located transcript, cached by file, size and mtime; null when it can't be opened. */
export function cachedActivity(hit: TranscriptHit, projects: string, opts: { worktree?: string | null; root?: string | null } = {}): TranscriptActivity | null {
  const t = openTranscript(hit, projects);
  if (!t) return null;
  try {
    const key = `${t.path}|${t.size}|${t.mtimeMs}|${opts.worktree ?? ''}|${opts.root ?? ''}`;
    if (activityCache.has(key)) return activityCache.get(key) ?? null;
    const a = lastActivity(t.fd, t.size, opts);
    activityCache.set(key, a);
    if (activityCache.size > CACHE_MAX) activityCache.delete(activityCache.keys().next().value!);
    return a;
  } finally {
    fs.closeSync(t.fd);
  }
}
