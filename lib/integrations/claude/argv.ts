// Claude Code's command line and environment for a headless session: the permission-mode and effort
// flags, `daemon.command` to argv, and the child's env. createSession (lib/office/session/lifecycle.ts)
// spawns with them; docs/ARCHITECTURE.md "Daemon security" describes the rules they keep.
import path from 'node:path';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { EFFORTS } from '#core/job/schema.ts';
import { SESSION_PINS } from '../git/runner.ts';
import { splitWords } from '#core/text.ts';
import type { DaemonAuth, DaemonPermissionMode, Effort } from '#core/types.ts';

/**
 * Paths the session may never write, appended to every daemon command as --disallowedTools
 * whatever `daemon.command` says. Claude Code checks file writes against Edit(path) rules,
 * anchors relative paths at the session's cwd (the main checkout, so job worktrees are
 * unaffected) and lets deny beat allow. This stops the Edit/Write route only; trustDigest is the
 * check that also covers writes made through Bash (docs/ARCHITECTURE.md "Daemon security").
 */
export const DENY_TOOLS = Object.freeze([
  'Edit(.forge/config.yml)',
  'Edit(.forge/trackers/**)',
  'Edit(.forge/secrets-allow.txt)',
  'Edit(.forge/verifiers/**)',
  // The repo budget's spend cache and the log its acknowledgements live in.
  'Edit(.forge/runtime/spend.json)',
  'Edit(.forge/runtime/audit.jsonl)',
]);

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

/** The API_KEY_VARS that are set (non-empty) in `env`. */
export function apiKeyVars(env: NodeJS.ProcessEnv): string[] {
  return API_KEY_VARS.filter((k) => Boolean(env[k]));
}

/**
 * The child's environment: this plugin's bin/ first on PATH, git pins appended after any the
 * caller already set, a no-op editor so `git merge|rebase --continue` can't wait on a TTY,
 * FORGE_MODE=agent so the session never gets human output, and no API key unless `daemon.auth`
 * is api-key.
 */
export function sessionEnv(env: NodeJS.ProcessEnv, auth: DaemonAuth = 'subscription'): NodeJS.ProcessEnv {
  // This plugin's bin/ goes first on PATH, so the session's `forge` is the same version as the
  // supervisor's even when another Forge install is on PATH (seen in the AC18 headless run).
  const PATH = [path.join(PLUGIN_ROOT, 'bin'), env.PATH].filter(Boolean).join(path.delimiter);
  // A session's forge calls feed its context, so they always print agent output, even under a PTY.
  const out: NodeJS.ProcessEnv = { ...env, PATH, FORGE_DAEMON: '1', FORGE_MODE: 'agent', GIT_EDITOR: 'true' };
  if (auth !== 'api-key') for (const k of API_KEY_VARS) delete out[k];
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  const base = Number.isInteger(count) && count > 0 ? count : 0;
  SESSION_PINS.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${base + i}`] = key;
    out[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(base + SESSION_PINS.length);
  return out;
}

/** `daemon.command` split into words; see splitWords in lib/core/text.ts. */
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
