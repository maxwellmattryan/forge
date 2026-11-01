// `forge run <job> <command> [--repo R] [--tail N] [-- <args…>]`, `forge run <job> <command> --background`
// and `forge run <job> <command> --changed` (the related tests of the job's changes at {args}).
import type { Config } from '#core/types.ts';
import type { Dispatched } from '../types.ts';
import { ForgeError } from '#core/errors.ts';
import { startBackground } from '#engine/workspace/dev-server.ts';
import { runCommand } from '#engine/workspace/run.ts';
import { runChanged } from '#engine/workspace/related-tests.ts';
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
  for (const flag of ['background', 'changed']) if (before.some((a) => a.startsWith(`--${flag}=`))) throw new ForgeError(`forge run: --${flag} takes no value`);
  // A word after --background or --changed is parsed as its value, so it is an extra argument too.
  if (pos.length > 3 || [flags.background, flags.changed].some((v) => v !== undefined && v !== true)) throw new ForgeError(AFTER_DASHES);
  const tail = num(flags.tail, '--tail', { integer: true }) ?? 40;
  const repo = flags.repo === undefined ? undefined : req(typeof flags.repo === 'string' ? flags.repo : undefined, '--repo');
  if (flags.changed) {
    // The CLI picks the arguments, so none may come from the call, and a member has its own base.
    if (args.length) throw new ForgeError('forge run --changed takes no -- <args…>: it passes the related tests itself');
    if (flags.background) throw new ForgeError('forge run --changed takes no --background: it runs the tests and returns');
    if (repo !== undefined) throw new ForgeError('forge run --changed takes no --repo: it runs only in the root worktree');
    const r = runChanged(root, config, id, name, { tail, checks: 'record' });
    return { data: r, exitCode: r.ok ? 0 : 1 };
  }
  // Member worktrees get no port, so a server there would collide with the root's.
  if (repo !== undefined && flags.background) throw new ForgeError('forge run --repo takes no --background: member repos run no background commands');
  if (flags.background) {
    // A reused server could not take them anyway: it is already running with its own.
    if (args.length) throw new ForgeError('forge run --background takes no extra arguments');
    return { data: await startBackground(root, config, id, name), exitCode: 0 };
  }
  // A pass on a clean committed tree goes in the check cache, which verify reuses (lib/engine/verify/cache.ts).
  const r = runCommand(root, config, id, name, { tail, args, checks: 'record', ...(repo !== undefined ? { repo } : {}) });
  return { data: r, exitCode: r.ok ? 0 : 1 };
}
