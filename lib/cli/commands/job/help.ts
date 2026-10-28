// `forge job`'s help table: every subcommand's usage, flags and exits, which `forge help job` prints and `npm run docs` reads.
import { OFFICE_GATES } from '#core/job/schema.ts';
import type { HelpGroup } from '../../types.ts';

const NO_JOB: [1, string] = [1, 'no such job'];
const BODY: [string, string][] = [
  ['--body B', 'the text'],
  ['--body-file F', "read the text from F (- for stdin); in a daemon session F must be inside the session job's folder or worktree"],
];

// In the order `forge job` lists its subcommands. `advance` is routed by lib/cli/main.ts but documented here.
export const JOB: HelpGroup = {
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
        ['--components a,b', 'the configured components it will change (the spec sets them otherwise)'],
        ['--services a,b', 'deprecated alias of --components'],
        ['--effort E', "the job's reasoning effort: low, medium, high, xhigh or max (default: inherit runtime.effort)"],
        ['--mandate ID', "the mandate it works under, which narrows what the Foreman decides for it (default: --parent's); locked once set"],
        ['--force', 'start it past an exceeded repo budget (budget:), logged as a budget-override; a human only'],
      ],
      exits: [[1, "an unsafe --branch or ref, --no-issue with tracker.kind none, --effort or --force from a daemon session, or a --mandate that is unknown (not_found), closed, unreadable or not --parent's"]],
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
      common: true,
    },
    { command: 'job list', args: '[--all]', summary: 'active jobs, one object each', flags: [['--all', 'include finished and cancelled jobs']] },
    { command: 'job show', args: '<id> [--full]', summary: 'one job, compact (the whole job.json with --full)', flags: [['--full', 'print the whole job.json']], exits: [NO_JOB] },
    { command: 'job get', args: '<id> [path]', summary: 'one value of job.json by dotted path (null when absent)', exits: [NO_JOB] },
    {
      command: 'job set',
      args: '<id> [--stage S] [--state S] [--waiting-on W|none] [--reason R] [--note N] [--field key=value]...',
      summary: "change a job's stage, state or fields; every check runs before anything is written. Moving an active job to done or cancelled tears its environment down (background processes, per-job containers and volumes, job databases) and lists it as environment; in the inbox or office daemon session it only stops it (environment.teardown: deferred), keeping volumes and job databases for archive or forge environment down; a chat session tears it down like a job session, as it may run forge environment down itself; a failed teardown keeps exit 0 and the records, for forge environment down to retry. `--field budget` (and any path under it) is refused for every caller: use `forge job budget` at a terminal or the dashboard's Approve on the budget gate",
      flags: [
        ['--stage S', 'the pipeline stage'],
        ['--state S', 'queued, running, waiting, blocked, failed, cancelled or done'],
        ['--waiting-on W', 'what a waiting job waits on (none clears it)'],
        ['--reason R', 'why, shown with the state'],
        ['--note N', 'a note logged with the change'],
        ['--field key=value', 'set a field (values are JSON or plain words; repeatable)'],
        ['--epoch N', "the driver's epoch: refused (stale_epoch) before any write once another session took the job over"],
      ],
      exits: [
        [
          1,
          "no such job, a field set only by another command, a list field that is not a JSON array of strings, or an unknown or cyclic dependency; human_only: a shelved job moved anywhere but done or cancelled (`forge job unshelve` takes it off the shelf), or a job cancelled or set done while shelved put back to work in a daemon session or with no person at a terminal (a person types the job id to confirm), or not confirmed; in a chat session, a job waiting on a gate that foreman.reserved or a security review that didn't pass keeps with a person (`a chat may not decide <gate> for <job>: …`), or any change to such a job beyond --state running with the stage the decision recorded at its park allows (docs/architecture/daemon-security.md › Chats)",
        ],
        [3, 'stale_epoch: the lease moved past --epoch'],
      ],
    },
    {
      command: 'job effort',
      args: '<id> low|medium|high|xhigh|max | --inherit',
      summary: "set a job's reasoning effort (forge job new --effort sets it at creation), or clear it so the job inherits runtime.effort; daemon sessions start with --effort and every agent gets it",
      flags: [['--inherit', "clear the job's effort"]],
      exits: [[1, 'no such job, or a daemon session']],
      docs: ['Effort', 'docs/CONFIG.md#effort'],
      common: true,
    },
    {
      command: 'job claim',
      args: '<id> --session S [--force] [--epoch N]',
      summary: "take the job's lease for a session (30 minutes, renewed by its own step, advance, agent and worktree commands); a new driver gets the next epoch, which the result returns as `epoch` for every later --epoch. For a job started from its issue, before any plan.md or spec.md exists, it also re-reads request.md from that issue, best effort (`requestRefreshed: true` when it changed)",
      flags: [
        ['--session S', 'the claiming session (required)'],
        ['--force', 'take it from a live lease, or claim it with dependencies not done'],
        ['--epoch N', 'a re-claim by the driver holding epoch N; refused (stale_epoch) once the job moved on'],
      ],
      exits: [[1, 'no such job, or the office daemon session ran it'], [3, 'another session holds a live lease (owned), or the lease moved past --epoch (stale_epoch)'], [4, 'dependencies pending, or the repo budget holds new work']],
    },
    { command: 'job release', args: '<id>', summary: "drop the job's driver (its epoch stays)", exits: [NO_JOB] },
    {
      command: 'job refresh-request',
      args: '<id>',
      summary: "re-read request.md and the title from the job's primary issue, so a queued job picks up an edited issue; the id, links, claim and dependsOn stay",
      exits: [[1, 'no such job, a finished job, plan.md or spec.md already written, an agent running, no linked issue, an issue outside this repo and its member repos\' trackers, or no such tracker item (gh failing reads as none)']],
    },
    {
      command: 'job repo',
      args: 'add <id> <name> [--verify-only] | remove <id> <name> | propose <id> <name> --reason R | downstream <id> | interim <id> (<name> | --root) canary|git-ref|local|sequential|inherit',
      summary: "add a member repo (a config repos entry whose clone passes doctor's check) to a job, which then gets its own worktree, verify evidence and PR on the job's branch; remove drops one that has no PR and no worktree left; interim sets one job repo's interim strategy as a dependency (what a consumer's PR points at while it is unmerged: docs/CONFIG.md \"Interim strategies\"), overriding release.interim, and inherit clears it (add, remove and interim are human-only). propose records an agent's proposal of a repos entry with its reason in repo-proposals.md; the job then waits until a human, or the foreman when allowed, runs forge job human <id> approve-repos|reject-repos (approving a verify-only member promotes it to an edited one). downstream adds the changed repos' linked consumers as verify-only repos, so verify runs their tests against the job's changes, and prints what it added and skipped with each reason (docs/CONFIG.md \"Downstream verification\"); it takes no repo name, and the job's own session may run it",
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
      docs: ['Job repos', 'docs/architecture/job-repos.md'],
      common: true,
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
      common: true,
    },
    { command: 'job note', args: '<id> [text] [--body B | --body-file F]', summary: 'log a note event', flags: BODY, exits: [NO_JOB] },
    {
      command: 'job human',
      args: '<id> <action> [--note N] [--link <ref>|new|none] [--reason R] [--repo A[,B]] [--actor human|foreman]',
      summary:
        "record a human decision: approve-spec, revise-spec, approve-split, revise-split, approve, rework, answer, or approve-repos or reject-repos on the pending repo proposals named by --repo (approve adds each repo to the job), or the foreman's approve-release of the job's pending release plan (logs release-approval and moves no job). In a chat session the decision records actor source chat (docs/architecture/daemon-security.md › Chats)",
      flags: [
        ['--note N', 'the human\'s note'],
        ['--repo A[,B]', 'with approve-repos or reject-repos (required): the pending repos you decide'],
        ['--link <ref>|new|none', 'with approve or approve-spec: link an issue, create one, or record that none is needed'],
        ['--reason R', 'why, with --link none'],
        ['--actor human|foreman', "who decided (default human). foreman is refused in every scope, approve-release included: only forge dash's gate runner records foreman decisions, in-process"],
      ],
      exits: [
        [
          1,
          "no such job, a --link that cannot be made, --actor foreman (refused in every scope), any call from the office session, a gate foreman.reserved or a security review that didn't pass keeps with a person when a chat session decides it (`a chat may not decide <gate> for <job>: …`), approve-release without --actor foreman, or approve-repos or reject-repos with nothing pending, no --repo, a repo that is not pending, a failing clone check, or from any daemon session",
        ],
        [3, 'the tracker claim was lost to another job'],
        [5, 'gh failed (GitHub tracker)'],
      ],
    },
    {
      command: 'job assist',
      args: '<id> --gate G',
      summary: "what a gate run's forge:assistant is briefed with for a gate, for a person's own terminal: model, effort and a brief of paths only, and for repo-proposal the pending repos; stale when the job no longer waits there. Read-only",
      flags: [['--gate G', `the gate class: ${OFFICE_GATES.join(', ')}`]],
      exits: [[1, 'no such job, an unknown gate, or any daemon session']],
    },
    {
      command: 'job agent',
      args: '<id> start|end|attach --role R [options]',
      summary: "record an agent starting or ending, with its usage; end also scans what the agent wrote for likely secrets (a secret-found event and secrets: <n>, never a refusal); attach records a running agent's --agent-id so the dashboard can follow its transcript",
      flags: [
        ['--role R', 'the role: a role name (a-z, 0-9, -) or reviewer:<lens> (required; anything else exits 2)'],
        ['--model M', 'the model it ran on'],
        ['--agent-id A', "the runtime's id for the agent (required with attach)"],
        ['--status S', 'how it ended'],
        ['--summary S', 'its one-line reply'],
        ['--output P', 'with start: the file it must write, inside the job dir'],
        ['--retry', 'with start: a retry of a lost agent'],
        ['--tokens N', 'with end: tokens used (refused in a daemon session)'],
        ['--tool-uses N', 'with end: tool calls made (refused in a daemon session)'],
        ['--duration-ms N', 'with end: wall time (refused in a daemon session)'],
        ['--import', "with end and --agent-id: read usage from the agent's Claude Code transcript (implied in a daemon session)"],
        ['--epoch N', "with start and end: the driver's epoch, refused (stale_epoch) before any write once another session took the job over"],
      ],
      exits: [
        [1, 'no such job, an --output outside the job dir, the inbox or office session starting an agent, or attach on a role that is not running'],
        [3, 'stale_epoch: the lease moved past --epoch'],
      ],
    },
    {
      command: 'job agent run',
      args: '<id> --session S [--spawn-index N] [--epoch N] [--cold]',
      summary:
        "run the spawn `forge job step` returns as its own headless `claude -p --agent forge:<role>` child in the job's worktree, the brief on its stdin, and record its start, attach and end, with the usage from its own result line; tool calls outside daemon.allowedTools are denied unattended. A review lens or rework build forks the round's context session (one child per round, agent, model, effort and prefix that read the shared inputs once), starting it when none is warm. Prints {id, role, rule, agentId, resumed, status, summary, failure, denied, wallMs, log, prefix, context, usage, jobTokens, jobCostUsd} on every exit after the start: prefix is the trusted prefix file passed as --append-system-prompt-file (the main checkout's instruction files, learnings and role notes), or null, with prefixRefused naming the source that made it run without one; context is {mode: fork|cold, session, reason, firstRead} for a review lens or rework build (reason: cold flag, no inputs, context failed: <class>, context busy, brief over the cap, fork failed or cache miss), null for any other spawn",
      flags: [
        ['--session S', 'the session that holds the job (required): only its driver may run a role'],
        ['--spawn-index N', "which spawn of step's list to run: 0 (the default) is the action itself, 1 on its `spawns`"],
        ['--epoch N', "the driver's epoch, refused (stale_epoch) before any write once another session took the job over"],
        ['--cold', 'run without a context session, for measurement: no context child starts and context.reason is `cold flag`'],
      ],
      exits: [
        [
          1,
          "no such job; the inbox, office or another job's session; stale_step: step no longer returns that spawn (another caller started it, or the job moved on); a worktree that is missing or under no worktrees root, a daemon.command problem, a tracker symlink, a trust digest that does not match under FORGE_DAEMON=1, or an empty brief; or the role failed (failure.class limit, auth, budget, error, timeout, untrusted or interrupted)",
        ],
        [3, 'another live session drives the job, the session does not hold it, or stale_epoch: the lease moved past --epoch or was taken over before the end'],
        [5, 'the role failed because claude never started (failure.class spawn) or closed without a result (exit)'],
      ],
      common: true,
    },
    { command: 'job round', args: '<id>', summary: 'start the next review round, unless the budget is spent', exits: [NO_JOB] },
    {
      command: 'job budget',
      args: '<id> [--set key=value,...] [--ack]',
      summary: "the job's budget limits and use; --set and --ack are a human-only operation: they ask the person at the terminal to type the job id, or a person uses the dashboard's Approve & continue on the budget gate instead",
      flags: [
        ['--set key=value', 'set a limit: tokens, usd, minutes, changedLines or verifyRetries (default restores the configured one)'],
        ['--ack', 'accept the limits now exceeded, so the job goes on'],
      ],
      exits: [[1, 'no such job, an unknown budget key or bad value, not confirmed, or human_only: --set or --ack in a daemon session or with no person at a terminal (an agent, a script or a configured command)']],
    },
    {
      command: 'job shelve',
      args: '<id> --reason TEXT',
      summary:
        "set a waiting, queued, failed or blocked job aside: it waits on `shelved` at its stage, lets go of its lease, stops its environment (the worktree stays), keeps its PR, and leaves the waiting count; one note with the reason goes to its linked issues. Nothing resumes it: only a person takes it off the shelf (`forge job unshelve`, or the dashboard's Shelved list). A person runs it from their own terminal; no daemon session does",
      flags: [['--reason TEXT', 'why it is set aside: one line of at most 200 characters (control characters and backticks are dropped; a reason that is empty after that exits 2)']],
      exits: [
        [1, 'no such job; a done, cancelled, running, eval or already shelved job, or one with an agent running; or any daemon session'],
        [2, 'usage: the call could not be parsed (no --reason, or one that is empty once control characters and backticks are dropped), or .forge/config.yml is missing or invalid'],
      ],
    },
    {
      command: 'job unshelve',
      args: '<id>',
      summary:
        "take a shelved job off the shelf: back to the wait, queue or failure it was shelved from, at its stage, so it can spend again, and back in Needs you (no Foreman gate request). A human-only operation: it asks the person at the terminal to type the job id, or a person uses Un-shelve in the dashboard's Shelved list instead",
      exits: [[1, 'no such job, a job that is not shelved, not confirmed, or human_only: run in a daemon session or with no person at a terminal (an agent, a script or a configured command)']],
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
      docs: ['Audit trail', 'docs/architecture/audit-trail.md'],
      common: true,
    },
    {
      command: 'job archive',
      args: '<id>|--done --older-than D',
      summary:
        'archive a finished job into .forge/archive/<id>.json (its job.json, events and a summary) and delete its job folder, after tearing down what is left of its environment; with --done --older-than D, every finished job at least D days old. A job whose teardown fails is listed in refused and kept. Stats, audit and retro still read archived jobs',
      flags: [
        ['--done', 'every finished job old enough, instead of one id'],
        ['--older-than D', 'with --done: days since the job finished (an integer, 0 or more)'],
      ],
      exits: [[1, 'not eligible, or a daemon session']],
      docs: ['Retention', 'docs/architecture/retention.md'],
      common: true,
    },
    {
      command: 'job delete',
      args: '<id> [--force]',
      summary: "delete a job started by mistake, for good: releases its tracker claim, removes its worktrees, per-job backing services and the branch Forge named for it, rejects its open requests and deletes its job folder and session logs, keeping no archive record. A job with a PR, split children or an active dependent is refused: cancel and archive real work instead",
      flags: [['--force', 'delete it even while a live interactive session owns it']],
      exits: [[1, 'no such job, not eligible (the message says why), a worktree or backing teardown that failed (rerun once fixed), or a daemon session']],
      docs: ['Deleting a job', 'docs/architecture/deleting-a-job.md'],
      common: true,
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
      docs: ['Retention', 'docs/architecture/retention.md'],
      common: true,
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
    { command: 'job decision', args: '<id>', summary: "read decision.md and record the approver's decision, its Auto-merge eligible line and the worktree HEAD it covers (head, and heads per PR member repo); once per approver run: a later call returns that record with recorded: false and logs nothing", exits: [NO_JOB] },
    {
      command: 'job score',
      args: 'record <id>',
      summary: "record the post-merge judge's score from score.md (first non-empty line `SCORE: <0-5>/5`) on a job whose score run forge sync queued; a missing or malformed file records the run as failed",
      exits: [[1, 'unknown job, nothing queued, or missing/malformed score.md']],
    },
    { command: 'job progress', args: '<id>', summary: 'tasks done and total in tasks.md', exits: [NO_JOB] },
    { command: 'job paths', args: '<id>', summary: "absolute paths of the job's files, for agent briefs", exits: [NO_JOB] },
    {
      command: 'job links',
      args: '<id>',
      summary: "the job's local links (config dependsOn links), active or not, with the dependency dir or the reason",
      exits: [NO_JOB],
      docs: ['Local links', 'docs/CONFIG.md#local-links'],
      common: true,
    },
    {
      command: 'job scope',
      args: '<id>',
      summary: "files the branch changed outside the spec's Approach, across every reviewed job repo (member paths prefixed <repo>/), plus this round's review/round-<n>/diff.patch for every job and scope.diff for a multi-repo job",
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
    {
      command: 'job acs',
      args: '<id>',
      summary: "the spec's acceptance criteria and their proof in build.md, and the rows in its file map (fileMap; a spec without one reports incomplete: [\"files\"])",
      exits: [NO_JOB],
    },
    {
      command: 'job findings',
      args: '<id>',
      summary: 'review findings per round and lens: raised, fixed, disputed and recurring (same lens and path in consecutive rounds)',
      exits: [NO_JOB],
    },
    {
      command: 'job step',
      args: '<id> [--session S] [--epoch N]',
      summary: "the job's next action (`spawn` with a ready agent brief, `run`, `wait`, `procedure` or `done`); read-only, the same state always gives the same answer, except that `--session <driver>` renews that session's lease",
      flags: [
        ['--session S', "renew session S's lease, when S drives the job"],
        ['--epoch N', 'the epoch your claim returned: refused (exit 3, stale_epoch) once another session took the job over'],
      ],
      exits: [NO_JOB, [3, 'stale_epoch: the lease moved past --epoch, or to another driver']],
      common: true,
    },
    {
      command: 'job advance',
      args: '<id> --session S [--epoch N] [--max N]',
      summary: "runs step's `run` actions in-process (at most N, default 20) and returns the next `spawn`, `wait`, `procedure` or `done` with `ran`, one line per command it ran; refuses (exit 3) a job session S does not hold, and stops at the first failed command (exit 1)",
      flags: [
        ['--session S', 'the session driving the job (required)'],
        ['--epoch N', 'the epoch your claim returned, checked at entry and after every command it runs (stale_epoch)'],
        ['--max N', 'run at most N commands (default 20)'],
      ],
      exits: [
        [1, 'no such job, or a command it ran failed (the result says which)'],
        [3, 'session S does not hold the job, or (stale_epoch) another session took it over'],
      ],
      common: true,
    },
  ],
};

export const HELP: HelpGroup[] = [JOB];
