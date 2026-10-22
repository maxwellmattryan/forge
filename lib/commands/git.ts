// `forge git diff|log|show|range-diff …`: read-only history for agents (`add`/`commit`, which
// write, are further down). These subcommands take
// `--output=<file>`, which writes anywhere git can, `.git/config` included (where a textconv or
// filter driver then runs on the next diff or add). A Bash prefix rule can't exclude one flag,
// so the daemon allows this wrapper instead of `Bash(git diff:*)` (docs/ARCHITECTURE.md "Daemon security").
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { attributionForbidden, findAttribution } from '../attribution.ts';
import { sessionEnv } from '../daemon.ts';
import { PINNED_GIT_CONFIG } from '../git-pins.ts';
import { PINNED_DIFF_OPTS } from '../integrity.ts';
import { jobDir, loadJob } from '../jobs.ts';
import { memberWorktree } from '../job-repos.ts';
import { policyRules } from '../policy-check.ts';
import { blobReader, checkProtected, comparisonPoint, diffEntries, historyEnv, logEscalated, logRefused, prefixHits, recordProtected, refusalText } from '../protected.ts';
import { resolveWorktreePaths } from '../paths.ts';
import { knownValues } from '../known-secrets.ts';
import { applyAllowlist, diffUnits, loadAllowlist, logSecrets, refusalMessage, refuseSecrets, scanUnits, secretMode, secretsBlock, textUnit } from '../secrets.ts';
import { ForgeError, run } from '../util.ts';
import { usageError } from './args.ts';
import type { CommandHelp, Config, HelpGroup, Job, ProtectedHit } from '../types.ts';

// Re-exported: callers (and tests) imported it from here before it moved to lib/paths.ts.
export { resolveWorktreePaths };

export const READ_SUBCOMMANDS: string[] = ['diff', 'log', 'show', 'range-diff'];

const readHelp = (sub: string): CommandHelp => ({
  command: `git ${sub}`,
  args: '[git args] [-- <path>...]',
  summary: `read-only git ${sub} in the current directory, for agents: git's output and exit code pass through; --output, --ext-diff, --textconv and --open-files-in-pager are refused`,
  exits: [
    [1, 'a refused option'],
    [5, 'git failed to start'],
  ],
});

const GIT: HelpGroup = {
  name: 'git',
  summary: "read-only git for agents, and staging and committing in a job's worktree",
  commands: [
    ...READ_SUBCOMMANDS.map(readHelp),
    {
      command: 'git add',
      args: '<id> [--repo NAME] -- <path>...',
      summary: "stage paths in the job's worktree, from any cwd; refuses git options, paths outside the worktree and a protected path the policy refuses; prints protected: <n> when the branch changes escalate paths",
      flags: [['--repo NAME', "stage in member repo NAME's worktree instead (not a verify-only repo)"]],
      exits: [
        [1, 'no such job or worktree, an option, a path outside the worktree or in .git, or a protected path (code protected_path)'],
        [5, 'git failed'],
      ],
      readme: true,
    },
    {
      command: 'git commit',
      args: '<id> [--repo NAME] (--message T | --message-file F) [-- <path>...]',
      summary:
        "commit in the job's worktree, on its branch, from any cwd (how agents commit, in a daemon session too); refuses git options, paths outside the worktree, AI attribution, a protected path the policy refuses and a likely secret (in the message always; in the staged changes under verifySecrets: block); prints protected: <n> when the branch changes escalate paths",
      flags: [
        ['--repo NAME', "commit in member repo NAME's worktree instead (not a verify-only repo; protected paths are root-repo paths and not checked there)"],
        ['--message T', 'the commit message'],
        ['--message-file F', 'read the message from F, a file inside the job dir'],
      ],
      exits: [
        [1, 'no such job or worktree, the wrong branch, a merge or rebase in progress, nothing to commit, a refused option, path or message, a protected path (code protected_path), or a likely secret (code secret_found)'],
        [5, 'git failed'],
      ],
      readme: true,
    },
  ],
};

export const HELP: HelpGroup[] = [GIT];

/** Options that write files or run config-defined programs. Git doesn't accept abbreviations of these. */
const REFUSED = /^--(output|ext-diff|textconv|open-files-in-pager)(=|$)/;

/**
 * The argv git runs: refused options rejected before `--`, and external diff and textconv
 * forced off (placed before `--`, after the caller's options, so they win).
 * `args` is `<subcommand> [options] [revisions] [-- paths]`.
 */
export function gitReadArgv(args: string[]): string[] {
  const [sub, ...rest] = args;
  if (!READ_SUBCOMMANDS.includes(sub)) throw new ForgeError(`forge git runs only ${READ_SUBCOMMANDS.join(', ')} (got ${JSON.stringify(sub ?? '')})`, 'usage');
  const dashdash = rest.indexOf('--');
  const opts = dashdash < 0 ? rest : rest.slice(0, dashdash);
  const paths = dashdash < 0 ? [] : rest.slice(dashdash);
  const bad = opts.filter((a) => REFUSED.test(a));
  if (bad.length) throw new ForgeError(`forge git refuses ${bad.join(', ')}: it writes files or runs configured programs`);
  return ['--no-pager', sub, ...opts, '--no-ext-diff', '--no-textconv', ...paths];
}

/** Runs git in the current directory with stdout/stderr passed through. */
export function gitRead(args: string[]): number {
  const res = spawnSync('git', gitReadArgv(args), { stdio: 'inherit' });
  if (res.error) throw new ForgeError(`git failed to start: ${res.error.message}`, 'external');
  return res.status ?? 1;
}

// `forge git add|commit <job> …`: the only way a daemon session stages and commits. Its cwd is the
// main checkout and its allowlist has no `cd` or `git -C`, so a bare `git commit` would land on the
// base branch. These run git in the job's worktree only, take no git options at all (no `-c`,
// `--no-verify`, `--amend`, `-C`, `--git-dir`), and keep every path inside the worktree.

export interface GitWriteArgs {
  message: string | null;
  messageFile: string | null;
  paths: string[];
  /** A member repo (`--repo`): stage and commit in its worktree instead of the root's. */
  repo?: string;
}

const MESSAGE_FILE_MAX = 1024 * 1024;

/** `[--repo R] [--message T | --message-file P] [-- paths…]`, strictly: any other option is refused. */
export function parseGitWriteArgs(args: string[]): GitWriteArgs {
  const out: GitWriteArgs = { message: null, messageFile: null, paths: [] };
  const set = (key: 'message' | 'messageFile', flag: string, v: string | undefined) => {
    if (v === undefined) throw new ForgeError(`${flag} needs a value`);
    if (out.message !== null || out.messageFile !== null) throw new ForgeError('pass exactly one of --message or --message-file');
    out[key] = v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.paths = args.slice(i + 1);
      break;
    }
    if (a === '--repo' || a.startsWith('--repo=')) {
      const v = a === '--repo' ? args[++i] : a.slice('--repo='.length);
      if (!v || v.startsWith('-')) throw new ForgeError('--repo needs a repo name');
      if (out.repo !== undefined) throw new ForgeError('pass --repo once');
      out.repo = v;
    } else if (a === '--message' || a === '--message-file') set(a === '--message' ? 'message' : 'messageFile', a, args[++i]);
    else if (a.startsWith('--message=')) set('message', '--message', a.slice('--message='.length));
    else if (a.startsWith('--message-file=')) set('messageFile', '--message-file', a.slice('--message-file='.length));
    else if (a.startsWith('-')) throw new ForgeError(`forge git refuses ${JSON.stringify(a.slice(0, 80))}: it takes only --message or --message-file, then -- and paths`);
    else throw new ForgeError(`unexpected argument ${JSON.stringify(a.slice(0, 80))}: paths go after --`);
  }
  return out;
}

/** Git's environment: the caller's, minus anything that points git at another repo, with the daemon's pins under FORGE_DAEMON=1. */
function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = { ...env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) delete base[k];
  // Outside the daemon a human's hooks run as they would for a plain `git commit`.
  return env.FORGE_DAEMON === '1' ? sessionEnv(base) : base;
}

/** What the protected-paths preview found: refusals among this call's changes, the escalate set S, and the comparison point. */
interface ProtectedPreview {
  refused: ProtectedHit[];
  escalated: ProtectedHit[];
  own: ProtectedHit[];
  m: string;
  /** A member repo's escalate set as paths in its worktree, before they were named `<repo>:<path>`. */
  local?: ProtectedHit[];
  /** The real index, and the checked preview that installPreview puts in its place. */
  index: string;
  tmp: string;
}

function dropPreview(tmp: string): void {
  fs.rmSync(tmp, { force: true });
  fs.rmSync(`${tmp}.lock`, { force: true });
}

/**
 * Makes the checked preview the real index, through git's own lock file, instead of running `add`
 * again: a second `add` would read the worktree again, and a write in between could stage content
 * the check never saw. The preview's mtime goes with it, so git's racy-entry check is unchanged.
 */
function installPreview(p: ProtectedPreview, cwd: string): void {
  const lock = `${p.index}.lock`;
  try {
    try {
      fs.copyFileSync(p.tmp, lock, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ForgeError(`${lock} exists: another git process is using the index in ${cwd}; run the command again once it ends`);
      throw e;
    }
    try {
      const st = fs.statSync(p.tmp);
      fs.utimesSync(lock, st.atime, st.mtime);
      fs.renameSync(lock, p.index);
    } catch (e) {
      fs.rmSync(lock, { force: true });
      throw e;
    }
  } finally {
    dropPreview(p.tmp);
  }
}

/**
 * Previews the index `git add -A -- <paths>` would produce, in a temp copy of the index inside the
 * job dir (removed on a throw, else installed or dropped by the caller), and checks it against the
 * policy before anything is written. C is
 * what differs between HEAD and the preview (this call's commit), D what differs from the comparison
 * point M (the branch). A refuse path is refused only when it is in both, so putting a path back to
 * its M content, or leaving a path the call doesn't touch, stays possible. Null with the policy off.
 */
function protectedPreview(config: Config, job: Job, cwd: string, dir: string, genv: NodeJS.ProcessEnv, paths: string[]): ProtectedPreview | null {
  const rules = policyRules(config);
  if (!rules.length) return null;
  const henv = historyEnv(genv);
  let m: string;
  try {
    m = comparisonPoint(cwd, config, job, 'HEAD', henv);
  } catch (e) {
    throw new ForgeError(`can't find where ${job.id}'s branch starts, so its protected paths can't be checked (${(e as Error).message})`, 'protected_path');
  }
  const index = path.resolve(cwd, run('git', ['rev-parse', '--git-path', 'index'], { cwd, env: genv }).stdout.trim());
  const tmp = path.join(dir, `.protected-index-${process.pid}-${Date.now()}`);
  const penv = { ...genv, GIT_INDEX_FILE: tmp };
  try {
    if (fs.existsSync(index)) {
      fs.copyFileSync(index, tmp, fs.constants.COPYFILE_EXCL);
      // Git trusts an entry's stat data only when the file is older than the index file. A fresh copy
      // is newer than everything, so a same-size edit made just before would read as unchanged; the
      // original's mtime (a second earlier, against rounding) keeps git's racy-entry check intact.
      const st = fs.statSync(index);
      fs.utimesSync(tmp, st.atime, new Date(st.mtimeMs - 1000));
    } else run('git', ['read-tree', 'HEAD'], { cwd, env: penv });
    run('git', ['--literal-pathspecs', 'add', '-A', ...(paths.length ? ['--', ...paths] : [])], { cwd, env: penv });
    const denv = historyEnv(penv);
    const c = new Set(diffEntries(cwd, 'HEAD', 'index', denv).map((e) => e.path));
    const found = checkProtected(diffEntries(cwd, m, 'index', denv), rules, blobReader(cwd, denv), cwd);
    return { refused: found.refused.filter((h) => c.has(h.path)), escalated: found.escalated, own: found.escalated.filter((h) => c.has(h.path)), m, index, tmp };
  } catch (e) {
    dropPreview(tmp);
    throw e;
  }
}

export function gitWrite(
  root: string,
  config: Config,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { id: string; staged: string[]; protected?: number } | { id: string; sha: string; branch: string; files: string[]; secrets?: number; protected?: number } {
  const [sub, id, ...rest] = args;
  if (sub !== 'add' && sub !== 'commit') throw usageError(GIT);
  if (!id || id.startsWith('-')) throw usageError(GIT, sub);
  const job = loadJob(root, id);
  const opts = parseGitWriteArgs(rest);
  // A member repo: its checked worktree (never the stored path as is), and never its clone.
  const member = opts.repo === undefined ? null : memberWorktree(root, config, job, opts.repo);
  if (member?.member.verifyOnly) throw new ForgeError(`repo ${member.member.repo} is verify-only: the job never commits there`);
  if (!member && (!job.worktree || !fs.existsSync(job.worktree))) throw new ForgeError(`job ${id} has no worktree`);
  const cwd = fs.realpathSync(member ? member.worktree : job.worktree!);
  const genv = gitEnv(env);
  const git = (a: string[], o: { allowFail?: boolean } = {}) => run('git', a, { cwd, env: genv, allowFail: o.allowFail });
  const toplevel = (dir: string) => {
    const r = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env: genv, allowFail: true });
    return r.ok ? fs.realpathSync(r.stdout.trim()) : null;
  };
  const top = toplevel(cwd);
  if (cwd === fs.realpathSync(root) || (top !== null && top === toplevel(root))) throw new ForgeError(`forge git ${sub} refuses to commit in the main checkout (${cwd})`);
  if (member && (cwd === fs.realpathSync(member.clone) || (top !== null && top === toplevel(member.clone))))
    throw new ForgeError(`forge git ${sub} refuses to commit in repo ${member.member.repo}'s clone (${cwd}); only its job worktree`);
  if (top !== cwd) throw new ForgeError(`${cwd} is not the root of a git worktree`);
  const paths = resolveWorktreePaths(cwd, opts.paths);
  // Literal, so a path like `:(top)…` or `*` is a file name, not pathspec magic.
  const add = (ps: string[]) => git(['--literal-pathspecs', 'add', '-A', ...(ps.length ? ['--', ...ps] : [])]);
  const dir = fs.realpathSync(jobDir(root, id));
  /** Refuses before anything is written; returns the escalate set to record once the write is done. */
  // A member repo gets the root's policy over its own branch (from its own base); its hits are named
  // `<repo>:<path>` on the job flag, so one human approval covers every repo the job pushes.
  const guard = (): ProtectedPreview | null => {
    let p = protectedPreview(config, member ? { ...job, base: member.member.base } : job, cwd, dir, genv, paths);
    if (p && member) {
      const repo = member.member.repo;
      const named = prefixHits(repo, p);
      p = { ...p, ...named, own: prefixHits(repo, { refused: [], escalated: p.own }).escalated, local: p.escalated };
    }
    if (p?.refused.length) {
      dropPreview(p.tmp);
      logRefused(root, job.id, sub, p.refused);
      throw new ForgeError(refusalText(`forge git ${sub}`, p.refused), 'protected_path');
    }
    return p;
  };
  /** Stages exactly what guard checked; a plain add with the policy off. */
  const stage = (p: ProtectedPreview | null) => (p ? installPreview(p, cwd) : void add(paths));
  // The flag holds the whole job's set: keep the other repos' hits as the last check recorded them.
  // By the hit's `repo` tag, not its `<repo>:` name, which a root path can also begin with.
  const repoOf = (h: ProtectedHit) => (typeof h.repo === 'string' ? h.repo : null);
  const mine = member ? member.member.repo : null;
  const carried = (job.protectedPaths?.hits ?? []).filter((h) => typeof h?.path === 'string' && repoOf(h) !== mine);
  const record = (p: ProtectedPreview | null, head: string | null): { protected?: number } => {
    if (!p) return {};
    const src = { cwd, from: p.m, to: head ?? 'index', env: historyEnv(genv), paths: (p.local ?? p.escalated).map((h) => h.path), ...(mine === null ? {} : { repo: mine }) };
    recordProtected(root, job.id, sub, [...p.escalated, ...carried], head, src);
    if (p.own.length) logEscalated(root, job.id, sub, p.own, head);
    return p.escalated.length ? { protected: p.escalated.length } : {};
  };

  if (sub === 'add') {
    if (opts.message !== null || opts.messageFile !== null) throw new ForgeError('forge git add takes only -- and paths');
    if (!paths.length) throw new ForgeError('forge git add needs at least one path after --');
    const p = guard();
    stage(p);
    return { id, staged: opts.paths, ...record(p, null) };
  }

  const gitPath = (p: string) => path.resolve(cwd, git(['rev-parse', '--git-path', p]).stdout.trim());
  if (fs.existsSync(gitPath('rebase-merge')) || fs.existsSync(gitPath('rebase-apply')) || git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }).ok)
    throw new ForgeError(`a merge or rebase is in progress in ${cwd}; stage resolutions with \`forge git add ${id} -- <files>\` and finish with \`forge integrate ${id} --continue\``);

  // After the merge check: a rebase detaches HEAD, and its message is the useful one.
  const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true }).stdout.trim();
  if (!branch || branch !== job.branch) throw new ForgeError(`the worktree is on ${branch || 'a detached HEAD'}, not the job's branch ${job.branch}`);
  if ((opts.message === null) === (opts.messageFile === null)) throw new ForgeError('pass exactly one of --message or --message-file');
  let message: string;
  if (opts.messageFile !== null) {
    let file: string;
    try {
      file = fs.realpathSync(path.resolve(opts.messageFile));
    } catch {
      throw new ForgeError(`no message file ${JSON.stringify(opts.messageFile)}`);
    }
    if (path.relative(dir, file).startsWith('..') || path.isAbsolute(path.relative(dir, file))) throw new ForgeError(`--message-file must be inside the job dir ${dir}`);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MESSAGE_FILE_MAX) throw new ForgeError(`--message-file must be a regular file under 1 MiB`);
    message = fs.readFileSync(file, 'utf8');
  } else message = opts.message!;
  if (!message.trim()) throw new ForgeError('the commit message is empty');
  if (attributionForbidden(config)) {
    const hits = findAttribution(message);
    if (hits.length) throw new ForgeError(`AI attribution is not allowed in commits; remove these lines:\n${[...new Set(hits)].map((h) => `  - ${h}`).join('\n')}`);
  }

  // Before anything is staged: the message is text Forge publishes, refused in either mode.
  refuseSecrets(root, config, [textUnit('(commit message)', message)], { what: 'the commit message', id, gate: 'commit' });

  const p = guard();
  stage(p);
  if (git(['diff', '--cached', '--quiet'], { allowFail: true }).ok) throw new ForgeError(`nothing to commit in ${cwd}`);
  // A builder can't rewrite history through forge git, so this is the last point where it can still
  // take a key out. The index stays staged on a refusal, for the builder to fix.
  const mode = secretMode(config);
  const staged = diffUnits(git([...PINNED_GIT_CONFIG, 'diff', '--cached', ...PINNED_DIFF_OPTS, '--text', '-U0', '--']).stdout, 'staged');
  const found = applyAllowlist(scanUnits(staged.units, { config, known: knownValues(root, id, config) }), loadAllowlist(root));
  const blocked = secretsBlock(found.findings, mode);
  logSecrets(root, id, 'commit', found, { blocked });
  if (blocked) throw new ForgeError(refusalMessage('the staged changes', found.findings), 'secret_found', `forge secrets scan ${id}`);
  const tmp = path.join(dir, `.commit-msg-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, message);
  try {
    git(['commit', '-q', '-F', tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD']).stdout.split('\n').filter(Boolean);
  return { id, sha, branch, files, ...(found.findings.length ? { secrets: found.findings.length } : {}), ...record(p, sha) };
}
