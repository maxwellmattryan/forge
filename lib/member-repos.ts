// Member repos: the other repos a project spans (`config.repos`), and where each is cloned on this
// machine (`.forge/local.yml`, gitignored). Doctor only reads them: it never clones, fetches, checks
// out or writes in a member clone, and the fix it prints is for the human to run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERIM_STRATEGIES, isInterimStrategy } from './components.ts';
import { paths, resolveFrom } from './paths.ts';
import { releaseMechanismCheck, strategyProblems } from './release-strategy.ts';
import { SEG, githubHost, slugFromRemote } from './repo-slug.ts';
import type { Config, DoctorCheck } from './types.ts';
import { SAFE_REF, readText, run, safeText } from './util.ts';
import * as yaml from './yaml.ts';

export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REMOTE_MAX = 2000;
// A local.yml is a few lines; anything this big is a mistake, and reading it all would stall doctor.
const LOCAL_MAX_BYTES = 256 * 1024;

const isMap = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown): string => (v === undefined ? 'nothing' : (JSON.stringify(v) ?? String(v)).slice(0, 120));

/** A branch name git accepts and that cannot read as an option or a range. */
export function isSafeBranch(b: unknown): b is string {
  return typeof b === 'string' && SAFE_REF.test(b) && !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.lock');
}

/** A git remote Forge may pass to git or write into a manifest: no leading -, whitespace or control characters. */
export const isSafeRemote = (r: unknown): r is string =>
  typeof r === 'string' && r.trim() !== '' && r.length <= REMOTE_MAX && !r.startsWith('-') && !/[\s\u0000-\u001f\u007f-\u009f]/.test(r);

const isGithubSlug = (s: unknown): boolean => {
  if (typeof s !== 'string') return false;
  const parts = s.split('/');
  return parts.length === 2 && parts.every((p) => SEG.test(p) && !p.includes('..'));
};

/**
 * A `release` map: `interim` one of the strategies, and the release strategy keys
 * (lib/release-strategy.ts). The root's (top-level) is always a map once defaults fill it; a
 * member's may be absent, null, or a map without interim.
 */
export function releaseProblems(r: unknown, at: string, optional = false): string[] {
  if (optional && (r === undefined || r === null)) return [];
  if (!isMap(r)) return [`${at} must be a map with interim ${INTERIM_STRATEGIES.join(' | ')} (got ${show(r)})`];
  const problems: string[] = [];
  if (!(optional && r.interim === undefined) && !isInterimStrategy(r.interim)) problems.push(`${at}.interim must be one of ${INTERIM_STRATEGIES.join(' | ')} (got ${show(r.interim)})`);
  return [...problems, ...strategyProblems(r, at)];
}

/** `downstream`: a map with enabled (boolean), max (integer 0–50) and skip (names of `repos` entries). */
export function downstreamProblems(c: any): string[] {
  const d = c?.downstream;
  if (!isMap(d)) return [`downstream must be a map (got ${show(d)})`];
  const problems: string[] = [];
  if (typeof d.enabled !== 'boolean') problems.push(`downstream.enabled must be true or false (got ${show(d.enabled)})`);
  if (!Number.isInteger(d.max) || d.max < 0 || d.max > 50) problems.push(`downstream.max must be an integer from 0 to 50 (got ${show(d.max)})`);
  if (!Array.isArray(d.skip) || d.skip.some((x: unknown) => typeof x !== 'string')) problems.push(`downstream.skip must be a list of repos names (got ${show(d.skip)})`);
  else {
    const names = new Set((Array.isArray(c.repos) ? c.repos : []).map((r: any) => (isMap(r) ? r.name : undefined)));
    for (const x of d.skip) if (!names.has(x)) problems.push(`downstream.skip names unknown repo ${JSON.stringify(x).slice(0, 110)}`);
  }
  return problems;
}

/** Every problem with `repos` and with a component's `repo` naming one, in the form validateConfig reports. */
export function repoProblems(c: any, root: string): string[] {
  const problems: string[] = [];
  const list = c?.repos;
  const names = new Set<string>();
  if (list !== undefined && !Array.isArray(list)) problems.push(`repos must be a list (got ${show(list)})`);
  else if (Array.isArray(list)) {
    const rootName = path.basename(root);
    const seen = new Set<string>();
    list.forEach((e: unknown, i: number) => {
      if (!isMap(e)) return problems.push(`repos[${i}] must be a map`);
      const named = typeof e.name === 'string' && REPO_NAME.test(e.name);
      if (!named) problems.push(`repos[${i}].name must start with a letter or digit and use only A-Z a-z 0-9 . _ - (at most 100 characters; got ${show(e.name)})`);
      const at = named ? `repos "${e.name}"` : `repos[${i}]`;
      if (named) {
        if (seen.has(e.name)) problems.push(`repos "${e.name}" is listed more than once`);
        else if (e.name === rootName) problems.push(`repos "${e.name}" is the root repo; the root repo is implicit`);
        seen.add(e.name);
        names.add(e.name);
      }
      if (!isSafeRemote(e.remote))
        problems.push(`${at}.remote must be a git url of at most ${REMOTE_MAX} characters, not starting with - and without whitespace or control characters (got ${show(e.remote)})`);
      if (!isSafeBranch(e.defaultBranch))
        problems.push(`${at}.defaultBranch must be a branch name using only A-Z a-z 0-9 . _ / -, without .. or //, not ending in / or .lock (got ${show(e.defaultBranch)})`);
      problems.push(...releaseProblems(e.release, `${at}.release`, true));
      const t = e.tracker;
      if (t === undefined || t === null) return;
      if (!isMap(t) || !['github', 'none'].includes(t.kind)) problems.push(`${at}.tracker must be a map with kind github | none (got ${show(t)})`);
      else if (t.kind === 'github' && t.repo !== undefined && t.repo !== null && !isGithubSlug(t.repo))
        problems.push(`${at}.tracker.repo must be owner/name (got ${show(t.repo)})`);
    });
  }
  // A list that is not a list is already reported; naming every component's repo unknown would bury it.
  if (list !== undefined && !Array.isArray(list)) return problems;
  if (!Array.isArray(c?.components)) return problems;
  c.components.forEach((e: unknown, i: number) => {
    if (!isMap(e) || typeof e.repo !== 'string' || names.has(e.repo)) return;
    const at = typeof e.name === 'string' && SAFE_REF.test(e.name) ? `components "${e.name}"` : `components[${i}]`;
    problems.push(`${at}.repo names unknown repo ${JSON.stringify(e.repo)}`);
  });
  return problems;
}

export interface LocalConfig {
  /** Whether `.forge/local.yml` exists. */
  present: boolean;
  /** Member name to clone path, as written; empty when the file has any problem. */
  repos: Record<string, { path: string }>;
  problems: string[];
}

/** `.forge/local.yml`, read without ever throwing: a problem empties `repos` so every member reads as missing. */
export function readLocalConfig(root: string): LocalConfig {
  const file = paths(root).local;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { present: false, repos: {}, problems: [] };
  }
  const bad = (problem: string): LocalConfig => ({ present: true, repos: {}, problems: [problem] });
  // statSync follows a symlink; a FIFO or device there would block or stream forever.
  if (!st.isFile()) return bad('local.yml is not a regular file');
  if (st.size > LOCAL_MAX_BYTES) return bad(`local.yml is larger than ${LOCAL_MAX_BYTES} bytes`);
  let doc: any;
  try {
    doc = yaml.parse(readText(file));
  } catch (e) {
    return bad(`local.yml is not valid YAML: ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return { present: true, repos: {}, problems: [] };
  if (!isMap(doc)) return bad('local.yml must be a map with a repos: map');
  if (doc.repos === undefined || doc.repos === null) return { present: true, repos: {}, problems: [] };
  if (!isMap(doc.repos)) return bad(`local.yml repos must be a map of member names to { path } (got ${show(doc.repos)})`);
  const problems: string[] = [];
  // Null prototype: member names like `constructor` or `__proto__` are valid and must not hit Object.prototype.
  const repos: Record<string, { path: string }> = Object.create(null);
  for (const [name, v] of Object.entries(doc.repos)) {
    if (isMap(v) && typeof v.path === 'string' && v.path.trim() && !v.path.includes('\0')) repos[name] = { path: v.path };
    else problems.push(`local.yml repos ${JSON.stringify(name)} needs a non-empty string path (got ${show(v)})`);
  }
  return problems.length ? { present: true, repos: {}, problems } : { present: true, repos, problems };
}

/** A local.yml path on this machine: `~/` is the home directory, a relative path is from the root repo. */
export function resolveMemberPath(root: string, p: string): string {
  const home = p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  return resolveFrom(root, home);
}

/** `u` without the userinfo of a `scheme://user:pass@host` url: it may carry a password or token. */
export const stripUserinfo = (u: string): string => u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
const plainUrl = (u: string): string => stripUserinfo(u.trim()).replace(/\/$/, '').replace(/\.git$/, '');

/** Whether two remote urls name the same repo: equal up to a trailing `/` or `.git`, or the same GitHub `owner/name`. */
export function remotesMatch(a: string, b: string): boolean {
  if (plainUrl(a) === plainUrl(b)) return true;
  const host = githubHost();
  const sa = slugFromRemote(a, host);
  const sb = slugFromRemote(b, host);
  return sa !== null && sb !== null && sa.toLowerCase() === sb.toLowerCase();
}

/** `s` as one shell word: as is when every character is safe, else single-quoted. */
export function shellWord(s: string, safe = /^[A-Za-z0-9._/~-]+$/): string {
  return safe.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
const quotePath = (p: string): string => shellWord(p);
// Remotes are printed, never run; quoting only the odd ones keeps the usual scp and https forms copyable as is.
const quoteRemote = (r: string): string => shellWord(r, /^[A-Za-z0-9._/~:@+=%-]+$/);

/**
 * The env for git in a member clone: inherited location variables would point the call at another
 * repo, and optional locks off keeps `status` from refreshing (writing) the clone's index.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

// git prints the top level as a forward-slash long path on Windows (C:/Users/runneradmin/…) while the
// clone path may use 8.3 short names (C:\Users\RUNNER~1\…): realpathSync.native expands those, and
// Windows paths compare case-insensitively.
export function sameDir(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  let ra: string;
  let rb: string;
  try {
    ra = fs.realpathSync.native(path.resolve(a));
    rb = fs.realpathSync.native(path.resolve(b));
  } catch {
    return false;
  }
  return platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Doctor's check of one member clone: its local.yml path, that it is a clone, and its remote. */
export function memberCheck(root: string, config: Config, repo: Config['repos'][number], local: LocalConfig): DoctorCheck {
  const name = `repo ${repo.name}`;
  const remote = quoteRemote(repo.remote);
  const gitRemote = config.git?.remote || 'origin';
  const entry = Object.hasOwn(local.repos, repo.name) ? local.repos[repo.name] : undefined;
  if (!entry) {
    const rel = `../${repo.name}`;
    return { name, ok: false, detail: `no path in .forge/local.yml; clone it: git clone ${remote} ${rel}, then add to .forge/local.yml: repos: { ${repo.name}: { path: ${rel} } }` };
  }
  const dir = resolveMemberPath(root, entry.path);
  const qp = quotePath(dir);
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return { name, ok: false, detail: `missing clone at ${qp}; run: git clone ${remote} ${qp}` };
  }
  const notClone: DoctorCheck = { name, ok: false, detail: `${qp} is not a git clone; point .forge/local.yml at the clone's top-level directory` };
  if (!st.isDirectory()) return notClone;
  const env = gitEnv();
  const git = (args: string[]) => run('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: dir, allowFail: true, timeoutMs: 5000, env });
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top.ok) return notClone;
  if (!sameDir(top.stdout.trim(), dir)) return notClone;
  const url = git(['remote', 'get-url', '--', gitRemote]);
  const actual = url.ok ? url.stdout.trim() : '';
  if (!actual || !remotesMatch(actual, repo.remote)) {
    const fix = actual ? `remote set-url ${gitRemote} ${remote}` : `remote add ${gitRemote} ${remote}`;
    return { name, ok: false, detail: `remote "${gitRemote}" is ${actual ? quoteRemote(safeText(stripUserinfo(actual), 300)) : 'missing'}, expected ${remote}; run: git -C ${qp} ${fix}` };
  }
  // defaultBranch is validated (isSafeBranch) and only ever passed inside a full ref name.
  if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${repo.defaultBranch}`]).ok)
    return { name, ok: true, warn: true, detail: `no local branch ${repo.defaultBranch}; run: git -C ${qp} fetch ${gitRemote} ${repo.defaultBranch}:${repo.defaultBranch}` };
  const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.ok ? head.stdout.trim() : 'detached';
  if (head.ok && branch === repo.defaultBranch) {
    const status = git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);
    const n = status.ok ? status.stdout.split('\n').filter((l) => l.trim()).length : 0;
    if (n) return { name, ok: true, warn: true, detail: `${repo.defaultBranch} has uncommitted changes (${n} paths) at ${qp}` };
  }
  return { name, ok: true, detail: `${qp} on ${branch}` };
}

/**
 * Doctor's member repo checks: a `local.yml` check when that file has a problem or names unknown
 * members, then one `repo <name>` per `repos` entry in config order. Call only when `repos` validates.
 */
export function memberRepoChecks(root: string, config: Config): DoctorCheck[] {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  const local = readLocalConfig(root);
  const checks: DoctorCheck[] = [];
  if (local.problems.length) checks.push({ name: 'local.yml', ok: false, detail: local.problems.join('; ') });
  else {
    const known = new Set(repos.map((r) => r.name));
    const unknown = Object.keys(local.repos).filter((n) => !known.has(n));
    if (unknown.length) checks.push({ name: 'local.yml', ok: true, warn: true, detail: `names not in repos: ${unknown.map((n) => JSON.stringify(n)).join(', ')}` });
  }
  for (const r of repos) checks.push(memberCheck(root, config, r, local));
  return checks;
}

/**
 * Doctor's release checks: `release mechanism` for the root, then `release mechanism <name>` per
 * `repos` entry in config order, each only when that repo declares a mechanism. Members are checked
 * only when `repos` validates, and in their local.yml clone; nothing runs in it.
 */
export function releaseChecks(root: string, config: Config, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (config.release?.mechanism && !releaseProblems(config.release, 'release').length) checks.push(releaseMechanismCheck('release mechanism', root, config.release, env, platform));
  const repos = Array.isArray(config.repos) ? config.repos : [];
  if (!repos.some((r) => r.release?.mechanism) || repoProblems(config, root).length) return checks;
  const local = readLocalConfig(root);
  for (const r of repos) {
    const mechanism = r.release?.mechanism;
    if (!r.release || !mechanism) continue;
    const name = `release mechanism ${r.name}`;
    const entry = Object.hasOwn(local.repos, r.name) ? local.repos[r.name] : undefined;
    const dir = entry ? resolveMemberPath(root, entry.path) : null;
    let isDir = false;
    try {
      isDir = dir !== null && fs.statSync(dir).isDirectory();
    } catch {
      // missing: reported by the repo <name> check
    }
    if (!dir || !isDir) checks.push({ name, ok: true, warn: true, detail: `${mechanism}: ${r.name}'s clone is not resolved (see the repo ${r.name} check); not checked` });
    else checks.push(releaseMechanismCheck(name, dir, r.release, env, platform));
  }
  return checks;
}
