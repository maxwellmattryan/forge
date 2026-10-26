// `forge mandate new|edit|pause|resume|close|list|show` and `forge mandate draft
// start|prepare|record|show|approve|revise|reject|assist`: the owner's mandates to the Office, a goal
// mandate's drafting runs and its milestone-approval gate (lib/office/mandates/, docs/CONFIG.md
// "Mandates"). Every write and `draft start` is refused in a daemon session, before anything is read: a
// session misled by tracker or PR text must not widen or create what directs the Office, or spend on
// drafting. `draft prepare|record` run only in the office session or a person's terminal; `draft
// approve|revise|reject` are a person's, or an assistant foreman's with `--actor foreman`.
import fs from 'node:fs';
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { OFFICE_SCOPE, SCOPE_ENV, daemonScope, inAssistant } from '#core/job/requests.ts';
import { oneLineTitle } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { AGENT_ID } from '#integrations/claude/transcripts.ts';
import { FOREMAN_ACTOR, currentActor } from '#integrations/github/actor.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { boundRequest, draftFile, draftSpend, draftStatus, queueDraftRequest, recordDraft } from '#office/mandates/draft.ts';
import { assistDraft, decideDraft, draftGate, gateView, onDraftRecorded } from '#office/mandates/gate.ts';
import type { DraftDecision } from '#office/mandates/gate.ts';
import { prepareDraft, staleReason } from '#office/mandates/intake.ts';
import { listMandates, mandateFile, mandateJobs, writeMandate } from '#office/mandates/store.ts';
import type { MandateAction } from '#office/mandates/store.ts';
import {
  applyInput,
  blankMandate,
  cleanReason,
  effectiveContract,
  fillDefaults,
  isReadable,
  issueRefs,
  mandateChain,
  mandateGoal,
  mandateGuidance,
  mandateProblems,
  mandateState,
  mandateSummary,
} from '#office/mandates/contract.ts';
import type { Mandate, MandateInput, ReadMandate } from '#office/mandates/types.ts';
import { bodyFrom, list, req, str, usageError } from './args.ts';
import type { CliContext, Dispatched, HelpGroup } from '../types.ts';

const TERMS: [string, string][] = [
  ['--milestones A,B', 'milestones in the order they are worked (none: empty the list on edit)'],
  ['--labels a,b', 'labels an issue in scope carries (none: empty)'],
  ['--issues r1,r2', 'issues worked in the order given; needs --order listed (none: empty)'],
  ['--until merge-ready|merged', 'where its work stops (merged applies only under foreman.ship: merge)'],
  ['--max-jobs N', 'its jobs running at once, 1-16'],
  ['--order graph|priority|listed', 'how it orders its work'],
  ['--decides g1,g2|none', 'the gate classes it delegates, within foreman.decides minus gate:<class> reservations'],
  ['--budget-usd N', 'its spend cap in USD, over 0 and at most 100000'],
  ['--budget-jobs N', 'the jobs it may start, 1-1000'],
  ['--stall-cadences N', "the Foreman's passes with no progress before it is stalled, 1-100"],
  ['--stall-bounces N', 'gate bounces on one job before it is stalled, 1-100'],
  ['--on-unfinishable park|cancel', "what it does with a job it can't finish"],
  ['--after ID', 'start only once mandate ID has closed (none: clear it on edit)'],
  ['--body T | --body-file F', "the owner's guidance, fenced as data wherever it is shown (at most 8000 characters)"],
];

const DOCS: [string, string] = ['Mandates', 'docs/CONFIG.md#mandates'];
const INTAKE: [string, string] = ['Foreman › Intake', 'docs/architecture/foreman.md'];
const DAEMON_EXIT = 'a daemon session ran it';

const MANDATE: HelpGroup = {
  name: 'mandate',
  summary: "the owner's mandates: standing instructions to the Office in .forge/runtime/mandates/",
  commands: [
    {
      command: 'mandate new',
      args: '<id> --title T [terms]',
      summary:
        'create a mandate, active, with every contract term not given taken from foreman.mandate (the default decides cut to the classes the foreman may decide) ({ok, changed, mandate}, plus draft: {request} for a goal mandate, whose intake starts with that drafting run)',
      flags: [
        ['--title T', 'one line, at most 200 characters (required)'],
        [
          '--goal T | --goal-file F',
          "a goal mandate: the owner's goal, set once, at most 4000 characters (F may be - for stdin), fenced as data wherever it is shown; its scope stays empty, and the first drafting run is queued (draft.request)",
        ],
        ...TERMS,
      ],
      exits: [[1, `the id exists or is not a mandate id, a term breaks the contract (every problem named), or ${DAEMON_EXIT}`]],
      docs: DOCS,
      readme: true,
    },
    {
      command: 'mandate edit',
      args: '<id> [--title T] [terms]',
      summary: 'replace only the terms given ({ok, changed, mandate}; changed false when nothing differs)',
      flags: [['--title T', 'a new title'], ...TERMS],
      exits: [[1, `no such mandate (not_found), it is closed or can't be read, a term breaks the contract, or ${DAEMON_EXIT}`]],
      docs: DOCS,
    },
    {
      command: 'mandate pause',
      args: '<id> [--reason R]',
      summary: 'pause an active mandate; a paused mandate still narrows its jobs (changed false when already paused)',
      flags: [['--reason R', 'why, one line']],
      exits: [[1, `no such mandate (not_found), it is closed or can't be read, or ${DAEMON_EXIT}`]],
      docs: DOCS,
    },
    {
      command: 'mandate resume',
      args: '<id>',
      summary: 'make a paused mandate active again and clear its reason (changed false when already active)',
      exits: [[1, `no such mandate (not_found), it is closed or can't be read, or ${DAEMON_EXIT}`]],
      docs: DOCS,
    },
    {
      command: 'mandate close',
      args: '<id> [--reason R]',
      summary: 'close a mandate for good, which starts the next link of its chain (changed false when already closed)',
      flags: [['--reason R', 'why, one line']],
      exits: [[1, `no such mandate (not_found), it can't be read, or ${DAEMON_EXIT}`]],
      docs: DOCS,
    },
    {
      command: 'mandate list',
      args: '',
      summary:
        'every mandate by creation time ({mandates: [{id, title, status, state, after, intake, chain, activeLink} | {id, problem}]}); state is waiting while after names a mandate not closed; intake is true for a goal mandate, whose draft forge mandate draft show <id> gives',
      docs: DOCS,
    },
    {
      command: 'mandate show',
      args: '<id>',
      summary:
        "one mandate: its summary, the contract as it applies now (effective) and what the config capped, its chain and active link, its jobs, the owner's guidance and goal fenced as data, a goal mandate's draft {status, request, gate} (gate: none, pending, filing or filed; else null), and its file",
      exits: [[1, "no such mandate (not_found), or it can't be read"]],
      docs: DOCS,
    },
    {
      command: 'mandate draft start',
      args: '<id>',
      summary:
        "queue a drafting run for an active goal mandate, for the office session to turn ({ok, changed, request}; changed false with the request already pending or in progress)",
      exits: [[1, `no such mandate (not_found), it can't be read, is not active, has no goal or its draft is filed, or ${DAEMON_EXIT}`]],
      docs: INTAKE,
    },
    {
      command: 'mandate draft prepare',
      args: '<id> --request R',
      summary:
        "the office session's first call of a drafting run: write the survey and return the forge:drafter brief ({mandate, request, stale: false, subagent, model, effort, brief, survey, staging}; a revision request's brief adds the previous draft's path and its title and the note, both fenced as data), or {stale: true, reason} for a mandate that is missing, unreadable, closed, paused, has no goal or is filed",
      flags: [['--request R', "the claimed draft request (required): in progress, for this mandate"]],
      exits: [[1, "run in a daemon session other than the office, R is not an in-progress draft request for this mandate, R's revision note breaks the note rules, or a link or a file sits at the drafts dir"]],
      docs: INTAKE,
    },
    {
      command: 'mandate draft record',
      args: '<id> --request R [--agent-id A]',
      summary:
        "the office session's last call of a drafting run: append its spend to the mandate's ledger, then check the drafter's staging file and store it as draft.json ({ok, mandate, request, digest, draft: {issues, waves, existing}, spend, file}); notifies that the draft waits for approval, and queues its milestone-approval gate request when the project and the mandate delegate the class",
      flags: [
        ['--request R', 'the claimed draft request (required): in progress, for this mandate'],
        ['--agent-id A', "the drafter's agent id, whose transcript gives the run's usage"],
      ],
      exits: [[1, "run in a daemon session other than the office, R is not an in-progress draft request for this mandate, the mandate can't be read, is closed or has no goal, or the draft breaks the rules (every problem named, at most 20; the spend stays recorded)"]],
      docs: INTAKE,
    },
    {
      command: 'mandate draft show',
      args: '<id>',
      summary:
        "a goal mandate's milestone draft: {mandate, title, status (queued, drafting, ready, unreadable, failed or none), request, note, problem, digest (the SHA-256 of draft.json's bytes, null without a readable draft), draft, gate: {status (none, pending, filing or filed), request, owner, filing}, spend: {runs, withUsage, tokens, usd, metered}, file}",
      exits: [[1, "no such mandate (not_found), it can't be read, or it has no goal"]],
      docs: INTAKE,
    },
    {
      command: 'mandate draft approve',
      args: '<id> [--request R] [--digest D] [--note N] [--actor foreman]',
      summary:
        "approve a pending milestone draft and file it: the milestone, then each issue in wave order (wave-<n> labels), then the mandate turns into a scoped mandate over the milestone ({ok, decision, mandate, request, digest, filing, scope}); run it again to resume a stopped filing",
      flags: [
        ['--request R', 'the draft request you read (draft show): refused once the draft changed'],
        ['--digest D', 'the 64-hex digest you read (draft show): refused once draft.json differs'],
        ['--note N', 'why, at most 2000 characters (required with --actor foreman)'],
        ['--actor foreman', 'an assistant foreman records it, under foreman.decides, foreman.reserved and the mandate\'s decides'],
      ],
      exits: [
        [1, `no such mandate (not_found), it can't be read, is paused or closed, the draft isn't pending (or filing), a pin doesn't match, a pre-flight check fails (secret_found for a likely secret), a decision is already running, a tracker call failed (filing.json keeps what was filed), --actor foreman is refused, or ${DAEMON_EXIT} without --actor foreman`],
        [5, 'gh failed while filing'],
      ],
      docs: INTAKE,
    },
    {
      command: 'mandate draft revise',
      args: '<id> --note N [--request R] [--digest D] [--actor foreman]',
      summary: "send a pending milestone draft back with a note: queues another drafting run whose brief carries the note and the previous draft, fenced ({ok, decision, mandate, request, queued})",
      flags: [
        ['--note N', 'what the drafter should change, at most 2000 characters (required)'],
        ['--request R', 'the draft request you read'],
        ['--digest D', 'the digest you read'],
        ['--actor foreman', 'an assistant foreman records it (at most 2 foreman revisions per mandate)'],
      ],
      exits: [[1, `no such mandate (not_found), it can't be read, is paused or closed, the draft isn't pending, a pin doesn't match, the note breaks the rules, a decision is already running, --actor foreman is refused, or ${DAEMON_EXIT} without --actor foreman`]],
      docs: INTAKE,
    },
    {
      command: 'mandate draft reject',
      args: '<id> [--note N] [--request R] [--digest D]',
      summary: "reject a pending milestone draft: closes the mandate with reason milestone draft rejected (and the note), files nothing, and starts the next link of its chain ({ok, decision, mandate, request, status})",
      flags: [
        ['--note N', 'why, at most 2000 characters'],
        ['--request R', 'the draft request you read'],
        ['--digest D', 'the digest you read'],
      ],
      exits: [[1, `no such mandate (not_found), it can't be read, is paused or closed, the draft isn't pending, a pin doesn't match, a decision is already running, or ${DAEMON_EXIT} (reject is never the foreman's)`]],
      docs: INTAKE,
    },
    {
      command: 'mandate draft assist',
      args: '<id> --request G',
      summary:
        "read-only, for an assistant foreman session (or a person): the forge:assistant spawn for a milestone-approval gate request ({mandate, gate, stale, reason?, reserved, subagent, model, effort, brief}); stale once the draft moved or was decided",
      flags: [['--request G', 'the claimed milestone-approval gate request (required): in progress, for this mandate']],
      exits: [[1, 'run in a daemon session other than an assistant foreman, or G is not an in-progress milestone-approval gate request for this mandate']],
      docs: INTAKE,
    },
  ],
};

export const HELP: HelpGroup[] = [MANDATE];

const WRITES = new Set(['new', 'edit', 'pause', 'resume', 'close']);

const refused = (problems: string[]) => new ForgeError(problems.join('; '), 1);

/** A list flag: undefined when absent, [] for `none`, else the comma-split entries. */
function listFlag(v: unknown, flag: string): string[] | undefined {
  const s = str(v, flag);
  if (s === undefined) return undefined;
  return s === 'none' ? [] : list(s);
}

/** A number flag as Number() reads it; the contract judges range and type. */
function numFlag(v: unknown, flag: string): number | undefined {
  const s = str(v, flag);
  return s === undefined ? undefined : Number(s);
}

/**
 * `--goal` or `--goal-file` (`-` for stdin) as `new` stores it: CRLF and lone CR to LF, then trimmed;
 * undefined when neither is given. The contract judges the result, so an empty goal is refused there.
 */
function goalFrom(flags: Record<string, any>): string | undefined {
  const inline = flags.goal;
  const file = flags['goal-file'];
  if (inline === undefined && file === undefined) return undefined;
  if (inline !== undefined && file !== undefined) throw new ForgeError('pass --goal or --goal-file, not both', 'usage');
  let raw: string;
  if (file !== undefined) {
    const f = str(file, '--goal-file')!;
    try {
      raw = fs.readFileSync(f === '-' ? 0 : f, 'utf8');
    } catch (e) {
      throw new ForgeError(`can't read --goal-file ${JSON.stringify(f).slice(0, 200)} (${(e as NodeJS.ErrnoException).code ?? 'error'})`, 1);
    }
  } else raw = inline === '' ? '' : str(inline, '--goal')!;
  return raw.replace(/\r\n?/g, '\n').trim();
}

/** The terms the flags give, and nothing else, so an edit replaces only those. */
function inputFrom(ctx: CliContext, flags: Record<string, any>): MandateInput {
  const input: MandateInput = {};
  const set = <K extends keyof MandateInput>(k: K, v: MandateInput[K] | undefined) => {
    if (v !== undefined) input[k] = v;
  };
  set('title', str(flags.title, '--title'));
  set('milestones', listFlag(flags.milestones, '--milestones'));
  set('labels', listFlag(flags.labels, '--labels'));
  set('issues', listFlag(flags.issues, '--issues'));
  set('until', str(flags.until, '--until'));
  set('maxJobs', numFlag(flags['max-jobs'], '--max-jobs'));
  set('order', str(flags.order, '--order'));
  set('decides', listFlag(flags.decides, '--decides'));
  set('budgetUsd', numFlag(flags['budget-usd'], '--budget-usd'));
  set('budgetJobs', numFlag(flags['budget-jobs'], '--budget-jobs'));
  set('stallCadences', numFlag(flags['stall-cadences'], '--stall-cadences'));
  set('stallBounces', numFlag(flags['stall-bounces'], '--stall-bounces'));
  set('onUnfinishable', str(flags['on-unfinishable'], '--on-unfinishable'));
  const after = str(flags.after, '--after');
  if (after !== undefined) input.after = after === 'none' ? null : after;
  if (flags.body !== undefined || flags['body-file'] !== undefined) input.body = bodyFrom(flags, ctx.root, ctx.config);
  return input;
}

/** The readable mandate `id` among `all`; not_found when there is none, refused when it can't be read. */
function target(all: ReadMandate[], id: string): Mandate {
  const m = all.find((x) => x.id === id);
  if (!m) throw new ForgeError(`no mandate ${JSON.stringify(id).slice(0, 60)}`, 'not_found');
  if (!isReadable(m)) throw new ForgeError(`mandate ${id} can't be read (${m.problem})`, 1);
  return m;
}

/** Whether two records say the same thing, the edit time aside. */
const same = (a: Mandate, b: Mandate): boolean => JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' });

/** The status moves: each idempotent, so the move to the status a mandate already has writes nothing. */
function statusMove(sub: 'pause' | 'resume' | 'close', m: Mandate, reason: string | null, at: string): Mandate | null {
  if (sub === 'close') return m.status === 'closed' ? null : { ...m, status: 'closed', reason, closedAt: at, updatedAt: at };
  if (m.status === 'closed') throw new ForgeError(`mandate ${m.id} is closed`, 1);
  if (sub === 'pause') return m.status === 'paused' ? null : { ...m, status: 'paused', reason, updatedAt: at };
  return m.status === 'active' ? null : { ...m, status: 'active', reason: null, updatedAt: at };
}

/** What every write returns: the mandate's summary as it now stands. */
function written(root: string, id: string, changed: boolean) {
  const all = listMandates(root);
  return { ok: true, changed, mandate: mandateSummary(target(all, id), all) };
}

function write(ctx: CliContext, sub: string, id: string, flags: Record<string, any>) {
  const { root, config } = ctx;
  if (sub === 'new') {
    const goal = goalFrom(flags);
    const input = { ...inputFrom(ctx, { ...flags, title: req(flags.title, '--title') }), ...(goal === undefined ? {} : { goal }) };
    writeMandate(root, (all) => {
      if (all.some((m) => m.id === id)) throw new ForgeError(`mandate ${id} exists; change it with forge mandate edit`, 1);
      const refs = issueRefs(root, config, fillDefaults(config, input));
      const m = applyInput(blankMandate(id, now()), refs.input);
      const problems = [...refs.problems, ...mandateProblems(config, m, all, null)];
      if (problems.length) throw refused(problems);
      return { mandate: m, action: 'new' as MandateAction };
    });
    // A goal mandate's first drafting run, for the office session to turn.
    if (goal !== undefined) return { ...written(root, id, true), draft: { request: queueDraftRequest(root, id).request } };
    return written(root, id, true);
  }
  const input = sub === 'edit' ? inputFrom(ctx, flags) : {};
  const reason = sub === 'pause' || sub === 'close' ? cleanReason(str(flags.reason, '--reason')) : null;
  const out = writeMandate(root, (all) => {
    const existing = target(all, id);
    if (sub !== 'edit') {
      const next = statusMove(sub as 'pause' | 'resume' | 'close', existing, reason, now());
      return next ? { mandate: next, action: sub as MandateAction, reason } : null;
    }
    const refs = issueRefs(root, config, input);
    const m = applyInput(existing, refs.input);
    const problems = [...refs.problems, ...mandateProblems(config, m, all, existing)];
    if (problems.length) throw refused(problems);
    return same(m, existing) ? null : { mandate: { ...m, updatedAt: now() }, action: 'edit' as MandateAction };
  });
  return written(root, id, out !== null);
}

function show(ctx: CliContext, id: string) {
  const { root, config } = ctx;
  const all = listMandates(root);
  const m = target(all, id);
  const { effective, capped } = effectiveContract(config, m);
  return {
    ...mandateSummary(m, all),
    effective,
    capped,
    ...mandateChain(m, all),
    jobs: mandateJobs(root, m.id),
    guidance: mandateGuidance(m),
    goal: mandateGoal(m),
    draft: m.goal === null ? null : (({ status, request }) => ({ status, request, gate: draftGate(root, config, m).status }))(draftStatus(root, config, m.id)),
    file: mandateFile(root, m.id),
  };
}

function listCmd(root: string) {
  const all = listMandates(root);
  return {
    mandates: all.map((m) =>
      isReadable(m)
        ? { id: m.id, title: m.title, status: m.status, state: mandateState(m, all), after: m.after, intake: m.goal !== null, ...mandateChain(m, all) }
        : { id: m.id, problem: m.problem },
    ),
  };
}

/** prepare and record: only the office session, or a person outside the daemon. Checked before anything is read. */
function officeOnly(action: string, env: NodeJS.ProcessEnv): { daemon: boolean } {
  const s = daemonScope(env);
  if ('problem' in s || (s.daemon && s.scope !== OFFICE_SCOPE)) {
    const scope = 'problem' in s ? oneLineTitle(env[SCOPE_ENV] ?? '').slice(0, 60) || 'unscoped' : s.scope;
    throw new ForgeError(`forge mandate draft ${action} runs in the office session or a person's own terminal, not the ${scope} session`, 1);
  }
  return { daemon: s.daemon };
}

/** assist: only an assistant foreman session, or a person outside the daemon. Checked before anything is read. */
function assistantOnly(env: NodeJS.ProcessEnv): void {
  const s = daemonScope(env);
  if ('problem' in s) throw new ForgeError(s.problem, 1);
  if (s.daemon && !inAssistant(env)) throw new ForgeError('forge mandate draft assist is for an assistant foreman session (or a person outside the daemon)', 1);
}

const DECISIONS = new Set(['approve', 'revise', 'reject']);

/** approve, revise and reject: one decideDraft call, as a person or (`--actor foreman`) as an assistant foreman. */
async function decide(ctx: CliContext, decision: DraftDecision, rest: string[], flags: Record<string, any>, env: NodeJS.ProcessEnv) {
  if (rest.length !== 2) throw usageError(MANDATE, `draft ${decision}`);
  const actor = str(flags.actor, '--actor');
  if (actor !== undefined && actor !== 'foreman') throw new ForgeError('--actor takes only foreman', 'usage');
  const foreman = actor === 'foreman';
  return decideDraft(ctx.root, ctx.config, rest[1], decision, {
    request: str(flags.request, '--request'),
    digest: str(flags.digest, '--digest'),
    note: flags.note === undefined ? undefined : flags.note === true ? '' : String(flags.note),
    foreman,
    actor: foreman ? FOREMAN_ACTOR : currentActor(ctx.root),
    tracker: () => loadTracker(ctx.root, ctx.config),
    env,
  });
}

/** The readable goal mandate `id` for `draft start|show`: not_found, or refused (exit 1) when it can't be read or has no goal. */
function goalMandate(root: string, id: string): Mandate {
  const m = target(listMandates(root), id);
  if (m.goal === null) throw new ForgeError(`mandate ${id} has no goal: drafts are for goal mandates (forge mandate new --goal)`, 1);
  return m;
}

/** `draft show`'s view of a goal mandate's draft and its milestone-approval gate. */
function draftView(ctx: CliContext, m: Mandate) {
  const { root, config } = ctx;
  return {
    mandate: m.id,
    title: m.title,
    ...draftStatus(root, config, m.id),
    gate: gateView(root, config, m).gate,
    spend: draftSpend(root, config, m.id),
    file: path.relative(root, draftFile(root, m.id)),
  };
}

async function draftCmd(ctx: CliContext, rest: string[], flags: Record<string, any>, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const { root, config } = ctx;
  const action = rest[0];
  if (action === 'start' && env.FORGE_DAEMON === '1')
    throw new ForgeError("forge mandate draft start writes the owner's instructions to the Office, which a daemon session may not do; run it in your own terminal", 1);
  // decideDraft refuses a daemon session without --actor foreman first, before anything is read.
  if (DECISIONS.has(action)) return decide(ctx, action as DraftDecision, rest, flags, env);
  if (action === 'assist') {
    assistantOnly(env);
    if (rest.length !== 2) throw usageError(MANDATE, 'draft assist');
    return assistDraft(root, config, rest[1], req(str(flags.request, '--request'), '--request'));
  }
  if (action === 'prepare' || action === 'record') {
    const { daemon } = officeOnly(action, env);
    if (rest.length !== 2) throw usageError(MANDATE, `draft ${action}`);
    const id = rest[1];
    const rid = req(str(flags.request, '--request'), '--request');
    const agentId = action === 'record' ? str(flags['agent-id'], '--agent-id') : undefined;
    if (agentId !== undefined && !AGENT_ID.test(agentId)) throw new ForgeError('--agent-id must match [A-Za-z0-9_-]{1,100}', 'usage');
    const bound = boundRequest(root, id, rid);
    const m = listMandates(root).find((x) => x.id === id);
    if (action === 'prepare') {
      const reason = staleReason(m, id);
      if (reason !== null) return { mandate: id, request: rid, stale: true, reason };
      return prepareDraft(root, config, m as Mandate, rid, await loadTracker(root, config), bound.args ?? {});
    }
    // A paused mandate is recorded: the run already happened.
    if (!m) throw new ForgeError(`no mandate ${id}`, 1);
    if (!isReadable(m)) throw new ForgeError(`mandate ${id} can't be read (${m.problem})`, 1);
    if (m.goal === null) throw new ForgeError(`mandate ${id} has no goal: drafts are for goal mandates (forge mandate new --goal)`, 1);
    if (m.status === 'closed') throw new ForgeError(`mandate ${id} is closed`, 1);
    if (m.filedAt !== null) throw new ForgeError(`mandate ${id}'s draft is filed`, 1);
    const recorded = recordDraft(root, config, m, rid, { agentId: agentId ?? null, metered: daemon });
    // After the draft is stored, and only then: a refused record queues no gate request and notifies no one.
    onDraftRecorded(root, config, m, { request: recorded.request, digest: recorded.digest });
    return recorded;
  }
  if (action !== 'start' && action !== 'show') throw usageError(MANDATE, 'draft');
  if (rest.length !== 2) throw usageError(MANDATE, `draft ${action}`);
  const m = goalMandate(root, rest[1]);
  if (action === 'show') return draftView(ctx, m);
  if (m.status !== 'active') throw new ForgeError(`mandate ${m.id} is ${m.status}`, 1);
  if (m.filedAt !== null) throw new ForgeError(`mandate ${m.id}'s draft is filed`, 1);
  return { ok: true, ...queueDraftRequest(root, m.id) };
}

export async function mandateCmd(ctx: CliContext, sub: string | undefined, rest: string[], flags: Record<string, unknown>): Promise<Dispatched> {
  // First, before the body or any mandate is read: a daemon session writes no mandate, whatever its scope.
  if (sub !== undefined && WRITES.has(sub) && process.env.FORGE_DAEMON === '1')
    throw new ForgeError(`forge mandate ${sub} writes the owner's instructions to the Office, which a daemon session may not do; run it in your own terminal`, 1);
  if (sub === 'draft') return { data: await draftCmd(ctx, rest, flags as Record<string, any>), exitCode: 0 };
  if (sub === 'list') {
    if (rest.length) throw usageError(MANDATE, sub);
    return { data: listCmd(ctx.root), exitCode: 0 };
  }
  if (sub === undefined || (!WRITES.has(sub) && sub !== 'show')) throw usageError(MANDATE);
  if (rest.length !== 1) throw usageError(MANDATE, sub);
  if (sub === 'edit' && (flags.goal !== undefined || flags['goal-file'] !== undefined)) throw new ForgeError('--goal is set only by forge mandate new', 'usage');
  const id = rest[0];
  if (sub === 'show') return { data: show(ctx, id), exitCode: 0 };
  return { data: write(ctx, sub, id, flags as Record<string, any>), exitCode: 0 };
}
