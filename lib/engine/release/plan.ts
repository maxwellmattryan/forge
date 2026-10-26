// The release plan's shapes, and the planner that turns each repo's release strategy
// (lib/core/config/release-strategy.ts) and the repo graph into an ordered plan of checkable steps
// with rollback (docs/RELEASES.md "Releasing a project"). Planning only reads: local git, the
// manifests and config. It never runs a release command, a registry command or `git fetch`; a script
// repo's bump comes from `opts.bump` (the draft `forge release plan` runs, or release.json on a recompute).
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
import { fileBumps } from './script.ts';

/** The release.json and state.json format; a file of any other version is planned again, never read. */
export const RELEASE_FILE_VERSION = 1;

const CHECK_KINDS = ['ready', 'clean', 'tagged', 'tag-pushed', 'remote-tagged', 'at-remote', 'registry', 'pr-merged'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const VERSION_BUMPS = ['patch', 'minor', 'major'] as const;
export type VersionBump = (typeof VERSION_BUMPS)[number];

/** A script repo's version bump: what its `--draft-notes` drafted at plan time, and the notes file the owner edits. */
export interface ReleaseBump {
  from: string;
  /** X.Y.Z: the version the release makes, which every step's argv names. */
  to: string;
  bump: VersionBump;
  inferred: 'patch' | 'minor';
  reasons: string[];
  /** Always Forge's own notes path (script.ts `notesPath`), never a value read back from release.json. */
  notes: string;
}

/**
 * What a plan releases. A since plan the Office pass makes for an `until: released` mandate also names the
 * mandate and, by label, the commit each planned repo's HEAD was at (only then, so a plain `--since` plan
 * hashes as before): planHash covers both, so an approval for one mandate's plan never stands for another's,
 * for a plain `--since` plan of the same tag, or for code merged after it was planned.
 */
export type ReleaseSelection = { kind: 'job'; job: string } | { kind: 'since'; tag: string; mandate?: string; heads?: Record<string, string> } | { kind: 'all' };

/** A full commit id (sha1 or sha256), as `git rev-parse` prints it. */
export const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

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
  /** `mechanism: script` only; null otherwise, and when a file from before the mechanism lacks it. */
  bump: ReleaseBump | null;
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
  /** A mandate plan's heads a recompute keeps as planned, by label (keptHeads); every other planned repo's HEAD is read now. */
  heads?: Record<string, string>;
  /** A script repo's bump: drafted by `forge release plan`, read back from release.json by a recompute. */
  bump?: (input: RepoInput) => ReleaseBump;
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

/** Each planned repo's HEAD commit by label, or the one `kept` holds for it (keptHeads). */
function headsOf(order: RepoKey[], dirs: Map<RepoKey, string>, git: GitReader, kept: Record<string, string> = {}): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const repo of order) {
    const label = labelOf(repo);
    if (Object.hasOwn(kept, label)) {
      heads[label] = kept[label];
      continue;
    }
    const r = git(dirs.get(repo)!, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const sha = r.ok ? r.stdout.trim() : '';
    if (!COMMIT_SHA.test(sha)) throw new ForgeError(`${label}: git can't read HEAD, so its release can't be planned`);
    heads[label] = sha;
  }
  return heads;
}

/**
 * The heads a recompute of a mandate plan keeps as planned: each repo where a step that acts (anything but
 * a check-only preflight) has run under this plan's state.json, since the release's own steps move HEAD
 * (a version commit, a fast-forward). Every other repo's HEAD is read again, so a merge makes the plan stale.
 */
export function keptHeads(file: Pick<ReleasePlan, 'selection' | 'hash' | 'repos'>, state: ReleaseState | null): Record<string, string> | undefined {
  const heads = file.selection.kind === 'since' ? file.selection.heads : undefined;
  if (!heads || !state || state.planHash !== file.hash) return undefined;
  const acted = (r: ReleaseRepo) => Array.isArray(r?.steps) && r.steps.some((s) => s && (s.argv !== null || s.shell !== null || s.manual !== null) && Object.hasOwn(state.steps, s.id));
  return Object.fromEntries(file.repos.filter((r) => acted(r) && typeof r.label === 'string' && Object.hasOwn(heads, r.label)).map((r) => [r.label, heads[r.label]]));
}

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
    // The script publishes nothing to a registry, whatever `registry` says.
    const eco = strategy.mechanism === 'script' ? null : ecosystemOf(strategy.mechanism, registry);
    const dir = dirs.get(repo)!;
    const manifest = eco ? readManifestPackage(dir, eco) : null;
    const input: RepoInput = { repo, dir, base: repoBase(config, repo), remote, strategy, manifest, bump: null };
    if (strategy.mechanism === 'script') {
      if (!opts.bump) throw new ForgeError(`${labelOf(repo)}: a script release needs its version bump; re-run forge release plan`);
      input.bump = opts.bump(input);
    }
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
      bump: input.bump,
      steps,
      rollback: rollbackFor(input, steps, pkg),
    };
  });
  // A mandate plan pins each planned repo's HEAD, so a merge after it was planned (or approved) makes it stale.
  const pinned: ReleaseSelection =
    selection.kind === 'since' && selection.mandate !== undefined ? { kind: 'since', tag: selection.tag, mandate: selection.mandate, heads: headsOf(ord.order, dirs, git, opts.heads) } : selection;
  const plan: Omit<ReleasePlan, 'hash'> = { version: RELEASE_FILE_VERSION, createdAt: now(), selection: pinned, order: ord.order.map(labelOf), relaxed: ord.relaxed, repos, skipped };
  return { ...plan, hash: planHash(plan) };
}

/**
 * How to re-plan a stale plan. A mandate's is planned again by the Office pass or `--mandate` (a plain plan
 * would replace it, and the mandate would never close), with `--force` once a step of its run has started.
 */
function replanHint(file: Pick<ReleasePlan, 'selection' | 'hash'>, state: ReleaseState | null): string {
  const sel = file.selection;
  if (sel.kind !== 'since' || sel.mandate === undefined) return 'run forge release plan';
  const started = !!state && state.planHash === file.hash && !state.finishedAt && Object.keys(state.steps).length > 0;
  return started ? `run forge release plan --mandate ${sel.mandate} --force` : `the Office pass plans it again, or run forge release plan --mandate ${sel.mandate}`;
}

/** The plan as it is now, against release.json and state.json; a mismatch is refused as stale. */
export function freshPlan(root: string, config: Config, file: ReleasePlan, state: ReleaseState | null, opts: PlanOptions = {}): ReleasePlan {
  // A script repo's bump comes back from the file, checked, with Forge's own notes path; its draft never runs again.
  const now = planRelease(root, config, file.selection, { ...opts, heads: keptHeads(file, state), bump: opts.bump ?? fileBumps(root, file) });
  // planHash(file) catches a release.json edited without updating its hash.
  const old = [file.hash, planHash(file), state?.planHash].find((h) => h !== undefined && h !== now.hash);
  if (old !== undefined) throw new ForgeError(`the release plan no longer matches config and the repos (plan ${String(old).slice(0, 12)}, now ${now.hash.slice(0, 12)}); ${replanHint(file, state)}`);
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

/** The plan command's `--bump`, or null without it; a usage error for any other value. */
export function bumpFrom(flags: { bump?: unknown }): VersionBump | null {
  if (flags.bump === undefined) return null;
  if (typeof flags.bump !== 'string' || !(VERSION_BUMPS as readonly string[]).includes(flags.bump)) throw new ForgeError('--bump must be patch, minor or major', 'usage', 'forge help release plan');
  return flags.bump as VersionBump;
}
