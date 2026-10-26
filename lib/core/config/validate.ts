// validateConfig, and the validators for the config sections that have no file of their own.
// Placement rule: a section's validator is one `<section>Problems(c: unknown)` function. It lives in
// that area's `*-config.ts` file when one exists (backing-config.ts, checkout-config.ts,
// endpoints-config.ts, notify-config.ts, secret-refs-config.ts, config-models.ts, config-trust.ts,
// plus components.ts, member-repos.ts and policy-check.ts), and otherwise here. validateConfig only
// calls them, plus its one-line enum checks. Imports no config.ts, which re-exports these.
import fs from 'node:fs';
import path from 'node:path';
import { backingProblems } from './validators/backing.ts';
import { checkoutProblems } from './validators/checkout.ts';
import { componentProblems } from './components.ts';
import { effortProblems, modelProblems, validModel } from './models.ts';
import { daemonProblems } from './trust.ts';
import { placeholderProblems } from './validators/endpoints.ts';
import { downstreamProblems, releaseProblems, repoProblems } from '#engine/project/member-repos.ts';
import { notifyProblems } from './validators/notify.ts';
import { commandEnvProblems } from './validators/command-env.ts';
import { requiredChecksProblems } from './validators/required-checks.ts';
import { PLUGIN_ROOT, exists, paths, resolveFrom } from '../paths.ts';
import { globProblem, policyProblems } from './validators/policy-check.ts';
import { CONFIG_SCHEMA_VERSION, EFFORTS, FOREMAN_SHIP, MANDATE_ON_UNFINISHABLE, MANDATE_ORDERS, MANDATE_UNTIL, OFFICE_GATES, REPO_BUDGET_MODES, reservedGateEntry } from '../job/schema.ts';
import { secretRefProblems } from './validators/secret-refs.ts';
import { MAX_GATE_RUNS } from '#api/constants.ts';
import { instructionsProblems } from './validators/instructions.ts';
import { isMap, show } from '../shape.ts';
import type { VerifyEntry } from '../types.ts';
import { ForgeError } from '../errors.ts';

/** budget.*: USD caps null or a number >= 0, tokensPerMonth null or an integer >= 0, onExceeded hold|warn. */
function repoBudgetProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const b = cfg.budget;
  if (b === undefined) return [];
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return [`budget must be a map (got ${JSON.stringify(b)})`];
  const problems: string[] = [];
  for (const key of ['usdPerDay', 'usdPerMonth']) {
    const v = b[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`budget.${key} must be null or a number >= 0 (got ${JSON.stringify(v)})`);
  }
  const t = b.tokensPerMonth;
  if (t !== null && t !== undefined && (!Number.isInteger(t) || t < 0)) problems.push(`budget.tokensPerMonth must be null or an integer >= 0 (got ${JSON.stringify(t)})`);
  if (b.onExceeded !== undefined && !(REPO_BUDGET_MODES as readonly unknown[]).includes(b.onExceeded)) {
    problems.push(`budget.onExceeded must be one of ${REPO_BUDGET_MODES.join(', ')} (got ${JSON.stringify(b.onExceeded)})`);
  }
  return problems;
}

/** retention.jobsDays and retention.logsDays: 1 day to 10 years. */
export const RETENTION_DAYS = { min: 1, max: 3650 } as const;
/** retention.logMaxBytes: 1 MiB to 1 GiB. */
const LOG_MAX_BYTES = { min: 1_048_576, max: 1_073_741_824 } as const;

/** retention.*: each key null or an integer in its range. */
function retentionProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const r = cfg.retention;
  if (r === undefined) return [];
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return [`retention must be a map (got ${JSON.stringify(r)})`];
  const problems: string[] = [];
  const check = (key: string, range: { min: number; max: number }) => {
    const v = r[key];
    if (v === null || v === undefined) return;
    if (!Number.isInteger(v) || v < range.min || v > range.max) problems.push(`retention.${key} must be null or an integer from ${range.min} to ${range.max} (got ${JSON.stringify(v)})`);
  };
  check('jobsDays', RETENTION_DAYS);
  check('logsDays', RETENTION_DAYS);
  check('logMaxBytes', LOG_MAX_BYTES);
  return problems;
}

/** environments.maxRunning: running job environments at once. */
const MAX_RUNNING = { min: 1, max: 64 } as const;

/** environments.*: maxRunning null or an integer from 1 to 64. */
function environmentsProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const e = cfg.environments;
  if (e === undefined) return [];
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return [`environments must be a map (got ${JSON.stringify(e)})`];
  const v = e.maxRunning;
  if (v === null || v === undefined) return [];
  if (!Number.isInteger(v) || v < MAX_RUNNING.min || v > MAX_RUNNING.max) return [`environments.maxRunning must be null or an integer from ${MAX_RUNNING.min} to ${MAX_RUNNING.max} (got ${JSON.stringify(v)})`];
  return [];
}

/** outcomes.windowDays: a day to a year. */
const OUTCOME_WINDOW_DAYS = { min: 1, max: 365 } as const;

/** outcomes.windowDays: an integer in its range. */
function outcomesProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const o = cfg.outcomes;
  if (o === undefined) return [];
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [`outcomes must be a map (got ${JSON.stringify(o)})`];
  const v = o.windowDays;
  if (v === undefined) return [];
  const { min, max } = OUTCOME_WINDOW_DAYS;
  return !Number.isInteger(v) || v < min || v > max ? [`outcomes.windowDays must be an integer from ${min} to ${max} (got ${JSON.stringify(v)})`] : [];
}

/** scoring.sample a number from 0 to 1, scoring.model null or a model MODEL_RE accepts. */
function scoringProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const s = cfg.scoring;
  if (s === undefined) return [];
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return [`scoring must be a map (got ${JSON.stringify(s)})`];
  const problems: string[] = [];
  const v = s.sample;
  if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) problems.push(`scoring.sample must be a number from 0 to 1 (got ${JSON.stringify(v)})`);
  const m = s.model;
  if (m !== undefined && m !== null && !validModel(m)) problems.push(`scoring.model must be a model alias or id (letters, digits and . _ : - [ ]) or null (got ${JSON.stringify(m)})`);
  return problems;
}

/**
 * Returns human-readable problems; an empty list means the config is usable.
 */
export function validateConfig(c: unknown, root: string): string[] {
  if (!isMap(c)) return [`config must be a map (got ${show(c)})`];
  const problems: string[] = [];
  const oneOf = (key: string, value: any, allowed: any[]) => {
    if (!allowed.includes(value)) problems.push(`${key} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(value)})`);
  };
  if (c.schemaVersion > CONFIG_SCHEMA_VERSION)
    problems.push(`config schemaVersion ${c.schemaVersion} is newer than this Forge (${CONFIG_SCHEMA_VERSION}); update the plugin`);
  oneOf('tracker.kind', c.tracker.kind, ['local', 'github', 'none', ...customTrackers(root)]);
  oneOf('tracker.github.statusSync', c.tracker.github.statusSync, ['none', 'labels', 'project', 'both']);
  oneOf('pipeline.plan', c.pipeline.plan, ['auto', 'always', 'never']);
  oneOf('pipeline.split', c.pipeline.split, ['ask', 'auto', 'never']);
  oneOf('pipeline.specApproval', c.pipeline.specApproval, ['always', 'large', 'never']);
  oneOf('pipeline.design', c.pipeline.design, ['none', 'reference', 'mockup']);
  oneOf('pr.conflicts', c.pr.conflicts, ['ask', 'fix', 'defer']);
  oneOf('pr.updateStrategy', c.pr.updateStrategy, ['merge', 'rebase']);
  oneOf('pr.integrationReview', c.pr.integrationReview, ['always', 'code-only']);
  oneOf('merge.method', c.merge.method, ['squash', 'merge', 'rebase']);
  problems.push(...requiredChecksProblems(c));
  oneOf('infra.mode', c.infra.mode, ['human', 'plan-only', 'agent']);
  oneOf('worktrees.cleanup', c.worktrees.cleanup, ['on-merge', 'manual']);
  oneOf('aiAttribution', c.aiAttribution, ['forbid', 'allow']);
  problems.push(...releaseProblems(c.release, 'release'));
  if (c.runtime?.diversity !== undefined && typeof c.runtime.diversity !== 'boolean')
    problems.push(`runtime.diversity must be true or false (got ${JSON.stringify(c.runtime.diversity)})`);
  oneOf('verifyIntegrity', c.verifyIntegrity, ['warn', 'block']);
  oneOf('verifySecrets', c.verifySecrets, ['block', 'warn']);
  if (!Array.isArray(c.review.panel) || !c.review.panel.length) problems.push('review.panel needs at least one reviewer');
  for (const r of c.review.panel ?? []) {
    if (!r?.name) {
      problems.push('every review.panel entry needs a name');
      continue;
    }
    if (!reviewerChecklist(root, r.name, r.checklist))
      problems.push(`reviewer "${r.name}" has no checklist (looked in .forge/reviewers/ and the plugin's reviewers/)`);
    if (r.needsApp !== undefined && typeof r.needsApp !== 'boolean')
      problems.push(`review.panel "${r.name}".needsApp must be true or false (got ${JSON.stringify(r.needsApp)})`);
    if (r.alwaysOnRework !== undefined && typeof r.alwaysOnRework !== 'boolean')
      problems.push(`review.panel "${r.name}".alwaysOnRework must be true or false (got ${JSON.stringify(r.alwaysOnRework)})`);
    if (r.paths !== undefined) problems.push(...panelPathsProblems(r.name, r.paths));
    problems.push(...pathsOnlyProblems(r));
  }
  oneOf('verifyE2e.when', c.verifyE2e?.when, ['ui', 'always', 'never']);
  const e2ePaths = c.verifyE2e?.paths;
  if (!Array.isArray(e2ePaths) || e2ePaths.some((p: any) => typeof p !== 'string' || !p.trim()))
    problems.push(`verifyE2e.paths must be a list of non-empty strings (got ${JSON.stringify(e2ePaths)})`);
  problems.push(...generatedProblems(c));
  problems.push(...worktreeSeedProblems(c));
  problems.push(...verifyProblems(c));
  problems.push(...effortProblems(c));
  problems.push(...modelProblems(c));
  if (c.review?.onRework !== undefined) oneOf('review.onRework', c.review.onRework, ['narrow', 'full']);
  if (!Number.isInteger(c.pipeline.maxRounds) || c.pipeline.maxRounds < 1) problems.push('pipeline.maxRounds must be a positive integer');
  const total = c.pipeline.maxTotalRounds;
  if (total !== null && total !== undefined && !(Number.isInteger(total) && total >= 1))
    problems.push(`pipeline.maxTotalRounds must be null or a positive integer (got ${JSON.stringify(total)})`);
  const ci = c.pr.maxCiReworks;
  if (ci !== undefined && !(Number.isInteger(ci) && ci >= 0)) problems.push(`pr.maxCiReworks must be an integer >= 0 (got ${JSON.stringify(ci)})`);
  for (const [k, v] of Object.entries(c.pipeline.budget ?? {})) {
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`pipeline.budget.${k} must be null or a non-negative number (got ${JSON.stringify(v)})`);
    else if (k === 'verifyRetries' && !Number.isInteger(v)) problems.push(`pipeline.budget.verifyRetries must be null or a non-negative integer (got ${v})`);
  }
  problems.push(...daemonProblems(c, root));
  problems.push(...foremanProblems(c));
  problems.push(...policyProblems(c));
  problems.push(...retentionProblems(c));
  problems.push(...environmentsProblems(c));
  problems.push(...outcomesProblems(c));
  problems.push(...scoringProblems(c));
  problems.push(...notifyProblems(c));
  problems.push(...commandEnvProblems(c));
  problems.push(...componentProblems(c));
  problems.push(...repoProblems(c, root));
  problems.push(...checkoutProblems(c));
  problems.push(...backingProblems(c));
  problems.push(...secretRefProblems(c));
  problems.push(...placeholderProblems(c));
  problems.push(...downstreamProblems(c));
  problems.push(...repoBudgetProblems(c));
  problems.push(...improveProblems(c));
  problems.push(...instructionsProblems(c));
  return problems;
}

/** improve.experiments and evals.recall: the settlement thresholds and the recall gate's paths. */
function improveProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const problems: string[] = [];
  const exp = cfg.improve?.experiments;
  const positive = (k: 'minJobs' | 'maxJobs') => {
    const v = exp?.[k];
    if (Number.isInteger(v) && v >= 1) return true;
    problems.push(`improve.experiments.${k} must be a positive integer (got ${JSON.stringify(v)})`);
    return false;
  };
  if (!exp || typeof exp !== 'object' || Array.isArray(exp)) problems.push(`improve.experiments must be a map with minJobs and maxJobs (got ${JSON.stringify(exp)})`);
  else if (positive('minJobs') && positive('maxJobs') && exp.maxJobs < exp.minJobs)
    problems.push(`improve.experiments.maxJobs (${exp.maxJobs}) must be at least minJobs (${exp.minJobs})`);
  const paths = cfg.evals?.recall?.paths;
  if (!Array.isArray(paths) || paths.some((p: unknown) => typeof p !== 'string' || !p.trim()))
    problems.push(`evals.recall.paths must be a list of non-empty strings (got ${JSON.stringify(paths)?.slice(0, 80)})`);
  return problems;
}

/** foreman.*: at run time an unknown `decides` class is ignored and an invalid `reserved` fails closed. */
export function foremanProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const f = cfg.foreman;
  if (f === undefined) return [];
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return [`foreman must be a map (got ${JSON.stringify(f)})`];
  const problems: string[] = [];
  if (f.enabled !== undefined && typeof f.enabled !== 'boolean') problems.push(`foreman.enabled must be true or false (got ${JSON.stringify(f.enabled)})`);
  if (!Array.isArray(f.decides)) problems.push(`foreman.decides must be a list of gate classes (got ${JSON.stringify(f.decides)})`);
  else
    for (const g of f.decides)
      if (!(OFFICE_GATES as readonly unknown[]).includes(g)) problems.push(`foreman.decides entry ${JSON.stringify(g)} is not a gate class (${OFFICE_GATES.join(' | ')})`);
  if (!Array.isArray(f.reserved) || f.reserved.some((p: unknown) => typeof p !== 'string' || !p.trim()))
    problems.push(`foreman.reserved must be a list of non-empty strings (got ${JSON.stringify(f.reserved)}); until fixed, every gate stays with a human`);
  else
    for (const p of f.reserved as string[]) {
      if (reservedGateEntry(p) !== 'invalid') continue;
      const t = p.trim();
      const exact = /^gate:/.test(t) && !/\s/.test(t);
      problems.push(
        `foreman.reserved entry ${JSON.stringify(t)} ${exact ? 'names no gate class' : 'is a mis-written class reservation'} (write exactly gate:<class>, lowercase with no spaces, the class one of ${OFFICE_GATES.join(' | ')}); until fixed, every gate stays with a human`,
      );
    }
  if (!(FOREMAN_SHIP as readonly unknown[]).includes(f.ship)) problems.push(`foreman.ship must be one of ${FOREMAN_SHIP.join(' | ')} (got ${JSON.stringify(f.ship)})`);
  problems.push(...foremanOfficeProblems(f));
  return problems;
}

/**
 * The Office's foreman.* keys (model, effort, cadence, assistants, surveyors, mandate), each checked
 * only when present, so a partial block a user wrote still merges over the defaults.
 */
function foremanOfficeProblems(f: Record<string, any>): string[] {
  const problems: string[] = [];
  const got = (v: unknown) => `(got ${JSON.stringify(v)})`;
  const int = (key: string, v: unknown, min: number, max: number) => {
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= min && (v as number) <= max)) problems.push(`foreman.${key} must be an integer ${min}-${max} ${got(v)}`);
  };
  const model = (key: string, v: unknown) => {
    if (v !== undefined && !validModel(v)) problems.push(`foreman.${key} must be a model alias or id (letters, digits and . _ : - [ ]) ${got(v)}`);
  };
  const effort = (key: string, v: unknown) => {
    if (v !== undefined && v !== null && !(EFFORTS as readonly unknown[]).includes(v)) problems.push(`foreman.${key} must be one of ${EFFORTS.join(' | ')}, or null ${got(v)}`);
  };
  const bool = (key: string, v: unknown) => {
    if (v !== undefined && typeof v !== 'boolean') problems.push(`foreman.${key} must be true or false ${got(v)}`);
  };
  const oneOf = (key: string, v: unknown, allowed: readonly string[]) => {
    if (v !== undefined && !allowed.includes(v as string)) problems.push(`foreman.${key} must be one of ${allowed.join(' | ')} ${got(v)}`);
  };
  /** The sub-map at `key` when it is a map; a problem and null when it is present but not one. */
  const map = (key: string, v: unknown): Record<string, any> | null => {
    if (v === undefined) return null;
    if (isMap(v)) return v;
    problems.push(`foreman.${key} must be a map ${got(v)}`);
    return null;
  };
  model('model', f.model);
  effort('effort', f.effort);
  int('cadence', f.cadence, 1, 1440);
  for (const role of ['assistants', 'surveyors'] as const) {
    const m = map(role, f[role]);
    if (!m) continue;
    bool(`${role}.enabled`, m.enabled);
    model(`${role}.model`, m.model);
    effort(`${role}.effort`, m.effort);
    if (role === 'assistants') {
      int('assistants.parallel', m.parallel, 1, MAX_GATE_RUNS);
      // The foreman-gate-runs step moved it; written again by hand, it would be ignored without a word.
      if (Object.hasOwn(m, 'sessions')) problems.push('foreman.assistants has unknown key "sessions": gate runs replaced the assistant sessions; set foreman.assistants.parallel');
    }
  }
  const m = map('mandate', f.mandate);
  if (!m) return problems;
  oneOf('mandate.until', m.until, MANDATE_UNTIL);
  int('mandate.maxJobs', m.maxJobs, 1, 16);
  oneOf('mandate.order', m.order, MANDATE_ORDERS);
  if (m.decides !== undefined && (!Array.isArray(m.decides) || m.decides.some((g: unknown) => !(OFFICE_GATES as readonly unknown[]).includes(g))))
    problems.push(`foreman.mandate.decides must be a list of gate classes (${OFFICE_GATES.join(' | ')}) ${got(m.decides)}`);
  const budget = map('mandate.budget', m.budget);
  if (budget) {
    const usd = budget.usd;
    if (usd !== undefined && !(typeof usd === 'number' && Number.isFinite(usd) && usd > 0 && usd <= 100000)) problems.push(`foreman.mandate.budget.usd must be a number over 0 and at most 100000 ${got(usd)}`);
    int('mandate.budget.jobs', budget.jobs, 1, 1000);
  }
  const stall = map('mandate.stall', m.stall);
  if (stall) {
    int('mandate.stall.cadences', stall.cadences, 1, 100);
    int('mandate.stall.bounces', stall.bounces, 1, 100);
  }
  oneOf('mandate.onUnfinishable', m.onUnfinishable, MANDATE_ON_UNFINISHABLE);
  return problems;
}

/**
 * Why `verify` can't be run as written: not a list, an entry that is neither a step name nor a
 * non-empty list of step names (a nested list included), or a step listed twice. A name with no
 * command is not a shape problem: verify reports that step skipped.
 */
export function verifyShapeProblems(verify: unknown): string[] {
  if (!Array.isArray(verify)) return [`verify must be a list of step names or lists of step names (got ${JSON.stringify(verify)})`];
  const isName = (n: unknown): n is string => typeof n === 'string' && n.trim() !== '';
  const problems: string[] = [];
  const seen = new Set<string>();
  const twice = new Set<string>();
  verify.forEach((entry: unknown, i) => {
    const names = isName(entry) ? [entry] : Array.isArray(entry) && entry.length && entry.every(isName) ? entry : null;
    if (!names) {
      problems.push(`verify entry ${i + 1} must be a step name or a non-empty list of step names (got ${JSON.stringify(entry)})`);
      return;
    }
    for (const n of names) {
      if (seen.has(n) && !twice.has(n)) {
        twice.add(n);
        problems.push(`verify step "${n}" is listed more than once`);
      }
      seen.add(n);
    }
  });
  return problems;
}

/** Shape problems, then every step name (inside groups too) that is not a key in `commands`. */
function verifyProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const commands = cfg.commands && typeof cfg.commands === 'object' ? cfg.commands : {};
  const unknown = [...new Set(verifySteps(cfg.verify))].filter((n) => !Object.hasOwn(commands, n));
  return [...verifyShapeProblems(cfg.verify), ...unknown.map((n) => `verify step "${n}" is not a key in commands`)];
}

/** `verify` as groups run in order; a plain step name is a group of one. Throws on the first shape problem. */
export function verifyGroups(verify: unknown): string[][] {
  const [problem] = verifyShapeProblems(verify);
  if (problem) throw new ForgeError(`verify: ${problem}`);
  return (verify as VerifyEntry[]).map((e) => (typeof e === 'string' ? [e] : [...e]));
}

/** Every step name in `verify`, groups flattened, ignoring anything malformed: for "is X listed" checks. */
export function verifySteps(verify: unknown): string[] {
  if (!Array.isArray(verify)) return [];
  return verify.flatMap((e: unknown) => (typeof e === 'string' ? [e] : Array.isArray(e) ? e.filter((n): n is string => typeof n === 'string') : []));
}

/**
 * A panel entry's `paths`: the same rules as `worktrees.generated`, so a glob can't read as an
 * option, pathspec magic or an exclusion, or point outside the repo. Each message names the lens.
 */
export function panelPathsProblems(name: string, paths: unknown): string[] {
  const key = `review.panel ${JSON.stringify(String(name))}.paths`;
  if (!Array.isArray(paths)) return [`${key} must be a list of paths or globs (got ${JSON.stringify(paths)})`];
  return paths.map((g) => globProblem(g, key)).filter((p): p is string => p !== null);
}

/** A panel entry's `pathsOnly`: a boolean, and only on an entry with paths to hit. */
export function pathsOnlyProblems(r: { name?: unknown; pathsOnly?: unknown; paths?: unknown }): string[] {
  if (r.pathsOnly === undefined) return [];
  const key = `review.panel ${JSON.stringify(String(r.name ?? ''))}.pathsOnly`;
  if (typeof r.pathsOnly !== 'boolean') return [`${key} must be true or false (got ${JSON.stringify(r.pathsOnly)})`];
  const hasPaths = Array.isArray(r.paths) && r.paths.some((p) => typeof p === 'string' && p.trim());
  return r.pathsOnly && !hasPaths ? [`${key} needs non-empty paths: a pathsOnly lens with none would never run`] : [];
}

/**
 * Why `p` can't be a `worktrees.seed.paths` or `.key` entry, or null. Each becomes a `cp` argument
 * and a path Forge deletes, so it must stay a plain relative path inside the worktree: never an
 * option, a glob, `..` or the worktree's `.git`. seed.ts checks again before it touches a path.
 */
export function seedPathProblem(p: unknown, at: string): string | null {
  const shown = JSON.stringify(p)?.slice(0, 80);
  if (typeof p !== 'string' || !p || p.length > 200) return `${at} must be a non-empty path of at most 200 characters (got ${shown})`;
  if (/^[/-]|[\\*?[]|[\x00-\x1f\x7f]/.test(p)) return `${at} must be a relative path with no leading / or -, and no \\, glob characters or control characters (got ${shown})`;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return `${at} must have no empty, . or .. segment (got ${shown})`;
  if (segs[0].toLowerCase() === '.git') return `${at} must not be inside .git (got ${shown})`;
  return null;
}

/** worktrees.seed: a map of relative-path lists (no duplicates, no nested paths) and command lists, with key files whenever paths are set. */
function worktreeSeedProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const s = cfg.worktrees?.seed;
  if (s === undefined) return [];
  if (!isMap(s)) return [`worktrees.seed must be a map (got ${show(s)})`];
  const problems: string[] = [];
  const pathList = (k: 'paths' | 'key'): string[] => {
    const v = s[k];
    if (!Array.isArray(v)) {
      problems.push(`worktrees.seed.${k} must be a list of relative paths (got ${show(v)})`);
      return [];
    }
    const ok: string[] = [];
    v.forEach((p: unknown, i: number) => {
      const bad = seedPathProblem(p, `worktrees.seed.${k}[${i}]`);
      if (bad) problems.push(bad);
      else if (ok.includes(p as string)) problems.push(`worktrees.seed.${k} lists ${JSON.stringify(p)} more than once`);
      else ok.push(p as string);
    });
    return ok;
  };
  const paths = pathList('paths');
  const key = pathList('key');
  for (const a of paths) for (const b of paths) if (b.startsWith(`${a}/`)) problems.push(`worktrees.seed.paths entry ${JSON.stringify(b)} sits inside ${JSON.stringify(a)}`);
  for (const k of ['setup', 'warm'] as const) {
    const v = s[k];
    if (!Array.isArray(v) || v.some((x: unknown) => typeof x !== 'string' || !x.trim())) problems.push(`worktrees.seed.${k} must be a list of non-empty commands (got ${show(v)})`);
  }
  if (Array.isArray(s.paths) && s.paths.length && Array.isArray(s.key) && !s.key.length) problems.push('worktrees.seed.key must name at least one file when worktrees.seed.paths is set');
  return problems;
}

/** `worktrees.generated` and `generatedBy`: each glob usable, and a configured command to rebuild them. */
function generatedProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const gen = cfg.worktrees?.generated;
  if (gen === undefined) return [];
  if (!Array.isArray(gen)) return [`worktrees.generated must be a list of paths or globs (got ${JSON.stringify(gen)})`];
  const problems = gen.map((g: unknown) => globProblem(g)).filter((p): p is string => p !== null);
  const by = cfg.worktrees?.generatedBy;
  if (gen.length && (typeof by !== 'string' || !Object.hasOwn(cfg.commands ?? {}, by) || cfg.commands[by] == null))
    problems.push(`worktrees.generatedBy must name a configured command (commands.${typeof by === 'string' ? by : '<name>'} is not set)`);
  return problems;
}

function customTrackers(root: string): string[] {
  const dir = paths(root).trackers;
  if (!exists(dir)) return [];
  // A .d.ts is a declaration, not an adapter; a name with both .mjs and .ts is listed once.
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') || (f.endsWith('.ts') && !f.endsWith('.d.ts'))).map((f) => f.replace(/\.(mjs|ts)$/, ''));
  return [...new Set(names)];
}

/**
 * Repo-local checklists override the plugin catalog so teams can tune a lens without forking.
 */
export function reviewerChecklist(root: string, name: string, explicit?: string): string | null {
  const candidates: string[] = [];
  if (explicit) candidates.push(resolveFrom(root, explicit));
  candidates.push(path.join(paths(root).reviewers, `${name}.md`));
  candidates.push(path.join(PLUGIN_ROOT, 'reviewers', `${name}.md`));
  return candidates.find(exists) ?? null;
}
