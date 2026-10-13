// @ts-check
// Fingerprints the dashboard sources and the built dist/, so a test can tell a stale or
// hand-edited dist/ without Vite, node_modules or the network. Built-ins only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAMP = 'build-stamp.json';

/**
 * Regular files under `dir`, as sorted posix-relative paths. Dotfiles and node_modules are
 * skipped at every depth; `skipTop` names are skipped only at the top level.
 * @param {string} dir @param {string[]} skipTop
 */
function walk(dir, skipTop) {
  /** @type {string[]} */
  const out = [];
  const visit = (/** @type {string} */ d, /** @type {string} */ rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (!rel && skipTop.includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  visit(dir, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** @param {crypto.Hash} h @param {string} dir @param {string[]} skipTop */
function hashTree(h, dir, skipTop) {
  for (const rel of walk(dir, skipTop)) {
    // CRLF normalised so a Windows checkout with autocrlf hashes like everyone else's.
    const content = fs.readFileSync(path.join(dir, rel)).toString('latin1').replace(/\r\n/g, '\n');
    h.update(rel + '\0');
    h.update(Buffer.from(content, 'latin1'));
    h.update('\0');
  }
}

/**
 * Hash of every dashboard source plus the toolchain's resolved package versions. Names and
 * versions only, so a release's root version bump or lockfile metadata churn doesn't mark dist stale.
 * @param {string} dashboardDir @param {string} lockPath
 */
export function sourceHash(dashboardDir, lockPath) {
  const h = crypto.createHash('sha256');
  hashTree(h, dashboardDir, ['dist']);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const lines = Object.entries(lock.packages ?? {})
    .filter(([key]) => key !== '')
    .map(([key, entry]) => `${key}@${/** @type {any} */ (entry)?.version}`)
    .sort();
  h.update('package-lock\0');
  h.update(lines.join('\n'));
  return h.digest('hex');
}

/** Hash of the built output, excluding the stamp itself. @param {string} distDir */
export function distHash(distDir) {
  const h = crypto.createHash('sha256');
  hashTree(h, distDir, [STAMP]);
  return h.digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dashboard = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(dashboard, 'dist');
  const stamp = { source: sourceHash(dashboard, path.join(dashboard, '..', 'package-lock.json')), dist: distHash(dist) };
  fs.writeFileSync(path.join(dist, STAMP), JSON.stringify(stamp, null, 2) + '\n');
}
