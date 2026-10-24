// `npm run release -- [patch|minor|major|X.Y.Z] [--notes-file <file>] [--yes]`: Forge's own release, run by
// the maintainer on a clean develop that equals origin/develop (docs/RELEASES.md "Releasing"). A release is
// a PR from release/v<version> into main:
//   1. with a version: bump package.json, package-lock.json, .claude-plugin/plugin.json and the forge
//      plugin's ref in .claude-plugin/marketplace.json, draft the CHANGELOG section from develop's commits
//      since the last tag, open it in $EDITOR, commit `Release X.Y.Z` (the release commit) on a new
//      release/vX.Y.Z branch cut from develop, and push that branch; develop itself does not move;
//   2. wait for main-update.yml's dashboard build on the release commit, check it (scripts/main-update.ts),
//      push the main update (the release commit plus dashboard/dist/, on top of main) to the branch and
//      open the release PR; a human merges it with a merge commit, and that push runs release.yml;
//   3. once release.yml has tagged the merge commit, land the release commit on develop, so develop's
//      marketplace.json, the one installs read, names the tag only once it exists.
// With no version it resumes the one release in flight: every step checks whether it is done before it runs.
// A release branch is adopted only when it can be re-derived, because anyone who can push a branch can push
// this one: the release commit must be develop plus exactly the bump (file by file, byte by byte), and the main
// update must have exactly the tree built from it and the artifact main-update.yml made of it. The head the PR
// merged is derived again before step 3 lands anything: the merge published whatever the head was by then.
// A human pushes and merges, not CI: a push or merge GITHUB_TOKEN makes starts no workflow run, and
// GITHUB_TOKEN can't push a commit that changes .github/workflows/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gitSync } from './git.ts';
import { changelogSection, forgeRef, releaseProblems } from './release-check.ts';
import { isMainUpdate, isReleaseSubject, mainCommit, mainOnlyCommits, oneLine, Refusal } from './main-update.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
const BUMPS = ['patch', 'minor', 'major'] as const;
const NOTE = '<!--';
// How long a workflow run may take to appear after its push, and to finish.
const APPEAR_MS = 3 * 60_000;
const FINISH_MS = 45 * 60_000;
const POLL_MS = 15_000;
// The versions the notes report when they move (versionsAt), with the words CHANGELOG uses for them.
const VERSION_LABELS: Record<string, string> = {
  CONFIG_SCHEMA_VERSION: 'config schema',
  JOB_SCHEMA_VERSION: 'job schema',
  EVENT_SCHEMA_VERSION: 'event schema',
  ARCHIVE_SCHEMA_VERSION: 'archive schema',
  API_VERSION: '`API_VERSION`',
};
const PR_FIELDS = 'number,state,url,headRefName,headRefOid,baseRefName,isCrossRepository,mergeCommit';
/** What to do with the release PR, naming the head `npm run release` checked: a later push to the branch is not it. */
const mergeHint = (head: string) =>
  `Merge it in GitHub with "Create a merge commit", and only while its head is ${head} (the commit checked; if the branch moved, run \`npm run release\` again first), then run \`npm run release\`.`;

const semver = (v: string): number[] => {
  const m = SEMVER.exec(v);
  if (!m) throw new Refusal(`${JSON.stringify(v)} is not X.Y.Z`);
  return m.slice(1).map(Number);
};

/** Below zero when `a` comes before `b`, zero when equal, above zero after. Both must be X.Y.Z. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [semver(a), semver(b)];
  return x.map((n, i) => n - y[i]).find((d) => d !== 0) ?? 0;
}

/** The version after `current`: a bump name, or an explicit X.Y.Z that must be greater. */
export function nextVersion(current: string, want: string): string {
  if (!SEMVER.test(current)) throw new Refusal(`the current version ${JSON.stringify(current)} is not X.Y.Z`);
  const [major, minor, patch] = semver(current);
  if (want === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (want === 'minor') return `${major}.${minor + 1}.0`;
  if (want === 'major') return `${major + 1}.0.0`;
  if (!SEMVER.test(want)) throw new Refusal(`${JSON.stringify(want)} is not patch, minor, major or X.Y.Z`);
  if (compareVersions(want, current) <= 0) throw new Refusal(`${want} is not after the current version ${current}`);
  return want;
}

/** The files a version bump touches, and the JSON paths that must read the new version afterwards. */
const VERSION_FILES: [string, string[][]][] = [
  ['package.json', [['version']]],
  ['package-lock.json', [['version'], ['packages', '', 'version']]],
  [path.join('.claude-plugin', 'plugin.json'), [['version']]],
];
/** Where installs added from GitHub read which commit to install: the forge plugin's `source.ref`. */
export const MARKETPLACE = path.join('.claude-plugin', 'marketplace.json');
/** Everything a release commit changes next to its parent, as git names the paths. */
const RELEASE_FILES = [...VERSION_FILES.map(([rel]) => rel), MARKETPLACE, 'CHANGELOG.md'].map((rel) => rel.split(path.sep).join('/'));

/**
 * `text` of one bumped file (`rel`: a `VERSION_FILES` entry or marketplace.json) taken from `from` to `to`. Rewrites
 * only the version lines, so the file keeps its formatting, and the first `ref` of marketplace.json to `v<to>`, then
 * checks the JSON reads `to` (and the forge plugin's ref `v<to>`). `releaseCommitOf` replays it on the parent's bytes.
 */
export function rewriteVersion(rel: string, text: string, from: string, to: string): string {
  if (rel === MARKETPLACE) {
    const next = text.replace(/("ref":\s*)"[^"]*"/, (_m, key) => `${key}"v${to}"`);
    let ref: unknown;
    try {
      ref = forgeRef(JSON.parse(next));
    } catch (e) {
      throw new Refusal(`.claude-plugin/marketplace.json: ${(e as Error).message}`);
    }
    if (ref !== `v${to}`) throw new Refusal(`.claude-plugin/marketplace.json: the forge plugin's source.ref reads ${JSON.stringify(ref ?? null)} after the bump, not v${to}`);
    return next;
  }
  const paths = VERSION_FILES.find(([r]) => r === rel)?.[1];
  if (!paths) throw new Refusal(`${rel} is not a file a version bump touches`);
  const line = new RegExp(`("version":\\s*)"${from.replace(/\./g, '\\.')}"`, 'g');
  let left = paths.length;
  // The first `version` lines are the ones the paths name: a lockfile lists its root before any dependency.
  const next = text.replace(line, (m, key) => (left-- > 0 ? `${key}"${to}"` : m));
  const json = JSON.parse(next);
  for (const p of paths) {
    const got = p.reduce<any>((o, k) => o?.[k], json);
    if (got !== to) throw new Refusal(`${rel}: ${p.join('.') || '""'} reads ${JSON.stringify(got)} after the bump, not ${to}`);
  }
  return next;
}

/** `rewriteVersion` over every file a bump touches. Each is checked before any is written, so a refusal never leaves a half-bumped tree. */
export function setVersion(root: string, from: string, to: string): void {
  const writes = [...VERSION_FILES.map(([rel]) => rel), MARKETPLACE].map((rel): [string, string] => {
    const file = path.join(root, rel);
    return [file, rewriteVersion(rel, fs.readFileSync(file, 'utf8'), from, to)];
  });
  for (const [f, text] of writes) fs.writeFileSync(f, text);
}

/** Where the schema file has lived, newest first: a tag from before the lib/ layers (#421) has the second. */
export const SCHEMA_FILES = ['lib/core/job/schema.ts', 'lib/schema.ts'];

/** The version lists (#426) that replaced the literal constants, by the constant each gives. */
export const VERSION_LISTS: Record<string, string> = {
  CONFIG_SCHEMA_VERSION: 'lib/core/versions/config.ts',
  JOB_SCHEMA_VERSION: 'lib/core/versions/job.ts',
  EVENT_SCHEMA_VERSION: 'lib/core/versions/event.ts',
  API_VERSION: 'lib/api/versions.ts',
};

/** `export const X_VERSION = n;` constants in a schema file's text. */
export function schemaVersions(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/^export const (\w+) = (\d+);/gm)) if (m[1] in VERSION_LABELS) out[m[1]] = Number(m[2]);
  return out;
}

/** The version a list file gives: 1 + its entries, each starting its own line as `  { id: '`. */
export const listVersion = (text: string): number => 1 + (text.match(/^ {2}\{ id: '/gm)?.length ?? 0);

/**
 * The versions a tree holds, through `read` (a repo-relative path's text, or null when absent): the
 * literal constants of its schema file, then each version list that exists in place of its constant.
 * A tag from before the lists has only the constants; a tree after them has both, ARCHIVE from schema.ts.
 */
export function versionsAt(read: (rel: string) => string | null): Record<string, number> {
  let out: Record<string, number> = {};
  for (const rel of SCHEMA_FILES) {
    const text = read(rel);
    if (text !== null) {
      out = schemaVersions(text);
      break;
    }
  }
  for (const [key, rel] of Object.entries(VERSION_LISTS)) {
    const text = read(rel);
    if (text !== null) out[key] = listVersion(text);
  }
  return out;
}

/** `- Versions: config schema 22 → 26, …` for the constants that moved, or null. */
export function versionsLine(before: Record<string, number>, after: Record<string, number>): string | null {
  const moved = Object.keys(VERSION_LABELS)
    .filter((k) => before[k] !== undefined && after[k] !== undefined && before[k] !== after[k])
    .map((k) => `${VERSION_LABELS[k]} ${before[k]} → ${after[k]}`);
  return moved.length ? `- Versions: ${moved.join(', ')}.` : null;
}

/** The draft `## <version>` section: a note on how to edit it, one bullet per commit, then the versions line. */
export function draftSection(version: string, since: string | null, subjects: string[], versions: string | null): string {
  const bullets = subjects.filter((s) => !isReleaseSubject(s)).map((s) => `- ${oneLine(s)}`);
  return [
    `## ${version}`,
    '',
    `${NOTE} Drafted from the commits since ${since ?? 'the first commit'}. Rewrite them as notes: behaviour changes first, then fixes, then the versions bumped, deprecations and removals. Lines starting with ${NOTE} are dropped. -->`,
    ...(bullets.length ? bullets : ['- ']),
    ...(versions ? [versions] : []),
  ].join('\n');
}

/** CHANGELOG text with `section` above the newest `## ` heading. */
export function insertSection(changelog: string, section: string): string {
  const at = changelog.search(/^## /m);
  if (at < 0) return `${changelog.trimEnd()}\n\n${section}\n`;
  return `${changelog.slice(0, at)}${section}\n\n${changelog.slice(at)}`;
}

/** The section `insertSection` put into `parent` to make `text`; null when `text` is anything else than `parent` with one section above its newest heading. */
export function insertedSection(parent: string, text: string): string | null {
  const at = parent.search(/^## /m);
  const head = at < 0 ? `${parent.trimEnd()}\n\n` : parent.slice(0, at);
  const tail = at < 0 ? '\n' : `\n\n${parent.slice(at)}`;
  if (text.length < head.length + tail.length || !text.startsWith(head) || !text.endsWith(tail)) return null;
  return text.slice(head.length, text.length - tail.length);
}

export const dropNotes =(text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith(NOTE)).join('\n');

export interface Run {
  id: number;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  html_url: string;
  repository?: { full_name?: string };
  head_repository?: { full_name?: string };
}

/** Why `run` can't vouch for `sha` on `branch` of `repo`; [] when it can. */
export function runProblems(run: Run, want: { repo: string; workflow: string; sha: string; branch: string }): string[] {
  const out: string[] = [];
  if (run.path !== `.github/workflows/${want.workflow}`) out.push(`run ${run.id} is ${run.path}, not ${want.workflow}`);
  if (run.head_sha !== want.sha) out.push(`run ${run.id} is for ${run.head_sha}, not ${want.sha}`);
  if (run.head_branch !== want.branch) out.push(`run ${run.id} ran on ${run.head_branch}, not ${want.branch}`);
  if (run.event !== 'push' && run.event !== 'workflow_dispatch') out.push(`run ${run.id} came from a ${run.event} event`);
  if (run.repository?.full_name !== want.repo || run.head_repository?.full_name !== want.repo) out.push(`run ${run.id} is not ${want.repo}'s own`);
  if (run.status === 'completed' && run.conclusion !== 'success') out.push(`run ${run.id} ended ${run.conclusion}: ${run.html_url}`);
  return out;
}

/** A `release/vX.Y.Z` branch, local or on origin. */
export interface ReleaseBranch {
  version: string;
  sha: string;
  remote: boolean;
}

/**
 * The exact `release/vX.Y.Z` branches above `current` in `git for-each-ref --format='%(objectname) %(refname)'`
 * output over refs/heads/release/ and refs/remotes/origin/release/. Any other name is not a release.
 */
export function releaseBranches(refs: string, current: string): ReleaseBranch[] {
  const out: ReleaseBranch[] = [];
  for (const line of refs.split('\n')) {
    const m = /^([0-9a-f]{40}) refs\/(heads|remotes\/origin)\/release\/v(\d+\.\d+\.\d+)$/.exec(line.trim());
    if (m && compareVersions(m[3], current) > 0) out.push({ version: m[3], sha: m[1], remote: m[2] !== 'heads' });
  }
  return out;
}

/**
 * The release in flight: a release branch ahead of develop's version, or main's version ahead of it (a
 * merged release not yet landed on develop, or a hotfix not yet ported). Null when none; two refuse.
 */
export function inFlight(developVersion: string, mainVersion: string, branches: ReleaseBranch[]): { version: string; from: 'branch' | 'main' } | null {
  const onBranch = new Set(branches.filter((b) => compareVersions(b.version, developVersion) > 0).map((b) => b.version));
  const ahead = new Set(onBranch);
  if (compareVersions(mainVersion, developVersion) > 0) ahead.add(mainVersion);
  if (ahead.size > 1) throw new Refusal(`more than one release is in flight: ${[...ahead].sort(compareVersions).join(', ')}. Finish or delete all but one (docs/RELEASES.md "Recovery")`);
  const [version] = ahead;
  if (version === undefined) return null;
  return { version, from: onBranch.has(version) ? 'branch' : 'main' };
}

/** The release PR as `npm run release` reads it. */
export interface ReleasePr {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  head: string;
  merge: string | null;
}

/**
 * This repo's PR from `release/v<version>` into main among `gh pr list --json <PR_FIELDS>` rows, or null.
 * A fork's PR with the same branch name, or any other base or head, is not it. The open or merged one wins
 * over closed ones; two open or merged ones refuse, and so does a row whose number or shas are malformed.
 */
export function pickReleasePr(prs: unknown, want: { version: string }): ReleasePr | null {
  if (!Array.isArray(prs)) throw new Refusal('gh pr list did not print a list');
  const branch = `release/v${want.version}`;
  const found: ReleasePr[] = [];
  for (const p of prs as any[]) {
    if (p?.headRefName !== branch || p?.baseRefName !== 'main' || p?.isCrossRepository !== false) continue;
    const state = typeof p.state === 'string' ? p.state.toLowerCase() : '';
    if (state !== 'open' && state !== 'merged' && state !== 'closed') throw new Refusal(`a PR from ${branch} has state ${JSON.stringify(p.state)}`);
    if (!Number.isSafeInteger(p.number) || p.number <= 0) throw new Refusal(`a PR from ${branch} has number ${JSON.stringify(p.number)}`);
    if (typeof p.headRefOid !== 'string' || !SHA.test(p.headRefOid)) throw new Refusal(`PR #${p.number} has head ${JSON.stringify(p.headRefOid)}`);
    const merge = state === 'merged' ? p.mergeCommit?.oid : null;
    if (state === 'merged' && (typeof merge !== 'string' || !SHA.test(merge))) throw new Refusal(`PR #${p.number} has merge commit ${JSON.stringify(merge ?? null)}`);
    if (typeof p.url !== 'string' || !/^https:\/\/\S+$/.test(p.url)) throw new Refusal(`PR #${p.number} has url ${JSON.stringify(p.url)}`);
    found.push({ number: p.number, url: p.url, state, head: p.headRefOid, merge });
  }
  const live = found.filter((p) => p.state !== 'closed');
  if (live.length > 1) throw new Refusal(`more than one open or merged PR from ${branch} into main: ${live.map((p) => `#${p.number}`).join(', ')}`);
  return live[0] ?? found.sort((a, b) => b.number - a.number)[0] ?? null;
}

function gitOut(root: string, args: string[], opts: { input?: string } = {}): string {
  const r = gitSync(args, { cwd: root, input: opts.input });
  if (r.error || r.status !== 0) throw new Refusal(`git ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
  return r.stdout;
}
const git = (root: string, ...args: string[]) => gitOut(root, args).trim();
const gitOk = (root: string, args: string[]) => gitSync(args, { cwd: root, stdio: 'ignore' }).status === 0;
const say = (s: string) => process.stderr.write(`${s}\n`);

/** `bytes` as text, or null when they are not valid UTF-8, which would not survive a rewrite byte for byte. */
const utf8 = (bytes: Buffer): string | null => {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
};

/**
 * Whether commit `c` is `parent` plus the bump to `version` that `prepare` makes and nothing else: each version
 * file and marketplace.json is the `rewriteVersion` of the parent's bytes, and CHANGELOG.md is the parent's with
 * one `## <version>` section inserted. A file list is not enough: a `resolved` URL changed in the lockfile, or a
 * hook added to plugin.json, would ride in with the bump, and CI would build and `land` would put it on develop.
 */
function isBumpOf(root: string, parent: string, c: string, version: string): boolean {
  const text = (rev: string, rel: string): string | null => {
    const r = gitSync(['cat-file', 'blob', `${rev}:${rel.split(path.sep).join('/')}`], { cwd: root, encoding: 'buffer' });
    return r.status === 0 ? utf8(r.stdout) : null;
  };
  try {
    const was = text(parent, 'package.json');
    const from: unknown = was === null ? null : JSON.parse(was)?.version;
    if (typeof from !== 'string' || compareVersions(from, version) >= 0) return false;
    for (const rel of [...VERSION_FILES.map(([r]) => r), MARKETPLACE]) {
      const [before, after] = [text(parent, rel), text(c, rel)];
      if (before === null || after === null || after !== rewriteVersion(rel, before, from, version)) return false;
    }
    const [before, after] = [text(parent, 'CHANGELOG.md'), text(c, 'CHANGELOG.md')];
    const section = before === null || after === null ? null : insertedSection(before, after);
    return section !== null && section === section.trim() && section.split('\n', 1)[0].trimEnd() === `## ${version}`;
  } catch {
    // A file that does not parse, or a refusal from the rewrite: not a bump.
    return false;
  }
}

/**
 * `tip` when it is a release commit for `version` (one parent, subject exactly `Release <version>`,
 * package.json at `version`, no tracked dashboard/dist, and nothing but develop plus the bump: its parent is
 * on `develop`, it changes only the version files, marketplace.json and CHANGELOG.md, and each holds exactly
 * the parent's bytes bumped, with one new CHANGELOG section), its second parent when `tip` is a two-parent
 * main update of one, else null: a hotfix branch, whose dist must never land on develop, or a branch someone
 * else pushed. `develop` is the ref the parent must be on.
 */
export function releaseCommitOf(root: string, tip: string, version: string, develop = 'refs/remotes/origin/develop'): string | null {
  if (!SHA.test(tip)) return null;
  const parents = (c: string) => git(root, 'rev-list', '--parents', '-n', '1', c, '--').split(' ').slice(1);
  const isRelease = (c: string): boolean => {
    const [parent, ...others] = parents(c);
    if (!parent || others.length) return false;
    if (git(root, 'log', '-1', '--format=%s', c, '--') !== `Release ${version}`) return false;
    const pkg = gitSync(['cat-file', 'blob', `${c}:package.json`], { cwd: root });
    let v: unknown;
    try {
      v = pkg.status === 0 ? JSON.parse(pkg.stdout)?.version : undefined;
    } catch {
      v = undefined;
    }
    if (v !== version || git(root, 'ls-tree', '-r', '--name-only', '--full-tree', c, '--', 'dashboard/dist') !== '') return false;
    if (!gitOk(root, ['merge-base', '--is-ancestor', parent, develop])) return false;
    const changed = gitOut(root, ['diff', '--name-only', '-z', '--no-renames', parent, c, '--']).split('\0').filter(Boolean);
    return changed.every((f) => RELEASE_FILES.includes(f)) && isBumpOf(root, parent, c, version);
  };
  if (isRelease(tip)) return tip;
  const p = parents(tip);
  return p.length === 2 && SHA.test(p[1]) && isRelease(p[1]) ? p[1] : null;
}

/** The release PR's description: a copy of the notes for reviewers. No workflow ever reads it. */
export function prBody(o: { section: string; repo: string; previous: string; version: string; head: string }): string {
  return [
    o.section.trim(),
    '',
    '---',
    '',
    `Everything since ${o.previous}: https://github.com/${o.repo}/compare/${o.previous}...release/v${o.version}`,
    '',
    `This PR's own diff is against \`main\`, so it equals \`${o.previous}..\` only while \`main\` sits at the tag: after a hotfix it leaves out what the hotfix already changed.`,
    '',
    `The Release notes come from CHANGELOG.md in the merged commit, not from this description: editing it changes nothing.`,
    '',
    mergeHint(o.head),
    '',
  ].join('\n');
}

function sh(cmd: string, args: string[], opts: { input?: string; inherit?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', input: opts.input, stdio: opts.inherit ? 'inherit' : 'pipe', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Refusal(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
  return opts.inherit ? '' : r.stdout;
}

const readVersion = (text: string, what: string): string => {
  const v = JSON.parse(text)?.version;
  if (typeof v !== 'string' || !SEMVER.test(v)) throw new Refusal(`${what} version ${JSON.stringify(v)} is not X.Y.Z`);
  return v;
};
const tagged = (root: string, v: string) => gitOk(root, ['rev-parse', '-q', '--verify', `refs/tags/v${v}`]);

/** The newest vX.Y.Z tag, or null. */
export function lastTag(root: string): string | null {
  return git(root, 'tag', '--list', 'v*', '--sort=-v:refname').split('\n').find((t) => /^v\d+\.\d+\.\d+$/.test(t)) ?? null;
}

/** The subjects of HEAD's first-parent commits since `since` (all of them for null), newest first. */
export function subjectsSince(root: string, since: string | null): string[] {
  return gitOut(root, ['log', '--first-parent', '--format=%s', since ? `${since}..HEAD` : 'HEAD', '--']).split('\n').filter(Boolean);
}

async function confirm(question: string, yes: boolean, declined = 'stopped: nothing more was pushed'): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) throw new Refusal(`${question} needs a terminal to answer, or --yes`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Refusal(declined);
}

function editNotes(file: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  if (!process.stdin.isTTY) throw new Refusal('editing the notes needs a terminal: pass --notes-file <file> instead');
  // Through the shell, so an editor setting with flags (`code --wait`) works as it does for git.
  sh('/bin/sh', ['-c', `${editor} "$1"`, 'editor', file], { inherit: true });
}

/**
 * Bumps, drafts and commits `Release <next>` (the release commit) on a new branch release/v<next> cut
 * from the current branch, then switches back to it: that branch, its tip and its tree do not change.
 * Returns the release commit's sha. A refusal leaves no branch, no commit and the tree as it was.
 */
export function prepare(root: string, current: string, next: string, notesFile: string | null): string {
  const since = lastTag(root);
  const subjects = subjectsSince(root, since);
  const before = since ? versionsAt((rel) => (gitOk(root, ['cat-file', '-e', `${since}:${rel}`]) ? gitOut(root, ['show', `${since}:${rel}`]) : null)) : {};
  const after = versionsAt((rel) => {
    const file = path.join(root, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  });
  const changelogFile = path.join(root, 'CHANGELOG.md');
  const changelog = fs.readFileSync(changelogFile, 'utf8');

  let section: string;
  if (notesFile) {
    const notes = fs.readFileSync(path.resolve(notesFile), 'utf8').trim();
    section = notes.startsWith(`## ${next}\n`) ? notes : `## ${next}\n\n${notes}`;
  } else {
    const draft = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-')), `CHANGELOG-${next}.md`);
    fs.writeFileSync(draft, `${draftSection(next, since, subjects, versionsLine(before, after))}\n`);
    editNotes(draft);
    section = dropNotes(fs.readFileSync(draft, 'utf8')).trim();
    fs.rmSync(path.dirname(draft), { recursive: true, force: true });
  }
  if (!section.startsWith(`## ${next}`)) throw new Refusal(`the notes must start with "## ${next}"`);

  const home = git(root, 'symbolic-ref', '--short', 'HEAD');
  const branch = `release/v${next}`;
  const files = RELEASE_FILES;
  if (localTip(root, branch)) throw new Refusal(`${branch} already exists: run \`npm run release\` with no version to finish it, or delete it`);
  setVersion(root, current, next);
  fs.writeFileSync(changelogFile, insertSection(changelog, section));
  const problems = releaseProblems(root, { dist: 'absent' }).filter((p) => !p.startsWith('the working tree is not clean'));
  if (problems.length) {
    gitOut(root, ['checkout', '--', ...files]);
    throw new Refusal(`nothing was committed:\n${problems.join('\n')}`);
  }
  let created = false;
  try {
    gitOut(root, ['switch', '--quiet', '-c', branch]);
    created = true;
    gitOut(root, ['add', '--', ...files]);
    gitOut(root, ['commit', '-q', '-F', '-'], { input: `Release ${next}\n` });
  } catch (e) {
    // Back to where it started: nothing staged or bumped, on the original branch, and no release branch.
    gitOk(root, ['reset', '-q', '--', ...files]);
    gitOk(root, ['checkout', '--', ...files]);
    gitOk(root, ['switch', '--quiet', home]);
    if (created) gitOk(root, ['branch', '-D', branch]);
    throw e;
  }
  const sha = git(root, 'rev-parse', 'HEAD');
  gitOut(root, ['switch', '--quiet', home]);
  say(`committed Release ${next} (${sha.slice(0, 7)}) on ${branch}; ${home} did not move`);
  return sha;
}

function repoName(): string {
  const name = sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Refusal(`gh repo view printed ${JSON.stringify(name)}`);
  return name;
}

/** Waits for `workflow`'s newest run on `sha` to appear and finish, and refuses one that can't vouch for it. */
async function waitForRun(repo: string, workflow: string, sha: string, branch: string): Promise<Run> {
  const want = { repo, workflow, sha, branch };
  const started = Date.now();
  let shown = '';
  for (;;) {
    const runs = JSON.parse(sh('gh', ['api', `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=20`, '--jq', '.workflow_runs'])) as Run[];
    const run = runs.find((r) => r.head_branch === branch && (r.event === 'push' || r.event === 'workflow_dispatch'));
    if (run) {
      const problems = runProblems(run, want);
      if (problems.length) throw new Refusal(problems.join('\n'));
      if (run.status === 'completed') {
        say(`${workflow}: success (${run.html_url})`);
        return run;
      }
      const line = `${workflow}: ${run.status} (${run.html_url})`;
      if (line !== shown) say((shown = line));
    } else if (Date.now() - started > APPEAR_MS) throw new Refusal(`no ${workflow} run started for ${sha.slice(0, 7)} on ${branch}`);
    if (Date.now() - started > FINISH_MS) throw new Refusal(`${workflow} did not finish for ${sha.slice(0, 7)} within ${FINISH_MS / 60_000} minutes`);
    await sleep(POLL_MS);
  }
}

/** The sha `branch` has on origin right now, or null when origin has no such branch. */
function remoteTip(root: string, branch: string): string | null {
  // ls-remote matches a pattern against the end of each ref name, so only the exact name counts.
  for (const line of gitOut(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && SHA.test(sha ?? '')) return sha;
  }
  return null;
}
const localTip = (root: string, branch: string): string | null => {
  const r = gitSync(['rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`], { cwd: root });
  const sha = r.stdout.trim();
  return r.status === 0 && SHA.test(sha) ? sha : null;
};
const notARelease = (branch: string, tip: string) =>
  new Refusal(`${branch} is at ${tip.slice(0, 7)}, which is neither a release commit nor a main update of one (a hotfix branch?): finish it by hand (docs/RELEASES.md › Hotfixes)`);

/** Prints the PR and the head `npm run release` checked, the one commit a merge should publish. */
function showPr(url: string, head: string): void {
  say(`the release PR is open: ${url}`);
  say(`checked head: ${head}`);
  say(mergeHint(head));
  process.stdout.write(`${url}\n`);
}

/** Runs `use` with the `dashboard-dist` artifact of `build` downloaded into a temp dir, removed afterwards. */
function withDist<T>(repo: string, build: Run, use: (dist: string) => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-dist-'));
  try {
    try {
      sh('gh', ['run', 'download', String(build.id), '--repo', repo, '--name', 'dashboard-dist', '--dir', tmp]);
    } catch (e) {
      throw new Refusal(`${(e as Error).message}\nIf the artifact has expired, "Re-run all jobs" on ${build.html_url} builds it again for the same commit; then run npm run release again.`);
    }
    return use(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Before the PR merges: the release commit pushed, the main update on top of main pushed, the PR open. */
async function toPr(root: string, repo: string, previous: string, version: string, pr: ReleasePr | null, yes: boolean): Promise<void> {
  const branch = `release/v${version}`;
  let tip = remoteTip(root, branch);
  if (!tip) {
    const local = localTip(root, branch);
    if (!local) throw new Refusal(`origin/main is at ${version} but there is no ${branch} branch and \`gh pr list\` found no release PR from it: if it is a hotfix, port it to develop (docs/RELEASES.md › Hotfixes); if a release PR merged, check that \`gh pr list --head ${branch} --state all\` lists it`);
    if (releaseCommitOf(root, local, version) !== local) throw notARelease(branch, local);
    await confirm(`Push Release ${version} (${local.slice(0, 7)}) to origin ${branch}?`, yes);
    gitOut(root, ['push', '--quiet', 'origin', `${local}:refs/heads/${branch}`]);
    tip = local;
  }
  const release = releaseCommitOf(root, tip, version);
  if (!release) throw notARelease(branch, tip);
  const main = git(root, 'rev-parse', 'refs/remotes/origin/main');
  if (tip !== release) {
    const pushed = tip;
    if (git(root, 'rev-parse', `${pushed}^1`) !== main)
      throw new Refusal(`origin/main moved past the main update's first parent: close the PR, delete ${branch}, port main's commits to develop, and start again`);
    // Whoever can push the branch can push a commit shaped like the main update, and the PR would carry it into main.
    // Only the tree this script derives from the release commit and its CI-built dist is accepted.
    const build = await waitForRun(repo, 'main-update.yml', release, branch);
    if (!withDist(repo, build, (dist) => isMainUpdate(main, release, pushed, dist)))
      throw new Refusal(`${branch}'s tip ${pushed.slice(0, 7)} is not the main update of Release ${version}: its tree is not the release commit's plus the dashboard from ${build.html_url}. Something other than npm run release pushed it: close the PR if one is open, delete ${branch} (git push origin --delete ${branch}; git branch -D ${branch}) and start the release again`);
  }
  if (pr) {
    if (pr.head !== tip) throw new Refusal(`the release PR ${pr.url} is at ${pr.head.slice(0, 7)}, not ${branch}'s tip ${tip.slice(0, 7)}: check what was pushed to ${branch}`);
    return showPr(pr.url, tip);
  }

  if (tip === release) {
    const build = await waitForRun(repo, 'main-update.yml', release, branch);
    const hotfixes = mainOnlyCommits(main, release);
    if (hotfixes.length) {
      say('These commits are on main but not in the release; it undoes any not ported to develop:');
      for (const c of hotfixes) say(`  ${c.sha} ${c.subject}`);
      await confirm('Were they all ported?', yes);
    }
    const update = withDist(repo, build, (dist) => mainCommit(main, release, dist));
    if (!SHA.test(update)) throw new Refusal(`the main update is ${JSON.stringify(update)}`);
    await confirm(`Push the main update (${update.slice(0, 7)}: Release ${version} plus the dashboard from ${build.html_url}) to ${branch}?`, yes);
    try {
      gitOut(root, ['push', '--quiet', 'origin', `${update}:refs/heads/${branch}`]);
    } catch (e) {
      throw new Refusal(`${(e as Error).message}\nIf GitHub refused a workflow file, your credential lacks the workflow scope (gh auth refresh -s workflow), then run npm run release again.`);
    }
    tip = update;
  }

  const section = changelogSection(gitOut(root, ['show', `${release}:CHANGELOG.md`]), version) ?? '';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-pr-'));
  try {
    const body = path.join(tmp, 'body.md');
    fs.writeFileSync(body, prBody({ section, repo, previous, version, head: tip }));
    const out = sh('gh', ['pr', 'create', '--repo', repo, '--base', 'main', '--head', branch, '--title', `Release ${version}`, '--body-file', body]);
    const url = out.trim().split('\n').at(-1) ?? '';
    if (!/^https:\/\/\S+$/.test(url)) throw new Refusal(`gh pr create printed ${JSON.stringify(out.trim())}`);
    showPr(url, tip);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Makes local develop hold `release` and returns the sha to push, or null when origin/develop already has it:
 * a fast-forward when origin/develop is still its parent, else a `Release <version>` merge of it on a develop that
 * equals origin/develop (a conflict aborts and refuses). A develop that is origin/develop plus `release` already,
 * a landing an earlier run made whose push was declined or rejected, is returned as it is.
 */
export function landOnDevelop(root: string, release: string, version: string): string | null {
  const remote = git(root, 'rev-parse', 'refs/remotes/origin/develop');
  if (gitOk(root, ['merge-base', '--is-ancestor', release, remote])) return null;
  const head = git(root, 'rev-parse', 'HEAD');
  if (head !== remote) {
    if (gitOk(root, ['merge-base', '--is-ancestor', remote, head]) && gitOk(root, ['merge-base', '--is-ancestor', release, head])) return head;
    throw new Refusal('develop differs from origin/develop: pull or push first');
  }
  if (git(root, 'rev-parse', `${release}^1`) === remote) gitOut(root, ['merge', '--quiet', '--ff-only', release]);
  else {
    const merged = gitSync(['merge', '--quiet', '--no-ff', '--no-edit', '-m', `Release ${version}`, release], { cwd: root });
    if (merged.status !== 0) {
      gitOk(root, ['merge', '--abort']);
      throw new Refusal(`Release ${version} does not merge cleanly into develop: merge it by hand (git merge --no-ff -m "Release ${version}" ${release}), push develop, then run npm run release`);
    }
  }
  return git(root, 'rev-parse', 'HEAD');
}

/**
 * After the PR merged: release.yml's tag on the merge commit, the merged head derived once more, then the release
 * commit landed on develop. The merge published whatever the head was when it happened (a push after the resume
 * vouched for it counts) and release.yml reads no tree, while landing moves develop's marketplace.json, the switch
 * every install reads, to the tag. This is the last place to stop installs from following a bad tag.
 */
async function land(root: string, repo: string, version: string, pr: ReleasePr, yes: boolean): Promise<void> {
  const merge = pr.merge as string;
  const tag = `v${version}`;
  const branch = `release/v${version}`;
  if (!gitOk(root, ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`])) await waitForRun(repo, 'release.yml', merge, 'main');
  gitOut(root, ['fetch', '--quiet', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  const peeled = git(root, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  if (peeled !== merge) throw new Refusal(`${tag} points at ${peeled.slice(0, 7)}, not the release PR's merge commit ${merge.slice(0, 7)}: check the tag by hand; nothing landed on develop`);
  const release = releaseCommitOf(root, pr.head, version);
  if (!release) throw notARelease(branch, pr.head);

  const unlanded = `Nothing landed on develop, so installs still follow the previous tag. Delete the ${tag} Release and tag by hand (gh release delete ${tag} --cleanup-tag --repo ${repo}) and undo the merge on main with a hotfix PR (docs/RELEASES.md › Recovery)`;
  const tree = (rev: string) => git(root, 'rev-parse', '--verify', `${rev}^{tree}`);
  if (tree(merge) !== tree(pr.head))
    throw new Refusal(`the merge commit ${merge.slice(0, 7)} does not have the tree of the release PR's head ${pr.head.slice(0, 7)}: main took another commit while the PR was open, or the merge is not of the head that was checked. ${unlanded}`);
  const build = await waitForRun(repo, 'main-update.yml', release, branch);
  if (!withDist(repo, build, (dist) => isMainUpdate(git(root, 'rev-parse', '--verify', `${pr.head}^1`), release, pr.head, dist)))
    throw new Refusal(`the release PR's head ${pr.head.slice(0, 7)} is not the main update of Release ${version}: its tree is not the release commit's plus the dashboard from ${build.html_url}. It was pushed after npm run release checked the branch, or by something else. ${unlanded}`);

  const head = landOnDevelop(root, release, version);
  if (head === null) say(`Release ${version} is already on develop`);
  else {
    const state = `develop (${head.slice(0, 7)}) holds Release ${version} and origin/develop does not`;
    await confirm(`Push develop (${head.slice(0, 7)}, with Release ${version}) to origin?`, yes, `stopped: local ${state}; the next npm run release pushes it`);
    try {
      gitOut(root, ['push', '--quiet', 'origin', `${head}:refs/heads/develop`]);
    } catch (e) {
      throw new Refusal(`${(e as Error).message}\nLocal ${state}: if origin/develop moved, merge it in (git pull --no-rebase), then run npm run release again`);
    }
  }
  const url = sh('gh', ['release', 'view', tag, '--repo', repo, '--json', 'url', '--jq', '.url']).trim();
  say(`released ${version}`);
  process.stdout.write(`${url}\n`);
}

interface Args {
  want: string | null;
  notesFile: string | null;
  yes: boolean;
}

export function parseArgs(argv: string[]): Args | null {
  const out: Args = { want: null, notesFile: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') out.yes = true;
    else if (a === '--notes-file' && argv[i + 1] !== undefined && out.notesFile === null) out.notesFile = argv[++i];
    else if (!a.startsWith('-') && out.want === null && ((BUMPS as readonly string[]).includes(a) || SEMVER.test(a))) out.want = a;
    else return null;
  }
  if (out.notesFile && !out.want) return null;
  return out;
}

/**
 * The versions of origin/develop and origin/main and the release in flight, from the refs a fetch just updated.
 * develop's version is origin/develop's, not the working tree's: a landing made on local develop whose push was
 * declined or rejected must still read as in flight, so the next run finds the merged PR and pushes it.
 */
export function releaseState(root: string): { developVersion: string; mainVersion: string; flight: ReturnType<typeof inFlight> } {
  const developVersion = readVersion(gitOut(root, ['show', 'refs/remotes/origin/develop:package.json']), "origin/develop's package.json");
  const mainVersion = readVersion(gitOut(root, ['show', 'refs/remotes/origin/main:package.json']), "origin/main's package.json");
  const refs = gitOut(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/release/', 'refs/remotes/origin/release/']);
  return { developVersion, mainVersion, flight: inFlight(developVersion, mainVersion, releaseBranches(refs, developVersion)) };
}

async function release(args: Args): Promise<void> {
  const root = ROOT;
  if (git(root, 'symbolic-ref', '--short', 'HEAD') !== 'develop') throw new Refusal('check out develop first');
  const dirty = gitOut(root, ['status', '--porcelain', '--untracked-files=all']).trimEnd();
  if (dirty) throw new Refusal(`the working tree is not clean:\n${dirty}`);
  say('fetching develop, main, the release branches and the tags');
  gitOut(root, ['fetch', '--quiet', '--prune', '--tags', 'origin', '+refs/heads/develop:refs/remotes/origin/develop', '+refs/heads/main:refs/remotes/origin/main', '+refs/heads/release/*:refs/remotes/origin/release/*']);

  const { developVersion, flight } = releaseState(root);

  let version: string;
  if (args.want) {
    if (flight) {
      const where = flight.from === 'branch' ? `branch release/v${flight.version}` : `origin/main is at ${flight.version}`;
      throw new Refusal(`Release ${flight.version} is in flight (${where}): run \`npm run release\` with no version to finish it, or, for a hotfix on main, port it to develop first`);
    }
    if (!tagged(root, developVersion)) throw new Refusal(`${developVersion} is not tagged: finish or fix that release first (docs/RELEASES.md "Recovery")`);
    if (git(root, 'rev-parse', 'HEAD') !== git(root, 'rev-parse', 'refs/remotes/origin/develop')) throw new Refusal('develop differs from origin/develop: pull or push first');
    const next = nextVersion(developVersion, args.want);
    if (tagged(root, next)) throw new Refusal(`v${next} is already tagged`);
    const commit = prepare(root, developVersion, next, args.notesFile);
    await confirm(`Push Release ${next} (${commit.slice(0, 7)}) to origin release/v${next}?`, args.yes);
    gitOut(root, ['push', '--quiet', 'origin', `${commit}:refs/heads/release/v${next}`]);
    version = next;
  } else if (!flight) throw new Refusal(`nothing is in flight: name the next version (patch, minor, major or X.Y.Z)`);
  else version = flight.version;

  const repo = repoName();
  const branch = `release/v${version}`;
  const pr = pickReleasePr(JSON.parse(sh('gh', ['pr', 'list', '--repo', repo, '--base', 'main', '--head', branch, '--state', 'all', '--json', PR_FIELDS])), { version });
  if (pr?.state === 'merged') return land(root, repo, version, pr, args.yes);
  if (pr?.state === 'closed') throw new Refusal(`the release PR ${pr.url} was closed without merging: reopen it, or delete ${branch} (git push origin --delete ${branch}; git branch -D ${branch}) and start over`);
  return toPr(root, repo, `v${developVersion}`, version, pr, args.yes);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write('usage: npm run release -- [patch|minor|major|X.Y.Z [--notes-file <file>]] [--yes]\n');
    process.exit(2);
  }
  release(args).catch((e) => {
    process.stderr.write(`release: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
