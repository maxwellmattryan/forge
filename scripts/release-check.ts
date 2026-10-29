// `npm run release:check [-- --root <dir>] [--dist absent|present]`: is this checkout fit to be a
// release commit? Versions agree, CHANGELOG has the version's notes, .claude-plugin/marketplace.json
// points installs at the `stable` branch, the tree is clean, and the built dashboard is untracked
// (`absent`: develop, the release commit and every PR into develop) or tracked and fresh (`present`: the
// stable tree release.yml's build checks through scripts/stable-tree.ts, which must also hold no
// .github/workflows/ and whose version must not be tagged at another commit); with no `--dist` the stamp
// is checked only when dist is tracked.
// Built-ins only, so CI's `release check` job runs it without `npm ci` (docs/RELEASES.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { findAttribution } from '../lib/engine/guard/attribution.ts';
import { gitSync } from './git.ts';
import { distHash, sourceHash, STAMP } from '../dashboard/build-stamp.mjs';

const SEMVER = /^\d+\.\d+\.\d+$/;
const MAX_LISTED = 10;

/** Whether a CHANGELOG section says anything: a line with text beyond list markers and whitespace. */
export const hasNotes = (section: string) => section.split(/\r?\n/).some((l) => /[^\s*+-]/.test(l));

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

/**
 * The one source installs follow: the `stable` branch, which release.yml moves, once per release. It never
 * changes per release, so a release commit leaves marketplace.json alone.
 */
export const STABLE_SOURCE = Object.freeze({ source: 'github', repo: 'maxwellmattryan/forge', ref: 'stable' });

/** The forge plugin's `source` in a parsed marketplace.json: where plugin installs come from. */
export const forgeSource = (marketplace: any): unknown =>
  Array.isArray(marketplace?.plugins) ? marketplace.plugins.find((p: any) => p?.name === 'forge')?.source : undefined;

/** Why marketplace.json does not point the forge plugin at STABLE_SOURCE, or null when it does. */
function marketplaceProblem(root: string): string | null {
  let source: unknown;
  try {
    source = forgeSource(JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8')));
  } catch (e) {
    return `cannot read marketplace.json: ${(e as Error).message}`;
  }
  if (isDeepStrictEqual(source, { ...STABLE_SOURCE })) return null;
  return `.claude-plugin/marketplace.json must point the forge plugin at ${JSON.stringify(STABLE_SOURCE)}, got ${JSON.stringify(source ?? null)}`;
}

export type DistMode = 'absent' | 'present';
const DIST_MODES: readonly string[] = ['absent', 'present'];

/**
 * Every reason `root` is not a releasable commit; [] when it is. `dist` says whether dashboard/dist
 * must be untracked (develop) or tracked (the stable tree); without it the stamp is checked only when tracked.
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
    else if (!hasNotes(section)) problems.push(`CHANGELOG.md "## ${v}" has no notes`);
    else if (findAttribution(section).length) problems.push(`CHANGELOG.md "## ${v}" has an AI attribution line: ${findAttribution(section)[0]}`);
  }

  // Installs read develop's marketplace.json: it names the stable branch, in every mode.
  const marketplace = marketplaceProblem(root);
  if (marketplace) problems.push(marketplace);

  // stable moves only to release: a stable tree whose version is already tagged elsewhere would never be
  // tagged or published. Needs the tags in the checkout.
  if (opts.dist === 'present' && v && SEMVER.test(v)) {
    const tag = gitSync(['--no-optional-locks', '-C', root, 'rev-parse', '-q', '--verify', `refs/tags/v${v}^{commit}`]);
    const head = gitSync(['--no-optional-locks', '-C', root, 'rev-parse', '-q', '--verify', 'HEAD^{commit}']);
    const [at, here] = [tag.stdout.trim(), head.stdout.trim()];
    if (tag.status === 0 && at && at !== here) problems.push(`v${v} is already tagged at ${at.slice(0, 7)}, not this commit (${here.slice(0, 7)}): bump the version to release again`);
  }

  // Pinned so repo config can't hide untracked files or reshape the listing.
  const status = gitSync(['-c', 'status.showUntrackedFiles=all', '--no-optional-locks', '-C', root, 'status', '--porcelain', '--untracked-files=all']);
  if (status.error || status.status !== 0) problems.push(`git status failed in ${root}: ${(status.stderr || status.error?.message || '').trim()}`);
  else {
    const dirty = status.stdout.split('\n').filter(Boolean);
    if (dirty.length) {
      const more = dirty.length > MAX_LISTED ? ` and ${dirty.length - MAX_LISTED} more` : '';
      problems.push(`the working tree is not clean: ${dirty.slice(0, MAX_LISTED).map((l) => l.slice(3)).join(', ')}${more}`);
    }
  }

  // GITHUB_TOKEN can't move a ref across a change to workflow files, so stable never holds any.
  if (opts.dist === 'present') {
    const workflows = gitSync(['--no-optional-locks', '-C', root, 'ls-files', '--', '.github/workflows']);
    if (workflows.error || workflows.status !== 0) problems.push(`git ls-files failed in ${root}: ${(workflows.stderr || workflows.error?.message || '').trim()}`);
    else if (workflows.stdout.trim() !== '') problems.push('the stable tree tracks .github/workflows: CI drops it so GITHUB_TOKEN can move stable');
  }

  // develop never commits the build; the stable tree must carry it.
  const tracked = gitSync(['--no-optional-locks', '-C', root, 'ls-files', '--', 'dashboard/dist']);
  if (tracked.error || tracked.status !== 0) {
    problems.push(`git ls-files failed in ${root}: ${(tracked.stderr || tracked.error?.message || '').trim()}`);
    return problems;
  }
  const distTracked = tracked.stdout.trim() !== '';
  if (opts.dist === 'absent') {
    if (distTracked) problems.push('dashboard/dist is tracked: develop never commits the build (CI builds it for stable)');
    return problems;
  }
  if (opts.dist === 'present' && !distTracked) {
    problems.push('dashboard/dist is not committed: stable needs the built dashboard');
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
