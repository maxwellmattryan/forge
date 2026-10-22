// Which prompts, plugin and repo layer a run used. The same hashes stamp eval runs (pluginHash,
// configHash), the roster (promptHash) and every agent-start event, so a change in behaviour can be
// traced to a change in instructions without anyone recording it by hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { reviewerChecklist } from './config.ts';
import { LENS_NAME } from './lens.ts';
import { paths, exists, PLUGIN_ROOT } from './paths.ts';
import type { Config } from './types.ts';
import { readText } from './util.ts';

/** The plugin files that shape what agents do and how the pipeline drives them. */
const PLUGIN_DIRS: { dir: string; recursive: boolean; md: boolean }[] = [
  { dir: 'agents', recursive: false, md: true },
  { dir: 'reviewers', recursive: false, md: true },
  { dir: 'skills/forge', recursive: true, md: false },
  { dir: 'lib/step', recursive: true, md: false },
];
const PLUGIN_FILES = ['lib/step.ts', 'lib/brief.ts'];

/** A regular file's bytes, or null: a link or FIFO swapped in since the listing is not read. */
export function regularFile(file: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

let installedHash: string | null = null;

/**
 * A content hash of the plugin's prompts, checklists, skill, step and brief, so two dev builds
 * with the same version string tell apart. Regular files only (no symlinks); the plugin's own path
 * is never part of it, since run records can be committed and it would leak a home directory.
 * The running plugin's hash is computed once per process: every agent start stamps it.
 */
export function pluginHash(pluginRoot: string = PLUGIN_ROOT): string {
  const own = path.resolve(pluginRoot) === path.resolve(PLUGIN_ROOT);
  if (own && installedHash) return installedHash;
  const rels: string[] = [];
  const list = (rel: string, recursive: boolean, md: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(pluginRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isFile() && (!md || e.name.endsWith('.md'))) rels.push(r);
      else if (e.isDirectory() && recursive) list(r, recursive, md);
    }
  };
  for (const d of PLUGIN_DIRS) list(d.dir, d.recursive, d.md);
  for (const f of PLUGIN_FILES) {
    try {
      if (fs.lstatSync(path.join(pluginRoot, f)).isFile()) rels.push(f);
    } catch {}
  }
  const h = crypto.createHash('sha256');
  // Framed like trustDigest, so no two file sets hash alike by moving bytes between names.
  for (const rel of rels.sort()) {
    const data = regularFile(path.join(pluginRoot, rel));
    if (data === null) continue;
    h.update(`${rel}\0${data.byteLength}\0`).update(data);
  }
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
export const shortHash = (...parts: string[]): string => crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12);

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

const ROLE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

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
