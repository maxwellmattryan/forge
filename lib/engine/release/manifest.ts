// The root package name and version read from a clone's `package.json` or `Cargo.toml`, filtered to
// what a registry accepts, and the ecosystem a repo's mechanism and registry publish to.

import fs from 'node:fs';
import path from 'node:path';
import type { ReleaseMechanism, ReleaseRegistry } from '#core/types.ts';

// Manifests are the human's own files, but their text lands in release.md and argv: only names and
// versions a registry would accept go through.
// The first character is never `-`: the name goes into `npm view` / `cargo search` argv.
const NPM_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]{0,213}$/;
const CARGO_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^\d[0-9A-Za-z.+-]{0,63}$/;
const MANIFEST_MAX = 1024 * 1024;

function readManifest(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MANIFEST_MAX) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const unquote = (v: string): string | null => {
  const m = /^"([^"\\]*)"\s*(?:#.*)?$/.exec(v.trim()) ?? /^'([^']*)'\s*(?:#.*)?$/.exec(v.trim());
  return m ? m[1] : null;
};

/** The root package of the clone at `dir`: its name and version, or why there is none to check. */
export function readManifestPackage(dir: string, ecosystem: 'npm' | 'cargo'): { name: string; version: string } | { reason: string } {
  if (ecosystem === 'npm') {
    const text = readManifest(path.join(dir, 'package.json'));
    if (text === null) return { reason: 'no package.json at the clone root' };
    let pkg: any;
    try {
      pkg = JSON.parse(text);
    } catch {
      return { reason: 'package.json is not valid JSON' };
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return { reason: 'package.json is not an object' };
    if (pkg.private === true) return { reason: 'package.json is private (a workspace root publishes its packages one by one)' };
    if (typeof pkg.name !== 'string' || !NPM_NAME.test(pkg.name)) return { reason: 'package.json has no valid name' };
    if (typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) return { reason: 'package.json has no valid version' };
    return { name: pkg.name, version: pkg.version };
  }
  const text = readManifest(path.join(dir, 'Cargo.toml'));
  if (text === null) return { reason: 'no Cargo.toml at the clone root' };
  let section = '';
  let sawWorkspace = false;
  let sawPackage = false;
  let name: string | null = null;
  let version: string | null = null;
  let inherited = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]*)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = header[1].trim();
      if (section === 'package') sawPackage = true;
      if (section === 'workspace' || section.startsWith('workspace.')) sawWorkspace = true;
      continue;
    }
    if (section !== 'package') continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'name') name = unquote(value);
    else if (key === 'version') {
      version = unquote(value);
      if (version === null && /workspace\s*=\s*true/.test(value)) inherited = true;
    } else if (key === 'version.workspace') inherited = true;
  }
  if (!sawPackage) return { reason: sawWorkspace ? 'Cargo.toml is a workspace with no root package' : 'Cargo.toml has no [package]' };
  if (name === null || !CARGO_NAME.test(name)) return { reason: 'Cargo.toml has no valid [package] name' };
  if (inherited) return { reason: 'the [package] version comes from the workspace' };
  if (version === null || !VERSION.test(version)) return { reason: 'Cargo.toml has no valid [package] version' };
  return { name, version };
}

export function ecosystemOf(mechanism: ReleaseMechanism, registry: ReleaseRegistry | null): 'npm' | 'cargo' | null {
  if (registry === 'npm') return 'npm';
  if (registry === 'crates.io') return 'cargo';
  if (mechanism === 'cargo-release') return 'cargo';
  if (mechanism === 'changesets') return 'npm';
  return null;
}
