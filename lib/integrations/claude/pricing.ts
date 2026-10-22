// Model prices (lib/pricing.json merged with config.usage.pricing) and the cost estimate built on
// them. A leaf, so jobs.ts can price usage without loading the transcript reader in usage.ts.
import path from 'node:path';
import { readJson } from '../../core/os/fs.ts';
import { PLUGIN_ROOT } from '../../core/paths.ts';

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

// Parsed pricing.json: raw input.
let cached: any = null;

export function pricing(overrides: Record<string, any> = {}): PricingTable {
  cached ??= readJson(path.join(PLUGIN_ROOT, 'lib', 'integrations', 'claude', 'pricing.json'));
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
