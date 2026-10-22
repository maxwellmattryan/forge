// Interim strategies: what a multi-repo job's consumer PR points at while its dependency's change is
// unmerged or unreleased (docs/CONFIG.md "Interim strategies"). Each dependency repo resolves to one
// of `local`, `sequential`, `git-ref` or `canary`: the job's override, then config, then `local`.
// Pure: no fs or git here, so lib/step/stages/pr.ts can import it. The git-dependent states (`stale`, and
// `ready` for git-ref and canary) and every write live in lib/interim-apply.ts.

import path from 'node:path';
import { INTERIM_STRATEGIES, isInterimStrategy, isLinkName } from '../../core/config/components.ts';
import { memberEntry } from '../project/job-repos.ts';
import { declaredLinks } from '../project/links.ts';
import type { DeclaredLink } from '../project/links.ts';
import { jobRepoOrder } from '../project/repo-order.ts';
import type { RepoKey } from '../project/repo-order.ts';
import type { Config, InterimStrategy, Job } from '../../core/types.ts';

export { INTERIM_STRATEGIES, isInterimStrategy };

/**
 * held (local), waiting, ready, blocked (can't be pinned or bumped), stale (the pin is not the
 * dependency's HEAD, or the manifests don't name its released version yet), released (they do).
 */
export type EdgeState = 'held' | 'waiting' | 'ready' | 'blocked' | 'stale' | 'released';

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
  /** A release edge (interimStatus): the dependency's recorded release the consumer is bumped to. */
  release?: string;
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
  // No pins left (every crate was released): the block goes, with the blank line it was appended after.
  if (!pins.length) {
    if (!block) return { text };
    const last = lines.slice(block.end + 1).every((l) => l.trim() === '');
    const from = last && block.begin > 0 && lines[block.begin - 1].trim() === '' ? block.begin - 1 : block.begin;
    return { text: [...lines.slice(0, from), ...lines.slice(block.end + 1)].join(eol) };
  }
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
 * case-insensitively) set to `value`. Zero or several matching declares, or zero or several GIT_TAGs, are refused.
 */
function setGitTag(text: string, name: string, value: string, file: string, what: 'pin' | 'release'): PinResult {
  const re = /\bFetchContent_Declare\s*\(/gi;
  const found: { tokens: Token[] }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const args = cmakeArgs(text, m.index + m[0].length - 1);
    if (!args) return { error: `${file} has an unclosed FetchContent_Declare(` };
    if (args.tokens.length && unquote(args.tokens[0].text).toLowerCase() === name.toLowerCase()) found.push(args);
    re.lastIndex = args.close + 1;
  }
  if (found.length !== 1) return { error: `${file} has ${found.length} FetchContent_Declare(${name} …) calls; the ${what} needs exactly one` };
  const tokens = found[0].tokens;
  const tags = tokens.flatMap((t, i) => (t.text === 'GIT_TAG' ? [i] : []));
  if (tags.length !== 1 || tags[0] + 1 >= tokens.length) return { error: `FetchContent_Declare(${name} …) in ${file} has ${tags.length} GIT_TAG arguments; the ${what} needs exactly one with a value` };
  const old = tokens[tags[0] + 1];
  return { text: text.slice(0, old.start) + value + text.slice(old.end) };
}

/** pinCmake: the GIT_TAG set to a full commit id. */
export function pinCmake(text: string, name: string, sha: string, file = 'CMakeLists.txt'): PinResult {
  if (!FULL_SHA.test(sha)) return { error: `not a commit id: ${JSON.stringify(sha).slice(0, 60)}` };
  return setGitTag(text, name, sha, file, 'pin');
}

/** The GIT_TAG set to a released version, kept exactly as recorded (`v1.2.0` stays `v1.2.0`): it names a tag. */
export function releaseCmake(text: string, name: string, tag: string, file = 'CMakeLists.txt'): PinResult {
  if (!isReleaseVersion(tag)) return { error: `not a released version: ${JSON.stringify(String(tag)).slice(0, 60)}` };
  return setGitTag(text, name, tag, file, 'release');
}

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/**
 * `text` (a package.json) with `name` set to `spec(old)` in every dependency section that has it,
 * indentation and the trailing newline kept. A file with no dependency on `name` is refused.
 */
function editNpm(text: string, name: string, file: string, spec: (old: unknown) => string): PinResult {
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
      sec[name] = spec(sec[name]);
      hits++;
    }
  }
  if (!hits) return { error: `${file} has no dependency on ${name}` };
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out = JSON.stringify(doc, null, indent).replace(/\n/g, eol);
  return { text: /\r?\n$/.test(text) ? out + eol : out };
}

/** `text` (a package.json) with `name` set to `spec` in every dependency section that has it. */
export function pinNpm(text: string, name: string, spec: string, file = 'package.json'): PinResult {
  return editNpm(text, name, file, () => spec);
}

const EXACT_SEMVER = /^\d{1,16}\.\d{1,16}\.\d{1,16}(?:-[0-9A-Za-z.-]{1,100})?(?:\+[0-9A-Za-z.-]{1,100})?$/;

/** A version's requirement core: no leading `v`, no `+build`. */
const releaseCore = (version: string): string => version.replace(/^v/, '').replace(/\+.*$/, '');

/**
 * The npm spec a released version replaces `old` with: `^`/`~` kept before a numeric range, the bare
 * core for an exact version, and `^core` for anything else (a git, canary, file or tag spec).
 */
export function npmReleaseSpec(old: unknown, version: string): string {
  const core = releaseCore(version);
  const s = typeof old === 'string' ? old.trim() : '';
  if (/^[\^~]\d/.test(s)) return `${s[0]}${core}`;
  if (EXACT_SEMVER.test(s) && !/canary/i.test(s)) return core;
  return `^${core}`;
}

/** Every dependency section of a package.json that has `name` set to the released version's spec. */
export function releaseNpm(text: string, name: string, version: string, file = 'package.json'): PinResult {
  if (!isReleaseVersion(version)) return { error: `not a released version: ${JSON.stringify(String(version)).slice(0, 60)}` };
  return editNpm(text, name, file, (old) => npmReleaseSpec(old, version));
}

const CARGO_DEP_TABLES = new Set(['dependencies', 'dev-dependencies', 'build-dependencies']);

/** Where the TOML string that opens at `at` (`"` or `'`) closes, or -1; one line only. */
function stringEnd(s: string, at: number): number {
  if (s[at] === "'") return s.indexOf("'", at + 1);
  for (let i = at + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

/** A TOML key at the start of `s` (bare, basic or literal string) and the text after it; null when there is none. */
function tomlKey(s: string): { key: string; rest: string } | null {
  if (s.startsWith('"') || s.startsWith("'")) {
    const end = stringEnd(s, 0);
    if (end < 0) return null;
    let key = s.slice(1, end);
    if (s[0] === '"') {
      try {
        key = JSON.parse(s.slice(0, end + 1));
      } catch {}
    }
    return { key, rest: s.slice(end + 1) };
  }
  const m = /^[A-Za-z0-9_-]{1,200}/.exec(s);
  return m ? { key: m[0], rest: s.slice(m[0].length) } : null;
}

/** The dotted keys of a `[table]` header line (trimmed); null for an array of tables or anything malformed. */
function tableHeader(t: string): string[] | null {
  if (!t.startsWith('[') || t.startsWith('[[')) return null;
  const segs: string[] = [];
  let s = t.slice(1);
  for (;;) {
    const k = tomlKey(s.trimStart());
    if (!k) return null;
    segs.push(k.key);
    s = k.rest.trimStart();
    if (s.startsWith('.')) s = s.slice(1);
    else return s.startsWith(']') ? segs : null;
  }
}

/** The top-level keys of the one-line inline table that opens at `open`, each with its value's offset, and its `}`; null when it does not close on the line. */
function inlineTable(line: string, open: number): { close: number; fields: Map<string, number> } | null {
  const fields = new Map<string, number>();
  let depth = 0;
  let expectKey = false;
  for (let i = open; i < line.length; ) {
    const c = line[i];
    if (depth === 1 && expectKey && !/\s/.test(c) && c !== '}') {
      const k = tomlKey(line.slice(i));
      const eq = k ? /^\s*=\s*/.exec(k.rest) : null;
      if (!k || !eq) return null;
      const at = line.length - k.rest.length + eq[0].length;
      fields.set(k.key, at);
      expectKey = false;
      i = at;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(line, i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (c === '#') return null;
    if (c === '{' || c === '[') {
      depth++;
      if (depth === 1) expectKey = true;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return { close: i, fields };
    } else if (c === ',' && depth === 1) expectKey = true;
    i++;
  }
  return null;
}

/**
 * `text` (a Cargo.toml) with every dependency entry for crate `name` set to the released version:
 * `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, `[workspace.dependencies]` and
 * `[target.*.dependencies]`, as a string, a one-line inline table's `version`, or a
 * `[dependencies.<name>]` subtable. A `=`, `^` or `~` operator is kept; `workspace = true` is left
 * alone. The Forge block is skipped (pinCargo owns it). Refused: a multi-line inline table, a dotted
 * `<name>.version` key, an entry with no version, and a file with no entry for the crate.
 */
export function releaseCargo(text: string, name: string, version: string, file = 'Cargo.toml'): PinResult {
  if (!isReleaseVersion(version)) return { error: `not a released version: ${JSON.stringify(String(version)).slice(0, 60)}` };
  const core = releaseCore(version);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const found = findBlock(lines, file);
  if (found && 'error' in found) return found;
  const block = found as { begin: number; end: number } | null;
  const req = (old: string) => `${/^\s*([=^~])/.exec(old)?.[1] ?? ''}${core}`;
  /** `line` with the string value at `at` set to the requirement, or null when no string starts there. */
  const setString = (line: string, at: number): string | null => {
    if (line[at] !== '"' && line[at] !== "'") return null;
    const end = stringEnd(line, at);
    if (end < 0) return null;
    return `${line.slice(0, at)}${line[at]}${req(line.slice(at + 1, end))}${line[at]}${line.slice(end + 1)}`;
  };
  const where = (i: number) => `${file}:${i + 1}`;
  let entry = false;
  let sub: { line: number; version: boolean; workspace: boolean } | null = null;
  let hits = 0;
  const closeSub = (): string | null => {
    const open = sub;
    sub = null;
    return open && !open.version && !open.workspace ? `${where(open.line)}: the [${name}] dependency table has no version` : null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if ((block && i >= block.begin && i <= block.end) || t.startsWith('[')) {
      const err = closeSub();
      if (err) return { error: err };
      const h = block && i >= block.begin && i <= block.end ? null : tableHeader(t);
      entry = Boolean(h && CARGO_DEP_TABLES.has(h.at(-1)!));
      if (h && h.length >= 2 && CARGO_DEP_TABLES.has(h.at(-2)!) && h.at(-1) === name) {
        sub = { line: i, version: false, workspace: false };
        hits++;
      }
      continue;
    }
    if ((!entry && !sub) || t === '' || t.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const k = tomlKey(line.slice(indent));
    if (!k) continue;
    const eq = /^\s*=\s*/.exec(k.rest);
    const at = line.length - k.rest.length + (eq ? eq[0].length : 0);
    if (sub) {
      if (!eq) continue;
      if (k.key === 'workspace' && /^true\b/.test(line.slice(at))) sub.workspace = true;
      if (k.key === 'version') {
        const next = setString(line, at);
        if (next === null) return { error: `${where(i)}: the version of ${name} is not a string` };
        lines[i] = next;
        sub.version = true;
      }
      continue;
    }
    if (k.key !== name) continue;
    if (/^\s*\./.test(k.rest)) return { error: `${where(i)} sets ${name} with a dotted key; write it as ${name} = { version = … } for Forge to bump it` };
    if (!eq) continue;
    hits++;
    if (line[at] === '{') {
      const tbl = inlineTable(line, at);
      if (!tbl) return { error: `${where(i)}: the ${name} entry is a multi-line inline table; put it on one line for Forge to bump it` };
      const ws = tbl.fields.get('workspace');
      if (ws !== undefined && /^true\b/.test(line.slice(ws))) continue;
      const v = tbl.fields.get('version');
      if (v === undefined) return { error: `${where(i)}: the ${name} entry has no version` };
      const next = setString(line, v);
      if (next === null) return { error: `${where(i)}: the version of ${name} is not a string` };
      lines[i] = next;
      continue;
    }
    const next = setString(line, at);
    if (next === null) return { error: `${where(i)}: the ${name} entry is neither a version string nor an inline table` };
    lines[i] = next;
  }
  const err = closeSub();
  if (err) return { error: err };
  if (!hits) return { error: `${file} has no dependency on ${name}` };
  return { text: lines.join(eol) };
}

/**
 * The lockfile refresh's argv after a release (run with no shell): `cargo update -p <name> --precise
 * <core>` or `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`. Refused for a
 * name that is no link name or starts with `-` (an option to cargo) and a version that is no release.
 */
export function lockfileArgv(ecosystem: string, name: string, version: string): { argv: string[] } | { error: string } {
  if (ecosystem !== 'cargo' && ecosystem !== 'npm') return { error: `${ecosystem} has no lockfile Forge refreshes` };
  if (!isLinkName(ecosystem, name) || name.startsWith('-')) return { error: `${JSON.stringify(String(name)).slice(0, 80)} is not a ${ecosystem} name Forge passes to a lockfile refresh` };
  if (!isReleaseVersion(version) || releaseCore(version).startsWith('-')) return { error: `${JSON.stringify(String(version)).slice(0, 60)} is not a released version` };
  return ecosystem === 'cargo' ? { argv: ['update', '-p', name, '--precise', releaseCore(version)] } : { argv: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'] };
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
const canaryPublished = (events: { type: string; repo?: unknown; version?: unknown }[], repo: RepoKey, version: string | undefined): boolean =>
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

type ReleaseEvent = { type: string; repo?: unknown; version?: unknown; dependency?: unknown };

const isRelease = (x: ReleaseEvent, repo: RepoKey): boolean => x.type === 'interim-released' && isRepoKey(x.repo) && x.repo === repo && isReleaseVersion(x.version);

/** Where the latest valid `interim-released` event for dependency `repo` sits in `events`, or -1. */
export const releaseIndex = (events: ReleaseEvent[], repo: RepoKey): number => events.findLastIndex((x) => isRelease(x, repo));

/**
 * The version the latest valid `interim-released` event records for dependency `repo`, or null.
 * events.jsonl is writable outside the CLI, so every record is checked and a malformed one is ignored.
 */
export function releasedVersion(events: ReleaseEvent[], repo: RepoKey): string | null {
  const i = releaseIndex(events, repo);
  return i < 0 ? null : (events[i].version as string);
}

/**
 * The version of the latest valid `interim-bumped` event for (consumer, dependency) after index
 * `afterIndex` (events.jsonl order), or null. Every field is checked, as for a release record.
 */
export function bumpedVersion(events: ReleaseEvent[], consumer: RepoKey, dependency: RepoKey, afterIndex: number): string | null {
  for (let i = events.length - 1; i > afterIndex && i >= 0; i--) {
    const x = events[i];
    if (x.type === 'interim-bumped' && isRepoKey(x.repo) && x.repo === consumer && isRepoKey(x.dependency) && x.dependency === dependency && isReleaseVersion(x.version)) return x.version;
  }
  return null;
}

/**
 * One edge's release gate. With no recorded release: `ci` for git-ref and canary (the seeded
 * release-gate check fails while the pin remains), `held` for local and sequential. With a recorded
 * release: `bump-due` while the edge has links, the consumer's PR is not merged and no
 * `interim-bumped` for that version came after the record; otherwise `released`.
 */
export interface ReleaseGate {
  consumer: RepoKey;
  dependency: RepoKey;
  strategy: InterimStrategy;
  gate: 'ci' | 'held' | 'bump-due' | 'released';
  version?: string;
}

/** A job repo's recorded PR state, from the job record (null: the root). */
export const prStateOf = (job: Pick<Job, 'pr' | 'repos'>, key: RepoKey): unknown => (key === null ? job.pr?.state : memberEntry(job, key)?.pr?.state);

/** Whether an edge's consumer is bumped to a recorded release: it has links and an unmerged PR. */
export const bumpsOnRelease = (e: { consumer: RepoKey; links?: unknown[] }, job: Pick<Job, 'pr' | 'repos'> | undefined): boolean =>
  Boolean(e.links?.length) && (job ? prStateOf(job, e.consumer) !== 'MERGED' : true);

export function releaseGates(edges: (Pick<InterimEdge, 'consumer' | 'dependency' | 'strategy'> & { links?: InterimEdge['links'] })[], events: ReleaseEvent[], job?: Pick<Job, 'pr' | 'repos'>): ReleaseGate[] {
  return edges.map((e) => {
    const { consumer, dependency, strategy } = e;
    const at = releaseIndex(events, dependency);
    if (at < 0) return { consumer, dependency, strategy, gate: strategy === 'git-ref' || strategy === 'canary' ? ('ci' as const) : ('held' as const) };
    const version = events[at].version as string;
    const due = bumpsOnRelease(e, job) && bumpedVersion(events, consumer, dependency, at) !== version;
    return { consumer, dependency, strategy, gate: due ? ('bump-due' as const) : ('released' as const), version };
  });
}

/** The consumers with a held or bump-due gate: their PRs stay drafts, and Forge never readies or merges them. */
export const heldConsumers = (gates: ReleaseGate[]): Set<RepoKey> => new Set(gates.filter((g) => g.gate === 'held' || g.gate === 'bump-due').map((g) => g.consumer));
