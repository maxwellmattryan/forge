// Config keys on their way out (docs/RELEASES.md "Deprecation"). `forge doctor` warns while one is
// set; docs/CONFIG.md "Deprecated keys" lists the same entries, and test/version.test.ts checks both.
import { parse } from './yaml.ts';
import { getPath } from './shape.ts';
import type { DoctorCheck } from './types.ts';

export interface DeprecatedKey {
  /** Dotted path, as `forge config get` takes it. */
  key: string;
  /** The release that announced it, X.Y.Z. */
  since: string;
  /** The first release without it, at least one minor after `since`. */
  removeIn: string;
  /** The key to use instead, or null when `note` says what to do. */
  replacement: string | null;
  note: string;
}

export const DEPRECATED_CONFIG_KEYS: readonly DeprecatedKey[] = [];

/**
 * One warning per registry key the user wrote. It reads the raw file because migrations and
 * defaults would hide what is actually set.
 */
export function deprecationChecks(text: string, registry: readonly DeprecatedKey[] = DEPRECATED_CONFIG_KEYS): DoctorCheck[] {
  if (!registry.length) return [];
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  return registry
    .filter((d) => getPath(raw, d.key) !== undefined)
    .map((d) => ({ name: `deprecated config key ${d.key}`, ok: true, warn: true, detail: `deprecated in ${d.since}, removed in ${d.removeIn}; ${d.replacement ? `use ${d.replacement}` : d.note}` }));
}
