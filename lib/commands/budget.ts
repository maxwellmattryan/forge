// `forge budget`: repo spend against the day and month caps (config `budget:`), and a human's
// acknowledgement that grants one more period. Per-job budgets are `forge job budget`.
import { currentActor } from '../integrations/github/actor.ts';
import { ackRepoBudget, checkRepoBudget } from '../engine/metrics/repo-budget.ts';
import type { Config, HelpGroup, RepoBudgetStatus } from '../core/types.ts';
import { ForgeError } from '../core/errors.ts';
import { str } from './args.ts';

const BUDGET: HelpGroup = {
  name: 'budget',
  summary: 'repo spend against the day and month caps (budget:), and acknowledging an exceeded period',
  commands: [
    {
      command: 'budget',
      args: '',
      summary: 'repo spend this UTC day and month against budget.usdPerDay, usdPerMonth and tokensPerMonth: caps, remaining, projected month-end and held jobs; frees repo-held jobs once nothing is exceeded',
      docs: ['Repo budget', 'docs/CONFIG.md#repo-budget'],
      readme: true,
    },
    {
      command: 'budget ack',
      args: '--period <YYYY-MM|YYYY-MM-DD> [--note N]',
      summary: "grant one more period's cap for the current, exceeded UTC month or day, then free the jobs it held; a human only",
      flags: [
        ['--period P', 'the current UTC month (month caps) or day (usdPerDay)'],
        ['--note N', 'why, kept in the audit log'],
      ],
      exits: [[1, 'a period that is not current, nothing exceeded in it, or a daemon session']],
    },
  ],
};

export const HELP: HelpGroup[] = [BUDGET];

// The cap is the human's control over unattended spend: a session misled by tracker or PR text must not lift it.
const DAEMON_REFUSAL = 'forge budget ack lifts the repo spend cap, which a daemon session may not do; a human runs it in their own session or acknowledges in the dashboard';

export function budgetCmd(root: string, config: Config, sub: string | undefined, flags: Record<string, any>): RepoBudgetStatus | { acked: string; status: RepoBudgetStatus } {
  if (sub === undefined) return checkRepoBudget(root, config);
  if (sub !== 'ack') throw new ForgeError(`unknown subcommand forge budget ${String(sub).slice(0, 40)}`, 'usage', 'forge help budget');
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(DAEMON_REFUSAL);
  if (flags.period === undefined || flags.period === true) throw new ForgeError('--period is required: the current UTC month (YYYY-MM) or day (YYYY-MM-DD)', 'usage', 'forge help budget');
  const note = str(flags.note, '--note') ?? null;
  return ackRepoBudget(root, config, String(flags.period), note, currentActor(root));
}
