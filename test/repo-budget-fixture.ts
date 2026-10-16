// Shared by the repo budget, spend and CSV tests: a price table where a run's input tokens are its
// dollars, and a way to append spend at a given time. Not a test file, so importing it runs nothing.
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, setJob } from '../lib/jobs.ts';
import type { Config, RepoBudgetConfig } from '../lib/types.ts';
import * as yaml from '../lib/yaml.ts';

/** A config whose `usd-model` costs $1 per input token, so a run's input is its cost. */
export function dollarConfig(): Config {
  const c = defaults();
  c.usage.pricing = { models: { 'usd-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  return c;
}

/** Appends an agent-end with `usd` dollars (and as many tokens) at `ts`. */
export function spend(root: string, id: string, usd: number, ts: string = new Date().toISOString(), role = 'builder'): void {
  const line = { v: 2, ts, type: 'agent-end', role, model: 'usd-model', usage: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: usd } };
  fs.appendFileSync(path.join(jobDir(root, id), 'events.jsonl'), JSON.stringify(line) + '\n');
}

/**
 * A scratch repo whose config.yml (and the returned config) carry `budget` and the dollar prices,
 * with a finished `spender` job that holds `spent` dollars from now.
 */
export function budgetRepo(budget: Partial<RepoBudgetConfig>, spent = 0, extra: Record<string, unknown> = {}) {
  const repo = tempRepo();
  const root = repo.dir;
  const config = dollarConfig();
  Object.assign(config.budget, budget);
  Object.assign(config, extra);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 10, budget: config.budget, usage: { pricing: config.usage.pricing }, ...extra }));
  const spender = createJob(root, config, { title: 'Spender' });
  setJob(root, spender.id, { stage: 'done', state: 'done' });
  if (spent) spend(root, spender.id, spent);
  return { repo, root, config, spender: spender.id, cleanup: repo.cleanup };
}
