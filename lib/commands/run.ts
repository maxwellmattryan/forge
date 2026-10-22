// `forge run <job> <command> [--repo R] [--tail N] [-- <args…>]` and `forge run <job> <command> --background`.
import type { Config, Dispatched } from '../core/types.ts';
import { ForgeError } from '../core/errors.ts';
import * as wt from '../worktree.ts';
import { num, parseArgs, req } from './args.ts';

const AFTER_DASHES = 'forge run takes extra arguments only after --: forge run <job> <command> -- <args…>';

/**
 * Everything after the first `--` goes to the command as its own quoted words (flags included),
 * and nothing before it does. Every refusal comes before the command runs, so it leaves no log.
 */
export async function runCmd(root: string, config: Config, argv: string[]): Promise<Dispatched> {
  const dashes = argv.indexOf('--');
  const args = dashes < 0 ? [] : argv.slice(dashes + 1);
  const before = dashes < 0 ? argv : argv.slice(0, dashes);
  const { pos, flags } = parseArgs(before);
  const id = req(pos[1], 'job id');
  const name = req(pos[2], 'command name');
  if (before.some((a) => a.startsWith('--background='))) throw new ForgeError('forge run: --background takes no value');
  // A word after --background is parsed as its value, so it is an extra argument too.
  if (pos.length > 3 || (flags.background !== undefined && flags.background !== true)) throw new ForgeError(AFTER_DASHES);
  const tail = num(flags.tail, '--tail', { integer: true }) ?? 40;
  const repo = flags.repo === undefined ? undefined : req(typeof flags.repo === 'string' ? flags.repo : undefined, '--repo');
  // Member worktrees get no port, so a server there would collide with the root's.
  if (repo !== undefined && flags.background) throw new ForgeError('forge run --repo takes no --background: member repos run no background commands');
  if (flags.background) {
    // A reused server could not take them anyway: it is already running with its own.
    if (args.length) throw new ForgeError('forge run --background takes no extra arguments');
    return { data: await wt.startBackground(root, config, id, name), exitCode: 0 };
  }
  const r = wt.runCommand(root, config, id, name, { tail, args, ...(repo !== undefined ? { repo } : {}) });
  return { data: r, exitCode: r.ok ? 0 : 1 };
}
