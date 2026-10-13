// `forge git diff|log|show|range-diff …`: read-only history for agents. These subcommands take
// `--output=<file>`, which writes anywhere git can, `.git/config` included (where a textconv or
// filter driver then runs on the next diff or add). A Bash prefix rule can't exclude one flag,
// so the daemon allows this wrapper instead of `Bash(git diff:*)` (docs/ARCHITECTURE.md "Daemon security").
import { spawnSync } from 'node:child_process';
import { ForgeError } from '../util.ts';

export const READ_SUBCOMMANDS: string[] = ['diff', 'log', 'show', 'range-diff'];

/** Options that write files or run config-defined programs. Git doesn't accept abbreviations of these. */
const REFUSED = /^--(output|ext-diff|textconv|open-files-in-pager)(=|$)/;

/**
 * The argv git runs: refused options rejected before `--`, and external diff and textconv
 * forced off (placed before `--`, after the caller's options, so they win).
 * `args` is `<subcommand> [options] [revisions] [-- paths]`.
 */
export function gitReadArgv(args: string[]): string[] {
  const [sub, ...rest] = args;
  if (!READ_SUBCOMMANDS.includes(sub)) throw new ForgeError(`forge git runs only ${READ_SUBCOMMANDS.join(', ')} (got ${JSON.stringify(sub ?? '')})`);
  const dashdash = rest.indexOf('--');
  const opts = dashdash < 0 ? rest : rest.slice(0, dashdash);
  const paths = dashdash < 0 ? [] : rest.slice(dashdash);
  const bad = opts.filter((a) => REFUSED.test(a));
  if (bad.length) throw new ForgeError(`forge git refuses ${bad.join(', ')}: it writes files or runs configured programs`);
  return ['--no-pager', sub, ...opts, '--no-ext-diff', '--no-textconv', ...paths];
}

/** Runs git in the current directory with stdout/stderr passed through. */
export function gitRead(args: string[]): number {
  const res = spawnSync('git', gitReadArgv(args), { stdio: 'inherit' });
  if (res.error) throw new ForgeError(`git failed to start: ${res.error.message}`);
  return res.status ?? 1;
}
