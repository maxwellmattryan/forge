// `forge budget`: repo spend against the day and month caps (config `budget:`), and a human's
// acknowledgement that grants one more period. Per-job budgets are `forge job budget`.
import { ackRepoBudget, checkRepoBudget, validPeriod } from '#engine/metrics/repo-budget.ts';
import type { Config, RepoBudgetStatus } from '#core/types.ts';
import type { HelpGroup } from '../types.ts';
import { ForgeError } from '#core/errors.ts';
import { str } from './args.ts';
import { budgetAckOp, confirmHuman } from './human.ts';

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
      summary: "grant one more period's cap for the current, exceeded UTC month or day, then free the jobs it held; a human-only operation: it asks the person at the terminal to type the period",
      flags: [
        ['--period P', 'the current UTC month (month caps) or day (usdPerDay)'],
        ['--note N', 'why, kept in the audit log'],
      ],
      exits: [[1, 'a period that is not current, nothing exceeded in it, not confirmed, or human_only: a daemon session, or no person at a terminal (an agent, a script or a configured command)']],
    },
  ],
};

export const HELP: HelpGroup[] = [BUDGET];

export async function budgetCmd(root: string, config: Config, sub: string | undefined, flags: Record<string, any>): Promise<RepoBudgetStatus | { acked: string; status: RepoBudgetStatus }> {
  if (sub === undefined) return checkRepoBudget(root, config);
  if (sub !== 'ack') throw new ForgeError(`unknown subcommand forge budget ${String(sub).slice(0, 40)}`, 'usage', 'forge help budget');
  if (flags.period === undefined || flags.period === true) throw new ForgeError('--period is required: the current UTC month (YYYY-MM) or day (YYYY-MM-DD)', 'usage', 'forge help budget');
  const period = String(flags.period);
  const note = str(flags.note, '--note') ?? null;
  // The cap is the human's control over unattended spend: a session misled by tracker or PR text,
  // or branch code it runs, must not lift it, so a person types the period back at this terminal.
  // Checked first, so the prompt only ever shows a well-formed period.
  if (!validPeriod(period)) throw new ForgeError(`--period must be YYYY-MM or YYYY-MM-DD (got ${JSON.stringify(period).slice(0, 40)})`, 'usage', 'forge help budget');
  const grant = await confirmHuman(root, budgetAckOp(period));
  return ackRepoBudget(root, config, period, note, grant.actor);
}
