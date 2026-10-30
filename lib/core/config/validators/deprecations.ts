// Config keys on their way out (docs/RELEASES.md "Deprecation"), and the keys Forge does not know: `forge doctor`
// warns while a deprecated or unknown key is set. docs/CONFIG.md "Deprecated keys" lists the registry's entries,
// and test/invariants/version.test.ts checks both.
import { parse } from '../../format/yaml.ts';
import { getPath, isMap } from '../../shape.ts';
import { safeText } from '../../text.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../../job/schema.ts';
import { defaults } from '../keys/defaults.ts';
import type { DoctorCheck } from '../../types.ts';

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

const NO_AGENT_READS = 'no agent reads it: put the text in AGENTS.md (or a file project.instructions names) and delete the key';

export const DEPRECATED_CONFIG_KEYS: readonly DeprecatedKey[] = [
  { key: 'project.description', since: '0.23.0', removeIn: '1.0.0', replacement: null, note: NO_AGENT_READS },
  { key: 'project.kinds', since: '0.23.0', removeIn: '1.0.0', replacement: null, note: NO_AGENT_READS },
  { key: 'project.notes', since: '0.23.0', removeIn: '1.0.0', replacement: null, note: NO_AGENT_READS },
  { key: 'infra.notes', since: '0.23.0', removeIn: '1.0.0', replacement: null, note: NO_AGENT_READS },
  { key: 'usage.track', since: '0.23.0', removeIn: '1.0.0', replacement: null, note: 'it has no effect (usage is recorded either way): delete the key' },
  { key: 'runtime.host', since: '0.23.0', removeIn: '1.0.0', replacement: null, note: 'it has no effect: delete the key' },
];

/**
 * The maps whose keys the user names: the `uniform` entries of keys/docs.ts, which the CLI must not import at
 * start-up. `forge config validate` polices their keys, so the unknown-key check never enters them.
 */
export const USER_NAMED_MAPS = ['project.instructions', 'commands', 'runtime.efforts', 'runtime.effortByComplexity', 'runtime.models', 'runtime.modelByComplexity'] as const;

const UNKNOWN_DETAIL = 'Forge reads no such key, so it has no effect: check its spelling and section against docs/CONFIG.md';

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

/**
 * One warning per key the file sets that defaults() lacks, in file order (docs/CONFIG.md "Unknown keys"). It walks
 * the migrated file, so a key an older schemaVersion used and a migration renames is not flagged, and stops at the
 * first unknown segment, at lists, at user-named and default-empty maps, and where the file's type differs from
 * the default's: those are `forge config validate`'s.
 */
export function unknownKeyChecks(text: string, registry: readonly DeprecatedKey[] = DEPRECATED_CONFIG_KEYS): DoctorCheck[] {
  let config: Record<string, unknown>;
  try {
    const raw: unknown = parse(text);
    if (!isMap(raw)) return [];
    // The same comparison migrateConfig makes: a newer file is left as written, so its keys can't be judged here.
    if ((raw.schemaVersion ?? CONFIG_SCHEMA_VERSION) > CONFIG_SCHEMA_VERSION) return [];
    const migrated: unknown = migrateConfig(raw).config;
    if (!isMap(migrated)) return [];
    config = migrated;
  } catch {
    return [];
  }
  const deprecated = new Set(registry.map((d) => d.key));
  const userNamed = new Set<string>(USER_NAMED_MAPS);
  const kind = isMap(config.tracker) ? config.tracker.kind : undefined;
  // A custom adapter's settings sit under tracker.<kind> (docs/TRACKERS.md), a block defaults() can't know.
  const adapterBlock = typeof kind === 'string' ? `tracker.${kind}` : null;
  const rows: DoctorCheck[] = [];
  const walk = (value: Record<string, unknown>, base: Record<string, unknown>, prefix: string): void => {
    for (const k of Object.keys(value)) {
      const at = prefix ? `${prefix}.${k}` : k;
      if (deprecated.has(at) || userNamed.has(at)) continue;
      if (!Object.hasOwn(base, k)) {
        if (at !== adapterBlock) rows.push({ name: `unknown config key ${safeText(at, 120)}`, ok: true, warn: true, detail: UNKNOWN_DETAIL });
        continue;
      }
      const v = value[k];
      const b = base[k];
      if (isMap(v) && isMap(b) && Object.keys(b).length > 0) walk(v, b, at);
    }
  };
  walk(config, defaults() as unknown as Record<string, unknown>, '');
  return rows;
}
