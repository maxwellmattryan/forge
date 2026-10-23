// The Settings modal's endpoints: /api/config, /api/doctor and /api/about.

/** A value `forge config set` and POST /api/config can write. */
export type ConfigValue = string | number | boolean | null | string[];

/** How a settings field is parsed, validated and rendered. */
export type ConfigFieldType = 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'list' | 'object';

/** The settings tab a field belongs to. */
export type ConfigSection = 'pipeline' | 'review' | 'agents' | 'tracker' | 'dashboard' | 'daemon';

/** One entry of FIELDS in lib/core/config/fields.ts. Every property is always present. */
export interface ConfigField {
  key: string;
  section: ConfigSection;
  label: string;
  help: string;
  type: ConfigFieldType;
  options: string[] | null;
  /** List options every value must keep (review.blockOn: blocker and major). */
  required: string[] | null;
  suggestions: string[] | null;
  min: number | null;
  /** `min` itself is not allowed: values must be greater than it. */
  minExclusive: boolean;
  max: number | null;
  nullable: boolean;
  default: unknown;
  editable: boolean;
  lockedReason: string | null;
}

/** What setConfigValue in lib/core/config/load.ts returns: `forge config set` and POST /api/config. */
export interface PostConfigResponse {
  ok: true;
  key: string;
  value: ConfigValue;
  previous: unknown;
  changed: boolean;
}

/** One `forge doctor` check: doctor in lib/engine/ops/doctor.ts. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** ok, but worth a look; never set with ok: false. */
  warn?: boolean;
}

/** What `forge doctor` prints: doctor in lib/engine/ops/doctor.ts. */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** How `forge version --json` names the install: InstallKind with `git` read as a clone. */
export type InstalledAs = 'plugin' | 'clone' | 'unknown';

/** GET /api/config: configResponse in lib/server/routes/config.ts over FIELDS in lib/core/config/fields.ts. */
export interface ConfigResponse {
  initialized: boolean;
  path: '.forge/config.yml';
  fields: ConfigField[];
  /** The effective value of every field key. */
  values: Record<string, unknown>;
  problems: string[];
  writable: boolean;
  lockedBy: 'uninitialized' | 'daemon' | null;
}

/** GET /api/doctor: doctor in lib/engine/ops/doctor.ts, plus when it ran. */
export type DoctorResponse = DoctorReport & { at: string };

/** GET /api/about: about in lib/server/routes/misc.ts. */
export interface AboutResponse {
  forgeVersion: string;
  apiVersion: number;
  pluginRoot: string;
  schemaVersions: { config: number; job: number; event: number };
  pricingAsOf: string | null;
  node: string;
  links: { repo: string | null; docs: string | null };
  /** versionInfo(PLUGIN_ROOT) in lib/engine/ops/version.ts: 40 lowercase hex, or null. */
  commit: string | null;
  installedAs: InstalledAs;
}

/** POST /api/config body: the handler in lib/server/routes/config.ts passes it to setConfigValue. */
export interface PostConfigBody {
  key: string;
  value: ConfigValue;
}
