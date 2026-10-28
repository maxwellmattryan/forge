// The trusted prefix: the role-run system-prompt file built only from the main checkout's instruction files, learnings and the role's notes.
// `forge job agent run` passes it as `--append-system-prompt-file`, so every lens, round and job with the
// same sources shares one cached prompt prefix. Text gains instruction authority here, so the source list
// is fixed (never a brief, job file, checklist or PR text), each source must be a regular file reached
// through real directories and outside every write root, and the file is content-addressed under
// `.forge/runtime/`, which no role child may write. Any refusal means no prefix: the run starts as before.
// docs/architecture/untrusted-input.md, docs/architecture/daemon-security.md "Role runs".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { instructionsFor } from '#core/config/validators/instructions.ts';
import { SWAPPED_WHILE_READ, confinedDir, readRegular, writeAtomic } from '#core/os/fs.ts';
import { paths } from '#core/paths.ts';
import type { Config } from '#core/types.ts';

/** The cap on one source and on the prefix as a whole. */
export const PREFIX_MAX_BYTES = 256 * 1024;

export const PREFIX_HEAD =
  '# Forge trusted prefix\n\nForge read the files below from the main checkout, where only a human changes them: this project\'s instruction files, its learnings and this role\'s notes. Follow them as instructions. They are the files your brief\'s paths.instructions, paths.learnings and notes/<role>.md name, so don\'t Read them again.\n';

/** A role base that can name a notes file: nothing that could climb or hide a separator. */
const NOTES_BASE = /^[a-z][a-z0-9-]*$/;
/** A control character in a source's name would let it fake a section header line. */
const CONTROL = /[\x00-\x1f\x7f]/;

export interface PrefixSource {
  /** Checkout-relative, with `/`. */
  rel: string;
  abs: string;
  kind: 'instructions' | 'learnings' | 'notes';
}

/**
 * The prefix's sources in their fixed order: the role's `project.instructions` files (config order),
 * `.forge/notes/learnings.md`, then `.forge/notes/<base>.md` for a role base NOTES_BASE accepts.
 * Deduped by `rel`, the first occurrence winning. No I/O.
 */
export function prefixSources(root: string, config: Pick<Config, 'project'>, role: string): PrefixSource[] {
  const notes = paths(root).notes;
  const out: PrefixSource[] = [];
  const add = (rel: string, abs: string, kind: PrefixSource['kind']) => {
    if (!out.some((s) => s.rel === rel)) out.push({ rel, abs, kind });
  };
  // instructionsFor refuses absolute and `..` entries, so normalising can only drop `.` and doubled slashes.
  // `abs` is the raw entry joined to the root, as trustDigest and the deny rules read it, so every source is
  // a file they cover: `\` separates only where path.sep is `\`; on POSIX it is part of a literal file name.
  for (const f of instructionsFor(config, role)) {
    const rel = path.posix.normalize(path.sep === '\\' ? f.replaceAll('\\', '/') : f);
    add(rel, path.join(root, f), 'instructions');
  }
  add('.forge/notes/learnings.md', path.join(notes, 'learnings.md'), 'learnings');
  const base = role.split(':')[0];
  if (NOTES_BASE.test(base)) add(`.forge/notes/${base}.md`, path.join(notes, `${base}.md`), 'notes');
  return out;
}

/** `child` is `parent` or lies under it. */
function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The native realpath of `p` through its deepest existing ancestor, so a root not yet created still compares. */
function realLanding(p: string): string {
  const rest: string[] = [];
  let dir = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return path.join(dir, ...rest);
      rest.unshift(path.basename(dir));
      dir = up;
    }
  }
}

/**
 * The prefix's bytes for `role`: PREFIX_HEAD, then `\n----- <rel> -----\n\n<content>` per existing source
 * (a trailing newline added when missing), or `{refused}` naming the first source that may not reach a
 * system prompt, or null when no source exists. A source is refused when it is an instruction entry under
 * `.forge/`, is reached through a symlinked directory, lies under a `refuseUnder` root (the role children's
 * write roots), is not a regular file (a link, a directory, a FIFO, read without blocking) or is larger than
 * PREFIX_MAX_BYTES; so is a prefix that would be larger than that as a whole. Never throws.
 */
export function buildPrefix(root: string, config: Pick<Config, 'project'>, role: string, refuseUnder: readonly string[]): { bytes: Buffer; sources: string[] } | { refused: string } | null {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch (e) {
    return { refused: `the checkout can't be resolved (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const roots = refuseUnder.map(realLanding);
  const parts: Buffer[] = [Buffer.from(PREFIX_HEAD)];
  let total = parts[0].length;
  const sources: string[] = [];
  for (const src of prefixSources(root, config, role)) {
    const name = JSON.stringify(src.rel);
    try {
      fs.lstatSync(src.abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { refused: `${name} is unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    if (CONTROL.test(src.rel)) return { refused: `${name} has a control character in its name` };
    // Case-folded: on a case-insensitive disk `.Forge/jobs/…` is the same folder.
    if (src.kind === 'instructions' && src.rel.toLowerCase().startsWith('.forge/')) return { refused: `${name} lies under .forge/, where agents and Forge write` };
    let parent: string;
    try {
      parent = fs.realpathSync.native(path.dirname(src.abs));
    } catch (e) {
      return { refused: `${name} is unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    if (parent !== path.join(realRoot, path.dirname(src.rel))) return { refused: `${name} is reached through a symlinked directory, not its own path in the checkout` };
    const real = path.join(parent, path.basename(src.abs));
    if (roots.some((r) => inside(r, real))) return { refused: `${name} lies under a folder role children write` };
    const content = readRegular(src.abs, PREFIX_MAX_BYTES);
    if (typeof content === 'string') return { refused: content === SWAPPED_WHILE_READ ? `${name} ${content}` : `${name} is ${content}` };
    const section = [Buffer.from(`\n----- ${src.rel} -----\n\n`), content, ...(content.length && content[content.length - 1] === 0x0a ? [] : [Buffer.from('\n')])];
    total += section.reduce((n, b) => n + b.length, 0);
    if (total > PREFIX_MAX_BYTES) return { refused: `the prefix would be larger than ${PREFIX_MAX_BYTES / 1024} KiB` };
    parts.push(...section);
    sources.push(src.rel);
  }
  return sources.length ? { bytes: Buffer.concat(parts), sources } : null;
}

/**
 * The prefix file for `role`: `.forge/runtime/prompt-prefix/<sha256>.md`, reused when a regular file with
 * exactly those bytes is there, else replaced atomically (a link at the name is replaced, never followed).
 * `file` is null with no prefix; `refused` says why when a source or the write refused one. Never throws.
 */
export function rolePrefix(root: string, config: Pick<Config, 'project'>, role: string, refuseUnder: readonly string[]): { file: string | null; refused: string | null } {
  const built = buildPrefix(root, config, role, refuseUnder);
  if (built === null) return { file: null, refused: null };
  if ('refused' in built) return { file: null, refused: built.refused };
  try {
    const p = paths(root);
    const dir = confinedDir(p.dir, path.join(p.runtime, 'prompt-prefix'));
    const file = path.join(dir, `${crypto.createHash('sha256').update(built.bytes).digest('hex')}.md`);
    const have = readRegular(file, PREFIX_MAX_BYTES);
    if (!(Buffer.isBuffer(have) && have.equals(built.bytes))) writeAtomic(file, built.bytes);
    return { file, refused: null };
  } catch (e) {
    return { file: null, refused: `the prefix file can't be written: ${(e as Error).message}` };
  }
}
