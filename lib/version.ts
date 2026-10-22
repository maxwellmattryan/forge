// `forge version --json`: which Forge is running, down to the commit, so an install can be pinned,
// audited and rolled back (docs/RELEASES.md "Provenance and pinning").
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './core/paths.ts';
import { detectInstall } from './update.ts';
import { ghJson } from './gh.ts';
import { git, gitEnv } from './git.ts';
import { readJson } from './core/os/fs.ts';
import type { DoctorCheck, InstallInfo, InstalledAs, VersionInfo } from './core/types.ts';

/** At the plugin root; `git archive` stamps it through `.gitattributes` `export-subst`. */
const COMMIT_FILE = 'COMMIT';
export const SHA = /^[0-9a-f]{40}$/;

const COMMIT_MAX_BYTES = 64;

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The stamped sha, or null for anything else: the committed `$Format:%H$` placeholder, a
 * symlink, a FIFO, a directory or a file with more than one sha's worth of content.
 */
export function readCommitFile(root: string): string | null {
  const file = path.join(root, COMMIT_FILE);
  let fd: number | undefined;
  try {
    // O_NOFOLLOW refuses a symlink and O_NONBLOCK keeps a FIFO from hanging the open.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > COMMIT_MAX_BYTES) return null;
    const buf = Buffer.alloc(COMMIT_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /^([0-9a-f]{40})\n?$/.exec(buf.subarray(0, n).toString('latin1'));
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Claude Code's own record of the commit it installed. The file is undocumented Claude Code
 * state, so any shape surprise yields null rather than an error.
 */
function pluginCommit(info: InstallInfo): string | null {
  if (info.kind !== 'plugin' || !info.pluginsDir || !info.plugin) return null;
  try {
    const data = readJson(path.join(info.pluginsDir, 'installed_plugins.json'), {});
    const raw = data?.plugins?.[info.plugin];
    const entries: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const { installPath, gitCommitSha } = e as { installPath?: unknown; gitCommitSha?: unknown };
      if (typeof installPath !== 'string' || realpath(installPath) !== info.root) continue;
      return typeof gitCommitSha === 'string' && SHA.test(gitCommitSha) ? gitCommitSha : null;
    }
  } catch {
    // fall through: a malformed file says nothing about the commit
  }
  return null;
}

/** HEAD, only when the root is its own git toplevel, never a repo the install happens to sit in. */
function gitCommit(info: InstallInfo, env: NodeJS.ProcessEnv): string | null {
  if (info.kind !== 'git') {
    const top = git(undefined, ['-C', info.root, 'rev-parse', '--show-toplevel'], { env: gitEnv(env), allowFail: true });
    if (!top.ok || realpath(top.stdout.trim()) !== info.root) return null;
  }
  const head = git(undefined, ['-C', info.root, 'rev-parse', '--verify', '--quiet', 'HEAD'], { env: gitEnv(env), allowFail: true });
  const sha = head.stdout.trim();
  return head.ok && SHA.test(sha) ? sha : null;
}

const INSTALLED_AS: Record<InstallInfo['kind'], InstalledAs> = { plugin: 'plugin', git: 'clone', unknown: 'unknown' };

/** The first valid commit wins: a stamped COMMIT file, the plugin install record, then git. */
export function versionInfo(root: string = PLUGIN_ROOT, env: NodeJS.ProcessEnv = process.env): VersionInfo {
  const info = detectInstall(root, env);
  const commit = readCommitFile(info.root) ?? pluginCommit(info) ?? gitCommit(info, env);
  return { version: info.version, commit, installedAs: INSTALLED_AS[info.kind], node: process.versions.node };
}

// No leading `-` in either part: the value becomes argv for `gh`, and a leading dash would read as a flag.
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const GITHUB_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function githubSlug(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = GITHUB_URL.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The GitHub `owner/repo` this install's releases come from: the marketplace Claude Code installed
 * it from, else the install's own plugin.json. Both files are writable by anything that can write
 * `~/.claude` or the checkout, so a candidate that is not a plain slug is dropped, never passed on.
 */
export function releaseRepo(root: string, info: InstallInfo): string | null {
  let candidate: string | null = null;
  try {
    if (info.kind === 'plugin' && info.pluginsDir && info.marketplace) {
      const source = readJson(path.join(info.pluginsDir, 'known_marketplaces.json'), {})?.[info.marketplace]?.source;
      if (source?.source === 'github') candidate = typeof source.repo === 'string' ? source.repo : null;
    }
    if (candidate === null) {
      const plugin = readJson(path.join(root, '.claude-plugin', 'plugin.json'), {});
      const repository = typeof plugin?.repository === 'string' ? plugin.repository : plugin?.repository?.url;
      candidate = githubSlug(repository) ?? githubSlug(plugin?.homepage);
    }
  } catch {
    return null;
  }
  return candidate !== null && REPO_SLUG.test(candidate) ? candidate : null;
}

function semver(v: unknown): [number, number, number] | null {
  const m = typeof v === 'string' ? SEMVER.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * `forge doctor`'s release row: is a newer Forge out? Null, so the row is left out, whenever it
 * cannot tell: no repo, no `gh`, no login, offline, no release yet, a timeout or odd output.
 */
export function latestReleaseCheck(opts: { root?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): DoctorCheck | null {
  try {
    const env = opts.env ?? process.env;
    const info = detectInstall(opts.root ?? PLUGIN_ROOT, env);
    const running = semver(info.version);
    if (!running || info.version.startsWith('v')) return null;
    const repo = releaseRepo(info.root, info);
    if (!repo) return null;
    const tag = ghJson(undefined, ['release', 'view', '--repo', repo, '--json', 'tagName'], {
      allowFail: true,
      timeoutMs: opts.timeoutMs ?? 5000,
      env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    })?.tagName;
    const latest = semver(tag);
    if (!latest) return null;
    const v = info.version;
    const order = compare(running, latest);
    if (order < 0) return { name: 'forge release', ok: true, warn: true, detail: `${v} is behind the latest release ${tag}: run forge update` };
    if (order === 0) return { name: 'forge release', ok: true, detail: `${v} is the latest release` };
    return { name: 'forge release', ok: true, detail: `${v} is newer than the latest release ${tag}` };
  } catch {
    return null;
  }
}
