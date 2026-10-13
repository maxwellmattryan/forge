import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from './util.ts';
import { PLUGIN_ROOT } from './paths.ts';
import type { AgentUsage } from './types.ts';

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

/** What importClaudeCodeTranscript returns: AgentUsage's transcript fields, all set, plus the file read. */
export type TranscriptUsage = Required<Pick<AgentUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'toolUses' | 'durationMs' | 'totalTokens' | 'exact' | 'outputEstimated'>> & {
  model: string | null;
  transcript: string;
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
 */
export function importClaudeCodeTranscript(agentId: string, opts: { projectsDir?: string } = {}): TranscriptUsage | null {
  const projects = opts.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  const file = findTranscript(projects, `agent-${agentId}.jsonl`);
  if (!file) return null;
  // usage is a transcript line's raw usage object.
  const byMessage = new Map<string, { usage: any; model: string | null; chars: number }>();
  const toolIds = new Set<string>();
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) {
      firstTs ??= o.timestamp;
      lastTs = o.timestamp;
    }
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
  const out: TranscriptUsage = { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolUses: toolIds.size, durationMs: 0, totalTokens: 0, exact: true, outputEstimated: false, transcript: file };
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
