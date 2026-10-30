// `forge office pass|survey|board|start|resume|note`: the Office's director loop (lib/office/mandates/pass.ts
// and director.ts). `pass` is what `forge dash` runs, and no daemon session may run it. The rest run only in
// an office run (scope `_office`, forge dash's children on a `direct` request) or in a person's own terminal:
// any other daemon scope is refused before anything is read.
import { ForgeError } from '#core/errors.ts';
import { inOffice } from '#core/job/requests.ts';
import { FOREMAN_ACTOR, currentActor } from '#integrations/github/actor.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { refuseOutsideOffice } from '#office/session/permissions/owner.ts';
import { cleanReason } from '#office/mandates/contract.ts';
import { directorTracker, officeBoard, officeNote, officeResume, officeStart, officeSurvey } from '#office/mandates/director.ts';
import { runOfficePass } from '#office/mandates/pass.ts';
import { startFromRef } from './tracker.ts';
import { str, usageError } from './args.ts';
import type { CliContext, Dispatched, HelpGroup } from '../types.ts';

const DOCS: [string, string] = ['Foreman › Director loop', 'docs/architecture/foreman.md'];
const SCOPE_EXIT = 'run in a daemon session other than the office, or with a missing or invalid scope';
const REASON: [string, string] = ['--reason R', 'why, one line of at most 200 characters (required)'];

const OFFICE: HelpGroup = {
  name: 'office',
  summary: "the Office's director loop: the pass forge dash runs, and the survey and directives its office runs run",
  commands: [
    {
      command: 'office pass',
      args: '',
      summary:
        "enforce every mandate's contract once, with no model: onUnfinishable on failed jobs, bounce stalls, the self-close with its closing summary and one retro request over the mandate's jobs (and the next link of a chain, in the same pass), the budget pause, the quality pause and the cadence stall; an until: released mandate whose jobs have all merged plans its release since the root's latest tag and waits for release approval (no pause or stall meanwhile), closing once the release run finished; for each closed mandate whose closing summary's card still has an open outcome, rewrite the card once when none is open (finalized); then queue one direct request, which forge dash runs as an office run, when a mandate has work to start or resume ({ok, enabled, mandates: [{id, state, actions, inFlight, free, candidates, spentUsd, started, blocked, release}], direct, problems, finalized}; release is the mandate's release state for an effective until: released, else null); with foreman.enabled false it writes nothing. forge dash runs it every foreman.cadence minutes and when a mandate or a mandate job changes",
      exits: [[1, 'run in a daemon session (forge dash runs it)']],
      docs: DOCS,
      common: true,
    },
    {
      command: 'office survey',
      args: '',
      summary:
        "read-only: every active mandate's figures, its window of candidates (titles one line), its resumable jobs, its latest 5 directives and its guidance fenced as data ({enabled, cadence, surveyors, repoBudget, mandates, problems})",
      exits: [[1, SCOPE_EXIT]],
      docs: DOCS,
    },
    {
      command: 'office board',
      args: '<mandate>',
      summary:
        "write the mandate's board (<mandate dir>/board.md: up to 100 job lines, in-flight first, in one fence under a data line) and return the forge:surveyor brief ({mandate, subagent, model, effort, brief, board})",
      exits: [[1, `foreman.surveyors.enabled is false, no such mandate or it can't be read, or ${SCOPE_EXIT}`]],
      docs: DOCS,
    },
    {
      command: 'office start',
      args: '<mandate> <ref> --reason R',
      summary:
        "start one issue of an active mandate: under the office lock, re-check its limits and that ref is in its window now (under order listed, its next issue), then create the job in the mandate, claim the issue, queue its resume and log a start directive ({ok, mandate, issue, job, request}); an issue the tracker reports closed or missing is skipped instead ({ok, skipped: true, issue, reason})",
      flags: [REASON],
      exits: [
        [1, `the mandate is missing, unreadable or not active, it is blocked (budget, tracker error, foreman off), ref is not in its window, the issue already has a job, or ${SCOPE_EXIT}`],
        [3, 'the tracker refused the claim'],
        [4, 'the repo budget holds new work'],
      ],
      docs: DOCS,
    },
    {
      command: 'office resume',
      args: '<mandate> <job> --reason R',
      summary: "queue a resume for one of an active mandate's resumable jobs (queued, no live lease, no open request) and log a resume directive ({ok, mandate, job, request})",
      flags: [REASON],
      exits: [[1, `the mandate is missing, unreadable or not active, the job is not one of its resumable jobs, or ${SCOPE_EXIT}`]],
      docs: DOCS,
    },
    {
      command: 'office note',
      args: '<mandate> --reason R',
      summary: 'log a note directive on a mandate that is not closed, such as why nothing starts though candidates exist ({ok, mandate})',
      flags: [REASON],
      exits: [[1, `the mandate is missing, unreadable or closed, or ${SCOPE_EXIT}`]],
      docs: DOCS,
    },
  ],
};

export const HELP: HelpGroup[] = [OFFICE];

const ARITY: Record<string, number> = { survey: 0, board: 1, start: 2, resume: 2, note: 1 };

/** --reason as a directive stores it; a usage error when it is missing or empty. */
function reasonFlag(sub: string, flags: Record<string, unknown>): string {
  const r = cleanReason(str(flags.reason, '--reason'));
  if (r === null) throw new ForgeError(`forge office ${sub} needs --reason "<why>"`, 'usage', `forge help office ${sub}`);
  return r;
}

export async function officeCmd(ctx: CliContext, sub: string | undefined, rest: string[], flags: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<Dispatched> {
  const { root, config } = ctx;
  if (sub === 'pass') {
    // First, before anything is read: enforcement runs only from forge dash, never from a session.
    if (env.FORGE_DAEMON === '1') throw new ForgeError('forge office pass runs outside daemon sessions (forge dash runs it)', 1);
    if (rest.length) throw usageError(OFFICE, sub);
    return { data: await runOfficePass(root, config), exitCode: 0 };
  }
  if (sub === undefined || !(sub in ARITY)) throw usageError(OFFICE);
  refuseOutsideOffice(`office ${sub}`, env);
  if (rest.length !== ARITY[sub]) throw usageError(OFFICE, sub);
  // An office run acts as the Foreman; a person in their own terminal as themselves.
  const actor = () => (inOffice(env) ? FOREMAN_ACTOR : currentActor(root));
  if (sub === 'survey') return { data: officeSurvey(root, config, await directorTracker(() => loadTracker(root, config))), exitCode: 0 };
  if (sub === 'board') return { data: officeBoard(root, config, rest[0]), exitCode: 0 };
  const reason = reasonFlag(sub, flags);
  if (sub === 'note') return { data: officeNote(root, rest[0], reason, actor()), exitCode: 0 };
  if (sub === 'resume') return { data: await officeResume(root, config, rest[0], rest[1], reason, actor()), exitCode: 0 };
  const t = await directorTracker(() => loadTracker(root, config));
  const id = rest[0];
  const start = (tracker: Parameters<typeof startFromRef>[2], native: string) => startFromRef(root, config, tracker, native, {}, { splitMode: 'never', mandate: id });
  return { data: await officeStart(root, config, id, rest[1], reason, { ...t, actor: actor(), start }), exitCode: 0 };
}
