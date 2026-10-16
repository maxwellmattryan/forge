// One supervised headless session. `forge dash` runs a pool of these (lib/daemon-pool.ts): one for
// the inbox and one per job with work. Each is a long-lived `claude -p --input-format stream-json`
// child that, whenever its pool sees new work for its scope, gets the one fixed `/forge requests`
// turn. A session never runs agents or writes job state itself: the claude child does, through the
// same claims and CLI as a human's session. docs/ARCHITECTURE.md "Daemon" and "Daemon security"
// describe the rules this file keeps.
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveLimits, exceededKeys, measureBudget } from './budget.ts';
import { TRUST_ENV, daemonProblems, defaults, loadConfig as defaultLoadConfig, trackerSymlinks, trustDigest } from './config.ts';
import { RUNNING_AGENT_MAX_MS, loadJob, markAgentsLost } from './jobs.ts';
import { PLUGIN_ROOT, paths } from './paths.ts';
import { INBOX_SCOPE, SCOPE_ENV, enqueue, validJobId, validScope } from './requests.ts';
import { EFFORTS } from './schema.ts';
import { isClaudeExecutable, now, run, sleepSync, splitWords, writeJsonAtomic } from './util.ts';
import { pidAlive } from './worktree.ts';
import type { Config, DaemonAuth, DaemonPermissionMode, DaemonPermissionPrompt, DaemonSessionState, DaemonStatus, Effort, EffortSource, ForgeRequest, JobAgent, PermissionDecision } from './types.ts';

/** What a session reports to its pool: a log line as it is written, or its new state after a change. */
export type SessionEvent = { kind: 'line'; scope: string; offset: number; line: string } | { kind: 'state'; scope: string; state: DaemonSessionState };

/** Where a session log goes: an fs.WriteStream, or a test's stand-in. */
export interface LogSink {
  write(line: string): boolean;
  on?(event: 'error', fn: (e: Error) => void): unknown;
  once?(event: 'drain', fn: () => void): unknown;
  end?(cb?: () => void): unknown;
}

/** Injection points for tests; every one defaults to the real thing. */
export interface DaemonOptions {
  spawn?: typeof nodeSpawn;
  killTree?: (child: DaemonChild, signal: NodeJS.Signals) => void;
  pollMs?: number;
  graceMs?: number;
  maxLineBytes?: number;
  rotateBytes?: number;
  env?: NodeJS.ProcessEnv;
  openLog?: (file: string) => LogSink;
  loadConfig?: (root: string, opts?: { text?: string | null }) => { config: Config };
  /** Backoff after a failed turn: first wait, and the cap it doubles up to. */
  retryMinMs?: number;
  retryMaxMs?: number;
  /** How long claude has to confirm a mode switch before the supervisor stops treating it as pending. */
  modeConfirmMs?: number;
  /** How long after its last result or agent end a job session keeps its slot from a waiting job. */
  slotGraceMs?: number;
  /** How long an idle job session may sit with agents marked running and no background task left before it gets a resume. */
  missedEndMs?: number;
  /** The host platform; the pool refuses to start on native Windows (lib/platform.ts). */
  platform?: NodeJS.Platform;
}

/** DaemonOptions with every default filled in. */
export interface SessionOptions {
  spawn: typeof nodeSpawn;
  killTree: (child: DaemonChild, signal: NodeJS.Signals) => void;
  graceMs: number;
  maxLineBytes: number;
  rotateBytes: number;
  retryMinMs: number;
  retryMaxMs: number;
  modeConfirmMs: number;
  slotGraceMs: number;
  missedEndMs: number;
  env: NodeJS.ProcessEnv;
  openLog: (file: string) => LogSink;
  readConfig: (root: string, opts?: { text?: string | null }) => { config: Config };
}

export function sessionOptions(opts: DaemonOptions = {}): SessionOptions {
  return {
    spawn: opts.spawn ?? nodeSpawn,
    killTree: opts.killTree ?? defaultKillTree,
    graceMs: opts.graceMs ?? 5000,
    maxLineBytes: opts.maxLineBytes ?? 8 * 1024 * 1024,
    rotateBytes: opts.rotateBytes ?? 20 * 1024 * 1024,
    retryMinMs: opts.retryMinMs ?? 60_000,
    retryMaxMs: opts.retryMaxMs ?? 60 * 60_000,
    modeConfirmMs: opts.modeConfirmMs ?? 15_000,
    // A review round ends a turn while its reviewers start: the grace covers the gap before they are recorded.
    slotGraceMs: opts.slotGraceMs ?? 30_000,
    // Long enough for a notification claude has queued to start its turn; short against the 45+ min stalls it ends.
    missedEndMs: opts.missedEndMs ?? 60_000,
    env: opts.env ?? process.env,
    // fd-based, so a symlink planted as <scope>.log is refused rather than followed.
    openLog: opts.openLog ?? ((file: string) => fs.createWriteStream(file, { fd: openAppend(file) })),
    readConfig: opts.loadConfig ?? defaultLoadConfig,
  };
}

/** What a session needs from its pool, which owns the trust snapshot and every repo-wide decision. */
export interface SessionContext {
  /** The trustDigest a human's pool start took. */
  trusted(): string | null;
  poolWanted(): boolean;
  config(): Config;
  /** .forge/config.yml or .forge/trackers/ changed: the pool stops every session. */
  untrusted(): void;
  /** A repo-wide refusal (config, daemon.enabled, tracker symlinks): the pool stops every session. */
  fatal(message: string): void;
  emit(e: SessionEvent): void;
  /** A turn's result arrived. */
  onResult(scope: string): void;
  /** Something freed a slot or may have left work unserved: tick. */
  poke(): void;
  /** The mode a human chose for this scope in the dashboard, or null to keep daemon.command's. */
  permissionMode(scope: string): DaemonPermissionMode | null;
  /** claude refused a switch to `mode`; `live` is the mode it still reports. */
  permissionModeRefused(scope: string, mode: DaemonPermissionMode, live: string | null): void;
  /** The --effort a spawn of `scope` gets under config `c` (resolveEffort); null level passes none. */
  effort(scope: string, c: Config): { level: Effort | null; source: EffortSource };
}

/** What the supervisor records about each child it spawned. */
interface ChildMeta {
  resume: boolean;
  stdout: boolean;
  /** a system/init was seen (claude emits one as each turn starts) */
  init: boolean;
  result: boolean;
  asked: boolean;
  /** ids its results covered */
  committed: string[];
  /** Background tasks claude listed in its latest background_tasks_changed; null until it sends one. */
  background: number | null;
}

/** A spawned session, with the supervisor's bookkeeping attached. */
export type DaemonChild = ChildProcess & { _forge: ChildMeta };

/** One scope's supervisor. The pool decides when it spawns and gets a turn; the session does the rest. */
export interface Session {
  readonly scope: string;
  readonly wanted: boolean;
  readonly running: boolean;
  readonly status: DaemonStatus;
  readonly waiting: boolean;
  readonly held: 'budget' | null;
  readonly lastError: string | null;
  readonly lastResultAt: string | null;
  /** Cached: a running agent of the job it drives keeps it (refreshKept). */
  readonly kept: 'agents' | null;
  /** Recomputes kept from job.json; emits a state frame when it changed. */
  refreshKept(): void;
  /** Why it may not be evicted for a slot now: running agents, or a result or agent end under graceMs ago. */
  keptBy(graceMs: number, at?: number): 'agents' | 'grace' | null;
  state(): DaemonSessionState;
  /** Applies this tick's pending requests for the scope: prunes, holds, and says whether any is fresh. */
  route(c: Config, pending: ForgeRequest[]): { eligible: string[]; fresh: boolean };
  /** Returns whether a child is now running. */
  spawn(c: Config, reason?: string): boolean;
  writeTurn(ids: string[]): void;
  /** Answers a pending permission prompt; false when there is none by that id (answered, or its child exited). */
  answerPermission(id: string, decision: PermissionDecision): boolean;
  /** Asks the running child to switch permission mode; false when no child runs (the next spawn takes ctx.permissionMode). */
  setPermissionMode(mode: DaemonPermissionMode): boolean;
  kill(event: string, endStdin: boolean, reason?: string): Promise<void>;
  logEvent(event: string, extra?: Record<string, unknown>): void;
  setWaiting(waiting: boolean): void;
  setWanted(wanted: boolean): void;
  /** A human (re)started it: wanted again, with a clean failure count and error. */
  reset(): void;
  recent(afterOffset?: number): { offset: number; line: string }[];
  close(): Promise<void>;
  killSync(): void;
}

/**
 * The only user message the daemon ever writes to the child's stdin; the only other lines are
 * permission answers (permissionResponse) and mode switches (modeRequest), whose only variable part
 * is a value from a fixed list. Nothing from requests, HTTP or config reaches either,
 * so inbox text can't become a prompt: the session reads requests through `forge requests`,
 * where they are fenced as data.
 */
export const TURN = Object.freeze({
  type: 'user',
  message: Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: '/forge requests' })]) }),
});
export const TURN_LINE = JSON.stringify(TURN) + '\n';

/** Request types that act on a job a budget stop may have parked. `approve` is the acknowledgement, so it is never held. */
export const HOLD_TYPES: string[] = ['resume', 'rework', 'answer', 'revise-spec'];

/**
 * Paths the session may never write, appended to every daemon command as --disallowedTools
 * whatever `daemon.command` says. Claude Code checks file writes against Edit(path) rules,
 * anchors relative paths at the session's cwd (the main checkout, so job worktrees are
 * unaffected) and lets deny beat allow. This stops the Edit/Write route only; trustDigest is the
 * check that also covers writes made through Bash (docs/ARCHITECTURE.md "Daemon security").
 */
export const DENY_TOOLS = Object.freeze(['Edit(.forge/config.yml)', 'Edit(.forge/trackers/**)', 'Edit(.forge/secrets-allow.txt)']);

/**
 * Appended to every daemon command: claude sends each permission check it would otherwise ask a
 * person about to the supervisor as a `can_use_tool` control request on stdout, and waits for the
 * answer on stdin. Under `--permission-mode dontAsk` nothing is ever asked, so nothing arrives.
 */
export const PROMPT_TOOL = Object.freeze(['--permission-prompt-tool', 'stdio']);

/**
 * The modes a human may switch one session to from the dashboard. `auto` is here but refused in
 * daemon.command (lib/config.ts SAFE_PERMISSION_MODES): a repo's config can't put every session on
 * every machine in it, but a human watching the dashboard may put one session there, for as long
 * as that `forge dash` runs. `bypassPermissions` never: claude refuses it on a session launched
 * without --dangerously-skip-permissions anyway.
 */
export const PERMISSION_MODES: readonly DaemonPermissionMode[] = Object.freeze(['default', 'auto', 'dontAsk']);

/**
 * The mode `daemon.command` starts sessions in: its --permission-mode value, with `manual` (the name
 * claude now lists for `default`, which it still accepts and reports) read as `default`. claude's own
 * default applies when the flag is absent or the template doesn't parse.
 */
export function commandPermissionMode(template: unknown): string {
  let words: string[];
  try {
    words = parseTemplate(String(template ?? ''));
  } catch {
    return 'default';
  }
  let mode = 'default';
  for (let i = 1; i < words.length; i++) {
    if (words[i] === '--permission-mode' && i + 1 < words.length) mode = words[i + 1];
    else if (words[i].startsWith('--permission-mode=')) mode = words[i].slice('--permission-mode='.length);
  }
  return mode === 'manual' ? 'default' : mode;
}

/** argv with every --permission-mode dropped and `mode` appended, so the human's choice is the one claude reads. */
export function withPermissionMode(argv: string[], mode: DaemonPermissionMode): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (i > 0 && argv[i] === '--permission-mode') i++;
    else if (i > 0 && argv[i].startsWith('--permission-mode=')) continue;
    else out.push(argv[i]);
  }
  return [...out, '--permission-mode', mode];
}

/**
 * argv with every --effort dropped and `effort` appended, so the job's or runtime.effort's level is
 * the one claude reads rather than one daemon.command already passes.
 */
export function withEffort(argv: string[], effort: Effort): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (i > 0 && argv[i] === '--effort') i++;
    else if (i > 0 && argv[i].startsWith('--effort=')) continue;
    else out.push(argv[i]);
  }
  return [...out, '--effort', effort];
}

/**
 * How much a mode lets a session do without a human, for deciding which way a switch goes. A mode
 * Forge doesn't know ranks above them all, so a switch away from it counts as a narrowing.
 */
export function modeReach(mode: string | null): number {
  if (mode === 'dontAsk' || mode === 'plan') return 0;
  if (mode === 'default' || mode === 'manual') return 1;
  if (mode === 'auto') return 2;
  return 3;
}

/** The control_request line asking claude to switch the session's permission mode. */
export function modeRequest(requestId: string, mode: DaemonPermissionMode): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } }) + '\n';
}

/** What a denied tool call returns to the agent. Fixed text: nothing a human types reaches the session. */
export const PERMISSION_DENIED =
  'A human denied this tool call from the Forge dashboard. Do not retry it or work around it with another tool: continue without it, or record what you needed and why in your output file.';
/** Prompts waiting at once per session; past this, new ones are denied without asking. */
const MAX_PROMPTS = 20;
/**
 * The longest tool input a prompt shows. It is never truncated: what the human reads is exactly
 * what an allow runs, so a longer input is denied without asking.
 */
export const PROMPT_INPUT_CHARS = 4000;
const PROMPT_TEXT_CHARS = 500;
const PROMPT_PATH_CHARS = 1000;

const cap = (v: unknown, n: number): string | null => (typeof v === 'string' && v ? (v.length > n ? `${v.slice(0, n)}…` : v) : null);
const record = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** The updatedPermissions "allow for this session" sends: claude's own suggestions, rebuilt from their checked fields. */
export interface SessionGrant {
  rules: { toolName: string; ruleContent?: string }[];
  dirs: string[];
}

/**
 * The parts of claude's `permission_suggestions` the supervisor may grant: allow rules and extra
 * directories, always for this session only. A suggestion to save rules to a settings file or to
 * change the permission mode is dropped, because either outlives the human's view of this call.
 * So is a rule that would allow a tool's every call (a bare tool name, or a wildcard-only pattern):
 * the human saw one call, and a grant that wide is a config change, not an answer to it.
 */
export function sessionGrant(suggestions: unknown): SessionGrant {
  const rules: SessionGrant['rules'] = [];
  const dirs: string[] = [];
  for (const raw of Array.isArray(suggestions) ? suggestions.slice(0, 20) : []) {
    const sug = record(raw);
    if (sug.type === 'addRules' && sug.behavior === 'allow' && Array.isArray(sug.rules)) {
      for (const r of sug.rules.slice(0, 20).map(record)) {
        if (typeof r.toolName !== 'string' || !r.toolName || r.toolName.length > 200) continue;
        if (typeof r.ruleContent !== 'string' || r.ruleContent.length > PROMPT_INPUT_CHARS || WILDCARD_RULE.test(r.ruleContent)) continue;
        rules.push({ toolName: r.toolName, ruleContent: r.ruleContent });
      }
    } else if (sug.type === 'addDirectories' && Array.isArray(sug.directories)) {
      for (const d of sug.directories.slice(0, 20)) if (typeof d === 'string' && path.isAbsolute(d) && d.length <= PROMPT_PATH_CHARS) dirs.push(d);
    }
  }
  return { rules, dirs };
}

/** A rule content that matches everything: only `*`, `:` and whitespace (`*`, `:*`, `**`). */
const WILDCARD_RULE = /^[\s*:]*$/;

/** A rule as claude's settings write it: `Bash(npm test)`, or a bare tool name. */
export function ruleText(r: { toolName: string; ruleContent?: string }): string {
  return r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`;
}

/**
 * The control_response line answering a `can_use_tool` request. An allow echoes the input claude
 * sent, unchanged; a deny carries PERMISSION_DENIED. The human picks only the decision.
 */
export function permissionResponse(requestId: string, decision: PermissionDecision, input: Record<string, unknown>, grant: SessionGrant): string {
  let response: Record<string, unknown>;
  if (decision === 'deny') response = { behavior: 'deny', message: PERMISSION_DENIED };
  else {
    response = { behavior: 'allow', updatedInput: input };
    if (decision === 'session') {
      const updates: Record<string, unknown>[] = [];
      if (grant.rules.length) updates.push({ type: 'addRules', rules: grant.rules, behavior: 'allow', destination: 'session' });
      if (grant.dirs.length) updates.push({ type: 'addDirectories', directories: grant.dirs, destination: 'session' });
      if (updates.length) response.updatedPermissions = updates;
    }
  }
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n';
}

/** Why the supervisor stopped: shown in the dashboard, so it speaks to the human. */
export const TRUST_CHANGED =
  'daemon stopped: .forge/config.yml or .forge/trackers/ changed while it was running. The session can write files in this checkout, so only a human may approve that change: review `git diff .forge/`, then start the daemon again.';

/** The summary an agent gets when its session's child exits under it. */
export const LOST_SUMMARY = 'lost: its daemon session ended';

/** The text of the resume a session queues for a missed agent end (watchMissedEnd). Fixed: nothing from job.json reaches it. */
export const MISSED_END_TEXT =
  'supervisor: claude reports no background agent left, but job.json still marks agents running. Record each one that finished with `forge job agent <id> end` (its report and task notification are earlier in this conversation; one with neither ends with --status lost), then continue the step loop.';

const RING_SIZE = 200;
/** Lines kept in memory for replay are capped like SSE frames; the session log keeps them verbatim. */
const RING_LINE_BYTES = 64 * 1024;
const STDERR_CAP = 4096;
const MAX_FAILURES = 3;
/**
 * A failed turn whose message says the account is out of quota, not that the request is broken:
 * it is retried for as long as it takes, never counted as a strike. Claude Code's wording for the
 * subscription windows and the API's 400 for a spend cap ("usage limits"), 429 and 529 all match.
 */
const LIMIT_TEXT = /usage limit|rate limit|limit reached|hit your limit|too many requests|\b429\b|overloaded|\b529\b/i;

/** The part of a `rate_limit_event` the supervisor uses: whether the last request was refused, and when the window resets. */
export interface RateLimitInfo {
  status: string;
  /** ms since the epoch */
  resetsAt: number | null;
}

/** Reads `rate_limit_info` from a `rate_limit_event` line tolerantly; the shape is Claude Code's, not a contract. */
export function parseRateLimit(info: unknown): RateLimitInfo | null {
  if (!info || typeof info !== 'object') return null;
  const r = info as Record<string, unknown>;
  if (typeof r.status !== 'string') return null;
  const raw = typeof r.resetsAt === 'number' && Number.isFinite(r.resetsAt) && r.resetsAt > 0 ? r.resetsAt : null;
  // Observed as epoch seconds; accept milliseconds too, in case that changes.
  const resetsAt = raw === null ? null : raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  return { status: r.status, resetsAt };
}

/**
 * Git config pinned for the session and everything it runs (subagents, `forge`, verify commands).
 * GIT_CONFIG_* entries outrank every config file, and the allowlist has no `git -c`, so a hook
 * or fsmonitor program the session writes into the repo (e.g. a `core.hooksPath` dir such as
 * `.githooks/`, which Claude Code doesn't protect the way it does `.git/`) never runs.
 * Drivers that only .git/config or ~/.gitconfig can define (filter, diff, merge) are left alone.
 */
export const GIT_PINS = Object.freeze([
  // The null device on every platform (\\.\nul on Windows), never a directory a hook could live in.
  ['core.hooksPath', os.devNull],
  ['core.fsmonitor', 'false'],
]);

/**
 * Variables that make claude bill an API account instead of the Claude login. `forge dash` is
 * usually started from a shell that exports one for some other tool, and a headless session
 * never asks which to use.
 */
export const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** The API_KEY_VARS that are set (non-empty) in `env`. */
export function apiKeyVars(env: NodeJS.ProcessEnv): string[] {
  return API_KEY_VARS.filter((k) => Boolean(env[k]));
}

/**
 * The child's environment: this plugin's bin/ first on PATH, git pins appended after any the
 * caller already set, a no-op editor so `git merge|rebase --continue` can't wait on a TTY, and
 * no API key unless `daemon.auth` is api-key.
 */
export function sessionEnv(env: NodeJS.ProcessEnv, auth: DaemonAuth = 'subscription'): NodeJS.ProcessEnv {
  // This plugin's bin/ goes first on PATH, so the session's `forge` is the same version as the
  // supervisor's even when another Forge install is on PATH (seen in the AC18 headless run).
  const PATH = [path.join(PLUGIN_ROOT, 'bin'), env.PATH].filter(Boolean).join(path.delimiter);
  const out: NodeJS.ProcessEnv = { ...env, PATH, FORGE_DAEMON: '1', GIT_EDITOR: 'true' };
  if (auth !== 'api-key') for (const k of API_KEY_VARS) delete out[k];
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  const base = Number.isInteger(count) && count > 0 ? count : 0;
  GIT_PINS.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${base + i}`] = key;
    out[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(base + GIT_PINS.length);
  return out;
}

/** `daemon.command` split into words; see splitWords in lib/util.ts. */
export function parseTemplate(template: string): string[] {
  return splitWords(template, 'daemon.command');
}

/**
 * Placeholders expand after splitting, so a plugin path with spaces stays one argument.
 * DENY_TOOLS and PROMPT_TOOL always follow the template.
 */
export function buildArgv(
  template: string,
  vars: { pluginRoot: string; session: { id: string; resume: boolean }; allowedTools: string[]; permissionMode?: DaemonPermissionMode | null; effort?: Effort | null },
): string[] {
  const tools = (vars.allowedTools ?? []).join(',');
  let argv = parseTemplate(template).flatMap((tok) => {
    if (tok === '{session}') return [vars.session.resume ? '--resume' : '--session-id', vars.session.id];
    return [tok.replaceAll('{pluginRoot}', vars.pluginRoot).replaceAll('{allowedTools}', tools)];
  });
  if (vars.permissionMode) argv = withPermissionMode(argv, vars.permissionMode);
  // Checked again here, not only by resolveEffort: anything outside the fixed list never becomes a word of argv.
  if (vars.effort && (EFFORTS as readonly unknown[]).includes(vars.effort)) argv = withEffort(argv, vars.effort);
  return [...argv, '--disallowedTools', DENY_TOOLS.join(','), ...PROMPT_TOOL];
}

/**
 * A request is held while its job is parked on a budget that is still exceeded; once a human
 * raises or acknowledges it, the request becomes eligible on the next tick.
 */
export function heldByBudget(root: string, config: Config, rec: { type: string; job: string | null }): boolean {
  if (!HOLD_TYPES.includes(rec?.type) || !validJobId(rec.job)) return false;
  let job;
  try {
    job = loadJob(root, rec.job);
  } catch {
    return false;
  }
  if (job.state !== 'waiting' || job.waitingOn !== 'budget') return false;
  return exceededKeys(effectiveLimits(config, job), measureBudget(job), job.budget.ack, job.round).length > 0;
}

/** What a job session's agents say about keeping it: sessionAgents. */
export interface SessionAgents {
  /** Roles of its owned agents marked running, sorted. */
  running: string[];
  /** A running agent started under RUNNING_AGENT_MAX_MS ago: the session keeps its slot and isn't idle-stopped. */
  keeps: boolean;
  /** The latest endedAt across its owned agents, whatever their status. */
  lastEndAt: string | null;
  /** `role@startedAt` of each running agent that keeps it, sorted: one agent run, across rounds. */
  keeping: string[];
}

const noAgents = (): SessionAgents => ({ running: [], keeps: false, lastEndAt: null, keeping: [] });
/**
 * How far ahead of now a job.json time may be and still count (clock skew between writers).
 * job.json is the session's own to write, so a time further ahead is ignored: a future startedAt
 * would otherwise dodge the RUNNING_AGENT_MAX_MS ceiling, and a future endedAt would hold the grace
 * (and the idle window) open for as long as it says.
 */
const CLOCK_SKEW_MS = 60_000;

/**
 * The agents a job session drives: those in its job.json, only while the job's owner is this
 * session. Another owner's agents (a human's terminal session, say), the inbox, and a missing or
 * unreadable job all give none, so a session can never be kept, or have agents marked lost, on
 * the strength of agents it doesn't drive. A running agent keeps it only for RUNNING_AGENT_MAX_MS
 * after its start, the ceiling ownerStatus uses, so a phantom can't hold a slot forever.
 */
export function sessionAgents(root: string, scope: string, sessionId: string | null, at = Date.now()): SessionAgents {
  // The office's scope is not a job id either, so it never has agents to keep it.
  if (scope === INBOX_SCOPE || !validJobId(scope) || !sessionId) return noAgents();
  let job;
  try {
    job = loadJob(root, scope);
  } catch {
    return noAgents();
  }
  if (job.owner?.session !== sessionId) return noAgents();
  const running: string[] = [];
  const keeping: string[] = [];
  let lastEnd = -Infinity;
  let lastEndAt: string | null = null;
  for (const [role, a] of Object.entries(job.agents ?? {}) as [string, JobAgent | undefined][]) {
    if (a?.status === 'running') {
      running.push(role);
      const started = typeof a.startedAt === 'string' ? Date.parse(a.startedAt) : NaN;
      if (Number.isFinite(started) && started <= at + CLOCK_SKEW_MS && at - started < RUNNING_AGENT_MAX_MS) keeping.push(`${role}@${a.startedAt}`);
    }
    const endedAt = a?.endedAt;
    const ended = typeof endedAt === 'string' ? Date.parse(endedAt) : NaN;
    if (Number.isFinite(ended) && ended <= at + CLOCK_SKEW_MS && ended > lastEnd) {
      lastEnd = ended;
      lastEndAt = endedAt!;
    }
  }
  return { running: running.sort(), keeps: keeping.length > 0, lastEndAt, keeping: keeping.sort() };
}

function defaultKillTree(child: DaemonChild, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') return void child.kill(signal);
  // The child leads its own group (detached), so the group signal reaches whatever it started.
  // A child without a pid never spawned, and its error handler drops it before anything kills it.
  try {
    process.kill(-child.pid!, signal);
  } catch {
    try {
      process.kill(child.pid!, signal);
    } catch {}
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}

function appendLine(file: string, line: unknown): void {
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = openAppend(file);
    fs.writeSync(fd, JSON.stringify(line) + '\n');
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many replaced session ids a record remembers, so a job claimed by an old incarnation can be handed on. */
export const MAX_PAST_SESSION_IDS = 20;

/**
 * The record after its session id becomes `next`: the old id (a uuid only, since the record is a
 * local file anyone with repo access can edit) joins `pastSessionIds`, deduped and capped. A record
 * runs one child at a time, so a past id names a session that has exited (lib/daemon-owner.ts).
 */
export function withSessionId(info: any, next: string): any {
  const kept = [...(Array.isArray(info.pastSessionIds) ? info.pastSessionIds : []), info.sessionId].filter((s: unknown): s is string => typeof s === 'string' && UUID.test(s) && s !== next);
  // Deduped keeping each id's latest position, so the cap drops the oldest.
  const past = kept.filter((s, i) => kept.lastIndexOf(s) === i);
  return { ...info, sessionId: next, pastSessionIds: past.slice(-MAX_PAST_SESSION_IDS) };
}

/** How far the process's start time may be from the recorded `startedAt` (ps reports whole seconds). */
const START_SLACK_MS = 30_000;

/**
 * Whether `pid` is provably the claude child a supervisor recorded in a session record. That file
 * lives in the repo's runtime dir, so it is checked rather than trusted: the process must lead
 * its own group (we spawn detached), not be us or our group, have started when the record says,
 * and run the recorded claude executable with the recorded session uuid as its session flag.
 */
export function isOurChild(info: any, pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const ids = [info.sessionId, info.spawnSessionId].filter((s) => typeof s === 'string' && UUID.test(s));
  if (!ids.length || typeof info.argv0 !== 'string' || !isClaudeExecutable(info.argv0) || !Date.parse(info.startedAt)) return false;
  const ps = run('ps', ['-o', 'pgid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { allowFail: true });
  const m = ps.ok ? /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/s.exec(ps.stdout.trim()) : null;
  if (!m || Number(m[1]) !== pid) return false;
  const own = run('ps', ['-o', 'pgid=', '-p', String(process.pid)], { allowFail: true });
  if (!own.ok || Number(own.stdout.trim()) === pid) return false;
  const started = Date.parse(m[2]);
  if (!Number.isFinite(started) || Math.abs(started - Date.parse(info.startedAt)) > START_SLACK_MS) return false;
  const command = m[3].trim();
  const words = command.split(/\s+/);
  const exeOk = path.isAbsolute(info.argv0) ? `${command} `.includes(`${info.argv0} `) : words.some((w) => path.basename(w) === info.argv0);
  if (!exeOk) return false;
  return ids.some((id) => words.some((w, i) => (w === '--session-id' || w === '--resume') && words[i + 1] === id));
}

/**
 * A scope's runtime files. The scope is checked first, so no path is ever built from an
 * unvalidated one.
 */
export function sessionFiles(root: string, scope: string): { dir: string; info: string; log: string } {
  if (!validScope(scope)) throw new Error(`invalid daemon scope ${JSON.stringify(String(scope).slice(0, 80))}`);
  const dir = daemonsDir(root);
  return { dir, info: path.join(dir, `${scope}.json`), log: path.join(dir, `${scope}.log`) };
}

export function daemonsDir(root: string): string {
  return path.join(paths(root).runtime, 'daemons');
}

/** The one-session daemon's record, from before the pool: reaped, then never used again. */
function legacyFiles(root: string): { info: string; log: string } {
  const dir = paths(root).runtime;
  return { info: path.join(dir, 'daemon.json'), log: path.join(dir, 'daemon.log') };
}

const MAX_RECORD = 64 * 1024;
/** Open flags for runtime files something else may have planted: never follow a link, never block on a FIFO. */
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * A session record, or {} for anything else: a missing, corrupt, oversized or non-regular file
 * (a FIFO or symlink planted in the runtime dir must not hang or redirect the server). Read
 * through one descriptor opened without following links or blocking.
 */
export function readInfo(file: string): any {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RECORD) return {};
    const v = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Opens a log for appending without following a planted symlink or blocking on a planted FIFO
 * (a write-only open of a FIFO with no reader would wait forever on the server's event loop; with
 * O_NONBLOCK it fails with ENXIO). Anything but a regular file is closed and refused.
 */
export function openAppend(file: string): number {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW | NONBLOCK, 0o644);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  return fd;
}

/** Opens a log for reading without following a planted symlink or blocking on a FIFO; refuses non-files. */
export function openRead(file: string): number {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  return fd;
}

/** The record is a local file anyone with repo access can edit: logBase must be a sane byte count. */
export function logBaseOf(info: any): number {
  const n = info?.logBase;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Every session record `forge dash` may have left: `daemons/<scope>.json` for valid scopes,
 * regular files only (a planted symlink is skipped), sorted by scope.
 */
export function sessionRecords(root: string): { scope: string; info: string; log: string }[] {
  const dir = daemonsDir(root);
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((e) => e.isFile() && e.name.endsWith('.json') && validScope(e.name.slice(0, -5)))
    .map((e) => e.name.slice(0, -5))
    .sort()
    .map((scope) => ({ scope, ...sessionFiles(root, scope) }));
}

/** A live `forge dash` other than this process that recorded itself in any session record. */
export function otherOwner(root: string): number | null {
  for (const file of [legacyFiles(root).info, ...sessionRecords(root).map((r) => r.info)]) {
    const pid = readInfo(file).serverPid;
    if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) return pid;
  }
  return null;
}

function reapOne(info: any, graceMs: number): number | null {
  const pid = info.pid;
  if (!Number.isInteger(pid)) return null;
  const serverGone = !info.serverPid || info.serverPid === process.pid || !pidAlive(info.serverPid);
  if (!serverGone || !pidAlive(pid) || !isOurChild(info, pid)) return null;
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(50);
  if (pidAlive(pid)) signalGroup(pid, 'SIGKILL');
  return pid;
}

/**
 * Children left behind by a `forge dash` that died without stopping them. Each record (the legacy
 * daemon.json and every daemons/<scope>.json) is proven on its own: only when its server is gone,
 * its child is alive, and isOurChild proves it is the claude process the record describes, so a
 * reused or planted pid is never signalled.
 */
export function reapOrphans(root: string, opts: { graceMs?: number } = {}): { reaped: number[] } {
  const reaped: number[] = [];
  if (process.platform === 'win32') return { reaped };
  const graceMs = opts.graceMs ?? 5000;
  const legacy = legacyFiles(root);
  const old = readInfo(legacy.info);
  const pid = reapOne(old, graceMs);
  if (pid !== null) {
    reaped.push(pid);
    // daemon.log is never read again, so the note goes to the inbox log.
    appendLine(sessionFiles(root, '_inbox').log, { type: 'forge-daemon', at: now(), event: 'reaped', pid, record: 'daemon.json' });
    writeJsonAtomic(legacy.info, { ...old, pid: null });
  }
  for (const r of sessionRecords(root)) {
    const info = readInfo(r.info);
    const p = reapOne(info, graceMs);
    if (p === null) continue;
    reaped.push(p);
    appendLine(r.log, { type: 'forge-daemon', at: now(), event: 'reaped', pid: p });
    writeJsonAtomic(r.info, { ...info, pid: null });
  }
  return { reaped };
}

export function createSession(root: string, scope: string, ctx: SessionContext, o: SessionOptions): Session {
  const f = sessionFiles(root, scope);
  let info: any = { sessionId: null, resumable: false, pid: null, serverPid: null, argv0: null, startedAt: null, lastTurnAt: null, ...readInfo(f.info) };
  info.logBase = logBaseOf(info);

  let wanted = true;
  let status: DaemonStatus = 'off';
  let child: DaemonChild | null = null;
  let turns = 0;
  let lastResultAt: string | null = null;
  let lastError: string | null = null;
  let held: 'budget' | null = null;
  let waiting = false;
  let failures = 0;
  /** Request ids a working turn has already covered; pruned to ids still pending. */
  const committed = new Set<string>();
  let inFlight: string[] = [];
  /** No turn is written before this time (ms): set by a failed turn, cleared by a working one or a human start. */
  let retryAt: number | null = null;
  /** Failed turns in a row (any kind): the backoff exponent. */
  let turnFailures = 0;
  /** Failed turns in a row that were not a quota limit: at MAX_FAILURES the session stops wanting itself. */
  let strikes = 0;
  /** The last rate_limit_event of the turn in flight. */
  let rateLimit: RateLimitInfo | null = null;
  let sink: LogSink | null = null;
  /** Offset of the next line: logBase plus its byte position in <scope>.log. */
  let pos = info.logBase;
  const ring: { offset: number; line: string }[] = [];
  let idleTimer: NodeJS.Timeout | null = null;
  /** When the idle timer was last armed (spawn or result), in ms. */
  let idleSince = 0;
  /** Last computed by refreshKept: running agents of its job keep it. */
  let kept: 'agents' | null = null;
  let closed = false;
  /** Permission prompts waiting on a human, by the supervisor's id, oldest first. */
  const prompts = new Map<string, { proc: DaemonChild; requestId: string; input: Record<string, unknown>; grant: SessionGrant; prompt: DaemonPermissionPrompt }>();
  /**
   * The mode the current child runs in: the one it was launched with until claude reports one (it
   * does so only at its first turn's init), then claude's word. Never null while a child runs, so a
   * refused switch can't make the pool forget a more permissive launch mode.
   */
  let liveMode: string | null = null;
  /** Mode switches sent to the current child and not yet answered, by request id, each with its confirmation deadline. */
  const modeRequests = new Map<string, { mode: DaemonPermissionMode; timer: NodeJS.Timeout }>();
  /** The --effort the current child was spawned with (null: none passed). A later change waits for the next spawn. */
  let spawnEffort: Effort | null = null;
  let missedTimer: NodeJS.Timeout | null = null;
  /** The `keeping` a missed-end resume was last queued for, so one stuck set of agent runs gets one. */
  let nudged: string | null = null;

  // Never recreate a repo that was deleted under a running supervisor (or a test's temp repo).
  const persist = () => {
    if (fs.existsSync(root)) writeJsonAtomic(f.info, info);
  };
  const changed = () => ctx.emit({ kind: 'state', scope, state: state() });

  function logSink(): LogSink {
    if (!sink) {
      if (!fs.existsSync(root)) return { write: () => true };
      fs.mkdirSync(f.dir, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(f.log).size;
      } catch {}
      pos = info.logBase + size;
      try {
        sink = o.openLog(f.log);
      } catch {
        // A symlink or non-file planted as the log: keep supervising, just without the file.
        sink = { write: () => true };
      }
      sink.on?.('error', () => {});
    }
    return sink;
  }

  /** Appends one line to the session log and the replay ring; returns the sink's write() result. */
  function logLine(line: string): boolean {
    const s = logSink();
    const offset = pos;
    const ok = s.write(line + '\n');
    pos += Buffer.byteLength(line) + 1;
    ring.push({ offset, line: capLine(line) });
    if (ring.length > RING_SIZE) ring.shift();
    ctx.emit({ kind: 'line', scope, offset, line });
    return ok;
  }

  const logEvent = (event: string, extra: Record<string, unknown> = {}) => void logLine(JSON.stringify({ type: 'forge-daemon', at: now(), event, ...extra }));

  function state(): DaemonSessionState {
    return {
      scope,
      wanted,
      running: Boolean(child),
      status,
      sessionId: info.sessionId ?? null,
      pid: child?.pid ?? null,
      lastTurnAt: info.lastTurnAt ?? null,
      lastResultAt,
      turns,
      failures,
      held,
      waiting,
      lastError,
      permissions: [...prompts.values()].map((p) => p.prompt),
      permissionMode: child ? liveMode : null,
      kept,
      effort: child ? spawnEffort : null,
    };
  }

  const agents = (at?: number) => sessionAgents(root, scope, typeof info.sessionId === 'string' ? info.sessionId : null, at);

  function computeKept(): 'agents' | null {
    return child && status !== 'stopping' && agents().keeps ? 'agents' : null;
  }

  function refreshKept(): void {
    const next = computeKept();
    if (next === kept) return;
    kept = next;
    changed();
  }

  /**
   * The child is gone, so every agent it drove is too: marking them lost lets the next session's
   * step respawn or retry them instead of waiting on phantoms. Only agents of a job this session
   * owns (sessionAgents), so another driver's agents are never touched. Never throws: an exit
   * must finish whatever job.json says.
   */
  function loseAgents(): void {
    if (!fs.existsSync(root)) return;
    try {
      const { running } = agents();
      if (!running.length) return;
      let cfg: Config;
      try {
        cfg = o.readConfig(root).config;
      } catch {
        cfg = defaults();
      }
      const roles = markAgentsLost(root, scope, running, LOST_SUMMARY, cfg, info.sessionId);
      if (roles.length) logEvent('agents-lost', { roles });
    } catch (e) {
      logEvent('error', { message: `marking agents lost: ${(e as Error).message}` });
    }
  }

  function keptBy(graceMs: number, at = Date.now()): 'agents' | 'grace' | null {
    const a = agents(at);
    if (a.keeps) return 'agents';
    const times = [lastResultAt, a.lastEndAt].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
    return times.length && at - Math.max(...times) < graceMs ? 'grace' : null;
  }

  /** Its child is gone, so nothing can answer them, and nothing it reported about its mode holds. */
  function dropPrompts(): void {
    prompts.clear();
    clearModeRequests();
    liveMode = null;
  }

  function clearModeRequests(): void {
    for (const r of modeRequests.values()) clearTimeout(r.timer);
    modeRequests.clear();
  }

  function writeControl(proc: DaemonChild, line: string): void {
    proc.stdin?.write(line);
  }

  /**
   * A `control_request` from claude. `can_use_tool` becomes a prompt the dashboard shows until a
   * human answers it; claude sends no other subtype unless asked to, so any other gets an error
   * rather than leaving claude waiting.
   */
  function onControl(proc: DaemonChild, ev: Record<string, any>): void {
    const requestId = ev.request_id;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) return void logEvent('error', { message: 'ignored a control_request without a usable request_id' });
    const req = record(ev.request);
    if (req.subtype !== 'can_use_tool') {
      const error = `forge does not handle ${String(req.subtype).slice(0, 40)} control requests`;
      return writeControl(proc, JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }) + '\n');
    }
    const tool = cap(req.tool_name, 200) ?? 'unknown';
    const input = record(req.input);
    const deny = (reason: string) => {
      logEvent('permission', { tool, decision: 'deny', reason });
      writeControl(proc, permissionResponse(requestId, 'deny', input, { rules: [], dirs: [] }));
    };
    if (prompts.size >= MAX_PROMPTS) return deny('too-many');
    let json: string | undefined;
    try {
      json = JSON.stringify(input);
    } catch {}
    // The dashboard must show the whole input, because an allow runs all of it: a call it can't show
    // whole is refused rather than shown cut short, and so is one whose tool name was cut.
    if (typeof json !== 'string') return deny('unserialisable-input');
    if (json.length > PROMPT_INPUT_CHARS) return deny('too-large');
    if (tool === 'unknown' || tool.endsWith('…')) return deny('unusable-tool-name');
    const grant = sessionGrant(req.permission_suggestions);
    const id = crypto.randomUUID();
    const prompt: DaemonPermissionPrompt = {
      id,
      tool,
      input: json,
      description: cap(req.description, PROMPT_TEXT_CHARS),
      agentId: cap(req.agent_id, 64),
      blockedPath: cap(req.blocked_path, PROMPT_PATH_CHARS),
      sessionRules: grant.rules.map(ruleText),
      sessionDirs: grant.dirs,
      at: now(),
    };
    prompts.set(id, { proc, requestId, input, grant, prompt });
    logEvent('permission-asked', { id, tool });
    changed();
  }

  /** claude withdrew a request (its turn was interrupted): the prompt goes away unanswered. */
  function onControlCancel(ev: Record<string, any>): void {
    for (const [id, p] of prompts) {
      if (p.requestId !== ev.request_id) continue;
      prompts.delete(id);
      logEvent('permission-cancelled', { id, tool: p.prompt.tool });
      changed();
    }
  }

  function setPermissionMode(mode: DaemonPermissionMode): boolean {
    if (!child || !PERMISSION_MODES.includes(mode)) return false;
    const requestId = `forge-mode-${crypto.randomUUID()}`;
    const proc = child;
    const timer = setTimeout(() => {
      if (!modeRequests.delete(requestId) || child !== proc) return;
      modeFailed(mode, `claude did not confirm permission mode ${mode}`);
    }, o.modeConfirmMs);
    timer.unref?.();
    modeRequests.set(requestId, { mode, timer });
    writeControl(child, modeRequest(requestId, mode));
    logEvent('permission-mode-requested', { mode });
    return true;
  }

  /** claude's answer to a control_request the supervisor sent: only mode switches are ever sent. */
  function onControlResponse(ev: Record<string, any>): void {
    const res = record(ev.response);
    const requestId = res.request_id;
    if (typeof requestId !== 'string') return;
    const pending = modeRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    modeRequests.delete(requestId);
    const { mode } = pending;
    if (res.subtype === 'success') return void logEvent('permission-mode', { mode });
    modeFailed(mode, `claude refused permission mode ${mode}: ${cap(res.error, PROMPT_TEXT_CHARS) ?? 'no reason given'}`);
  }

  /**
   * A switch claude refused or never confirmed. One that would have widened the session falls back:
   * the dashboard shows the mode the session still runs in. One that would have narrowed it stops
   * the child instead, so the session never keeps more reach than the human chose: its next spawn
   * starts in the chosen mode.
   */
  function modeFailed(mode: DaemonPermissionMode, why: string): void {
    if (modeReach(mode) < modeReach(liveMode)) {
      logEvent('error', { message: `${why}; stopping the session so it starts in ${mode}` });
      void kill('stop', true, 'permission-mode');
      return;
    }
    logEvent('error', { message: why });
    ctx.permissionModeRefused(scope, mode, liveMode);
    changed();
  }

  function answerPermission(id: string, decision: PermissionDecision): boolean {
    const p = prompts.get(id);
    if (!p || p.proc !== child) return false;
    prompts.delete(id);
    writeControl(p.proc, permissionResponse(p.requestId, decision, p.input, p.grant));
    logEvent('permission', { id, tool: p.prompt.tool, decision });
    changed();
    return true;
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle(c: Config): void {
    clearIdle();
    const minutes = c?.daemon?.idleStopMinutes;
    if (typeof minutes !== 'number' || !(minutes > 0)) return;
    idleSince = Date.now();
    idleAfter(minutes * 60_000, minutes * 60_000);
  }

  /**
   * The window counts from the later of the arming and the last agent end, and never runs out while
   * an agent keeps the session: an orchestrator waiting on background reviewers is idle, not done.
   */
  function idleAfter(delay: number, ms: number): void {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (status !== 'idle' || !child) return;
      const a = agents();
      if (a.keeps) return idleAfter(ms, ms);
      const end = a.lastEndAt ? Date.parse(a.lastEndAt) : NaN;
      const left = Math.max(idleSince, Number.isFinite(end) ? end : 0) + ms - Date.now();
      // Never longer than the window, so no job.json time can push setTimeout past its 2^31-1 ms limit.
      if (left > 0) return idleAfter(Math.min(left, ms), ms);
      void kill('idle-stop', true, 'idle');
    }, delay);
    idleTimer.unref?.();
  }

  function clearMissed(): void {
    if (missedTimer) clearTimeout(missedTimer);
    missedTimer = null;
  }

  /**
   * Claude Code delivers a finished background agent as two queued messages, its report and its
   * task notification, and can dequeue the second into an empty result the model never sees
   * (num_turns 0; seen on 2.1.299). An orchestrator that ended the report's turn waiting for the
   * notification then waits for good. So an idle child that lists no background task while its job
   * still has agents running has nothing left to wake it: after missedEndMs the session queues its
   * job a resume, once per stuck set of agent runs, and the pool turns it like any other request.
   */
  function watchMissedEnd(proc: DaemonChild): void {
    clearMissed();
    if (status !== 'idle' || proc._forge.background !== 0 || !agents().keeps) return;
    missedTimer = setTimeout(() => {
      missedTimer = null;
      if (closed || child !== proc || status !== 'idle' || proc._forge.background !== 0 || !fs.existsSync(root)) return;
      const a = agents();
      const key = a.keeping.join(',');
      if (!a.keeps || key === nudged) return;
      try {
        const rec = enqueue(root, null, { type: 'resume', job: scope, text: MISSED_END_TEXT, from: 'daemon:supervisor' });
        // Only after it queued: a failed enqueue leaves the set eligible for the next idle result.
        nudged = key;
        logEvent('missed-agent-end', { roles: a.running, request: rec.id });
      } catch (e) {
        return void logEvent('error', { message: `queueing a resume for a missed agent end: ${(e as Error).message}` });
      }
      ctx.poke();
    }, o.missedEndMs);
    missedTimer.unref?.();
  }

  /** This session can't start (its executable is missing, say): stop wanting it, and only it. */
  function sessionFatal(message: string): void {
    wanted = false;
    status = 'off';
    lastError = message;
    logEvent('error', { message });
    changed();
  }

  function rotate() {
    let size: number;
    try {
      size = fs.statSync(f.log).size;
    } catch {
      return;
    }
    // An open sink may still hold writes the file doesn't show yet; offsets must count them.
    if (sink) size = Math.max(size, pos - info.logBase);
    if (size <= o.rotateBytes) return;
    if (sink) {
      sink.end?.();
      sink = null;
    }
    try {
      fs.renameSync(f.log, `${f.log}.1`);
    } catch {
      return;
    }
    info = { ...info, logBase: info.logBase + size };
    pos = info.logBase;
    persist();
  }

  function spawnChild(c: Config, reason?: string): boolean {
    if (child) return true;
    if (closed) return false;
    const links = trackerSymlinks(root);
    if (links.length) {
      ctx.fatal(`cannot start daemon: .forge/trackers/ contains symlinks (${links.join(', ')}), whose targets the daemon can't pin; replace them with files`);
      return false;
    }
    // Respawns (idle stop, resume failure, new work) happen without a human, so they reuse the
    // pool start's snapshot. config.yml is read once, hashed, and that same text is what argv is
    // built from: a file swapped and restored between two reads (by a job's background process,
    // say) can't slip in.
    let bytes: Buffer | null = null;
    try {
      bytes = fs.readFileSync(paths(root).config);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') bytes = Buffer.from(`!${(e as NodeJS.ErrnoException).code}`);
    }
    const trusted = ctx.trusted();
    if (!trusted || trustDigest(root, bytes) !== trusted) {
      ctx.untrusted();
      return false;
    }
    try {
      c = o.readConfig(root, { text: bytes === null ? null : bytes.toString('utf8') }).config;
    } catch (e) {
      ctx.fatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    if (c.daemon?.enabled !== true) {
      ctx.fatal('daemon.enabled is false in .forge/config.yml');
      return false;
    }
    const problem = daemonProblems(c, root)[0];
    if (problem) {
      ctx.fatal(problem);
      return false;
    }
    rotate();
    // The record is a local file anyone with repo access can edit; only a uuid may follow --resume.
    const resume = Boolean(info.resumable && typeof info.sessionId === 'string' && UUID.test(info.sessionId));
    if (!resume) info = { ...withSessionId(info, crypto.randomUUID()), resumable: false };
    let argv;
    const launchMode = ctx.permissionMode(scope);
    // From the config bytes just hashed (never a second read) and the job.json read now, so a change made since the last spawn applies.
    const effort = ctx.effort(scope, c);
    try {
      argv = buildArgv(c.daemon.command, { pluginRoot: PLUGIN_ROOT, session: { id: info.sessionId, resume }, allowedTools: c.daemon.allowedTools, permissionMode: launchMode, effort: effort.level });
    } catch (e) {
      ctx.fatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    let c2;
    try {
      // The scope reaches the session only through its environment, never stdin or argv.
      c2 = o.spawn(argv[0], argv.slice(1), { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...sessionEnv(o.env, c.daemon.auth), [TRUST_ENV]: trusted, [SCOPE_ENV]: scope } });
    } catch (e) {
      sessionFatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    // _forge is attached on the next lines, before anything reads it.
    const proc = c2 as DaemonChild;
    child = proc;
    status = 'idle';
    waiting = false;
    liveMode = launchMode ?? commandPermissionMode(c.daemon.command);
    spawnEffort = effort.level;
    clearModeRequests();
    const meta: ChildMeta = { resume, stdout: false, init: false, result: false, asked: false, committed: [], background: null };
    proc._forge = meta;
    info = { ...info, pid: proc.pid ?? null, serverPid: process.pid, argv0: argv[0], startedAt: now(), spawnSessionId: info.sessionId };
    persist();
    logEvent('spawn', { pid: proc.pid ?? null, sessionId: info.sessionId, resume, ...(reason ? { reason } : {}) });
    logEvent('effort', { level: effort.level ?? 'inherit', source: effort.source });
    const keys = apiKeyVars(o.env);
    if (keys.length) logEvent('auth', { auth: c.daemon.auth, vars: keys, passed: c.daemon.auth === 'api-key' });

    proc.on('error', (e: Error) => {
      if (child !== proc) return;
      if (!proc.pid) {
        // Never started (ENOENT, EACCES): retrying can't help, so stop wanting this session.
        child = null;
        clearIdle();
        clearMissed();
        inFlight = [];
        info = { ...info, pid: null };
        persist();
        sessionFatal(`cannot start daemon: ${e.message}`);
      } else logEvent('error', { message: e.message });
    });
    // EPIPE on a child that died mid-write must not take the server down.
    proc.stdin?.on('error', (e: Error) => {
      if (child === proc) logEvent('error', { message: `stdin: ${e.message}` });
    });
    proc.stdout?.on(
      'data',
      splitter(o.maxLineBytes, (line) => onStdout(proc, line), (n) => {
        if (child === proc) logEvent('line-truncated', { bytes: n });
      }),
    );
    proc.stderr?.on(
      'data',
      splitter(STDERR_CAP, (text) => void logLine(JSON.stringify({ type: 'forge-stderr', at: now(), text })), null),
    );
    proc.on('close', (code: number | null, signal: string | null) => onExit(proc, code, signal));
    armIdle(c);
    changed();
    return true;
  }

  /**
   * claude stamps only its assistant and user lines (`timestamp`); its system, result and
   * progress events carry no time at all. Those get the receipt time as `at`, the key the
   * supervisor's own events use, so the dashboard can show a time on every line. A line that
   * already has either key is logged verbatim.
   */
  function stamped(ev: any, line: string): string {
    if (Array.isArray(ev) || typeof ev.timestamp === 'string' || typeof ev.at === 'string') return line;
    return JSON.stringify({ ...ev, at: now() });
  }

  function onStdout(proc: DaemonChild, line: string): void {
    const meta = proc._forge;
    let ev: any = null;
    try {
      ev = JSON.parse(line);
    } catch {}
    const ok = ev && typeof ev === 'object' ? logLine(stamped(ev, line)) : logLine(JSON.stringify({ type: 'forge-raw', at: now(), text: line }));
    if (!ok && proc.stdout && !proc.stdout.isPaused()) {
      proc.stdout.pause();
      // write() returned false, so the sink is a real stream (the stand-in never does), and stdout was
      // checked just above, where the callback can't see the narrowing.
      logSink().once!('drain', () => proc.stdout!.resume());
    }
    if (child !== proc) return;
    if (!meta.stdout) {
      meta.stdout = true;
      if (!info.resumable) {
        info = { ...info, resumable: true };
        persist();
      }
    }
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'system' && ev.subtype === 'init') meta.init = true;
    if (ev.type === 'system' && ev.subtype === 'init' && status === 'idle' && meta.result) {
      // A turn nobody wrote: a background agent finished and its notification woke the orchestrator.
      // init alone is the signal, so a stray line after a result can never leave the session busy.
      status = 'busy';
      clearIdle();
      clearMissed();
      logEvent('wake');
      kept = computeKept();
      changed();
    }
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && ev.session_id && ev.session_id !== info.sessionId) {
      // It becomes the value after --resume on the next spawn, so it must be a uuid, never a flag.
      if (!UUID.test(ev.session_id)) return void logEvent('error', { message: `ignored a non-uuid session_id: ${JSON.stringify(ev.session_id.slice(0, 80))}` });
      const from = info.sessionId;
      info = withSessionId(info, ev.session_id);
      persist();
      logEvent('session-changed', { from, to: ev.session_id });
      changed();
    }
    // claude reports its mode at each turn's init and in a status event after every switch.
    if (ev.type === 'system' && (ev.subtype === 'init' || ev.subtype === 'status') && typeof ev.permissionMode === 'string') {
      const mode = cap(ev.permissionMode, 40);
      if (mode !== liveMode) {
        liveMode = mode;
        changed();
      }
    }
    if (ev.type === 'system' && ev.subtype === 'background_tasks_changed' && Array.isArray(ev.tasks)) {
      meta.background = ev.tasks.length;
      // Mid-turn, the turn's result checks instead.
      if (status === 'idle' && meta.result) watchMissedEnd(proc);
    }
    if (ev.type === 'control_request') onControl(proc, ev);
    if (ev.type === 'control_response') onControlResponse(ev);
    if (ev.type === 'control_cancel_request') onControlCancel(ev);
    if (ev.type === 'rate_limit_event') rateLimit = parseRateLimit(ev.rate_limit_info) ?? rateLimit;
    if (ev.type === 'result') onResult(proc, ev);
  }

  function onResult(proc: DaemonChild, ev: Record<string, any>): void {
    proc._forge.result = true;
    failures = 0;
    // A result clears errors from earlier exits and failed turns; a refusal or fatal error stays.
    if (lastError && /^(daemon exited|last turn failed)/.test(lastError)) lastError = null;
    const ids = inFlight;
    inFlight = [];
    lastResultAt = now();
    if (status === 'busy') status = 'idle';
    kept = computeKept();
    if (ev.is_error === true) failedTurn(proc, ev, ids);
    else {
      proc._forge.committed.push(...ids);
      for (const id of ids) committed.add(id);
      turnFailures = 0;
      strikes = 0;
      retryAt = null;
    }
    logEvent('result', { turns });
    changed();
    if (status === 'idle') {
      try {
        armIdle(ctx.config());
      } catch {}
      watchMissedEnd(proc);
    }
    ctx.onResult(scope);
  }

  /**
   * claude reports an API failure (an expired login, an exhausted quota) as a result with is_error,
   * often with subtype "success": the session is alive but no request made progress. Nothing is
   * committed, so the requests stay fresh, and the session waits before its next turn: until the
   * rate-limit window resets when claude said which one refused it, otherwise with a doubling
   * backoff. A limit is retried for as long as it takes; any other error strikes out at MAX_FAILURES.
   */
  function failedTurn(proc: DaemonChild, ev: Record<string, any>, ids: string[]): void {
    const why = (typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim() : String(ev.subtype ?? 'error')).slice(0, 300);
    const meta = proc._forge;
    const t = Date.now();
    if (meta.resume && !meta.init) {
      // A lost transcript on --resume prints this result and exits 1; onExit then starts over and
      // clears the wait. The wait only guards against a child that stays up without ever initialising.
      retryAt = t + o.retryMinMs;
      lastError = `last turn failed: ${why}`;
      return;
    }
    const rejected = rateLimit?.status === 'rejected';
    const reset = rejected && rateLimit!.resetsAt !== null && rateLimit!.resetsAt > t ? rateLimit!.resetsAt : null;
    const limit = rejected || LIMIT_TEXT.test(why);
    turnFailures++;
    if (!limit) strikes++;
    if (!limit && strikes >= MAX_FAILURES) {
      wanted = false;
      retryAt = null;
      lastError = `daemon stopped after ${MAX_FAILURES} failed turns: ${why}`;
      logEvent('error', { message: lastError });
      // The child would otherwise sit idle in a slot other jobs could use.
      void kill('stop', true, 'failed-turns');
      return;
    }
    // A limit with no reset time (a spend cap's 400, say) starts its backoff higher: retrying sooner can't help.
    const backoff = Math.min(o.retryMaxMs, o.retryMinMs * (limit ? 5 : 1) * 2 ** (turnFailures - 1));
    retryAt = reset ?? t + backoff;
    const at = new Date(retryAt).toISOString();
    lastError = `last turn failed: ${why}; retry at ${at}`;
    logEvent('retry', { at, reason: limit ? 'limit' : 'error', attempt: turnFailures, requests: ids.length });
  }

  function onExit(proc: DaemonChild, code: number | null, signal: string | null): void {
    if (child !== proc) return;
    const meta = proc._forge;
    child = null;
    clearIdle();
    clearMissed();
    dropPrompts();
    inFlight = [];
    status = 'off';
    kept = null;
    info = { ...info, pid: null };
    persist();
    logEvent('exit', { code, signal });
    loseAgents();
    if (meta.asked) {
      // A failed turn's error describes the process just stopped on purpose; the log keeps it.
      // Clearing it lets a finished or slot-stopped session be pruned instead of showing failing forever.
      if (lastError?.startsWith('last turn failed')) lastError = null;
      return changed();
    }
    if (meta.resume && !meta.init && code !== 0 && code !== null) {
      // The transcript is gone (or unreadable): start over once rather than counting a failure.
      // Real claude still prints one `result` (subtype error_during_execution, is_error) before
      // exiting 1, so the test is "no system/init", and whatever that result committed is undone:
      // no turn actually ran.
      for (const id of meta.committed) committed.delete(id);
      if (lastError?.startsWith('last turn failed')) lastError = null;
      retryAt = null;
      logEvent('resume-failed', { sessionId: info.sessionId, code });
      info = { ...withSessionId(info, crypto.randomUUID()), resumable: false };
      persist();
      changed();
      // Its own slot was just freed, so the respawn needs no new one.
      if (wanted && ctx.poolWanted() && !closed) {
        try {
          if (spawnChild(ctx.config())) ctx.poke();
        } catch (e) {
          sessionFatal(`cannot start daemon: ${(e as Error).message}`);
        }
      }
      return;
    }
    lastError = `daemon exited (code ${code}, signal ${signal})`;
    if (!meta.result) failures++;
    if (failures >= MAX_FAILURES && wanted) {
      wanted = false;
      lastError = `daemon stopped after ${MAX_FAILURES} failed starts: ${lastError}`;
      logEvent('error', { message: lastError });
    }
    changed();
  }

  /** Stops the current child: SIGTERM to its group, SIGKILL after graceMs. */
  async function kill(event: string, endStdin: boolean, reason?: string): Promise<void> {
    const proc = child;
    if (!proc) {
      if (status !== 'off') {
        status = 'off';
        changed();
      }
      return;
    }
    proc._forge.asked = true;
    clearIdle();
    clearMissed();
    status = 'stopping';
    kept = null;
    logEvent(event, { pid: proc.pid ?? null, ...(reason ? { reason } : {}) });
    changed();
    const closedP = new Promise((resolve) => proc.once('close', () => resolve(true)));
    const wait = (ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise((r) => (timer = setTimeout(() => r(false), ms)));
      // Cleared once the child closes, so a pending grace timer never holds the process open.
      return Promise.race([closedP, timeout]).finally(() => clearTimeout(timer));
    };
    if (endStdin) {
      try {
        proc.stdin?.end();
      } catch {}
    }
    o.killTree(proc, 'SIGTERM');
    if (!(await wait(o.graceMs))) {
      o.killTree(proc, 'SIGKILL');
      await wait(o.graceMs);
    }
    if (child === proc) {
      // No close event at all (a stuck pipe): treat it as gone so the supervisor can't wedge.
      child = null;
      kept = null;
      dropPrompts();
      info = { ...info, pid: null };
      persist();
      loseAgents();
    }
    if (!child) status = 'off';
    changed();
    // A start that arrived while this child was stopping, or a job waiting for this slot, gets its session now.
    if (!closed) ctx.poke();
  }

  function writeTurn(ids: string[]): void {
    // The pool only calls this once a child is running, and its stdin is a pipe.
    child!.stdin!.write(TURN_LINE);
    status = 'busy';
    inFlight = ids;
    rateLimit = null;
    retryAt = null;
    turns++;
    info = { ...info, lastTurnAt: now() };
    persist();
    clearIdle();
    clearMissed();
    logEvent('turn', { requests: ids.length, turn: turns });
    changed();
  }

  return {
    scope,
    get wanted() {
      return wanted;
    },
    get running() {
      return Boolean(child);
    },
    get status() {
      return status;
    },
    get waiting() {
      return waiting;
    },
    get held() {
      return held;
    },
    get lastError() {
      return lastError;
    },
    get lastResultAt() {
      return lastResultAt;
    },
    get kept() {
      return kept;
    },
    refreshKept,
    keptBy,
    state,
    route(c, pending) {
      const ids = new Set(pending.map((r) => r.id));
      for (const id of committed) if (!ids.has(id)) committed.delete(id);
      let isHeld = false;
      const eligible: string[] = [];
      for (const r of pending) {
        if (heldByBudget(root, c, r)) isHeld = true;
        else eligible.push(r.id);
      }
      const next = isHeld ? 'budget' : null;
      if (next !== held) {
        held = next;
        logEvent('held', { held: next });
        changed();
      }
      // Backing off after a failed turn: the requests stay fresh, the turn just waits.
      if (retryAt !== null && Date.now() < retryAt) return { eligible, fresh: false };
      return { eligible, fresh: eligible.some((id) => !committed.has(id)) };
    },
    spawn: spawnChild,
    writeTurn,
    answerPermission,
    setPermissionMode,
    kill,
    logEvent,
    setWaiting(w) {
      if (w === waiting) return;
      waiting = w;
      if (w) logEvent('waiting', { maxConcurrent: ctx.config().daemon?.maxConcurrent ?? null });
      changed();
    },
    setWanted(w) {
      if (w === wanted) return;
      wanted = w;
      if (!w) waiting = false;
      changed();
    },
    reset() {
      wanted = true;
      failures = 0;
      turnFailures = 0;
      strikes = 0;
      retryAt = null;
      lastError = null;
      changed();
    },
    /** Buffered lines after `afterOffset`; all of them when it is missing or ahead of us (a restarted server). */
    recent(afterOffset) {
      const last = ring.length ? ring[ring.length - 1].offset : -1;
      if (afterOffset === undefined || !Number.isFinite(afterOffset) || afterOffset > last) return ring.slice();
      return ring.filter((r) => r.offset > afterOffset);
    },
    async close() {
      await kill('stop', false);
      closed = true;
      clearIdle();
      clearMissed();
      // Only our own record: a refused start must not clear the owning server's pid.
      if (info.serverPid === process.pid) {
        info = { ...info, pid: null, serverPid: null };
        persist();
      }
      if (sink) {
        const s = sink;
        sink = null;
        await new Promise((resolve) => {
          if (typeof s.end !== 'function') return resolve(undefined);
          s.end(() => resolve(undefined));
        });
      }
    },
    /** Last resort from a process `exit` handler: synchronous, so it can't wait for the grace period. */
    killSync() {
      if (child) o.killTree(child, 'SIGTERM');
    },
  };
}

/**
 * Reads complete lines of a session log backwards from `before` (an offset; default and
 * maximum: the end of the file), newest last, through an already-open descriptor. A page stops
 * at `maxBytes` of file or `maxLines` lines (always at least one line), a line over `lineCap`
 * bytes comes back as a forge-truncated marker at its real offset, and at most `scanBytes` are
 * read, so a huge file can't make one request expensive.
 */
export function readLogPage(
  fd: number,
  size: number,
  logBase: number,
  opts: { before?: number | null; maxBytes?: number; maxLines?: number; lineCap?: number; scanBytes?: number } = {},
): { lines: { offset: number; line: string }[]; start: number; end: number; more: boolean } {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const maxLines = opts.maxLines ?? 1000;
  const lineCap = opts.lineCap ?? 64 * 1024;
  let budget = opts.scanBytes ?? 16 * 1024 * 1024;
  let limit = size;
  if (opts.before !== undefined && opts.before !== null) limit = Math.max(0, Math.min(size, opts.before - logBase));
  const CHUNK = 64 * 1024;
  let chunkStart = 0;
  let chunk = Buffer.alloc(0);
  const load = (i: number): boolean => {
    const startAt = Math.max(0, i + 1 - CHUNK);
    const len = i + 1 - startAt;
    if (len > budget) return false;
    budget -= len;
    chunk = Buffer.alloc(len);
    fs.readSync(fd, chunk, 0, len, startAt);
    chunkStart = startAt;
    return true;
  };
  const byteAt = (i: number): number | null => {
    if (i < chunkStart || i >= chunkStart + chunk.length) if (!load(i)) return null;
    return chunk[i - chunkStart];
  };
  /** Position of the last newline at or before i, -1 at the start of the file, null when out of budget. */
  const prevNewline = (i: number): number | null => {
    for (let j = i; j >= 0; j--) {
      const b = byteAt(j);
      if (b === null) return null;
      if (b === 10) return j;
    }
    return -1;
  };
  // A trailing line still being written (no newline yet) is not complete.
  let cursor = 0;
  if (limit > 0) {
    const nl = prevNewline(limit - 1);
    cursor = nl === null ? 0 : nl + 1;
  }
  const end = logBase + cursor;
  const lines: { offset: number; line: string }[] = [];
  let covered = 0;
  while (cursor > 0 && lines.length < maxLines) {
    const nl = cursor >= 2 ? prevNewline(cursor - 2) : -1;
    if (nl === null) break;
    const lineStart = nl + 1;
    const len = cursor - lineStart;
    if (lines.length && covered + len > maxBytes) break;
    const bytes = len - 1;
    let text: string;
    if (bytes > lineCap) {
      const head = Buffer.alloc(Math.min(bytes, 256));
      fs.readSync(fd, head, 0, head.length, lineStart);
      const m = /^\{"type":"([^"\\]{1,64})"/.exec(head.toString('utf8'));
      text = JSON.stringify({ type: 'forge-truncated', originalType: m ? m[1] : null, bytes });
    } else {
      const buf = Buffer.alloc(bytes);
      if (bytes) fs.readSync(fd, buf, 0, bytes, lineStart);
      text = buf.toString('utf8').replace(/\r$/, '');
    }
    if (text.trim()) lines.unshift({ offset: logBase + lineStart, line: text });
    covered += len;
    cursor = lineStart;
  }
  return { lines, start: logBase + cursor, end, more: cursor > 0 && lines.length > 0 };
}

export function capLine(line: string): string {
  const bytes = Buffer.byteLength(line);
  if (bytes <= RING_LINE_BYTES) return line;
  let originalType: unknown = null;
  try {
    originalType = JSON.parse(line)?.type ?? null;
  } catch {}
  return JSON.stringify({ type: 'forge-truncated', originalType, bytes });
}

/**
 * Byte-capped line splitter, so one runaway line can't grow memory without bound. A line longer
 * than `max` is dropped up to its newline and reported through `onTooLong`; with no
 * `onTooLong` its first `max` bytes are kept instead.
 */
export function splitter(max: number, onLine: (line: string) => void, onTooLong: ((bytes: number) => void) | null): (data: Buffer | string) => void {
  let parts: Buffer[] = [];
  let size = 0;
  let dropping = false;
  let dropped = 0;
  return (data: Buffer | string) => {
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(10, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (dropping) dropped += piece.length;
      else if (size + piece.length > max) {
        dropping = true;
        dropped = size + piece.length;
        if (onTooLong) parts = [];
        else parts.push(piece.subarray(0, max - size));
        size = 0;
      } else if (piece.length) {
        parts.push(piece);
        size += piece.length;
      }
      if (nl === -1) break;
      if (dropping && onTooLong) onTooLong(dropped);
      else {
        const line = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
        if (line.trim()) onLine(line);
      }
      parts = [];
      size = 0;
      dropping = false;
      dropped = 0;
      start = nl + 1;
    }
  };
}
