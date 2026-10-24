// The release plan's shapes, and the planner that turns each repo's release strategy
// (lib/core/config/release-strategy.ts) and the repo graph into an ordered plan of checkable steps
// with rollback (docs/RELEASES.md "Releasing a project"). Planning only reads: local git, the
// manifests and config. It never runs a release command, a registry command or `git fetch`.
// lib/engine/release/run.ts executes the plan, and recomputes it here first rather than trusting
// release.json, which an agent session could have edited.

import crypto from 'node:crypto';
import { validateConfig } from '#core/config/load.ts';
import { git as runGit } from '#integrations/git/runner.ts';
import { resolveInterim } from './interim.ts';
import { loadJob } from '#core/job/store.ts';
import { memberCheck, readLocalConfig, resolveMemberPath } from '../project/member-repos.ts';
import { memberRepos } from '../project/job-repos.ts';
import { prRepos, repoOrder, type RepoKey } from '../project/repo-order.ts';
import type { Config, ReleaseCadence, ReleaseMechanism, ReleaseRegistry, ReleaseStrategy } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { assertSafeRef } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { ecosystemOf, readManifestPackage } from './manifest.ts';
import { type RepoInput, labelOf, rollbackFor, stepsFor } from './steps.ts';

/** The release.json and state.json format; a file of any other version is planned again, never read. */
export const RELEASE_FILE_VERSION = 1;

const CHECK_KINDS = ['ready', 'clean', 'tagged', 'tag-pushed', 'remote-tagged', 'at-remote', 'registry'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export type ReleaseSelection = { kind: 'job'; job: string } | { kind: 'since'; tag: string } | { kind: 'all' };

export interface ReleaseStep {
  /** `<label>/<kind>`. */
  id: string;
  repo: RepoKey;
  kind: string;
  title: string;
  /** Program and arguments, run without a shell; the program word is resolved on PATH at run time. */
  argv: string[] | null;
  /** The tag mechanism's `release.command`, run under commandShell (the login shell: release runs never run under the daemon). */
  shell: string | null;
  /** What a human does by hand (release-please's merge). */
  manual: string | null;
  /** Outward-facing: pushes, publishes or tags. */
  publish: boolean;
  check: CheckKind | null;
  /** Why a registry step has no check, when it would have one. */
  note?: string;
}

export interface ReleasePackage {
  ecosystem: 'npm' | 'cargo';
  name: string;
}

export interface ReleaseRepo {
  repo: RepoKey;
  label: string;
  dir: string;
  mechanism: ReleaseMechanism;
  registry: ReleaseRegistry | null;
  cadence: ReleaseCadence | null;
  version: string | null;
  package: ReleasePackage | null;
  steps: ReleaseStep[];
  rollback: string[];
}

export interface ReleaseSkip {
  repo: RepoKey;
  label: string;
  reason: string;
}

export interface ReleasePlan {
  version: typeof RELEASE_FILE_VERSION;
  hash: string;
  createdAt: string;
  selection: ReleaseSelection;
  order: string[];
  relaxed: boolean;
  repos: ReleaseRepo[];
  skipped: ReleaseSkip[];
}

export type StepStatus = 'started' | 'done' | 'failed';

export interface StepState {
  status: StepStatus;
  at: string;
  skipped?: true;
  exit?: number | null;
  reason?: 'exit' | 'check';
  detail?: string;
  log?: string;
  tags?: string[];
  version?: string;
}

export interface ReleaseState {
  version: typeof RELEASE_FILE_VERSION;
  planHash: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  steps: Record<string, StepState>;
}

/** git in a clone: its output, or not ok. Injected by tests. */
export type GitReader = (dir: string, args: string[]) => { ok: boolean; stdout: string };
/** A member's clone dir, or why it can't be used. Injected by tests. */
export type CloneResolver = (name: string) => { dir: string } | { detail: string };

export interface PlanOptions {
  git?: GitReader;
  clone?: CloneResolver;
}

/** git in a clone through the shared wrapper (pins, no inherited GIT_DIR-style variables), as memberCheck runs it. */
export const cloneGit: GitReader = (dir, args) => {
  const r = runGit(dir, args, { allowFail: true });
  return { ok: r.ok, stdout: r.stdout };
};

function defaultClone(root: string, config: Config): CloneResolver {
  const local = readLocalConfig(root);
  return (name) => {
    const entry = config.repos.find((r) => r.name === name);
    if (!entry) return { detail: `repo ${name} is not a repos entry in .forge/config.yml` };
    const check = memberCheck(root, config, entry, local);
    if (!check.ok) return { detail: check.detail };
    return { dir: resolveMemberPath(root, local.repos[name].path) };
  };
}

/** The branch a repo releases from: `git.base` for the root, `defaultBranch` for a member. */
export function repoBase(config: Config, repo: RepoKey): string {
  if (repo === null) return assertSafeRef(config.git.base, 'git.base');
  const entry = config.repos.find((r) => r.name === repo);
  if (!entry) throw new ForgeError(`repo ${repo} is not a repos entry in .forge/config.yml`);
  return assertSafeRef(entry.defaultBranch, `repos ${repo} defaultBranch`);
}

export const repoRemote = (config: Config): string => assertSafeRef(config.git.remote || 'origin', 'git.remote');

/** A repo's release strategy: the top-level `release` for the root, `repos[].release` for a member. */
export function strategyOf(config: Config, repo: RepoKey): ReleaseStrategy | null {
  if (repo === null) return config.release ?? null;
  return config.repos.find((r) => r.name === repo)?.release ?? null;
}

/** sha256 of canonical JSON (keys sorted) of what decides what runs; see the spec's "File shapes". */
export function planHash(plan: Pick<ReleasePlan, 'selection' | 'order' | 'repos' | 'skipped'>): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  const body = {
    selection: plan.selection,
    order: plan.order,
    repos: plan.repos.map((r) => ({ repo: r.repo, mechanism: r.mechanism, registry: r.registry, dir: r.dir, package: r.package, steps: r.steps })),
    skipped: plan.skipped,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon(body))).digest('hex');
}

const SINCE = (tag: string) => `forge release plan --since ${tag}`;

/**
 * The release plan for `selection`, from config, the job (for `job`) and the clones. Throws a
 * ForgeError for every refusal in the spec; never writes.
 */
export function planRelease(root: string, config: Config, selection: ReleaseSelection, opts: PlanOptions = {}): ReleasePlan {
  const problems = validateConfig(config, root);
  if (problems.length)
    throw new ForgeError(`.forge/config.yml has ${problems.length} problem${problems.length === 1 ? '' : 's'}, so no release can be planned: ${problems.slice(0, 5).join('; ')}`, 'failed', 'forge config validate');
  const git = opts.git ?? cloneGit;
  const clone = opts.clone ?? defaultClone(root, config);
  const remote = repoRemote(config);
  const skipped: ReleaseSkip[] = [];
  const skip = (repo: RepoKey, reason: string) => skipped.push({ repo, label: labelOf(repo), reason });
  const members = config.repos.map((r) => r.name);
  let candidates: RepoKey[];
  if (selection.kind === 'job') {
    const job = loadJob(root, selection.job);
    candidates = prRepos(job);
    const prOf = (repo: RepoKey) => (repo === null ? job.pr : memberRepos(job).find((m) => m.repo === repo)?.pr);
    const unmerged = candidates.filter((r) => prOf(r)?.state !== 'MERGED');
    // A consumer of an interim edge merges after its dependencies' release (its release gate), so it
    // is left out of this plan rather than refused; any other unmerged PR still is.
    const consumers = new Set(resolveInterim(config, job).edges.map((e) => e.consumer));
    const refused = unmerged.filter((r) => !consumers.has(r));
    if (refused.length) throw new ForgeError(`forge release plan --job ${selection.job}: ${refused.map(labelOf).join(', ')} have no merged PR; run forge pr sync ${selection.job} first`);
    for (const r of unmerged) skip(r, "PR not merged: it waits on its dependencies' release");
    candidates = candidates.filter((r) => !unmerged.includes(r));
    if (!candidates.length) throw new ForgeError(`forge release plan --job ${selection.job}: no PR of the job is merged yet`);
  } else candidates = [null, ...members];

  const dirs = new Map<RepoKey, string>();
  for (const repo of candidates) {
    if (repo === null) {
      dirs.set(null, root);
      continue;
    }
    if (!config.repos.some((r) => r.name === repo)) throw new ForgeError(`repo ${repo} is not a repos entry in .forge/config.yml`);
    const c = clone(repo);
    if ('detail' in c) {
      if (selection.kind === 'job') throw new ForgeError(`repo ${repo}: ${c.detail}`);
      skip(repo, `clone: ${c.detail}`);
      continue;
    }
    dirs.set(repo, c.dir);
  }

  let selected = candidates.filter((r) => dirs.has(r));
  if (selection.kind === 'since') {
    const tag = selection.tag;
    let resolved = 0;
    selected = selected.filter((repo) => {
      const dir = dirs.get(repo)!;
      if (!git(dir, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]).ok) {
        skip(repo, `no tag ${tag}`);
        return false;
      }
      resolved++;
      const count = git(dir, ['rev-list', '--count', `${tag}..HEAD`]);
      if (!count.ok || !(Number(count.stdout.trim()) > 0)) {
        skip(repo, `no commits since ${tag}`);
        return false;
      }
      return true;
    });
    if (!resolved) throw new ForgeError(`${SINCE(tag)}: no repo has the tag ${tag}`);
  }
  selected = selected.filter((repo) => {
    if (strategyOf(config, repo)?.mechanism) return true;
    skip(repo, 'no release.mechanism');
    return false;
  });

  const ord = repoOrder(config, selected);
  if (ord.cycle) throw new ForgeError(`the components' dependsOn form a cycle between ${ord.cycle.map(labelOf).join(', ')}; a release needs an order`);

  const repos: ReleaseRepo[] = ord.order.map((repo) => {
    const strategy = strategyOf(config, repo) as ReleaseStrategy & { mechanism: ReleaseMechanism };
    const registry = strategy.registry ?? null;
    const eco = ecosystemOf(strategy.mechanism, registry);
    const dir = dirs.get(repo)!;
    const manifest = eco ? readManifestPackage(dir, eco) : null;
    const input: RepoInput = { repo, dir, base: repoBase(config, repo), remote, strategy, manifest };
    const steps = stepsFor(input);
    const pkg = eco && manifest && 'name' in manifest ? { ecosystem: eco, name: manifest.name } : null;
    return {
      repo,
      label: labelOf(repo),
      dir,
      mechanism: strategy.mechanism,
      registry,
      cadence: strategy.cadence ?? null,
      version: manifest && 'version' in manifest ? manifest.version : null,
      package: pkg,
      steps,
      rollback: rollbackFor(input, steps, pkg),
    };
  });
  const plan: Omit<ReleasePlan, 'hash'> = { version: RELEASE_FILE_VERSION, createdAt: now(), selection, order: ord.order.map(labelOf), relaxed: ord.relaxed, repos, skipped };
  return { ...plan, hash: planHash(plan) };
}

/** The plan as it is now, against release.json and state.json; a mismatch is refused as stale. */
export function freshPlan(root: string, config: Config, file: ReleasePlan, state: ReleaseState | null, opts: PlanOptions = {}): ReleasePlan {
  const now = planRelease(root, config, file.selection, opts);
  // planHash(file) catches a release.json edited without updating its hash.
  const old = [file.hash, planHash(file), state?.planHash].find((h) => h !== undefined && h !== now.hash);
  if (old !== undefined) throw new ForgeError(`the release plan no longer matches config and the repos (plan ${String(old).slice(0, 12)}, now ${now.hash.slice(0, 12)}); run forge release plan`);
  return now;
}

/** The `selection` for the plan command's flags; usage errors for the combinations it refuses. */
export function selectionFrom(flags: { job?: unknown; since?: unknown }): ReleaseSelection {
  if (flags.job !== undefined && flags.since !== undefined) throw new ForgeError('forge release plan takes --job or --since, not both', 'usage', 'forge help release plan');
  if (flags.job !== undefined) {
    if (typeof flags.job !== 'string' || !flags.job) throw new ForgeError('missing value for --job', 'usage', 'forge help release plan');
    return { kind: 'job', job: flags.job };
  }
  if (flags.since !== undefined) {
    if (typeof flags.since !== 'string' || !flags.since) throw new ForgeError('missing value for --since', 'usage', 'forge help release plan');
    try {
      return { kind: 'since', tag: assertSafeRef(flags.since, '--since') };
    } catch (e) {
      throw new ForgeError((e as Error).message.replace('safe branch name', 'safe tag name'), 'usage', 'forge help release plan');
    }
  }
  return { kind: 'all' };
}
