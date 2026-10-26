// The settings schema: which config keys `forge config set` and POST /api/config may write, and
// how each one is parsed, validated and shown in the dashboard. It is an allowlist: a key is
// editable only when it can't name a command, file, module, tool or repository that Forge runs,
// loads or writes to, and can't loosen a security or attribution policy. Everything else is
// read-only here and edited by hand in .forge/config.yml.
// CONFIG_DISCLOSURE, at the end, is a separate map rather than a ConfigField property: it must
// classify every key (commands.* and worktrees.setup are not settings), and /api/config stays as is.
import { defaults } from './load.ts';
import { COMPLEXITIES, EFFORT_ROLES, EFFORTS, FOREMAN_SHIP, KEEP_AWAKE_MODES, MANDATE_ON_UNFINISHABLE, MANDATE_ORDERS, MANDATE_UNTIL, MODEL_RE, OFFICE_GATES } from '../job/schema.ts';
import type { Config, ConfigField, ConfigFieldType, ConfigSection, ConfigValue } from '../types.ts';
import { getPath } from '../shape.ts';
import { ForgeError } from '../errors.ts';
import * as yaml from '../format/yaml.ts';

export { MODEL_RE };
/** Keys whose value is a model alias or id, checked against MODEL_RE. */
const isModelKey = (key: string) =>
  key.startsWith('runtime.models.') ||
  key.startsWith('runtime.modelByComplexity.') ||
  key === 'runtime.reworkModel' ||
  key === 'scoring.model' ||
  key === 'foreman.model' ||
  key === 'foreman.assistants.model' ||
  key === 'foreman.surveyors.model';
const LABEL_PREFIX_RE = /^.+[:/-]$/;
const MODEL_SUGGESTIONS = ['inherit', 'opus', 'sonnet', 'haiku', 'fable'];
const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
/** Values that reach `gh` as arguments, where a leading dash would read as a flag. */
const NO_LEADING_DASH = /^tracker\.github\.(ready\.|labels\.prefix$)/;
const MAX_STRING = 200;

export type ConfigSetReason = 'unknown' | 'locked' | 'invalid' | 'uninitialized' | 'unsupported-yaml';

/** Why setConfigValue refused; the server maps `reason` to a status code. */
export class ConfigSetError extends ForgeError {
  // `declare` keeps this a type only: a plain field would become a runtime class field and show up in Object.keys.
  declare reason: ConfigSetReason;
  constructor(reason: ConfigSetReason, message: string) {
    super(message, reason === 'uninitialized' ? 'not_initialized' : 'failed');
    this.reason = reason;
  }
}

interface Spec {
  type: ConfigFieldType;
  options?: string[];
  required?: string[];
  suggestions?: string[];
  min?: number;
  minExclusive?: boolean;
  max?: number;
  nullable?: boolean;
  /** read-only, and why */
  locked?: string;
}

const base = defaults();

function field(key: string, section: ConfigSection, label: string, help: string, s: Spec): ConfigField {
  return {
    key,
    section,
    label,
    help,
    type: s.type,
    options: s.options ?? null,
    required: s.required ?? null,
    suggestions: s.suggestions ?? null,
    min: s.min ?? null,
    minExclusive: s.minExclusive ?? false,
    max: s.max ?? null,
    nullable: s.nullable ?? false,
    default: structuredClone(getPath(base, key)),
    editable: !s.locked,
    lockedReason: s.locked ?? null,
  };
}

const budget = (k: string, label: string, help: string, type: 'integer' | 'number') =>
  field(`pipeline.budget.${k}`, 'pipeline', label, `${help} Empty means unlimited.`, { type, min: 0, nullable: true });

const MODEL_LABEL: Record<string, string> = {
  orchestrator: 'Orchestrator model',
  planner: 'Planner model',
  'spec-writer': 'Spec writer model',
  designer: 'Designer model',
  builder: 'Builder model',
  reviewer: 'Reviewer model',
  approver: 'Approver model',
  integrator: 'Integrator model',
  retro: 'Retro model',
  judge: 'Judge model',
  verifier: 'Verifier model',
};

const EFFORT_LABEL: Record<(typeof EFFORT_ROLES)[number], string> = {
  planner: 'Planner effort',
  'spec-writer': 'Spec writer effort',
  designer: 'Designer effort',
  builder: 'Builder effort',
  reviewer: 'Reviewer effort',
  approver: 'Approver effort',
  integrator: 'Integrator effort',
  retro: 'Retro effort',
  judge: 'Judge effort',
};

export const FIELDS: ConfigField[] = [
  field('pipeline.plan', 'pipeline', 'Plan', 'Whether a request goes through the planner first.', { type: 'enum', options: ['auto', 'always', 'never'] }),
  field('pipeline.split', 'pipeline', 'Split', 'What a plan that proposes several jobs does: ask parks it for approval, auto creates the jobs, never keeps one job.', { type: 'enum', options: ['ask', 'auto', 'never'] }),
  field('pipeline.specApproval', 'pipeline', 'Spec approval', 'Which specs wait for a human before the build starts.', { type: 'enum', options: ['always', 'large', 'never'] }),
  field('pipeline.design', 'pipeline', 'Design', 'Whether UI jobs get a design reference or a mockup first.', { type: 'enum', options: ['none', 'reference', 'mockup'] }),
  field('pipeline.maxRounds', 'pipeline', 'Max rounds', 'Build and review rounds before asking a human.', { type: 'integer', min: 1, max: 20 }),
  field('pipeline.maxTotalRounds', 'pipeline', 'Total-round ceiling', 'Rounds of any kind, reworks by a human, the foreman or CI included, before each further round needs a person. Empty means twice max rounds.', { type: 'integer', min: 1, nullable: true }),
  budget('tokens', 'Token budget', 'Per-job limit on total tokens.', 'integer'),
  budget('usd', 'Cost budget (USD)', 'Per-job limit on estimated cost.', 'number'),
  budget('minutes', 'Minutes budget', 'Per-job limit on agent run time, never human waits.', 'number'),
  budget('changedLines', 'Changed lines budget', 'Per-job limit on committed lines added and deleted against the base branch.', 'integer'),
  budget('verifyRetries', 'Verify retries', 'Failed forge verify runs allowed per round beyond the first.', 'integer'),
  field('budget.usdPerDay', 'pipeline', 'Repo cost per day (USD)', 'Repo-wide limit on estimated cost per UTC day, across every job. Reaching it holds new work (or warns). Empty means unlimited.', { type: 'number', min: 0, nullable: true }),
  field('budget.usdPerMonth', 'pipeline', 'Repo cost per month (USD)', 'Repo-wide limit on estimated cost per UTC month, across every job. Reaching it holds new work (or warns). Empty means unlimited.', { type: 'number', min: 0, nullable: true }),
  field('budget.tokensPerMonth', 'pipeline', 'Repo tokens per month', 'Repo-wide limit on total tokens per UTC month, across every job. Empty means unlimited.', { type: 'integer', min: 0, nullable: true }),
  field('budget.onExceeded', 'pipeline', 'Over the repo budget', 'hold parks new and resumed jobs until a human acknowledges with forge budget ack or the period ends; warn only reports it.', { type: 'enum', options: ['hold', 'warn'] }),
  // Locked: warn would loosen a security gate, which the header rule keeps out of the settings.
  field('verifySecrets', 'pipeline', 'Secret scan', 'block fails verify, and refuses commits and pr open, on a likely credential; warn only reports it. Text Forge sends is always refused.', { type: 'enum', options: ['block', 'warn'], locked: 'loosens a security gate' }),
  field('merge.requiredChecks', 'pipeline', 'Required checks', "The checks the root PR's merge needs, each a name or bound to an app, workflow file or status creator. Empty: the base branch's protection names them.", { type: 'list', locked: 'emptying it loosens the merge gate' }),
  field('worktrees.generated', 'pipeline', 'Generated files', 'Committed paths or globs a command regenerates; forge integrate rebuilds them when they conflict.', { type: 'list', locked: 'names paths a command regenerates' }),
  field('worktrees.seed', 'pipeline', 'Worktree seed', 'Untracked paths a new worktree clones from a private seed while its key files match, instead of running setup.', { type: 'object', locked: 'names paths Forge writes and commands it runs' }),
  field('worktrees.generatedBy', 'pipeline', 'Generated by', 'The commands.* entry forge integrate runs to regenerate them, mid-merge.', { type: 'string', locked: 'names a command Forge runs' }),
  // Locked: both widen what the job's own code, run by verify before review, can read.
  field('commandEnv.inherit', 'pipeline', 'Command environment', 'Variable names (or * globs) configured commands get beyond the allowlist; a glob never passes a credential-like name.', { type: 'list', locked: 'widens what configured commands can read' }),
  field('commandEnv.loginShell', 'pipeline', 'Login shell', 'Run configured commands as $SHELL -lc, sourcing the login profile, instead of /bin/sh -c.', { type: 'boolean', locked: 'sources the login profile in every configured command' }),
  // Locked: the dashboard token alone must not be able to delete job files or session logs.
  field('retention.jobsDays', 'pipeline', 'Archive jobs after (days)', 'forge sync and forge dash archive finished jobs this many days old into .forge/archive/ and delete their job folders. Empty keeps them forever.', { type: 'integer', min: 1, max: 3650, nullable: true, locked: 'deletes job files' }),
  field('outcomes.windowDays', 'pipeline', 'Outcome window (days)', 'After a merge, forge sync watches this many days for a revert, follow-up bug issues and churn before the outcome is final and counts in the autonomy rate.', { type: 'integer', min: 1, max: 365 }),
  field('scoring.sample', 'pipeline', 'Score sample', 'The share of merged jobs forge sync queues for one post-merge judge run, from 0 (off) to 1 (every job). The run counts toward spend and budgets.', { type: 'number', min: 0, max: 1 }),
  field('scoring.model', 'pipeline', 'Scoring judge model', "The judge's model for post-merge score runs. Empty falls through to the judge model.", { type: 'string', nullable: true, suggestions: MODEL_SUGGESTIONS }),
  field('policy.protectedPaths', 'pipeline', 'Protected paths', 'Globs Forge refuses to write or escalates to a human; checked at forge git add/commit, verify and pr open.', { type: 'object', locked: 'names what Forge refuses to write' }),
  // Locked: the dashboard token alone must not redirect notifications or run a program.
  field('notify.webhooks', 'pipeline', 'Notification webhooks', 'URLs Forge posts a fixed-shape notification to on gates, PRs, failures and budget stops: each with url, optional events and format (json or slack).', { type: 'object', locked: 'names a URL Forge posts to' }),
  field('notify.command', 'pipeline', 'Notification command', 'A shell command Forge runs once per notification; {event}, {job}, {title}, {url}, {stage}, {reason} and {dashboardUrl} read from environment variables.', { type: 'string', nullable: true, locked: 'runs a program' }),
  // Locked: turning the check off or capping it at 0 loosens a verification gate, and skip names repositories.
  field('downstream.enabled', 'pipeline', 'Downstream verification', "A changed library's linked consumer repos join the job verify-only, and verify runs their tests against the job's changes.", { type: 'boolean', locked: "runs member repos' commands in verify" }),
  field('downstream.max', 'pipeline', 'Downstream repos per job', 'At most this many consumer repos join one job for downstream verification.', { type: 'integer', min: 0, max: 50, locked: 'caps a verification gate' }),
  field('downstream.skip', 'pipeline', 'Downstream skip', 'repos entries never added for downstream verification.', { type: 'list', locked: 'names repositories' }),

  field('review.blockOn', 'review', 'Block on', 'Severities that force another round. Blocker and major always do; add minor or nit to be stricter.', { type: 'list', options: SEVERITIES, required: ['blocker', 'major'] }),
  field('review.onPrFeedback', 'review', 'On PR feedback', 'Which lenses re-run after PR feedback.', { type: 'enum', options: ['changed', 'full', 'none'] }),
  field('review.onRework', 'review', 'On rework', 'Rounds 2 and later: narrow re-runs the always lenses, the ones that asked for changes and the ones whose paths the fix touched; full re-runs every lens.', { type: 'enum', options: ['narrow', 'full'] }),
  field('pr.integrationReview', 'review', 'Integration review', 'After a conflict fix: always review, or skip when only docs or generated files conflicted.', { type: 'enum', options: ['always', 'code-only'] }),
  field('pr.maxCiReworks', 'review', 'CI rework cap', 'CI reworks forge sync starts in a row on a red PR before the next red head waits for a person. 0 sends every red head to a person.', { type: 'integer', min: 0, max: 20 }),
  field('review.panel', 'review', 'Panel', 'The review lenses: built-in names or .forge/reviewers/<name>.md.', { type: 'object', locked: 'lenses name checklist files and models' }),

  ...Object.keys(base.runtime.models).map((role) =>
    field(`runtime.models.${role}`, 'agents', MODEL_LABEL[role] ?? `${role} model`, 'An alias (inherit, opus, sonnet, haiku, fable) or a full model id.', { type: 'string', suggestions: MODEL_SUGGESTIONS }),
  ),
  field('runtime.maxParallelJobs', 'agents', 'Max parallel jobs', 'Jobs the orchestrator runs at once.', { type: 'integer', min: 1, max: 16 }),
  // Editable: it names nothing Forge runs; a wrong value only stops (never removes) environments.
  field('environments.maxRunning', 'agents', 'Max running environments', 'Job environments running at once; starting one more stops the least recently used, never the focused job. Empty means no cap.', { type: 'integer', min: 1, max: 64, nullable: true }),
  field('runtime.diversity', 'agents', 'Model diversity', "Warn (never block) when the approver or a lens shares the builder's model family.", { type: 'boolean' }),
  // Editable: it changes how much the model thinks, never what it may do.
  field('runtime.effort', 'agents', 'Effort', "How much the model thinks: low, medium, high, xhigh or max. Daemon sessions get --effort and the orchestrator passes it to each agent; a job's own effort overrides it. Empty leaves it to Claude Code's own setting.", { type: 'enum', options: [...EFFORTS], nullable: true }),
  // Editable like runtime.effort: they change how much the model thinks, never what it may do.
  ...EFFORT_ROLES.map((role) =>
    field(`runtime.efforts.${role}`, 'agents', EFFORT_LABEL[role], "Effort for this role's agents; overrides the complexity mapping and the default effort, not a job's own. Empty falls through.", { type: 'enum', options: [...EFFORTS], nullable: true }),
  ),
  ...COMPLEXITIES.map((k) =>
    field(`runtime.effortByComplexity.${k}`, 'agents', `Effort for ${k} complexity`, `Effort for agents of a job whose spec says Complexity: ${k}, when the role has no effort of its own. Empty falls through.`, { type: 'enum', options: [...EFFORTS], nullable: true }),
  ),
  // Editable like runtime.models.builder: they pick which model builds, never what it may do.
  ...COMPLEXITIES.map((k) =>
    field(`runtime.modelByComplexity.${k}`, 'agents', `Builder model for ${k} complexity`, `The builder's model for a job whose spec says Complexity: ${k}; beats the builder model, not the review rework model. Empty falls through.`, { type: 'string', nullable: true, suggestions: MODEL_SUGGESTIONS }),
  ),
  field('runtime.reworkModel', 'agents', 'Builder model on review rework', "The builder's model on a rework round that only addresses review findings (no failed verify, PR feedback, feedback or answer). Empty falls through.", { type: 'string', nullable: true, suggestions: MODEL_SUGGESTIONS }),
  field('runtime.provider', 'agents', 'Provider', 'Informational; the roster is provider-neutral markdown.', { type: 'string', locked: 'informational' }),
  field('runtime.host', 'agents', 'Host', 'The agent host Forge runs in.', { type: 'string', locked: 'informational' }),

  field('tracker.kind', 'tracker', 'Tracker', 'local, github, none, or a custom adapter in .forge/trackers/.', { type: 'string', locked: 'selects the adapter module Forge loads and runs' }),
  field('tracker.local.path', 'tracker', 'Local backlog', 'The markdown backlog the local tracker uses.', { type: 'string', locked: 'a file Forge reads and writes' }),
  field('tracker.github.repo', 'tracker', 'GitHub repo', 'owner/name; empty means the repo the checkout resolves to.', { type: 'string', nullable: true, locked: 'points tracker writes at another repository' }),
  field('tracker.github.ready.labels', 'tracker', 'Ready labels', 'Labels an issue must all have to count as ready. One per line.', { type: 'list' }),
  field('tracker.github.ready.excludeLabels', 'tracker', 'Excluded labels', 'Labels that keep an issue out of forge next. One per line.', { type: 'list' }),
  field('tracker.github.ready.assignee', 'tracker', 'Ready assignee', 'Only issues assigned to this user, for example @me.', { type: 'string', nullable: true }),
  field('tracker.github.ready.milestone', 'tracker', 'Ready milestone', 'Only issues in this milestone.', { type: 'string', nullable: true }),
  field('tracker.github.ready.projectStatus', 'tracker', 'Ready project status', 'Only issues with this project status (needs a project).', { type: 'string', nullable: true }),
  field('tracker.github.claim.assign', 'tracker', 'Assign on claim', 'Assign the issue to you when a job claims it.', { type: 'boolean' }),
  field('tracker.github.comments', 'tracker', 'Comments', 'Whose issue and PR comments reach agents: collaborators or all.', { type: 'enum', options: ['collaborators', 'all'], locked: 'decides whose untrusted text reaches agents' }),
  field('tracker.github.statusSync', 'tracker', 'Status sync', 'How job status is mirrored on GitHub.', { type: 'enum', options: ['none', 'labels', 'project', 'both'] }),
  field('tracker.github.labels.prefix', 'tracker', 'Label prefix', 'Prefix for status labels in labels mode, for example forge:in-progress. At least 2 characters, ending in : / or -.', { type: 'string' }),
  field('tracker.github.project.config', 'tracker', 'Project config', 'File to read the project owner, number and status field from.', { type: 'string', locked: 'points status writes at a project' }),
  field('tracker.github.project.owner', 'tracker', 'Project owner', 'The project owner when not read from the config file.', { type: 'string', nullable: true, locked: 'points status writes at a project' }),
  field('tracker.github.project.number', 'tracker', 'Project number', 'The project number when not read from the config file.', { type: 'integer', nullable: true, locked: 'points status writes at a project' }),
  field('tracker.github.project.statusField', 'tracker', 'Status field', 'The project field Forge sets.', { type: 'string', locked: 'points status writes at a project' }),
  field('tracker.github.project.statusMap', 'tracker', 'Status map', 'Forge status to project option name; unset keys are matched by meaning.', { type: 'object', locked: 'points status writes at a project' }),

  field('dashboard.port', 'dashboard', 'Port', 'The port forge dash listens on. Takes effect at the next forge dash.', { type: 'integer', min: 1024, max: 65535 }),

  field('daemon.enabled', 'daemon', 'Enabled', 'forge dash starts the headless orchestrator, which spends tokens unattended.', { type: 'boolean', locked: 'turns on an unattended session' }),
  field('daemon.command', 'daemon', 'Command', 'The claude command the daemon runs, split into words without a shell.', { type: 'string', locked: 'runs a program' }),
  field('daemon.allowedTools', 'daemon', 'Allowed tools', 'Tools the unattended session may use.', { type: 'list', locked: 'grants the unattended session permissions' }),
  field('daemon.maxConcurrent', 'daemon', 'Max concurrent', 'Job sessions the daemon runs at once, besides the inbox.', { type: 'integer', min: 1, max: 16, locked: 'caps unattended job sessions' }),
  field('daemon.auth', 'daemon', 'Billing', 'What daemon sessions run on: your Claude login (subscription), or an ANTHROPIC_API_KEY exported where forge dash starts (api-key). Subscription drops the key from their environment.', { type: 'enum', options: ['subscription', 'api-key'] }),
  field('daemon.idleStopMinutes', 'daemon', 'Idle stop (minutes)', 'Stop an idle session after this long; new work resumes it. Empty means never.', { type: 'number', min: 0, minExclusive: true, nullable: true }),
  field('daemon.turnTimeoutMinutes', 'daemon', 'Turn timeout (minutes)', 'Stop a turn still running after this long; its work goes back to the inbox and the session starts again. Empty means no limit.', { type: 'number', min: 0, minExclusive: true, nullable: true }),
  field('daemon.jobBudget.tokens', 'daemon', 'Unattended job tokens', 'With the daemon on, fills the token limit of a job whose budget leaves it unset.', { type: 'integer', min: 0, nullable: true, locked: 'caps unattended spend' }),
  field('daemon.jobBudget.usd', 'daemon', 'Unattended job cost (USD)', 'With the daemon on, fills the cost limit of a job whose budget leaves it unset.', { type: 'number', min: 0, nullable: true, locked: 'caps unattended spend' }),
  field('daemon.dailyUsd.inbox', 'daemon', 'Inbox daily cap (USD)', 'Dollars per UTC day the inbox session may spend, as the supervisor meters it. At the cap it stops; start it again after midnight UTC, or raise the cap. Empty means no cap.', { type: 'number', min: 0, nullable: true, locked: 'caps unattended spend' }),
  field('daemon.dailyUsd.office', 'daemon', 'Office daily cap (USD)', "Dollars per UTC day the office session and its assistant foremen may spend together, as the supervisor meters it. At the cap it stops; start it again after midnight UTC, or raise the cap. Empty means no cap.", { type: 'number', min: 0, nullable: true, locked: 'caps unattended spend' }),
  field('daemon.dailyUsd.chat', 'daemon', 'Chat daily cap (USD)', "Dollars per UTC day every chat with the Foreman may spend together, as the supervisor meters it. At the cap a chat refuses the next message and a running one stops after its reply; send again after midnight UTC, or raise the cap. Empty means no cap.", { type: 'number', min: 0, nullable: true, locked: 'caps unattended spend' }),
  // Editable: it names no command, file or tool and loosens no policy; it only decides whether this project holds the machine awake.
  field('daemon.keepAwake', 'daemon', 'Keep awake', "Hold the machine awake while this project's pool has an active mandate or a running job at an agent stage.", { type: 'enum', options: [...KEEP_AWAKE_MODES] }),
  // Locked: each one widens or narrows what an unattended session decides for a human.
  field('retention.logsDays', 'daemon', 'Delete session logs after (days)', 'forge sync and forge dash delete daemon session logs this many days old whose session is not running. Empty keeps them forever.', { type: 'integer', min: 1, max: 3650, nullable: true, locked: 'deletes session logs' }),
  field('retention.logMaxBytes', 'daemon', 'Rotate session logs at (bytes)', 'Rotate a session log to <scope>.log.1 as soon as it reaches this size, keeping one older generation. Empty rotates only at spawn, past 20 MiB.', { type: 'integer', min: 1048576, max: 1073741824, nullable: true }),
  field('foreman.enabled', 'daemon', 'Foreman', 'Assistant foremen decide parked gates through assistant sub-agents, unattended.', { type: 'boolean', locked: 'turns on unattended gate decisions' }),
  field('foreman.decides', 'daemon', 'Foreman decides', 'The gate classes the foreman may decide; the rest stay with a human.', { type: 'list', options: [...OFFICE_GATES], locked: 'widens what the foreman may decide' }),
  field('foreman.reserved', 'daemon', 'Reserved topics', 'Whole-phrase patterns that keep a gate with a human when the reason, decision or note mentions them; a gate:<class> entry keeps that whole gate class with a human.', { type: 'list', locked: 'narrows what stays with a human' }),
  field('foreman.ship', 'daemon', 'Foreman ship', 'propose leaves merging as it is; merge counts as merge.auto for PRs the approver marks eligible; release does too, and lets a mandate run until its release.', { type: 'enum', options: [...FOREMAN_SHIP], locked: "lets the foreman's pipeline merge" }),
  // Editable like runtime.models and runtime.efforts: they pick a model and how much it thinks, never what it may do.
  field('foreman.model', 'daemon', 'Foreman model', "The office session's model when it directs work under mandates: --model on its spawn. An alias (inherit, opus, sonnet, haiku, fable) or a full model id; inherit keeps daemon.command's.", { type: 'string', suggestions: MODEL_SUGGESTIONS }),
  field('foreman.effort', 'daemon', 'Foreman effort', 'How much the office session thinks when it directs work under mandates. Empty falls through to the default effort.', { type: 'enum', options: [...EFFORTS], nullable: true }),
  field('foreman.assistants.model', 'daemon', 'Assistant model', "The model of the forge:assistant sub-agent that judges one gate for the Foreman. An alias (inherit, opus, sonnet, haiku, fable) or a full model id.", { type: 'string', suggestions: MODEL_SUGGESTIONS }),
  field('foreman.assistants.effort', 'daemon', 'Assistant effort', "Effort for the Foreman's gate assistant; a job's own effort beats it. Empty falls through to the complexity mapping, then the default effort.", { type: 'enum', options: [...EFFORTS], nullable: true }),
  field('foreman.surveyors.model', 'daemon', 'Surveyor model', "The model of the sub-agents that summarise the board for the Foreman. An alias (inherit, opus, sonnet, haiku, fable) or a full model id.", { type: 'string', suggestions: MODEL_SUGGESTIONS }),
  field('foreman.surveyors.effort', 'daemon', 'Surveyor effort', 'How much the surveyors think. Empty falls through to the default effort.', { type: 'enum', options: [...EFFORTS], nullable: true }),
  // Locked: each one paces, caps or widens unattended work.
  field('foreman.cadence', 'daemon', 'Foreman cadence (minutes)', "Minutes between the Office's passes over its mandates (budgets, stalls, closes and the next starts); a mandate stalls after its stall passes of this many minutes with no progress.", { type: 'integer', min: 1, max: 1440, locked: 'paces unattended work' }),
  field('foreman.assistants.enabled', 'daemon', 'Assistant foremen', "Assistant foremen: pool sessions that claim the Foreman's gate requests and decide them. Off leaves parked gates for a human.", { type: 'boolean', locked: 'changes who decides gates unattended' }),
  field('foreman.assistants.sessions', 'daemon', 'Assistant sessions', 'Assistant foreman sessions the pool runs at once. They count against neither max concurrent sessions nor the machine cap.', { type: 'integer', min: 1, max: 16, locked: 'caps unattended sessions' }),
  field('foreman.surveyors.enabled', 'daemon', 'Surveyors', "The Foreman summarises each mandate's board through surveyor sub-agents before it chooses what to start.", { type: 'boolean', locked: 'adds unattended sub-agents' }),
  field('foreman.mandate.until', 'daemon', 'Mandate until', "A new mandate's stop: a merge-ready PR, a merged one (needs Foreman ship: merge or release), or its finished release run (needs Foreman ship: release).", { type: 'enum', options: [...MANDATE_UNTIL], locked: 'sets where unattended work stops' }),
  field('foreman.mandate.maxJobs', 'daemon', 'Mandate jobs at once', "A new mandate's cap on its jobs running at once.", { type: 'integer', min: 1, max: 16, locked: 'caps unattended jobs' }),
  field('foreman.mandate.order', 'daemon', 'Mandate order', "How a new mandate orders its work: graph, priority or listed.", { type: 'enum', options: [...MANDATE_ORDERS], locked: 'orders unattended work' }),
  field('foreman.mandate.decides', 'daemon', 'Mandate decides', "The gate classes a new mandate delegates, always within Foreman decides.", { type: 'list', options: [...OFFICE_GATES], locked: 'widens what a mandate delegates' }),
  field('foreman.mandate.budget.usd', 'daemon', 'Mandate budget (USD)', "A new mandate's spend cap in USD.", { type: 'number', min: 0, minExclusive: true, max: 100000, locked: 'caps unattended spend' }),
  field('foreman.mandate.budget.jobs', 'daemon', 'Mandate budget (jobs)', "A new mandate's cap on the jobs it starts.", { type: 'integer', min: 1, max: 1000, locked: 'caps unattended spend' }),
  field('foreman.mandate.stall.cadences', 'daemon', 'Mandate stall (passes)', "A new mandate's passes with no progress before it counts as stalled.", { type: 'integer', min: 1, max: 100, locked: 'decides when unattended work stops' }),
  field('foreman.mandate.stall.bounces', 'daemon', 'Mandate stall (bounces)', "A new mandate's gate bounces on one job before it counts as stalled.", { type: 'integer', min: 1, max: 100, locked: 'decides when unattended work stops' }),
  field('foreman.mandate.onUnfinishable', 'daemon', 'Mandate unfinishable job', "What a new mandate does with a job it can't finish: park it or cancel it.", { type: 'enum', options: [...MANDATE_ON_UNFINISHABLE], locked: 'can cancel jobs unattended' }),
];

function hasPath(obj: any, key: string): boolean {
  let o = obj;
  for (const k of key.split('.')) {
    if (!o || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, k)) return false;
    o = o[k];
  }
  return true;
}

/** The editable field for `key`; throws ConfigSetError for an unknown or read-only key. */
export function fieldFor(key: string): ConfigField {
  if (!key || !hasPath(defaults(), key)) throw new ConfigSetError('unknown', `unknown config key "${key}"; see docs/CONFIG.md`);
  const f = FIELDS.find((x) => x.key === key);
  if (!f?.editable)
    throw new ConfigSetError('locked', `${key} is not editable with forge config set (${f?.lockedReason ?? 'not in the settings schema'}); edit .forge/config.yml by hand`);
  return f;
}

/** The rule a value must follow, for error messages. */
export function ruleFor(f: ConfigField): string {
  let rule: string;
  if (f.type === 'boolean') rule = 'true or false';
  else if (f.type === 'enum') rule = `one of ${(f.options ?? []).join(' | ')}`;
  else if (f.type === 'list') rule = f.options ? `a list of ${f.options.join(' | ')}, like [a, b]` : 'a list like [a, b]';
  else if (f.type === 'integer' || f.type === 'number') {
    const what = f.type === 'integer' ? 'an integer' : 'a number';
    const gt = f.minExclusive ? 'greater than' : 'at least';
    if (f.min !== null && f.max !== null) rule = `${what} from ${f.min} to ${f.max}`;
    else if (f.min !== null) rule = `${what} ${gt} ${f.min}`;
    else if (f.max !== null) rule = `${what} at most ${f.max}`;
    else rule = what;
  } else rule = 'text';
  return f.nullable ? `${rule}, or null` : rule;
}

/** Why a short config string is unsafe to show or pass on, or null. `f.key` picks the extra rules some keys have. */
export function stringProblem(f: Pick<ConfigField, 'key'>, s: string, what: string): string | null {
  // C0, DEL, C1, and format characters (bidi overrides, zero-width) plus the line and paragraph
  // separators, which can reorder or hide text in the diff a human reviews.
  if (/[\u0000-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/u.test(s)) return `${what} must not contain control or invisible formatting characters`;
  if (s.length > MAX_STRING) return `${what} must be at most ${MAX_STRING} characters`;
  if (NO_LEADING_DASH.test(f.key) && s.startsWith('-')) return `${what} must not start with "-"`;
  return null;
}

/** null when `value` is valid for `f`, else an English message naming the key. */
export function validateFieldValue(f: ConfigField, value: unknown): string | null {
  const bad = () => `${f.key} must be ${ruleFor(f)} (got ${JSON.stringify(value)})`;
  if (value === null) return f.nullable ? null : bad();
  switch (f.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : bad();
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || (f.type === 'integer' && !Number.isInteger(value))) return bad();
      if (f.min !== null && (f.minExclusive ? value <= f.min : value < f.min)) return bad();
      if (f.max !== null && value > f.max) return bad();
      return null;
    }
    case 'enum':
      return typeof value === 'string' && (f.options ?? []).includes(value) ? null : bad();
    case 'string': {
      if (typeof value !== 'string') return bad();
      if (!value && !f.nullable) return `${f.key} must not be empty`;
      const p = stringProblem(f, value, f.key);
      if (p) return p;
      // Forge removes every issue label that starts with the prefix, so a bare word would catch unrelated labels.
      if (f.key === 'tracker.github.labels.prefix' && !LABEL_PREFIX_RE.test(value))
        return `tracker.github.labels.prefix must be at least 2 characters and end with : / or - (got ${JSON.stringify(value)})`;
      // An empty model would pass here yet fail `forge config validate`; unset is null.
      if (isModelKey(f.key) && !MODEL_RE.test(value))
        return `${f.key} must be a model alias or id: letters, digits and . _ : - [ ] (got ${JSON.stringify(value)})`;
      return null;
    }
    case 'list': {
      if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) return bad();
      for (const item of value) {
        if (!item.trim()) return `${f.key} items must not be empty`;
        const p = stringProblem(f, item, `${f.key} item ${JSON.stringify(item)}`);
        if (p) return p;
        if (f.options && !f.options.includes(item)) return bad();
      }
      const missing = (f.required ?? []).filter((r) => !value.includes(r));
      if (missing.length) return `${f.key} must include ${(f.required ?? []).join(' and ')} (missing ${missing.join(', ')})`;
      return null;
    }
    default:
      return bad();
  }
}

/** Parses a `forge config set` argument by the field's type; throws a ForgeError naming the rule. */
export function parseCliValue(f: ConfigField, raw: string): ConfigValue {
  const bad = () => new ForgeError(`${f.key} must be ${ruleFor(f)} (got ${raw})`);
  if (f.nullable && (raw === 'null' || (raw === '' && isModelKey(f.key)))) return null;
  switch (f.type) {
    case 'boolean':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw bad();
    case 'integer':
    case 'number':
      if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
      throw bad();
    case 'list': {
      if (!raw.trim().startsWith('[')) throw bad();
      let v: unknown;
      try {
        v = yaml.parseScalar(raw, 0);
      } catch {
        throw bad();
      }
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad();
      return v as string[];
    }
    default:
      return raw;
  }
}

// ---------- disclosure: what a support bundle may show ----------

/**
 * How much a config value says about its owner: `plain` is shown in a support bundle, every other
 * class is replaced. `token` has no keys yet; it exists so a credential-bearing key needs a decision.
 */
export type Disclosure = 'plain' | 'url' | 'command' | 'path' | 'token' | 'text';

/** Keyed by dotted prefix; the longest matching prefix wins. Every key of defaults() must resolve. */
export const CONFIG_DISCLOSURE: Record<string, Disclosure> = {
  schemaVersion: 'plain',
  project: 'plain',
  'project.name': 'text',
  'project.description': 'text',
  'project.instructions': 'path',
  'project.notes': 'path',
  git: 'plain',
  worktrees: 'plain',
  'worktrees.root': 'path',
  'worktrees.copy': 'path',
  'worktrees.setup': 'command',
  'worktrees.seed': 'path',
  'worktrees.seed.setup': 'command',
  'worktrees.seed.warm': 'command',
  'worktrees.cargo.targetDir': 'path',
  'worktrees.generated': 'path',
  commands: 'command',
  commandEnv: 'plain',
  // Variable names can say what a machine has (a client's SDK, an internal service).
  'commandEnv.inherit': 'text',
  verify: 'plain',
  verifyE2e: 'plain',
  'verifyE2e.paths': 'path',
  verifyIntegrity: 'plain',
  verifySecrets: 'plain',
  ports: 'plain',
  runtime: 'plain',
  tracker: 'plain',
  'tracker.local.path': 'path',
  'tracker.github.repo': 'url',
  'tracker.github.ready.assignee': 'text',
  'tracker.github.project.config': 'path',
  'tracker.github.project.owner': 'text',
  pipeline: 'plain',
  review: 'plain',
  'review.panel': 'path',
  approver: 'plain',
  'approver.alwaysEscalate': 'text',
  // Globs and reasons are repo-specific prose, so a bundle counts them but doesn't print them.
  'policy.protectedPaths': 'text',
  pr: 'plain',
  'pr.reviewers': 'text',
  merge: 'plain',
  // Check names, workflow files and creator logins (a person's, not only a bot's) are repo-specific, so a bundle counts them but doesn't print them.
  'merge.requiredChecks': 'text',
  aiAttribution: 'plain',
  release: 'plain',
  // A release command can carry hostnames, paths or tokens like any other configured command.
  'release.command': 'command',
  resources: 'url',
  components: 'command',
  // Remotes can name private hosts and repos, so support bundles hide them like resources.
  repos: 'url',
  checkout: 'command',
  // Images, env values and urls can name private hosts or carry credentials.
  backing: 'command',
  // Env var names, keychain services, 1Password references and file paths name where credentials live.
  secrets: 'command',
  downstream: 'plain',
  infra: 'plain',
  'infra.allowed': 'command',
  'infra.notes': 'text',
  usage: 'plain',
  improve: 'plain',
  evals: 'plain',
  dashboard: 'plain',
  daemon: 'plain',
  'daemon.command': 'command',
  'daemon.allowedTools': 'command',
  foreman: 'plain',
  'foreman.reserved': 'text',
  retention: 'plain',
  environments: 'plain',
  outcomes: 'plain',
  scoring: 'plain',
  notify: 'plain',
  'notify.webhooks': 'url',
  'notify.command': 'command',
  budget: 'plain',
};

/** The class of the longest CONFIG_DISCLOSURE prefix of `key`, or null when none covers it. */
export function disclosureOf(key: string): Disclosure | null {
  let best: string | null = null;
  for (const p of Object.keys(CONFIG_DISCLOSURE)) {
    if ((key === p || key.startsWith(p + '.')) && (best === null || p.length > best.length)) best = p;
  }
  return best === null ? null : CONFIG_DISCLOSURE[best];
}

const REDACTED = '<redacted>';

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length);

/** A hidden value keeps its shape where that says nothing: empties stay, a list keeps its length. */
function hide(v: unknown): unknown {
  if (isEmpty(v)) return v;
  return Array.isArray(v) ? v.map(() => REDACTED) : REDACTED;
}

/**
 * The config with every value that is not `plain` replaced, for a support bundle. A key defaults()
 * doesn't have is hidden too, whatever its prefix says: an unknown key was never classified.
 */
export function redactedConfig(config: Config): Record<string, unknown> {
  const walk = (v: unknown, key: string): unknown => {
    if (!hasPath(base, key) || disclosureOf(key) !== 'plain') return hide(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, `${key}.${k}`);
      return out;
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) out[k] = walk(v, k);
  return out;
}
