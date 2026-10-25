// Claude Code's command line and environment for a headless session: the permission-mode and effort
// flags, `daemon.command` to argv, and the child's env. createSession (lib/office/session/lifecycle.ts)
// spawns with them; docs/architecture/daemon-security.md describes the rules they keep.
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { EFFORTS } from '#core/job/schema.ts';
import { SESSION_PINS, pinEnv } from '../git/runner.ts';
import { splitWords } from '#core/text.ts';
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
 * Placeholders expand after splitting, so a plugin path with spaces stays one argument.
 * `{allowedTools}` loses every file tool, bare or scoped; when it had one, an Edit rule per write
 * root takes its place, so a session writes without a prompt only inside those roots.
 * Any --max-budget-usd in the template is dropped; `maxBudgetUsd`, when a number, becomes the one
 * claude reads. DENY_TOOLS, then `deny`, and PROMPT_TOOL always follow the template.
 */
export function buildArgv(
  template: string,
  vars: {
    pluginRoot: string;
    session: { id: string; resume: boolean };
    allowedTools: string[];
    permissionMode?: DaemonPermissionMode | null;
    effort?: Effort | null;
    writeRoots?: string[];
    deny?: string[];
    maxBudgetUsd?: number | null;
  },
): string[] {
  const listed = vars.allowedTools ?? [];
  const kept = listed.filter((t) => !isFileTool(t));
  const scoped = kept.length < listed.length ? (vars.writeRoots ?? []).map((r) => `Edit(${absRule(r)}/**)`) : [];
  const tools = [...kept, ...scoped].join(',');
  let argv = parseTemplate(template).flatMap((tok) => {
    if (tok === '{session}') return [vars.session.resume ? '--resume' : '--session-id', vars.session.id];
    return [tok.replaceAll('{pluginRoot}', vars.pluginRoot).replaceAll('{allowedTools}', tools)];
  });
  if (vars.permissionMode) argv = withPermissionMode(argv, vars.permissionMode);
  // Checked again here, not only by resolveEffort: anything outside the fixed list never becomes a word of argv.
  if (vars.effort && (EFFORTS as readonly unknown[]).includes(vars.effort)) argv = withEffort(argv, vars.effort);
  argv = withoutBudgetCap(argv);
  if (typeof vars.maxBudgetUsd === 'number' && Number.isFinite(vars.maxBudgetUsd)) argv.push('--max-budget-usd', capArg(vars.maxBudgetUsd));
  return [...argv, '--disallowedTools', [...DENY_TOOLS, ...(vars.deny ?? [])].join(','), ...PROMPT_TOOL];
}
