// Backing services' Docker names: a container is `forge-<owner>-<name>` and its volumes add `-<i>`.
// The owner is qualified by the root's label (the job id or project slug plus rootLabel), so two
// registered projects with one basename or job id never share a container; the legacy owners (the
// bare job id or slug) are still looked up so an upgrade keeps its running containers and volumes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '#core/types.ts';

const slugOf = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `project.name`, else the repo root's basename, lowercased to Docker's name charset. */
export function projectSlug(root: string, config: Config): string {
  return slugOf(String(config.project?.name ?? '')) || slugOf(path.basename(root)) || 'project';
}

/** The first 12 hex of sha256(realpath(root)): which checkout a container belongs to. */
export function rootLabel(root: string): string {
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // An unresolvable root still gets a stable label from its own path.
  }
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 12);
}

/** `forge-<owner>-<name>`: the owner is jobOwner for per-job entries and sharedOwner for shared ones. */
export function containerName(owner: string, name: string): string {
  return `forge-${owner}-${name}`;
}

export function volumeName(owner: string, name: string, i: number): string {
  return `${containerName(owner, name)}-${i}`;
}

/** A per-job entry's owner: `<job>-<rootLabel>`. */
export const jobOwner = (root: string, id: string): string => `${id}-${rootLabel(root)}`;

/** A shared entry's owner: `<project slug>-<rootLabel>`. */
export const sharedOwner = (root: string, config: Config): string => `${projectSlug(root, config)}-${rootLabel(root)}`;

/** The owners an entry's container and volumes are looked up under, qualified first, then the legacy one from before #400. */
export function ownersOf(root: string, config: Config, jobId: string | null): [qualified: string, legacy: string] {
  return jobId ? [jobOwner(root, jobId), jobId] : [sharedOwner(root, config), projectSlug(root, config)];
}
