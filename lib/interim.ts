// Interim strategies: what a multi-repo job's consumer PR points at while its dependency's change is
// unmerged or unreleased (docs/CONFIG.md "Interim strategies"). Each dependency repo resolves to one
// of `local`, `sequential`, `git-ref` or `canary`: the job's override, then config, then `local`.
// Pure: no fs or git here, so lib/step.ts can import it. The git-dependent states (`stale`, and
// `ready` for git-ref and canary) and every write live in lib/interim-apply.ts.

import path from 'node:path';
import { INTERIM_STRATEGIES, isInterimStrategy } from './components.ts';
import { memberEntry } from './job-repos.ts';
import { declaredLinks } from './links.ts';
import type { DeclaredLink } from './links.ts';
import { jobRepoOrder } from './repo-order.ts';
import type { RepoKey } from './repo-order.ts';
import type { Config, InterimStrategy, Job } from './types.ts';

export { INTERIM_STRATEGIES, isInterimStrategy };

/** held (local), waiting, ready, blocked (can't be pinned), stale (the pin is not the dependency's HEAD). */
export type EdgeState = 'held' | 'waiting' | 'ready' | 'blocked' | 'stale';

/** One (consumer, dependency) pair of a job's PR repos: `forge job interim`. */
export interface InterimEdge {
  consumer: RepoKey;
  dependency: RepoKey;
  strategy: InterimStrategy;
  source: 'job' | 'config';
  links: DeclaredLink[];
  state: EdgeState;
  detail: string;
  /** A waiting canary edge: the package and version not published yet. */
  canary?: { name: string; version: string };
}

export interface InterimResolution {
  edges: InterimEdge[];
  /** The job's PR repos, dependencies first (jobRepoOrder). */
  order: RepoKey[];
  /** The repos left in a dependsOn cycle; null when there is none. */
  cycle: RepoKey[] | null;
}

/** A full commit id (sha1 or sha256): the only revision a pin or a publish accepts. */
export const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** `repo lib`, or `the root repo`: how prose names a repo key. */
export const repoLabel = (key: RepoKey): string => (key === null ? 'the root repo' : `repo ${key}`);

/** The strategy a dependency repo resolves to, and where it came from. */
export function strategyOf(config: Pick<Config, 'release' | 'repos'>, job: Pick<Job, 'interim' | 'repos'>, repo: RepoKey): { strategy: InterimStrategy; source: 'job' | 'config' } {
  const override = repo === null ? (job.interim ?? job.repos?.[0]?.interim) : memberEntry(job, repo)?.interim;
  if (isInterimStrategy(override)) return { strategy: override, source: 'job' };
  const configured = repo === null ? config.release?.interim : (Array.isArray(config.repos) ? config.repos : []).find((r) => r?.name === repo)?.release?.interim;
  return { strategy: isInterimStrategy(configured) ? configured : 'local', source: 'config' };
}

/** Whether a link's dependency dir is its repo's root: npm installs a git dependency only from there. */
const atRepoRoot = (relPath: string): boolean => path.posix.normalize(relPath.replace(/\\/g, '/')).replace(/\/+$/, '') === '.';

/** The state an edge has before any git is read; git-ref and canary edges that pass read `ready` until interimStatus checks them. */
function pureState(job: Pick<Job, 'pr' | 'repos'>, e: Omit<InterimEdge, 'state' | 'detail'>): Pick<InterimEdge, 'state' | 'detail'> {
  const d = repoLabel(e.dependency);
  if (e.strategy === 'local') return { state: 'held', detail: `${repoLabel(e.consumer)}'s PR opens as a draft (interim: local)` };
  if (e.strategy === 'sequential') {
    const pr = e.dependency === null ? job.pr : memberEntry(job, e.dependency)?.pr;
    if (!pr?.number) return { state: 'waiting', detail: `${d} has no PR yet` };
    const name = `${d} PR #${Number(pr.number)}`;
    return pr.state === 'MERGED' ? { state: 'ready', detail: `${name} merged` } : { state: 'waiting', detail: `${name} is not merged` };
  }
  if (!e.links.length) return { state: 'blocked', detail: `no dependsOn link joins ${repoLabel(e.consumer)} to ${d}; ${e.strategy} needs one to pin` };
  for (const l of e.links) {
    if (e.strategy === 'canary' && l.ecosystem !== 'npm') return { state: 'blocked', detail: `canary is npm-only: the ${l.ecosystem} link ${l.name} can't take one` };
    if (e.strategy === 'git-ref' && l.ecosystem === 'npm' && !atRepoRoot(l.relPath)) return { state: 'blocked', detail: `npm installs a git dependency only from its repo's root, and ${l.name} is at ${l.relPath} in ${d}` };
    if (l.manifest === null) return { state: 'blocked', detail: `the consumer component ${l.consumer} has no usable path for its manifest` };
  }
  return { state: 'ready', detail: 'pin not checked yet' };
}

/**
 * Every edge of the job, in merge order of the consumer then of the dependency, with its strategy
 * and the states that need no git. Never throws: config is hand-edited and validation reports it.
 */
export function resolveInterim(config: Pick<Config, 'components' | 'repos' | 'release'>, job: Pick<Job, 'interim' | 'repos' | 'pr'>): InterimResolution {
  const { order, deps, cycle } = jobRepoOrder(config, job);
  const links = declaredLinks(config);
  const edges: InterimEdge[] = [];
  for (const consumer of order) {
    for (const dependency of order.filter((d) => (deps.get(consumer) ?? []).includes(d))) {
      const { strategy, source } = strategyOf(config, job, dependency);
      const base = { consumer, dependency, strategy, source, links: links.filter((l) => l.consumerRepo === consumer && l.dependencyRepo === dependency) };
      edges.push({ ...base, ...pureState(job, base) });
    }
  }
  return { edges, order, cycle };
}

/** Whether any edge pins (git-ref or canary): only then does verify commit pins or report an `interim` step. */
export const pinsAny = (edges: InterimEdge[]): boolean => edges.some((e) => e.strategy === 'git-ref' || e.strategy === 'canary');

const SEMVER_CORE = /^v?(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})(?:[-+][0-9A-Za-z.+-]{0,200})?$/;

/**
 * `<major>.<minor>.<patch>-canary.<sha12>` from a package version and the verified sha, any
 * prerelease or build suffix dropped. An all-digit sha12 gets a `g` so it is no numeric identifier
 * (which semver forbids with a leading zero). Null when either input is not what it should be.
 */
export function canaryVersion(pkgVersion: unknown, sha: unknown): string | null {
  if (typeof pkgVersion !== 'string' || typeof sha !== 'string' || !FULL_SHA.test(sha)) return null;
  const m = SEMVER_CORE.exec(pkgVersion.trim());
  if (!m) return null;
  const sha12 = sha.slice(0, 12);
  return `${m[1]}.${m[2]}.${m[3]}-canary.${/^\d+$/.test(sha12) ? `g${sha12}` : sha12}`;
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\//;
// user@host:path, or host:path; never a drive letter, and the path never starts with `/` twice.
const SCP_LIKE = /^(?:([A-Za-z0-9._~-]{1,100})@)?([A-Za-z0-9.-]{2,253}):(?!\/\/)([^\s]{1,2000})$/;

/**
 * A remote as a URL git, cargo and npm all accept: an absolute path becomes `file://<path>`, an
 * scp-like `user@host:path` becomes `ssh://user@host/path`, and a URL is kept without its
 * credentials (the result is committed). Null for anything else (a relative path).
 */
export function remoteUrl(remote: string): string | null {
  if (!remote || /[\s\u0000-\u001f\u007f]/.test(remote) || remote.startsWith('-')) return null;
  if (URL_SCHEME.test(remote)) return withoutCredentials(remote);
  if (remote.startsWith('/')) return `file://${remote}`;
  if (/^[A-Za-z]:[\\/]/.test(remote)) return `file:///${remote.replace(/\\/g, '/')}`;
  const scp = SCP_LIKE.exec(remote);
  if (scp) return `ssh://${scp[1] ? `${scp[1]}@` : ''}${scp[2]}/${scp[3].replace(/^\/+/, '')}`;
  return null;
}

/**
 * A URL's userinfo dropped through the last `@` of its authority, so a raw `@` in a password can't
 * leave the rest of it behind. Outside http(s) a bare user name stays (`ssh://git@host` needs it and
 * it is no secret); a password never does, under any scheme.
 */
function withoutCredentials(url: string): string {
  const scheme = URL_SCHEME.exec(url)![0];
  const rest = url.slice(scheme.length);
  const end = rest.search(/[/?#]/);
  const at = (end === -1 ? rest : rest.slice(0, end)).lastIndexOf('@');
  if (at === -1) return url;
  const user = rest.slice(0, at);
  const keep = !/^(git\+)?https?:\/\/$/i.test(scheme) && /^[A-Za-z0-9._~-]{1,100}$/.test(user) ? `${user}@` : '';
  return `${scheme}${keep}${rest.slice(at + 1)}`;
}

/** npm's git dependency spec for a remote at a sha: `git+<url>#<sha>`, null when the remote has no URL form. */
export function npmGitSpec(remote: string, sha: string): string | null {
  const url = remoteUrl(remote);
  if (url === null || !FULL_SHA.test(sha)) return null;
  return `${url.startsWith('git+') ? url : `git+${url}`}#${sha}`;
}

export type PinResult = { text: string } | { error: string };

export const BLOCK_BEGIN = '# forge:interim begin';
export const BLOCK_END = '# forge:interim end';

/** One `[patch.<source>]` entry pinCargo writes: a crate at a git rev. */
export interface CargoPin {
  source: string;
  name: string;
  git: string;
  rev: string;
}

/** The key after `patch.` on a TOML line (a bare key, or a basic or literal string), or null. */
function patchKey(rest: string): string | null {
  const s = rest.trimStart();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end < 0) return null;
    try {
      return JSON.parse(s.slice(0, end + 1));
    } catch {
      return s.slice(1, end);
    }
  }
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    return end < 0 ? null : s.slice(1, end);
  }
  const m = /^[A-Za-z0-9_-]{1,200}/.exec(s);
  return m ? m[0] : null;
}

/** The `[patch.<key>]` header, or `patch.<key>.` dotted key, a line opens; null for any other line. */
function patchSourceOf(line: string): string | null {
  const t = line.trim();
  const header = /^\[\s*patch\s*\./.exec(t);
  if (header) return patchKey(t.slice(header[0].length));
  const dotted = /^patch\s*\./.exec(t);
  if (dotted) return patchKey(t.slice(dotted[0].length));
  return null;
}

/** Where the Forge block sits in `lines`, or an error for a broken or repeated one. */
function findBlock(lines: string[], file: string): { begin: number; end: number } | null | { error: string } {
  const begins = lines.flatMap((l, i) => (l.trim() === BLOCK_BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === BLOCK_END ? [i] : []));
  if (!begins.length && !ends.length) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return { error: `${file} has a broken or repeated ${BLOCK_BEGIN} / ${BLOCK_END} block` };
  return { begin: begins[0], end: ends[0] };
}

/**
 * `text` (a Cargo.toml) with one Forge block holding a `[patch."<source>"]` table per source and
 * `"<name>" = { git = "<url>", rev = "<sha>" }` per crate, sorted. The block replaces an existing
 * one in place, or goes at the end. TOML can't open a table twice, so a `[patch]` table for the same
 * source outside the block is refused rather than merged. JSON strings are TOML basic strings.
 */
export function pinCargo(text: string, pins: CargoPin[], file = 'Cargo.toml'): PinResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const found = findBlock(lines, file);
  if (found && 'error' in found) return found;
  const block = found as { begin: number; end: number } | null;
  const sources = new Map<string, Map<string, CargoPin>>();
  for (const p of pins) {
    if (!FULL_SHA.test(p.rev)) return { error: `not a commit id: ${JSON.stringify(p.rev).slice(0, 60)}` };
    if (!sources.has(p.source)) sources.set(p.source, new Map());
    sources.get(p.source)!.set(p.name, p);
  }
  for (let i = 0; i < lines.length; i++) {
    if (block && i >= block.begin && i <= block.end) continue;
    const src = patchSourceOf(lines[i]);
    if (src !== null && sources.has(src)) return { error: `${file} has [patch.${JSON.stringify(src)}] outside the Forge block` };
  }
  const body = [BLOCK_BEGIN];
  for (const src of [...sources.keys()].sort()) {
    body.push(`[patch.${JSON.stringify(src)}]`);
    const names = sources.get(src)!;
    for (const n of [...names.keys()].sort()) {
      const p = names.get(n)!;
      body.push(`${JSON.stringify(n)} = { git = ${JSON.stringify(p.git)}, rev = ${JSON.stringify(p.rev)} }`);
    }
  }
  body.push(BLOCK_END);
  if (block) return { text: [...lines.slice(0, block.begin), ...body, ...lines.slice(block.end + 1)].join(eol) };
  const trailing = lines.at(-1) === '';
  const head = trailing ? lines.slice(0, -1) : lines;
  const sep = head.length && head.at(-1)!.trim() !== '' ? [''] : [];
  return { text: [...head, ...sep, ...body, ''].join(eol) };
}

/** A CMake token: its text and where it sits in the source. */
interface Token {
  text: string;
  start: number;
  end: number;
}

/** The argument tokens of the command whose `(` is at `open`, and the index of its `)`; null when unclosed. */
function cmakeArgs(text: string, open: number): { tokens: Token[]; close: number } | null {
  const tokens: Token[] = [];
  let depth = 0;
  let i = open + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) return { tokens, close: i };
      depth--;
      i++;
      continue;
    }
    const start = i;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
    } else {
      while (i < text.length && !/[\s()#"]/.test(text[i])) i++;
    }
    tokens.push({ text: text.slice(start, i), start, end: i });
  }
  return null;
}

const unquote = (t: string): string => (t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1) : t);

/**
 * `text` with the one `GIT_TAG <value>` of the one `FetchContent_Declare(<name> …)` (name matched
 * case-insensitively) set to `sha`. Zero or several matching declares, or zero or several GIT_TAGs, are refused.
 */
export function pinCmake(text: string, name: string, sha: string, file = 'CMakeLists.txt'): PinResult {
  if (!FULL_SHA.test(sha)) return { error: `not a commit id: ${JSON.stringify(sha).slice(0, 60)}` };
  const re = /\bFetchContent_Declare\s*\(/gi;
  const found: { tokens: Token[] }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const args = cmakeArgs(text, m.index + m[0].length - 1);
    if (!args) return { error: `${file} has an unclosed FetchContent_Declare(` };
    if (args.tokens.length && unquote(args.tokens[0].text).toLowerCase() === name.toLowerCase()) found.push(args);
    re.lastIndex = args.close + 1;
  }
  if (found.length !== 1) return { error: `${file} has ${found.length} FetchContent_Declare(${name} …) calls; the pin needs exactly one` };
  const tokens = found[0].tokens;
  const tags = tokens.flatMap((t, i) => (t.text === 'GIT_TAG' ? [i] : []));
  if (tags.length !== 1 || tags[0] + 1 >= tokens.length) return { error: `FetchContent_Declare(${name} …) in ${file} has ${tags.length} GIT_TAG arguments; the pin needs exactly one with a value` };
  const value = tokens[tags[0] + 1];
  return { text: text.slice(0, value.start) + sha + text.slice(value.end) };
}

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/**
 * `text` (a package.json) with `name` set to `spec` in every dependency section that has it,
 * indentation and the trailing newline kept. A file with no dependency on `name` is refused.
 */
export function pinNpm(text: string, name: string, spec: string, file = 'package.json'): PinResult {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return { error: `${file} is not valid JSON` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: `${file} is not a JSON object` };
  let hits = 0;
  for (const s of NPM_SECTIONS) {
    const sec = doc[s];
    if (sec && typeof sec === 'object' && !Array.isArray(sec) && Object.prototype.hasOwnProperty.call(sec, name)) {
      sec[name] = spec;
      hits++;
    }
  }
  if (!hits) return { error: `${file} has no dependency on ${name}` };
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = JSON.stringify(doc, null, indent).replace(/\n/g, eol);
  return { text: /\r?\n$/.test(text) ? out + eol : out };
}

// ---------- deferred PRs ----------

/** A repo `pr open` held back: its PR opens once `waitingOn` merged (sequential) or the canary is published. */
export interface Deferral {
  repo: RepoKey;
  why: 'sequential' | 'canary';
  waitingOn: RepoKey[];
  /** canary only: the version the consumer pins, and its package. */
  version?: string;
  name?: string;
}

const isRepoKey = (v: unknown): v is RepoKey => v === null || (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v));

/** A `pr-deferred` event's list, every entry checked (events.jsonl is writable outside the CLI); malformed entries are dropped. */
export function readDeferrals(raw: unknown): Deferral[] {
  if (!Array.isArray(raw)) return [];
  const out: Deferral[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const { repo, why, waitingOn, version, name } = d as Record<string, unknown>;
    if (!isRepoKey(repo) || (why !== 'sequential' && why !== 'canary') || !Array.isArray(waitingOn) || !waitingOn.length || !waitingOn.every(isRepoKey)) continue;
    if (why === 'canary' && (typeof version !== 'string' || typeof name !== 'string')) continue;
    out.push({ repo, why, waitingOn, ...(why === 'canary' ? { version: version as string, name: name as string } : {}) });
  }
  return out;
}

/** The latest open attempt (`pr-opened`, `pr-updated` or `pr-deferred`) when it is a `pr-deferred`, else null. */
export function pendingDeferral<E extends { type: string }>(events: E[]): E | null {
  const last = events.findLast((e) => e.type === 'pr-opened' || e.type === 'pr-updated' || e.type === 'pr-deferred');
  return last?.type === 'pr-deferred' ? last : null;
}

/** Whether a `canary-published` event records `version` for dependency `repo`. */
export const canaryPublished = (events: { type: string; repo?: unknown; version?: unknown }[], repo: RepoKey, version: string | undefined): boolean =>
  events.some((e) => e.type === 'canary-published' && (e.repo ?? null) === repo && e.version === version);

/**
 * Where a deferral stands: the first canary still unpublished, the first sequential entry whose
 * dependencies have not all merged (per `state`), and whether every entry can open now.
 */
export function deferralStatus(deferred: Deferral[], state: (repo: RepoKey) => string | null | undefined, events: { type: string; repo?: unknown; version?: unknown }[]): { canary: Deferral | null; sequential: Deferral | null; openable: boolean } {
  const canary = deferred.find((d) => d.why === 'canary' && !canaryPublished(events, d.waitingOn[0], d.version)) ?? null;
  const sequential = deferred.find((d) => d.why === 'sequential' && !d.waitingOn.every((w) => state(w) === 'MERGED')) ?? null;
  return { canary, sequential, openable: deferred.length > 0 && !canary && !sequential };
}

// ---------- release gates ----------

/** A released version `forge job interim release` records: semver, an optional `v`, never a canary. */
export const RELEASE_VERSION = /^v?(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})(?:-[0-9A-Za-z.-]{1,100})?(?:\+[0-9A-Za-z.-]{1,100})?$/;

/** Whether `v` is a version a release record may carry (RELEASE_VERSION, at most 120 chars, no `canary`). */
export const isReleaseVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= 120 && RELEASE_VERSION.test(v) && !/canary/i.test(v);

type ReleaseEvent = { type: string; repo?: unknown; version?: unknown };

/**
 * The version the latest valid `interim-released` event records for dependency `repo`, or null.
 * events.jsonl is writable outside the CLI, so every record is checked and a malformed one is ignored.
 */
export function releasedVersion(events: ReleaseEvent[], repo: RepoKey): string | null {
  const e = events.findLast((x) => x.type === 'interim-released' && isRepoKey(x.repo) && x.repo === repo && isReleaseVersion(x.version));
  return e ? (e.version as string) : null;
}

/**
 * One edge's release gate: `ci` for git-ref and canary (the seeded release-gate check fails while the
 * pin remains), `held` for local and sequential until the dependency's release is recorded, then
 * `released` with its version.
 */
export interface ReleaseGate {
  consumer: RepoKey;
  dependency: RepoKey;
  strategy: InterimStrategy;
  gate: 'ci' | 'held' | 'released';
  version?: string;
}

export function releaseGates(edges: Pick<InterimEdge, 'consumer' | 'dependency' | 'strategy'>[], events: ReleaseEvent[]): ReleaseGate[] {
  return edges.map(({ consumer, dependency, strategy }) => {
    if (strategy === 'git-ref' || strategy === 'canary') return { consumer, dependency, strategy, gate: 'ci' as const };
    const version = releasedVersion(events, dependency);
    return version === null ? { consumer, dependency, strategy, gate: 'held' as const } : { consumer, dependency, strategy, gate: 'released' as const, version };
  });
}

/** The consumers with at least one held gate: their PRs stay drafts, and Forge never readies or merges them. */
export const heldConsumers = (gates: ReleaseGate[]): Set<RepoKey> => new Set(gates.filter((g) => g.gate === 'held').map((g) => g.consumer));
