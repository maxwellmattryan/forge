// The human-command table: what one job request (approve, revise-spec, answer, rework, cancel, resume) records on the
// job it names, as a plan `forge job apply` carries out, and the two files a request's text reaches (feedback.md and
// the questions.md answer), always fenced as data. requestPlan and requestLink are pure; the writers are its I/O half.
import fs from 'node:fs';
import path from 'node:path';
import { isQualifiedRef } from '#core/job/issue-ref.ts';
import { jobDir } from '#core/job/store.ts';
import { AGENT_TEXT_MAX, readRegularText, writeTextAtomic } from '#core/os/fs.ts';
import { ForgeError } from '#core/errors.ts';
import { fenceImport, oneLineTitle } from '#core/text.ts';
import type { ForgeRequest, Job } from '#core/types.ts';
import { isRepoProposalPark } from '../../project/repo-proposals.ts';
import { isShelved, shelvedRefusal } from './shelve.ts';

/** Where a person's decision comes from: the dashboard's POST, or `forge requests add` outside a daemon session. */
export const PERSON_SOURCES: readonly string[] = ['dashboard', 'cli'];

/** The request types that record a person's decision; a `resume` only moves the job on. */
const DECISIONS: readonly string[] = ['approve', 'revise-spec', 'answer', 'rework', 'cancel'];

/** Request types a shelved job refuses: each would restart it. */
const RESTARTING: readonly string[] = ['approve', 'revise-spec', 'rework', 'answer', 'resume'];

export type RequestHumanAction = 'approve-spec' | 'approve' | 'approve-split' | 'revise-split' | 'revise-spec' | 'rework' | 'answer';

/** One step of a plan: a `forge job human` decision, a `forge job set` move, or a file the CLI writes from the request text. */
export type RequestStep =
  | { human: RequestHumanAction; note: string | null; link?: string; reason?: string }
  | { set: { stage?: string; state: string; note?: string; reason?: string } }
  | { feedback: true }
  | { answer: true };

/** What a request does: refused with a reason, nothing (the step loop is the whole answer), or steps in order. */
export type RequestPlan = { refuse: string } | { none: true } | { steps: RequestStep[] };

export interface RequestPlanContext {
  /** forge job budget's `stillExceeded`, read only for a budget park; null anywhere else. */
  stillExceeded: string[] | null;
  /** The clock a repo budget's period is named from (UTC). */
  now: Date;
}

/** The reason step's SP5 writes for a spec gate on a job with no issue yet: only there does an approve link one. */
const UNLINKED_SPEC = 'spec ready, issue unlinked';

const REPO_PROPOSAL_REFUSAL = (id: string): string =>
  `decide repo proposals in the dashboard drawer or your own terminal: forge job human ${id} approve-repos|reject-repos --repo <names>`;

const LINK_ERROR = 'an approve on an issue-link park needs args.link or a first word new, none or an issue ref';

const textOf = (req: Pick<ForgeRequest, 'text'>): string => (typeof req.text === 'string' ? req.text : '');
const noteOf = (req: Pick<ForgeRequest, 'text'>): string | null => (textOf(req).trim() ? textOf(req) : null);
/** A source or type named in a refusal: one line, short, so a request file can't stretch it. */
const named = (v: unknown): string => oneLineTitle(String(v ?? '')).slice(0, 60) || 'nowhere';

/**
 * The link an approve carries: `args.link` when given, else the text's first word when it is `new`, `none` (the rest is
 * the reason), all digits, starts with `#`, or a qualified ref (the rest is the note). Otherwise null at the spec gate (the
 * whole text stays the note) and an error at an issue-link park. `forge job human` checks the link itself.
 */
export interface RequestLink {
  link: string;
  reason?: string;
  note: string | null;
}

const linkError = (l: RequestLink | { error: string }): l is { error: string } => 'error' in l;

export function requestLink(req: Pick<ForgeRequest, 'text' | 'args'>, job: Pick<Job, 'waitingOn'>): RequestLink | { error: string } | null {
  const given = req.args?.link;
  if (given !== undefined && given !== null) return typeof given === 'string' ? { link: given, note: noteOf(req) } : { error: 'args.link must be an issue ref, new or none' };
  const text = textOf(req).trim();
  const first = text.split(/\s/, 1)[0];
  const rest = text.slice(first.length).trim();
  if (first === 'new') return { link: 'new', note: rest || null };
  if (first === 'none') return { link: 'none', ...(rest ? { reason: rest } : {}), note: null };
  if (first && (/^\d+$/.test(first) || first.startsWith('#') || isQualifiedRef(first))) return { link: first, note: rest || null };
  return job.waitingOn === 'issue-link' ? { error: LINK_ERROR } : null;
}

/** The period `forge budget ack` takes for a repo budget reason: the UTC day when the reason says today, else the month. */
const repoPeriod = (reason: string, now: Date): string => now.toISOString().slice(0, /\btoday\b/.test(reason) ? 10 : 7);

const human = (action: RequestHumanAction, note: string | null): RequestStep => ({ human: action, note });
const steps = (...s: RequestStep[]): RequestPlan => ({ steps: s });
/** A decision step, then feedback.md when the request has text. */
const withFeedback = (action: RequestHumanAction, note: string | null): RequestPlan => steps(human(action, note), ...(note ? [{ feedback: true } as const] : []));
const linked = (action: RequestHumanAction, l: RequestLink): RequestStep => ({ human: action, note: l.note, link: l.link, ...(l.reason ? { reason: l.reason } : {}) });

function approvePlan(req: ForgeRequest, job: Job, on: string | null, ctx: RequestPlanContext): RequestPlan {
  const note = noteOf(req);
  const reason = String(job.reason ?? '');
  switch (on) {
    case 'spec-approval': {
      const link = reason === UNLINKED_SPEC ? requestLink(req, job) : null;
      if (link === null) return steps(human('approve-spec', note));
      return linkError(link) ? { refuse: link.error } : steps(linked('approve-spec', link));
    }
    case 'escalation':
    case 'rounds-exhausted':
    case 'infra':
    case 'conflicts':
      return steps(human('approve', note));
    case 'budget': {
      if (reason.startsWith('repo budget:'))
        return { refuse: `the repo budget holds this job: a person runs forge budget ack --period ${repoPeriod(reason, ctx.now)} or raises budget.*` };
      const still = ctx.stillExceeded;
      if (still && !still.length) return steps(human('approve', note));
      return { refuse: `still over budget: ${still ? still.join(', ') : 'unknown'}: raise or acknowledge it on the dashboard's budget gate, or with forge job budget ${job.id} --set or --ack in your own terminal` };
    }
    case 'split-approval':
      return steps(human('approve-split', note));
    case 'issue-link': {
      const link = requestLink(req, job);
      if (link === null) return { refuse: LINK_ERROR };
      return linkError(link) ? { refuse: link.error } : steps(linked('approve', link));
    }
    case 'human':
      return isRepoProposalPark(job) ? { refuse: REPO_PROPOSAL_REFUSAL(job.id) } : steps(human('approve', note));
    default:
      return { refuse: `${job.id} is ${job.state}${job.waitingOn ? ` on ${job.waitingOn}` : ''}: an approve answers no gate there` };
  }
}

/**
 * The plan for one request on its job: provenance first (a decision only from a person), then the shelf, then the row for
 * the request type and the gate the job waits at. `none` leaves a plain resume to the step loop; a resume's button rows
 * (infra, external, conflicts, failed) are a person's too.
 */
export function requestPlan(req: ForgeRequest, job: Job, ctx: RequestPlanContext): RequestPlan {
  const type = req.type;
  if (DECISIONS.includes(type) && !PERSON_SOURCES.includes(req.from)) return { refuse: `human decisions come from a person (this ${named(type)} came from ${named(req.from)})` };
  if (RESTARTING.includes(type) && isShelved(job)) return { refuse: shelvedRefusal(job.id) };
  const on = job.state === 'waiting' ? job.waitingOn : null;
  const note = noteOf(req);
  const proposal = isRepoProposalPark(job);
  switch (type) {
    case 'approve':
      return approvePlan(req, job, on, ctx);
    case 'revise-spec':
      if (on === 'split-approval') return withFeedback('revise-split', note);
      return proposal ? { refuse: REPO_PROPOSAL_REFUSAL(job.id) } : withFeedback('revise-spec', note);
    case 'answer':
      if (on !== 'input') return { refuse: `${job.id} is not waiting on input` };
      return note ? steps(human('answer', note), { answer: true }) : { refuse: 'an answer needs text' };
    case 'rework':
      if (on === 'conflicts') return steps(human('approve', note));
      return proposal ? { refuse: REPO_PROPOSAL_REFUSAL(job.id) } : withFeedback('rework', note);
    case 'cancel':
      return steps({ set: { state: 'cancelled', reason: oneLineTitle(textOf(req)).slice(0, 200) || 'cancelled by a person' } });
    case 'resume':
      // The four rows are the dashboard's buttons, a person's choice. A resume from Forge, sync or a daemon session only
      // moves the job on: the step loop answers it (the Foreman's approve at conflicts is GA4's, not a deferral).
      if (!PERSON_SOURCES.includes(req.from)) return { none: true };
      if (on === 'infra') return steps(human('approve', 'steps done'));
      if (on === 'external') return steps({ set: { state: 'running' } });
      if (on === 'conflicts') return steps({ set: { stage: 'decide', state: 'running', note: 'conflicts with base deferred' } });
      if (job.state === 'failed') return steps({ set: { state: 'running' } });
      return { none: true };
    default:
      return { refuse: `${named(type)} is not a job request` };
  }
}

/** Where a request's text says it came from, on the provenance line of what the CLI writes from it. */
const requestSource = (req: Pick<ForgeRequest, 'id' | 'type' | 'from'>): string => `the ${named(req.from)} ${named(req.type)} request ${req.id}`;

/** feedback.md, overwritten with the request's text fenced as data; returns its path. */
export function writeRequestFeedback(root: string, id: string, req: Pick<ForgeRequest, 'id' | 'type' | 'from' | 'text'>): string {
  const dir = jobDir(root, id);
  const file = path.join(dir, 'feedback.md');
  writeTextAtomic(file, `${fenceImport(textOf(req), requestSource(req))}\n`, { root: dir });
  return file;
}

/**
 * The answer appended to questions.md: an empty line, `## Answer`, an empty line, then the text fenced as data, after
 * everything already there. The old content is read without following a link; a questions.md that is not a regular
 * file is refused rather than replaced. Returns its path.
 */
export function appendRequestAnswer(root: string, id: string, req: Pick<ForgeRequest, 'id' | 'type' | 'from' | 'text'>): string {
  const dir = jobDir(root, id);
  const file = path.join(dir, 'questions.md');
  let before = '';
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    const read = readRegularText(file, AGENT_TEXT_MAX);
    if (read === null) throw new ForgeError(`${file} is not a regular file Forge can read: the answer was not written`);
    before = read && !read.endsWith('\n') ? `${read}\n` : read;
  }
  writeTextAtomic(file, `${before}\n## Answer\n\n${fenceImport(textOf(req), requestSource(req))}\n`, { root: dir });
  return file;
}
