// Claude Code's command line and environment for a headless session: the permission-mode and effort
// flags, `daemon.command` to argv, a role child's argv, and the child's env. createSession
// (lib/office/session/lifecycle.ts) and `forge job agent run` spawn with them;
// docs/architecture/daemon-security.md describes the rules they keep.
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { EFFORTS } from '#core/job/schema.ts';
import { validModel } from '#core/config/models.ts';
import { UUID } from '#core/job/session-files.ts';
import { SESSION_PINS, pinEnv } from '../git/runner.ts';
import { splitWords } from '#core/text.ts';
import { BROWSER_ALLOWED, BROWSER_DENIED } from './browser.ts';
import type { DaemonAuth, DaemonBilling, DaemonPermissionMode, Effort } from '#core/types.ts';

/**
 * Paths the session may never write, appended to every daemon command as --disallowedTools
 * whatever `daemon.command` says. Claude Code checks file writes against Edit(path) rules,
 * anchors relative paths at the session's cwd (the main checkout, so job worktrees are
 * unaffected) and lets deny beat allow. The caller appends each one's absolute twin and the
 * checkout-specific rules (lib/office/session/confine.ts denyRules). This stops the file-tool route
 * only; trustDigest and the post-turn check also cover writes made through Bash
 * (docs/architecture/daemon-security.md).
 */
export const DENY_TOOLS = Object.freeze([
  'Edit(.forge/config.yml)',
  'Edit(.forge/secrets-allow.txt)',
  'Edit(.forge/local.yml)',
  'Edit(.forge/trackers/**)',
  'Edit(.forge/verifiers/**)',
  'Edit(.forge/notes/**)',
  'Edit(.forge/reviewers/**)',
  'Edit(.forge/evals/**)',
  'Edit(.forge/ci/**)',
  // The spend cache, the audit log, session records and the CLI copies of job state.
  'Edit(.forge/runtime/**)',
  'Edit(.forge/locks/**)',
  'Edit(.forge/archive/**)',
  // The job files only the CLI writes, and instructions a later agent would load from a job folder.
  'Edit(.forge/jobs/*/job.json)',
  'Edit(.forge/jobs/*/events.jsonl)',
  'Edit(.forge/jobs/*/.lock/**)',
  'Edit(.forge/jobs/**/CLAUDE.md)',
  'Edit(.forge/jobs/**/CLAUDE.local.md)',
]);

/** Claude Code's file-writing tools: one Edit(…) rule governs them all. */
export const FILE_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Whether an allowedTools entry is a file tool, bare or scoped. */
export const isFileTool = (tool: string): boolean => FILE_TOOLS.some((f) => tool.trim() === f || tool.trim().startsWith(`${f}(`));

/**
 * `p` as the path of an absolute permission rule: `//` and its POSIX form (`C:\x` becomes `//c/x`).
 * A rule can't carry a comma (it splits --allowedTools), parentheses, glob characters or a newline,
 * nor a backslash off Windows (the rule syntax's escape character), so a path holding one throws
 * rather than becoming a rule that matches something else.
 */
export function absRule(p: string, platform: NodeJS.Platform = process.platform): string {
  if (/[,()*?[\]{}\r\n\0]/.test(p) || (platform !== 'win32' && p.includes('\\')))
    throw new ForgeError(`${JSON.stringify(p)} can't be a permission rule: it contains one of , ( ) * ? [ ] { } or a newline, or a backslash off Windows; move it to a path without them`);
  let posix = p;
  if (platform === 'win32') posix = p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
  return `/${posix}`;
}

/**
 * Appended to every daemon command: claude sends each permission check it would otherwise ask a
 * person about to the supervisor as a `can_use_tool` control request on stdout, and waits for the
 * answer on stdin. Under `--permission-mode dontAsk` nothing is ever asked, so nothing arrives.
 */
export const PROMPT_TOOL = Object.freeze(['--permission-prompt-tool', 'stdio']);

/**
 * The modes a human may switch one session to from the dashboard. `auto` is here but refused in
 * daemon.command (lib/core/config/trust.ts SAFE_PERMISSION_MODES): a repo's config can't put every session on
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
 * argv with every --model dropped and `model` appended as its own word, so the office session's
 * foreman.model is the one claude reads rather than one daemon.command already passes.
 */
export function withModel(argv: string[], model: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (i > 0 && argv[i] === '--model') i++;
    else if (i > 0 && argv[i].startsWith('--model=')) continue;
    else out.push(argv[i]);
  }
  return [...out, '--model', model];
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

/**
 * Variables that make claude bill an API account instead of the Claude login. `forge dash` is
 * usually started from a shell that exports one for some other tool, and a headless session
 * never asks which to use.
 */
const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/**
 * Variables that each silently make claude bill another account (Bedrock, Vertex, Foundry) or send
 * its traffic through another endpoint, past the Claude login and the spend Forge expects.
 */
const PROVIDER_VARS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL'] as const;

/** The API_KEY_VARS that are set (non-empty) in `env`. */
export function apiKeyVars(env: NodeJS.ProcessEnv): string[] {
  return API_KEY_VARS.filter((k) => Boolean(env[k]));
}

/** The PROVIDER_VARS that are set (non-empty) in `env`. */
export function providerVars(env: NodeJS.ProcessEnv): string[] {
  return PROVIDER_VARS.filter((k) => Boolean(env[k]));
}

/**
 * Which billing variables are set in `env`, whether sessions get them (only under api-key), and whether that warrants a
 * warning (a provider switch or ANTHROPIC_BASE_URL is set; an API key alone does not); null when none is.
 */
export function billingOf(env: NodeJS.ProcessEnv, auth: DaemonAuth): DaemonBilling | null {
  const providers = providerVars(env);
  const vars = [...apiKeyVars(env), ...providers];
  return vars.length ? { vars, passed: auth === 'api-key', warn: providers.length > 0 } : null;
}

/**
 * The child's environment: this plugin's bin/ first on PATH, git pins appended after any the
 * caller already set, a no-op editor so `git merge|rebase --continue` can't wait on a TTY,
 * FORGE_MODE=agent so the session never gets human output, and no API key or provider switch
 * unless `daemon.auth` is api-key.
 */
export function sessionEnv(env: NodeJS.ProcessEnv, auth: DaemonAuth = 'subscription'): NodeJS.ProcessEnv {
  // This plugin's bin/ goes first on PATH, so the session's `forge` is the same version as the
  // supervisor's even when another Forge install is on PATH (seen in the AC18 headless run).
  const PATH = [path.join(PLUGIN_ROOT, 'bin'), env.PATH].filter(Boolean).join(path.delimiter);
  // A session's forge calls feed its context, so they always print agent output, even under a PTY.
  const out: NodeJS.ProcessEnv = { ...env, PATH, FORGE_DAEMON: '1', FORGE_MODE: 'agent', GIT_EDITOR: 'true' };
  if (auth !== 'api-key') for (const k of [...API_KEY_VARS, ...PROVIDER_VARS]) delete out[k];
  return pinEnv(out, SESSION_PINS);
}

/** A --max-budget-usd value: at least a cent, floored to cents, with two decimals. */
export function capArg(usd: number): string {
  return Math.max(0.01, Math.floor(usd * 100) / 100).toFixed(2);
}

/** argv with every --max-budget-usd dropped after argv[0]: Forge passes its own from the job's dollar budget. */
function withoutBudgetCap(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (i > 0 && argv[i] === '--max-budget-usd') i++;
    else if (i > 0 && argv[i].startsWith('--max-budget-usd=')) continue;
    else out.push(argv[i]);
  }
  return out;
}

/** `daemon.command` split into words; see splitWords in lib/core/text.ts. */
export function parseTemplate(template: string): string[] {
  return splitWords(template, 'daemon.command');
}

/**
 * `allowedTools` as one --allowedTools value: every file tool, bare or scoped, goes, and when there was
 * one, an `Edit(//<root>/**)` rule per write root takes its place, so a session writes without a
 * prompt only inside those roots.
 */
export function scopedTools(allowedTools: readonly string[], writeRoots: readonly string[]): string {
  const kept = allowedTools.filter((t) => !isFileTool(t));
  const scoped = kept.length < allowedTools.length ? writeRoots.map((r) => `Edit(${absRule(r)}/**)`) : [];
  return [...kept, ...scoped].join(',');
}

/** The plugin agents a one-shot child of forge dash may start as (`buildArgv`'s `agent`): a gate run's and an office run's. */
export const CHILD_AGENTS = Object.freeze(['forge:assistant', 'forge:drafter', 'forge:surveyor', 'forge:director'] as const);
export type ChildAgent = (typeof CHILD_AGENTS)[number];

/**
 * Placeholders expand after splitting, so a plugin path with spaces stays one argument.
 * `{allowedTools}` loses every file tool, bare or scoped; when it had one, an Edit rule per write
 * root takes its place, so a session writes without a prompt only inside those roots.
 * Any --max-budget-usd in the template is dropped; `maxBudgetUsd`, when a number, becomes the one
 * claude reads. A `model` (the office session's foreman.model) replaces every --model the template
 * has. `appendSystemPrompt`, when a string, follows as `--append-system-prompt <text>`: only a chat
 * session's spawn passes it, and only the fixed CHAT_PROMPT (lib/office/session/launch.ts). `agent`, when one of
 * CHILD_AGENTS, appends `--agent <it>`: a gate run's forge:assistant (lib/office/foreman/attempt.ts), or an office
 * run's drafter, surveyor or director (lib/office/foreman/runs/child.ts); it is a fixed value, never config text. `mcpConfig`, when a string, follows as `--mcp-config <json>`: only a job
 * session's spawn passes it, and only browserMcpConfig's (lib/integrations/claude/browser.ts); the template
 * itself may never pass the flag (lib/core/config/trust.ts), and BROWSER_DENIED joins the deny list with it.
 * DENY_TOOLS, then `deny`, then those, and PROMPT_TOOL always follow the template, so a flag follows
 * claude's variadic --mcp-config value.
 */
export function buildArgv(
  template: string,
  vars: {
    pluginRoot: string;
    session: { id: string; resume: boolean };
    allowedTools: string[];
    permissionMode?: DaemonPermissionMode | null;
    effort?: Effort | null;
    model?: string | null;
    writeRoots?: string[];
    deny?: string[];
    maxBudgetUsd?: number | null;
    appendSystemPrompt?: string | null;
    agent?: ChildAgent | null;
    mcpConfig?: string | null;
  },
): string[] {
  const tools = scopedTools(vars.allowedTools ?? [], vars.writeRoots ?? []);
  let argv = parseTemplate(template).flatMap((tok) => {
    if (tok === '{session}') return [vars.session.resume ? '--resume' : '--session-id', vars.session.id];
    return [tok.replaceAll('{pluginRoot}', vars.pluginRoot).replaceAll('{allowedTools}', tools)];
  });
  if (vars.permissionMode) argv = withPermissionMode(argv, vars.permissionMode);
  // Checked again here, not only by resolveEffort: anything outside the fixed list never becomes a word of argv.
  if (vars.effort && (EFFORTS as readonly unknown[]).includes(vars.effort)) argv = withEffort(argv, vars.effort);
  // Checked again here too: a model that starts with `-` or holds a space never becomes a word of argv.
  const model = validModel(vars.model);
  if (model && model !== 'inherit') argv = withModel(argv, model);
  argv = withoutBudgetCap(argv);
  if (typeof vars.maxBudgetUsd === 'number' && Number.isFinite(vars.maxBudgetUsd)) argv.push('--max-budget-usd', capArg(vars.maxBudgetUsd));
  if (typeof vars.appendSystemPrompt === 'string') argv.push('--append-system-prompt', vars.appendSystemPrompt);
  // A fixed list, never config or model text: any other value appends nothing.
  const agent = CHILD_AGENTS.find((a) => a === vars.agent);
  if (agent) argv.push('--agent', agent);
  const browser = typeof vars.mcpConfig === 'string';
  if (browser) argv.push('--mcp-config', mcpJson(vars.mcpConfig as string));
  return [...argv, '--disallowedTools', [...DENY_TOOLS, ...(vars.deny ?? []), ...(browser ? BROWSER_DENIED : [])].join(','), ...PROMPT_TOOL];
}

/** An --mcp-config value, which must be a JSON object: never a word claude could read as a flag or a file path. */
function mcpJson(value: string): string {
  if (!value.startsWith('{')) throw new ForgeError(`an --mcp-config value must be a JSON object (got ${JSON.stringify(value.slice(0, 80))})`);
  return value;
}

/** A plugin agent a role child may run: `forge:` and a role's base name. */
const ROLE_AGENT = /^forge:[a-z0-9-]+$/;
/** A built-in tool name a role child's --tools may list: no flag, space, comma, rule or MCP tool. */
const BUILTIN_TOOL = /^[A-Z][A-Za-z]+$/;
/** An absolute file rule as confine.ts absoluteDenyRules writes one: `Edit(//…)`, with no comma to split the list. */
const ABSOLUTE_RULE = /^Edit\(\/\/[^,\r\n]+\)$/;

/**
 * One role child's command line (`forge job agent run`, lib/cli/commands/job/agent-run.ts): one pipeline
 * role as its own headless `claude -p --agent forge:<role>` in the job's worktree, with the brief on
 * stdin (stream.ts briefLine), never in argv. Only `executable` comes from daemon.command (its first
 * word); none of the template's other words. `model` and `effort` are dropped unless valid, and the
 * agent and session id must match their patterns or this throws, so no value can become a flag.
 * DENY_TOOLS are not appended: anchored at the worktree cwd they would deny the branch's own
 * `.forge/notes/**` and `CLAUDE.md`. The caller passes the absolute rules (absoluteDenyRules), and a
 * relative one throws. The cwd is also a branch's checkout of files agents write, so `--setting-sources ''`
 * loads no setting source at all: neither its project and local scope (CLAUDE.md and CLAUDE.local.md memory,
 * `.claude/settings*.json` hooks, permissions and env, `.claude/skills` and `commands`) nor the user's
 * (their plugins, hooks and MCP servers, none of them Forge's); `--strict-mcp-config` keeps its `.mcp.json` out
 * too. Only the `--plugin-dir` plugin and managed settings load. `--disable-slash-commands` drops skills, and
 * `tools`, the built-in tools of the agent's `tools:` frontmatter (lib/engine/pipeline/roster.ts agentTools),
 * becomes `--tools`: it must be non-empty and every name must match BUILTIN_TOOL, or this throws.
 * `appendSystemPromptFile`, when a string, follows the effort words as `--append-system-prompt-file <path>`:
 * the trusted prefix (lib/engine/guard/prompt-prefix.ts), an absolute path with no NUL, CR or LF, or this throws.
 * `mcpConfig`, when a string, is browserMcpConfig's JSON (lib/integrations/claude/browser.ts): it follows as
 * `--mcp-config <json>`, `--allowedTools` gains BROWSER_ALLOWED (the page tools, since a role child has no one
 * to ask, never the whole server) and `--disallowedTools` gains BROWSER_DENIED after the caller's `deny`.
 * claude reads `--tools` and `--mcp-config` variadically, so a flag always follows each.
 * `fork` puts `--fork-session` straight after `--resume <id>` (a context session's fork, lib/engine/workspace/context-session.ts),
 * and throws without `session.resume`: a fork of nothing would start a fresh conversation under a resumed one's name.
 * `persist: false` puts `--no-session-persistence` after the session id words (and the fork), for a one-shot child
 * whose conversation nothing resumes (the intake runner's triage, lib/office/inbox/triage.ts).
 */
export function roleArgv(vars: {
  executable: string;
  pluginRoot: string;
  agent: string;
  tools: readonly string[];
  model?: string | null;
  effort?: Effort | null;
  permissionMode: string;
  allowedTools: readonly string[];
  writeRoots: readonly string[];
  deny: readonly string[];
  session: { id: string; resume: boolean };
  appendSystemPromptFile?: string | null;
  mcpConfig?: string | null;
  fork?: boolean;
  persist?: boolean;
}): string[] {
  if (vars.fork && vars.session?.resume !== true) throw new ForgeError("a role child's --fork-session needs --resume: fork only a session it resumes");
  if (typeof vars.agent !== 'string' || !ROLE_AGENT.test(vars.agent)) throw new ForgeError(`a role child's agent must match ${ROLE_AGENT.source} (got ${JSON.stringify(String(vars.agent).slice(0, 80))})`);
  const tools = Array.isArray(vars.tools) ? vars.tools : [];
  const badTool = tools.find((t) => typeof t !== 'string' || !BUILTIN_TOOL.test(t));
  if (!tools.length || badTool !== undefined)
    throw new ForgeError(`a role child's tools must be built-in tool names matching ${BUILTIN_TOOL.source}, at least one (got ${JSON.stringify(tools.length ? String(badTool).slice(0, 80) : '[]')})`);
  const prompt = vars.appendSystemPromptFile;
  if (prompt !== undefined && prompt !== null && (typeof prompt !== 'string' || !path.isAbsolute(prompt) || /[\0\r\n]/.test(prompt)))
    throw new ForgeError(`a role child's system prompt file must be an absolute path without NUL, CR or LF (got ${JSON.stringify(String(prompt).slice(0, 200))})`);
  if (typeof vars.session?.id !== 'string' || !UUID.test(vars.session.id)) throw new ForgeError(`a role child's session id must be a uuid (got ${JSON.stringify(String(vars.session?.id).slice(0, 80))})`);
  const relative = vars.deny.find((r) => typeof r !== 'string' || !ABSOLUTE_RULE.test(r));
  if (relative !== undefined) throw new ForgeError(`a role child's deny rules must be absolute Edit(//…) rules: ${JSON.stringify(String(relative).slice(0, 200))} would anchor at the worktree`);
  const model = validModel(vars.model);
  const effort = vars.effort && (EFFORTS as readonly unknown[]).includes(vars.effort) ? vars.effort : null;
  const mcp = typeof vars.mcpConfig === 'string' ? mcpJson(vars.mcpConfig) : null;
  return [
    vars.executable,
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--plugin-dir',
    vars.pluginRoot,
    '--agent',
    vars.agent,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools',
    tools.join(','),
    ...(model && model !== 'inherit' ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(typeof prompt === 'string' ? ['--append-system-prompt-file', prompt] : []),
    ...(mcp !== null ? ['--mcp-config', mcp] : []),
    '--permission-mode',
    vars.permissionMode,
    '--allowedTools',
    [scopedTools(vars.allowedTools, vars.writeRoots), ...(mcp !== null ? BROWSER_ALLOWED : [])].filter(Boolean).join(','),
    vars.session.resume ? '--resume' : '--session-id',
    vars.session.id,
    ...(vars.fork ? ['--fork-session'] : []),
    ...(vars.persist === false ? ['--no-session-persistence'] : []),
    '--disallowedTools',
    [...vars.deny, ...(mcp !== null ? BROWSER_DENIED : [])].join(','),
    ...PROMPT_TOOL,
  ];
}
