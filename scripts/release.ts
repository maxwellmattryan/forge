// `npm run release -- [patch|minor|major|X.Y.Z] [--notes-file <file>] [--yes]`: Forge's own release, run by
// the maintainer on a clean develop (docs/RELEASES.md "Releasing"):
//   1. with a version: bump package.json, package-lock.json and .claude-plugin/plugin.json, draft the
//      CHANGELOG section from the commits since the last tag, open it in $EDITOR and commit `Release X.Y.Z`;
//   2. push develop, then wait for CI and main-update.yml's dashboard build on that commit;
//   3. download the build, check it (scripts/main-update.ts), and push develop's tree plus dashboard/dist/
//      to main, which runs release.yml: tag and GitHub Release.
// With no version it resumes an untagged release: every step checks whether it is done before it runs.
// The maintainer pushes main, not CI, because GITHUB_TOKEN can't push a commit that changes
// .github/workflows/, and a push or merge it makes starts no release.yml run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gitSync } from './git.ts';
import { releaseProblems } from './release-check.ts';
import { isReleaseSubject, mainCommit, mainOnlyCommits, oneLine, Refusal } from './main-update.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
const BUMPS = ['patch', 'minor', 'major'] as const;
const NOTE = '<!--';
// How long a workflow run may take to appear after its push, and to finish.
const APPEAR_MS = 3 * 60_000;
const FINISH_MS = 45 * 60_000;
const POLL_MS = 15_000;
// lib/core/job/schema.ts constants the notes report when they move, with the words CHANGELOG uses for them.
const VERSION_LABELS: Record<string, string> = {
  CONFIG_SCHEMA_VERSION: 'config schema',
  JOB_SCHEMA_VERSION: 'job schema',
  EVENT_SCHEMA_VERSION: 'event schema',
  ARCHIVE_SCHEMA_VERSION: 'archive schema',
  API_VERSION: '`API_VERSION`',
};

/** The version after `current`: a bump name, or an explicit X.Y.Z that must be greater. */
export function nextVersion(current: string, want: string): string {
  const c = SEMVER.exec(current);
  if (!c) throw new Refusal(`the current version ${JSON.stringify(current)} is not X.Y.Z`);
  const [major, minor, patch] = c.slice(1).map(Number);
  if (want === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (want === 'minor') return `${major}.${minor + 1}.0`;
  if (want === 'major') return `${major + 1}.0.0`;
  const w = SEMVER.exec(want);
  if (!w) throw new Refusal(`${JSON.stringify(want)} is not patch, minor, major or X.Y.Z`);
  const order = w.slice(1).map(Number).map((n, i) => n - [major, minor, patch][i]).find((d) => d !== 0) ?? 0;
  if (order <= 0) throw new Refusal(`${want} is not after the current version ${current}`);
  return want;
}

/** The files a version bump touches, and the JSON paths that must read the new version afterwards. */
const VERSION_FILES: [string, string[][]][] = [
  ['package.json', [['version']]],
  ['package-lock.json', [['version'], ['packages', '', 'version']]],
  [path.join('.claude-plugin', 'plugin.json'), [['version']]],
];

/** Rewrites only the version lines, so the files keep their formatting, then checks the JSON reads `to`. */
export function setVersion(root: string, from: string, to: string): void {
  const line = new RegExp(`("version":\\s*)"${from.replace(/\./g, '\\.')}"`, 'g');
  // Every file is checked before any is written, so a refusal never leaves a half-bumped tree.
  const writes: [string, string][] = [];
  for (const [rel, paths] of VERSION_FILES) {
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, 'utf8');
    let left = paths.length;
    // The first `version` lines are the ones the paths name: a lockfile lists its root before any dependency.
    const next = text.replace(line, (m, key) => (left-- > 0 ? `${key}"${to}"` : m));
    const json = JSON.parse(next);
    for (const p of paths) {
      const got = p.reduce<any>((o, k) => o?.[k], json);
      if (got !== to) throw new Refusal(`${rel}: ${p.join('.') || '""'} reads ${JSON.stringify(got)} after the bump, not ${to}`);
    }
    writes.push([file, next]);
  }
  for (const [file, text] of writes) fs.writeFileSync(file, text);
}

/**
 * Where the schema file has lived, newest first: a tag from before the lib/ layers (#421) has it at
 * lib/schema.ts.
 */
export const SCHEMA_FILES = ['lib/core/job/schema.ts', 'lib/schema.ts'];

/** The first of SCHEMA_FILES that `has` finds, or null when none is there. */
export function schemaFileAt(has: (rel: string) => boolean): string | null {
  return SCHEMA_FILES.find(has) ?? null;
}

/** `export const X_VERSION = n;` constants in a schema file's text. */
export function schemaVersions(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/^export const (\w+) = (\d+);/gm)) if (m[1] in VERSION_LABELS) out[m[1]] = Number(m[2]);
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

export const dropNotes = (text: string) => text.split('\n').filter((l) => !l.trimStart().startsWith(NOTE)).join('\n');

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

function sh(cmd: string, args: string[], opts: { input?: string; inherit?: boolean } = {}): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', input: opts.input, stdio: opts.inherit ? 'inherit' : 'pipe', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Refusal(`${cmd} ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
  return opts.inherit ? '' : r.stdout;
}
function gitOut(args: string[], opts: { input?: string } = {}): string {
  const r = gitSync(args, { cwd: ROOT, input: opts.input });
  if (r.error || r.status !== 0) throw new Refusal(`git ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
  return r.stdout;
}
const git = (...args: string[]) => gitOut(args).trim();
const gitOk = (args: string[]) => gitSync(args, { cwd: ROOT, stdio: 'ignore' }).status === 0;
const say = (s: string) => process.stderr.write(`${s}\n`);

const readVersion = (text: string): string => {
  const v = JSON.parse(text)?.version;
  if (typeof v !== 'string' || !SEMVER.test(v)) throw new Refusal(`package.json version ${JSON.stringify(v)} is not X.Y.Z`);
  return v;
};
const tagged = (v: string) => gitOk(['rev-parse', '-q', '--verify', `refs/tags/v${v}`]);

/** The newest vX.Y.Z tag, or null. */
function lastTag(): string | null {
  return git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').find((t) => /^v\d+\.\d+\.\d+$/.test(t)) ?? null;
}

async function confirm(question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) throw new Refusal(`${question} needs a terminal to answer, or --yes`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Refusal('stopped: nothing more was pushed');
}

function editNotes(file: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  if (!process.stdin.isTTY) throw new Refusal('editing the notes needs a terminal: pass --notes-file <file> instead');
  // Through the shell, so an editor setting with flags (`code --wait`) works as it does for git.
  sh('/bin/sh', ['-c', `${editor} "$1"`, 'editor', file], { inherit: true });
}

/** Bumps, drafts and commits `Release <next>` on the local develop. */
function prepare(current: string, next: string, notesFile: string | null): void {
  const since = lastTag();
  const subjects = git('log', '--first-parent', '--format=%s', ...(since ? [`${since}..HEAD`] : ['HEAD'])).split('\n').filter(Boolean);
  const old = since ? schemaFileAt((rel) => gitOk(['cat-file', '-e', `${since}:${rel}`])) : null;
  const before = since && old ? schemaVersions(gitOut(['show', `${since}:${old}`])) : {};
  const after = schemaVersions(fs.readFileSync(path.join(ROOT, SCHEMA_FILES[0]!), 'utf8'));
  const changelogFile = path.join(ROOT, 'CHANGELOG.md');
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

  setVersion(ROOT, current, next);
  fs.writeFileSync(changelogFile, insertSection(changelog, section));
  const problems = releaseProblems(ROOT, { dist: 'absent' }).filter((p) => !p.startsWith('the working tree is not clean'));
  if (problems.length) {
    gitOut(['checkout', '--', ...VERSION_FILES.map(([rel]) => rel), 'CHANGELOG.md']);
    throw new Refusal(`nothing was committed:\n${problems.join('\n')}`);
  }
  gitOut(['add', '--', ...VERSION_FILES.map(([rel]) => rel), 'CHANGELOG.md']);
  gitOut(['commit', '-q', '-F', '-'], { input: `Release ${next}\n` });
  say(`committed Release ${next} on develop`);
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

/** The commit on main whose second parent is `develop`, or null. */
function releasedTo(develop: string): string | null {
  for (const l of git('log', '--first-parent', '--merges', '-50', '--format=%H %P', 'refs/remotes/origin/main').split('\n')) {
    const [sha, , second] = l.split(' ');
    if (second === develop) return sha;
  }
  return null;
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

async function release(args: Args): Promise<void> {
  if (git('symbolic-ref', '--short', 'HEAD') !== 'develop') throw new Refusal('check out develop first');
  const dirty = gitOut(['status', '--porcelain', '--untracked-files=all']).trimEnd();
  if (dirty) throw new Refusal(`the working tree is not clean:\n${dirty}`);
  say('fetching develop, main and the tags');
  gitOut(['fetch', '--quiet', '--tags', 'origin', '+refs/heads/develop:refs/remotes/origin/develop', '+refs/heads/main:refs/remotes/origin/main']);

  let version = readVersion(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (args.want) {
    if (!tagged(version)) throw new Refusal(`${version} is not released yet: run \`npm run release\` with no version to finish it`);
    if (git('rev-parse', 'HEAD') !== git('rev-parse', 'refs/remotes/origin/develop')) throw new Refusal('develop differs from origin/develop: pull or push first');
    const next = nextVersion(version, args.want);
    if (tagged(next)) throw new Refusal(`v${next} is already tagged`);
    prepare(version, next, args.notesFile);
    version = next;
  } else if (tagged(version)) throw new Refusal(`${version} is released: name the next version (patch, minor, major or X.Y.Z)`);

  const problems = releaseProblems(ROOT, { dist: 'absent' });
  if (problems.length) throw new Refusal(problems.join('\n'));

  const develop = git('rev-parse', 'HEAD');
  const remote = git('rev-parse', 'refs/remotes/origin/develop');
  if (develop !== remote) {
    if (!gitOk(['merge-base', '--is-ancestor', remote, develop])) throw new Refusal('origin/develop has commits this develop lacks: pull first');
    await confirm(`Push ${git('rev-list', '--count', `${remote}..${develop}`)} commit(s) ending in Release ${version} to develop?`, args.yes);
    gitOut(['push', '--quiet', 'origin', `${develop}:refs/heads/develop`]);
  }

  const repo = repoName();
  let onMain = releasedTo(develop);
  if (!onMain) {
    const main = git('rev-parse', 'refs/remotes/origin/main');
    const hotfixes = mainOnlyCommits(main, develop);
    if (hotfixes.length) {
      say('These commits are on main but not develop; this release undoes any not ported to develop:');
      for (const c of hotfixes) say(`  ${c.sha} ${c.subject}`);
      await confirm('Were they all ported?', args.yes);
    }
    await waitForRun(repo, 'ci.yml', develop, 'develop');
    const build = await waitForRun(repo, 'main-update.yml', develop, 'develop');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-dist-'));
    try {
      sh('gh', ['run', 'download', String(build.id), '--repo', repo, '--name', 'dashboard-dist', '--dir', tmp]);
      const sha = mainCommit(main, develop, tmp);
      if (!SHA.test(sha)) throw new Refusal(`the main commit is ${JSON.stringify(sha)}`);
      await confirm(`Push Release ${version} to main (${sha.slice(0, 7)}: develop ${develop.slice(0, 7)} plus the dashboard from ${build.html_url})?`, args.yes);
      try {
        gitOut(['push', '--quiet', 'origin', `${sha}:refs/heads/main`]);
      } catch (e) {
        throw new Refusal(`${(e as Error).message}\nIf GitHub refused a workflow file, your credential lacks the workflow scope (gh auth refresh -s workflow). If main moved, run npm run release again.`);
      }
      onMain = sha;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (!gitOk(['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/v${version}`])) await waitForRun(repo, 'release.yml', onMain, 'main');
  const url = sh('gh', ['release', 'view', `v${version}`, '--repo', repo, '--json', 'url', '--jq', '.url']).trim();
  say(`released ${version}`);
  process.stdout.write(`${url}\n`);
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
