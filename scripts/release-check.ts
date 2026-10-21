// `npm run release:check [-- --root <dir>] [--dist absent|present]`: is this checkout fit to be a
// release commit? Versions agree, CHANGELOG has the version's notes, the tree is clean, and the
// built dashboard is untracked (`absent`, develop) or tracked and fresh (`present`, main and the
// main update); with no `--dist` the stamp is checked only when dist is tracked.
// Built-ins only, so CI's `release check` job runs it without `npm ci` (docs/RELEASES.md).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findAttribution } from '../lib/attribution.ts';
import { distHash, sourceHash, STAMP } from '../dashboard/build-stamp.mjs';

const SEMVER = /^\d+\.\d+\.\d+$/;
const MAX_LISTED = 10;

/**
 * The body under the exact heading line `## <version>` (trailing spaces allowed), up to the next
 * `## ` heading, trimmed: null when the heading is missing, '' when the body is empty.
 */
export function changelogSection(text: string, version: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trimEnd() === `## ${version}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

function version(file: string): { value: unknown; problem?: string } {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8'))?.version };
  } catch (e) {
    return { value: undefined, problem: `cannot read ${path.basename(file)}: ${(e as Error).message}` };
  }
}

export type DistMode = 'absent' | 'present';
const DIST_MODES: readonly string[] = ['absent', 'present'];

/**
 * Every reason `root` is not a releasable commit; [] when it is. `dist` says whether dashboard/dist
 * must be untracked (develop) or tracked (main); without it the stamp is checked only when tracked.
 */
export function releaseProblems(root: string, opts: { dist?: DistMode } = {}): string[] {
  const problems: string[] = [];
  const pkg = version(path.join(root, 'package.json'));
  const plugin = version(path.join(root, '.claude-plugin', 'plugin.json'));
  for (const p of [pkg.problem, plugin.problem]) if (p) problems.push(p);
  const v = typeof pkg.value === 'string' ? pkg.value : null;
  if (pkg.value !== plugin.value) problems.push(`package.json version ${JSON.stringify(pkg.value)} differs from .claude-plugin/plugin.json version ${JSON.stringify(plugin.value)}`);
  if (!v || !SEMVER.test(v)) problems.push(`version ${JSON.stringify(pkg.value)} is not X.Y.Z`);

  if (v) {
    let changelog = '';
    try {
      changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    } catch {
      problems.push('CHANGELOG.md is missing');
    }
    const section = changelogSection(changelog, v);
    if (section === null) problems.push(`CHANGELOG.md has no "## ${v}" heading`);
    else if (!section) problems.push(`CHANGELOG.md "## ${v}" has no notes`);
    else if (findAttribution(section).length) problems.push(`CHANGELOG.md "## ${v}" has an AI attribution line: ${findAttribution(section)[0]}`);
  }

  // Pinned so repo config can't hide untracked files or reshape the listing.
  const status = spawnSync('git', ['-c', 'core.quotepath=off', '-c', 'status.showUntrackedFiles=all', '--no-optional-locks', '-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  if (status.error || status.status !== 0) problems.push(`git status failed in ${root}: ${(status.stderr || status.error?.message || '').trim()}`);
  else {
    const dirty = status.stdout.split('\n').filter(Boolean);
    if (dirty.length) {
      const more = dirty.length > MAX_LISTED ? ` and ${dirty.length - MAX_LISTED} more` : '';
      problems.push(`the working tree is not clean: ${dirty.slice(0, MAX_LISTED).map((l) => l.slice(3)).join(', ')}${more}`);
    }
  }

  // develop never commits the build; main must carry it.
  const tracked = spawnSync('git', ['-c', 'core.quotepath=off', '--no-optional-locks', '-C', root, 'ls-files', '--', 'dashboard/dist'], { encoding: 'utf8' });
  if (tracked.error || tracked.status !== 0) {
    problems.push(`git ls-files failed in ${root}: ${(tracked.stderr || tracked.error?.message || '').trim()}`);
    return problems;
  }
  const distTracked = tracked.stdout.trim() !== '';
  if (opts.dist === 'absent') {
    if (distTracked) problems.push('dashboard/dist is tracked: develop never commits the build (CI builds it for the main update)');
    return problems;
  }
  if (opts.dist === 'present' && !distTracked) {
    problems.push('dashboard/dist is not committed: main needs the built dashboard');
    return problems;
  }
  if (!distTracked) return problems;

  const dashboard = path.join(root, 'dashboard');
  const dist = path.join(dashboard, 'dist');
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(dist, STAMP), 'utf8'));
    if (stamp?.source !== sourceHash(dashboard, path.join(root, 'package-lock.json'))) problems.push('dashboard/dist is stale: a dashboard source or package-lock.json changed after the last build (npm run build:dashboard)');
    if (stamp?.dist !== distHash(dist)) problems.push('dashboard/dist was edited by hand: its files do not match the build stamp (npm run build:dashboard)');
  } catch (e) {
    problems.push(`cannot check dashboard/dist against ${STAMP}: ${(e as Error).message}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let root = path.resolve(import.meta.dirname, '..');
  let dist: DistMode | undefined;
  const usage = () => {
    process.stderr.write('usage: node scripts/release-check.ts [--root <dir>] [--dist absent|present]\n');
    process.exit(2);
  };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (value === undefined || seen.has(flag)) usage();
    seen.add(flag);
    if (flag === '--root') root = path.resolve(value);
    else if (flag === '--dist' && DIST_MODES.includes(value)) dist = value as DistMode;
    else usage();
  }
  const problems = releaseProblems(root, { dist });
  if (problems.length) {
    for (const p of problems) process.stderr.write(`${p}\n`);
    process.exit(1);
  }
  const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  process.stdout.write(`release check passed: ${v}\n`);
}
