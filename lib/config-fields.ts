// The settings schema: which config keys `forge config set` and POST /api/config may write, and
// how each one is parsed, validated and shown in the dashboard. It is an allowlist: a key is
// editable only when it can't name a command, file, module, tool or repository that Forge runs,
// loads or writes to, and can't loosen a security or attribution policy. Everything else is
// read-only here and edited by hand in .forge/config.yml.
import { defaults } from './config.ts';
import { COMPLEXITIES, EFFORT_ROLES, EFFORTS, FOREMAN_SHIP, OFFICE_GATES } from './schema.ts';
import type { ConfigField, ConfigFieldType, ConfigSection, ConfigValue } from './types.ts';
import { ForgeError, getPath } from './util.ts';
import * as yaml from './yaml.ts';

export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;
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
  assistant: 'Assistant model',
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
  assistant: 'Assistant effort',
};

export const FIELDS: ConfigField[] = [
  field('pipeline.plan', 'pipeline', 'Plan', 'Whether a request goes through the planner first.', { type: 'enum', options: ['auto', 'always', 'never'] }),
  field('pipeline.split', 'pipeline', 'Split', 'What a plan that proposes several jobs does: ask parks it for approval, auto creates the jobs, never keeps one job.', { type: 'enum', options: ['ask', 'auto', 'never'] }),
  field('pipeline.specApproval', 'pipeline', 'Spec approval', 'Which specs wait for a human before the build starts.', { type: 'enum', options: ['always', 'large', 'never'] }),
  field('pipeline.design', 'pipeline', 'Design', 'Whether UI jobs get a design reference or a mockup first.', { type: 'enum', options: ['none', 'reference', 'mockup'] }),
  field('pipeline.maxRounds', 'pipeline', 'Max rounds', 'Build and review rounds before asking a human.', { type: 'integer', min: 1, max: 20 }),
  budget('tokens', 'Token budget', 'Per-job limit on total tokens.', 'integer'),
  budget('usd', 'Cost budget (USD)', 'Per-job limit on estimated cost.', 'number'),
  budget('minutes', 'Minutes budget', 'Per-job limit on agent run time, never human waits.', 'number'),
  budget('changedLines', 'Changed lines budget', 'Per-job limit on committed lines added and deleted against the base branch.', 'integer'),
  budget('verifyRetries', 'Verify retries', 'Failed forge verify runs allowed per round beyond the first.', 'integer'),
  // Locked: warn would loosen a security gate, which the header rule keeps out of the settings.
  field('verifySecrets', 'pipeline', 'Secret scan', 'block fails verify, and refuses commits and pr open, on a likely credential; warn only reports it. Text Forge sends is always refused.', { type: 'enum', options: ['block', 'warn'], locked: 'loosens a security gate' }),
  field('worktrees.generated', 'pipeline', 'Generated files', 'Committed paths or globs a command regenerates; forge integrate rebuilds them when they conflict.', { type: 'list', locked: 'names paths a command regenerates' }),
  field('worktrees.generatedBy', 'pipeline', 'Generated by', 'The commands.* entry forge integrate runs to regenerate them, mid-merge.', { type: 'string', locked: 'names a command Forge runs' }),

  field('review.blockOn', 'review', 'Block on', 'Severities that force another round. Blocker and major always do; add minor or nit to be stricter.', { type: 'list', options: SEVERITIES, required: ['blocker', 'major'] }),
  field('review.onPrFeedback', 'review', 'On PR feedback', 'Which lenses re-run after PR feedback.', { type: 'enum', options: ['changed', 'full', 'none'] }),
  field('pr.integrationReview', 'review', 'Integration review', 'After a conflict fix: always review, or skip when only docs or generated files conflicted.', { type: 'enum', options: ['always', 'code-only'] }),
  field('review.panel', 'review', 'Panel', 'The review lenses: built-in names or .forge/reviewers/<name>.md.', { type: 'object', locked: 'lenses name checklist files and models' }),

  ...Object.keys(base.runtime.models).map((role) =>
    field(`runtime.models.${role}`, 'agents', MODEL_LABEL[role] ?? `${role} model`, 'An alias (inherit, opus, sonnet, haiku, fable) or a full model id.', { type: 'string', suggestions: MODEL_SUGGESTIONS }),
  ),
  field('runtime.maxParallelJobs', 'agents', 'Max parallel jobs', 'Jobs the orchestrator runs at once.', { type: 'integer', min: 1, max: 16 }),
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
  field('tracker.github.comments', 'tracker', 'Comments', 'Whose issue comments reach agents: collaborators or all.', { type: 'enum', options: ['collaborators', 'all'], locked: 'decides whose untrusted text reaches agents' }),
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
  // Locked: each one widens or narrows what an unattended session decides for a human.
  field('foreman.enabled', 'daemon', 'Foreman', 'The office session decides gates through assistant sub-agents, unattended.', { type: 'boolean', locked: 'turns on unattended gate decisions' }),
  field('foreman.decides', 'daemon', 'Foreman decides', 'The gate classes the foreman may decide; the rest stay with a human.', { type: 'list', options: [...OFFICE_GATES], locked: 'widens what the foreman may decide' }),
  field('foreman.reserved', 'daemon', 'Reserved topics', 'Whole-phrase patterns that keep a gate with a human when the reason, decision or note mentions them.', { type: 'list', locked: 'narrows what stays with a human' }),
  field('foreman.ship', 'daemon', 'Foreman ship', 'propose leaves merging as it is; merge counts as merge.auto for PRs the approver marks eligible.', { type: 'enum', options: [...FOREMAN_SHIP], locked: "lets the foreman's pipeline merge" }),
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
      if (f.key.startsWith('runtime.models.') && !MODEL_RE.test(value))
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
  if (f.nullable && raw === 'null') return null;
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
