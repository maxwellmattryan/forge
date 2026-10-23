// `forge release plan`: each repo's release strategy (lib/core/config/release-strategy.ts) and the repo graph
// turned into an ordered plan of checkable steps with rollback (docs/RELEASES.md "Releasing a
// project"). Planning only reads: local git, the manifests and config. It never runs a release
// command, a registry command or `git fetch`. lib/engine/release/run.ts executes the plan, and recomputes
// it here first rather than trusting release.json, which an agent session could have edited.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '#core/config/load.ts';
import { git as runGit } from '#integrations/git/runner.ts';
import { resolveInterim } from './interim.ts';
import { loadJob } from '#core/job/store.ts';
import { memberCheck, readLocalConfig, resolveMemberPath, shellWord } from '../project/member-repos.ts';
import { paths } from '#core/paths.ts';
import { memberRepos } from '../project/job-repos.ts';
import { prRepos, repoOrder, type RepoKey } from '../project/repo-order.ts';
import { validJobId } from '#core/job/requests.ts';
import type { Config, ReleaseCadence, ReleaseMechanism, ReleaseRegistry, ReleaseStrategy } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { writeJsonAtomic, writeTextAtomic } from '#core/os/fs.ts';
import { assertSafeRef, fenced, safeText } from '#core/text.ts';
import { now } from '#core/utils.ts';

/** The release.json and state.json format; a file of any other version is planned again, never read. */
export const RELEASE_FILE_VERSION = 1;

const CHECK_KINDS = ['ready', 'clean', 'tagged', 'tag-pushed', 'remote-tagged', 'at-remote', 'registry'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export type ReleaseSelection = { kind: 'job'; job: string } | { kind: 'since'; tag: string } | { kind: 'all' };

export interface ReleaseStep {
  /** `<label>/<kind>`. */
  id: string;
  repo: RepoKey;
  kind: string;
  title: string;
  /** Program and arguments, run without a shell; the program word is resolved on PATH at run time. */
  argv: string[] | null;
  /** The tag mechanism's `release.command`, run as `<posixShell()> -lc <shell>`. */
  shell: string | null;
  /** What a human does by hand (release-please's merge). */
  manual: string | null;
  /** Outward-facing: pushes, publishes or tags. */
  publish: boolean;
  check: CheckKind | null;
  /** Why a registry step has no check, when it would have one. */
  note?: string;
}

export interface ReleasePackage {
  ecosystem: 'npm' | 'cargo';
  name: string;
}

export interface ReleaseRepo {
  repo: RepoKey;
  label: string;
  dir: string;
  mechanism: ReleaseMechanism;
  registry: ReleaseRegistry | null;
  cadence: ReleaseCadence | null;
  version: string | null;
  package: ReleasePackage | null;
  steps: ReleaseStep[];
  rollback: string[];
}

export interface ReleaseSkip {
  repo: RepoKey;
  label: string;
  reason: string;
}

export interface ReleasePlan {
  version: typeof RELEASE_FILE_VERSION;
  hash: string;
  createdAt: string;
  selection: ReleaseSelection;
  order: string[];
  relaxed: boolean;
  repos: ReleaseRepo[];
  skipped: ReleaseSkip[];
}

export type StepStatus = 'started' | 'done' | 'failed';

export interface StepState {
  status: StepStatus;
  at: string;
  skipped?: true;
  exit?: number | null;
  reason?: 'exit' | 'check';
  detail?: string;
  log?: string;
  tags?: string[];
  version?: string;
}

export interface ReleaseState {
  version: typeof RELEASE_FILE_VERSION;
  planHash: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  steps: Record<string, StepState>;
}

/** git in a clone: its output, or not ok. Injected by tests. */
export type GitReader = (dir: string, args: string[]) => { ok: boolean; stdout: string };
/** A member's clone dir, or why it can't be used. Injected by tests. */
export type CloneResolver = (name: string) => { dir: string } | { detail: string };

export interface PlanOptions {
  git?: GitReader;
  clone?: CloneResolver;
}

const ROOT_LABEL = '(root)';
const labelOf = (repo: RepoKey): string => repo ?? ROOT_LABEL;

/** git in a clone through the shared wrapper (pins, no inherited GIT_DIR-style variables), as memberCheck runs it. */
export const cloneGit: GitReader = (dir, args) => {
  const r = runGit(dir, args, { allowFail: true });
  return { ok: r.ok, stdout: r.stdout };
};

function defaultClone(root: string, config: Config): CloneResolver {
  const local = readLocalConfig(root);
  return (name) => {
    const entry = config.repos.find((r) => r.name === name);
    if (!entry) return { detail: `repo ${name} is not a repos entry in .forge/config.yml` };
    const check = memberCheck(root, config, entry, local);
    if (!check.ok) return { detail: check.detail };
    return { dir: resolveMemberPath(root, local.repos[name].path) };
  };
}

/** The branch a repo releases from: `git.base` for the root, `defaultBranch` for a member. */
export function repoBase(config: Config, repo: RepoKey): string {
  if (repo === null) return assertSafeRef(config.git.base, 'git.base');
  const entry = config.repos.find((r) => r.name === repo);
  if (!entry) throw new ForgeError(`repo ${repo} is not a repos entry in .forge/config.yml`);
  return assertSafeRef(entry.defaultBranch, `repos ${repo} defaultBranch`);
}

export const repoRemote = (config: Config): string => assertSafeRef(config.git.remote || 'origin', 'git.remote');

/** A repo's release strategy: the top-level `release` for the root, `repos[].release` for a member. */
export function strategyOf(config: Config, repo: RepoKey): ReleaseStrategy | null {
  if (repo === null) return config.release ?? null;
  return config.repos.find((r) => r.name === repo)?.release ?? null;
}

// Manifests are the human's own files, but their text lands in release.md and argv: only names and
// versions a registry would accept go through.
// The first character is never `-`: the name goes into `npm view` / `cargo search` argv.
const NPM_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]{0,213}$/;
const CARGO_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^\d[0-9A-Za-z.+-]{0,63}$/;
const MANIFEST_MAX = 1024 * 1024;

function readManifest(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MANIFEST_MAX) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const unquote = (v: string): string | null => {
  const m = /^"([^"\\]*)"\s*(?:#.*)?$/.exec(v.trim()) ?? /^'([^']*)'\s*(?:#.*)?$/.exec(v.trim());
  return m ? m[1] : null;
};

/** The root package of the clone at `dir`: its name and version, or why there is none to check. */
export function readManifestPackage(dir: string, ecosystem: 'npm' | 'cargo'): { name: string; version: string } | { reason: string } {
  if (ecosystem === 'npm') {
    const text = readManifest(path.join(dir, 'package.json'));
    if (text === null) return { reason: 'no package.json at the clone root' };
    let pkg: any;
    try {
      pkg = JSON.parse(text);
    } catch {
      return { reason: 'package.json is not valid JSON' };
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return { reason: 'package.json is not an object' };
    if (pkg.private === true) return { reason: 'package.json is private (a workspace root publishes its packages one by one)' };
    if (typeof pkg.name !== 'string' || !NPM_NAME.test(pkg.name)) return { reason: 'package.json has no valid name' };
    if (typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) return { reason: 'package.json has no valid version' };
    return { name: pkg.name, version: pkg.version };
  }
  const text = readManifest(path.join(dir, 'Cargo.toml'));
  if (text === null) return { reason: 'no Cargo.toml at the clone root' };
  let section = '';
  let sawWorkspace = false;
  let sawPackage = false;
  let name: string | null = null;
  let version: string | null = null;
  let inherited = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]*)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = header[1].trim();
      if (section === 'package') sawPackage = true;
      if (section === 'workspace' || section.startsWith('workspace.')) sawWorkspace = true;
      continue;
    }
    if (section !== 'package') continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'name') name = unquote(value);
    else if (key === 'version') {
      version = unquote(value);
      if (version === null && /workspace\s*=\s*true/.test(value)) inherited = true;
    } else if (key === 'version.workspace') inherited = true;
  }
  if (!sawPackage) return { reason: sawWorkspace ? 'Cargo.toml is a workspace with no root package' : 'Cargo.toml has no [package]' };
  if (name === null || !CARGO_NAME.test(name)) return { reason: 'Cargo.toml has no valid [package] name' };
  if (inherited) return { reason: 'the [package] version comes from the workspace' };
  if (version === null || !VERSION.test(version)) return { reason: 'Cargo.toml has no valid [package] version' };
  return { name, version };
}

function ecosystemOf(mechanism: ReleaseMechanism, registry: ReleaseRegistry | null): 'npm' | 'cargo' | null {
  if (registry === 'npm') return 'npm';
  if (registry === 'crates.io') return 'cargo';
  if (mechanism === 'cargo-release') return 'cargo';
  if (mechanism === 'changesets') return 'npm';
  return null;
}

/** What stepsFor needs to know about one repo. */
export interface RepoInput {
  repo: RepoKey;
  dir: string;
  base: string;
  remote: string;
  strategy: ReleaseStrategy & { mechanism: ReleaseMechanism };
  manifest: { name: string; version: string } | { reason: string } | null;
}

/** The mechanism table (spec "Steps per mechanism"), as data. */
export function stepsFor(r: RepoInput): ReleaseStep[] {
  const label = labelOf(r.repo);
  const { mechanism } = r.strategy;
  const registry = r.strategy.registry ?? null;
  const steps: ReleaseStep[] = [];
  const add = (kind: string, title: string, rest: Partial<ReleaseStep>): void => {
    steps.push({ id: `${label}/${kind}`, repo: r.repo, kind, title, argv: null, shell: null, manual: null, publish: false, check: null, ...rest });
  };
  const noCheck = r.manifest && 'reason' in r.manifest ? `no registry check: ${r.manifest.reason}; check by hand` : null;
  const registryCheck = (): Partial<ReleaseStep> => (noCheck ? { check: null, note: noCheck } : { check: 'registry' });
  add('preflight', `Check that the clone is on ${r.base}, clean, and level with ${r.remote}/${r.base}`, { check: 'ready' });
  const registryPublish = () => {
    if (registry === 'npm') add('publish', 'Publish the package to npm', { argv: ['npm', 'publish'], publish: true, ...registryCheck() });
    else if (registry === 'crates.io') add('publish', 'Publish the crate to crates.io', { argv: ['cargo', 'publish'], publish: true, ...registryCheck() });
  };
  if (mechanism === 'tag') {
    add('release', 'Run release.command, which tags and pushes the release', { shell: String(r.strategy.command ?? ''), publish: true, check: 'tag-pushed' });
    registryPublish();
  } else if (mechanism === 'cargo-release') {
    add('publish', 'Publish the crates with cargo-release', { argv: ['cargo', 'release', 'publish', '--execute', '--no-confirm'], publish: true, ...(registry === 'none' ? {} : registryCheck()) });
    add('tag', 'Tag the release', { argv: ['cargo', 'release', 'tag', '--execute', '--no-confirm'], check: 'tagged' });
    add('push', 'Push the release commit and tags', { argv: ['cargo', 'release', 'push', '--execute', '--no-confirm'], publish: true, check: 'tag-pushed' });
  } else if (mechanism === 'changesets') {
    add('version', 'Apply the changesets: bump versions and changelogs', { argv: ['changeset', 'version'] });
    add('stage', 'Stage the version changes', { argv: ['git', 'add', '--all'] });
    add('commit', 'Commit the version bump', { argv: ['git', 'commit', '--message', 'Version packages'], check: 'clean' });
    add('publish', 'Publish the packages and tag them', { argv: ['changeset', 'publish'], publish: true, check: 'tagged' });
    add('push', `Push the release commit and tags to ${r.remote}/${r.base}`, { argv: ['git', 'push', '--follow-tags', r.remote, `HEAD:refs/heads/${r.base}`], publish: true, check: 'tag-pushed' });
  } else {
    add('merge', "Merge the release PR", { manual: `Merge ${label}'s open release-please PR on GitHub; its workflow tags the release.`, publish: true, check: 'remote-tagged' });
    add('sync', `Fast-forward ${r.base} to ${r.remote}/${r.base}`, { argv: ['git', 'merge', '--ff-only', `${r.remote}/${r.base}`], check: 'at-remote' });
    registryPublish();
  }
  return steps;
}

function rollbackFor(r: RepoInput, steps: ReleaseStep[], pkg: ReleasePackage | null): string[] {
  const name = pkg?.name ?? '<name>';
  const tag = `\`git push ${r.remote} --delete refs/tags/<tag>\`, then \`git tag --delete <tag>\`, and delete its GitHub Release if one was made: \`gh release delete <tag>\``;
  const lines = (s: ReleaseStep): string[] => {
    const m = r.strategy.mechanism;
    if (m === 'tag' && s.kind === 'release') return [`Delete the pushed tag: ${tag}`];
    if (m === 'cargo-release' && s.kind === 'push') return [`Delete the pushed tag: ${tag}`];
    if (m === 'changesets' && s.kind === 'push')
      return [`Delete the pushed tag: ${tag}`, `Revert the version commit once pushed: \`git revert --no-edit <release commit>\`, then \`git push ${r.remote} HEAD:refs/heads/${r.base}\``];
    if (m === 'release-please' && s.kind === 'merge') return [`Delete the tag the workflow pushed: ${tag}`, `revert the release PR's merge commit on ${r.base} in a new PR`];
    if (s.kind !== 'publish') return [];
    const npm = m === 'changesets' || (s.argv?.[0] === 'npm');
    if (npm) return [`\`npm deprecate ${name}@<version> "<reason>"\`; \`npm unpublish ${name}@<version>\` only works within 72 hours of publishing and when no other public package depends on it`];
    return [`\`cargo yank --version <version> ${name}\`; crates.io never deletes a version; a yank stops new lockfiles from picking it`];
  };
  return [...steps].reverse().flatMap(lines);
}

/** sha256 of canonical JSON (keys sorted) of what decides what runs; see the spec's "File shapes". */
export function planHash(plan: Pick<ReleasePlan, 'selection' | 'order' | 'repos' | 'skipped'>): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    return v;
  };
  const body = {
    selection: plan.selection,
    order: plan.order,
    repos: plan.repos.map((r) => ({ repo: r.repo, mechanism: r.mechanism, registry: r.registry, dir: r.dir, package: r.package, steps: r.steps })),
    skipped: plan.skipped,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon(body))).digest('hex');
}

const SINCE = (tag: string) => `forge release plan --since ${tag}`;

/**
 * The release plan for `selection`, from config, the job (for `job`) and the clones. Throws a
 * ForgeError for every refusal in the spec; never writes.
 */
export function planRelease(root: string, config: Config, selection: ReleaseSelection, opts: PlanOptions = {}): ReleasePlan {
  const problems = validateConfig(config, root);
  if (problems.length)
    throw new ForgeError(`.forge/config.yml has ${problems.length} problem${problems.length === 1 ? '' : 's'}, so no release can be planned: ${problems.slice(0, 5).join('; ')}`, 'failed', 'forge config validate');
  const git = opts.git ?? cloneGit;
  const clone = opts.clone ?? defaultClone(root, config);
  const remote = repoRemote(config);
  const skipped: ReleaseSkip[] = [];
  const skip = (repo: RepoKey, reason: string) => skipped.push({ repo, label: labelOf(repo), reason });
  const members = config.repos.map((r) => r.name);
  let candidates: RepoKey[];
  if (selection.kind === 'job') {
    const job = loadJob(root, selection.job);
    candidates = prRepos(job);
    const prOf = (repo: RepoKey) => (repo === null ? job.pr : memberRepos(job).find((m) => m.repo === repo)?.pr);
    const unmerged = candidates.filter((r) => prOf(r)?.state !== 'MERGED');
    // A consumer of an interim edge merges after its dependencies' release (its release gate), so it
    // is left out of this plan rather than refused; any other unmerged PR still is.
    const consumers = new Set(resolveInterim(config, job).edges.map((e) => e.consumer));
    const refused = unmerged.filter((r) => !consumers.has(r));
    if (refused.length) throw new ForgeError(`forge release plan --job ${selection.job}: ${refused.map(labelOf).join(', ')} have no merged PR; run forge pr sync ${selection.job} first`);
    for (const r of unmerged) skip(r, "PR not merged: it waits on its dependencies' release");
    candidates = candidates.filter((r) => !unmerged.includes(r));
    if (!candidates.length) throw new ForgeError(`forge release plan --job ${selection.job}: no PR of the job is merged yet`);
  } else candidates = [null, ...members];

  const dirs = new Map<RepoKey, string>();
  for (const repo of candidates) {
    if (repo === null) {
      dirs.set(null, root);
      continue;
    }
    if (!config.repos.some((r) => r.name === repo)) throw new ForgeError(`repo ${repo} is not a repos entry in .forge/config.yml`);
    const c = clone(repo);
    if ('detail' in c) {
      if (selection.kind === 'job') throw new ForgeError(`repo ${repo}: ${c.detail}`);
      skip(repo, `clone: ${c.detail}`);
      continue;
    }
    dirs.set(repo, c.dir);
  }

  let selected = candidates.filter((r) => dirs.has(r));
  if (selection.kind === 'since') {
    const tag = selection.tag;
    let resolved = 0;
    selected = selected.filter((repo) => {
      const dir = dirs.get(repo)!;
      if (!git(dir, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]).ok) {
        skip(repo, `no tag ${tag}`);
        return false;
      }
      resolved++;
      const count = git(dir, ['rev-list', '--count', `${tag}..HEAD`]);
      if (!count.ok || !(Number(count.stdout.trim()) > 0)) {
        skip(repo, `no commits since ${tag}`);
        return false;
      }
      return true;
    });
    if (!resolved) throw new ForgeError(`${SINCE(tag)}: no repo has the tag ${tag}`);
  }
  selected = selected.filter((repo) => {
    if (strategyOf(config, repo)?.mechanism) return true;
    skip(repo, 'no release.mechanism');
    return false;
  });

  const ord = repoOrder(config, selected);
  if (ord.cycle) throw new ForgeError(`the components' dependsOn form a cycle between ${ord.cycle.map(labelOf).join(', ')}; a release needs an order`);

  const repos: ReleaseRepo[] = ord.order.map((repo) => {
    const strategy = strategyOf(config, repo) as ReleaseStrategy & { mechanism: ReleaseMechanism };
    const registry = strategy.registry ?? null;
    const eco = ecosystemOf(strategy.mechanism, registry);
    const dir = dirs.get(repo)!;
    const manifest = eco ? readManifestPackage(dir, eco) : null;
    const input: RepoInput = { repo, dir, base: repoBase(config, repo), remote, strategy, manifest };
    const steps = stepsFor(input);
    const pkg = eco && manifest && 'name' in manifest ? { ecosystem: eco, name: manifest.name } : null;
    return {
      repo,
      label: labelOf(repo),
      dir,
      mechanism: strategy.mechanism,
      registry,
      cadence: strategy.cadence ?? null,
      version: manifest && 'version' in manifest ? manifest.version : null,
      package: pkg,
      steps,
      rollback: rollbackFor(input, steps, pkg),
    };
  });
  const plan: Omit<ReleasePlan, 'hash'> = { version: RELEASE_FILE_VERSION, createdAt: now(), selection, order: ord.order.map(labelOf), relaxed: ord.relaxed, repos, skipped };
  return { ...plan, hash: planHash(plan) };
}

/** The plan as it is now, against release.json and state.json; a mismatch is refused as stale. */
export function freshPlan(root: string, config: Config, file: ReleasePlan, state: ReleaseState | null, opts: PlanOptions = {}): ReleasePlan {
  const now = planRelease(root, config, file.selection, opts);
  // planHash(file) catches a release.json edited without updating its hash.
  const old = [file.hash, planHash(file), state?.planHash].find((h) => h !== undefined && h !== now.hash);
  if (old !== undefined) throw new ForgeError(`the release plan no longer matches config and the repos (plan ${String(old).slice(0, 12)}, now ${now.hash.slice(0, 12)}); run forge release plan`);
  return now;
}

const CHECK_TEXT: Record<CheckKind, (r: ReleaseRepo, base: string, remote: string) => string> = {
  ready: (_r, base, remote) => `the clone is on ${base} with nothing uncommitted, and HEAD equals ${remote}/${base} after a fetch.`,
  clean: () => '`git status` shows nothing uncommitted.',
  tagged: () => 'HEAD carries at least one tag.',
  'tag-pushed': (_r, base, remote) => `HEAD carries a tag, and ${remote} has ${base} at HEAD and every tag at HEAD.`,
  'remote-tagged': (_r, base, remote) => `after a fetch, ${remote}/${base} carries a tag.`,
  'at-remote': (_r, base, remote) => `HEAD equals ${remote}/${base}.`,
  registry: (r) =>
    r.package?.ecosystem === 'cargo'
      ? `\`cargo search ${r.package.name}\` lists the version in Cargo.toml.`
      : `\`npm view ${r.package?.name ?? '<name>'}@<version> version\` prints the version in package.json.`,
};

/** A step's command as one line: the argv as shell words, the tag command as written, or the manual instruction. */
export function stepCommand(s: ReleaseStep): string {
  if (s.manual !== null) return s.manual;
  if (s.shell !== null) return s.shell;
  return (s.argv ?? []).map((w) => shellWord(w, /^[A-Za-z0-9._/:@=+-]+$/)).join(' ');
}

const SELECTION_TEXT = (s: ReleaseSelection): string => (s.kind === 'job' ? `job ${s.job}` : s.kind === 'since' ? `since ${s.tag}` : 'every repo');

/** release.md: the human plan with its rollback. Text from config and manifests stays in fences or is cut to safe text. */
export function renderReleaseMd(plan: ReleasePlan, config: Config): string {
  const remote = repoRemote(config);
  const out: string[] = ['# Release plan', ''];
  out.push(`Selection: ${SELECTION_TEXT(plan.selection)} · planned ${plan.createdAt} · plan ${plan.hash.slice(0, 12)}`);
  out.push(`Order: ${plan.order.length ? plan.order.join(', ') : 'nothing to release'} (dependencies first)${plan.relaxed ? ' · runtime edges ignored: they formed a cycle' : ''}`);
  out.push('');
  out.push('Run it with `forge release run`. It stops at the first failed check and, run again, resumes there. Steps marked **publish** ask before they run unless the repo sets `release.publish: allow`.');
  plan.repos.forEach((r, i) => {
    const base = repoBase(config, r.repo);
    out.push('', `## ${i + 1}. ${r.label} (${r.mechanism} → ${r.registry ?? 'no registry'})`);
    out.push(`Directory: \`${safeText(r.dir, 500)}\` · version ${r.version ?? 'unknown'} · cadence ${r.cadence ?? 'undeclared'}`);
    if (r.cadence === 'on-merge' || r.cadence === 'scheduled') out.push(`> Cadence ${r.cadence} usually releases from CI; steps CI already did are skipped by their checks.`);
    out.push('');
    r.steps.forEach((s, j) => {
      out.push(`${j + 1}. \`${s.id}\`${s.publish ? ' · **publish**' : ''} — ${s.title}`);
      if (s.argv || s.shell !== null || s.manual !== null) out.push(...fenced(stepCommand(s), 'sh').split('\n').map((l) => `   ${l}`));
      out.push(`   Check: ${s.check ? CHECK_TEXT[s.check](r, base, remote) : 'the exit code.'}`);
      if (s.note) out.push(`   ${s.note}`);
    });
  });
  if (plan.skipped.length) {
    out.push('', '## Not released');
    for (const s of plan.skipped) out.push(`- \`${s.label}\`: ${safeText(s.reason, 400)}`);
  }
  out.push('', '## Rollback', 'Forge never runs these. Undo in this order, last released first; `forge release status` shows the tags and versions each step recorded.');
  for (const r of [...plan.repos].reverse()) {
    out.push(`### ${r.label}`);
    if (!r.rollback.length) out.push('- nothing outward-facing to undo');
    for (const line of r.rollback) out.push(`- ${line}`);
  }
  return out.join('\n') + '\n';
}

export interface ReleaseFiles {
  dir: string;
  md: string;
  json: string;
  state: string;
  logs: string;
}

export function releaseFiles(root: string): ReleaseFiles {
  const dir = path.join(paths(root).runtime, 'release');
  return { dir, md: path.join(dir, 'release.md'), json: path.join(dir, 'release.json'), state: path.join(dir, 'state.json'), logs: path.join(dir, 'logs') };
}

/** Refuses when the release dir or one of the files Forge reads or writes in it is a symlink. */
export function assertNoSymlinks(files: ReleaseFiles, extra: string[] = []): void {
  for (const p of [files.dir, files.md, files.json, files.state, files.logs, ...extra]) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) throw new ForgeError(`${p} is a symlink; forge release reads and writes only real files there. Remove it and plan again`);
  }
}

/** state.json, or null when there is none. A file Forge can't read as its own is refused. */
export function readState(files: ReleaseFiles): ReleaseState | null {
  let text: string;
  try {
    text = fs.readFileSync(files.state, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ForgeError(`cannot read ${files.state}: ${(e as Error).message}`);
  }
  let s: any;
  try {
    s = JSON.parse(text);
  } catch {
    throw new ForgeError(`${files.state} is not valid JSON; re-run forge release plan --force, which discards its checkpoints`);
  }
  if (!s || s.version !== RELEASE_FILE_VERSION || typeof s.planHash !== 'string' || !s.steps || typeof s.steps !== 'object' || Array.isArray(s.steps))
    throw new ForgeError(`${files.state} is not a version ${RELEASE_FILE_VERSION} release state; re-run forge release plan --force, which discards its checkpoints`);
  return s as ReleaseState;
}

/** release.json, or null when there is none; an unreadable or older file is refused with the fix. */
export function readPlanFile(files: ReleaseFiles): ReleasePlan | null {
  let text: string;
  try {
    text = fs.readFileSync(files.json, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ForgeError(`cannot read ${files.json}: ${(e as Error).message}`);
  }
  let p: any;
  try {
    p = JSON.parse(text);
  } catch {
    throw new ForgeError(`${files.json} is not valid JSON; re-run forge release plan`);
  }
  if (!p || p.version !== RELEASE_FILE_VERSION) throw new ForgeError(`${files.json} is not a version ${RELEASE_FILE_VERSION} release plan; re-run forge release plan`);
  const sel = p.selection;
  const okSel = sel && ((sel.kind === 'job' && typeof sel.job === 'string') || (sel.kind === 'since' && typeof sel.tag === 'string') || sel.kind === 'all');
  if (!okSel || typeof p.hash !== 'string' || !Array.isArray(p.repos)) throw new ForgeError(`${files.json} is not a release plan Forge wrote; re-run forge release plan`);
  // Anyone who can write .forge/runtime/ can plant this file, and its selection reaches git argv and
  // a path join before any hash is compared, so it passes the same rules as the CLI flags.
  if (sel.kind === 'since') {
    try {
      assertSafeRef(sel.tag, 'selection.tag');
    } catch (e) {
      throw new ForgeError(`${files.json}: ${(e as Error).message.replace('safe branch name', 'safe tag name')}; re-run forge release plan`);
    }
  }
  if (sel.kind === 'job' && !validJobId(sel.job)) throw new ForgeError(`${files.json}: selection.job ${JSON.stringify(sel.job.slice(0, 80))} is not a valid job id; re-run forge release plan`);
  return p as ReleasePlan;
}

/** Every step of the plan, in order. */
export const planSteps = (plan: Pick<ReleasePlan, 'repos'>): ReleaseStep[] => plan.repos.flatMap((r) => r.steps);

export const doneCount = (plan: Pick<ReleasePlan, 'repos'>, state: ReleaseState | null): number => planSteps(plan).filter((s) => state?.steps[s.id]?.status === 'done').length;

/** Whether every step of the plan is done in `state`. */
export const finished = (plan: Pick<ReleasePlan, 'repos'>, state: ReleaseState | null): boolean => planSteps(plan).every((s) => state?.steps[s.id]?.status === 'done');

/** The `selection` for the plan command's flags; usage errors for the combinations it refuses. */
export function selectionFrom(flags: { job?: unknown; since?: unknown }): ReleaseSelection {
  if (flags.job !== undefined && flags.since !== undefined) throw new ForgeError('forge release plan takes --job or --since, not both', 'usage', 'forge help release plan');
  if (flags.job !== undefined) {
    if (typeof flags.job !== 'string' || !flags.job) throw new ForgeError('missing value for --job', 'usage', 'forge help release plan');
    return { kind: 'job', job: flags.job };
  }
  if (flags.since !== undefined) {
    if (typeof flags.since !== 'string' || !flags.since) throw new ForgeError('missing value for --since', 'usage', 'forge help release plan');
    try {
      return { kind: 'since', tag: assertSafeRef(flags.since, '--since') };
    } catch (e) {
      throw new ForgeError((e as Error).message.replace('safe branch name', 'safe tag name'), 'usage', 'forge help release plan');
    }
  }
  return { kind: 'all' };
}

/**
 * `forge release plan`: plans, guards an unfinished run of another plan, and writes release.md and
 * release.json (and drops state.json on `force`).
 */
export function writeReleasePlan(root: string, config: Config, selection: ReleaseSelection, opts: PlanOptions & { force?: boolean; log?: (line: string) => void } = {}) {
  const files = releaseFiles(root);
  assertNoSymlinks(files);
  const plan = planRelease(root, config, selection, opts);
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  let state: ReleaseState | null;
  try {
    state = readState(files);
  } catch (e) {
    if (!opts.force) throw e;
    // readState's own error says to use --force, so --force must get past an unreadable file.
    log(`forge release plan: --force discarded an unreadable ${files.state}`);
    fs.rmSync(files.state, { force: true });
    state = null;
  }
  if (state && state.planHash !== plan.hash) {
    // finishedAt is set only once every step is done; the counts come from the plan the state belongs to.
    if (!state.finishedAt) {
      const old = (() => {
        try {
          return readPlanFile(files);
        } catch {
          return null;
        }
      })();
      const steps = old && old.hash === state.planHash ? planSteps(old).map((s) => s.id) : Object.keys(state.steps);
      const done = steps.filter((id) => state.steps[id]?.status === 'done').length;
      if (!opts.force) throw new ForgeError(`a release run is in progress (${done}/${steps.length} steps done); finish it with forge release run, or re-plan with --force, which discards its checkpoints`);
      log(`forge release plan: --force discarded the checkpoints of plan ${state.planHash.slice(0, 12)} (${done}/${steps.length} steps done)`);
    }
    fs.rmSync(files.state, { force: true });
  }
  fs.mkdirSync(files.dir, { recursive: true });
  assertNoSymlinks(files);
  writeJsonAtomic(files.json, plan);
  writeTextAtomic(files.md, renderReleaseMd(plan, config));
  return { plan: files.md, steps: files.json, hash: plan.hash.slice(0, 12), order: plan.order, total: planSteps(plan).length, skipped: plan.skipped.map(({ label, reason }) => ({ repo: label, reason })) };
}
