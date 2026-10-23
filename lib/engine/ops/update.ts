// `forge update`: update the Forge install that is running, whether Claude Code installed it as a
// plugin or it is a git clone (npm link, --plugin-dir). It only ever moves the install to its own
// marketplace's or upstream's head, never runs a build, and refuses anything that could lose work.
import fs from 'node:fs';
import path from 'node:path';
import { git as runGit, gitEnv } from '#integrations/git/runner.ts';
import { mainRoot, paths, PLUGIN_ROOT } from '#core/paths.ts';
import { WINDOWS_UPDATE_REFUSAL } from '#core/os/platform.ts';
import { ForgeError } from '#core/errors.ts';
import { pidAlive, run } from '#core/os/process.ts';
import { readJson } from '#core/os/fs.ts';
import { tail } from '#core/text.ts';
import type { InstallInfo, UpdateCheck, UpdateDashboard, UpdateResult } from '#core/types.ts';

// No leading `-`: these names come from the install's path and become argv for `claude`.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const MANUAL = 'in Claude Code, run `/plugin marketplace update forge` then `/plugin update forge@forge`; in a git clone of Forge, run `git pull`';

export const DAEMON_REFUSAL = 'forge update replaces the code a daemon session runs on; a human runs it in their own session';

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Read fresh from disk each time: after an update the cached forgeVersion() is the old code's. */
function readVersion(dir: string): string {
  try {
    const v = readJson(path.join(dir, 'package.json'))?.version;
    return typeof v === 'string' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

function pluginName(root: string): string {
  try {
    const n = readJson(path.join(root, '.claude-plugin', 'plugin.json'))?.name;
    return typeof n === 'string' ? n : 'forge';
  } catch {
    return 'forge';
  }
}

/**
 * The plugin layout is `<config>/plugins/cache/<marketplace>/<plugin>/<version>` or
 * `<config>/plugins/marketplaces/<marketplace>`. The plugins dir comes from the root's own path
 * rather than CLAUDE_CONFIG_DIR, so it always describes the install that is running.
 */
function detectPlugin(root: string, version: string): InstallInfo | null {
  const segs = root.split(path.sep);
  for (let i = segs.length - 2; i >= 0; i--) {
    if (segs[i] !== 'plugins') continue;
    const pluginsDir = segs.slice(0, i + 1).join(path.sep) || path.sep;
    let marketplace: string;
    let name: string;
    if (segs[i + 1] === 'cache' && i + 4 < segs.length && isFile(path.join(pluginsDir, 'installed_plugins.json'))) {
      marketplace = segs[i + 2];
      name = segs[i + 3];
    } else if (segs[i + 1] === 'marketplaces' && i + 2 < segs.length && isFile(path.join(pluginsDir, 'known_marketplaces.json'))) {
      marketplace = segs[i + 2];
      name = pluginName(root);
    } else continue;
    if (!SAFE_NAME.test(marketplace) || !SAFE_NAME.test(name)) {
      return { kind: 'unknown', root, version, reason: `the plugin names in ${root} (${JSON.stringify(`${name}@${marketplace}`)}) are not safe to pass to claude` };
    }
    return { kind: 'plugin', root, version, plugin: `${name}@${marketplace}`, marketplace, pluginsDir };
  }
  return null;
}

/**
 * Plugin detection runs first: Claude Code's cache dirs can contain a `.git`, and a git pull
 * there would fork the install from what Claude Code tracks.
 */
export function detectInstall(root: string, env: NodeJS.ProcessEnv = process.env): InstallInfo {
  const real = realpath(root);
  const version = readVersion(real);
  const plugin = detectPlugin(real, version);
  if (plugin) return plugin;
  const top = runGit(undefined, ['-C', real, 'rev-parse', '--show-toplevel'], { env: gitEnv(env), allowFail: true });
  if (top.ok && realpath(top.stdout.trim()) === real) return { kind: 'git', root: real, version };
  return { kind: 'unknown', root: real, version };
}

function unknownMessage(info: InstallInfo): string {
  const why = info.reason ?? `cannot tell how Forge at ${info.root} was installed`;
  return `${why}; update it by hand: ${MANUAL}`;
}

interface GitState {
  branch?: string;
  upstream?: string;
  blocked?: string;
}

/** Read-only: `--no-optional-locks` keeps even `git status` from refreshing the index. */
function gitState(root: string, env: NodeJS.ProcessEnv): GitState {
  const git = (...args: string[]) => runGit(undefined, ['--no-optional-locks', '-C', root, ...args], { env: gitEnv(env), allowFail: true });
  const status = git('status', '--porcelain');
  if (!status.ok) return { blocked: `git status failed in ${root}: ${tail(status.stderr, 5)}` };
  if (status.stdout.trim()) return { blocked: `uncommitted changes in ${root}; commit or stash them, then run forge update again` };
  const branch = git('symbolic-ref', '-q', '--short', 'HEAD');
  if (!branch.ok) return { blocked: `HEAD is detached in ${root}; check out a branch that tracks an upstream, then run forge update again` };
  const name = branch.stdout.trim();
  const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  if (!upstream.ok) return { branch: name, blocked: `branch ${name} in ${root} has no upstream; set one with git branch --set-upstream-to, then run forge update again` };
  return { branch: name, upstream: upstream.stdout.trim() };
}

function headSha(root: string, env: NodeJS.ProcessEnv): string {
  return runGit(undefined, ['-C', root, 'rev-parse', '--short', 'HEAD'], { env: gitEnv(env), allowFail: true }).stdout.trim();
}

function planCommands(info: InstallInfo): string[] {
  if (info.kind === 'plugin') return [`claude plugin marketplace update ${info.marketplace}`, `claude plugin update ${info.plugin}`];
  if (info.kind === 'git') return [`git -C ${info.root} pull --ff-only`];
  return [];
}

/** Runs one update step; the first that fails stops the update with its output's tail. */
function step(display: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, info: InstallInfo): void {
  const r = run(cmd, args, { env, allowFail: true });
  // run() reports a spawn error (ENOENT) as status null with the error in stderr; a signal also
  // leaves status null but no such message.
  if (r.status === null && /ENOENT/.test(r.stderr)) {
    if (cmd === 'claude') {
      throw new ForgeError(`claude is not on PATH; in Claude Code, run \`/plugin marketplace update ${info.marketplace}\` then \`/plugin update ${info.plugin}\``, 'external');
    }
    throw new ForgeError(`"${display}" could not start: ${r.stderr.trim()}`, 'external');
  }
  if (!r.ok) throw new ForgeError(`"${display}" failed (exit ${r.status ?? 'by signal'}): ${tail(r.stderr.trim() || r.stdout, 20)}`, 'external');
}

/** Where Claude Code put the plugin after `claude plugin update`: the user-scope entry wins. */
function pluginRootAfter(info: InstallInfo): string {
  let entries: unknown;
  try {
    entries = readJson(path.join(info.pluginsDir!, 'installed_plugins.json'))?.plugins?.[info.plugin!];
  } catch {
    return info.root;
  }
  if (!Array.isArray(entries) || !entries.length) return info.root;
  const entry = entries.find((e) => e?.scope === 'user') ?? entries[0];
  const p = entry?.installPath;
  if (typeof p !== 'string' || !path.isAbsolute(p) || !isDir(p)) return info.root;
  return realpath(p);
}

/** The dashboard of the repo cwd is in, when one is running. */
function runningDashboard(cwd: string): { repo: string; url: string } | null {
  let repo: string;
  try {
    repo = mainRoot(cwd);
  } catch {
    return null;
  }
  let rt: any;
  try {
    rt = readJson(path.join(paths(repo).runtime, 'dashboard.json'), null);
  } catch {
    return null;
  }
  if (!pidAlive(rt?.pid)) return null;
  return { repo, url: typeof rt.url === 'string' ? rt.url : '' };
}

/**
 * A global npm copy earlier on PATH wins over this install for every bare `forge`, and Node
 * refuses to strip types under node_modules, so that copy cannot even start.
 */
function shadowWarning(env: NodeJS.ProcessEnv): string | null {
  if (process.platform === 'win32') return null;
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'forge');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    if (!realpath(candidate).split(path.sep).includes('node_modules')) return null;
    return `${candidate} shadows this install on PATH and cannot run (Node does not strip types under node_modules); remove it: npm uninstall -g @maxwellmattryan/forge`;
  }
  return null;
}

const RESTART_CMD = 'forge dash --stop && forge dash --background';

/** Spawns the new install's bin: `forge dash` restarts from its own PLUGIN_ROOT, which here is the old code. */
function restartDashboard(newRoot: string, repo: string, url: string, env: NodeJS.ProcessEnv): { dashboard: UpdateDashboard; warning?: string } {
  const bin = path.join(newRoot, 'bin', 'forge');
  for (const flag of ['--stop', '--background']) {
    const r = run(process.execPath, [bin, 'dash', flag], { cwd: repo, env, allowFail: true });
    if (!r.ok) {
      return {
        dashboard: { running: true, stale: true, url },
        warning:
          `restarting the dashboard failed at "forge dash ${flag}" (exit ${r.status ?? 'by signal'})` +
          (flag === '--background' ? ' after it was stopped; start it with `forge dash --background`' : '') +
          `: ${tail(r.stderr.trim() || r.stdout, 20)}`,
      };
    }
    if (flag === '--background') {
      try {
        const started = JSON.parse(r.stdout);
        if (typeof started?.url === 'string') return { dashboard: { restarted: true, url: started.url } };
      } catch {}
    }
  }
  return { dashboard: { restarted: true } };
}

export interface UpdateOptions {
  root?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  check?: boolean;
  keepDash?: boolean;
  /** The host platform; native Windows is refused (docs/SUPPORT.md). */
  platform?: NodeJS.Platform;
}

export async function updateForge(opts: UpdateOptions = {}): Promise<UpdateCheck | UpdateResult> {
  const env = opts.env ?? process.env;
  // Before detection or any subprocess: an unattended session must not swap the code it and the
  // dash run on for whatever the marketplace or upstream holds right now.
  if (env.FORGE_DAEMON === '1') throw new ForgeError(DAEMON_REFUSAL);
  // Also before detection or any subprocess: docs/SUPPORT.md refuses updates on native Windows.
  if ((opts.platform ?? process.platform) === 'win32') throw new ForgeError(WINDOWS_UPDATE_REFUSAL);
  const cwd = opts.cwd ?? process.cwd();
  const info = detectInstall(opts.root ?? PLUGIN_ROOT, env);
  const warnings: string[] = [];
  const shadow = shadowWarning(env);
  if (shadow) warnings.push(shadow);
  const dash = runningDashboard(cwd);
  const git = info.kind === 'git' ? gitState(info.root, env) : {};
  const commands = planCommands(info);

  if (opts.check) {
    const blocked = info.kind === 'unknown' ? unknownMessage(info) : git.blocked;
    return {
      kind: info.kind,
      root: info.root,
      version: info.version,
      ...(info.plugin ? { plugin: info.plugin } : {}),
      ...(git.branch ? { branch: git.branch } : {}),
      ...(git.upstream ? { upstream: git.upstream } : {}),
      commands,
      ...(blocked ? { blocked } : {}),
      ...(dash ? { dashboard: { running: true as const, url: dash.url } } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  if (info.kind === 'unknown') throw new ForgeError(unknownMessage(info));
  if (git.blocked) throw new ForgeError(git.blocked);

  const from = info.version;
  let newRoot = info.root;
  let head: { from: string; to: string } | undefined;
  if (info.kind === 'plugin') {
    step(commands[0], 'claude', ['plugin', 'marketplace', 'update', info.marketplace!], env, info);
    step(commands[1], 'claude', ['plugin', 'update', info.plugin!], env, info);
    newRoot = pluginRootAfter(info);
  } else {
    const before = headSha(info.root, env);
    // --ff-only on the command line overrides pull.rebase / pull.ff from the user's config.
    step(commands[0], 'git', ['-C', info.root, 'pull', '--ff-only'], env, info);
    head = { from: before, to: headSha(info.root, env) };
  }
  const to = readVersion(newRoot);
  const updated = head ? head.from !== head.to : from !== to;

  const next: string[] = [];
  let dashboard: UpdateDashboard | undefined;
  if (dash && updated) {
    if (opts.keepDash) dashboard = { running: true, stale: true, url: dash.url };
    else {
      const r = restartDashboard(newRoot, dash.repo, dash.url, env);
      dashboard = r.dashboard;
      if (r.warning) warnings.push(r.warning);
    }
  }
  if (updated) {
    if (info.kind === 'plugin') next.push('Start a new Claude Code session to load the updated /forge skill, agents and hooks.');
    next.push(`Dashboards running in other repos still serve the old version: run \`${RESTART_CMD}\` there.`);
    next.push('Optionally run `forge migrate` in each repo to rewrite older config and job files (Forge reads them as they are).');
    if (dashboard && 'stale' in dashboard) next.push(`This repo's dashboard still serves the old version: run \`${RESTART_CMD}\` in ${dash!.repo}.`);
  }
  return {
    kind: info.kind,
    root: info.root,
    from,
    to,
    updated,
    ...(newRoot !== info.root ? { newRoot } : {}),
    ...(head ? { head } : {}),
    commands,
    ...(dashboard ? { dashboard } : {}),
    ...(warnings.length ? { warnings } : {}),
    next,
  };
}
