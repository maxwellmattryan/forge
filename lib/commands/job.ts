// `forge job …`: every write to a job's state goes through here.
import fs from 'node:fs';
import path from 'node:path';
import { jobAcs } from '../acs.ts';
import { assistantBrief, jobPathMap } from '../brief.ts';
import { budgetCmd, enforceBudget } from '../budget.ts';
import { OFFICE_REFUSAL, daemonClaimOpts, refuseInOffice, refuseInboxDrive } from '../daemon-owner.ts';
import { OFFICE_JOB_COMMANDS, checkForemanDecision, checkOfficeSetFor, gateClass, inOffice, isGateClass, maybeEnqueueGate, reservedFor } from '../foreman.ts';
import { claimRespectingDeps, refreshDependencyWait, validateDependsOn } from '../deps.ts';
import { agentOutputMissing, claimJob, createJob, ensureReviewDir, importCursor, isActive, listJobs, loadJob, logEvent, parseDecision, progress, recordAgent, releaseJob, resolveAgentOutput, roundVerdicts, setJob, setJobEffort, touchJob, updateJob, jobDir } from '../jobs.ts';
import { logSecrets, scanAgentOutputs } from '../secrets.ts';
import { normalizeRef } from '../issue-link.ts';
import { exists } from '../paths.ts';
import { COMPLEXITIES, EFFORTS, OFFICE_GATES } from '../schema.ts';
import { daemonScope } from '../requests.ts';
import { jobScope } from '../scope.ts';
import { loadStepInput, step } from '../step.ts';
import { createAndLink, linkJob, markNoIssue, suggestLink } from '../tracker-link.ts';
import { loadTracker } from '../trackers/index.ts';
import { importClaudeCodeTranscript } from '../usage.ts';
import { modelFor, resolveEffort } from '../config.ts';
import { ForgeError, coerce, getPath, run } from '../util.ts';
import { bodyFrom, list, num, oneOf, req, requireJob, str, usageError } from './args.ts';
import { mirrorToTracker, startFromRef } from './tracker.ts';
import type { AgentUsage, Config, Effort, HelpGroup, HumanActor, Job } from '../types.ts';

const NO_JOB: [1, string] = [1, 'no such job'];
const BODY: [string, string][] = [
  ['--body B', 'the text'],
  ['--body-file F', 'read the text from F (- for stdin)'],
];

// In the order `forge job` lists its subcommands. `advance` is routed by lib/cli.ts but documented here.
const JOB: HelpGroup = {
  name: 'job',
  summary: "one job's state, agents and reviews; forge job step <id> returns its next action",
  commands: [
    {
      command: 'job new',
      args: '--title T [--body B | --body-file F] [--session S] [options]',
      summary: 'create a job; with --session, claim it for that session (a split child, with --parent, starts unowned)',
      flags: [
        ['--title T', 'the title (required)'],
        ...BODY,
        ['--session S', 'claim the new job for session S'],
        ['--ref R', 'the tracker ref it came from'],
        ['--url U', "the tracker item's URL"],
        ['--tracker T', 'the tracker kind of --ref (default: tracker.kind)'],
        ['--kind K', 'feature, bug, …'],
        ['--slug S', 'the words its id starts with (default: from the title)'],
        ['--branch B', 'the branch to push to (default: git.branchPrefix + id)'],
        ['--parent ID', 'the umbrella job this one was split from'],
        ['--services a,b', 'the services it touches'],
        ['--effort E', "the job's reasoning effort: low, medium, high, xhigh or max (default: inherit runtime.effort)"],
      ],
      exits: [[1, 'an unsafe --branch, or --effort from a daemon session']],
    },
    {
      command: 'job from-ref',
      args: '<ref> [--session S]',
      summary: 'start (or find) the job for a tracker item, planned as one job, and claim the item for it',
      flags: [['--session S', 'claim the job for session S']],
      exits: [
        [1, 'no such tracker item'],
        [3, 'the tracker claim was lost to another job'],
        [5, 'gh failed (GitHub tracker)'],
      ],
    },
    {
      command: 'job link',
      args: '<id> <ref>|--create|--none [--reason R]|--suggest',
      summary: 'link a job to an issue, create one, or record that it needs none',
      flags: [
        ['--create', 'create an issue from the job and link it'],
        ['--none', 'record that the job needs no issue'],
        ['--reason R', 'why, with --none'],
        ['--suggest', 'list issues that look like this job, linking nothing'],
      ],
      exits: [
        [1, 'no such job or item, the job or item is already linked, or tracker.kind is none'],
        [3, 'the tracker claim was lost to another job'],
        [5, 'gh failed (GitHub tracker)'],
      ],
      docs: ['Linking jobs to issues', 'docs/TRACKERS.md#linking-jobs-to-issues'],
      readme: true,
    },
    { command: 'job list', args: '[--all]', summary: 'active jobs, one object each', flags: [['--all', 'include finished and cancelled jobs']] },
    { command: 'job show', args: '<id> [--full]', summary: 'one job, compact (the whole job.json with --full)', flags: [['--full', 'print the whole job.json']], exits: [NO_JOB] },
    { command: 'job get', args: '<id> [path]', summary: 'one value of job.json by dotted path (null when absent)', exits: [NO_JOB] },
    {
      command: 'job set',
      args: '<id> [--stage S] [--state S] [--waiting-on W|none] [--reason R] [--note N] [--field key=value]...',
      summary: "change a job's stage, state or fields; every check runs before anything is written",
      flags: [
        ['--stage S', 'the pipeline stage'],
        ['--state S', 'queued, running, waiting, blocked, failed, cancelled or done'],
        ['--waiting-on W', 'what a waiting job waits on (none clears it)'],
        ['--reason R', 'why, shown with the state'],
        ['--note N', 'a note logged with the change'],
        ['--field key=value', 'set a field (values are JSON or plain words; repeatable)'],
      ],
      exits: [[1, 'no such job, a field set only by another command, a list field that is not a JSON array of strings, or an unknown or cyclic dependency']],
    },
    {
      command: 'job effort',
      args: '<id> low|medium|high|xhigh|max | --inherit',
      summary: "set a job's reasoning effort (forge job new --effort sets it at creation), or clear it so the job inherits runtime.effort; daemon sessions start with --effort and every agent gets it",
      flags: [['--inherit', "clear the job's effort"]],
      exits: [[1, 'no such job, or a daemon session']],
      docs: ['Effort', 'docs/CONFIG.md#effort'],
      readme: true,
    },
    {
      command: 'job claim',
      args: '<id> --session S [--force]',
      summary: 'claim a job for a session',
      flags: [
        ['--session S', 'the claiming session (required)'],
        ['--force', 'take it from a live owner, or claim it with dependencies not done'],
      ],
      exits: [[1, 'no such job, or the office daemon session ran it'], [3, 'another live session holds the job'], [4, 'its dependencies are not done']],
    },
    { command: 'job release', args: '<id>', summary: "drop the job's owner", exits: [NO_JOB] },
    { command: 'job note', args: '<id> [text] [--body B | --body-file F]', summary: 'log a note event', flags: BODY, exits: [NO_JOB] },
    {
      command: 'job human',
      args: '<id> <action> [--note N] [--link <ref>|new|none] [--reason R] [--actor human|foreman]',
      summary: 'record a human decision: approve-spec, revise-spec, approve-split, revise-split, approve, rework or answer',
      flags: [
        ['--note N', 'the human\'s note'],
        ['--link <ref>|new|none', 'with approve or approve-spec: link an issue, create one, or record that none is needed'],
        ['--reason R', 'why, with --link none'],
        ['--actor human|foreman', 'who decided (default human); foreman only from the office daemon session, which must pass it'],
      ],
      exits: [
        [1, 'no such job, a --link that cannot be made, or a foreman decision the authority checks refuse'],
        [3, 'the tracker claim was lost to another job'],
        [5, 'gh failed (GitHub tracker)'],
      ],
    },
    {
      command: 'job assist',
      args: '<id> --gate G',
      summary: "the office session's forge:assistant spawn for a gate: model, effort and a brief of paths only; stale when the job no longer waits there. Read-only",
      flags: [['--gate G', `the gate class: ${OFFICE_GATES.join(', ')}`]],
      exits: [[1, 'no such job, an unknown gate, or a daemon session other than the office']],
    },
    {
      command: 'job agent',
      args: '<id> start|end --role R [options]',
      summary: 'record an agent starting or ending, with its usage; end also scans what the agent wrote for likely secrets (a secret-found event and secrets: <n>, never a refusal)',
      flags: [
        ['--role R', 'the role, e.g. builder or reviewer:code (required)'],
        ['--model M', 'the model it ran on'],
        ['--agent-id A', "the runtime's id for the agent"],
        ['--status S', 'how it ended'],
        ['--summary S', 'its one-line reply'],
        ['--output P', 'with start: the file it must write, inside the job dir'],
        ['--retry', 'with start: a retry of a lost agent'],
        ['--tokens N', 'with end: tokens used'],
        ['--tool-uses N', 'with end: tool calls made'],
        ['--duration-ms N', 'with end: wall time'],
        ['--import', "with end and --agent-id: read usage from the agent's Claude Code transcript"],
      ],
      exits: [[1, 'no such job, an --output outside the job dir, or the inbox or office session starting an agent']],
    },
    { command: 'job round', args: '<id>', summary: 'start the next review round, unless the budget is spent', exits: [NO_JOB] },
    {
      command: 'job budget',
      args: '<id> [--set key=value,...] [--ack]',
      summary: "the job's budget limits and use",
      flags: [
        ['--set key=value', 'set a limit: tokens, usd, minutes, changedLines or verifyRetries (default restores the configured one)'],
        ['--ack', 'accept the limits now exceeded, so the job goes on'],
      ],
      exits: [[1, 'no such job, or an unknown budget key or bad value']],
    },
    {
      command: 'job verdicts',
      args: '<id> [--round N|integration] [--reviewers a,b] [--malformed changes] [--compact]',
      summary: "read a round's review files and record their verdicts once all are in",
      flags: [
        ['--round N', 'the round (default: the current one), or integration'],
        ['--reviewers a,b', 'the lenses to read (default: the job\'s reviewers)'],
        ['--malformed changes', 'count a malformed review as CHANGES'],
        ['--compact', 'one verdict per lens, and the missing files'],
      ],
      exits: [[1, 'no such job, or no reviewers selected']],
    },
    { command: 'job decision', args: '<id>', summary: "read decision.md and record the approver's decision", exits: [NO_JOB] },
    { command: 'job progress', args: '<id>', summary: 'tasks done and total in tasks.md', exits: [NO_JOB] },
    { command: 'job paths', args: '<id>', summary: "absolute paths of the job's files, for agent briefs", exits: [NO_JOB] },
    {
      command: 'job scope',
      args: '<id>',
      summary: "files the branch changed outside the spec's Approach",
      exits: [
        [1, 'no such job, no worktree or no spec.md'],
        [5, 'git failed'],
      ],
    },
    { command: 'job acs', args: '<id>', summary: "the spec's acceptance criteria and their proof in build.md", exits: [NO_JOB] },
    {
      command: 'job step',
      args: '<id> [--session S]',
      summary: "the job's next action (`spawn` with a ready agent brief, `run`, `wait`, `procedure` or `done`); read-only, the same state always gives the same answer, except that `--session <owner>` refreshes that session's claim heartbeat",
      flags: [['--session S', "refresh session S's claim heartbeat, when S owns the job"]],
      exits: [NO_JOB],
      readme: true,
    },
    {
      command: 'job advance',
      args: '<id> --session S [--max N]',
      summary: "runs step's `run` actions in-process (at most N, default 20) and returns the next `spawn`, `wait`, `procedure` or `done` with `ran`, one line per command it ran; refuses (exit 3) a job session S does not hold, and stops at the first failed command (exit 1)",
      flags: [
        ['--session S', 'the session driving the job (required)'],
        ['--max N', 'run at most N commands (default 20)'],
      ],
      exits: [
        [1, 'no such job, or a command it ran failed (the result says which)'],
        [3, 'session S does not hold the job'],
      ],
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [JOB];

// Effort is the human's control over how much a job costs: a session misled by request text must
// not raise its own job's, or another's, past what the human chose.
const EFFORT_DAEMON_REFUSAL =
  "forge job effort sets how hard a job's sessions and agents think, which a daemon session may not change; a human sets it from the dashboard or their own session";
const refuseEffortInDaemon = () => {
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(EFFORT_DAEMON_REFUSAL);
};

// `forge stats` and `forge job step` read these from `human` events, so an invented action is refused.
const HUMAN_ACTIONS = ['approve-spec', 'revise-spec', 'approve-split', 'revise-split', 'approve', 'rework', 'answer'] as const;

// List fields `step`, the briefs and the dashboard iterate; each maps to the example its error shows.
const ARRAY_FIELDS: Record<string, string> = { reviewers: '["code","tests"]', services: '["api"]', dependsOn: '["<job id>"]', children: '["<job id>"]' };

// A job's identity: what it pushes to, where it lives and who owns it. A session misled by request
// text could otherwise run `--field branch=main` and have `forge pr open` push there, so only the
// command that owns each key may write it. Each maps to that command, for the error.
const LOCKED_FIELDS: Record<string, string> = {
  id: 'forge job new',
  createdAt: 'forge job new',
  branch: 'forge job new --branch',
  base: 'forge worktree create or forge sync',
  worktree: 'forge worktree create|remove',
  port: 'forge worktree create|remove',
  owner: 'forge job claim|release',
  runs: 'forge job claim|release',
  source: 'forge job link',
  pr: 'forge pr find|open|sync',
  schemaVersion: 'forge migrate',
  usage: 'forge job agent',
  effort: 'forge job effort',
};

// setPath walks these into Object.prototype.
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The result is printed as JSON. */
export async function jobCmd(root: string, config: Config, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<unknown> {
  const id = rest[0];
  // The office decides gates and does nothing else: an allowlist, so a new subcommand starts out refused there.
  if (inOffice() && !OFFICE_JOB_COMMANDS.includes(String(sub))) throw new ForgeError(`${OFFICE_REFUSAL}; forge job ${String(sub).slice(0, 40)} is not available in the office session`, 1);
  switch (sub) {
    case 'new': {
      // Read before createJob, so a bare --session fails instead of claiming as session "true".
      const session = str(flags.session, '--session');
      let effort: Effort | undefined;
      if (flags.effort !== undefined) {
        refuseEffortInDaemon();
        effort = oneOf(str(flags.effort, '--effort'), EFFORTS, 'effort');
      }
      const job = createJob(root, config, {
        title: req(flags.title, '--title'),
        ref: flags.ref,
        url: flags.url,
        tracker: flags.tracker,
        body: bodyFrom(flags),
        parent: flags.parent,
        branch: flags.branch,
        kind: flags.kind,
        slug: flags.slug,
        services: list(flags.services),
        effort,
      });
      // A split child starts unowned: the session claims each child only when it runs it.
      if (session && !flags.parent) claimJob(root, job.id, session, false, daemonClaimOpts(root, job.id));
      return { id: job.id, branch: job.branch, dir: path.relative(root, jobDir(root, job.id)) };
    }
    case 'link': {
      const jobId = req(id, 'job id');
      const ref = rest[1];
      const modes = [ref !== undefined, flags.create === true, flags.none === true, flags.suggest === true].filter(Boolean).length;
      if (modes !== 1) throw usageError(JOB, 'link');
      if (flags.suggest) return suggestLink(root, config, jobId, () => loadTracker(root, config));
      if (flags.none) return markNoIssue(root, jobId, typeof flags.reason === 'string' ? flags.reason : null);
      const tracker = await loadTracker(root, config);
      return flags.create ? createAndLink(root, config, tracker, jobId) : linkJob(root, config, tracker, jobId, ref!);
    }
    case 'from-ref': {
      const tracker = await loadTracker(root, config);
      // An issue the human picked is planned as one job, whatever pipeline.split says.
      return startFromRef(root, config, tracker, req(id, 'tracker ref'), flags, { splitMode: 'never' });
    }
    case 'list': {
      const jobs = listJobs(root).filter((j) => (flags.all ? true : isActive(j)));
      return jobs.map((j) => ({ id: j.id, title: j.title, stage: j.stage, state: j.state, waitingOn: j.waitingOn, round: j.round, pr: j.pr?.number ?? null, owner: j.owner?.session ?? null, effort: j.effort }));
    }
    case 'show': {
      const job = loadJob(root, req(id, 'job id'));
      return flags.full ? job : compactJob(root, job);
    }
    case 'get':
      return getPath(loadJob(root, req(id, 'job id')), rest[1] ?? '') ?? null;
    case 'effort': {
      refuseEffortInDaemon();
      const jobId = requireJob(root, id).id;
      const level = rest[1];
      if ((level !== undefined) === (flags.inherit === true) || rest.length > 2) throw usageError(JOB, 'effort');
      return setJobEffort(root, jobId, level === undefined ? null : oneOf(level, EFFORTS, 'effort'), 'cli');
    }
    case 'set': {
      const jobId = requireJob(root, id).id;
      const note = str(flags.note, '--note');
      const fields: Record<string, any> = {};
      for (const kv of flags.field === undefined || flags.field === true ? [] : ([] as unknown[]).concat(flags.field).map(String)) {
        const eq = kv.indexOf('=');
        if (eq < 1) throw new ForgeError(`--field expects key=value, got "${kv}"`, 'usage');
        const key = kv.slice(0, eq);
        // Checked before coerce, so `owner={}` gets the lock message rather than a JSON error.
        const segments = key.split('.');
        if (segments.some((s) => PROTO_KEYS.has(s))) throw new ForgeError(`--field ${key}: __proto__, constructor and prototype are not field names`);
        if (Object.hasOwn(LOCKED_FIELDS, segments[0])) throw new ForgeError(`--field ${segments[0]} is not settable; use ${LOCKED_FIELDS[segments[0]]}`);
        fields[key] = coerce(kv.slice(eq + 1), key);
      }
      for (const [key, example] of Object.entries(ARRAY_FIELDS)) {
        const v = fields[key];
        if (key in fields && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw new ForgeError(`--field ${key} must be a JSON array of strings, e.g. --field '${key}=${example}'`);
      }
      // complexity picks among levels a human configured, so only the three values (or none) are accepted.
      for (const key of Object.keys(fields))
        if (key.split('.')[0] === 'complexity' && (key !== 'complexity' || !(fields[key] === null || (COMPLEXITIES as readonly unknown[]).includes(fields[key]))))
          throw new ForgeError('--field complexity must be low, medium or high, or null');
      // Checked before anything is written, so a bad list leaves job.json untouched.
      const before = loadJob(root, jobId);
      const waitingOn = flags['waiting-on'] === undefined ? undefined : flags['waiting-on'] === 'none' ? null : flags['waiting-on'];
      if (inOffice()) checkOfficeSetFor(root, before, { stage: flags.stage, state: flags.state, waitingOn, reason: flags.reason, fields });
      if ('dependsOn' in fields) fields.dependsOn = validateDependsOn(root, jobId, fields.dependsOn);
      let job = setJob(root, jobId, {
        stage: flags.stage,
        state: flags.state,
        waitingOn,
        reason: flags.reason,
        note,
        fields,
      });
      if ('dependsOn' in fields) {
        refreshDependencyWait(root, job.id);
        job = loadJob(root, job.id);
      }
      const gate = maybeEnqueueGate(root, config, before, job);
      await mirrorToTracker(root, config, job);
      return { id: job.id, stage: job.stage, state: job.state, waitingOn: job.waitingOn, ...(gate ? { gateRequest: gate.id } : {}) };
    }
    case 'claim': {
      const jobId = requireJob(root, id).id;
      refuseInOffice(`it never claims ${jobId}`);
      const { job, overridden } = claimRespectingDeps(root, jobId, req(str(flags.session, '--session'), '--session'), Boolean(flags.force), daemonClaimOpts(root, jobId));
      return { id: job.id, owner: job.owner, ...(overridden.length ? { dependenciesOverridden: overridden } : {}) };
    }
    case 'release': {
      const jobId = requireJob(root, id).id;
      releaseJob(root, jobId);
      return { id: jobId, released: true };
    }
    case 'note':
      logEvent(root, requireJob(root, id).id, 'note', { text: rest.slice(1).join(' ') || bodyFrom(flags) });
      return { ok: true };
    case 'human': {
      const job = requireJob(root, id);
      const jobId = job.id;
      const action = oneOf(rest[1], HUMAN_ACTIONS, 'action');
      const note = str(flags.note, '--note');
      const actor: HumanActor = flags.actor === undefined ? 'human' : oneOf(str(flags.actor, '--actor'), ['human', 'foreman'] as const, 'actor');
      // The office session records only foreman decisions, and only it may: provenance is the
      // daemon scope, so a job session misled by request text can't pass off a decision as the foreman's.
      if (inOffice() && actor !== 'foreman') throw new ForgeError('the office session records decisions only with --actor foreman', 1);
      if (actor === 'foreman') checkForemanDecision(root, config, job, action, note, { link: flags.link, reason: flags.reason });
      // Every check runs before any write, so a refused --link leaves job.json and events untouched.
      const link = flags.link;
      if (link !== undefined && (typeof link !== 'string' || !link.trim())) throw new ForgeError('--link needs <ref>, new or none');
      if (link !== undefined && action !== 'approve-spec' && action !== 'approve') throw new ForgeError('--link is only for approve and approve-spec');
      // Re-validated here, not only in the orchestrator: the value can come from request or dashboard text.
      if (typeof link === 'string' && link !== 'new' && link !== 'none' && !normalizeRef(link)) throw new ForgeError(`invalid ref ${JSON.stringify(link.slice(0, 100))}`);
      const reason = str(flags.reason, '--reason');
      if (reason !== undefined && link !== 'none') throw new ForgeError('--reason is only for --link none');
      // A rejected split re-plans as one job; recorded before the event so step never sees one without the other.
      if (action === 'revise-split') setJob(root, jobId, { fields: { splitMode: 'never' } });
      // The link goes first: if it throws, no approval is recorded and the job keeps waiting.
      let linked: unknown;
      if (link === 'none') linked = markNoIssue(root, jobId, reason ?? null);
      else if (link === 'new') linked = createAndLink(root, config, await loadTracker(root, config), jobId);
      else if (typeof link === 'string') linked = linkJob(root, config, await loadTracker(root, config), jobId, link);
      logEvent(root, jobId, 'human', { action, note: note ?? (rest.slice(2).join(' ') || null), actor });
      return { ok: true, ...(link !== undefined ? { link: linked } : {}) };
    }
    case 'assist':
      return assist(root, config, requireJob(root, id), flags.gate);
    case 'agent': {
      const jobId = requireJob(root, id).id;
      const phase = req(rest[1], 'start|end');
      if (!['start', 'end'].includes(phase)) throw new ForgeError('phase must be start or end', 'usage');
      const role = req(flags.role, '--role');
      // Validated before anything is written, so a bad count leaves job.json and its usage untouched.
      const summary = str(flags.summary, '--summary');
      const tokens = num(flags.tokens, '--tokens');
      const toolUses = num(flags['tool-uses'], '--tool-uses');
      const durationMs = num(flags['duration-ms'], '--duration-ms');
      // `end` stays allowed, so a stray start can still be closed.
      if (phase === 'start') refuseInboxDrive(jobId);
      let usage: (AgentUsage & { transcript?: string; through?: string | null }) | undefined;
      let since: string | null = null;
      let output: string | null = null;
      let outputMissing: boolean | null = null;
      if (phase === 'start' && flags.output !== undefined) {
        if (typeof flags.output !== 'string' || !flags.output) throw new ForgeError('--output needs a path');
        // Resolved and checked before anything is written, so a refused path leaves no trace.
        output = resolveAgentOutput(root, jobId, flags.output);
        fs.mkdirSync(path.dirname(path.join(jobDir(root, jobId), output)), { recursive: true });
      }
      let secrets = 0;
      if (phase === 'end') {
        const before = loadJob(root, jobId);
        outputMissing = agentOutputMissing(root, before.id, role, before.agents[role], summary);
        // Detection only: what the agent wrote stays in the job dir, but a human sees the note.
        const scan = scanAgentOutputs(root, config, before, role);
        logSecrets(root, before.id, 'agent-end', scan, { blocked: false, role });
        secrets = scan.findings.length;
        if (flags.import && flags['agent-id']) {
          since = importCursor(before, String(flags['agent-id']));
          usage = importClaudeCodeTranscript(String(flags['agent-id']), { since }) ?? undefined;
        }
        if (!usage && (tokens !== undefined || toolUses !== undefined || durationMs !== undefined)) usage = { totalTokens: tokens ?? 0, toolUses: toolUses ?? 0, durationMs: durationMs ?? 0 };
        if (usage && !usage.toolUses && toolUses) usage.toolUses = toolUses;
      }
      const job = recordAgent(
        root,
        jobId,
        {
          role,
          phase: phase as 'start' | 'end',
          model: flags.model ?? usage?.model ?? undefined,
          agentId: flags['agent-id'],
          status: flags.status,
          summary,
          // The transcript's path and cursor are set to undefined, so the usage job.json records is
          // only token counts; the cursor goes to the agent record instead.
          usage: usage ? ({ ...usage, transcript: undefined, through: undefined } as AgentUsage) : undefined,
          importedThrough: usage?.through,
          ...(phase === 'start' ? { output, retry: flags.retry === true } : {}),
          ...(outputMissing !== null ? { outputMissing } : {}),
        },
        config,
      );
      const a = job.agents[role];
      const budget = phase === 'end' ? enforceBudget(root, config, job.id, 'agent-end') : null;
      return { role, status: a.status, model: a.model, usage: usage ? { tokens: usage.totalTokens, exact: Boolean(usage.exact), ...(since && usage.transcript ? { since } : {}) } : null, jobTokens: job.usage.totalTokens, jobCostUsd: job.usage.estCostUsd, ...(outputMissing !== null ? { outputMissing } : {}), ...(secrets ? { secrets } : {}), ...(budget ? { budget } : {}) };
    }
    case 'round': {
      // Checked before incrementing, so after approval re-running `forge job round` starts the round.
      const budget = enforceBudget(root, config, req(id, 'job id'), 'round');
      if (budget) {
        const j = loadJob(root, String(id));
        return { round: j.round, maxRounds: j.maxRounds, exhausted: j.round > j.maxRounds, budget };
      }
      const job = updateJob(root, String(id), (j) => {
        j.round += 1;
      });
      ensureReviewDir(root, job.id, job.round);
      logEvent(root, job.id, 'round', { round: job.round });
      return { round: job.round, maxRounds: job.maxRounds, exhausted: job.round > job.maxRounds };
    }
    case 'verdicts': {
      const job = loadJob(root, req(id, 'job id'));
      // The integration review is a mini round after conflict resolution; it is logged as an
      // event only, because stats, retro and the dashboard read job.verdicts keys as numbers.
      const integration = flags.round === 'integration';
      if (flags.round !== undefined && !integration && !/^[1-9]\d*$/.test(String(flags.round))) throw new ForgeError('--round must be a positive integer or "integration"', 'usage');
      const round: number | 'integration' = integration ? 'integration' : Number(flags.round ?? job.round);
      const reviewers = list(flags.reviewers).length ? list(flags.reviewers) : integration ? ['code'] : job.reviewers;
      if (!reviewers.length) throw new ForgeError(`job ${id} has no reviewers selected; set them with: forge job set ${id} --field reviewers='["code","tests"]'`);
      if (flags.malformed !== undefined && flags.malformed !== 'changes') throw new ForgeError('--malformed accepts only "changes"', 'usage');
      const v = roundVerdicts(root, job.id, round, reviewers, config.review.blockOn, { malformedAs: flags.malformed });
      // The sha reviewers saw is evidence; it tells a later reader whether the review is still current.
      const sha = job.worktree && exists(job.worktree) ? run('git', ['rev-parse', 'HEAD'], { cwd: job.worktree, allowFail: true }).stdout.trim() || null : null;
      if (v.complete) {
        const verdicts = Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict]));
        const coerced = Object.entries(v.reviewers).filter(([, r]) => r.coerced).map(([k]) => k);
        if (integration) logEvent(root, job.id, 'integration-review', { outcome: v.outcome, sha, reviewers: verdicts, coerced: coerced.length ? coerced : undefined });
        else {
          setJob(root, job.id, { fields: { [`verdicts.${round}`]: verdicts } });
          logEvent(root, job.id, 'verdicts', { round, outcome: v.outcome, sha, coerced: coerced.length ? coerced : undefined });
        }
        if (coerced.length) logEvent(root, job.id, 'note', { text: `${integration ? 'integration review' : `round ${round}`}: malformed review(s) from ${coerced.join(', ')} counted as CHANGES` });
      }
      if (flags.compact) {
        // Absolute paths, so the orchestrator can hand a re-spawned reviewer its output verbatim.
        const missing = Object.fromEntries(Object.entries(v.reviewers).filter(([, r]) => r.verdict === 'MISSING').map(([k, r]) => [k, r.path]));
        const reviewers = Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict === 'CHANGES' ? `CHANGES(${r.blocking})` : r.verdict]));
        return { round, complete: v.complete, outcome: v.outcome, sha, reviewers, ...(Object.keys(missing).length ? { missing } : {}) };
      }
      return { ...v, sha };
    }
    case 'decision': {
      const jobId = requireJob(root, id).id;
      const d = parseDecision(root, jobId);
      if (d.decision) {
        setJob(root, jobId, { fields: { decision: d.decision } });
        logEvent(root, jobId, 'decision', d);
      }
      return d;
    }
    case 'budget':
      return budgetCmd(root, config, req(id, 'job id'), { set: list(flags.set), ack: Boolean(flags.ack) });
    case 'progress':
      return progress(root, requireJob(root, id).id);
    case 'paths':
      return jobPaths(root, config, loadJob(root, req(id, 'job id')));
    case 'scope':
      return jobScope(root, config, req(id, 'job id'));
    case 'acs':
      return jobAcs(root, req(id, 'job id'));
    case 'step': {
      const jobId = loadJob(root, req(id, 'job id')).id;
      // The loop's heartbeat: only the owner's own step refreshes its claim, and nothing else changes.
      const session = str(flags.session, '--session');
      if (session !== undefined) touchJob(root, jobId, session);
      return step(loadStepInput(root, config, jobId));
    }
    default:
      throw usageError(JOB);
  }
}

/**
 * `forge job assist`: what the office session spawns for one gate. Read-only. `stale` when the job
 * no longer waits on that gate (someone acted meanwhile); `reserved` is re-checked now, not taken
 * from the request.
 */
function assist(root: string, config: Config, job: Job, rawGate: unknown) {
  const s = daemonScope();
  if ('problem' in s) throw new ForgeError(s.problem);
  if (s.daemon && !inOffice()) throw new ForgeError('forge job assist is for the office session (or a human outside the daemon)', 1);
  const gate = str(rawGate, '--gate');
  if (!isGateClass(gate)) throw new ForgeError(`--gate must be one of ${OFFICE_GATES.join(', ')} (got ${JSON.stringify(String(gate ?? '').slice(0, 40))})`, 1);
  const stale = gateClass(job) !== gate;
  const reserved = stale ? null : reservedFor(root, config, job, gate);
  return {
    gate,
    stale,
    reserved,
    model: modelFor(config, 'assistant'),
    effort: resolveEffort(config, job, 'assistant').level,
    subagent: 'forge:assistant',
    brief: assistantBrief(root, config, job, gate, config.foreman?.reserved),
  };
}

/**
 * Absolute paths an agent prompt needs, so the orchestrator can hand them over verbatim.
 * The review directories are created here, before any reviewer is briefed with them.
 */
export function jobPaths(root: string, config: Config, job: Job): Record<string, unknown> {
  ensureReviewDir(root, job.id, Math.max(job.round, 1));
  ensureReviewDir(root, job.id, 'integration');
  return jobPathMap(root, config, job);
}

/** The job as `forge job show` prints it without --full. */
export function compactJob(root: string, job: Job): Record<string, unknown> {
  const lastVerify = job.verifyRuns[job.verifyRuns.length - 1] ?? null;
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    stage: job.stage,
    state: job.state,
    waitingOn: job.waitingOn,
    reason: job.reason,
    round: job.round,
    maxRounds: job.maxRounds,
    reviewers: job.reviewers,
    lastVerdicts: job.verdicts[job.round] ?? null,
    verify: job.verify[job.round] ?? null,
    verified: lastVerify ? { round: lastVerify.round, attempt: lastVerify.attempt, ok: lastVerify.ok, sha: lastVerify.sha } : null,
    decision: job.decision,
    branch: job.branch,
    base: job.base,
    worktree: job.worktree,
    port: job.port,
    pr: job.pr ? { number: job.pr.number, url: job.pr.url, state: job.pr.state, checks: job.pr.checks?.state, behindBy: job.pr.behindBy, conflicts: job.pr.conflicts, unresolvedThreads: job.pr.unresolvedThreads } : null,
    source: job.source,
    noIssue: job.noIssue,
    effort: job.effort,
    owner: job.owner?.session ?? null,
    progress: progress(root, job.id),
    tokens: job.usage.totalTokens,
    estCostUsd: job.usage.estCostUsd,
  };
}
