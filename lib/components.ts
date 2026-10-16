// Components: the parts of a repo (`config.components`), what kind each is and what it depends on.
// The lists live here rather than in schema.ts because schema.ts runs servicesToComponents as a
// migration while it loads; schema.ts re-exports them beside its other runtime lists.

import path from 'node:path';
import type { ComponentConfig, Config, Job } from './types.ts';
import { SAFE_REF } from './util.ts';

export const COMPONENT_KINDS = ['library', 'service', 'app'] as const;
export const DEPENDENCY_TYPES = ['build', 'runtime'] as const;

const isMap = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The v8 `services` list folded into `components`: each service becomes a `service` component with
 * no dependencies and its other keys kept. A config that already has `components`, or has no
 * `services` list, is returned as is, so validation can report a leftover `services` key.
 */
export function servicesToComponents(c: any): any {
  if (!isMap(c) || !Array.isArray(c.services) || c.components !== undefined) return c;
  const { services, ...rest } = c;
  const components = services.map((s: unknown) => {
    // Kept as is so validation names the bad entry instead of the migration dropping it.
    if (!isMap(s)) return s;
    const p = typeof s.path === 'string' && s.path.trim() ? s.path : '.';
    return { ...s, path: p, kind: 'service', dependsOn: [] };
  });
  return { ...rest, components };
}

/**
 * The component whose commands a job uses: the one root-repo component its `services` names when it
 * names exactly one. A component in another repo has no checkout in the job's worktree, so it is
 * never selected and the top-level commands run instead.
 */
export function jobComponent(config: Pick<Config, 'components'>, job: Pick<Job, 'services'>): ComponentConfig | null {
  if (job.services.length !== 1) return null;
  const c = (config.components ?? []).find((s) => s?.name === job.services[0]);
  return c && (c.repo === undefined || c.repo === null) ? c : null;
}

const show = (v: unknown): string => (v === undefined ? 'nothing' : JSON.stringify(v));
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * A component's path becomes the cwd of its shell commands (path.join(worktree, path)), so it must
 * stay inside the checkout: no absolute path, drive letter or `..` segment on either separator.
 */
export function isInsidePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (path.isAbsolute(p) || /^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[/\\]/).includes('..');
}

/** Every problem with `components` (and a leftover `services`), in the form validateConfig reports. */
export function componentProblems(c: any): string[] {
  const problems: string[] = [];
  if (c?.services !== undefined && c?.components !== undefined)
    problems.push('services was renamed to components in config schemaVersion 9; move its entries under components and delete services');
  const list = c?.components;
  if (list === undefined) return problems;
  if (!Array.isArray(list)) return [...problems, `components must be a list (got ${show(list)})`];
  const counts = new Map<string, number>();
  for (const e of list) if (isMap(e) && typeof e.name === 'string' && SAFE_REF.test(e.name)) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const reported = new Set<string>();
  list.forEach((e: unknown, i: number) => {
    if (!isMap(e)) return problems.push(`components[${i}] must be a map`);
    const named = typeof e.name === 'string' && SAFE_REF.test(e.name);
    if (!named) problems.push(`components[${i}].name must start with a letter or digit and use only A-Z a-z 0-9 . _ / - (got ${show(e.name)})`);
    const at = named ? `components "${e.name}"` : `components[${i}]`;
    if (named && counts.get(e.name)! > 1 && !reported.has(e.name)) {
      reported.add(e.name);
      problems.push(`components "${e.name}" is listed more than once`);
    }
    if (!isInsidePath(e.path)) problems.push(`${at}.path must be a relative path inside the repo (got ${show(e.path)})`);
    if (!(COMPONENT_KINDS as readonly unknown[]).includes(e.kind)) problems.push(`${at}.kind must be one of ${COMPONENT_KINDS.join(' | ')} (got ${show(e.kind)})`);
    if (e.repo !== undefined && e.repo !== null && typeof e.repo !== 'string') problems.push(`${at}.repo must be a string or null (got ${show(e.repo)})`);
    if (e.owners !== undefined && (!Array.isArray(e.owners) || e.owners.some((o: unknown) => typeof o !== 'string'))) problems.push(`${at}.owners must be a list of strings (got ${show(e.owners)})`);
    if (e.commands !== undefined) {
      if (!isMap(e.commands)) problems.push(`${at}.commands must be a map of command names to strings (got ${show(e.commands)})`);
      else for (const [k, v] of Object.entries(e.commands)) if (v !== null && typeof v !== 'string') problems.push(`${at}.commands.${k} must be a string or null (got ${show(v)})`);
    }
    if (e.notes !== undefined && e.notes !== null && typeof e.notes !== 'string') problems.push(`${at}.notes must be a string or null (got ${show(e.notes)})`);
    if (e.dependsOn === undefined) return;
    if (!Array.isArray(e.dependsOn)) return problems.push(`${at}.dependsOn must be a list (got ${show(e.dependsOn)})`);
    e.dependsOn.forEach((d: unknown, j: number) => {
      const dep = isMap(d) ? d : {};
      const keys = (['component', 'backing'] as const).filter((k) => dep[k] !== undefined);
      if (keys.length !== 1) problems.push(`${at}.dependsOn[${j}] must name exactly one of component or backing`);
      else if (!isNonEmptyString(dep[keys[0]])) problems.push(`${at}.dependsOn[${j}].${keys[0]} must be a non-empty string (got ${show(dep[keys[0]])})`);
      // A self edge is a cycle when it is a build edge (buildCycles reports it), and unknown otherwise.
      else if (keys[0] === 'component' && (dep.component === e.name ? dep.type !== 'build' : !counts.has(dep.component)))
        problems.push(`${at}.dependsOn[${j}] names unknown component ${show(dep.component)}`);
      if (isMap(d) && !(DEPENDENCY_TYPES as readonly unknown[]).includes(dep.type)) problems.push(`${at}.dependsOn[${j}].type must be one of ${DEPENDENCY_TYPES.join(' | ')} (got ${show(dep.type)})`);
    });
  });
  for (const cycle of buildCycles(list)) problems.push(`components: build dependency cycle ${[...cycle, cycle[0]].join(' -> ')}`);
  return problems;
}

/**
 * The cycles among `build` edges between known components, each starting at its alphabetically
 * first member. A depth-first walk in sorted order keeps the report the same from run to run.
 */
export function buildCycles(components: unknown): string[][] {
  if (!Array.isArray(components)) return [];
  const edges = new Map<string, Set<string>>();
  for (const e of components) if (isMap(e) && typeof e.name === 'string' && SAFE_REF.test(e.name) && !edges.has(e.name)) edges.set(e.name, new Set());
  for (const e of components) {
    if (!isMap(e) || !edges.has(e.name) || !Array.isArray(e.dependsOn)) continue;
    for (const d of e.dependsOn) if (isMap(d) && d.type === 'build' && d.backing === undefined && edges.has(d.component)) edges.get(e.name)!.add(d.component);
  }
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const found = new Map<string, string[]>();
  const visit = (n: string) => {
    state.set(n, 'open');
    stack.push(n);
    for (const m of [...edges.get(n)!].sort()) {
      if (state.get(m) === 'open') {
        const cycle = stack.slice(stack.indexOf(m));
        const first = cycle.indexOf([...cycle].sort()[0]);
        const rotated = [...cycle.slice(first), ...cycle.slice(0, first)];
        found.set(rotated.join('\0'), rotated);
      } else if (!state.has(m)) visit(m);
    }
    stack.pop();
    state.set(n, 'done');
  };
  for (const n of [...edges.keys()].sort()) if (!state.has(n)) visit(n);
  return [...found.values()];
}
