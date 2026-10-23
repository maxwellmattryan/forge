// `forge experiment evaluate|check`: settling the experiment ledger and validating the notes layer
// (lib/engine/evals/experiments.ts, docs/IMPROVEMENT.md). The retro job runs evaluate on its worktree and commits
// what it writes; verify's `notes` step runs check on every branch that touches a notes file.
import { checkNotes, evaluateExperiments } from '#engine/evals/experiments.ts';
import { requireJob, usageError } from './args.ts';
import type { CliContext, Dispatched, HelpGroup } from '#core/types.ts';

const EXPERIMENT: HelpGroup = {
  name: 'experiment',
  summary: 'settle the experiment ledger and check the notes layer',
  commands: [
    {
      command: 'experiment evaluate',
      args: '[<job>] [--dry-run]',
      summary:
        "settle each open .forge/notes/experiments.md entry: its metric over the done or cancelled jobs created after it, against its baseline; writes kept, reverted or inconclusive (the only writer of a ledger status), in the job worktree's ledger with <job>, else the repo's",
      flags: [['--dry-run', 'compute every verdict and write nothing']],
      exits: [[1, 'no such job, the job has no worktree, or the ledger is a link or unreadable']],
      docs: ['Settling experiments', 'docs/IMPROVEMENT.md#settling-experiments'],
      readme: true,
    },
    {
      command: 'experiment check',
      args: '[<job>]',
      summary:
        "check the notes layer: new learnings and addenda carry experiment: and review-by:, new ledger entries are open with a stats-path metric, and only evaluate settles one; with <job>, what its branch adds or edits against the merge base, else a full audit of the repo's files",
      exits: [[1, 'a problem was found, no such job, or the job has no worktree']],
      docs: ['Settling experiments', 'docs/IMPROVEMENT.md#settling-experiments'],
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [EXPERIMENT];

export function experimentCmd(ctx: CliContext, sub: string | undefined, rest: string[], flags: Record<string, unknown>): Dispatched {
  const { root, config } = ctx;
  if (rest.length > 1) throw usageError(EXPERIMENT, sub);
  const job = rest.length ? requireJob(root, rest[0]) : null;
  if (sub === 'evaluate') return { data: evaluateExperiments(root, config, { job, dryRun: flags['dry-run'] === true }), exitCode: 0 };
  if (sub === 'check') {
    const r = checkNotes(root, config, job);
    return { data: r, exitCode: r.ok ? 0 : 1 };
  }
  throw usageError(EXPERIMENT);
}
