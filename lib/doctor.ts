// `forge doctor` and GET /api/doctor: is this machine and repo ready for Forge?
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig, worktreeRoot } from './config.ts';
import { dockerCheck } from './backing.ts';
import { apiKeyVars } from './daemon.ts';
import { deprecationChecks } from './deprecations.ts';
import { memberRepoChecks, releaseChecks, repoProblems } from './member-repos.ts';
import { isActive, listJobs } from './jobs.ts';
import { notifyChecks } from './notify.ts';
import { paths, exists, PLUGIN_ROOT } from './paths.ts';
import { dirBytes } from './retention.ts';
import { SUPPORT_URL, hostInfo, platformTier, posixShell, tierDetail, versionAtLeast } from './platform.ts';
import type { HostInfo } from './platform.ts';
import type { Config, DoctorCheck, DoctorReport } from './types.ts';
import { hasBinary, readText, run } from './util.ts';
import { latestReleaseCheck } from './version.ts';

/** package.json `engines`: Node 22.18 is the first with type stripping on by default. */
export function nodeSupported(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}

/** Past this, one of .forge/jobs, .forge/archive or .forge/runtime is worth pruning: 500 MiB. */
export const STORAGE_WARN_BYTES = 524_288_000;

/** `139.2 MB`: binary units, one decimal past bytes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * The `storage` check: the size of each of .forge/jobs, .forge/archive and .forge/runtime, measured
 * with lstat and never through a link (a missing one is 0). Always ok; a warning past `warnBytes`.
 */
export function storageCheck(root: string, warnBytes = STORAGE_WARN_BYTES): DoctorCheck {
  const p = paths(root);
  const sizes: [string, number][] = [
    ['jobs', dirBytes(p.jobs)],
    ['archive', dirBytes(p.archive)],
    ['runtime', dirBytes(p.runtime)],
  ];
  const warn = sizes.some(([, n]) => n > warnBytes);
  const detail = sizes.map(([k, n]) => `${k} ${formatBytes(n)}`).join(' · ') + (warn ? '; run forge job prune --older-than 30 --dry-run' : '');
  return { name: 'storage', ok: true, detail, ...(warn ? { warn: true } : {}) };
}

/**
 * The `dashboard built` check: a plugin checkout off `main` (develop, a clone) has no dashboard/dist/
 * until it is built. Always ok, so a source checkout never fails doctor; a warning until it is built.
 */
export function dashboardCheck(distDir: string = path.join(PLUGIN_ROOT, 'dashboard', 'dist')): DoctorCheck {
  if (exists(path.join(distDir, 'manifest.json'))) return { name: 'dashboard built', ok: true, detail: 'ok' };
  return { name: 'dashboard built', ok: true, warn: true, detail: 'not built: run npm ci && npm run build:dashboard' };
}

/** The repo root and worktrees root that sit on the Windows filesystem (/mnt/…) under WSL2. */
function onWindowsFs(root: string, config: Config): string[] {
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // A root that can't be resolved is still judged by its own path.
  }
  const posix = (p: string) => p.replaceAll('\\', '/');
  return [...new Set([real, worktreeRoot(root, config)].map(posix))].filter((p) => p.startsWith('/mnt/'));
}

export async function doctor(root: string, config: Config, initialized: boolean, host: HostInfo = hostInfo()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });
  // First, so the verdict is the first thing doctor prints.
  const tier = platformTier(host);
  add('platform', tier !== 'unsupported', tierDetail(host));
  if (tier === 'supported-with-notes') {
    const bad = onWindowsFs(root, config);
    add(
      'repo on the Linux filesystem (WSL2)',
      !bad.length,
      bad.length ? `${bad.join(', ')} under /mnt/ (the Windows filesystem): clone the repo under your Linux home (e.g. ~/src) and keep worktrees.root there too: ${SUPPORT_URL}` : 'ok',
    );
  }
  if (host.platform === 'win32') {
    try {
      add('POSIX sh (command templates)', true, posixShell({ platform: host.platform }));
    } catch (e) {
      add('POSIX sh (command templates)', false, (e as Error).message);
    }
  }
  add('node >= 22.18', nodeSupported(process.versions.node), process.versions.node);
  const gitV = run('git', ['--version'], { allowFail: true });
  add('git >= 2.38', gitV.ok && versionAtLeast(gitV.stdout, [2, 38]), gitV.ok ? gitV.stdout.trim() : 'git not found');
  const sparse = run('git', ['sparse-checkout', '-h'], { allowFail: true });
  add('git sparse-checkout (evals)', sparse.status === 129 || sparse.ok, '');
  add('config present', initialized, initialized ? path.relative(root, paths(root).config) : 'run /forge init');
  if (initialized) {
    const problems = validateConfig(config, root);
    add('config valid', !problems.length, problems.join('; '));
    checks.push(...deprecationChecks(readText(paths(root).config)));
    // A bad repos list is already a failing config check; member checks would only guess at it.
    if (!repoProblems(config, root).length) checks.push(...memberRepoChecks(root, config));
    checks.push(...releaseChecks(root, config));
    // Only with a valid config that has a per-job or shared entry; otherwise Docker is never called.
    const docker = problems.length ? null : dockerCheck(config);
    if (docker) checks.push(docker);
  }
  const keys = apiKeyVars(process.env);
  if (initialized && config.daemon.enabled && keys.length) {
    const api = config.daemon.auth === 'api-key';
    add('daemon billing', true, api ? `${keys.join(', ')} set: sessions bill that API account (daemon.auth: api-key)` : `${keys.join(', ')} set but ignored: sessions use your Claude login (daemon.auth: subscription)`);
  }
  const needsGh = config.pr.enabled || config.tracker.kind === 'github';
  if (needsGh) {
    const auth = hasBinary('gh') ? run('gh', ['auth', 'status'], { allowFail: true }) : null;
    add('gh installed + authenticated', Boolean(auth?.ok), auth ? (auth.ok ? 'ok' : (auth.stderr || auth.stdout).trim().split('\n')[0]) : 'gh not found');
    if (auth) {
      const ghV = run('gh', ['--version'], { allowFail: true });
      add('gh >= 2.40', ghV.ok && versionAtLeast(ghV.stdout, [2, 40]), ghV.stdout.trim().split('\n')[0] || ghV.stderr.trim());
    }
    if (auth?.ok && ['project', 'both'].includes(config.tracker.github.statusSync)) {
      const scopes = `${auth.stdout}${auth.stderr}`;
      add('gh token has "project" scope', /project/.test(scopes), 'run: gh auth refresh -s project');
    }
  }
  const remote = run('git', ['remote', 'get-url', config.git.remote], { cwd: root, allowFail: true });
  add(`remote "${config.git.remote}"`, remote.ok, remote.ok ? 'ok' : 'missing (PRs need a remote)');
  const base = run('git', ['rev-parse', '--verify', '--quiet', config.git.base], { cwd: root, allowFail: true });
  add(`base branch "${config.git.base}"`, base.ok, '');
  for (const j of listJobs(root).filter((x) => isActive(x) && x.port)) {
    if (j.worktree && !exists(j.worktree)) add(`job ${j.id} worktree`, false, `missing: ${j.worktree}`);
  }
  const unsupported = listJobs(root).filter((j) => j._unsupported);
  if (unsupported.length) add('job schema', false, `${unsupported.length} job(s) from a newer Forge`);
  checks.push(storageCheck(root));
  checks.push(dashboardCheck());
  if (initialized) checks.push(...(await notifyChecks(config)));
  // Last, and bounded: the only network call, and left out entirely when it cannot tell.
  const release = latestReleaseCheck();
  if (release) checks.push(release);
  // Warnings are ok: true, so they never fail the report.
  return { ok: checks.every((c) => c.ok), checks };
}
