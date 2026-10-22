// The merge order of a multi-repo job's PRs, from config `components[].dependsOn`: repo A depends on
// repo B when a component in A depends on one in B. Pure: it reads no files and never throws, since
// config is hand-edited and a bad entry must not stop a sync or a merge (validation reports it).

import { memberRepos } from './job-repos.ts';
import { projectGraph } from './project.ts';
import { isMap } from './core/shape.ts';
import type { Config, Job } from './core/types.ts';

/** A job repo: a member's name, or null for the root (as `JobRepo.repo`). */
export type RepoKey = string | null;

export interface RepoOrder {
  /** The job's PR repos, dependencies first; `job.repos` order on a cycle. */
  order: RepoKey[];
  /** Each PR repo's dependencies among the job's PR repos, transitive through repos outside the job. */
  deps: Map<RepoKey, RepoKey[]>;
  /** The build + runtime edges cycled, so the order uses build edges alone. */
  relaxed: boolean;
  /** The repos left in a build cycle, in `job.repos` order; null when there is none. */
  cycle: RepoKey[] | null;
}

export type PrStateKey = 'OPEN' | 'CLOSED' | 'MERGED' | null;


/** The job's PR repos: the root, then every member that is not verify-only, in `job.repos` order. */
export function prRepos(job: Pick<Job, 'repos'>): RepoKey[] {
  return [null, ...memberRepos(job).filter((m) => !m.verifyOnly).map((m) => m.repo)];
}

/** Whether a job has at least one member that gets a PR: its PRs are then linked and merged as one unit. */
export function isLinkedJob(job: Pick<Job, 'repos'>): boolean {
  return memberRepos(job).some((m) => !m.verifyOnly);
}

// Repo keys go in a Map, where null is a valid key, so no string can collide with the root.
function repoGraph(config: Pick<Config, 'components' | 'repos'>, types: readonly string[]): Map<RepoKey, Set<RepoKey>> {
  const known = new Set<string>((Array.isArray(config?.repos) ? config.repos : []).filter(isMap).map((r) => r.name).filter((n): n is string => typeof n === 'string'));
  const graph = projectGraph({ components: config?.components });
  const repoOf = new Map<string, RepoKey>();
  for (const c of graph.components) {
    if (c.repo === null) repoOf.set(c.name, null);
    else if (known.has(c.repo)) repoOf.set(c.name, c.repo);
  }
  const adj = new Map<RepoKey, Set<RepoKey>>();
  for (const e of graph.edges) {
    if (e.target !== 'component' || !types.includes(e.type) || !repoOf.has(e.from) || !repoOf.has(e.to)) continue;
    const from = repoOf.get(e.from)!;
    const to = repoOf.get(e.to)!;
    if (from === to) continue;
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
  }
  return adj;
}

function jobDeps(adj: Map<RepoKey, Set<RepoKey>>, repos: RepoKey[]): Map<RepoKey, RepoKey[]> {
  const inJob = new Set(repos);
  const deps = new Map<RepoKey, RepoKey[]>();
  for (const r of repos) {
    const seen = new Set<RepoKey>();
    const stack = [...(adj.get(r) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of adj.get(n) ?? []) stack.push(m);
    }
    deps.set(r, repos.filter((x) => x !== r && inJob.has(x) && seen.has(x)));
  }
  return deps;
}

/** Kahn's algorithm, taking the lowest `repos` index each time; `left` is what a cycle kept out. */
function topo(repos: RepoKey[], deps: Map<RepoKey, RepoKey[]>): { order: RepoKey[]; left: RepoKey[] } {
  const placed = new Set<RepoKey>();
  const order: RepoKey[] = [];
  for (;;) {
    const next = repos.find((r) => !placed.has(r) && (deps.get(r) ?? []).every((d) => placed.has(d)));
    if (next === undefined) break;
    placed.add(next);
    order.push(next);
  }
  return { order, left: repos.filter((r) => !placed.has(r)) };
}

/** The merge order of the job's PR repos; see RepoOrder. Never throws. */
export function jobRepoOrder(config: Pick<Config, 'components' | 'repos'>, job: Pick<Job, 'repos'>): RepoOrder {
  return repoOrder(config, prRepos(job));
}

/** `repos`, dependencies first (`repos` order breaks ties and stands on a cycle); see RepoOrder. Never throws. */
export function repoOrder(config: Pick<Config, 'components' | 'repos'>, repos: RepoKey[]): RepoOrder {
  const full = jobDeps(repoGraph(config, ['build', 'runtime']), repos);
  const first = topo(repos, full);
  if (!first.left.length) return { order: first.order, deps: full, relaxed: false, cycle: null };
  const build = jobDeps(repoGraph(config, ['build']), repos);
  const second = topo(repos, build);
  if (!second.left.length) return { order: second.order, deps: build, relaxed: true, cycle: null };
  return { order: repos, deps: build, relaxed: true, cycle: second.left };
}

const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * `Part of job <id>: o/lib#7 then o/app#11`, refs in merge order; on a cycle, comma-separated with
 * the reason. Null with fewer than two usable refs. Only checked slugs and safe numbers go in, so the
 * line carries no markdown or mention.
 */
export function siblingLine(id: string, refs: { slug: string; number: number }[], cycle: boolean): string | null {
  const ok = refs.filter((r) => typeof r.slug === 'string' && SLUG.test(r.slug) && Number.isSafeInteger(r.number) && r.number > 0).map((r) => `${r.slug}#${r.number}`);
  if (ok.length < 2) return null;
  return cycle ? `Part of job ${id}: ${ok.join(', ')} (no merge order: the components' dependsOn form a cycle)` : `Part of job ${id}: ${ok.join(' then ')}`;
}

/** The first PR in `order` that is not MERGED and whose dependencies all are; undefined when none is (null is the root). */
export function nextMergeable(order: RepoKey[], deps: Map<RepoKey, RepoKey[]>, states: Map<RepoKey, PrStateKey>): RepoKey | null | undefined {
  for (const r of order) {
    if (states.get(r) === 'MERGED') continue;
    if ((deps.get(r) ?? []).every((d) => states.get(d) === 'MERGED')) return r;
  }
  return undefined;
}
