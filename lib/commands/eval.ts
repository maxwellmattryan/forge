// `forge eval …`: lists, mines, starts, grades and reports eval tasks, and the reviewer recall evals.
import { parseOverlay } from '../eval-overlay.ts';
import * as evals from '../evals.ts';
import * as recall from '../recall.ts';
import { ForgeError } from '../core/errors.ts';
import { bodyFrom, list, num, req, requireJob, usageError } from './args.ts';
import type { Config, HelpGroup } from '../core/types.ts';

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
      args: '[--tasks a,b] [--tags a,b] [--label L] [--repeat N] [--set key=value]...',
      summary: 'start a run: one eval job per task, each in its own worktree',
      flags: [
        ['--tasks a,b', 'only these tasks'],
        ['--tags a,b', 'only tasks with these tags'],
        ['--label L', "the run's label"],
        ['--repeat N', 'eval jobs per task, 1–10 (default 1)'],
        ['--set key=value', "a config overlay for this run's jobs: runtime.models.*, runtime.effort(s), pipeline.*, review.panel or verify; repeatable; never writes .forge/config.yml"],
      ],
      exits: [
        [1, 'no task matches, or a bad --repeat or --set'],
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
    { command: 'eval compare', args: '<runA> <runB>', summary: 'two runs side by side: stamps, deltas with sample counts, per task', exits: [[1, 'no such run']] },
    {
      command: 'eval recall list',
      args: '',
      summary: "the main checkout's reviewer recall fixtures (.forge/evals/recall/<name>/): lenses, planted defects, clean or not",
      exits: [[1, 'a fixture is invalid (the message names it and the problem)']],
      docs: ['Reviewer recall evals', 'docs/IMPROVEMENT.md#reviewer-recall-evals'],
    },
    {
      command: 'eval recall start',
      args: '[--job <id>]',
      summary:
        "start a recall run: copy each fixture's diff and return one forge:reviewer brief per fixture and lens, under the job worktree's (or repo's) own agents/reviewer.md when it has one, else the installed plugin's",
      flags: [['--job <id>', "grade this job's prompts: the run lives in its job dir and logs a recall event"]],
      exits: [[1, 'a fixture is invalid, there is none, or no such job']],
      docs: ['Reviewer recall evals', 'docs/IMPROVEMENT.md#reviewer-recall-evals'],
    },
    {
      command: 'eval recall record',
      args: '<run> [--tokens N]',
      summary: 'grade every review of a run: recall (planted defects caught) and precision (clean fixtures left alone) per lens, against the last base-branch run',
      flags: [['--tokens N', "the run's tokens, recorded as given"]],
      exits: [[1, 'no such run, the run is already recorded, or no review file exists']],
      docs: ['Reviewer recall evals', 'docs/IMPROVEMENT.md#reviewer-recall-evals'],
    },
  ],
};

/** `forge eval recall list|start|record`. */
function recallCmd(root: string, config: Config, sub: string | undefined, rest: string[], flags: Record<string, any>): unknown {
  const usage = () => usageError(EVAL, sub ? `recall ${sub}` : undefined);
  switch (`recall ${sub}`) {
    case 'recall list':
      if (rest.length) throw usage();
      return recall.listRecall(root);
    case 'recall start':
      if (rest.length) throw usage();
      return recall.startRecall(root, config, flags.job === undefined ? null : requireJob(root, flags.job));
    case 'recall record':
      if (rest.length !== 1) throw usage();
      return recall.recordRecall(root, config, rest[0], { tokens: num(flags.tokens, '--tokens', { integer: true }) ?? null });
    default:
      throw usage();
  }
}

export const HELP: HelpGroup[] = [EVAL];

const MAX_REPEAT = 10;
// The overlay bypasses the daemon's config trust check by design, so only a human starts one.
const SET_DAEMON_REFUSAL = 'forge eval start --set changes what eval jobs run, which a daemon session may not do; a human runs it in their own session';

/** --repeat as an integer from 1 to MAX_REPEAT; it multiplies the run's spend. */
function repeatFlag(v: unknown): number {
  if (v === undefined) return 1;
  const raw = v === true ? '' : String(v);
  if (Array.isArray(v) || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_REPEAT)
    throw new ForgeError(`--repeat must be an integer from 1 to ${MAX_REPEAT} (got ${v === true ? 'no value' : JSON.stringify(String(v))})`);
  return Number(raw);
}

/** Every --set value as given: not comma-split, since lists hold commas. */
function setFlags(v: unknown): string[] {
  if (v === undefined) return [];
  const sets = ([] as unknown[]).concat(v);
  if (sets.some((x) => x === true)) throw new ForgeError('missing value for --set (write --set=<key>=<value> if the value starts with --)');
  return sets.map(String);
}

/** The result is printed as JSON. */
export async function evalCmd(root: string, config: Config, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<unknown> {
  switch (sub) {
    case 'list':
      return evals.listTasks(root).map(({ dir: _d, request: _r, ...t }) => t);
    case 'new':
      return evals.createTask(root, req(rest[0], 'name'), flags.title ?? rest[0], bodyFrom(flags) || req(flags.request, '--request or --body-file'));
    case 'mine':
      return evals.mineFromPr(root, config, Number(req(flags.pr, '--pr')), { name: flags.name, testPattern: flags['test-pattern'] });
    case 'start': {
      // Everything is checked before startRun, so a refusal creates no job, worktree or run file.
      const repeat = repeatFlag(flags.repeat);
      const sets = setFlags(flags.set);
      if (sets.length && process.env.FORGE_DAEMON === '1') throw new ForgeError(SET_DAEMON_REFUSAL);
      const overlay = parseOverlay(root, config, sets);
      return evals.startRun(root, config, { tasks: list(flags.tasks), tags: list(flags.tags), label: flags.label, repeat, overlay });
    }
    case 'grade':
      return evals.gradeJob(root, config, req(rest[0], 'job id'));
    case 'runs':
      return evals.listRuns(root).map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status,
        configHash: r.configHash,
        forgeVersion: r.forgeVersion,
        pluginHash: r.pluginHash ?? null,
        repeat: r.repeat ?? 1,
        overlay: r.overlay ?? {},
        summary: r.summary,
      }));
    case 'report': {
      const r = evals.listRuns(root).find((x) => x.id === req(rest[0], 'run id'));
      if (!r) throw new ForgeError(`no run ${rest[0]}`);
      return r;
    }
    case 'compare':
      return evals.compareRuns(root, req(rest[0], 'run A'), req(rest[1], 'run B'));
    default:
      if (sub === 'recall') return recallCmd(root, config, rest[0], rest.slice(1), flags);
      throw usageError(EVAL);
  }
}
