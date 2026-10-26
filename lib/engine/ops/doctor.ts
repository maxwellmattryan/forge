// `forge doctor` and GET /api/doctor: is this machine and repo ready for Forge?
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig, worktreeRoot } from '#core/config/load.ts';
import { dockerCheck } from '../environment/backing.ts';
import { billingOf } from '#integrations/claude/argv.ts';
import { deprecationChecks } from '#core/config/validators/deprecations.ts';
import { uncoveredInstructionProbes } from '#core/config/validators/instructions.ts';
import { policyRules } from '#core/config/validators/policy-check.ts';
import { memberRepoChecks, releaseChecks, repoProblems } from '../project/member-repos.ts';
import { defaultServiceOptions, serviceCheck, type ServiceOptions } from '../project/login-service.ts';
import { isActive, listJobs } from '#core/job/store.ts';
import { notifyChecks } from '#office/notify.ts';
import { paths, exists, BUILD_DASHBOARD, PLUGIN_ROOT } from '#core/paths.ts';
import { dirBytes } from './retention.ts';
import { secretAvailability } from '../guard/secret-refs.ts';
import { BUILD_LIKE, CREDENTIAL_CARRIERS, droppedVariables } from '../guard/command-env.ts';
import { COMMAND_PATH_ENV, COMMAND_PATH_SOURCE_ENV } from '../guard/command-path.ts';
import type { ResolveOptions } from '../guard/secret-refs.ts';
import { SUPPORT_URL, hostInfo, platformTier, posixShell, tierDetail, versionAtLeast } from '#core/os/platform.ts';
import type { HostInfo } from '#core/os/platform.ts';
import type { Config, DoctorCheck, DoctorReport } from '#core/types.ts';
import { gh } from '#integrations/github/gh.ts';
import { readBranchRules } from '#integrations/github/protection.ts';
import { repoSlug } from '#integrations/github/pull-requests.ts';
import type { BranchRules } from '#integrations/github/types.ts';
import { requiredChecksAdvice } from '../pr/required.ts';
import { git } from '#integrations/git/runner.ts';
import { hasBinary } from '#core/os/process.ts';
import { readText } from '#core/os/fs.ts';
import { latestReleaseCheck } from './version.ts';

/** package.json `engines`: Node 22.18 is the first with type stripping on by default. */
function nodeSupported(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}

/** Past this, one of .forge/jobs, .forge/archive or .forge/runtime is worth pruning: 500 MiB. */
const STORAGE_WARN_BYTES = 524_288_000;

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
 * The `secrets` check, only when some are declared: how many, and each source this process can see
 * is unavailable, as a warning (a command's environment may differ). Never reads a value: `op`,
 * `security` and `secret-tool` can prompt, so they are only looked up on PATH.
 */
export function secretsCheck(root: string, config: Config, opts: ResolveOptions = {}): DoctorCheck | null {
  const n = Object.keys(config.secrets ?? {}).length;
  if (!n) return null;
  const missing = secretAvailability(root, config, opts);
  return { name: 'secrets', ok: true, detail: `${n} declared${missing.length ? `; ${missing.join('; ')}` : ''}`, ...(missing.length ? { warn: true } : {}) };
}

/**
 * One path segment as copyUntracked's glob (globFiles in lib/engine/workspace/worktree.ts) reads it:
 * `*` and `?` never cross a `/`. Duplicated rather than imported, which would load the whole worktree module.
 */
function segmentGlob(segment: string): RegExp {
  return new RegExp('^' + segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
}

/**
 * The `worktrees.copy` warning, when an entry can copy a `.env*` file into every worktree: its last
 * path segment (trailing `/` removed) starts with `.env`, or is a glob that matches `.env`. Null
 * when no entry can.
 */
export function envCopyCheck(config: Pick<Config, 'worktrees'>): DoctorCheck | null {
  const entries: unknown[] = Array.isArray(config?.worktrees?.copy) ? config.worktrees.copy : [];
  const hits = entries.filter((e): e is string => {
    if (typeof e !== 'string') return false;
    const last = e.replace(/\/+$/, '').split('/').at(-1) ?? '';
    return last.startsWith('.env') || (/[*?]/.test(last) && segmentGlob(last).test('.env'));
  });
  if (!hits.length) return null;
  return {
    name: 'worktrees.copy',
    ok: true,
    warn: true,
    detail: `${hits.join(', ')} can copy .env files into every worktree, where every configured command reads them; declare the values under secrets and pass them through a config sink instead`,
  };
}

/**
 * The `daemon billing` check: the API keys, provider switches and ANTHROPIC_BASE_URL set where doctor runs,
 * which daemon sessions inherit from `forge dash`. Always ok; a warning when a provider switch or base URL
 * is set, since each sends sessions to another account or endpoint. Null with the daemon off or none set.
 */
export function daemonBillingCheck(config: Pick<Config, 'daemon'>, env: NodeJS.ProcessEnv = process.env): DoctorCheck | null {
  if (config?.daemon?.enabled !== true) return null;
  const auth = config.daemon.auth ?? 'subscription';
  const billing = billingOf(env, auth);
  if (!billing) return null;
  const vars = billing.vars.join(', ');
  const detail = billing.passed
    ? `${vars} set: sessions bill that account or go through that endpoint (daemon.auth: api-key)`
    : `${vars} set but ignored: sessions use your Claude login (daemon.auth: subscription)`;
  return billing.warn ? { name: 'daemon billing', ok: true, warn: true, detail } : { name: 'daemon billing', ok: true, detail };
}

/**
 * The `protected instruction files` hint: a configured policy written before the default gained the
 * instruction-file rule leaves some probe unmatched, and no re-init rewrites it. Null when every
 * probe is covered, and for `[]`: an empty policy was turned off deliberately.
 */
export function instructionsPolicyCheck(config: Config): DoctorCheck | null {
  const rules = policyRules(config);
  if (!rules.length) return null;
  const uncovered = uncoveredInstructionProbes(rules);
  if (!uncovered.length) return null;
  return {
    name: 'protected instruction files',
    ok: true,
    warn: true,
    detail: `policy.protectedPaths does not cover ${uncovered.join(', ')}: add an escalate rule for **/AGENTS.md, **/CLAUDE.md, **/CLAUDE.local.md, .claude, **/.claude/** and .mcp.json by hand (docs/CONFIG.md "Protected paths")`,
  };
}

/**
 * The `dashboard built` check: a plugin checkout off `main` (develop, a clone) has no dashboard/dist/
 * until it is built. Always ok, so a source checkout never fails doctor; a warning until it is built.
 */
export function dashboardCheck(distDir: string = path.join(PLUGIN_ROOT, 'dashboard', 'dist')): DoctorCheck {
  if (exists(path.join(distDir, 'manifest.json'))) return { name: 'dashboard built', ok: true, detail: 'ok' };
  return { name: 'dashboard built', ok: true, warn: true, detail: `not built: run ${BUILD_DASHBOARD}` };
}

/** A capture that ran and failed; `inherited: win32` is by design. */
const FAILED_CAPTURE = /^inherited: (timed out|exited|no PATH)/;

/**
 * The `command PATH` check: where configured commands' PATH comes from (the login shell `forge dash`
 * captured, or this process's own) and the empty or relative entries sanitising drops from it.
 * Always ok; a warning for a failed capture or a dropped entry.
 */
export function commandPathCheck(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DoctorCheck {
  const get = (name: string) => (platform === 'win32' ? Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1] : env[name]);
  const source = get(COMMAND_PATH_SOURCE_ENV) || "this process's PATH";
  const value = get(COMMAND_PATH_ENV) ?? get('PATH') ?? '';
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dropped = [...new Set(value.split(p.delimiter).filter((e) => !e || !p.isAbsolute(e)))].map((e) => (e ? e : '(empty)'));
  const failed = FAILED_CAPTURE.test(source);
  const notes = [...(failed ? ['start forge dash from a terminal whose login shell sets PATH quickly'] : []), ...(dropped.length ? [`dropped relative or empty entries: ${dropped.join(', ')}`] : [])];
  return { name: 'command PATH', ok: true, detail: [source, ...notes].join('; '), ...(failed || dropped.length ? { warn: true } : {}) };
}

export interface DoctorOptions {
  /**
   * For a support bundle, which goes to public issues: the `command environment` check names only
   * BUILD_LIKE's fixed names and counts the other `*_HOME`/`*_ROOT` ones, which can say what a machine
   * has (the bundle's config.json hides commandEnv.inherit for the same reason).
   */
  bundle?: boolean;
  /** The machine the `service` row reads: defaultServiceOptions() when absent; a test passes a temp home and a fake runner. */
  service?: ServiceOptions;
}

const CARRIER_ADVICE = 'can carry credentials: inherit such a name only if a command needs it, or declare a secret with a config sink';

/** `names` joined; for a bundle, the ones BUILD_LIKE does not name are counted instead. */
function listedNames(names: string[], bundle: boolean): string {
  if (!bundle) return names.join(', ');
  const known = names.filter((n) => BUILD_LIKE.has(n.toUpperCase()));
  const others = names.length - known.length;
  if (!others) return known.join(', ');
  return [...known, `${others} ${known.length ? 'more ' : ''}*_HOME or *_ROOT ${others === 1 ? 'name' : 'names'}`].join(', ');
}

/**
 * The `command environment` check: the variables this environment exports that configured commands
 * do not get and that look like build settings (names only, sorted), as a warning pointing at
 * commandEnv.inherit, with the ones that carry credentials (CREDENTIAL_CARRIERS) in a clause of their
 * own that says so. Ok with no warning when there are none.
 */
export function commandEnvCheck(config: Config, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, opts: DoctorOptions = {}): DoctorCheck {
  const dropped = droppedVariables(config, env, platform);
  const docs = '(docs/CONFIG.md "Command environment")';
  if (!dropped.length) return { name: 'command environment', ok: true, detail: `configured commands get the allowlist ${docs}` };
  const carries = (name: string) => CREDENTIAL_CARRIERS.has(name.toUpperCase());
  const build = dropped.filter((n) => !carries(n));
  const carriers = dropped.filter(carries);
  const clauses: string[] = [];
  if (build.length) clauses.push(`configured commands do not get ${listedNames(build, opts.bundle === true)}; add the names they need to commandEnv.inherit`);
  if (carriers.length) clauses.push(`${build.length ? 'nor' : 'configured commands do not get'} ${carriers.join(', ')}, which ${CARRIER_ADVICE}`);
  return { name: 'command environment', ok: true, warn: true, detail: `${clauses.join('; ')} ${docs}` };
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

/**
 * The `merge required checks` row: a warning when `base` merges on whatever CI has reported, with
 * the command that turns on protection (requiredChecksAdvice). `rules` null: merge.requiredChecks is set, so not read.
 */
export function requiredChecksCheck(config: Config, base: string, rules: BranchRules | null): DoctorCheck {
  const { warn, detail } = requiredChecksAdvice(config, base, rules);
  return { name: 'merge required checks', ok: true, ...(warn ? { warn: true } : {}), detail };
}

export async function doctor(root: string, config: Config, initialized: boolean, host: HostInfo = hostInfo(), opts: DoctorOptions = {}): Promise<DoctorReport> {
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
  checks.push(commandPathCheck(process.env, host.platform));
  const gitV = git(undefined, ['--version'], { allowFail: true });
  add('git >= 2.38', gitV.ok && versionAtLeast(gitV.stdout, [2, 38]), gitV.ok ? gitV.stdout.trim() : 'git not found');
  const sparse = git(undefined, ['sparse-checkout', '-h'], { allowFail: true });
  add('git sparse-checkout (evals)', sparse.status === 129 || sparse.ok, '');
  add('config present', initialized, initialized ? path.relative(root, paths(root).config) : 'run /forge init');
  let configValid = false;
  if (initialized) {
    const problems = validateConfig(config, root);
    configValid = !problems.length;
    add('config valid', !problems.length, problems.join('; '));
    checks.push(...deprecationChecks(readText(paths(root).config)));
    // A bad repos list is already a failing config check; member checks would only guess at it.
    if (!repoProblems(config, root).length) checks.push(...memberRepoChecks(root, config));
    checks.push(...releaseChecks(root, config));
    // Only with a valid config that has a per-job or shared entry; otherwise Docker is never called.
    const docker = problems.length ? null : dockerCheck(config);
    if (docker) checks.push(docker);
    const secrets = secretsCheck(root, config);
    if (secrets) checks.push(secrets);
    const envCopy = envCopyCheck(config);
    if (envCopy) checks.push(envCopy);
    // Only with a valid config: an invalid policy is already the failing config check.
    const instructions = problems.length ? null : instructionsPolicyCheck(config);
    if (instructions) checks.push(instructions);
    if (!problems.length) checks.push(commandEnvCheck(config, process.env, host.platform, opts));
  }
  const billing = initialized && config.daemon.enabled ? daemonBillingCheck(config) : null;
  if (billing) checks.push(billing);
  const needsGh = config.pr.enabled || config.tracker.kind === 'github';
  if (needsGh) {
    const auth = hasBinary('gh') ? gh(undefined, ['auth', 'status'], { allowFail: true }) : null;
    add('gh installed + authenticated', Boolean(auth?.ok), auth ? (auth.ok ? 'ok' : (auth.stderr || auth.stdout).trim().split('\n')[0]) : 'gh not found');
    if (auth) {
      const ghV = gh(undefined, ['--version'], { allowFail: true });
      add('gh >= 2.40', ghV.ok && versionAtLeast(ghV.stdout, [2, 40]), ghV.stdout.trim().split('\n')[0] || ghV.stderr.trim());
    }
    if (auth?.ok && ['project', 'both'].includes(config.tracker.github.statusSync)) {
      const scopes = `${auth.stdout}${auth.stderr}`;
      add('gh token has "project" scope', /project/.test(scopes), 'run: gh auth refresh -s project');
    }
    if (auth?.ok && config.pr.enabled && configValid) {
      let slug: string | null = null;
      try {
        slug = repoSlug(root, config);
      } catch {
        // No repository to read protection from: the row is left out.
      }
      if (slug !== null) checks.push(requiredChecksCheck(config, config.git.base, config.merge.requiredChecks.length ? null : readBranchRules(gh, root, slug, config.git.base)));
    }
  }
  const remote = git(root, ['remote', 'get-url', config.git.remote], { allowFail: true });
  add(`remote "${config.git.remote}"`, remote.ok, remote.ok ? 'ok' : 'missing (PRs need a remote)');
  const base = git(root, ['rev-parse', '--verify', '--quiet', config.git.base], { allowFail: true });
  add(`base branch "${config.git.base}"`, base.ok, '');
  for (const j of listJobs(root).filter((x) => isActive(x) && x.port)) {
    if (j.worktree && !exists(j.worktree)) add(`job ${j.id} worktree`, false, `missing: ${j.worktree}`);
  }
  const unsupported = listJobs(root).filter((j) => j._unsupported);
  if (unsupported.length) add('job schema', false, `${unsupported.length} job(s) from a newer Forge`);
  checks.push(storageCheck(root));
  checks.push(dashboardCheck());
  // One row for the machine, whatever the number of projects: it runs only read-only manager calls, and only with a unit installed.
  checks.push(serviceCheck(opts.service ?? defaultServiceOptions(), { bundle: opts.bundle === true }));
  if (initialized) checks.push(...(await notifyChecks(config)));
  // Last, and bounded: the only network call, and left out entirely when it cannot tell.
  const release = latestReleaseCheck();
  if (release) checks.push(release);
  // Warnings are ok: true, so they never fail the report.
  return { ok: checks.every((c) => c.ok), checks };
}
