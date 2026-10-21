import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util.ts';
import { PLUGIN_ROOT } from './paths.ts';
import { agentTranscriptById, claudeProjectsDir, openTranscript } from './transcripts.ts';
import type { TranscriptHit } from './transcripts.ts';
import type { AgentUsage, Job } from './types.ts';

/** One model's prices in USD per million tokens: an entry of lib/pricing.json's `models`. */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** lib/pricing.json merged with config.usage.pricing: pricing(). */
export interface PricingTable {
  aliases: Record<string, string>;
  models: Record<string, ModelRate>;
  blend: ModelRate;
  [key: string]: any;
}

/**
 * What importClaudeCodeTranscript returns: AgentUsage's transcript fields, all set, plus the file
 * read and `through`, the transcript's last timestamp (the cursor the next import of this agent
 * passes as `since`).
 */
export type TranscriptUsage = Required<Pick<AgentUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'toolUses' | 'durationMs' | 'totalTokens' | 'exact' | 'outputEstimated'>> & {
  model: string | null;
  transcript: string;
  through: string | null;
};

// Parsed pricing.json: raw input.
let cached: any = null;

export function pricing(overrides: Record<string, any> = {}): PricingTable {
  cached ??= readJson(path.join(PLUGIN_ROOT, 'lib', 'pricing.json'));
  return {
    ...cached,
    aliases: { ...cached.aliases, ...(overrides.aliases ?? {}) },
    models: { ...cached.models, ...(overrides.models ?? {}) },
    blend: { ...cached.blend, ...(overrides.blend ?? {}) },
  };
}

export function resolveModel(model: string | null | undefined, table: PricingTable): string | null {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (table.models[m]) return m;
  if (table.aliases[m]) return table.aliases[m];
  const undated = m.replace(/-\d{8}$/, '');
  if (table.models[undated]) return undated;
  return null;
}

export function estimateCost(
  u: { model?: string | null; totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  overrides?: Record<string, any>,
): { usd: number; model: string | null; method: 'exact' | 'blended' | 'unpriced' } {
  const table = pricing(overrides);
  const model = resolveModel(u.model, table);
  const rate = model ? table.models[model] : null;
  if (!rate) return { usd: 0, model: u.model ?? null, method: 'unpriced' };
  const hasSplit = [u.input, u.output, u.cacheRead, u.cacheWrite].some((n) => (n ?? 0) > 0);
  let usd;
  if (hasSplit) {
    usd = ((u.input ?? 0) * rate.input + (u.output ?? 0) * rate.output + (u.cacheRead ?? 0) * rate.cacheRead + (u.cacheWrite ?? 0) * rate.cacheWrite) / 1e6;
  } else {
    const t = u.totalTokens ?? 0;
    const b = table.blend;
    usd = (t * (b.input * rate.input + b.output * rate.output + b.cacheRead * rate.cacheRead + b.cacheWrite * rate.cacheWrite)) / 1e6;
  }
  return { usd, model, method: hasSplit ? 'exact' : 'blended' };
}

/**
 * Claude Code keeps every subagent's transcript on disk; summing its per-message usage gives an
 * exact input/output/cache breakdown that the completion notification does not carry.
 * Each content block is logged as its own line sharing the message id, and the logged usage is the
 * message_start snapshot: input and cache counts are exact, output_tokens is not. Output is therefore
 * estimated from the logged content (≈3.5 chars/token) whenever that exceeds the logged value.
 * A resumed agent (SendMessage) appends to the same file, so `since` (the previous import's
 * `through`) skips every line at or before it: each import counts, and times, only the new span.
 * A line without a timestamp belongs to the span of the timestamped line before it.
 * Given the job and root, the transcript is looked up under the job's sessions in this repo's project
 * dirs first (lib/transcripts.ts); the scan of every project dir stays as the fallback for an agent
 * whose parent session isn't recorded.
 */
export function importClaudeCodeTranscript(
  agentId: string,
  opts: { projectsDir?: string; since?: string | null; root?: string; job?: Pick<Job, 'id' | 'lease' | 'runs' | 'agents' | 'worktree'> } = {},
): TranscriptUsage | null {
  const projects = opts.projectsDir ?? claudeProjectsDir();
  const hit = opts.root && opts.job ? agentTranscriptById(opts.root, opts.job, agentId, { projects }) : null;
  const file = (hit ? readConfined(hit, projects) : null) ?? readScanned(findTranscript(projects, `agent-${agentId}.jsonl`));
  if (!file) return null;
  return summarise(file.text, file.path, opts.since);
}

/** A located transcript's path and text, read through openTranscript's confined descriptor. */
function readConfined(hit: TranscriptHit, projects: string): { path: string; text: string } | null {
  const t = openTranscript(hit, projects);
  if (!t) return null;
  try {
    return { path: hit.path, text: fs.readFileSync(t.fd, 'utf8') };
  } finally {
    fs.closeSync(t.fd);
  }
}

/** The fallback scan's hit, read as before. */
function readScanned(file: string | null): { path: string; text: string } | null {
  return file ? { path: file, text: fs.readFileSync(file, 'utf8') } : null;
}

function summarise(text: string, file: string, sinceAt: string | null | undefined): TranscriptUsage {
  // usage is a transcript line's raw usage object.
  const byMessage = new Map<string, { usage: any; model: string | null; chars: number }>();
  const toolIds = new Set<string>();
  const since = sinceAt ? Date.parse(sinceAt) : NaN;
  let skipping = !Number.isNaN(since);
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let through: string | null = sinceAt ?? null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) {
      through = o.timestamp;
      if (skipping) skipping = !(Date.parse(o.timestamp) > since);
      if (!skipping) {
        firstTs ??= o.timestamp;
        lastTs = o.timestamp;
      }
    }
    if (skipping) continue;
    const msg = o.message;
    if (o.type !== 'assistant' || !msg?.usage) continue;
    const key = msg.id ?? o.uuid;
    const entry = byMessage.get(key) ?? { usage: msg.usage, model: msg.model ?? null, chars: 0 };
    if ((msg.usage.output_tokens ?? 0) > (entry.usage.output_tokens ?? 0)) entry.usage = msg.usage;
    for (const c of msg.content ?? []) {
      if (c?.type === 'tool_use') {
        if (c.id) toolIds.add(c.id);
        entry.chars += JSON.stringify(c.input ?? {}).length + String(c.name ?? '').length;
      } else if (c?.type === 'text') entry.chars += String(c.text ?? '').length;
      else if (c?.type === 'thinking') entry.chars += String(c.thinking ?? '').length;
    }
    byMessage.set(key, entry);
  }
  const out: TranscriptUsage = { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolUses: toolIds.size, durationMs: 0, totalTokens: 0, exact: true, outputEstimated: false, transcript: file, through };
  for (const m of byMessage.values()) {
    const u = m.usage;
    out.model ??= m.model;
    out.input += u.input_tokens ?? 0;
    out.cacheRead += u.cache_read_input_tokens ?? 0;
    out.cacheWrite += u.cache_creation_input_tokens ?? 0;
    const estimated = Math.ceil(m.chars / 3.5);
    if (estimated > (u.output_tokens ?? 0)) out.outputEstimated = true;
    out.output += Math.max(u.output_tokens ?? 0, estimated);
  }
  out.totalTokens = out.input + out.output + out.cacheRead + out.cacheWrite;
  if (firstTs && lastTs) out.durationMs = Date.parse(lastTs) - Date.parse(firstTs);
  return out;
}

function findTranscript(projects: string, name: string): string | null {
  if (!fs.existsSync(projects)) return null;
  for (const proj of fs.readdirSync(projects)) {
    const projDir = path.join(projects, proj);
    let sessions;
    try {
      sessions = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const candidate = path.join(projDir, s.name, 'subagents', name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}
