// `forge release plan|run|status`: a release a human runs from the CLI, single- or multi-repo
// (lib/engine/release/plan.ts plans it, lib/engine/release/run.ts runs it; docs/RELEASES.md "Releasing a project").
import readline from 'node:readline/promises';
import { refuseRun, releaseStatus, runRelease } from '#engine/release/run.ts';
import { noteReleasePlanned } from '#engine/release/approval.ts';
import { selectionFrom, writeReleasePlan } from '#engine/release/plan.ts';
import { ForgeError } from '#core/errors.ts';
import { usageError } from './args.ts';
import type { CliContext, Dispatched, HelpGroup } from '#core/types.ts';

const DOCS: [string, string] = ['Releasing a project', 'docs/RELEASES.md#releasing-a-project'];

const RELEASE: HelpGroup = {
  name: 'release',
  summary: 'plan and run a release of the root repo and its member repos',
  commands: [
    {
      command: 'release plan',
      args: '[--job ID | --since TAG] [--force]',
      summary:
        "plan a release from each repo's release strategy, dependencies first: write .forge/runtime/release/release.md (steps, checks and rollback) and release.json; nothing runs. With --job, the job's PRs must be merged, except a consumer of an interim edge, which is skipped (it merges after its dependencies' release); the plan logs release-planned and, when the Foreman decides the release gate class, queues its gate request, and approval says who owns the publish decision",
      flags: [
        ['--job ID', "release the job's merged PR repos; an unmerged consumer of an interim edge is skipped"],
        ['--since TAG', 'release the repos with commits since TAG'],
        ['--force', "discard an unfinished run's checkpoints (not in a daemon session)"],
      ],
      exits: [[1, 'config problems, an unmerged PR that is no interim consumer, no merged PR at all (--job), an unusable member clone (--job), no repo with the tag, a build cycle, an unfinished run of another plan, a symlinked release dir, or --force in a daemon session']],
      docs: DOCS,
      readme: true,
    },
    {
      command: 'release run',
      args: '',
      summary:
        'run the plan step by step, checking each, with checkpoints so a second run resumes at the first step not done; a step whose check already passes is skipped, and publish steps ask on a terminal unless the repo sets release.publish: allow, and without a terminal they run only when the Foreman approved this exact plan (approvedBy: foreman). On a --job plan, each dependency repo whose last step finished in this run gets its release recorded on the job from the checks of this run (released: version, recorded, and a hint when no single version showed), which resumes the job to bump its consumers. Prints its own result',
      exits: [
        [1, 'stopped at a step (the result says why), no plan, a stale or edited plan, a symlinked release dir, a daemon session, or native Windows'],
        [3, 'another forge release run holds the lock'],
      ],
      docs: DOCS,
      readme: true,
    },
    {
      command: 'release status',
      args: '',
      summary: "the plan's progress: each step's status with the tags and versions its checks recorded, the next step, whether config or the repos have moved since planning, and the publish approval (owner, pending or approved)",
      docs: DOCS,
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [RELEASE];

const PLAN_DAEMON_REFUSAL = "forge release plan --force discards a release run's checkpoints, which a daemon session may not do; a human runs it in their own session";

/** A yes/no question on stderr, as `forge dash` asks about daemon auth. */
async function ask(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(prompt)).trim());
  } finally {
    rl.close();
  }
}

export async function releaseCmd(ctx: CliContext, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<Dispatched> {
  const { root, config } = ctx;
  if (sub === 'plan') {
    if (rest.length) throw usageError(RELEASE, 'plan');
    if (flags.force !== undefined && process.env.FORGE_DAEMON === '1') throw new ForgeError(PLAN_DAEMON_REFUSAL);
    const selection = selectionFrom(flags);
    const written = writeReleasePlan(root, config, selection, { force: flags.force === true });
    // Only a --job plan has a gate: --since and plain plans are always a human's to run.
    const approval = selection.kind === 'job' ? noteReleasePlanned(root, config) : { owner: 'human' as const, request: null };
    return { data: { ...written, approval }, exitCode: 0 };
  }
  if (sub === 'run') {
    refuseRun();
    if (rest.length) throw usageError(RELEASE, 'run');
    const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
    return runRelease(root, config, { interactive, confirm: ask });
  }
  if (sub === 'status') {
    if (rest.length) throw usageError(RELEASE, 'status');
    return { data: releaseStatus(root, config), exitCode: 0 };
  }
  throw usageError(RELEASE);
}
