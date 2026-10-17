// The side of interim strategies that touches git (docs/CONFIG.md "Interim strategies"): verify's
// pin refresh, the git-dependent edge states `forge job interim` and `pr open` read, and the one
// command in Forge that publishes anything, `forge job interim publish`. Worktrees are recomputed
// (isOwnWorktreePath, trustedMemberWorktree), never read from job.json alone, and every value that
// reaches a manifest is checked first: a sha against FULL_SHA, a remote against isSafeRemote.
// Must not import worktree.ts or integrity.ts: worktree.ts imports this module.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { attributionForbidden, scrubBranch } from './attribution.ts';
import { isInsidePath } from './components.ts';
import { isOwnWorktreePath } from './config.ts';
import { memberConfig, memberEntry, trustedMemberWorktree } from './job-repos.ts';
import { loadJob, logEvent, readEvents, setJob, updateJob } from './jobs.ts';
import { FULL_SHA, INTERIM_STRATEGIES, canaryVersion, isInterimStrategy, npmGitSpec, pinCargo, pinCmake, pinNpm, pinsAny, remoteUrl, repoLabel, resolveInterim } from './interim.ts';
import type { CargoPin, InterimEdge, PinResult } from './interim.ts';
import { isSafeRemote } from './member-repos.ts';
import { historyEnv } from './protected.ts';
import type { RepoKey } from './repo-order.ts';
import { enqueue, listRequests } from './requests.ts';
import { logSecrets, refusalMessage, scanBranch, scanFiles, secretMode } from './secrets.ts';
import type { Config, InterimStrategy, Job, JobEvent } from './types.ts';
import { ForgeError, SAFE_REF, run } from './util.ts';

const STATUS_ARGV = ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'];
const PIN_STRATEGIES = new Set(['git-ref', 'canary']);

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  return env;
}

const git = (cwd: string, args: string[]) => run('git', args, { cwd, allowFail: true, env: gitEnv() });

/** A job repo's worktree when it is the path Forge computes and exists, else null. */
export function repoWorktree(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'repos'>, key: RepoKey): string | null {
  if (key === null) return job.worktree && isOwnWorktreePath(root, config, job.id, job.worktree) && fs.existsSync(job.worktree) ? job.worktree : null;
  return trustedMemberWorktree(root, config, job, key);
}

function headOf(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const sha = r.stdout.trim();
  return r.ok && FULL_SHA.test(sha) ? sha : null;
}

/** A tracked file's text at `sha`, read from git objects only (no filters); null when it is not there. */
function readAt(cwd: string, sha: string, rel: string): string | null {
  if (!FULL_SHA.test(sha) || !isInsidePath(rel)) return null;
  const r = git(cwd, ['cat-file', 'blob', `${sha}:${rel.replace(/\\/g, '/')}`]);
  return r.ok ? r.stdout : null;
}

/** The dependency's remote as a URL a manifest can name, or why there is none. */
function dependencyUrl(root: string, config: Config, key: RepoKey): { url: string } | { error: string } {
  let remote: string;
  if (key === null) {
    if (!SAFE_REF.test(String(config.git.remote))) return { error: `git.remote ${JSON.stringify(config.git.remote)} is not a remote name` };
    remote = git(root, ['remote', 'get-url', config.git.remote]).stdout.trim().split('\n')[0] ?? '';
  } else {
    try {
      remote = memberConfig(config, key).remote;
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  if (!isSafeRemote(remote)) return { error: `${repoLabel(key)} has no usable remote URL` };
  const url = remoteUrl(remote);
  if (url === null) return { error: `${repoLabel(key)}'s remote is neither a URL, an absolute path nor user@host:path` };
  if (underHome(url)) return { error: `${repoLabel(key)}'s remote is a path in your home directory, which a pushed manifest must not name (and CI can't fetch); give the repo a hosted remote` };
  return { url };
}

/** A `file://` URL inside the user's home directory: pinned, it would publish a local home path in a PR. */
function underHome(url: string): boolean {
  if (!/^file:\/\//i.test(url)) return false;
  let file: string;
  try {
    file = path.resolve(fileURLToPath(url));
  } catch {
    return true;
  }
  const homes = new Set<string>();
  for (const h of [os.homedir(), process.env.HOME]) {
    if (!h || path.resolve(h) === path.parse(path.resolve(h)).root) continue;
    homes.add(path.resolve(h));
    try {
      homes.add(fs.realpathSync(h));
    } catch {}
  }
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {}
  return [...homes].some((h) => [file, real].some((f) => f === h || f.startsWith(h + path.sep)));
}

interface Pins {
  cargo: { manifest: string; pin: CargoPin }[];
  cmake: { manifest: string; name: string; sha: string }[];
  npm: { manifest: string; name: string; spec: string }[];
  /** The commit message line: `<D>: git-ref <sha12>` or `<D>: canary <version>`. */
  line: string;
  /** Canary versions by npm name. */
  versions: Map<string, string>;
}

/** What one edge writes into its consumer's manifests for dependency HEAD `sha`, or why it can't. */
function edgePins(root: string, config: Config, edge: InterimEdge, dWorktree: string, sha: string): Pins | { error: string } {
  const out: Pins = { cargo: [], cmake: [], npm: [], line: '', versions: new Map() };
  const d = edge.dependency === null ? 'root' : edge.dependency;
  if (edge.strategy === 'canary') {
    const versions = new Set<string>();
    for (const l of edge.links) {
      const text = readAt(dWorktree, sha, path.posix.join(l.relPath.replace(/\\/g, '/'), 'package.json'));
      if (text === null) return { error: `${l.relPath}/package.json is not in ${repoLabel(edge.dependency)} at ${sha.slice(0, 12)}` };
      let version: unknown;
      try {
        version = JSON.parse(text)?.version;
      } catch {
        return { error: `${l.relPath}/package.json in ${repoLabel(edge.dependency)} is not valid JSON` };
      }
      const v = canaryVersion(version, sha);
      if (v === null) return { error: `${l.relPath}/package.json in ${repoLabel(edge.dependency)} has no semver version` };
      versions.add(v);
      out.versions.set(l.name, v);
      out.npm.push({ manifest: l.manifest!, name: l.name, spec: v });
    }
    out.line = `${d}: canary ${[...versions].join(', ')}`;
    return out;
  }
  const remote = dependencyUrl(root, config, edge.dependency);
  if ('error' in remote) return remote;
  for (const l of edge.links) {
    if (l.ecosystem === 'cargo') out.cargo.push({ manifest: l.manifest!, pin: { source: l.source ?? 'crates-io', name: l.name, git: remote.url, rev: sha } });
    else if (l.ecosystem === 'cmake') out.cmake.push({ manifest: l.manifest!, name: l.name, sha });
    else {
      const spec = npmGitSpec(remote.url, sha);
      if (spec === null) return { error: `${repoLabel(edge.dependency)}'s remote has no npm git form` };
      out.npm.push({ manifest: l.manifest!, name: l.name, spec });
    }
  }
  out.line = `${d}: git-ref ${sha.slice(0, 12)}`;
  return out;
}

/** One consumer's manifests before and after its pins, and each edge's reason it can't be pinned. */
interface ConsumerPlan {
  files: Map<string, { before: string; after: string }>;
  errors: Map<InterimEdge, string>;
  edgeFiles: Map<InterimEdge, string[]>;
  lines: string[];
  versions: Map<InterimEdge, Map<string, string>>;
}

/**
 * Applies every pin edge of `consumer` to its manifests as they are at `cSha`, with each dependency at
 * `heads`. An edge whose pins can't be written, or that shares a manifest with one, gets an error.
 */
function planConsumer(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'repos'>, consumer: RepoKey, edges: InterimEdge[], cWorktree: string, cSha: string, heads: Map<RepoKey, string>): ConsumerPlan {
  const plan: ConsumerPlan = { files: new Map(), errors: new Map(), edgeFiles: new Map(), lines: [], versions: new Map() };
  const byFile = new Map<string, { cargo: CargoPin[]; ops: ((t: string) => PinResult)[]; edges: InterimEdge[] }>();
  for (const e of edges) {
    const dWt = repoWorktree(root, config, job, e.dependency);
    const sha = heads.get(e.dependency);
    if (!dWt || !sha) {
      plan.errors.set(e, `${repoLabel(e.dependency)} has no worktree; run: forge worktree create ${job.id}`);
      continue;
    }
    const pins = edgePins(root, config, e, dWt, sha);
    if ('error' in pins) {
      plan.errors.set(e, pins.error);
      continue;
    }
    plan.lines.push(pins.line);
    plan.versions.set(e, pins.versions);
    const slot = (m: string) => {
      if (!byFile.has(m)) byFile.set(m, { cargo: [], ops: [], edges: [] });
      const s = byFile.get(m)!;
      if (!s.edges.includes(e)) s.edges.push(e);
      return s;
    };
    for (const c of pins.cargo) slot(c.manifest).cargo.push(c.pin);
    for (const c of pins.cmake) slot(c.manifest).ops.push((t) => pinCmake(t, c.name, c.sha, c.manifest));
    for (const n of pins.npm) slot(n.manifest).ops.push((t) => pinNpm(t, n.name, n.spec, n.manifest));
    plan.edgeFiles.set(e, [...new Set([...pins.cargo, ...pins.cmake, ...pins.npm].map((p) => p.manifest))]);
  }
  for (const [file, s] of byFile) {
    const before = readAt(cWorktree, cSha, file);
    let res: PinResult = before === null ? { error: `${file} is not in ${repoLabel(consumer)} at ${cSha.slice(0, 12)}` } : { text: before };
    if ('text' in res && s.cargo.length) res = pinCargo(res.text, s.cargo, file);
    for (const op of s.ops) if ('text' in res) res = op(res.text);
    if ('error' in res) for (const e of s.edges) plan.errors.set(e, res.error);
    else plan.files.set(file, { before: before!, after: res.text });
  }
  return plan;
}

/** Each job repo's HEAD now, read from its trusted worktree. */
function currentHeads(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'repos'>, keys: RepoKey[]): Map<RepoKey, string> {
  const heads = new Map<RepoKey, string>();
  for (const k of keys) {
    const wt = repoWorktree(root, config, job, k);
    const h = wt ? headOf(wt) : null;
    if (h) heads.set(k, h);
  }
  return heads;
}

const canaryEvents = (events: JobEvent[], key: RepoKey, name: string, version: string): JobEvent[] =>
  events.filter((e) => e.type === 'canary-published' && (e.repo ?? null) === key && e.name === name && e.version === version);

/**
 * Every edge of the job with its git-dependent state filled in: `blocked` when a pin can't be
 * written, `stale` when the consumer's manifest at its head does not carry the pin for the
 * dependency's head, `waiting` for a canary not yet published. `heads` are the commits to judge
 * (pr open passes the checked ones); by default each repo's HEAD now. No network call.
 */
export function interimStatus(root: string, config: Config, job: Job, heads?: Map<RepoKey, string>): { edges: InterimEdge[]; cycle: RepoKey[] | null } {
  const res = resolveInterim(config, job);
  if (!pinsAny(res.edges)) return { edges: res.edges, cycle: res.cycle };
  const at = heads ?? currentHeads(root, config, job, res.order);
  const events = readEvents(root, job.id);
  const edges = res.edges.map((e) => ({ ...e }));
  for (const consumer of res.order) {
    const mine = edges.filter((e) => e.consumer === consumer && PIN_STRATEGIES.has(e.strategy) && e.state !== 'blocked');
    if (!mine.length) continue;
    const cWt = repoWorktree(root, config, job, consumer);
    const cSha = at.get(consumer);
    if (!cWt || !cSha) {
      for (const e of mine) Object.assign(e, { state: 'blocked', detail: `${repoLabel(consumer)} has no worktree; run: forge worktree create ${job.id}` });
      continue;
    }
    const plan = planConsumer(root, config, job, consumer, mine, cWt, cSha, at);
    for (const e of mine) {
      const err = plan.errors.get(e);
      if (err) {
        Object.assign(e, { state: 'blocked', detail: err });
        continue;
      }
      const sha = at.get(e.dependency)!;
      const moved = (plan.edgeFiles.get(e) ?? []).filter((f) => plan.files.get(f)?.after !== plan.files.get(f)?.before);
      if (moved.length) {
        Object.assign(e, { state: 'stale', detail: `${moved.join(', ')} in ${repoLabel(consumer)} does not pin ${repoLabel(e.dependency)} at ${sha.slice(0, 12)}; run: forge verify ${job.id}` });
        continue;
      }
      if (e.strategy === 'canary') {
        const missing = [...(plan.versions.get(e) ?? new Map()).entries()].find(([n, v]) => !canaryEvents(events, e.dependency, n, v).length);
        if (missing) {
          Object.assign(e, { state: 'waiting', canary: { name: missing[0], version: missing[1] }, detail: `canary ${missing[0]}@${missing[1]} is not published; a human runs: forge job interim publish ${job.id} ${e.dependency ?? '--root'} --confirm` });
          continue;
        }
        Object.assign(e, { state: 'ready', detail: `pins ${[...(plan.versions.get(e) ?? new Map()).entries()].map(([n, v]) => `${n}@${v}`).join(', ')}, published` });
        continue;
      }
      Object.assign(e, { state: 'ready', detail: `pins ${repoLabel(e.dependency)} at ${sha.slice(0, 12)}` });
    }
  }
  return { edges, cycle: res.cycle };
}

/** What verify's interim pre-step did: refreshInterim. */
export interface InterimRefresh {
  /** The job has a git-ref or canary edge, so verify reports an `interim` step. */
  active: boolean;
  ok: boolean;
  problems: string[];
  commits: { repo: RepoKey; sha: string }[];
}

/** Writes `text` over `file` inside `worktree` (temp file plus rename, so a symlink there is replaced, never followed). */
function writeManifest(worktree: string, rel: string, text: string): void {
  const file = path.join(worktree, rel);
  const parent = fs.realpathSync.native(path.dirname(file));
  const inside = path.relative(fs.realpathSync.native(worktree), parent);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new ForgeError(`${rel} resolves outside the worktree`);
  const tmp = path.join(parent, `.${path.basename(file)}.forge-${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  try {
    const st = fs.lstatSync(file);
    if (st.isFile()) fs.chmodSync(tmp, st.mode & 0o777);
  } catch {}
  fs.renameSync(tmp, path.join(parent, path.basename(file)));
}

/** The scrub `pr open` runs on a repo's branch, run here first so the sha a consumer pins is the one pushed. */
function scrubLikePrOpen(config: Config, worktree: string, base: string | null): void {
  if (!base || !SAFE_REF.test(base) || !SAFE_REF.test(String(config.git.remote))) return;
  const remoteBase = `${config.git.remote}/${base}`;
  const from = git(worktree, ['rev-parse', '--verify', '--quiet', remoteBase]).ok ? remoteBase : base;
  scrubBranch(worktree, from, 'HEAD', historyEnv(gitEnv()));
}

/**
 * Verify's pre-step: for each git-ref or canary edge, writes the consumer's pins for the
 * dependency's HEAD and commits them in the consumer's worktree, dependencies first. Nothing is
 * written when a worktree involved is dirty (worktree-clean then fails the run) or when no content
 * changes. A problem never throws: it becomes the `interim` step's failure.
 */
export function refreshInterim(root: string, config: Config, job: Job): InterimRefresh {
  const res = resolveInterim(config, job);
  if (!pinsAny(res.edges)) return { active: false, ok: true, problems: [], commits: [] };
  const problems: string[] = [];
  const commits: InterimRefresh['commits'] = [];
  if (res.cycle) problems.push(`the components' dependsOn form a cycle among ${res.cycle.map(repoLabel).join(', ')}: pins need a dependency order`);
  const pinEdges = res.edges.filter((e) => PIN_STRATEGIES.has(e.strategy));
  for (const e of pinEdges.filter((x) => x.state === 'blocked')) problems.push(`${repoLabel(e.consumer)} on ${repoLabel(e.dependency)} (${e.strategy}): ${e.detail}`);
  const live = pinEdges.filter((e) => e.state !== 'blocked');
  const involved = [...new Set(live.flatMap((e) => [e.consumer, e.dependency]))];
  const worktrees = new Map<RepoKey, string>();
  for (const k of involved) {
    const wt = repoWorktree(root, config, job, k);
    if (wt) worktrees.set(k, wt);
    else problems.push(`${repoLabel(k)} has no worktree; run: forge worktree create ${job.id}`);
  }
  if (problems.length) return { active: true, ok: false, problems, commits };
  if ([...worktrees.values()].some((wt) => git(wt, STATUS_ARGV).stdout.trim() !== '')) return { active: true, ok: true, problems, commits };
  const deps = new Set(live.map((e) => e.dependency));
  const base = (k: RepoKey) => (k === null ? job.base : (memberEntry(job, k)?.base ?? null));
  try {
    for (const repo of res.order) {
      const wt = worktrees.get(repo);
      if (!wt) continue;
      // Before this repo's own pin commit, which carries no attribution: the scrub then leaves it alone at pr open.
      if (deps.has(repo) && attributionForbidden(config)) scrubLikePrOpen(config, wt, base(repo));
      const mine = live.filter((e) => e.consumer === repo);
      if (!mine.length) continue;
      const heads = currentHeads(root, config, job, involved);
      const cSha = heads.get(repo);
      if (!cSha) {
        problems.push(`${repoLabel(repo)} has no HEAD commit`);
        continue;
      }
      const plan = planConsumer(root, config, job, repo, mine, wt, cSha, heads);
      for (const [e, err] of plan.errors) problems.push(`${repoLabel(e.consumer)} on ${repoLabel(e.dependency)} (${e.strategy}): ${err}`);
      if (plan.errors.size) continue;
      const changed = [...plan.files].filter(([, f]) => f.after !== f.before);
      if (!changed.length) continue;
      for (const [rel, f] of changed) writeManifest(wt, rel, f.after);
      const msg = [`forge: interim pins for job ${job.id}`, '', ...plan.lines].join('\n');
      const c = git(wt, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '--only', '-m', msg, '--', ...changed.map(([rel]) => rel)]);
      if (!c.ok) {
        problems.push(`could not commit the pins in ${repoLabel(repo)} (git exited ${c.status})`);
        continue;
      }
      commits.push({ repo, sha: headOf(wt) ?? '' });
    }
  } catch (e) {
    problems.push((e as Error).message);
  }
  return { active: true, ok: problems.length === 0, problems, commits };
}

/**
 * `forge job repo interim`: sets (or with `inherit` clears) the job's override for one job repo as a
 * dependency. Refused for a finished job, an unknown or verify-only repo, and `canary` on a repo that
 * a non-npm link depends on (canary is npm-only).
 */
export function setRepoInterim(root: string, config: Config, id: string, key: RepoKey, value: string): { id: string; repo: RepoKey; interim: InterimStrategy | null } {
  if (value !== 'inherit' && !isInterimStrategy(value)) throw new ForgeError(`strategy must be one of ${[...INTERIM_STRATEGIES, 'inherit'].join(' | ')} (got ${JSON.stringify(value).slice(0, 60)})`);
  const job = loadJob(root, id);
  if (['done', 'cancelled'].includes(job.state) || job.stage === 'done') throw new ForgeError(`job ${id} is ${job.state}; its interim strategies can't change`);
  if (key !== null) {
    const m = memberEntry(job, key);
    if (!m) throw new ForgeError(`job ${id} has no repo ${JSON.stringify(key).slice(0, 110)}`);
    if (m.verifyOnly) throw new ForgeError(`repo ${key} is verify-only on job ${id}: it is unchanged, so nothing depends on its branch`);
  }
  const interim = value === 'inherit' ? null : value;
  if (interim === 'canary') {
    const bad = resolveInterim(config, { ...job, interim: null, repos: job.repos }).edges.flatMap((e) => (e.dependency === key ? e.links : [])).find((l) => l.ecosystem !== 'npm');
    if (bad) throw new ForgeError(`canary is npm-only, and ${repoLabel(bad.consumerRepo)} depends on ${repoLabel(key)} through the ${bad.ecosystem} link ${bad.name}`);
  }
  updateJob(root, id, (j) => {
    if (key === null) j.interim = interim;
    else {
      const e = memberEntry(j, key);
      if (e) e.interim = interim;
    }
  });
  logEvent(root, id, 'job-repo-interim', { repo: key, interim });
  return { id, repo: key, interim };
}

// ---------- canary publish ----------

// Publishing is outward-facing and runs on the human's npm credentials: a session misled by tracker
// or PR text must never reach it.
export const PUBLISH_DAEMON_REFUSAL = 'forge job interim publish publishes a package from this job, which a daemon session may not do; a human runs it in their own session';

/** One package publishCanary would publish or did. */
export interface CanaryPackage {
  name: string;
  version: string;
  tag: 'canary';
  dir: string;
  skipped?: true;
}

/** Config npm reads from a package directory, and so from an export: it could redirect the registry and the token. */
const NPM_CONFIG_FILE = /(^|\/)(\.npmrc|\.yarnrc[^/]*)$/;

interface TreeEntry {
  mode: string;
  blob: string;
  path: string;
}

/** The regular files of `rel` at `sha` from git objects only. Symlinks and submodules are left out. */
function treeEntries(cwd: string, sha: string, rel: string): TreeEntry[] {
  const spec = rel.replace(/\\/g, '/').replace(/\/+$/, '');
  const ls = run('git', ['-c', 'core.quotepath=off', 'ls-tree', '-r', '-z', '--full-tree', sha, '--', ...(spec === '.' ? [] : [spec])], { cwd, env: gitEnv() });
  return ls.stdout.split('\0').filter(Boolean).flatMap((line) => {
    const m = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/s.exec(line);
    return m && (m[1] === '100644' || m[1] === '100755') ? [{ mode: m[1], blob: m[2], path: m[3] }] : [];
  });
}

/**
 * Writes `entries` into `dir` from git objects only: no checkout, so no filter, hook or attribute in
 * the (builder-writable) repo config runs, and nothing untracked or ignored in the worktree ships.
 * Returns what it wrote, for the secret scan.
 */
function exportTree(cwd: string, entries: TreeEntry[], dir: string): { path: string; body: Buffer }[] {
  if (!entries.length) return [];
  const batch = spawnSync('git', ['cat-file', '--batch'], { cwd, env: gitEnv(), input: entries.map((e) => e.blob).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024 });
  if (batch.status !== 0 || !batch.stdout) throw new ForgeError(`git cat-file could not read the objects of the export`);
  const out = batch.stdout as Buffer;
  const written: { path: string; body: Buffer }[] = [];
  let at = 0;
  for (const e of entries) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[0] !== e.blob || header[1] !== 'blob' || !Number.isSafeInteger(size)) throw new ForgeError(`git cat-file returned an unexpected object for ${e.path}`);
    const body = out.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    if (!isInsidePath(e.path)) continue;
    const file = path.join(dir, e.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { mode: e.mode === '100755' ? 0o755 : 0o644 });
    written.push({ path: e.path, body });
  }
  return written;
}

/** Resumes a job PR6 parked, the way a human's approval of a parked gate does: running, plus a `resume` request when the daemon is on. */
function resumeParked(root: string, config: Config, id: string, reason: string): boolean {
  const job = loadJob(root, id);
  if (!(job.stage === 'pr' && job.state === 'waiting' && job.waitingOn === 'human')) return false;
  setJob(root, id, { state: 'running', waitingOn: null, reason });
  if (config.daemon?.enabled === true && !listRequests(root).some((r) => r.type === 'resume' && r.job === id && (r.status === 'pending' || r.status === 'in-progress')))
    enqueue(root, config, { type: 'resume', job: id, text: 'forge job interim publish published the canary', from: 'interim' });
  return true;
}

// Publishing runs on the human's npm credentials, so it needs a human at a terminal too: an agent's
// Bash tool has no TTY on stdin. A speed bump against a misled session, not a sandbox.
export const PUBLISH_TTY_REFUSAL = 'forge job interim publish --confirm needs a human at a terminal (stdin is not a TTY); run it yourself in your own shell';

/**
 * `forge job interim publish`: the only path in Forge that publishes anything. Refused in a daemon
 * session, with `confirm` when stdin is not a terminal, for a repo that is not the dependency of an
 * npm-only canary edge, for a HEAD that is not the one the latest passing verify recorded or not on
 * the job branch, for a package that carries npm or yarn config, and for a secret in the commits or
 * in the exported files under `verifySecrets: block`. Without `confirm` it only says what it would
 * publish.
 */
export function publishCanary(root: string, config: Config, id: string, key: RepoKey, opts: { confirm: boolean; interactive: boolean }): { id: string; repo: RepoKey; confirm: boolean; would?: CanaryPackage[]; published?: CanaryPackage[]; resumed?: boolean } {
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(PUBLISH_DAEMON_REFUSAL);
  if (opts.confirm && !opts.interactive) throw new ForgeError(PUBLISH_TTY_REFUSAL);
  const job = loadJob(root, id);
  if (key !== null && !memberEntry(job, key)) throw new ForgeError(`job ${id} has no repo ${JSON.stringify(key).slice(0, 110)}`);
  const edges = resolveInterim(config, job).edges.filter((e) => e.dependency === key && e.strategy === 'canary' && e.links.length && e.links.every((l) => l.ecosystem === 'npm'));
  if (!edges.length) throw new ForgeError(`${repoLabel(key)} is not the dependency of a canary edge with npm links on job ${id}; set one with: forge job repo interim ${id} ${key ?? '--root'} canary`);
  const wt = repoWorktree(root, config, job, key);
  if (!wt) throw new ForgeError(`${repoLabel(key)} has no worktree; run: forge worktree create ${id}`);
  const head = headOf(wt);
  const last = job.verifyRuns.filter((r) => r.ok).at(-1);
  const verified = key === null ? last?.sha : last?.repos?.find((r) => r.repo === key)?.sha;
  if (!head || !verified || head !== verified)
    throw new ForgeError(`${repoLabel(key)}'s HEAD ${String(head).slice(0, 12)} is not the commit the latest passing verify checked (${String(verified ?? 'none').slice(0, 12)}); run: forge verify ${id}`);
  // job.json is writable by the session this guards against: git says whether the verified commit is
  // really on the job's branch, not only what the record claims.
  // Every member shares the job's branch (cleanRepos).
  const branch = job.branch;
  const tip = branch && SAFE_REF.test(branch) ? git(wt, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).stdout.trim() : '';
  if (!FULL_SHA.test(tip) || !git(wt, ['merge-base', '--is-ancestor', head, tip]).ok)
    throw new ForgeError(`${repoLabel(key)}'s verified commit ${head.slice(0, 12)} is not on the job branch ${JSON.stringify(String(branch)).slice(0, 120)}; run: forge verify ${id}`);
  const mode = secretMode(config);
  const view = { id, worktree: wt, base: key === null ? job.base : (memberEntry(job, key)?.base ?? null) };
  const scan = scanBranch(root, config, view, { staged: false, head });
  logSecrets(root, id, 'publish', scan, { blocked: mode === 'block' });
  if (mode === 'block' && scan.error) throw new ForgeError(`secret scan of ${repoLabel(key)}'s commits could not finish (${scan.error}); forge job interim publish won't publish unscanned code`, 'secret_found', `forge secrets scan ${id}`);
  if (mode === 'block' && scan.findings.length) throw new ForgeError(refusalMessage(`the commits of ${repoLabel(key)}`, scan.findings), 'secret_found', `forge secrets scan ${id}`);
  const byName = new Map<string, string>();
  for (const e of edges) for (const l of e.links) if (!byName.has(l.name)) byName.set(l.name, l.relPath);
  const would: CanaryPackage[] = [];
  const trees = new Map<string, TreeEntry[]>();
  for (const [name, rel] of [...byName].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const text = readAt(wt, head, path.posix.join(rel.replace(/\\/g, '/'), 'package.json'));
    let pkg: any = null;
    try {
      pkg = text === null ? null : JSON.parse(text);
    } catch {}
    const version = canaryVersion(pkg?.version, head);
    if (!version) throw new ForgeError(`${rel}/package.json in ${repoLabel(key)} has no semver version at ${head.slice(0, 12)}`);
    if (pkg.name !== name) throw new ForgeError(`${rel}/package.json in ${repoLabel(key)} is named ${JSON.stringify(String(pkg.name)).slice(0, 220)}, not the link's ${name}; Forge publishes only the package config names`);
    const entries = treeEntries(wt, head, rel);
    const rc = entries.find((e) => NPM_CONFIG_FILE.test(e.path));
    if (rc) throw new ForgeError(`${repoLabel(key)} tracks ${JSON.stringify(rc.path).slice(0, 220)} in the package ${name}; npm would read it as config while publishing, so Forge won't publish it`);
    trees.set(name, entries);
    would.push({ name, version, tag: 'canary', dir: rel });
  }
  if (!opts.confirm) return { id, repo: key, confirm: false, would };
  const published: CanaryPackage[] = [];
  for (const p of would) {
    if (canaryEvents(readEvents(root, id), key, p.name, p.version).length) {
      published.push({ ...p, skipped: true });
      continue;
    }
    // Outside the repo and the job dir (both writable by the builder), so npm finds no project or
    // workspace config above the package either.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-canary-'));
    try {
      const files = exportTree(wt, trees.get(p.name)!, dir);
      const exported = scanFiles(root, config, files);
      logSecrets(root, id, 'publish', exported, { blocked: mode === 'block' });
      if (mode === 'block' && exported.findings.length) throw new ForgeError(refusalMessage(`the package ${p.name} of ${repoLabel(key)}`, exported.findings), 'secret_found', `forge secrets scan ${id}`);
      const pkgDir = path.join(dir, p.dir);
      const file = path.join(pkgDir, 'package.json');
      const raw = fs.readFileSync(file, 'utf8');
      const pkg = JSON.parse(raw);
      if (pkg.name !== p.name) throw new ForgeError(`the exported package.json is named ${JSON.stringify(String(pkg.name)).slice(0, 220)}, not ${p.name}`);
      pkg.version = p.version;
      // It could point the publish at another registry or make the canary everyone's latest.
      delete pkg.publishConfig;
      const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? '  ';
      fs.writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`);
      // Fixed argv, no shell: nothing from the repo or job reaches npm's options, and none of the
      // package's lifecycle scripts runs in the human's session.
      const r = run('npm', ['publish', '--ignore-scripts', '--workspaces=false', '--tag', 'canary'], { cwd: pkgDir, allowFail: true });
      if (!r.ok) throw new ForgeError(`npm publish of ${p.name}@${p.version} exited ${r.status ?? 'without starting'}; nothing was recorded`, 'external');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    logEvent(root, id, 'canary-published', { repo: key, name: p.name, version: p.version, sha: head });
    published.push(p);
  }
  const resumed = resumeParked(root, config, id, `canary of ${repoLabel(key)} published: open the deferred PRs`);
  return { id, repo: key, confirm: true, published, ...(resumed ? { resumed } : {}) };
}
