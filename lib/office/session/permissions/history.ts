// The prompt history: one line per permission prompt a pool session answered (`.forge/runtime/permission-prompts.jsonl`),
// holding only the scope, tool, candidate rules, decision and reason, never the input, the agent's description, the
// blocked path or the suggested folders. A rule is claude's own pattern and can be most of the command, so a rule that
// holds a value Forge knows is secret is dropped, not stored redacted. control.ts appends it; `forge daemon prompts`
// reads it (suggest.ts). The file is untrusted on read (a human-allowed Bash call could write it), so every line and
// rule is checked again there.
import fs from 'node:fs';
import path from 'node:path';
import { redactKnown } from '#engine/guard/known-secrets.ts';
import { validScope } from '#core/job/requests.ts';
import { appendConfined, openRead } from '#core/job/session-files.ts';
import { confinedDir, writeAtomic } from '#core/os/fs.ts';
import { paths } from '#core/paths.ts';
import { isMap } from '#core/shape.ts';
import { SAFE_TOOL } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { PROMPT_HISTORY_STEPS, PROMPT_HISTORY_VERSION } from '#core/versions/prompt-history.ts';
import { runSteps } from '#core/versions/steps.ts';
import { WILDCARD_RULE } from '#integrations/claude/stream.ts';
import type { PermissionDecision } from '#core/types.ts';

/** Why a deny was sent: a human's Deny, the permission timeout, or one of control.ts's denies without asking. */
export type PromptReason = 'human' | 'timeout' | 'too-many' | 'unserialisable-input' | 'too-large' | 'unusable-tool-name';
const REASONS: readonly PromptReason[] = ['human', 'timeout', 'too-many', 'unserialisable-input', 'too-large', 'unusable-tool-name'];
const DECISIONS: readonly PermissionDecision[] = ['allow', 'session', 'deny'];

export interface PromptEntry {
  v: number;
  at: string;
  scope: string;
  tool: string;
  /** The prompt's candidate rules (sessionGrant's, as `Tool(content)`), each printable ASCII, at most 10, distinct. */
  rules: string[];
  decision: PermissionDecision;
  /** Null for an allow; set for every deny. */
  reason: PromptReason | null;
}

/** Past this size an append trims the file to its newest whole lines totalling at most half of it; the CLI reads at most this much. */
export const PROMPT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const MAX_RULES = 10;
/** Printable ASCII only, so no control, bidi or invisible character reaches a terminal through the report. */
const RULE_TEXT = /^[\x20-\x7e]{1,4210}$/;
/** `Tool(content)` with a tool name SAFE_TOOL would take; the tool part has no `(`, so the split is unambiguous. */
export const RULE_SHAPE = /^([A-Za-z0-9_.:-]{1,100})\(([\x20-\x7e]*)\)$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** A candidate rule the history keeps and the report may group: printable ASCII `Tool(content)` whose content isn't wildcard-only. */
function goodRule(r: unknown): r is string {
  if (typeof r !== 'string' || !RULE_TEXT.test(r)) return false;
  const m = RULE_SHAPE.exec(r);
  return m !== null && !WILDCARD_RULE.test(m[2]);
}

/**
 * The good rules of `rules`, distinct, in order, at most MAX_RULES. A rule `redactKnown` would change under `known`
 * holds a secret value: it is left out (a redacted rule is useless as a suggestion), so the value never reaches disk.
 */
function keptRules(rules: unknown, known: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (out.length >= MAX_RULES) break;
    if (goodRule(r) && !out.includes(r) && redactKnown(r, known) === r) out.push(r);
  }
  return out;
}

/**
 * Appends one prompt's answer to the history: the tool (`unknown` unless SAFE_TOOL takes it), its kept rules,
 * the decision and the reason, nothing else. A rule holding any of `known` (the session's known secret values,
 * as its log is redacted with) is left out. A scope validScope refuses records nothing. The append goes only
 * through real directories to a regular file (appendConfined), so a planted link or FIFO is refused, and past
 * `maxBytes` the file is rewritten atomically to its newest whole lines totalling at most half of it. Every
 * session of a project appends synchronously from the one `forge dash` process, so an append and a trim never
 * interleave. Never throws: a failed write is dropped, and the prompt is answered as before.
 */
export function recordPrompt(
  root: string,
  e: { scope: string; tool: string | null; rules: readonly string[]; decision: PermissionDecision; reason: PromptReason | null; known?: readonly string[] },
  opts: { maxBytes?: number } = {},
): void {
  try {
    if (!validScope(e.scope)) return;
    const entry: PromptEntry = {
      v: PROMPT_HISTORY_VERSION,
      at: now(),
      scope: e.scope,
      tool: typeof e.tool === 'string' && SAFE_TOOL.test(e.tool) ? e.tool : 'unknown',
      rules: keptRules(e.rules, e.known),
      decision: e.decision,
      reason: e.reason,
    };
    const file = paths(root).permissionPrompts;
    appendConfined(root, file, JSON.stringify(entry) + '\n');
    trim(root, file, opts.maxBytes ?? PROMPT_HISTORY_MAX_BYTES);
  } catch {}
}

/** Over `max` bytes, the file becomes its newest whole lines totalling at most `max / 2`. */
function trim(root: string, file: string, max: number): void {
  let keep: Buffer;
  const fd = openRead(file);
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= max) return;
    keep = tailWhole(fd, size, Math.floor(max / 2));
  } finally {
    fs.closeSync(fd);
  }
  writeAtomic(path.join(confinedDir(root, paths(root).runtime), path.basename(file)), keep);
}

/**
 * The last `n` bytes behind `fd`, from the first line that starts inside them: one byte before is read too,
 * to tell whether the cut fell on a line start.
 */
function tailWhole(fd: number, size: number, n: number): Buffer {
  if (size <= n) {
    const buf = Buffer.alloc(size);
    return buf.subarray(0, fs.readSync(fd, buf, 0, size, 0));
  }
  const buf = Buffer.alloc(n + 1);
  const got = buf.subarray(0, fs.readSync(fd, buf, 0, n + 1, size - n - 1));
  const nl = got.indexOf(10);
  return nl < 0 ? Buffer.alloc(0) : got.subarray(nl + 1);
}

/** One history line as an entry, or null for anything malformed, forged past the current version or carrying unsafe text. */
function parseEntry(line: string): PromptEntry | null {
  if (!line.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isMap(raw)) return null;
  const v = raw.v;
  if (!Number.isInteger(v) || v < 1 || v > PROMPT_HISTORY_VERSION) return null;
  const e = runSteps(PROMPT_HISTORY_STEPS, raw, v);
  if (!isMap(e)) return null;
  const { at, scope, tool, rules, decision, reason } = e;
  if (typeof at !== 'string' || !AT.test(at) || Number.isNaN(Date.parse(at))) return null;
  if (!validScope(scope) || typeof tool !== 'string' || !SAFE_TOOL.test(tool) || !Array.isArray(rules)) return null;
  if (!DECISIONS.includes(decision) || (reason !== null && !REASONS.includes(reason))) return null;
  // Every deny says why, and no allow does.
  if ((decision === 'deny') !== (reason !== null)) return null;
  return { v: PROMPT_HISTORY_VERSION, at, scope, tool, rules: keptRules(rules), decision, reason };
}

/**
 * The history's well-formed entries, oldest first. Reads at most the file's last `maxBytes` (from the first whole
 * line in them), through one descriptor that never follows a link or blocks on a FIFO; anything but a regular
 * file, or no file, reads as []. It filters by no date: promptReport does, because a deny before `--since` must
 * still block a suggestion.
 */
export function readPromptHistory(root: string, opts: { maxBytes?: number } = {}): PromptEntry[] {
  let fd: number;
  try {
    fd = openRead(paths(root).permissionPrompts);
  } catch {
    return [];
  }
  let text: string;
  try {
    text = tailWhole(fd, fs.fstatSync(fd).size, opts.maxBytes ?? PROMPT_HISTORY_MAX_BYTES).toString('utf8');
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
  return text.split('\n').map(parseEntry).filter((e): e is PromptEntry => e !== null);
}
