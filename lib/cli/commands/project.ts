// `forge project add|remove|list`: the machine index of registered projects
// (lib/engine/project/machine-index.ts). Routed before mainRoot(), so `list`, `remove` and
// `add <path>` work outside any repo.
import { forgeHome } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { PROJECT_NAME, addProject, listProjects, removeProject, resolveProjectRoot } from '#engine/project/machine-index.ts';
import { out, usageError } from './args.ts';
import type { HelpGroup } from '../types.ts';

const PROJECT: HelpGroup = {
  name: 'project',
  summary: "the projects registered on this machine (the machine index in ~/.forge or FORGE_HOME)",
  commands: [
    {
      command: 'project add',
      args: '[<path>] [--name N]',
      summary:
        "register a project in the machine index: this repo's main checkout (FORGE_ROOT, else the cwd's), or the main checkout of the repo at <path> (FORGE_ROOT ignored), stored as its realpath with a name from the directory ({added, project: {name, path, addedAt}}). The same path again is a no-op (added: false). It reads nothing from the project's config and writes nothing inside it",
      flags: [['--name N', "the project's name instead of the directory's (^[a-z0-9][a-z0-9._-]{0,63}$)"]],
      exits: [[1, 'the name is registered for another path, a daemon session ran it, or the index file is unreadable or from a newer Forge (never rewritten)']],
    },
    {
      command: 'project remove',
      args: '<name|path>',
      summary:
        "drop one project from the machine index ({removed}), by name or by path (absolute, or containing /, or starting with . or ~); a path that no longer exists still matches. It never touches the project's directory",
      exits: [[1, 'no such registered project (not_found), a daemon session ran it, or the index file is unreadable or from a newer Forge']],
    },
    {
      command: 'project list',
      args: '',
      summary: 'the registered projects, sorted by name ({home, projects: [{name, path, addedAt, status}]}), status ok, missing or not-initialized; it never writes, so a missing project stays until remove drops it',
      exits: [[1, 'the index file is unreadable or from a newer Forge']],
    },
  ],
};

export const HELP: HelpGroup[] = [PROJECT];

// Registering is a human's trust decision: a later machine-wide server runs a pool for each project.
const PROJECT_DAEMON_REFUSAL =
  'forge project add|remove changes which projects this machine serves, which a daemon session may not do; a human runs it in their own terminal';

const usage = (sub?: string) => usageError(PROJECT, sub);

/** `forge project <sub> …`: prints its result. `words` are the positionals after `project`. */
export function projectCmd(words: string[], flags: Record<string, any>): void {
  const [sub, ...args] = words;
  if (sub !== 'add' && sub !== 'remove' && sub !== 'list') throw usage();
  if (sub !== 'list' && process.env.FORGE_DAEMON === '1') throw new ForgeError(PROJECT_DAEMON_REFUSAL);
  if (sub === 'list') {
    if (args.length) throw usage(sub);
    return out(listProjects(forgeHome()), flags);
  }
  if (sub === 'add') {
    if (args.length > 1 || flags.name === true || (flags.name !== undefined && typeof flags.name !== 'string')) throw usage(sub);
    if (flags.name !== undefined && !PROJECT_NAME.test(flags.name)) throw new ForgeError(`--name ${JSON.stringify(flags.name).slice(0, 80)} must match ${PROJECT_NAME}`, 'usage', 'forge help project add');
    const root = resolveProjectRoot(args[0]);
    return out(addProject(forgeHome(), root, { name: flags.name }), flags);
  }
  if (args.length !== 1 || !args[0]) throw usage(sub);
  out(removeProject(forgeHome(), args[0]), flags);
}
