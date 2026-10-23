// The escalate floor: paths no unattended merge lands, whatever policy.protectedPaths says.
// Forge's own control files, the instruction files agents read, and the test, build and CI config
// that decides whether a check passes. A builder writes these on its branch, so only a human merges them.
import path from 'node:path';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { INSTRUCTION_ROLES, instructionsFor } from '#core/config/validators/instructions.ts';
import type { Config, Job } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { resolveBase } from '../pipeline/scope.ts';
import { commandSources, configEdit } from './integrity.ts';
import { diffEntries } from './protected.ts';
import type { DiffEntry } from './protected.ts';

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** What floorHits needs beside the diff: the instruction files, the scripts commands run, and how to read a blob at a commit. */
export interface FloorInputs {
  instructions: string[];
  sources: string[];
  read: (rev: string, p: string | null) => string | null;
  mergeBase: string;
  head: string;
}

/** A path as checkouts on case-insensitive file systems see it: `./` dropped, lower-cased. */
const fold = (p: string): string => path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '').toLowerCase();

/**
 * The paths in `entries` (a `--no-renames` diff, so a rename shows both sides) that only a human
 * merges: anything under `.forge/` in any case, an instruction file (case-folded), and every change
 * integrity's configEdit counts as a test, build or CI config edit. Sorted, each once.
 */
export function floorHits(entries: DiffEntry[], inputs: FloorInputs): string[] {
  const instructions = new Set(inputs.instructions.map(fold));
  const sources = new Set(inputs.sources);
  const out = new Set<string>();
  for (const e of entries) {
    const low = fold(e.path);
    const change = { status: e.status, from: e.status === 'A' ? null : e.path, to: e.status === 'D' ? null : e.path };
    if (low === '.forge' || low.startsWith('.forge/') || instructions.has(low) || configEdit(change, sources, inputs.read, inputs.mergeBase, inputs.head)) out.add(e.path);
  }
  return [...out].sort();
}

/**
 * floorHits over one repo's branch: the committed diff from merge-base(base, head) to `head`, a
 * commit id. A member repo has no instruction files and runs none of the root's commands. Throws
 * when git can't answer, so a caller counts that as a hit, never as a clean branch.
 */
export function branchFloor(cwd: string, config: Config, base: Pick<Job, 'base'>, head: string, opts: { member: boolean }): string[] {
  if (!FULL_SHA.test(head)) throw new ForgeError(`${JSON.stringify(String(head).slice(0, 80))} is not a commit id`);
  const env = historyEnv();
  const mergeBase = resolveBase(cwd, config, base, head).mergeBase;
  if (!FULL_SHA.test(mergeBase)) throw new ForgeError(`merge-base ${JSON.stringify(mergeBase.slice(0, 80))} is not a commit id`);
  const read = (rev: string, p: string | null): string | null => {
    if (!p) return null;
    const r = git(cwd, ['cat-file', 'blob', `${rev}:${p}`], { env, allowFail: true });
    return r.ok && !r.stdout.includes('\0') ? r.stdout : null;
  };
  const instructions = opts.member ? [] : [undefined, ...INSTRUCTION_ROLES].flatMap((r) => instructionsFor(config, r));
  const sources = opts.member ? [] : commandSources(config);
  return floorHits(diffEntries(cwd, mergeBase, head, env), { instructions, sources, read, mergeBase, head });
}
