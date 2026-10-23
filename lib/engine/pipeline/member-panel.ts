// Member review panels: the lenses a member repo of a job defines for itself. They come from the
// member's clone (`.forge/config.yml` review.panel, `.forge/reviewers/<name>.md`), never from the
// job's worktree of it, which the builder writes: a build must not choose or rewrite its own lenses.
import fs from 'node:fs';
import path from 'node:path';
import { panelPathsProblems, reviewerChecklist } from '#core/config/load.ts';
import { memberClone, within } from '../project/job-repos.ts';
import { LENS_NAME, QUALIFIED_LENS, lensRepoAllowed, splitLens } from '#core/job/lens.ts';
import { PLUGIN_ROOT, exists, resolveFrom } from '#core/paths.ts';
import { isMap, show } from '#core/shape.ts';
import type { Config, Job, PanelEntry } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import * as yaml from '#core/format/yaml.ts';

/** One usable entry of a member's panel. */
export interface MemberLens {
  /** `<repo>:<name>`, or the plain name when the entry is subsumed by the root lens of that name. */
  lens: string;
  subsumed: boolean;
  entry: PanelEntry;
  checklist: string | null;
}

// The same cap local.yml has: a config this big is a mistake, and reading it all would stall the panel.
const CONFIG_MAX_BYTES = 256 * 1024;


/** The text of `<clone>/.forge/config.yml`, or null when it is absent. Never blocks on a FIFO. */
function readMemberConfig(name: string, file: string): string | null {
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer forever.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new ForgeError(`repo ${name}: cannot read .forge/config.yml (${code ?? (e as Error).message})`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new ForgeError(`repo ${name}: .forge/config.yml is not a regular file`);
    if (st.size > CONFIG_MAX_BYTES) throw new ForgeError(`repo ${name}: .forge/config.yml is larger than ${CONFIG_MAX_BYTES} bytes`);
    const buf = Buffer.alloc(st.size);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, st.size, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** A regular file inside the clone after every symlink is resolved, else null. */
function confinedFile(clone: string, file: string): string | null {
  if (!within(clone, file)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * Member `name`'s panel, read from its clone. A config that can't be used throws `repo <name>: …`,
 * so the job never reviews with a lens silently missing; a bad entry is dropped with a problem.
 * An entry named like a root lens, with no checklist of its own, is subsumed by that root lens.
 */
export function readMemberPanel(root: string, config: Config, name: string): { entries: MemberLens[]; problems: string[] } {
  const clone = memberClone(root, config, name);
  const text = readMemberConfig(name, path.join(clone, '.forge', 'config.yml'));
  const none = { entries: [], problems: [] };
  if (text === null) return none;
  let doc: any;
  try {
    doc = yaml.parse(text);
  } catch (e) {
    throw new ForgeError(`repo ${name}: .forge/config.yml is not valid YAML: ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return none;
  if (!isMap(doc)) throw new ForgeError(`repo ${name}: .forge/config.yml must be a map`);
  if (doc.review === undefined || doc.review === null) return none;
  if (!isMap(doc.review)) throw new ForgeError(`repo ${name}: review in .forge/config.yml must be a map (got ${show(doc.review)})`);
  const panel = doc.review.panel;
  if (panel === undefined || panel === null) return none;
  if (!Array.isArray(panel)) throw new ForgeError(`repo ${name}: review.panel in .forge/config.yml must be a list (got ${show(panel)})`);

  const rootNames = config.review.panel.map((p) => p.name).filter((n) => LENS_NAME.test(n));
  const entries: MemberLens[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  panel.forEach((e: unknown, i: number) => {
    const at = `repo ${name}: review.panel`;
    if (!isMap(e) || typeof e.name !== 'string' || !LENS_NAME.test(e.name)) {
      problems.push(`${at}[${i}].name must be a lens name using a-z 0-9 - (got ${show(isMap(e) ? e.name : e)})`);
      return;
    }
    const lensName: string = e.name;
    if (seen.has(lensName)) return;
    if (e.paths !== undefined) {
      const bad = panelPathsProblems(lensName, e.paths);
      if (bad.length) return problems.push(...bad.map((p) => `repo ${name}: ${p}`));
    }
    if (e.checklist !== undefined && (typeof e.checklist !== 'string' || !e.checklist || e.checklist.includes('\0')))
      return problems.push(`${at} "${lensName}".checklist must be a path (got ${show(e.checklist)})`);
    const explicit: string | undefined = e.checklist;
    const local = path.join(clone, '.forge', 'reviewers', `${lensName}.md`);
    const entry: PanelEntry = {
      name: lensName,
      ...(e.always === true ? { always: true } : {}),
      ...(typeof e.when === 'string' ? { when: e.when } : {}),
      ...(Array.isArray(e.paths) ? { paths: e.paths as string[] } : {}),
    };
    const catalog = path.join(PLUGIN_ROOT, 'reviewers', `${lensName}.md`);
    if (rootNames.includes(lensName) && explicit === undefined && !exists(local)) {
      seen.add(lensName);
      entries.push({ lens: lensName, subsumed: true, entry, checklist: exists(catalog) ? catalog : null });
      return;
    }
    let checklist: string | null;
    if (explicit !== undefined) {
      checklist = confinedFile(clone, resolveFrom(clone, explicit));
      if (!checklist) return problems.push(`${at} "${lensName}".checklist ${show(explicit)} is not a file inside the clone`);
    } else if (exists(local)) {
      checklist = confinedFile(clone, local);
      if (!checklist) return problems.push(`${at} "${lensName}": .forge/reviewers/${lensName}.md is not a file inside the clone`);
    } else checklist = exists(catalog) ? catalog : null;
    if (!checklist) return problems.push(`${at} "${lensName}" has no checklist: add .forge/reviewers/${lensName}.md to the clone`);
    seen.add(lensName);
    entries.push({ lens: `${name}:${lensName}`, subsumed: false, entry, checklist });
  });
  return { entries, problems };
}

/**
 * Each lens's checklist for briefs and step: a plain name exactly as reviewerChecklist resolves it
 * today; a qualified one from its member's clone, and null when its repo is not a reviewed member of
 * the job or its panel can't be read. Each member panel is read once.
 */
export function lensChecklists(root: string, config: Config, job: Pick<Job, 'repos'>, names: string[]): Record<string, string | null> {
  const panels = new Map<string, MemberLens[] | null>();
  const memberLenses = (repo: string): MemberLens[] | null => {
    if (!panels.has(repo)) {
      try {
        panels.set(repo, readMemberPanel(root, config, repo).entries);
      } catch {
        panels.set(repo, null);
      }
    }
    return panels.get(repo)!;
  };
  return Object.fromEntries(
    names.map((n) => {
      if (!QUALIFIED_LENS.test(n)) return [n, reviewerChecklist(root, n, config.review.panel.find((p) => p.name === n)?.checklist)];
      const repo = splitLens(n)!.repo!;
      if (!lensRepoAllowed(job, n)) return [n, null];
      return [n, memberLenses(repo)?.find((m) => m.lens === n)?.checklist ?? null];
    }),
  );
}

/** One lens's checklist: lensChecklists for a single name. */
export function lensChecklist(root: string, config: Config, job: Pick<Job, 'repos'>, lens: string): string | null {
  return lensChecklists(root, config, job, [lens])[lens];
}
