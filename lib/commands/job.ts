// `forge job …`: every write to a job's state goes through here.
import fs from 'node:fs';
import path from 'node:path';
import { jobAcs } from '../acs.ts';
import { jobFindings } from '../findings.ts';
import { assistantBrief, jobPathMap } from '../brief.ts';
import { budgetCmd, enforceBudget } from '../budget.ts';
import { OFFICE_REFUSAL, daemonClaimOpts, refuseInOffice, refuseInboxDrive } from '../daemon-owner.ts';
import { OFFICE_JOB_COMMANDS, checkForemanDecision, classReservation, checkOfficeSetFor, gateClassFor, inOffice, isGateClass, maybeEnqueueGate, reservedFor } from '../foreman.ts';
import { claimRespectingDeps, refreshDependencyWait, validateDependsOn } from '../deps.ts';
import { agentOutputMissing, attachAgent, claimJob, createJob, ownerStatus, ensureReviewDir, importCursor, isActive, listJobs, loadJob, logEvent, logHumanEvent, parseDecision, progress, recordAgent, releaseJob, resolveAgentOutput, roundVerdicts, setJob, setJobEffort, touchJob, updateJob, jobDir, readEvents } from '../jobs.ts';
import { logSecrets, scanAgentOutputs } from '../secrets.ts';
import { issueLinkStatus } from '../issue-link.ts';
import { checkIssueRef, isSafeUrl, issueUrl } from '../issue-ref.ts';
import { githubHost, localRepoSlug } from '../repo-slug.ts';
import { exists } from '../paths.ts';
import { addJobRepo, refuseInterimInDaemon, refuseJobRepoInDaemon, removeJobRepo, trustedMemberWorktree } from '../job-repos.ts';
import { decideRepoProposals, pendingRepoProposals, proposeJobRepo } from '../repo-proposals.ts';
import { addDownstreamRepos } from '../downstream.ts';
import { RELEASE_DAEMON_REFUSAL, interimStatus, publishCanary, recordRelease, setRepoInterim } from '../interim-apply.ts';
import { releaseGates } from '../interim.ts';
import { RELEASE_APPROVAL, checkReleaseDecision, pendingReleaseHash } from '../release-approval.ts';
import { isLens, lensRepoAllowed, reviewedRepoNames } from '../lens.ts';
import { resolveLinks } from '../links.ts';
import { COMPLEXITIES, EFFORTS, OFFICE_GATES } from '../schema.ts';
import { daemonScope } from '../requests.ts';
import { jobPanel } from '../panel.ts';
import { jobScope } from '../scope.ts';
import { loadStepInput, step } from '../step.ts';
import { createAndLink, linkJob, markNoIssue, suggestLink, unlinkJob } from '../tracker-link.ts';
import { loadTracker } from '../trackers/index.ts';
import { AGENT_ID } from '../transcripts.ts';
import { importClaudeCodeTranscript } from '../usage.ts';
import { modelFor, resolveEffort } from '../config.ts';
import { ForgeError, coerce, getPath, run } from '../util.ts';
import { bodyFrom, list, num, oneOf, req, requireJob, str, usageError } from './args.ts';
import { mirrorToTracker, startFromRef } from './tracker.ts';
import { archiveJob, archiveOlder, prune } from '../retention.ts';
import type { AgentUsage, ArchiveResult, Config, Effort, HelpGroup, Job, JobIssue } from '../types.ts';
import { FOREMAN_ACTOR, currentActor } from '../actor.ts';
import { jobAudit, toCsv } from '../audit.ts';
import { checkRepoBudget, isRepoHold, parkForRepoBudget, repoBudgetBlock, repoBudgetExempt } from '../repo-budget.ts';

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
        ['--issue R', 'an issue to record, in order, the first one primary: #12, owner/repo#12, KEY-123 or a backlog ref (repeatable, or comma-separated; no tracker call)'],
        ['--ref R', 'the one tracker ref it came from (not with --issue)'],
        ['--url U', "the tracker item's URL, with --ref"],
        ['--tracker T', 'the tracker kind of --ref or --issue (default: tracker.kind)'],
        ['--no-issue', 'record that the job needs no issue (not with --issue or --ref)'],
        ['--reason R', 'why, with --no-issue'],
        ['--kind K', 'feature, bug, …'],
        ['--slug S', 'the words its id starts with (default: from the title)'],
        ['--branch B', 'the branch to push to (default: git.branchPrefix + id)'],
        ['--parent ID', 'the umbrella job this one was split from'],
        ['--services a,b', 'the services it touches'],
        ['--effort E', "the job's reasoning effort: low, medium, high, xhigh or max (default: inherit runtime.effort)"],
        ['--force', 'start it past an exceeded repo budget (budget:), logged as a budget-override; a human only'],
      ],
      exits: [[1, 'an unsafe --branch or ref, --no-issue with tracker.kind none, or --effort or --force from a daemon session']],
    },
    {
      command: 'job from-ref',
      args: '<ref> [--session S]',
      summary: "start (or find) the job for a tracker item (#12, 12 or this repo's owner/repo#12, or owner/name#N from a member repo's tracker, which starts the job with that member as a job repo), planned as one job, and claim the item for it",
      flags: [['--session S', 'claim the job for session S']],
      exits: [
        [1, "no such tracker item, an issue outside this repo and its member repos' trackers, or a member clone that fails doctor's check"],
        [3, 'the tracker claim was lost to another job'],
        [4, 'the repo budget holds new work'],
        [5, 'gh failed (GitHub tracker)'],
      ],
    },
    {
      command: 'job link',
      args: '<id> <ref>…|--remove <ref>|--create|--none [--reason R]|--suggest',
      summary: "add issues to a job (this repo's are checked and claimed, other repos' only recorded), remove them, create one, or record that it needs none",
      flags: [
        ['--remove R', 'remove an issue from the job; the tracker claim stays (repeatable, or comma-separated)'],
        ['--create', 'create an issue from the job and add it'],
        ['--none', 'record that the job needs no issue'],
        ['--reason R', 'why, with --none'],
        ['--suggest', 'list issues that look like this job, linking nothing'],
      ],
      exits: [
        [1, 'no such job or item, an invalid ref, a ref the job does not carry, --none on a linked job, or tracker.kind is none'],
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
      exits: [[1, 'no such job, or the office daemon session ran it'], [3, 'another live session holds the job'], [4, 'dependencies pending, or the repo budget holds new work']],
    },
    { command: 'job release', args: '<id>', summary: "drop the job's owner", exits: [NO_JOB] },
    {
      command: 'job repo',
      args: 'add <id> <name> [--verify-only] | remove <id> <name> | propose <id> <name> --reason R | downstream <id> | interim <id> (<name> | --root) canary|git-ref|local|sequential|inherit',
      summary:
        "add a member repo (a config repos entry whose clone passes doctor's check) to a job, which then gets its own worktree, verify evidence and PR on the job's branch; remove drops one that has no PR and no worktree left; interim sets one job repo's interim strategy as a dependency (what a consumer's PR points at while it is unmerged: docs/CONFIG.md \"Interim strategies\"), overriding release.interim, and inherit clears it (add, remove and interim are human-only). propose records an agent's proposal of a repos entry with its reason in repo-proposals.md; the job then waits until a human, or the foreman when allowed, runs forge job human <id> approve-repos|reject-repos (approving a verify-only member promotes it to an edited one). downstream adds the changed repos' linked consumers as verify-only repos, so verify runs their tests against the job's changes, and prints what it added and skipped with each reason (docs/CONFIG.md \"Downstream verification\"); it takes no repo name, and the job's own session may run it",
      flags: [
        ['--verify-only', 'with add: verify the repo at its base with the job, but give it no branch, push or PR'],
        ['--reason R', 'with propose: what changes in that repo and which component needs it (at most 200 characters)'],
        ['--root', 'with interim: the root repo instead of a member'],
      ],
      exits: [
        [
          1,
          'no such job, a done job or one at stage pr, an unknown or duplicate repo, a failing clone check, a repo with a PR or a worktree, or a daemon session; for interim, a done or cancelled job, an unknown or verify-only repo, canary for a repo a cargo or cmake link depends on, or a daemon session; for propose: a missing or long --reason, an eval job, a repo rejected on this job, or a daemon session other than the job\'s own; for downstream: an eval job, a job at stage pr or later, or a daemon session other than the job\'s own',
        ],
      ],
      docs: ['Job repos', 'docs/ARCHITECTURE.md#job-repos'],
      readme: true,
    },
    {
      command: 'job interim',
      args: '<id> | publish <id> (<name> | --root) [--confirm] | release <id> (<name> | --root) <version>',
      summary:
        "each dependency edge between the job's repos: its interim strategy (job or config), links, state (held, waiting, ready, blocked, stale or released) and why, with no network call, plus each edge's release gate (ci, held, bump-due or released). publish publishes a dependency repo's canary: each npm link's package, exported from the verified commit's git objects, as <version>-canary.<sha12> under the canary dist-tag; without --confirm it only lists what it would publish, and --confirm needs a terminal on stdin. publish and forge release run are the only commands that publish anything. release records that the dependency of an edge of any strategy was released as <version>, after its PR merged (result: recorded, clear, bump, resumed): forge verify then bumps each unmerged consumer's manifests (and a tracked lockfile) to it, after which the consumer's PR may leave draft (forge pr ready) and merge; a job waiting on pr-review at stage pr resumes. publish and release are human-only",
      flags: [
        ['--root', 'with publish or release: the root repo instead of a member'],
        ['--confirm', 'with publish: publish (without it, nothing is published)'],
      ],
      exits: [
        [
          1,
          "no such job; for publish, a daemon session, --confirm without a terminal on stdin, a repo that is not the dependency of an npm-only canary edge, a HEAD that is not the one the latest passing verify checked or not on the job branch, a package.json whose name is not the link's, a package that tracks a symlink or npm, yarn or pnpm config in any case, a failed npm publish, or a likely secret in its commits or its files (code secret_found); for release, a daemon session, a done or cancelled job, an unknown repo, a repo no edge depends on, a version that is not semver or names a canary, or a dependency whose recorded PR is not merged",
        ],
      ],
      docs: ['Interim strategies', 'docs/CONFIG.md#interim-strategies'],
      readme: true,
    },
    { command: 'job note', args: '<id> [text] [--body B | --body-file F]', summary: 'log a note event', flags: BODY, exits: [NO_JOB] },
    {
      command: 'job human',
      args: '<id> <action> [--note N] [--link <ref>|new|none] [--reason R] [--repo A[,B]] [--actor human|foreman]',
      summary:
        "record a human decision: approve-spec, revise-spec, approve-split, revise-split, approve, rework, answer, or approve-repos or reject-repos on the pending repo proposals named by --repo (approve adds each repo to the job), or the foreman's approve-release of the job's pending release plan (logs release-approval and moves no job)",
      flags: [
        ['--note N', 'the human\'s note'],
        ['--repo A[,B]', 'with approve-repos or reject-repos (required): the pending repos you decide; with --actor foreman, every pending one'],
        ['--link <ref>|new|none', 'with approve or approve-spec: link an issue, create one, or record that none is needed'],
        ['--reason R', 'why, with --link none'],
        ['--actor human|foreman', 'who decided (default human); foreman only from the office daemon session, which must pass it; approve-release takes only --actor foreman and --note'],
      ],
      exits: [
        [1, 'no such job, a --link that cannot be made, a foreman decision the authority checks refuse, or approve-repos or reject-repos with nothing pending, no --repo, a repo that is not pending, a foreman --repo that is not the whole pending set, a failing clone check, or from a daemon session other than the office'],
        [3, 'the tracker claim was lost to another job'],
        [5, 'gh failed (GitHub tracker)'],
      ],
    },
    {
      command: 'job assist',
      args: '<id> --gate G',
      summary: "the office session's forge:assistant spawn for a gate: model, effort and a brief of paths only, and for repo-proposal the pending repos to pass as --repo; stale when the job no longer waits there. Read-only",
      flags: [['--gate G', `the gate class: ${OFFICE_GATES.join(', ')}`]],
      exits: [[1, 'no such job, an unknown gate, or a daemon session other than the office']],
    },
    {
      command: 'job agent',
      args: '<id> start|end|attach --role R [options]',
      summary: "record an agent starting or ending, with its usage; end also scans what the agent wrote for likely secrets (a secret-found event and secrets: <n>, never a refusal); attach records a running agent's --agent-id so the dashboard can follow its transcript",
      flags: [
        ['--role R', 'the role, e.g. builder or reviewer:code (required)'],
        ['--model M', 'the model it ran on'],
        ['--agent-id A', "the runtime's id for the agent (required with attach)"],
        ['--status S', 'how it ended'],
        ['--summary S', 'its one-line reply'],
        ['--output P', 'with start: the file it must write, inside the job dir'],
        ['--retry', 'with start: a retry of a lost agent'],
        ['--tokens N', 'with end: tokens used'],
        ['--tool-uses N', 'with end: tool calls made'],
        ['--duration-ms N', 'with end: wall time'],
        ['--import', "with end and --agent-id: read usage from the agent's Claude Code transcript"],
      ],
      exits: [[1, 'no such job, an --output outside the job dir, the inbox or office session starting an agent, or attach on a role that is not running']],
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
      command: 'job audit',
      args: '<id> [--json|--csv]',
      summary: "the job's audit trail: who did each human action (best effort, unauthenticated), its gate transitions, and its PR opening and merge, in time order",
      flags: [
        ['--json', 'the rows as JSON (the default)'],
        ['--csv', 'the rows as RFC 4180 CSV with CRLF line ends, formula-like cells prefixed with \''],
      ],
      exits: [NO_JOB],
      docs: ['Audit trail', 'docs/ARCHITECTURE.md#audit-trail'],
      readme: true,
    },
    {
      command: 'job archive',
      args: '<id>|--done --older-than D',
      summary: 'archive a finished job into .forge/archive/<id>.json (its job.json, events and a summary) and delete its job folder; with --done --older-than D, every finished job at least D days old. Stats, audit and retro still read archived jobs',
      flags: [
        ['--done', 'every finished job old enough, instead of one id'],
        ['--older-than D', 'with --done: days since the job finished (an integer, 0 or more)'],
      ],
      exits: [[1, 'not eligible, or a daemon session']],
      docs: ['Retention', 'docs/ARCHITECTURE.md#retention'],
      readme: true,
    },
    {
      command: 'job prune',
      args: '--older-than D [--dry-run]',
      summary: 'archive every eligible finished job at least D days old and delete stale daemon session logs; --dry-run lists what it would free and writes nothing',
      flags: [
        ['--older-than D', 'days since the job finished or the log was last written (an integer, 0 or more)'],
        ['--dry-run', 'list the jobs, refusals and logs with their sizes; change nothing'],
      ],
      exits: [[1, 'not eligible, or a daemon session']],
      docs: ['Retention', 'docs/ARCHITECTURE.md#retention'],
      readme: true,
    },
    {
      command: 'job verdicts',
      args: '<id> [--round N|integration] [--reviewers a,b] [--malformed changes] [--compact]',
      summary: "read a round's review files and record their verdicts once all are in, with each reviewed job repo's HEAD",
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
      command: 'job links',
      args: '<id>',
      summary: "the job's local links (config dependsOn links), active or not, with the dependency dir or the reason",
      exits: [NO_JOB],
      docs: ['Local links', 'docs/CONFIG.md#local-links'],
      readme: true,
    },
    {
      command: 'job scope',
      args: '<id>',
      summary: "files the branch changed outside the spec's Approach, across every reviewed job repo (member paths prefixed <repo>/), plus scope.diff for a multi-repo job",
      exits: [
        [1, 'no such job, no worktree or no spec.md'],
        [5, 'git failed'],
      ],
    },
    {
      command: 'job panel',
      args: '<id>',
      summary: "this round's review lenses: always, the spec's suggestions and the panel's paths matched against the branch diff, with a reason per lens; each reviewed job repo adds the lenses its clone's panel defines, as <repo>:<lens>; on a narrowed rework round, rerun and skipped name the rework panel",
      exits: [
        [1, 'no such job, no worktree or no spec.md'],
        [5, 'git failed'],
      ],
    },
    { command: 'job acs', args: '<id>', summary: "the spec's acceptance criteria and their proof in build.md", exits: [NO_JOB] },
    {
      command: 'job findings',
      args: '<id>',
      summary: 'review findings per round and lens: raised, fixed, disputed and recurring (same lens and path in consecutive rounds)',
      exits: [NO_JOB],
    },
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

// The repo budget caps unattended spend: a session misled by tracker or PR text must not force work past it.
const FORCE_DAEMON_REFUSAL = 'forge job new --force starts work past the repo budget, which a daemon session may not do; a human runs it in their own session';
const refuseForceInDaemon = () => {
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(FORCE_DAEMON_REFUSAL);
};

const TERMINAL_STATES = ['done', 'cancelled', 'failed'];

// Archive and prune delete job folders and session logs: a session misled by tracker text must not
// wipe the evidence. The retention policy itself still runs from forge sync, since a human set it.
const refuseRetentionInDaemon = (sub: string) => {
  const s = daemonScope(process.env);
  if ('problem' in s || s.daemon) throw new ForgeError(`forge job ${sub} deletes job folders and session logs, which a daemon session may not do; run it from your own terminal`, 1, 'run it from your own terminal');
};

// `forge stats` and `forge job step` read these from `human` events, so an invented action is refused.
const HUMAN_ACTIONS = ['approve-spec', 'revise-spec', 'approve-split', 'revise-split', 'approve', 'rework', 'answer', 'approve-repos', 'reject-repos', 'approve-release'] as const;
const REPO_ACTIONS: readonly string[] = ['approve-repos', 'reject-repos'];

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
  issues: 'forge job link',
  // A waiver set by hand would let a job past the issue-link wait with nobody having decided it.
  noIssue: 'forge job link --none',
  pr: 'forge pr find|open|sync',
  schemaVersion: 'forge migrate',
  usage: 'forge job agent',
  effort: 'forge job effort',
  // A cleared flag would skip the PP1 park; pr open recomputes it anyway.
  protectedPaths: 'forge git add|commit, forge verify or forge pr open',
  eval: 'forge eval start',
  // Which repos a job pushes to is a human decision.
  repos: 'forge job repo add|remove',
  // What its PRs point at, and what may be published, is too.
  interim: 'forge job repo interim',
};

// Kinds step routes differently: a retro job's review panel is fixed at code and docs, and an eval
// job skips the PR and the escalation gate. A session set to `retro` mid-build would have RV9 drop
// the lenses its diff selected, so only the command that creates each kind writes it.
const OWNED_KINDS: Record<string, string> = {
  retro: 'forge job new --kind retro',
  eval: 'forge eval start',
};

/**
 * `forge job new`'s issue flags as createJob's list, checked before anything is written. Refs are
 * recorded as given, with no tracker call or claim (from-ref and link make those).
 */
function newJobIssues(root: string, config: Config, flags: Record<string, any>): { issues: JobIssue[]; noIssue: { reason: string | null } | null } {
  const typed = list(flags.issue);
  const ref = str(flags.ref, '--ref');
  const url = str(flags.url, '--url');
  const wantsNone = flags['no-issue'] === true;
  const reason = str(flags.reason, '--reason');
  if ((ref !== undefined || url !== undefined) && (typed.length || flags.issue !== undefined)) throw usageError(JOB, 'new');
  if (wantsNone && (typed.length || ref !== undefined || flags.issue !== undefined)) throw usageError(JOB, 'new');
  if (reason !== undefined && !wantsNone) throw usageError(JOB, 'new');
  if (wantsNone && config.tracker.kind === 'none') throw new ForgeError('tracker.kind is "none": no issue is needed, so there is nothing to waive (drop --no-issue)');
  if (url !== undefined && !isSafeUrl(url)) throw new ForgeError(`invalid url ${JSON.stringify(String(url).slice(0, 100))}: expected http(s) with no whitespace`);
  const tracker = str(flags.tracker, '--tracker') ?? config.tracker.kind;
  const slug = tracker === 'github' ? localRepoSlug(root, config) : null;
  const parse = (raw: string): string => {
    const r = checkIssueRef(raw, { tracker, slug });
    if ('error' in r) throw new ForgeError(r.error);
    return r.ref;
  };
  const issues: JobIssue[] = ref !== undefined || url !== undefined ? [{ tracker, ref: ref === undefined ? null : parse(ref), url: url ?? null }] : typed.map((raw) => {
    const r = parse(raw);
    return { tracker, ref: r, url: tracker === 'github' ? issueUrl(r, githubHost()) : null };
  });
  return { issues, noIssue: wantsNone ? { reason: reason ?? null } : null };
}

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
      // Every issue check runs before createJob, so a refused flag leaves no job dir.
      const { issues, noIssue } = newJobIssues(root, config, flags);
      let effort: Effort | undefined;
      if (flags.effort !== undefined) {
        refuseEffortInDaemon();
        effort = oneOf(str(flags.effort, '--effort'), EFFORTS, 'effort');
      }
      const force = flags.force !== undefined && flags.force !== false;
      if (force) refuseForceInDaemon();
      // Checked before the job exists, so release never frees the job being created.
      const status = checkRepoBudget(root, config);
      const job = createJob(root, config, {
        title: req(flags.title, '--title'),
        issues,
        body: bodyFrom(flags),
        parent: flags.parent,
        branch: flags.branch,
        kind: flags.kind,
        slug: flags.slug,
        services: list(flags.services),
        effort,
      });
      const waived = noIssue ? markNoIssue(root, job.id, noIssue.reason).noIssue : null;
      const created = { id: job.id, branch: job.branch, dir: path.relative(root, jobDir(root, job.id)), issueLink: issueLinkStatus({ ...job, noIssue: waived }, config) };
      if (force) logHumanEvent(root, job.id, 'budget-override', { day: status.day, month: status.month, spent: status.spent, caps: status.caps });
      const limited = Boolean(status.reason) && !force && job.kind !== 'retro';
      // Still created, so the human's request is kept, but parked and unclaimed until the budget allows it.
      if (limited && status.held) {
        parkForRepoBudget(root, job.id, status);
        return { ...created, repoBudget: repoBudgetBlock(status) };
      }
      // A split child starts unowned: the session claims each child only when it runs it.
      if (session && !flags.parent) claimJob(root, job.id, session, false, daemonClaimOpts(root, job.id));
      if (!limited) return created;
      logEvent(root, job.id, 'repo-budget-warn', { reason: status.reason });
      return { ...created, repoBudget: repoBudgetBlock(status) };
    }
    case 'link': {
      const jobId = req(id, 'job id');
      const refs = rest.slice(1);
      const removes = list(flags.remove);
      const modes = [refs.length > 0, flags.remove !== undefined, flags.create === true, flags.none === true, flags.suggest === true].filter(Boolean).length;
      if (modes !== 1 || (flags.remove !== undefined && !removes.length)) throw usageError(JOB, 'link');
      if (flags.suggest) return suggestLink(root, config, jobId, () => loadTracker(root, config));
      if (flags.none) return markNoIssue(root, jobId, typeof flags.reason === 'string' ? flags.reason : null);
      if (removes.length) return unlinkJob(root, config, jobId, removes);
      const tracker = await loadTracker(root, config);
      return flags.create ? createAndLink(root, config, tracker, jobId) : linkJob(root, config, tracker, jobId, refs);
    }
    case 'from-ref': {
      const ref = req(id, 'tracker ref');
      // A human named the item, so a hold is an error rather than an empty result.
      const status = checkRepoBudget(root, config);
      if (status.held) throw new ForgeError(status.reason!, 'blocked', 'forge budget');
      const tracker = await loadTracker(root, config);
      // An issue the human picked is planned as one job, whatever pipeline.split says.
      const r = await startFromRef(root, config, tracker, ref, flags, { splitMode: 'never' });
      if (!status.reason || 'existing' in r) return r;
      logEvent(root, r.id, 'repo-budget-warn', { reason: status.reason });
      return { ...r, repoBudget: repoBudgetBlock(status) };
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
      if ('kind' in fields && Object.hasOwn(OWNED_KINDS, String(fields.kind))) throw new ForgeError(`--field kind=${fields.kind} is not settable; use ${OWNED_KINDS[String(fields.kind)]}`);
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
      const force = Boolean(flags.force);
      const session = req(str(flags.session, '--session'), '--session');
      const status = checkRepoBudget(root, config);
      let budgetNote: { held: boolean; reason: string | null } | null = null;
      if (status.reason) {
        const cur = loadJob(root, jobId);
        const own = ownerStatus(cur);
        const agentRunning = Object.values(cur.agents ?? {}).some((a) => a?.status === 'running');
        const foreignOwner = own.status === 'live' && own.session !== session;
        const limited = !repoBudgetExempt(root, cur, status) && !TERMINAL_STATES.includes(cur.state) && !agentRunning && !foreignOwner;
        // A running agent finishes its step, a foreign owner gets its exit 3, and another gate's wait is kept.
        if (limited && status.held && (cur.state !== 'waiting' || isRepoHold(cur))) {
          parkForRepoBudget(root, jobId, status);
          throw new ForgeError(status.reason, 'blocked', 'forge budget');
        }
        if ((limited && cur.state !== 'waiting') || agentRunning) budgetNote = repoBudgetBlock(status);
      }
      // Only a forced takeover is a person's decision; a plain claim is the pipeline's own.
      const opts = { ...daemonClaimOpts(root, jobId), ...(force ? { actor: currentActor(root) } : {}) };
      const { job, overridden } = claimRespectingDeps(root, jobId, session, force, opts);
      if (budgetNote && !budgetNote.held) logEvent(root, job.id, 'repo-budget-warn', { reason: budgetNote.reason });
      return { id: job.id, owner: job.owner, ...(overridden.length ? { dependenciesOverridden: overridden } : {}), ...(budgetNote ? { repoBudget: budgetNote } : {}) };
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
      const who = flags.actor === undefined ? 'human' : oneOf(str(flags.actor, '--actor'), ['human', 'foreman'] as const, 'actor');
      // The office session records only foreman decisions, and only it may: provenance is the
      // daemon scope, so a job session misled by request text can't pass off a decision as the foreman's.
      if (inOffice() && who !== 'foreman') throw new ForgeError('the office session records decisions only with --actor foreman', 1);
      // No job waits on a release, so it skips checkForemanDecision; checkReleaseDecision re-plans and
      // re-reads the policy before the one event it writes. The job's state never changes.
      if (action === 'approve-release') {
        if (who !== 'foreman') throw new ForgeError("approve-release is the foreman's (--actor foreman); a person approves a release by answering forge release run's publish prompt in a terminal", 1);
        const planHash = checkReleaseDecision(root, config, jobId, note, { link: flags.link, reason: flags.reason, repo: flags.repo });
        logHumanEvent(root, jobId, RELEASE_APPROVAL, { planHash, note }, FOREMAN_ACTOR);
        return { ok: true, release: { plan: planHash.slice(0, 12), actor: 'foreman' } };
      }
      if (who === 'foreman') checkForemanDecision(root, config, job, action, note, { link: flags.link, reason: flags.reason });
      // Every check runs before any write, so a refused --link leaves job.json and events untouched.
      const link = flags.link;
      if (link !== undefined && (typeof link !== 'string' || !link.trim())) throw new ForgeError('--link needs <ref>, new or none');
      if (link !== undefined && action !== 'approve-spec' && action !== 'approve') throw new ForgeError('--link is only for approve and approve-spec');
      // Re-validated here, not only in the orchestrator: the value can come from request or dashboard text.
      if (typeof link === 'string' && link !== 'new' && link !== 'none') {
        const checked = checkIssueRef(link, { tracker: config.tracker.kind, slug: localRepoSlug(root, config) });
        if ('error' in checked) throw new ForgeError(checked.error);
      }
      const reason = str(flags.reason, '--reason');
      if (reason !== undefined && link !== 'none') throw new ForgeError('--reason is only for --link none');
      if (flags.repo !== undefined && !REPO_ACTIONS.includes(action)) throw new ForgeError('--repo is only for approve-repos and reject-repos');
      if (REPO_ACTIONS.includes(action)) {
        // Widening the repos a job pushes to: never from a job session or the inbox, which could be misled by request text.
        const s = daemonScope();
        if ('problem' in s) throw new ForgeError(s.problem);
        if (s.daemon && !inOffice()) throw new ForgeError(`forge job human ${action} decides which repos a job pushes to, which a daemon session may not do; decide in the dashboard or your own terminal`, 1);
        const actor = who === 'foreman' ? FOREMAN_ACTOR : currentActor(root);
        // The decider names what it saw: never "every pending repo", which could include one proposed since.
        const repos = flags.repo === undefined ? [] : list(flags.repo);
        if (!repos.length) throw new ForgeError(`forge job human ${action} needs --repo A[,B]: the pending repos you decide (see repo-proposals.md)`, 1);
        // The foreman decides the whole list its assist call returned; a person may name a subset.
        const decided = decideRepoProposals(root, config, jobId, action === 'approve-repos' ? 'approve' : 'reject', { repos, exact: who === 'foreman', note: note ?? (rest.slice(2).join(' ') || null), actor });
        return { ok: true, ...decided };
      }
      // A rejected split re-plans as one job; recorded before the event so step never sees one without the other.
      if (action === 'revise-split') setJob(root, jobId, { fields: { splitMode: 'never' } });
      // The link goes first: if it throws, no approval is recorded and the job keeps waiting.
      let linked: unknown;
      // Resolved after every check, so a refused call never spawns gh to find out who asked.
      const actor = who === 'foreman' ? FOREMAN_ACTOR : currentActor(root);
      if (link === 'none') linked = markNoIssue(root, jobId, reason ?? null, actor);
      else if (link === 'new') linked = createAndLink(root, config, await loadTracker(root, config), jobId, actor);
      else if (typeof link === 'string') linked = linkJob(root, config, await loadTracker(root, config), jobId, [link], actor);
      logHumanEvent(root, jobId, 'human', { action, note: note ?? (rest.slice(2).join(' ') || null) }, actor);
      return { ok: true, ...(link !== undefined ? { link: linked } : {}) };
    }
    case 'repo': {
      // Computed from config and events, never named: the one way a job's own session adds a repo, and only verify-only.
      if (rest[0] === 'downstream') {
        if (rest.length !== 2 || Object.keys(flags).length) throw usageError(JOB, 'repo');
        return addDownstreamRepos(root, config, rest[1]);
      }
      if (rest[0] === 'interim') {
        refuseInterimInDaemon();
        const jobId = rest[1];
        const root_ = flags.root;
        // parseArgs gives `--root` the next word as its value, so `--root canary` arrives as root: 'canary'.
        const strategy = typeof root_ === 'string' ? root_ : rest[root_ === true ? 2 : 3];
        const name = root_ === undefined ? rest[2] : undefined;
        if (!jobId || !strategy || (root_ === undefined && !name) || rest.length > (root_ === undefined ? 4 : typeof root_ === 'string' ? 2 : 3)) throw usageError(JOB, 'repo');
        return setRepoInterim(root, config, requireJob(root, jobId).id, name ?? null, strategy);
      }
      const action = rest[0];
      const jobId = rest[1];
      const name = rest[2];
      // An agent may propose (in its own job's session only); adding and removing stay human-only.
      if (action === 'propose') {
        if (!jobId || !name || rest.length > 3 || flags['verify-only'] !== undefined) throw usageError(JOB, 'repo');
        // A bare or empty --reason is a missing reason (exit 1), not a usage error.
        const reason = Array.isArray(flags.reason) ? str(flags.reason, '--reason') : typeof flags.reason === 'string' ? flags.reason : undefined;
        return proposeJobRepo(root, config, requireJob(root, jobId).id, name, reason);
      }
      refuseJobRepoInDaemon();
      if (flags.reason !== undefined) throw usageError(JOB, 'repo');
      if (!['add', 'remove'].includes(String(action)) || !jobId || !name || rest.length > 3 || (action === 'remove' && flags['verify-only'] !== undefined)) throw usageError(JOB, 'repo');
      requireJob(root, jobId);
      return action === 'add' ? addJobRepo(root, config, jobId, name, flags['verify-only'] === true) : removeJobRepo(root, jobId, name);
    }
    case 'interim': {
      if (rest[0] === 'publish') {
        const jobId = rest[1];
        const root_ = flags.root;
        if (!jobId || (root_ !== undefined && root_ !== true) || (root_ === true ? rest.length !== 2 : rest.length !== 3)) throw usageError(JOB, 'interim');
        if (flags.confirm !== undefined && flags.confirm !== true) throw usageError(JOB, 'interim');
        return publishCanary(root, config, requireJob(root, jobId).id, root_ === true ? null : rest[2], { confirm: flags.confirm === true, interactive: process.stdin.isTTY === true });
      }
      if (rest[0] === 'release') {
        // Before the job or config is read: a daemon session never records a release.
        if (process.env.FORGE_DAEMON === '1') throw new ForgeError(RELEASE_DAEMON_REFUSAL);
        const jobId = rest[1];
        const root_ = flags.root;
        // parseArgs gives `--root` the next word as its value, so `--root 1.2.0` arrives as root: '1.2.0'.
        const version = typeof root_ === 'string' ? root_ : rest[root_ === true ? 2 : 3];
        const name = root_ === undefined ? rest[2] : undefined;
        if (!jobId || !version || (root_ === undefined && !name) || rest.length !== (root_ === undefined ? 4 : typeof root_ === 'string' ? 2 : 3)) throw usageError(JOB, 'interim');
        return recordRelease(root, config, requireJob(root, jobId).id, name ?? null, version);
      }
      if (!id || rest.length > 1) throw usageError(JOB, 'interim');
      const job = requireJob(root, id);
      const edges = interimStatus(root, config, job).edges;
      return { id: job.id, edges, gates: releaseGates(edges, readEvents(root, job.id), job) };
    }
    case 'assist':
      return assist(root, config, requireJob(root, id), flags.gate);
    case 'agent': {
      const jobId = requireJob(root, id).id;
      const phase = req(rest[1], 'start|end|attach');
      if (!['start', 'end', 'attach'].includes(phase)) throw new ForgeError('phase must be start, end or attach', 'usage');
      const role = req(flags.role, '--role');
      if (phase === 'attach') {
        const agentId = flags['agent-id'];
        // Checked before anything is written: the id becomes a transcript file name.
        if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) throw new ForgeError('--agent-id must match [A-Za-z0-9_-]{1,100}', 'usage');
        const a = attachAgent(root, jobId, role, agentId).agents[role];
        return { role, status: a.status, agentId: a.agentId };
      }
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
          usage = importClaudeCodeTranscript(String(flags['agent-id']), { since, root, job: before }) ?? undefined;
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
      // job.reviewers is settable with --field: a qualified lens counts only for a reviewed member of the job.
      const reviewers = list(flags.reviewers).length ? list(flags.reviewers) : integration ? ['code'] : job.reviewers.filter((l) => isLens(l) && lensRepoAllowed(job, l));
      if (!reviewers.length) throw new ForgeError(`job ${id} has no reviewers selected; set them with: forge job set ${id} --field reviewers='["code","tests"]'`);
      if (flags.malformed !== undefined && flags.malformed !== 'changes') throw new ForgeError('--malformed accepts only "changes"', 'usage');
      const v = roundVerdicts(root, job.id, round, reviewers, config.review.blockOn, { malformedAs: flags.malformed });
      // The sha reviewers saw is evidence; it tells a later reader whether the review is still current.
      const sha = job.worktree && exists(job.worktree) ? run('git', ['rev-parse', 'HEAD'], { cwd: job.worktree, allowFail: true }).stdout.trim() || null : null;
      // Each reviewed member's HEAD beside the root's sha; only Forge's own worktree path is trusted.
      const memberHeads = Object.fromEntries(
        reviewedRepoNames(job).map((name) => {
          const wt = trustedMemberWorktree(root, config, job, name);
          return [name, wt ? run('git', ['rev-parse', 'HEAD'], { cwd: wt, allowFail: true }).stdout.trim() || null : null];
        }),
      );
      const heads = Object.keys(memberHeads).length ? { heads: memberHeads } : {};
      if (v.complete) {
        const verdicts = Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict]));
        const coerced = Object.entries(v.reviewers).filter(([, r]) => r.coerced).map(([k]) => k);
        if (integration) logEvent(root, job.id, 'integration-review', { outcome: v.outcome, sha, ...heads, reviewers: verdicts, coerced: coerced.length ? coerced : undefined });
        else {
          setJob(root, job.id, { fields: { [`verdicts.${round}`]: verdicts } });
          logEvent(root, job.id, 'verdicts', { round, outcome: v.outcome, sha, ...heads, coerced: coerced.length ? coerced : undefined });
        }
        if (coerced.length) logEvent(root, job.id, 'note', { text: `${integration ? 'integration review' : `round ${round}`}: malformed review(s) from ${coerced.join(', ')} counted as CHANGES` });
      }
      if (flags.compact) {
        // Absolute paths, so the orchestrator can hand a re-spawned reviewer its output verbatim.
        const missing = Object.fromEntries(Object.entries(v.reviewers).filter(([, r]) => r.verdict === 'MISSING').map(([k, r]) => [k, r.path]));
        const reviewers = Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict === 'CHANGES' ? `CHANGES(${r.blocking})` : r.verdict]));
        return { round, complete: v.complete, outcome: v.outcome, sha, ...heads, reviewers, ...(Object.keys(missing).length ? { missing } : {}) };
      }
      return { ...v, sha, ...heads };
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
    case 'audit': {
      if (flags.json && flags.csv) throw usageError(JOB, 'audit');
      // jobAudit reads an archived job's record once its job dir is gone.
      const a = jobAudit(root, req(id, 'job id'));
      return flags.csv ? toCsv(a.rows, () => a.pr) : a;
    }
    case 'archive': {
      refuseRetentionInDaemon('archive');
      if (flags.done !== undefined || flags['older-than'] !== undefined) {
        if (id !== undefined || flags.done !== true || flags['older-than'] === undefined) throw usageError(JOB, 'archive');
        return archiveOlder(root, num(flags['older-than'], '--older-than', { integer: true })!, 'cli');
      }
      if (rest.length !== 1) throw usageError(JOB, 'archive');
      return { archived: [archiveJob(root, req(id, 'job id'), 'cli')], refused: [] } satisfies ArchiveResult;
    }
    case 'prune': {
      refuseRetentionInDaemon('prune');
      if (rest.length || flags['older-than'] === undefined) throw usageError(JOB, 'prune');
      return prune(root, num(flags['older-than'], '--older-than', { integer: true })!, { dryRun: flags['dry-run'] === true });
    }
    case 'budget':
      return budgetCmd(root, config, req(id, 'job id'), { set: list(flags.set), ack: Boolean(flags.ack) });
    case 'progress':
      return progress(root, requireJob(root, id).id);
    case 'paths':
      return jobPaths(root, config, loadJob(root, req(id, 'job id')));
    case 'links': {
      const job = requireJob(root, id);
      return { id: job.id, links: resolveLinks(root, config, job) };
    }
    case 'scope':
      return jobScope(root, config, req(id, 'job id'));
    case 'panel':
      return jobPanel(root, config, req(id, 'job id'));
    case 'acs':
      return jobAcs(root, req(id, 'job id'));
    case 'findings': {
      const jobId = requireJob(root, id).id;
      return { id: jobId, ...jobFindings(root, jobId) };
    }
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
  const events = readEvents(root, job.id);
  // A release is a plan awaiting approval, not a park: stale once release.json moves on or it is approved.
  const releaseHash = gate === 'release' ? pendingReleaseHash(root, job.id, events) : null;
  const stale = gate === 'release' ? releaseHash === null : gateClassFor(root, job) !== gate;
  // A class reserved with gate:<class> is a human's even when a request for it exists.
  const reserved = stale ? null : (classReservation(config, gate) ?? reservedFor(root, config, job, gate));
  // One read of the events for both the brief and `repos`, so the foreman's --repo is exactly the set the assistant judged.
  const pending = gate === 'repo-proposal' && !stale ? pendingRepoProposals(job, events) : [];
  return {
    gate,
    stale,
    reserved,
    model: modelFor(config, 'assistant'),
    effort: resolveEffort(config, job, 'assistant').level,
    subagent: 'forge:assistant',
    brief: assistantBrief(root, config, job, gate, config.foreman?.reserved, events, pending, releaseHash),
    // The brief's `Pending repos` names: the foreman passes exactly these as --repo, and `exact` refuses once they stop being the pending set.
    ...(gate === 'repo-proposal' && !stale ? { repos: pending.map((r) => r.repo) } : {}),
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
    ports: job.ports,
    pr: job.pr ? { number: job.pr.number, url: job.pr.url, state: job.pr.state, checks: job.pr.checks?.state, behindBy: job.pr.behindBy, conflicts: job.pr.conflicts, unresolvedThreads: job.pr.unresolvedThreads } : null,
    issues: job.issues,
    noIssue: job.noIssue,
    effort: job.effort,
    owner: job.owner?.session ?? null,
    progress: progress(root, job.id),
    tokens: job.usage.totalTokens,
    estCostUsd: job.usage.estCostUsd,
  };
}
