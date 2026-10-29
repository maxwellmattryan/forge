// The Agents tab's runs panel as plain parts: each agent run's billing split and context composition as bar
// segments with their tokens and share, and the run's duration and status tone. Tool and MCP server names come from
// transcripts, so they stay plain strings the component renders as text. No DOM access.
import { SERIES } from './overview.ts';
import type { Series } from './overview.ts';
import type { AgentRun, ContextComposition, RunBilling } from '../core/types.ts';

const [S1, S2, S3, S4, S5] = SERIES;
/** The rest of a bar: what is not split, and earlier runs. Ember (series-6) stays out: it means "waits on you". */
const REST = 'series-rest';

export type BarSeries = Series | typeof REST;
export type BillingKey = 'cacheRead' | 'cacheWrite' | 'input' | 'output' | 'unsplit';
export type CompositionKey = 'forgePrompt' | 'harness' | 'carried' | 'tool' | 'mcp' | 'otherTools' | 'assistant' | 'user';

/** One bar segment and its legend entry. `name` is the tool name, or the server for `mcp`; null for the rest. */
export interface BarPart {
  key: BillingKey | CompositionKey;
  name: string | null;
  tokens: number;
  /** tokens over the bar's total, 0–1. */
  share: number;
  series: BarSeries;
}

type Raw = Omit<BarPart, 'share'>;

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The non-zero parts with their shares of the parts' sum, which is the bar's total for a well-formed input. */
function withShares(raw: Raw[]): BarPart[] {
  const parts = raw.filter((p) => p.tokens > 0);
  const total = parts.reduce((n, p) => n + p.tokens, 0);
  return parts.map((p) => ({ ...p, share: p.tokens / total }));
}

/**
 * A run's billing split as segments: cache read, cache write, fresh input, output, then what the total holds beyond
 * them (`unsplit`: all of a self-reported `--tokens` run). Zero segments are left out; [] without usage.
 */
export function billingParts(usage: RunBilling | null | undefined): BarPart[] {
  if (!usage) return [];
  const split: Raw[] = [
    { key: 'cacheRead', name: null, tokens: count(usage.cacheRead), series: S1 },
    { key: 'cacheWrite', name: null, tokens: count(usage.cacheWrite), series: S2 },
    { key: 'input', name: null, tokens: count(usage.input), series: S3 },
    { key: 'output', name: null, tokens: count(usage.output), series: S5 },
  ];
  const unsplit = count(usage.totalTokens) - split.reduce((n, p) => n + p.tokens, 0);
  return withShares([...split, { key: 'unsplit', name: null, tokens: Math.max(0, unsplit), series: REST }]);
}

/**
 * A composition as segments: the start prefix (Forge prompt, harness), earlier runs, one per tool group (an MCP
 * server's as `mcp`, the rest as `otherTools`), assistant output and user turns. Zero segments are left out; [] for null.
 */
export function compositionParts(c: ContextComposition | null | undefined): BarPart[] {
  if (!c) return [];
  const tools = (Array.isArray(c.tools) ? c.tools : []).map((p): Raw => {
    if (p.name === 'other') return { key: 'otherTools', name: null, tokens: count(p.tokens), series: S5 };
    if (p.name.startsWith('mcp:')) return { key: 'mcp', name: p.name.slice(4), tokens: count(p.tokens), series: S5 };
    return { key: 'tool', name: p.name, tokens: count(p.tokens), series: S5 };
  });
  return withShares([
    { key: 'forgePrompt', name: null, tokens: count(c.forgePrompt), series: S1 },
    { key: 'harness', name: null, tokens: count(c.harness), series: S3 },
    { key: 'carried', name: null, tokens: count(c.carried), series: REST },
    ...tools,
    { key: 'assistant', name: null, tokens: count(c.assistant), series: S2 },
    { key: 'user', name: null, tokens: count(c.user), series: S4 },
  ]);
}

/** endedAt − startedAt; null when either is unknown. */
export function runDuration(run: Pick<AgentRun, 'startedAt' | 'endedAt'>): number | null {
  const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const end = run.endedAt ? Date.parse(run.endedAt) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/** The runs' total tokens, as the server totals a row's Tokens; null when no run has usage. */
export const runsTotal = (runs: readonly Pick<AgentRun, 'usage'>[]): number | null => runs.reduce<number | null>((n, r) => (r.usage ? (n ?? 0) + count(r.usage.totalTokens) : n), null);

/** The Chip tone for an agent or run status. */
export const statusTone = (status: string | null, running: boolean): string => (running ? 'live' : status === 'done' ? 'ok' : status === 'lost' ? 'warn' : 'muted');
