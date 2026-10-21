// What a job's running agents are doing, as plain parts AgentActivity.svelte and the drawer's Agents tab render as
// text: `<role> · <model> · running <elapsed> · <last thing>`, the owner's liveness, and the round's agent rows. The
// last thing is untrusted transcript text, so nothing here builds markup.
import { ago, dur } from './util.ts';
import type { AgentActivity, AgentRow, JobDetail, OwnerStatus } from './types.ts';

/** One activity line's parts. `model` is `—` when unknown; `last` is null when no transcript was found. */
export interface ActivityLine {
  role: string;
  model: string;
  elapsed: string;
  last: string | null;
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Newest `startedAt` first; an unknown start sorts last. */
const byNewest = <T extends { startedAt: string | null }>(a: T, b: T): number => (ms(b.startedAt) || 0) - (ms(a.startedAt) || 0);

export function activityLine(a: AgentActivity, now: number): ActivityLine {
  const started = ms(a.startedAt);
  return {
    role: a.role,
    model: a.model || '—',
    elapsed: dur(Number.isFinite(started) ? Math.max(0, now - started) : null),
    last: a.last?.text ? a.last.text : null,
  };
}

/** The newest running agent and how many others run beside it. */
export function newestActivity(list: readonly AgentActivity[] | null | undefined): { newest: AgentActivity | null; more: number } {
  const sorted = [...(list ?? [])].sort(byNewest);
  return { newest: sorted[0] ?? null, more: Math.max(0, sorted.length - 1) };
}

/** Every running agent, newest first. */
export const sortedActivity = (list: readonly AgentActivity[] | null | undefined): AgentActivity[] => [...(list ?? [])].sort(byNewest);

/** The lease's state: `ok` while live, `warn` once expired, and nothing without a driver. `age` is the last renewal's. */
export function ownerLiveness(o: OwnerStatus | null | undefined, now: number): { tone: 'ok' | 'warn' | null; status: string | null; age: string | null } {
  if (!o || o.status === 'none') return { tone: null, status: null, age: null };
  return { tone: o.status === 'live' ? 'ok' : 'warn', status: o.status, age: ago(o.renewedAt ?? o.since, now) };
}

/** A round agent row with its duration: the recorded one, or the live elapsed time while running. */
export type AgentRowView = AgentRow & { elapsedMs: number | null; running: boolean };

/** The detail's agents of the current round plus any still running, newest first, with live durations. */
export function roundAgents(detail: Pick<JobDetail, 'agents'> | null | undefined, now: number): AgentRowView[] {
  return [...(detail?.agents ?? [])].sort(byNewest).map((a) => {
    const running = a.status === 'running';
    const started = ms(a.startedAt);
    return { ...a, running, elapsedMs: running ? (Number.isFinite(started) ? Math.max(0, now - started) : null) : a.durationMs };
  });
}
