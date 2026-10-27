// A role's agent runs as the job detail serves them: the runs that ended before runHistory existed, rebuilt from
// agent-end events, then the recorded ones (recordRun in lib/core/job/schema.ts), their total, and the agents
// without either for /api/state.
import { MAX_AGENT_RUNS, addBilling, cleanRun, runBilling } from '#core/job/schema.ts';
import type { AgentRun, JobAgent, JobEvent } from '#core/types.ts';

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * The first `wanted` runs of a role rebuilt from its events: each agent-start pairs with the next agent-end, a further
 * agent-end with usage before the next start folds into that run, and one with no run to fold into and no usage is
 * skipped. They carry billing only, no round and no composition.
 */
function legacyRuns(role: string, wanted: number, events: readonly JobEvent[]): AgentRun[] {
  const runs: AgentRun[] = [];
  let open: { startedAt: string | null; model: string | null } | null = null;
  for (const e of events) {
    if (e?.role !== role) continue;
    if (e.type === 'agent-start') {
      if (runs.length >= wanted) break;
      open = { startedAt: strOrNull(e.ts), model: strOrNull(e.model) };
    } else if (e.type === 'agent-end') {
      const usage = runBilling(e.usage);
      if (!open && runs.length) {
        if (usage) addBilling(runs.at(-1)!, usage);
        continue;
      }
      if (!open && !usage) continue;
      runs.push({ round: null, startedAt: open?.startedAt ?? null, endedAt: strOrNull(e.ts), status: strOrNull(e.status) ?? 'done', model: strOrNull(e.model) ?? open?.model ?? null, usage, composition: null });
      open = null;
    }
  }
  return runs.slice(0, wanted);
}

/** Every ended agent run of a role, oldest first: its legacy runs (at most MAX_AGENT_RUNS), then runHistory's well-formed entries. */
export function agentRuns(role: string, agent: JobAgent, events: readonly JobEvent[]): AgentRun[] {
  const wanted = Math.min(Math.floor(count(agent.legacyRuns)), MAX_AGENT_RUNS);
  const legacy = wanted > 0 ? legacyRuns(role, wanted, events) : [];
  const recorded = Array.isArray(agent.runHistory) ? agent.runHistory.map(cleanRun).filter((r): r is AgentRun => r !== null) : [];
  return [...legacy, ...recorded];
}

/** The runs' total tokens; null when no run has usage. */
export function runsTokens(runs: readonly AgentRun[]): number | null {
  let total: number | null = null;
  for (const r of runs) if (r.usage) total = (total ?? 0) + r.usage.totalTokens;
  return total;
}

/** The agents without runHistory and legacyRuns, so /api/state and the detail's job don't grow with every run. */
export function withoutRunHistory(agents: Record<string, JobAgent>): Record<string, Omit<JobAgent, 'runHistory' | 'legacyRuns'>> {
  return Object.fromEntries(
    Object.entries(agents ?? {}).map(([role, a]) => {
      if (!a || typeof a !== 'object') return [role, a];
      const { runHistory: _h, legacyRuns: _l, ...rest } = a;
      return [role, rest];
    }),
  );
}
