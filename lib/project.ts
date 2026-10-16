// The project graph GET /api/project serves: `components` reduced to names, repos, kinds, paths and
// dependsOn edges. Config is hand-edited, so every entry is checked here and a bad one is dropped
// (validation reports it, and `problems` counts what it reports) rather than thrown on.

import type { Config, ProjectComponent, ProjectEdge, ProjectResponse } from './types.ts';
import { COMPONENT_KINDS, DEPENDENCY_TYPES, componentProblems } from './components.ts';
import { SAFE_REF } from './util.ts';

const isMap = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const trimmed = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The graph of `config.components`; pure, so it never reads files and never throws. */
export function projectGraph(config: Pick<Config, 'components'>): ProjectResponse {
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
  return {
    components: kept.map((k) => k.c).sort((a, b) => cmp(a.name, b.name)),
    backing: [...backing].sort(cmp),
    edges: [...edges.values()].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.type, b.type) || cmp(a.target, b.target)),
    problems: componentProblems(config).length,
  };
}
