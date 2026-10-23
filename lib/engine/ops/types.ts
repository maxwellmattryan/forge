// What the audit, support-bundle, update, version, archive and prune commands print, type-only.
import type { RedactCounts } from '../guard/types.ts';
import type { EventActor, InstalledAs } from '#api/types.ts';

/** One row of `forge job audit` / `forge audit` (lib/engine/ops/audit.ts); `job` is null for the repo-level log. */
export interface AuditRow {
  ts: string;
  job: string | null;
  actor: EventActor | null;
  /** The `human` event's action, else the event type, else `gate:<waitingOn>` / `gate-cleared:<waitingOn>`. */
  action: string;
  /** The human's note or the transition's reason. */
  note: string | null;
  /** A short per-type summary: budget keys, the PR and merge method, the linked ref, the permission tool. */
  detail: string | null;
}

/** `forge job audit <id> --json`. */
export interface JobAudit {
  id: string;
  title: string;
  pr: { number: number | null; mergeMethod: string | null; merged: boolean };
  rows: AuditRow[];
}

/** `forge audit --json`. */
export interface RepoAudit {
  since: string;
  until: string;
  rows: AuditRow[];
}

/** One zip entry and its uncompressed size. */
export interface BundleEntry {
  name: string;
  bytes: number;
}

/** A file the bundle left out instead of reading: a symlink, a FIFO, one outside its dir, or unreadable. */
export interface BundleSkip {
  name: string;
  reason: string;
}

/** The support bundle's manifest.json: buildBundle in lib/engine/ops/bundle.ts. Names are already redacted. */
export interface BundleManifest {
  createdAt: string;
  forgeVersion: string;
  includeText: boolean;
  jobs: string[];
  entries: BundleEntry[];
  skipped: BundleSkip[];
  redactions: RedactCounts;
}

/** `forge doctor --bundle`'s stdout. */
export interface BundleResult {
  file: string;
  bytes: number;
  entries: BundleEntry[];
  skipped: BundleSkip[];
  redactions: RedactCounts;
  includeText: boolean;
  jobs: string[];
}

/** How the running Forge was installed: detectInstall in lib/engine/ops/update.ts. */
export type InstallKind = 'plugin' | 'git' | 'unknown';

/** The running install as detectInstall in lib/engine/ops/update.ts sees it. */
export interface InstallInfo {
  kind: InstallKind;
  root: string;
  version: string;
  /** `<plugin>@<marketplace>`, plugin installs only. */
  plugin?: string;
  marketplace?: string;
  /** The Claude Code `plugins/` dir the install sits under. */
  pluginsDir?: string;
  /** Why a path that looked like a plugin install was not trusted. */
  reason?: string;
}

/** `forge version --json`: versionInfo in lib/engine/ops/version.ts. */
export interface VersionInfo {
  version: string;
  /** 40 lowercase hex, or null when no source could say. */
  commit: string | null;
  installedAs: InstalledAs;
  node: string;
}

/** What `forge update --check` prints: updateForge in lib/engine/ops/update.ts. */
export interface UpdateCheck {
  kind: InstallKind;
  root: string;
  version: string;
  plugin?: string;
  branch?: string;
  upstream?: string;
  commands: string[];
  blocked?: string;
  dashboard?: { running: true; url: string };
  warnings?: string[];
}

/** This repo's dashboard after an update: updateForge in lib/engine/ops/update.ts. */
export type UpdateDashboard = { restarted: true; url?: string } | { running: true; stale: true; url: string };

/** What `forge update` prints: updateForge in lib/engine/ops/update.ts. */
export interface UpdateResult {
  kind: InstallKind;
  root: string;
  from: string;
  to: string;
  updated: boolean;
  /** Only when the update moved the install to another directory. */
  newRoot?: string;
  /** Git installs: short shas before and after. */
  head?: { from: string; to: string };
  commands: string[];
  dashboard?: UpdateDashboard;
  warnings?: string[];
  next: string[];
}

/** `forge job archive` output. */
export interface ArchiveResult {
  archived: { id: string; file: string; bytes: number }[];
  refused: { id: string; reason: string }[];
}

/** `forge job prune` output; `file` is relative to the repo root. */
export interface PruneResult {
  dryRun: boolean;
  jobs: { id: string; bytes: number }[];
  refused: { id: string; reason: string }[];
  logs: { scope: string; file: string; bytes: number }[];
  freedBytes: number;
}
