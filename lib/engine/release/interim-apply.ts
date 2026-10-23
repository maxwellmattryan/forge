// The side of interim strategies that touches git (docs/CONFIG.md "Interim strategies"): verify's
// pin refresh, the git-dependent edge states `forge job interim` and `pr open` read, and the one
// command in Forge that publishes anything, `forge job interim publish`. Worktrees are recomputed
// (isOwnWorktreePath, trustedMemberWorktree), never read from job.json alone, and every value that
// reaches a manifest is checked first: a sha against FULL_SHA, a remote against isSafeRemote.
// Must not import lib/engine/verify/gate.ts or integrity.ts: gate.ts imports this module.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attributionForbidden, scrubBranch } from '../guard/attribution.ts';
import { isInsidePath } from '#core/config/components.ts';
import { isOwnWorktreePath } from '#core/config/load.ts';
import { STATUS_ARGV, git as runGit, gitEnv, gitSpawnSync, historyEnv } from '#integrations/git/runner.ts';
import { memberConfig, memberEntry, trustedMemberWorktree } from '../project/job-repos.ts';
import { loadJob, logEvent, readEvents, setJob, updateJob } from '#core/job/store.ts';
import {
  FULL_SHA,
  INTERIM_STRATEGIES,
  RELEASE_VERSION,
  bumpedVersion,
  bumpsOnRelease,
  canaryVersion,
  isInterimStrategy,
  isReleaseVersion,
  lockfileArgv,
  npmGitSpec,
  pinCargo,
  pinCmake,
  pinNpm,
  pinsAny,
  prStateOf,
  releaseCargo,
  releaseCmake,
  releaseGates,
  releaseIndex,
  releaseNpm,
  releasedVersion,
  remoteUrl,
  repoLabel,
  resolveInterim,
} from './interim.ts';
import type { CargoPin, InterimEdge, PinResult } from './interim.ts';
import { isSafeRemote, readLocalConfig, resolveMemberPath } from '../project/member-repos.ts';
import type { RepoKey } from '../project/repo-order.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { logSecrets, refusalMessage, scanBranch, scanFiles, secretMode, secretsBlock } from '../guard/secrets.ts';
import type { Config, InterimStrategy, Job, JobEvent, WaitingOn } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { findOnPath, run } from '#core/os/process.ts';
import { SAFE_REF } from '#core/text.ts';
import { verifiedSha } from '../verify/record.ts';

const PIN_STRATEGIES = new Set(['git-ref', 'canary']);

const git = (cwd: string, args: string[], o: { write?: boolean } = {}) => runGit(cwd, args, { allowFail: true, ...o });

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

/** One consumer's manifests before and after its pins and release bumps, and each edge's reason it can't be written. */
interface ConsumerPlan {
  files: Map<string, { before: string; after: string }>;
  errors: Map<InterimEdge, string>;
  edgeFiles: Map<InterimEdge, string[]>;
  lines: string[];
  versions: Map<InterimEdge, Map<string, string>>;
  /** Each release edge's links, for the lockfile refresh. */
  releaseLinks: { edge: InterimEdge; ecosystem: string; name: string; manifest: string; version: string }[];
}

/** Whether `tag` names a commit in the dependency's worktree, or in its clone (the main checkout for the root). */
function tagExists(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'repos'>, key: RepoKey, tag: string): boolean {
  if (!isReleaseVersion(tag)) return false;
  const dirs = [repoWorktree(root, config, job, key)];
  if (key === null) dirs.push(root);
  else {
    const local = readLocalConfig(root).repos[key]?.path;
    if (typeof local === 'string' && local) dirs.push(resolveMemberPath(root, local));
  }
  return dirs.some((d) => d !== null && fs.existsSync(d) && git(d, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).ok);
}

/**
 * Applies every edge of `consumer` to its manifests as they are at `cSha`: a pin edge at its
 * dependency's commit in `heads`, a release edge (in `releases`) at its recorded version. Per file,
 * the remaining cargo pins first (a released crate leaves the Forge block), then the release writers,
 * then the other pins. An edge whose manifests can't be written, or that shares one with such an edge, gets an error.
 */
function planConsumer(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'repos'>, consumer: RepoKey, edges: InterimEdge[], cWorktree: string, cSha: string, heads: Map<RepoKey, string>, releases: Map<InterimEdge, string> = new Map()): ConsumerPlan {
  const plan: ConsumerPlan = { files: new Map(), errors: new Map(), edgeFiles: new Map(), lines: [], versions: new Map(), releaseLinks: [] };
  const byFile = new Map<string, { cargo: CargoPin[]; cargoTouched: boolean; release: ((t: string) => PinResult)[]; ops: ((t: string) => PinResult)[]; edges: InterimEdge[] }>();
  const slotFor = (e: InterimEdge) => (m: string) => {
    if (!byFile.has(m)) byFile.set(m, { cargo: [], cargoTouched: false, release: [], ops: [], edges: [] });
    const s = byFile.get(m)!;
    if (!s.edges.includes(e)) s.edges.push(e);
    return s;
  };
  for (const e of edges) {
    const slot = slotFor(e);
    const version = releases.get(e);
    if (version !== undefined) {
      const d = e.dependency === null ? 'root' : e.dependency;
      const noManifest = e.links.find((l) => l.manifest === null);
      if (noManifest) {
        plan.errors.set(e, `the consumer component ${noManifest.consumer} has no usable path for its manifest`);
        continue;
      }
      const cmake = e.links.find((l) => l.ecosystem === 'cmake');
      if (cmake && !tagExists(root, config, job, e.dependency, version)) {
        plan.errors.set(e, `tag ${version} is not in ${repoLabel(e.dependency)}; fetch its tags, or record the version as the tag names it`);
        continue;
      }
      for (const l of e.links) {
        const m = l.manifest!;
        const s = slot(m);
        if (l.ecosystem === 'cargo') {
          s.cargoTouched = true;
          s.release.push((t) => releaseCargo(t, l.name, version, m));
        } else if (l.ecosystem === 'cmake') s.release.push((t) => releaseCmake(t, l.name, version, m));
        else s.release.push((t) => releaseNpm(t, l.name, version, m));
        plan.releaseLinks.push({ edge: e, ecosystem: l.ecosystem, name: l.name, manifest: m, version });
      }
      plan.lines.push(`${d}: release ${version}`);
      plan.edgeFiles.set(e, [...new Set(e.links.map((l) => l.manifest!))]);
      continue;
    }
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
    for (const c of pins.cargo) slot(c.manifest).cargo.push(c.pin);
    for (const c of pins.cmake) slot(c.manifest).ops.push((t) => pinCmake(t, c.name, c.sha, c.manifest));
    for (const n of pins.npm) slot(n.manifest).ops.push((t) => pinNpm(t, n.name, n.spec, n.manifest));
    plan.edgeFiles.set(e, [...new Set([...pins.cargo, ...pins.cmake, ...pins.npm].map((p) => p.manifest))]);
  }
  for (const [file, s] of byFile) {
    const before = readAt(cWorktree, cSha, file);
    let res: PinResult = before === null ? { error: `${file} is not in ${repoLabel(consumer)} at ${cSha.slice(0, 12)}` } : { text: before };
    if ('text' in res && (s.cargo.length || s.cargoTouched)) res = pinCargo(res.text, s.cargo, file);
    for (const op of [...s.release, ...s.ops]) if ('text' in res) res = op(res.text);
    if ('error' in res) for (const e of s.edges) plan.errors.set(e, res.error);
    else plan.files.set(file, { before: before!, after: res.text });
  }
  return plan;
}

/**
 * The release edges of a job (a valid recorded release for the dependency, links, and a consumer PR
 * that is not MERGED) with their versions, and every dependency that has a valid recorded release:
 * none of its edges pins any more.
 */
function releaseInfo(edges: InterimEdge[], events: JobEvent[], job: Job): { releases: Map<InterimEdge, string>; released: Set<RepoKey> } {
  const releases = new Map<InterimEdge, string>();
  const released = new Set<RepoKey>();
  for (const e of edges) {
    const v = releasedVersion(events, e.dependency);
    if (v === null) continue;
    released.add(e.dependency);
    if (bumpsOnRelease(e, job)) releases.set(e, v);
  }
  return { releases, released };
}

/** A recorded release whose dependency's recorded PR is not MERGED: a forged record, so nothing is written for it. */
const unmergedRelease = (job: Job, e: InterimEdge, version: string): string | null =>
  prStateOf(job, e.dependency) === 'MERGED' ? null : `${repoLabel(e.dependency)}'s PR is not merged, yet a release ${version} is recorded`;

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
 * Every edge of the job with its git-dependent state filled in: `blocked` when a pin or bump can't be
 * written, `stale` when the consumer's manifest at its head does not carry the pin for the
 * dependency's head (or, for a release edge, the released version), `released` when a release
 * edge's manifests name it, `waiting` for a canary not yet published. `heads` are the commits to
 * judge (pr open passes the checked ones); by default each repo's HEAD now. No network call.
 */
export function interimStatus(root: string, config: Config, job: Job, heads?: Map<RepoKey, string>): { edges: InterimEdge[]; cycle: RepoKey[] | null } {
  const res = resolveInterim(config, job);
  const events = readEvents(root, job.id);
  const edges = res.edges.map((e) => ({ ...e }));
  const { releases, released } = releaseInfo(edges, events, job);
  if (!pinsAny(res.edges) && !releases.size && !released.size) return { edges: res.edges, cycle: res.cycle };
  const at = heads ?? currentHeads(root, config, job, res.order);
  for (const e of edges) {
    if (!released.has(e.dependency)) continue;
    const v = releasedVersion(events, e.dependency)!;
    if (!releases.has(e)) Object.assign(e, { state: 'released', detail: `release ${v} of ${repoLabel(e.dependency)} recorded; nothing to bump` });
    else {
      e.release = v;
      const err = unmergedRelease(job, e, v);
      Object.assign(e, err ? { state: 'blocked', detail: err } : { state: 'ready', detail: 'bump not checked yet' });
    }
  }
  for (const consumer of res.order) {
    const mine = edges.filter((e) => e.consumer === consumer && e.state !== 'blocked' && (releases.has(e) || (PIN_STRATEGIES.has(e.strategy) && !released.has(e.dependency))));
    if (!mine.length) continue;
    const cWt = repoWorktree(root, config, job, consumer);
    const cSha = at.get(consumer);
    if (!cWt || !cSha) {
      for (const e of mine) Object.assign(e, { state: 'blocked', detail: `${repoLabel(consumer)} has no worktree; run: forge worktree create ${job.id}` });
      continue;
    }
    const plan = planConsumer(root, config, job, consumer, mine, cWt, cSha, at, releases);
    for (const e of mine) {
      const err = plan.errors.get(e);
      if (err) {
        Object.assign(e, { state: 'blocked', detail: err });
        continue;
      }
      const moved = (plan.edgeFiles.get(e) ?? []).filter((f) => plan.files.get(f)?.after !== plan.files.get(f)?.before);
      const version = releases.get(e);
      if (version !== undefined) {
        Object.assign(
          e,
          moved.length
            ? { state: 'stale', detail: `${moved.join(', ')} in ${repoLabel(consumer)} does not name the released version ${version} of ${repoLabel(e.dependency)}; run: forge verify ${job.id}` }
            : { state: 'released', detail: `names the released version ${version} of ${repoLabel(e.dependency)}` },
        );
        continue;
      }
      const sha = at.get(e.dependency)!;
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
  /** The job has a git-ref or canary edge, or a release edge, so verify reports an `interim` step. */
  active: boolean;
  ok: boolean;
  problems: string[];
  /** `release` when the commit bumps a consumer to a recorded release (pins may ride along). */
  commits: { repo: RepoKey; sha: string; kind: 'pins' | 'release' }[];
}

// O_EXCL: two tracked paths that fold to one name (`package.json` and `PACKAGE.JSON` on APFS) fail
// instead of the second silently replacing the first, and a path planted ahead of a temp file is
// never reused. O_NOFOLLOW: never write through a link.
const EXPORT_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);

const tempSuffix = (): string => crypto.randomBytes(8).toString('hex');

/**
 * Writes `text` over `file` inside `worktree` through a random-named temp file in the manifest's real
 * parent, opened exclusive and no-follow, then renamed over it: a symlink at either path is replaced
 * or refused, never followed. The temp file is removed when anything after its creation fails.
 * `rand` exists for the test that plants a link at the temp path.
 */
export function writeManifest(worktree: string, rel: string, text: string, rand: () => string = tempSuffix): void {
  const file = path.join(worktree, rel);
  const parent = fs.realpathSync.native(path.dirname(file));
  const inside = path.relative(fs.realpathSync.native(worktree), parent);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new ForgeError(`${rel} resolves outside the worktree`);
  const tmp = path.join(parent, `.${path.basename(file)}.forge-${rand()}.tmp`);
  // A failed open created nothing of Forge's (EEXIST, ELOOP), so there is nothing to remove.
  const fd = fs.openSync(tmp, EXPORT_FLAGS, 0o600);
  try {
    try {
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(file);
    } catch {}
    if (st?.isFile()) fs.chmodSync(tmp, st.mode & 0o777);
    fs.renameSync(tmp, path.join(parent, path.basename(file)));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** The scrub `pr open` runs on a repo's branch, run here first so the sha a consumer pins is the one pushed. */
function scrubLikePrOpen(config: Config, worktree: string, base: string | null): void {
  if (!base || !SAFE_REF.test(base) || !SAFE_REF.test(String(config.git.remote))) return;
  const remoteBase = `${config.git.remote}/${base}`;
  const from = git(worktree, ['rev-parse', '--verify', '--quiet', remoteBase]).ok ? remoteBase : base;
  scrubBranch(worktree, from, 'HEAD', historyEnv());
}

const LOCKFILE_TIMEOUT_MS = 600_000;
const LOCKFILES: Record<string, string> = { cargo: 'Cargo.lock', npm: 'package-lock.json' };
const STATUS_Z = ['status', '--porcelain', '-z', '--untracked-files=normal', '--ignore-submodules=none'];

/** The tracked `name` in the manifest's directory or the nearest ancestor inside the repo, or null. */
function trackedLockfile(wt: string, manifest: string, name: string): string | null {
  let dir = path.posix.dirname(manifest.replace(/\\/g, '/'));
  for (;;) {
    const cand = dir === '.' ? name : `${dir}/${name}`;
    const ls = git(wt, ['--literal-pathspecs', 'ls-files', '-z', '--', cand]);
    if (ls.ok && ls.stdout.split('\0').includes(cand)) return cand;
    if (dir === '.' || dir === '/' || dir === '') return null;
    dir = path.posix.dirname(dir);
  }
}

const isRegularFile = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
};

/** The paths `git status` reports in `wt`, renames' sources included. */
function statusPaths(wt: string): string[] {
  const parts = git(wt, STATUS_Z).stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') out.push(parts[++i] ?? '');
  }
  return out.filter(Boolean);
}

/**
 * The lockfile refresh after a release bump wrote `written` in consumer `wt`: for each release link
 * whose manifest changed and that has a tracked lockfile, its fixed argv (lockfileArgv) with no
 * shell, then a check that nothing but the written manifests and lockfiles changed. Returns the
 * lockfiles to commit, or the step's failure and the lockfiles a tool may have touched.
 */
function refreshLockfiles(wt: string, consumer: RepoKey, plan: ConsumerPlan, written: Set<string>): { locks: string[] } | { error: string; touched: string[] } {
  const runs = new Map<string, { tool: string; argv: string[]; cwd: string; lock: string; label: string }>();
  for (const l of plan.releaseLinks) {
    if (!written.has(l.manifest) || !LOCKFILES[l.ecosystem]) continue;
    const lock = trackedLockfile(wt, l.manifest, LOCKFILES[l.ecosystem]);
    if (!lock) continue;
    const label = `${repoLabel(consumer)} on ${repoLabel(l.edge.dependency)} (release ${l.version})`;
    const a = lockfileArgv(l.ecosystem, l.name, l.version);
    if ('error' in a) return { error: `${label}: ${a.error}`, touched: [] };
    const cwd = l.ecosystem === 'cargo' ? path.posix.dirname(l.manifest.replace(/\\/g, '/')) : path.posix.dirname(lock);
    const key = [l.ecosystem, cwd, ...a.argv].join('\0');
    if (!runs.has(key)) runs.set(key, { tool: l.ecosystem, argv: a.argv, cwd, lock, label });
  }
  const locks = [...new Set([...runs.values()].map((r) => r.lock))];
  const touched: string[] = [];
  const env = gitEnv();
  let last: { tool: string; label: string } | null = null;
  for (const r of runs.values()) {
    last = r;
    if (!isRegularFile(path.join(wt, r.lock))) return { error: `${r.label}: ${r.lock} is not a regular file; Forge won't refresh it`, touched };
    const bin = findOnPath(r.tool, env);
    if (!bin) return { error: `${r.label}: ${r.tool} not found on PATH; it refreshes ${r.lock}`, touched };
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) return { error: `${r.label}: refresh ${r.lock} by hand: Forge runs no .cmd without a shell on native Windows`, touched };
    if (!touched.includes(r.lock)) touched.push(r.lock);
    const out = run(bin, r.argv, { cwd: path.join(wt, r.cwd), allowFail: true, timeoutMs: LOCKFILE_TIMEOUT_MS, env });
    if (!out.ok) {
      const why = out.status === null ? `did not finish (${out.stderr.trim().split('\n')[0].slice(0, 200)})` : `exited ${out.status}`;
      const tail = `${out.stderr}\n${out.stdout}`.trim().split('\n').slice(-20).join('\n');
      return { error: `${r.label}: ${r.tool} ${why}${tail ? `: ${tail}` : ''}`, touched };
    }
  }
  if (last) {
    const allowed = new Set([...written, ...locks]);
    const other = statusPaths(wt).find((p) => !allowed.has(p));
    if (other !== undefined) return { error: `${last.label}: ${last.tool} changed ${JSON.stringify(other).slice(0, 200)}, which is neither a written manifest nor its lockfile`, touched };
  }
  return { locks };
}

/** `files` in `wt` back to their text at `sha` (git objects only, written with writeManifest). */
function restoreAt(wt: string, sha: string, files: string[]): void {
  for (const rel of files) {
    const before = readAt(wt, sha, rel);
    if (before !== null && isRegularFile(path.join(wt, rel))) writeManifest(wt, rel, before);
  }
}

/**
 * Verify's pre-step: for each git-ref or canary edge, writes the consumer's pins for the
 * dependency's HEAD, and for each release edge the released version (refreshing a tracked lockfile),
 * and commits them in the consumer's worktree, dependencies first. Nothing is written when a
 * worktree involved is dirty (worktree-clean then fails the run) or when no content changes; a
 * failed lockfile refresh puts the consumer's files back. A release edge whose manifests name its
 * version logs `interim-bumped` once. A problem never throws: it becomes the `interim` step's failure.
 */
export function refreshInterim(root: string, config: Config, job: Job): InterimRefresh {
  const res = resolveInterim(config, job);
  const events = readEvents(root, job.id);
  const { releases, released } = releaseInfo(res.edges, events, job);
  if (!pinsAny(res.edges) && !releases.size) return { active: false, ok: true, problems: [], commits: [] };
  const problems: string[] = [];
  const commits: InterimRefresh['commits'] = [];
  if (res.cycle) problems.push(`the components' dependsOn form a cycle among ${res.cycle.map(repoLabel).join(', ')}: pins need a dependency order`);
  const pinEdges = res.edges.filter((e) => PIN_STRATEGIES.has(e.strategy) && !released.has(e.dependency));
  for (const e of pinEdges.filter((x) => x.state === 'blocked')) problems.push(`${repoLabel(e.consumer)} on ${repoLabel(e.dependency)} (${e.strategy}): ${e.detail}`);
  for (const [e, v] of releases) {
    const err = unmergedRelease(job, e, v);
    if (err && !problems.includes(err)) problems.push(err);
  }
  const live = pinEdges.filter((e) => e.state !== 'blocked');
  const relEdges = [...releases.keys()];
  const involved = [...new Set([...live.flatMap((e) => [e.consumer, e.dependency]), ...relEdges.map((e) => e.consumer)])];
  const worktrees = new Map<RepoKey, string>();
  for (const k of involved) {
    const wt = repoWorktree(root, config, job, k);
    if (wt) worktrees.set(k, wt);
    else problems.push(`${repoLabel(k)} has no worktree; run: forge worktree create ${job.id}`);
  }
  if (problems.length) return { active: true, ok: false, problems, commits };
  if ([...worktrees.values()].some((wt) => git(wt, [...STATUS_ARGV]).stdout.trim() !== '')) return { active: true, ok: true, problems, commits };
  // Only a pin's dependency is pushed at the sha it is pinned at; a release names a version instead.
  const deps = new Set(live.map((e) => e.dependency));
  const base = (k: RepoKey) => (k === null ? job.base : (memberEntry(job, k)?.base ?? null));
  try {
    for (const repo of res.order) {
      const wt = worktrees.get(repo);
      if (!wt) continue;
      // Before this repo's own pin commit, which carries no attribution: the scrub then leaves it alone at pr open.
      if (deps.has(repo) && attributionForbidden(config)) scrubLikePrOpen(config, wt, base(repo));
      const mine = [...live.filter((e) => e.consumer === repo), ...relEdges.filter((e) => e.consumer === repo)];
      if (!mine.length) continue;
      const heads = currentHeads(root, config, job, involved);
      const cSha = heads.get(repo);
      if (!cSha) {
        problems.push(`${repoLabel(repo)} has no HEAD commit`);
        continue;
      }
      const plan = planConsumer(root, config, job, repo, mine, wt, cSha, heads, releases);
      for (const [e, err] of plan.errors) problems.push(`${repoLabel(e.consumer)} on ${repoLabel(e.dependency)} (${releases.has(e) ? `release ${releases.get(e)}` : e.strategy}): ${err}`);
      if (plan.errors.size) continue;
      const changed = [...plan.files].filter(([, f]) => f.after !== f.before).map(([rel, f]) => ({ rel, after: f.after }));
      if (changed.length) {
        // Never written through: a tracked manifest that is a symlink stops the step.
        const link = changed.find((c) => !isRegularFile(path.join(wt, c.rel)));
        if (link) {
          problems.push(`${link.rel} in ${repoLabel(repo)} is not a regular file; Forge won't write through it`);
          continue;
        }
        for (const c of changed) writeManifest(wt, c.rel, c.after);
        const written = new Set(changed.map((c) => c.rel));
        const lock = refreshLockfiles(wt, repo, plan, written);
        if ('error' in lock) {
          restoreAt(wt, cSha, [...written, ...lock.touched]);
          problems.push(lock.error);
          continue;
        }
        const bump = mine.some((e) => releases.has(e) && (plan.edgeFiles.get(e) ?? []).some((f) => written.has(f)));
        const msg = [bump ? `forge: release bump for job ${job.id}` : `forge: interim pins for job ${job.id}`, '', ...plan.lines].join('\n');
        const paths = [...written, ...lock.locks];
        const c = git(wt, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '--only', '-m', msg, '--', ...paths], { write: true });
        if (!c.ok) {
          problems.push(`could not commit the ${bump ? 'release bump' : 'pins'} in ${repoLabel(repo)} (git exited ${c.status})`);
          continue;
        }
        commits.push({ repo, sha: headOf(wt) ?? '', kind: bump ? 'release' : 'pins' });
      }
      const sha = headOf(wt);
      for (const e of mine) {
        const v = releases.get(e);
        if (v === undefined || bumpedVersion(events, repo, e.dependency, releaseIndex(events, e.dependency)) === v) continue;
        logEvent(root, job.id, 'interim-bumped', { repo, dependency: e.dependency, version: v, sha });
      }
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
const PUBLISH_DAEMON_REFUSAL = 'forge job interim publish publishes a package from this job, which a daemon session may not do; a human runs it in their own session';

/** One package publishCanary would publish or did. */
export interface CanaryPackage {
  name: string;
  version: string;
  tag: 'canary';
  dir: string;
  skipped?: true;
}

/**
 * The name a case-insensitive, normalization-insensitive filesystem (APFS, HFS+, NTFS) would give one
 * path component: NFKC, case-folded, without default-ignorable code points (HFS+ drops them),
 * an NTFS stream suffix (`:$DATA`) or trailing dots and spaces (NTFS drops those).
 */
function foldName(component: string): string {
  const s = component
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/:.*$/s, '');
  // A loop, not /[. ]+$/: that regex retries from every dot or space and is quadratic on `. . . x`.
  let end = s.length;
  while (end > 0 && (s[end - 1] === '.' || s[end - 1] === ' ')) end--;
  return s.slice(0, end);
}

/**
 * Whether a tracked path is, or sits under, a file npm, yarn or pnpm could read as config: any
 * component whose folded name, leading dots dropped, starts with `npmrc`, `yarnrc` or `pnpmrc`
 * (`.npmrc`, `.NPMRC`, `.yarnrc.yml`, an 8.3 `NPMRC~1`). Over-matching refuses a publish a human can
 * redo by hand; under-matching could send the human's token to another registry.
 */
export function isPackageManagerConfig(rel: string): boolean {
  return rel.split(/[\\/]/).some((c) => /^(npm|yarn|pnpm)rc/.test(foldName(c).replace(/^\.+/, '')));
}

interface TreeEntry {
  mode: string;
  blob: string;
  path: string;
}

/** The blobs of `rel` at `sha` from git objects only, symlinks included (the caller refuses them). Submodules are left out. */
function treeEntries(cwd: string, sha: string, rel: string): TreeEntry[] {
  const spec = rel.replace(/\\/g, '/').replace(/\/+$/, '');
  const ls = runGit(cwd, ['ls-tree', '-r', '-z', '--full-tree', sha, '--', ...(spec === '.' ? [] : [spec])]);
  return ls.stdout.split('\0').filter(Boolean).flatMap((line) => {
    const m = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/s.exec(line);
    return m ? [{ mode: m[1], blob: m[2], path: m[3] }] : [];
  });
}

/**
 * Writes `entries` into `dir` from git objects only: no checkout, so no filter, hook or attribute in
 * the (builder-writable) repo config runs, and nothing untracked or ignored in the worktree ships.
 * Returns what it wrote, for the secret scan.
 */
function exportTree(cwd: string, entries: TreeEntry[], dir: string): { path: string; body: Buffer }[] {
  if (!entries.length) return [];
  const batch = gitSpawnSync(cwd, ['cat-file', '--batch'], { input: entries.map((e) => e.blob).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024 });
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
    try {
      const fd = fs.openSync(file, EXPORT_FLAGS, e.mode === '100755' ? 0o755 : 0o644);
      try {
        fs.writeFileSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err: any) {
      if (err?.code === 'EEXIST' || err?.code === 'ELOOP') throw new ForgeError(`${JSON.stringify(e.path).slice(0, 220)} collides with another tracked path in the export (this filesystem folds case or Unicode); Forge won't publish it`);
      throw err;
    }
    written.push({ path: e.path, body });
  }
  return written;
}

/**
 * Resumes a job parked at stage pr on one of `waits`, the way a human's approval of a parked gate
 * does: running, plus a `resume` request when the daemon is on and none is pending. Any other wait is left alone.
 */
function resumeJob(root: string, config: Config, id: string, reason: string, waits: WaitingOn[], text: string): boolean {
  const job = loadJob(root, id);
  if (!(job.stage === 'pr' && job.state === 'waiting' && job.waitingOn !== null && waits.includes(job.waitingOn))) return false;
  setJob(root, id, { state: 'running', waitingOn: null, reason });
  if (config.daemon?.enabled === true && !listRequests(root).some((r) => r.type === 'resume' && r.job === id && (r.status === 'pending' || r.status === 'in-progress')))
    enqueue(root, config, { type: 'resume', job: id, text, from: 'interim' });
  return true;
}

// Publishing runs on the human's npm credentials, so it needs a human at a terminal too: an agent's
// Bash tool has no TTY on stdin. A speed bump against a misled session, not a sandbox.
const PUBLISH_TTY_REFUSAL = 'forge job interim publish --confirm needs a human at a terminal (stdin is not a TTY); run it yourself in your own shell';

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
  const verified = verifiedSha(job, key);
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
  if (secretsBlock(scan.findings, mode)) throw new ForgeError(refusalMessage(`the commits of ${repoLabel(key)}`, scan.findings), 'secret_found', `forge secrets scan ${id}`);
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
    const link = entries.find((e) => e.mode === '120000');
    if (link) throw new ForgeError(`${repoLabel(key)} tracks the symlink ${JSON.stringify(link.path).slice(0, 220)} in the package ${name}; Forge publishes regular files only, so it won't publish it`);
    const rc = entries.find((e) => isPackageManagerConfig(e.path));
    if (rc) throw new ForgeError(`${repoLabel(key)} tracks ${JSON.stringify(rc.path).slice(0, 220)} in the package ${name}; npm would read it as config while publishing, so Forge won't publish it`);
    const odd = entries.find((e) => e.mode !== '100644' && e.mode !== '100755');
    if (odd) throw new ForgeError(`${repoLabel(key)} tracks ${JSON.stringify(odd.path).slice(0, 220)} with mode ${odd.mode} in the package ${name}; Forge publishes regular files only`);
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
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-canary-')));
    try {
      const tree = path.join(dir, 'tree');
      const prefix = path.join(dir, 'npm');
      fs.mkdirSync(tree, { mode: 0o700 });
      fs.mkdirSync(prefix, { mode: 0o700 });
      const files = exportTree(wt, trees.get(p.name)!, tree);
      const exported = scanFiles(root, config, files, { id });
      logSecrets(root, id, 'publish', exported, { blocked: mode === 'block' });
      if (secretsBlock(exported.findings, mode)) throw new ForgeError(refusalMessage(`the package ${p.name} of ${repoLabel(key)}`, exported.findings), 'secret_found', `forge secrets scan ${id}`);
      const pkgDir = path.join(tree, p.dir);
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
      // package's lifecycle scripts runs in the human's session. npm reads project config from its
      // local prefix, which is the package dir when it runs there; `--prefix` and the cwd move that
      // to an empty dir, so even a config file the name check missed is never read. The global
      // config moves with the prefix and is pinned to an empty file; the user config stays the
      // human's own (`~/.npmrc` or their `npm_config_userconfig`), which holds the token.
      const globalconfig = path.join(prefix, 'npmrc');
      fs.writeFileSync(globalconfig, '', { mode: 0o600, flag: 'wx' });
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!/^npm_config_(globalconfig|prefix|workspaces?|ignore_scripts|tag)$/i.test(k)) env[k] = v;
      env.npm_config_globalconfig = globalconfig;
      const r = run('npm', ['publish', pkgDir, '--ignore-scripts', '--workspaces=false', '--tag', 'canary', '--prefix', prefix], { cwd: prefix, env, allowFail: true });
      if (!r.ok) throw new ForgeError(`npm publish of ${p.name}@${p.version} exited ${r.status ?? 'without starting'}; nothing was recorded`, 'external');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    logEvent(root, id, 'canary-published', { repo: key, name: p.name, version: p.version, sha: head });
    published.push(p);
  }
  const resumed = resumeJob(root, config, id, `canary of ${repoLabel(key)} published: open the deferred PRs`, ['human'], 'forge job interim publish published the canary');
  return { id, repo: key, confirm: true, published, ...(resumed ? { resumed } : {}) };
}

// ---------- release record ----------

// A recorded release opens a held consumer's PR for review and merge, and bumps a pinned one to it: a
// session misled by tracker or PR text must never be the one that says the dependency shipped.
export const RELEASE_DAEMON_REFUSAL = "forge job interim release records a dependency's release, which a daemon session may not do; a human runs it in their own session";

/** What logging a release did: whether it was new, which consumers are clear or due a bump, and whether the job resumed. */
export interface ReleaseLogged {
  recorded: boolean;
  clear: RepoKey[];
  bump: RepoKey[];
  resumed: boolean;
}

/**
 * Logs `interim-released` for dependency `key` (null: the root) at `version`, for the two writers
 * (`forge job interim release` and a `--job` `forge release run`). Refused for a repo no edge
 * depends on, a version that is not semver or is a canary, and a dependency whose recorded PR is not
 * MERGED. Recording the version the latest valid record already holds logs nothing. Then resumes a
 * job parked on `pr-review` at stage pr, so step bumps the consumers (PR9).
 */
export function logRelease(root: string, config: Config, id: string, key: RepoKey, version: string, text = 'forge job interim release recorded the release'): ReleaseLogged {
  const job = loadJob(root, id);
  const edges = resolveInterim(config, job).edges;
  const mine = edges.filter((e) => e.dependency === key);
  if (!mine.length) throw new ForgeError(`${repoLabel(key)} is not the dependency of an edge on job ${id} (no edge depends on it)`);
  if (typeof version !== 'string' || version.length > 120 || !RELEASE_VERSION.test(version)) throw new ForgeError(`${JSON.stringify(String(version)).slice(0, 60)} is not a semver version (1.2.0, v1.2.0, 1.2.0-rc.1)`);
  if (/canary/i.test(version)) throw new ForgeError(`${JSON.stringify(version).slice(0, 60)} is a canary; a release gate clears only on a released version`);
  const pr = key === null ? job.pr : memberEntry(job, key)?.pr;
  if (pr?.state !== 'MERGED')
    throw new ForgeError(`${repoLabel(key)}'s PR is not merged (recorded state ${pr?.state ? String(pr.state).slice(0, 20) : 'none'}); a release comes from a merged change; run: forge pr sync ${id}`);
  const recorded = releasedVersion(readEvents(root, id), key) !== version;
  if (recorded) logEvent(root, id, 'interim-released', { repo: key, version });
  const gates = releaseGates(edges, readEvents(root, id), job);
  const consumers = [...new Set(mine.map((e) => e.consumer))];
  const clear = consumers.filter((c) => gates.filter((g) => g.consumer === c).every((g) => g.gate === 'released'));
  const bump = consumers.filter((c) => gates.some((g) => g.consumer === c && g.gate === 'bump-due'));
  const resumed = resumeJob(root, config, id, `release of ${repoLabel(key)} ${version} recorded: bump its consumers`, ['pr-review'], text);
  return { recorded, clear, bump, resumed };
}

/**
 * `forge job interim release`: records that dependency `key` (null: the root) of an edge of any
 * strategy was released as `version`. Refused in a daemon session, for a finished job and an unknown
 * repo, then as logRelease refuses. `clear` lists the consumers whose gates are all released, `bump`
 * the ones verify still has to bump to the version.
 */
export function recordRelease(root: string, config: Config, id: string, key: RepoKey, version: string): { id: string; repo: RepoKey; version: string; recorded: boolean; clear: RepoKey[]; bump: RepoKey[]; resumed?: true } {
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(RELEASE_DAEMON_REFUSAL);
  const job = loadJob(root, id);
  if (['done', 'cancelled'].includes(job.state)) throw new ForgeError(`job ${id} is ${job.state}; there is no release gate left to clear`);
  if (key !== null && !memberEntry(job, key)) throw new ForgeError(`job ${id} has no repo ${JSON.stringify(key).slice(0, 110)}`);
  const r = logRelease(root, config, id, key, version);
  return { id, repo: key, version, recorded: r.recorded, clear: r.clear, bump: r.bump, ...(r.resumed ? { resumed: true as const } : {}) };
}
