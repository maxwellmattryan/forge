// Permission prompts from daemon sessions: the pure half of PermissionPrompts.svelte and POST /api/daemon/permission.
// Every prompt field but id and at is session output, i.e. untrusted text: these return plain strings rendered as text.
import type { DaemonPermissionPrompt, DaemonPoolState, PermissionDecision } from './types.ts';

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

/** Every prompt in the pool (the inbox's, the office's, then each job's), oldest first; only `scope`'s when given. */
export function pendingPrompts(pool: Partial<DaemonPoolState> | null | undefined, scope?: string): PendingPrompt[] {
  const p = obj(pool);
  const sessions = [obj(p.inbox), obj(p.office), ...Object.values(obj(p.jobs)).map(obj)];
  const out: PendingPrompt[] = [];
  for (const s of sessions) {
    if (typeof s.scope !== 'string' || (scope !== undefined && s.scope !== scope)) continue;
    for (const raw of Array.isArray(s.permissions) ? s.permissions : []) {
      const prompt = readPrompt(raw);
      if (prompt) out.push({ scope: s.scope, prompt });
    }
  }
  return out.sort((a, b) => (a.prompt.at < b.prompt.at ? -1 : a.prompt.at > b.prompt.at ? 1 : 0));
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
export async function postPermission(scope: string, id: string, decision: PermissionDecision, token: string, fetchImpl: typeof fetch = fetch): Promise<DaemonPoolState> {
  const res = await fetchImpl('/api/daemon/permission', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-token': token },
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
