// The Agents page: the agents running now and the sessions driving jobs. No DOM access.
import type { StateJob } from './types.ts';

const s = (v: unknown): string => String(v ?? '');

export interface RunningAgent {
  job: StateJob;
  role: string;
  model?: string | null;
  round?: number;
  startedAt?: string;
}

export const runningAgents = (jobs: StateJob[]): RunningAgent[] =>
  jobs.flatMap((j) =>
    Object.entries(j.agents ?? {})
      .filter(([, a]) => a.status === 'running')
      .map(([role, a]) => ({ job: j, role, ...a })),
  );

export interface SessionRow {
  session: string;
  since: string | null;
  /** The latest renewal across its jobs. */
  renewedAt: string | null;
  jobs: StateJob[];
  live: boolean;
}

const leaseLive = (l: { driver?: string | null; expiresAt?: string | null } | null | undefined, now: number): boolean => Boolean(l?.driver) && Date.parse(s(l?.expiresAt)) > now;

/** The sessions driving jobs, keyed on each job's lease driver while that lease is live. */
export function agentSessions(jobs: StateJob[], now: number): SessionRow[] {
  const sessions: Record<string, SessionRow> = {};
  for (const j of jobs) {
    const l = j.lease;
    if (!leaseLive(l, now) || !l.driver) continue;
    const row = (sessions[l.driver] ??= { session: l.driver, since: l.since, renewedAt: null, jobs: [], live: true });
    row.jobs.push(j);
    if (l.renewedAt && s(l.renewedAt) > s(row.renewedAt)) row.renewedAt = l.renewedAt;
  }
  return Object.values(sessions);
}
