// Backing services' validated entries and their port records: each job's `backing.json` and the
// project's shared one, read tolerantly (the session can write them), and the host ports they hold.
// Split from backing.ts so job ports (ports.ts) and backing ports share one allocation path without
// an import cycle.
import fs from 'node:fs';
import path from 'node:path';
import { backingProblems } from '#core/config/validators/backing.ts';
import { jobDir } from '#core/job/store.ts';
import { paths } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { readJson } from '#core/os/fs.ts';
import type { BackingEntry, BackingIsolation, Config } from '#core/types.ts';
import type { BackingRecord } from './types.ts';

/** The validated entries; an invalid backing config is refused before any docker call. */
export function entries(config: Config): BackingEntry[] {
  const list = Array.isArray(config.backing) ? config.backing : [];
  if (!list.length) return [];
  const problems = backingProblems(config);
  if (problems.length) throw new ForgeError(`backing config is invalid: ${problems.join('; ')}`);
  return list;
}

/** entries() without throwing: an invalid config contributes nothing (validation reports it). */
export function entriesOrNone(config: Config): BackingEntry[] {
  try {
    return entries(config);
  } catch {
    return [];
  }
}

export const jobRecordFile = (root: string, id: string): string => path.join(jobDir(root, id), 'backing.json');
export const sharedRecordFile = (root: string): string => path.join(paths(root).runtime, 'backing.json');
export const emptyRecord = (): BackingRecord => ({ v: 1, ports: {} });

/** A record file's JSON, or null when it is missing or unreadable (the session can write it). */
export function readRaw(file: string): any {
  try {
    return readJson(file, null);
  } catch {
    return null;
  }
}

function inRange(config: Config, p: unknown): p is number {
  return Number.isInteger(p) && (p as number) >= config.ports.base && (p as number) < config.ports.base + config.ports.span;
}

/**
 * A record read tolerantly: an entry is kept only when its name is a current managed entry of the
 * right isolation, every port key is in that entry's ports, and every host port is in range and
 * not already used in this record. Anything else is dropped, to be allocated again.
 */
function readRecord(file: string, config: Config, isolation: BackingIsolation): BackingRecord {
  const raw = readRaw(file);
  const out = emptyRecord();
  if (!raw || typeof raw !== 'object' || !raw.ports || typeof raw.ports !== 'object') return out;
  const seen = new Set<number>();
  for (const e of entriesOrNone(config).filter((x) => x.isolation === isolation)) {
    const m = raw.ports[e.name];
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    const want = (e.ports ?? []).map(String);
    const keys = Object.keys(m);
    if (keys.length !== want.length || !want.every((k) => keys.includes(k))) continue;
    const ports: Record<string, number> = {};
    const here = new Set<number>();
    for (const k of want) if (inRange(config, m[k]) && !seen.has(m[k]) && !here.has(m[k])) here.add((ports[k] = m[k]));
    if (here.size !== want.length) continue;
    for (const p of here) seen.add(p);
    out.ports[e.name] = ports;
  }
  return out;
}

export function readJobRecord(root: string, id: string, config: Config): BackingRecord {
  return readRecord(jobRecordFile(root, id), config, 'per-job');
}

export function readSharedRecord(root: string, config: Config): BackingRecord {
  return readRecord(sharedRecordFile(root), config, 'shared');
}

/** Every in-range integer port a record file names, read raw: a stale entry may still hold a running container. */
export function rawPorts(file: string, config: Config): number[] {
  const raw = readRaw(file);
  const out: number[] = [];
  if (!raw || typeof raw !== 'object' || !raw.ports || typeof raw.ports !== 'object') return out;
  for (const m of Object.values(raw.ports)) if (m && typeof m === 'object') for (const p of Object.values(m)) if (inRange(config, p)) out.push(p);
  return out;
}

function jobIds(root: string): string[] {
  const dir = paths(root).jobs;
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9._-]*$/i.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * The host ports backing services hold: every port in any job's backing.json (active or not, since a
 * cancelled job's container may still run), except `exceptId`'s, and every port in the shared record.
 */
export function takenPorts(root: string, config: Config, exceptId?: string): Set<number> {
  const taken = new Set<number>();
  for (const id of jobIds(root)) if (id !== exceptId) for (const p of rawPorts(jobRecordFile(root, id), config)) taken.add(p);
  for (const p of rawPorts(sharedRecordFile(root), config)) taken.add(p);
  return taken;
}

/** The project's lock every host port is handed out under (inside the machine's, ports.ts withPortsLock). */
export const portsLock = (root: string): string => path.join(paths(root).locks, 'ports');
