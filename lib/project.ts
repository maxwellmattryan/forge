// The project graph GET /api/project serves: `components` reduced to names, repos, kinds, paths and
// dependsOn edges. Config is hand-edited, so every entry is checked here and a bad one is dropped
// (validation reports it, and `problems` counts what it reports) rather than thrown on.

import type { Config, DependencyType, ProjectComponent, ProjectEdge, ProjectResponse } from './types.ts';
import { COMPONENT_KINDS, DEPENDENCY_TYPES, componentProblems } from './components.ts';
import { REPO_NAME } from './member-repos.ts';
import { isMap } from './shape.ts';
import { SAFE_REF } from './util.ts';

const trimmed = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The graph of `config.components`; pure, so it never reads files and never throws. */
export function projectGraph(config: Pick<Config, 'components'> & Partial<Pick<Config, 'backing'>>): ProjectResponse {
  const list: unknown[] = Array.isArray(config?.components) ? config.components : [];
  const seen = new Set<string>();
  const kept: { c: ProjectComponent; dependsOn: unknown }[] = [];
  for (const e of list) {
    if (!isMap(e) || typeof e.name !== 'string' || !SAFE_REF.test(e.name) || seen.has(e.name)) continue;
    // The first entry with a name decides it, even when that entry is dropped for its kind.
    seen.add(e.name);
    if (!(COMPONENT_KINDS as readonly unknown[]).includes(e.kind)) continue;
    const c: ProjectComponent = { name: e.name, repo: trimmed(e.repo), kind: e.kind as ProjectComponent['kind'], path: typeof e.path === 'string' ? e.path : '.' };
    kept.push({ c, dependsOn: e.dependsOn });
  }
  const names = new Set(kept.map((k) => k.c.name));
  const edges = new Map<string, ProjectEdge>();
  const backing = new Set<string>();
  for (const { c, dependsOn } of kept) {
    if (!Array.isArray(dependsOn)) continue;
    for (const d of dependsOn) {
      if (!isMap(d) || !(DEPENDENCY_TYPES as readonly unknown[]).includes(d.type)) continue;
      if ((d.component === undefined) === (d.backing === undefined)) continue;
      const target = d.component !== undefined ? 'component' : 'backing';
      const to = trimmed(target === 'component' ? d.component : d.backing);
      if (!to || (target === 'component' && (!names.has(to) || to === c.name))) continue;
      const edge: ProjectEdge = { from: c.name, to, target, type: d.type as ProjectEdge['type'] };
      edges.set(`${edge.from}|${edge.target}|${edge.to}|${edge.type}`, edge);
      if (target === 'backing') backing.add(to);
    }
  }
  // Declared entries show even when no edge points at them.
  for (const b of Array.isArray(config?.backing) ? (config.backing as unknown[]) : []) {
    const name = isMap(b) ? trimmed(b.name) : null;
    if (name) backing.add(name);
  }
  return {
    components: kept.map((k) => k.c).sort((a, b) => cmp(a.name, b.name)),
    backing: [...backing].sort(cmp),
    edges: [...edges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.type, b.type) || cmp(a.target, b.target)),
    problems: componentProblems(config).length,
  };
}

/** One member repo as the planner and spec-writer see it: its components and who depends on them. */
export interface RepoGraphRow {
  repo: string;
  components: string[];
  usedBy: { component: string; repo: string | null; type: DependencyType }[];
}

/**
 * A row per config `repos` entry with a valid name: the projectGraph components in that repo, and
 * the component edges into them from components in another repo (null: the root). Pure, config only.
 */
export function repoGraph(config: Pick<Config, 'components' | 'repos'>): RepoGraphRow[] {
  const repos: unknown[] = Array.isArray(config?.repos) ? config.repos : [];
  const graph = projectGraph(config);
  const repoOf = new Map(graph.components.map((c) => [c.name, c.repo]));
  const seen = new Set<string>();
  const rows: RepoGraphRow[] = [];
  for (const r of repos) {
    const name = isMap(r) ? r.name : undefined;
    if (typeof name !== 'string' || !REPO_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    const components = graph.components.filter((c) => c.repo === name).map((c) => c.name);
    const usedBy = graph.edges
      .filter((e) => e.target === 'component' && components.includes(e.to) && repoOf.get(e.from) !== name)
      .map((e) => ({ component: e.from, repo: repoOf.get(e.from) ?? null, type: e.type }));
    rows.push({ repo: name, components, usedBy });
  }
  return rows;
}
