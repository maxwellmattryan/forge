// Which prompts, plugin and repo layer a run used. The same hashes stamp eval runs (pluginHash,
// configHash), the roster (promptHash) and every agent-start event, so a change in behaviour can be
// traced to a change in instructions without anyone recording it by hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { reviewerChecklist } from '#core/config/load.ts';
import { LENS_NAME, ROLE_NAME } from '#core/job/lens.ts';
import { paths, exists, PLUGIN_ROOT } from '#core/paths.ts';
import type { Config } from '#core/types.ts';
import { readText } from '#core/os/fs.ts';

/** The plugin files that shape what agents do and how the pipeline drives them. */
const PLUGIN_DIRS: { dir: string; recursive: boolean; md: boolean }[] = [
  { dir: 'agents', recursive: false, md: true },
  { dir: 'reviewers', recursive: false, md: true },
  { dir: 'skills/forge', recursive: true, md: false },
  { dir: 'lib/engine/pipeline/step', recursive: true, md: false },
];
const PLUGIN_FILES = ['lib/engine/pipeline/step.ts', 'lib/engine/pipeline/brief.ts'];

/**
 * A regular file's bytes when it is at most `max` bytes, `over` past it, else null: a link or FIFO
 * swapped in since the listing is not read.
 */
function cappedFile(file: string, max: number): Buffer | 'over' | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    return st.size > max ? 'over' : fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

let installedHash: string | null = null;

/**
 * pluginHash's caps. It runs on a job's worktree at decide, and a branch can commit any tree: the
 * walk stops after this many directory entries or bytes read, and the hash says it stopped.
 */
const PLUGIN_WALK_LIMITS = { entries: 5000, bytes: 32 * 1024 * 1024 };

/**
 * A content hash of the plugin's prompts, checklists, skill, step and brief, so two dev builds
 * with the same version string tell apart. Regular files only (a symlinked file is skipped). A
 * listed directory or file reached through a symlink (itself or a directory above it) is never
 * followed: it hashes as a link marker with its target, so a branch can't point the walk outside
 * the checkout, and replacing a directory with a link still changes the hash. The plugin's own
 * path is never part of it, since run records can be committed and it would leak a home directory.
 * The running plugin's hash is computed once per process: every agent start stamps it.
 */
export function pluginHash(pluginRoot: string = PLUGIN_ROOT, limits: { entries: number; bytes: number } = PLUGIN_WALK_LIMITS): string {
  const own = path.resolve(pluginRoot) === path.resolve(PLUGIN_ROOT) && limits === PLUGIN_WALK_LIMITS;
  if (own && installedHash) return installedHash;
  const rels: string[] = [];
  const links = new Map<string, string>();
  let visited = 0;
  let truncated = false;
  /** Whether `rel` is reached without a symlink, recording the first link on the way when not. */
  const real = (rel: string): boolean => {
    const segs = rel.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const sub = segs.slice(0, i).join('/');
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(pluginRoot, sub));
      } catch {
        return false;
      }
      if (st.isSymbolicLink()) {
        let target = '';
        try {
          target = fs.readlinkSync(path.join(pluginRoot, sub));
        } catch {}
        links.set(sub, target);
        return false;
      }
    }
    return true;
  };
  const list = (rel: string, recursive: boolean, md: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(pluginRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (++visited > limits.entries) {
        truncated = true;
        return;
      }
      const r = `${rel}/${e.name}`;
      // A Dirent is lstat's view: a linked entry is neither a file nor a directory here.
      if (e.isFile() && (!md || e.name.endsWith('.md'))) rels.push(r);
      else if (e.isDirectory() && recursive) list(r, recursive, md);
    }
  };
  for (const d of PLUGIN_DIRS) if (real(d.dir)) list(d.dir, d.recursive, d.md);
  for (const f of PLUGIN_FILES) {
    try {
      if (real(f) && fs.lstatSync(path.join(pluginRoot, f)).isFile()) rels.push(f);
    } catch {}
  }
  const h = crypto.createHash('sha256');
  // Framed like trustDigest, so no two file sets hash alike by moving bytes between names. A link's
  // frame has a word where a file's has its length, and a path holds no NUL, so neither reads as the other.
  const items = [...rels.map((rel) => ({ rel, link: null as string | null })), ...[...links].map(([rel, link]) => ({ rel, link }))];
  let budget = limits.bytes;
  for (const { rel, link } of items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    if (link !== null) {
      h.update(`${rel}\0link\0${link}\0`);
      continue;
    }
    const data = cappedFile(path.join(pluginRoot, rel), budget);
    if (data === 'over') {
      truncated = true;
      break;
    }
    if (data === null) continue;
    budget -= data.byteLength;
    h.update(`${rel}\0${data.byteLength}\0`).update(data);
  }
  if (truncated) h.update('\0truncated\0');
  const digest = h.digest('hex').slice(0, 10);
  if (own) installedHash = digest;
  return digest;
}

/**
 * Captures everything repo-side that shapes Forge behaviour, so a retro or config change
 * shows up as a different hash between two eval runs.
 */
export function configHash(root: string, config: Config): string {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(config));
  const p = paths(root);
  for (const dir of [p.reviewers, p.notes, p.verifiers]) {
    if (!exists(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) h.update(f).update(readText(path.join(dir, f)));
  }
  return h.digest('hex').slice(0, 10);
}

/** The roster's 12-hex hash: parts joined by NUL. */
const shortHash = (...parts: string[]): string => crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12);

/** A prompt file's frontmatter and the body after it. */
export function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * The main checkout's `.forge/verifiers/*.md`, sorted by name and framed by name and length: they
 * are the verifier agent's real instructions, so editing one changes its prompt hash.
 */
export function verifierDigest(root: string): string {
  const dir = paths(root).verifiers;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {}
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const n of names) {
    let body = '';
    try {
      // lstat: a symlinked verifier never runs, so only its name counts.
      if (fs.lstatSync(path.join(dir, n)).isFile()) body = fs.readFileSync(path.join(dir, n), 'utf8');
    } catch {}
    h.update(`${n}\0${Buffer.byteLength(body)}\0`).update(body);
  }
  return h.digest('hex');
}

/** The plugin's roles: one per `agents/*.md`. */
export function agentRoles(): string[] {
  try {
    return fs
      .readdirSync(path.join(PLUGIN_ROOT, 'agents'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .filter((r) => ROLE_NAME.test(r))
      .sort();
  } catch {
    return [];
  }
}

/** A plain role's prompt hash: its body, the repo's addendum and learnings (and, for the verifier, the verifiers). */
function agentHash(root: string, role: string): string | null {
  if (!ROLE_NAME.test(role)) return null;
  const file = path.join(PLUGIN_ROOT, 'agents', `${role}.md`);
  if (!exists(file)) return null;
  const { body } = frontmatter(readText(file));
  const notes = paths(root).notes;
  const addendum = readText(path.join(notes, `${role}.md`));
  const learnings = readText(path.join(notes, 'learnings.md'));
  return role === 'verifier' ? shortHash(body, addendum, learnings, verifierDigest(root)) : shortHash(body, addendum, learnings);
}

/** A lens's checklist file as the panel resolves it, and its hash; both null without one. */
export function lensChecklist(root: string, config: Config, lens: string): { file: string | null; hash: string | null } {
  const entry = (config.review?.panel ?? []).find((r) => r?.name === lens);
  const file = reviewerChecklist(root, lens, entry?.checklist);
  return { file, hash: file ? shortHash(readText(file)) : null };
}

/**
 * The hash `forge roster` reports for a role. `reviewer:<lens>` combines the reviewer prompt with
 * the lens's checklist, so a checklist edit is a new cohort; a role with no agent file is null.
 */
export function promptHash(root: string, config: Config, role: string): string | null {
  const m = /^reviewer:(.+)$/.exec(role);
  if (!m) return agentHash(root, role);
  const reviewer = agentHash(root, 'reviewer');
  if (reviewer === null) return null;
  // Only a plain lens name reaches a checklist path; anything else hashes as having none.
  return shortHash(reviewer, (LENS_NAME.test(m[1]) ? lensChecklist(root, config, m[1]).hash : null) ?? '');
}
