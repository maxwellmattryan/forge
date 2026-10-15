import * as evals from '../evals.ts';
import { ForgeError } from '../util.ts';
import { bodyFrom, list, req, usageError } from './args.ts';
import type { Config, HelpGroup } from '../types.ts';

const EVAL: HelpGroup = {
  name: 'eval',
  summary: 'measure Forge on frozen tasks: the task suite, runs and comparisons',
  commands: [
    { command: 'eval list', args: '', summary: 'the eval tasks' },
    {
      command: 'eval new',
      args: '<name> [--title T] (--request R | --body B | --body-file F)',
      summary: 'add a task from a request',
      flags: [
        ['--title T', 'the title (default: the name)'],
        ['--request R', 'the request text'],
        ['--body B', 'the request text'],
        ['--body-file F', 'read the request from F (- for stdin)'],
      ],
      exits: [[1, 'a task with that name already exists']],
    },
    {
      command: 'eval mine',
      args: '--pr N [--name N] [--test-pattern P]',
      summary: 'add a task from a merged PR: its issue as the request, its tests as hidden checks',
      flags: [
        ['--pr N', 'the merged PR (required)'],
        ['--name N', 'the task name (default: from the PR)'],
        ['--test-pattern P', 'which changed files are the hidden tests'],
      ],
      exits: [
        [1, 'the PR cannot be used'],
        [5, 'gh or git failed'],
      ],
    },
    {
      command: 'eval start',
      args: '[--tasks a,b] [--tags a,b] [--label L]',
      summary: 'start a run: one eval job per task, each in its own worktree',
      flags: [
        ['--tasks a,b', 'only these tasks'],
        ['--tags a,b', 'only tasks with these tags'],
        ['--label L', "the run's label"],
      ],
      exits: [
        [1, 'no task matches'],
        [5, 'git failed'],
      ],
    },
    {
      command: 'eval grade',
      args: '<job>',
      summary: "grade an eval job's result against its task's checks",
      exits: [
        [1, 'no such job, or not an eval job'],
        [5, 'git failed'],
      ],
    },
    { command: 'eval runs', args: '', summary: 'the runs, with their summaries' },
    { command: 'eval report', args: '<run>', summary: 'one run in full', exits: [[1, 'no such run']] },
    { command: 'eval compare', args: '<runA> <runB>', summary: 'two runs side by side, per task', exits: [[1, 'no such run']] },
  ],
};

export const HELP: HelpGroup[] = [EVAL];

/** The result is printed as JSON. */
export async function evalCmd(root: string, config: Config, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<unknown> {
  switch (sub) {
    case 'list':
      return evals.listTasks(root).map(({ dir: _d, request: _r, ...t }) => t);
    case 'new':
      return evals.createTask(root, req(rest[0], 'name'), flags.title ?? rest[0], bodyFrom(flags) || req(flags.request, '--request or --body-file'));
    case 'mine':
      return evals.mineFromPr(root, config, Number(req(flags.pr, '--pr')), { name: flags.name, testPattern: flags['test-pattern'] });
    case 'start':
      return evals.startRun(root, config, { tasks: list(flags.tasks), tags: list(flags.tags), label: flags.label });
    case 'grade':
      return evals.gradeJob(root, config, req(rest[0], 'job id'));
    case 'runs':
      return evals.listRuns(root).map((r) => ({ id: r.id, label: r.label, status: r.status, configHash: r.configHash, forgeVersion: r.forgeVersion, summary: r.summary }));
    case 'report': {
      const r = evals.listRuns(root).find((x) => x.id === req(rest[0], 'run id'));
      if (!r) throw new ForgeError(`no run ${rest[0]}`);
      return r;
    }
    case 'compare':
      return evals.compareRuns(root, req(rest[0], 'run A'), req(rest[1], 'run B'));
    default:
      throw usageError(EVAL);
  }
}
