// Components: the parts of a repo (`config.components`), what kind each is and what it depends on.
// The lists the /api shapes derive from (COMPONENT_KINDS, DEPENDENCY_TYPES, INTERIM_STRATEGIES)
// live in constants.ts and are re-exported here. LINK_ECOSYSTEMS stays here rather than in
// schema.ts because schema.ts runs servicesToComponents as a migration while it loads; schema.ts
// re-exports these beside its other runtime lists.

import path from 'node:path';
import type { ComponentConfig, Config, Job } from './types.ts';
import { isMap, show } from './shape.ts';
import { SAFE_REF, isInsidePath } from './util.ts';
import { sinkProblems } from './config-sinks.ts';
import { declaredSecrets } from './secret-refs-config.ts';
import { COMPONENT_KINDS, DEPENDENCY_TYPES, INTERIM_STRATEGIES } from './constants.ts';

export { isInsidePath };
export { COMPONENT_KINDS, DEPENDENCY_TYPES, INTERIM_STRATEGIES } from './constants.ts';

export const LINK_ECOSYSTEMS = ['cargo', 'cmake', 'npm'] as const;

export const isInterimStrategy = (v: unknown): v is (typeof INTERIM_STRATEGIES)[number] => (INTERIM_STRATEGIES as readonly unknown[]).includes(v);

// Names and sources reach TOML and sh (lib/links.ts quotes them too), so each is held to what its
// ecosystem accepts: a crate name, a FetchContent name (it becomes a CMake variable), an npm name.
const LINK_NAMES: Record<(typeof LINK_ECOSYSTEMS)[number], { re: RegExp; max: number; what: string }> = {
  cargo: { re: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, max: 64, what: 'a crate name (A-Z a-z 0-9 _ -, at most 64 characters)' },
  cmake: { re: /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,99}$/, max: 100, what: 'a FetchContent name (A-Z a-z 0-9 _ . + -, at most 100 characters)' },
  npm: { re: /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, max: 214, what: 'an npm package name (lower case, optionally @scope/, at most 214 characters)' },
};
const REGISTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SOURCE_MAX = 2000;
const SOURCE_URL = /^(?:https|ssh|git):\/\/[^\s"'\\\u0000-\u001f\u007f-\u009f]+$/;

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

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Whether `name` is a valid link name for `ecosystem`. */
export function isLinkName(ecosystem: unknown, name: unknown): name is string {
  const rule = LINK_NAMES[ecosystem as (typeof LINK_ECOSYSTEMS)[number]];
  return Boolean(rule) && typeof name === 'string' && name.length <= rule.max && rule.re.test(name);
}

/** A cargo `[patch.<source>]` key: `crates-io`, a registry name, or a git url. */
export function isLinkSource(s: unknown): s is string {
  return typeof s === 'string' && s.length <= SOURCE_MAX && (REGISTRY_NAME.test(s) || SOURCE_URL.test(s));
}

/** The problems with one `dependsOn` edge's `link`, labelled `at` (`components "x".dependsOn[0].link`). */
function linkProblems(link: unknown, at: string): string[] {
  if (!isMap(link) || !(LINK_ECOSYSTEMS as readonly unknown[]).includes(link.ecosystem))
    return [`${at} must be a map with ecosystem ${LINK_ECOSYSTEMS.join(' | ')} (got ${show(link, Infinity)})`];
  const problems: string[] = [];
  const eco = link.ecosystem as (typeof LINK_ECOSYSTEMS)[number];
  if (!isLinkName(eco, link.name)) problems.push(`${at}.name must be ${LINK_NAMES[eco].what} (got ${show(link.name, Infinity)})`);
  if (link.source !== undefined && link.source !== null) {
    if (eco !== 'cargo') problems.push(`${at}.source is only for a cargo link (got ${show(link.source, Infinity)})`);
    else if (!isLinkSource(link.source))
      problems.push(`${at}.source must be crates-io, a registry name or an https://, ssh:// or git:// url of at most ${SOURCE_MAX} characters without whitespace, quotes, backslashes or control characters (got ${show(link.source, Infinity)})`);
  }
  if (link.path !== undefined && link.path !== null && !isInsidePath(link.path)) problems.push(`${at}.path must be a relative path inside the dependency's repo (got ${show(link.path, Infinity)})`);
  if (link.manifest !== undefined && link.manifest !== null && !isManifestPath(eco, link.manifest))
    problems.push(`${at}.manifest must be a relative path inside the consumer's repo to ${MANIFEST_NAMES[eco]} (got ${show(link.manifest, Infinity)})`);
  return problems;
}

const MANIFEST_NAMES: Record<(typeof LINK_ECOSYSTEMS)[number], string> = { cargo: 'a Cargo.toml', cmake: 'a CMakeLists.txt or a .cmake file', npm: 'a package.json' };

/** A link's `manifest`: inside the consumer's repo, and the file its ecosystem's pin goes in. */
export function isManifestPath(ecosystem: unknown, p: unknown): p is string {
  if (!isInsidePath(p)) return false;
  const base = p.split(/[/\\]/).pop() ?? '';
  if (ecosystem === 'cargo') return base === 'Cargo.toml';
  if (ecosystem === 'cmake') return base === 'CMakeLists.txt' || (base.endsWith('.cmake') && base.length > '.cmake'.length);
  if (ecosystem === 'npm') return base === 'package.json';
  return false;
}

const repoLabel = (r: unknown): string => (typeof r === 'string' ? `repo ${r}` : 'the root repo');

/** Every problem with `components` (and a leftover `services`), in the form validateConfig reports. */
export function componentProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const problems: string[] = [];
  if (cfg.services !== undefined && cfg.components !== undefined)
    problems.push('services was renamed to components in config schemaVersion 10; move its entries under components and delete services');
  const list = cfg.components;
  if (list === undefined) return problems;
  if (!Array.isArray(list)) return [...problems, `components must be a list (got ${show(list, Infinity)})`];
  const counts = new Map<string, number>();
  for (const e of list) if (isMap(e) && typeof e.name === 'string' && SAFE_REF.test(e.name)) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const reported = new Set<string>();
  // One consumer repo, ecosystem, name (and cargo source) to the first link's dependency dir.
  const linkTargets = new Map<string, { dir: string; at: string }>();
  list.forEach((e: unknown, i: number) => {
    if (!isMap(e)) return problems.push(`components[${i}] must be a map`);
    const named = typeof e.name === 'string' && SAFE_REF.test(e.name);
    if (!named) problems.push(`components[${i}].name must start with a letter or digit and use only A-Z a-z 0-9 . _ / - (got ${show(e.name, Infinity)})`);
    const at = named ? `components "${e.name}"` : `components[${i}]`;
    if (named && counts.get(e.name)! > 1 && !reported.has(e.name)) {
      reported.add(e.name);
      problems.push(`components "${e.name}" is listed more than once`);
    }
    if (!isInsidePath(e.path)) problems.push(`${at}.path must be a relative path inside the repo (got ${show(e.path, Infinity)})`);
    if (!(COMPONENT_KINDS as readonly unknown[]).includes(e.kind)) problems.push(`${at}.kind must be one of ${COMPONENT_KINDS.join(' | ')} (got ${show(e.kind, Infinity)})`);
    if (e.repo !== undefined && e.repo !== null && typeof e.repo !== 'string') problems.push(`${at}.repo must be a string or null (got ${show(e.repo, Infinity)})`);
    if (e.owners !== undefined && (!Array.isArray(e.owners) || e.owners.some((o: unknown) => typeof o !== 'string'))) problems.push(`${at}.owners must be a list of strings (got ${show(e.owners, Infinity)})`);
    if (e.commands !== undefined) {
      if (!isMap(e.commands)) problems.push(`${at}.commands must be a map of command names to strings (got ${show(e.commands, Infinity)})`);
      else for (const [k, v] of Object.entries(e.commands)) if (v !== null && typeof v !== 'string') problems.push(`${at}.commands.${k} must be a string or null (got ${show(v, Infinity)})`);
    }
    if (e.notes !== undefined && e.notes !== null && typeof e.notes !== 'string') problems.push(`${at}.notes must be a string or null (got ${show(e.notes, Infinity)})`);
    if (e.config !== undefined) problems.push(...sinkProblems(e.config, `${at}.config`, e, declaredSecrets(cfg)));
    if (e.dependsOn === undefined) return;
    if (!Array.isArray(e.dependsOn)) return problems.push(`${at}.dependsOn must be a list (got ${show(e.dependsOn, Infinity)})`);
    e.dependsOn.forEach((d: unknown, j: number) => {
      const dep = isMap(d) ? d : {};
      const keys = (['component', 'backing'] as const).filter((k) => dep[k] !== undefined);
      if (keys.length !== 1) problems.push(`${at}.dependsOn[${j}] must name exactly one of component or backing`);
      else if (!isNonEmptyString(dep[keys[0]])) problems.push(`${at}.dependsOn[${j}].${keys[0]} must be a non-empty string (got ${show(dep[keys[0]], Infinity)})`);
      // A self edge is a cycle when it is a build edge (buildCycles reports it), and unknown otherwise.
      else if (keys[0] === 'component' && (dep.component === e.name ? dep.type !== 'build' : !counts.has(dep.component)))
        problems.push(`${at}.dependsOn[${j}] names unknown component ${show(dep.component, Infinity)}`);
      if (isMap(d) && !(DEPENDENCY_TYPES as readonly unknown[]).includes(dep.type)) problems.push(`${at}.dependsOn[${j}].type must be one of ${DEPENDENCY_TYPES.join(' | ')} (got ${show(dep.type, Infinity)})`);
      if (dep.link === undefined) return;
      const lat = `${at}.dependsOn[${j}].link`;
      if (dep.backing !== undefined) return problems.push(`${lat} is only for a component edge, not a backing one`);
      const found = linkProblems(dep.link, lat);
      problems.push(...found);
      const target = typeof dep.component === 'string' && counts.get(dep.component) === 1 ? list.find((c: any) => isMap(c) && c.name === dep.component) : null;
      if (!target) return;
      if ((e.repo ?? null) === (target.repo ?? null))
        return problems.push(`${lat} joins two components of ${repoLabel(e.repo)}; a link points a consumer at another repo's worktree`);
      if (found.length) return;
      const l = dep.link;
      const key = JSON.stringify([e.repo ?? null, l.ecosystem, l.name, l.ecosystem === 'cargo' ? (l.source ?? 'crates-io') : null]);
      const dir = JSON.stringify([target.repo ?? null, path.posix.normalize(String(l.path ?? target.path).replace(/\\/g, '/')).replace(/\/+$/, '')]);
      const seen = linkTargets.get(key);
      if (!seen) linkTargets.set(key, { dir, at: lat });
      else if (seen.dir !== dir) problems.push(`${lat} gives ${repoLabel(e.repo)} the ${l.ecosystem} link ${JSON.stringify(l.name)} again with another dependency dir than ${seen.at}`);
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
