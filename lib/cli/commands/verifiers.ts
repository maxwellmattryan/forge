// `forge verifiers list|run|record`: the repo's yes/no checks between verify and the review panel
// (lib/engine/pipeline/verifiers.ts, docs/VERIFIERS.md). `run` and `record` are what `forge job step` emits as VF1
// and VF3; the verifier agent in between only reads the input and writes the answers.
import path from 'node:path';
import { loadVerifiers, verifiersRecord, verifiersRun } from '#engine/pipeline/verifiers.ts';
import { usageError } from './args.ts';
import type { CliContext, Dispatched, HelpGroup } from '../types.ts';

const VERIFIERS: HelpGroup = {
  name: 'verifiers',
  summary: 'narrow yes/no checks between verify and the review panel',
  commands: [
    {
      command: 'verifiers list',
      args: '',
      summary: "the main checkout's .forge/verifiers/*.md that will run, and the problems that keep the others from running",
      docs: ['Verifiers', 'docs/VERIFIERS.md'],
      readme: true,
    },
    {
      command: 'verifiers run',
      args: '<id>',
      summary:
        "select the verifiers whose paths match the diff of the commit the round's passing verify checked, and write the verifier agent's input; with none selected, write the PASS report straight away",
      exits: [
        [1, "no such job, no worktree, or no passing verify in the job's round"],
        [5, 'git failed'],
      ],
      readme: true,
    },
    {
      command: 'verifiers record',
      args: '<id>',
      summary: "turn the verifier agent's answers into verify/round-<n>-verifiers.md; a block-mode NO (or no valid answer) whose severity is in review.blockOn fails the round's verify",
      exits: [
        [1, 'no such job, or no pending verifiers run in its round'],
        [5, 'git failed'],
      ],
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [VERIFIERS];

export function verifiersCmd(ctx: CliContext, sub: string | undefined, rest: string[]): Dispatched {
  const { root, config } = ctx;
  if (sub === 'list') {
    if (rest.length) throw usageError(VERIFIERS, 'list');
    const set = loadVerifiers(root);
    return {
      data: {
        dir: path.relative(root, set.dir),
        verifiers: set.verifiers.map(({ name, paths, severity, mode, question }) => ({ name, paths, severity, mode, question })),
        problems: set.problems,
      },
      exitCode: 0,
    };
  }
  if (sub === 'run' || sub === 'record') {
    if (rest.length !== 1) throw usageError(VERIFIERS, sub);
    return { data: sub === 'run' ? verifiersRun(root, config, rest[0]) : verifiersRecord(root, config, rest[0]), exitCode: 0 };
  }
  throw usageError(VERIFIERS);
}
