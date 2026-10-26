// A role's agent runs: the bounded per-run list `forge job agent end` records on the agent record (runHistory), the
// runs that ended before it existed rebuilt from agent-end events, and the agents without either for /api/state.
import type { AgentRun, AgentUsage, ContextComposition, JobAgent, JobEvent, RunBilling } from '../types.ts';

/** The runs one agent record keeps; the oldest drop first. */
export const MAX_AGENT_RUNS = 50;

/** A tool part's name as composeContext stores it: `mcp:` and a 64-char name, with room to spare. */
const MAX_PART_NAME = 70;

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * A run's billing split from the usage its end reported: counts that are not finite numbers ≥ 0 read as 0, and the
 * total is the reported one or, as addUsage computes it, their sum. Null without usage.
 */
export function runBilling(u?: AgentUsage | null): RunBilling | null {
  if (!u || typeof u !== 'object') return null;
  const b = { input: count(u.input), output: count(u.output), cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite) };
  return { ...b, totalTokens: isCount(u.totalTokens) ? u.totalTokens : b.input + b.output + b.cacheRead + b.cacheWrite };
}

/** Adds `more`'s counts to `run`'s billing. */
function fold(run: AgentRun, more: RunBilling): void {
  const u = run.usage;
  run.usage = u
    ? { input: u.input + more.input, output: u.output + more.output, cacheRead: u.cacheRead + more.cacheRead, cacheWrite: u.cacheWrite + more.cacheWrite, totalTokens: u.totalTokens + more.totalTokens }
    : more;
}

/** What recordAgent knows about an end: whether the agent was running, and what the end recorded. */
export interface RunEnd {
  wasRunning: boolean;
  at: string | null;
  round: number;
  status: string;
  model: string | null;
  usage?: AgentUsage;
  composition?: ContextComposition | null;
}

/**
 * Records an end on the agent's runHistory. The end of a running agent is a new run, usage or not (a lost run has
 * none). A further end with usage on an ended agent adds its counts to the last run and, when it has one, its
 * composition; with no recorded run it is a run of its own unless legacy runs exist, whose events fold it in (an end
 * without usage on an ended agent records nothing). The list keeps the newest MAX_AGENT_RUNS.
 */
export function recordRun(a: JobAgent, end: RunEnd): void {
  if (!Array.isArray(a.runHistory)) a.runHistory = [];
  const list = a.runHistory;
  const usage = runBilling(end.usage);
  const last = list.at(-1);
  if (!end.wasRunning) {
    if (!usage) return;
    if (last) {
      fold(last, usage);
      if (end.composition) last.composition = end.composition;
      return;
    }
    if (count(a.legacyRuns) > 0) return;
  }
  list.push({
    round: end.round,
    startedAt: end.wasRunning ? (a.startedAt ?? null) : null,
    endedAt: end.at,
    status: end.status,
    model: end.model,
    usage,
    composition: end.composition ?? null,
  });
  if (list.length > MAX_AGENT_RUNS) list.splice(0, list.length - MAX_AGENT_RUNS);
}

/** A stored composition, or null unless every count is a finite number ≥ 0, every tool part is named, and the parts sum to the total. */
export function cleanComposition(v: unknown): ContextComposition | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const keys = ['total', 'forgePrompt', 'harness', 'carried', 'assistant', 'user'] as const;
  if (!keys.every((k) => isCount(c[k])) || !Array.isArray(c.tools)) return null;
  const tools: { name: string; tokens: number }[] = [];
  for (const p of c.tools as unknown[]) {
    const part = p as { name?: unknown; tokens?: unknown } | null;
    if (!part || typeof part !== 'object' || typeof part.name !== 'string' || !part.name || part.name.length > MAX_PART_NAME || !isCount(part.tokens)) return null;
    tools.push({ name: part.name, tokens: part.tokens });
  }
  const n = (k: (typeof keys)[number]) => c[k] as number;
  const sum = n('forgePrompt') + n('harness') + n('carried') + n('assistant') + n('user') + tools.reduce((s, p) => s + p.tokens, 0);
  if (sum !== n('total')) return null;
  return { total: n('total'), forgePrompt: n('forgePrompt'), harness: n('harness'), carried: n('carried'), tools, assistant: n('assistant'), user: n('user') };
}

/** A stored billing split, or null unless every count is a finite number ≥ 0. */
function cleanBilling(v: unknown): RunBilling | null {
  if (!v || typeof v !== 'object') return null;
  const u = v as Record<string, unknown>;
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
  if (!keys.every((k) => isCount(u[k]))) return null;
  return { input: u.input as number, output: u.output as number, cacheRead: u.cacheRead as number, cacheWrite: u.cacheWrite as number, totalTokens: u.totalTokens as number };
}

/** A stored run, or null when it is not an object or its usage is malformed; a malformed composition reads as null. */
function cleanRun(v: unknown): AgentRun | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const usage = r.usage == null ? null : cleanBilling(r.usage);
  if (r.usage != null && !usage) return null;
  return {
    round: typeof r.round === 'number' && Number.isInteger(r.round) ? r.round : null,
    startedAt: strOrNull(r.startedAt),
    endedAt: strOrNull(r.endedAt),
    status: strOrNull(r.status),
    model: strOrNull(r.model),
    usage,
    composition: cleanComposition(r.composition),
  };
}

/**
 * The runs that ended before runHistory existed, rebuilt from the role's events: each agent-start pairs with the
 * next agent-end, a further agent-end with usage before the next start folds into that run, and one with no run
 * to fold into and no usage is skipped. They carry billing only, no round and no composition.
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
        if (usage) fold(runs.at(-1)!, usage);
        continue;
      }
      if (!open && !usage) continue;
      runs.push({ round: null, startedAt: open?.startedAt ?? null, endedAt: strOrNull(e.ts), status: strOrNull(e.status) ?? 'done', model: strOrNull(e.model) ?? open?.model ?? null, usage, composition: null });
      open = null;
    }
  }
  return runs.slice(0, wanted);
}

/** Every ended run of a role, oldest first: its legacy runs (at most MAX_AGENT_RUNS), then runHistory's well-formed entries. */
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
