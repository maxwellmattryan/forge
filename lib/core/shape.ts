// Shape helpers every validator and state writer shares: one definition each, so the prototype-key
// guards can't drift between copies. Imports only errors.ts, and errors.ts must never import this file.

import { ForgeError } from './errors.ts';

/**
 * A plain map: not null, not a list. Narrows to `any` on purpose: validators read optional nested
 * keys of parsed YAML and check each value where they use it.
 */
export const isMap = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A value as a validator quotes it in a problem: JSON, cut to `max` characters; `nothing` when absent. */
export const show = (v: unknown, max = 120): string => (v === undefined ? 'nothing' : (JSON.stringify(v) ?? String(v)).slice(0, max));

/** A value's kind, for fields that can hold credentials (a url, a whole backing value): never the value itself. */
export const kind = (v: unknown): string => (v === undefined ? 'nothing' : v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'a map' : `a ${typeof v}`);

/** Keys that reach an object's prototype when assigned or walked. */
export const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Whether any segment of a dotted path is a prototype key. */
export const hasProtoSegment = (dotted: string): boolean => dotted.split('.').some((k) => PROTO_KEYS.has(k));

// Far deeper than any config or answers file; the bound turns runaway nesting into a refusal instead
// of a stack overflow. refuseProtoKeys walks both inputs first, so it also bounds merge's recursion.
const MAX_DEPTH = 64;

/** Throws when `v` holds an own prototype key at any depth, lists included, or nests past MAX_DEPTH. */
function refuseProtoKeys(v: unknown, label: string, depth = 0): void {
  if (depth > MAX_DEPTH) throw new ForgeError(`${label} is nested more than ${MAX_DEPTH} levels deep`, 'usage');
  if (Array.isArray(v)) for (const x of v) refuseProtoKeys(x, label, depth + 1);
  else if (isMap(v))
    for (const k of Object.keys(v)) {
      if (PROTO_KEYS.has(k)) throw new ForgeError(`${label} key ${JSON.stringify(k)} is not allowed`, 'usage');
      refuseProtoKeys(v[k], label, depth + 1);
    }
}

function merge(base: unknown, over: unknown): Record<string, any> {
  const out: Record<string, any> = {};
  if (isMap(base)) for (const k of Object.keys(base)) out[k] = structuredClone(base[k]);
  if (!isMap(over)) return out;
  for (const k of Object.keys(over)) {
    const v = over[k];
    out[k] = isMap(v) && isMap(out[k]) ? merge(out[k], v) : structuredClone(v);
  }
  return out;
}

/**
 * `over` deep-merged into a copy of `base`; neither input changes. Maps merge key by key, lists and
 * scalars from `over` replace. A non-map `base` counts as `{}`, a non-map `over` adds nothing. Both
 * inputs are walked in full first, so an own `__proto__`, `constructor` or `prototype` key anywhere
 * is refused before anything is copied, and Object.prototype is never written.
 */
export function deepMerge<T extends Record<string, any>>(base: T, over: unknown, labels: { base?: string; over?: string } = {}): T {
  refuseProtoKeys(base, labels.base ?? 'merge base');
  refuseProtoKeys(over, labels.over ?? 'merge source');
  return merge(base, over) as T;
}

/** The value at a dotted path, or undefined; a path with a prototype segment reads nothing. */
export function getPath(obj: unknown, dotted: string): any {
  if (!dotted) return obj;
  if (hasProtoSegment(dotted)) return undefined;
  return dotted.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), obj);
}

/** Sets the value at a dotted path, creating maps on the way; refuses a prototype segment before writing anything. */
export function setPath(obj: any, dotted: string, value: unknown): void {
  if (hasProtoSegment(dotted)) throw new ForgeError(`${JSON.stringify(dotted.slice(0, 80))}: __proto__, constructor and prototype are not path segments`, 'usage');
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}
