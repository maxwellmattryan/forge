// What a daemon session may write: its write roots (the job folders and every worktrees root), the
// deny rules for the checkout's protected paths, and the env that tells hooks/write-guard.ts the same
// roots. lifecycle.ts builds every spawn from spawnConfinement. docs/architecture/daemon-security.md
// describes the layers.
import fs from 'node:fs';
import path from 'node:path';
import { allInstructionFiles, worktreeRoot } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { landing } from '#core/paths.ts';
import { memberWorktreesRoot } from '#engine/project/job-repos.ts';
import { DENY_TOOLS, absRule } from '#integrations/claude/argv.ts';
import { git } from '#integrations/git/runner.ts';
import type { Config } from '#core/types.ts';

/** Carries a session's write roots, as JSON `{jobs, worktrees}`, to hooks/write-guard.ts. The FORGE_DAEMON prefix keeps it out of configured commands. */
export const WRITE_ROOTS_ENV = 'FORGE_DAEMON_WRITE_ROOTS';

/** Where a daemon session may write without a prompt: realpaths, through the deepest existing ancestor. */
export interface WriteRoots {
  jobs: string;
  worktrees: string[];
}

/** `child` is `parent` or lies under it. */
function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * `<real root>/.forge/jobs` and the worktrees roots of the root and of each member repo whose clone
 * is set up on this machine (one that isn't is left out: its writes prompt, and the guard refuses
 * them). Throws when a worktrees root is the checkout or contains it, since the guard would then
 * allow every write in it, or when a root can't be written as a permission rule.
 */
export function writeRoots(root: string, config: Config): WriteRoots {
  const real = fs.realpathSync(root);
  const jobs = landing(path.join(real, '.forge', 'jobs'));
  const found = [worktreeRoot(root, config)];
  for (const r of Array.isArray(config.repos) ? config.repos : []) {
    try {
      found.push(memberWorktreesRoot(root, config, r.name));
    } catch {
      // Not set up in .forge/local.yml on this machine.
    }
  }
  const worktrees = [...new Set(found.map(landing))];
  for (const w of worktrees)
    if (inside(w, real))
      throw new ForgeError(`the worktrees root ${w} is the checkout ${real} or contains it, so a daemon session could write anywhere in it; set worktrees.root outside the checkout (docs/CONFIG.md)`);
  for (const w of [jobs, ...worktrees]) absRule(w);
  return { jobs, worktrees };
}

/** The checkout-relative path (with `/`) of a `core.hooksPath` directory inside the checkout, else null. */
export function hooksDir(root: string): string | null {
  const r = git(root, ['config', '--type=path', '--get', 'core.hooksPath'], { allowFail: true });
  const value = r.ok ? r.stdout.trim() : '';
  if (!value) return null;
  const real = fs.realpathSync(root);
  const dir = landing(path.resolve(real, value));
  const rel = path.relative(real, dir);
  return rel && inside(real, dir) ? rel.split(path.sep).join('/') : null;
}

/**
 * The deny rules a spawn adds after DENY_TOOLS: each DENY_TOOLS entry's absolute twin, the root's
 * CLAUDE.md, CLAUDE.local.md and AGENTS.md, every configured instruction file, `**\/CLAUDE.md` and
 * `**\/CLAUDE.local.md` when no worktrees root lies inside the checkout (a nested one would deny the
 * job's own), and an in-checkout `core.hooksPath` directory. Absolute rules are written for the
 * checkout's realpath and again for the path as given when the two differ. Root-level names with no
 * `/` appear only in absolute form, since a relative one would match at any depth.
 */
export function denyRules(root: string, config: Config, roots: WriteRoots = writeRoots(root, config)): string[] {
  const real = fs.realpathSync(root);
  const bases = [...new Set([real, path.resolve(root)])];
  const out: string[] = [];
  const both = (rel: string) => {
    out.push(`Edit(${rel})`);
    for (const b of bases) out.push(`Edit(${absRule(b)}/${rel})`);
  };
  for (const b of bases) for (const t of DENY_TOOLS) out.push(`Edit(${absRule(b)}/${t.slice('Edit('.length, -1)})`);
  for (const f of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']) for (const b of bases) out.push(`Edit(${absRule(path.join(b, f))})`);
  for (const f of allInstructionFiles(config)) {
    // absRule refuses a name a rule can't carry, for the relative form too.
    const abs = bases.map((b) => `Edit(${absRule(path.join(b, f))})`);
    if (f.includes('/')) out.push(`Edit(${f})`);
    out.push(...abs);
  }
  if (!roots.worktrees.some((w) => inside(real, w))) for (const f of ['CLAUDE.md', 'CLAUDE.local.md']) both(`**/${f}`);
  const hooks = hooksDir(root);
  if (hooks !== null) {
    absRule(path.join(real, hooks));
    both(`${hooks}/**`);
  }
  return [...new Set(out)];
}

/** Everything a spawn needs to confine its session: the write roots, the extra deny rules and the guard's env. */
export function spawnConfinement(root: string, config: Config): { roots: WriteRoots; deny: string[]; env: Record<string, string> } {
  const roots = writeRoots(root, config);
  return { roots, deny: denyRules(root, config, roots), env: { [WRITE_ROOTS_ENV]: JSON.stringify(roots) } };
}
