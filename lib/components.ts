// Components: the parts of a repo (`config.components`), what kind each is and what it depends on.
// The lists live here rather than in schema.ts because schema.ts runs servicesToComponents as a
// migration while it loads; schema.ts re-exports them beside its other runtime lists.

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
