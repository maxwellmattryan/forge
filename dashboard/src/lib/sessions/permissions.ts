// Permission prompts from daemon sessions: the pure half of PermissionPrompts.svelte, TimedOutPrompts.svelte and POST /api/daemon/permission.
// Every prompt field but id and at is session output, i.e. untrusted text: these return plain strings rendered as text.
import { projectApi } from '../core/project.ts';
import type { DaemonPermissionPrompt, DaemonPoolState, DaemonSessionState, DaemonTimedOutPrompt, PermissionDecision } from '../core/types.ts';

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A prompt and the session that is waiting on it. */
export interface PendingPrompt {
  scope: string;
  prompt: DaemonPermissionPrompt;
}

/** A prompt as /api/state or SSE delivers it, with every field checked; null without an id. */
export function readPrompt(v: unknown): DaemonPermissionPrompt | null {
  const p = obj(v);
  if (typeof p.id !== 'string' || !p.id) return null;
  return {
    id: p.id,
    tool: typeof p.tool === 'string' && p.tool ? p.tool : 'unknown',
    input: typeof p.input === 'string' ? p.input : '{}',
    description: strOrNull(p.description),
    agentId: strOrNull(p.agentId),
    blockedPath: strOrNull(p.blockedPath),
    sessionRules: strs(p.sessionRules),
    sessionDirs: strs(p.sessionDirs),
    at: typeof p.at === 'string' ? p.at : '',
  };
}

/** A prompt the supervisor denied because nobody answered it in time, and the session that asked it. */
export interface TimedOutPrompt {
  scope: string;
  prompt: DaemonTimedOutPrompt;
}

/** A timed-out prompt as /api/state or SSE delivers it: readPrompt plus `deniedAt`; null without an id. */
export function readTimedOut(v: unknown): DaemonTimedOutPrompt | null {
  const p = readPrompt(v);
  if (!p) return null;
  const deniedAt = obj(v).deniedAt;
  return { ...p, deniedAt: typeof deniedAt === 'string' ? deniedAt : '' };
}

const newestDeniedFirst = (a: TimedOutPrompt, b: TimedOutPrompt): number => (a.prompt.deniedAt > b.prompt.deniedAt ? -1 : a.prompt.deniedAt < b.prompt.deniedAt ? 1 : 0);

/** Every session's timed-out prompts (the inbox's, the office's, then each job's), newest denied first. An older server sends no `timedOut`: none. */
export function timedOutPrompts(pool: Partial<DaemonPoolState> | null | undefined): TimedOutPrompt[] {
  const p = obj(pool);
  const out: TimedOutPrompt[] = [];
  for (const s of [obj(p.inbox), obj(p.office), ...Object.values(obj(p.jobs)).map(obj)]) {
    if (typeof s.scope !== 'string' || !Array.isArray(s.timedOut)) continue;
    for (const raw of s.timedOut) {
      const prompt = readTimedOut(raw);
      if (prompt) out.push({ scope: s.scope, prompt });
    }
  }
  return out.sort(newestDeniedFirst);
}

const oldestFirst = (a: PendingPrompt, b: PendingPrompt): number => (a.prompt.at < b.prompt.at ? -1 : a.prompt.at > b.prompt.at ? 1 : 0);

/** One session's valid prompts, each with `scope`, unsorted. */
function promptsOf(session: unknown, scope: string): PendingPrompt[] {
  const list = obj(session).permissions;
  const out: PendingPrompt[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const prompt = readPrompt(raw);
    if (prompt) out.push({ scope, prompt });
  }
  return out;
}

/** Every prompt in the pool (the inbox's, the office's, then each job's), oldest first; only `scope`'s when given. */
export function pendingPrompts(pool: Partial<DaemonPoolState> | null | undefined, scope?: string): PendingPrompt[] {
  const p = obj(pool);
  const sessions = [obj(p.inbox), obj(p.office), ...Object.values(obj(p.jobs)).map(obj)];
  const out: PendingPrompt[] = [];
  for (const s of sessions) {
    if (typeof s.scope !== 'string' || (scope !== undefined && s.scope !== scope)) continue;
    out.push(...promptsOf(s, s.scope));
  }
  return out.sort(oldestFirst);
}

/**
 * One session's prompts as `scope`'s, oldest first: a session the pool state doesn't list (a chat's, from GET
 * /api/chats/<id> and its stream's state frames). Null, or a session without `permissions`, has none.
 */
export function sessionPrompts(session: Partial<DaemonSessionState> | null | undefined, scope: string): PendingPrompt[] {
  return promptsOf(session, scope).sort(oldestFirst);
}

/** The sorted ids of a session's valid prompts, one per line; null when it carries no `permissions` array. */
function promptKey(session: unknown): string | null {
  const list = obj(session).permissions;
  if (!Array.isArray(list)) return null;
  const ids: string[] = [];
  for (const raw of list) {
    const p = readPrompt(raw);
    if (p) ids.push(p.id);
  }
  return ids.sort().join('\n');
}

/**
 * The frame's prompt-id key when it differs from the poll's and from the last key a refresh was asked for; else null.
 * A frame without `permissions` (a partial update) never asks; a missing polled session counts as no prompts.
 */
export function promptRefreshKey(frame: unknown, polled: unknown, last: string | null): string | null {
  const key = promptKey(frame);
  if (key === null) return null;
  const polledKey = promptKey(polled) ?? '';
  return key !== polledKey && key !== last ? key : null;
}

const INPUT_KEYS: Record<string, string> = { Bash: 'command', Read: 'file_path', Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path', WebFetch: 'url', Glob: 'pattern', Grep: 'pattern' };

/**
 * What the call would do, as the human should read it: a Bash command, a file path or a URL on
 * its own, otherwise the whole input as indented JSON. The input is capped server-side, so it may
 * not parse; then it shows as sent.
 */
export function promptInput(prompt: Pick<DaemonPermissionPrompt, 'tool' | 'input'>): string {
  let input: unknown;
  try {
    input = JSON.parse(prompt.input);
  } catch {
    return prompt.input;
  }
  const key = INPUT_KEYS[prompt.tool];
  const main = key ? obj(input)[key] : undefined;
  if (typeof main === 'string' && Object.keys(obj(input)).every((k) => k === key || k === 'description')) return main;
  return JSON.stringify(input, null, 2);
}

/** Whether "allow for this session" grants anything beyond this one call. */
export const grantsMore = (prompt: Pick<DaemonPermissionPrompt, 'sessionRules' | 'sessionDirs'>): boolean => prompt.sessionRules.length + prompt.sessionDirs.length > 0;

/** POST /api/daemon/permission. Throws with the server's `error` field, else its text, else the status text. */
export async function postPermission(scope: string, id: string, decision: PermissionDecision, fetchImpl: typeof fetch = fetch): Promise<DaemonPoolState> {
  const res = await fetchImpl(projectApi('/api/daemon/permission'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope, id, decision }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error((body && typeof body.error === 'string' && body.error) || text || res.statusText);
  return body;
}
