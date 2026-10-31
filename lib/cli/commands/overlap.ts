// `forge overlap`: which jobs, open PRs and people's recent pushes touch the same code as a job or a PR,
// and when to merge it, from a fixed rule (lib/engine/project/overlap.ts, docs/architecture/overlap.md).
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';
import { overlap } from '#engine/project/overlap.ts';
import type { OverlapSubject, OverlapSummary } from '#engine/project/overlap.ts';
import type { GitHub } from '#integrations/github/types.ts';
import type { HelpGroup } from '../types.ts';
import { requireJob } from './args.ts';

const OVERLAP: HelpGroup = {
  name: 'overlap',
  summary: 'which jobs, PRs and pushes touch the same code, and when to merge',
  commands: [
    {
      command: 'overlap',
      args: "<id> | '#<n>' | --pr <n>",
      summary:
        "check a job, or an open PR, against every other job in flight, every other open PR into its base and people's commits in the last overlap.recentHours hours: the counterparts that share files and line spans with it, whether nothing else is in flight (idle), and one timing (merge-now, wait-for, merge-first or needs-human) from a fixed rule; read-only apart from its report under .forge/runtime/overlap/, which `report` names",
      flags: [['--pr N', "the open PR to check, as '#N' does"]],
      exits: [
        [1, 'no such job, a job with no diff and no file map yet, or a PR that is not open (not_found)'],
        [2, 'a PR number that is not a positive integer, both a job and a PR, or no subject'],
        [5, 'a PR subject when gh is missing or GitHub could not be read'],
      ],
      docs: ['Overlap check', 'docs/architecture/overlap.md'],
      common: true,
    },
  ],
};

export const HELP: HelpGroup[] = [OVERLAP];

const PR_NUMBER = /^[1-9][0-9]{0,9}$/;

const usage = (message: string): ForgeError => new ForgeError(message, 'usage', 'forge help overlap');

/** The subject `pos` and `--pr` name: a job id, `#<n>` or `--pr <n>`, exactly one. */
export function overlapSubject(root: string, pos: readonly string[], flags: Record<string, unknown>): OverlapSubject {
  if (pos.length > 1) throw usage('forge overlap takes one subject: a job id, #<n> or --pr <n>');
  const [arg] = pos;
  const pr = flags.pr;
  const number = (v: unknown, what: string): number => {
    if (typeof v !== 'string' || !PR_NUMBER.test(v)) throw usage(`${what} must be a PR number (got ${JSON.stringify(v).slice(0, 40)})`);
    return Number(v);
  };
  if (pr !== undefined) {
    if (arg !== undefined) throw usage('give a job or a PR, not both');
    return { pr: number(pr, '--pr') };
  }
  if (arg === undefined) throw usage('name a job id, #<n> or --pr <n>');
  if (arg.startsWith('#')) return { pr: number(arg.slice(1), 'the PR') };
  return { job: requireJob(root, arg).id };
}

export function overlapCmd(root: string, config: Config, pos: readonly string[], flags: Record<string, unknown>, github: GitHub): OverlapSummary {
  return overlap(root, config, github, overlapSubject(root, pos, flags)).summary;
}
