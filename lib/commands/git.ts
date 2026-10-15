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
import { jobDir, loadJob } from '../jobs.ts';
import { resolveWorktreePaths } from '../paths.ts';
import { ForgeError, run } from '../util.ts';
import { usageError } from './args.ts';
import type { CommandHelp, Config, HelpGroup } from '../types.ts';

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
      args: '<id> -- <path>...',
      summary: "stage paths in the job's worktree, from any cwd; refuses git options and paths outside the worktree",
      exits: [
        [1, 'no such job or worktree, an option, or a path outside the worktree or in .git'],
        [5, 'git failed'],
      ],
      readme: true,
    },
    {
      command: 'git commit',
      args: '<id> (--message T | --message-file F) [-- <path>...]',
      summary: "commit in the job's worktree, on its branch, from any cwd (how agents commit, in a daemon session too); refuses git options, paths outside the worktree and AI attribution",
      flags: [
        ['--message T', 'the commit message'],
        ['--message-file F', 'read the message from F, a file inside the job dir'],
      ],
      exits: [
        [1, 'no such job or worktree, the wrong branch, a merge or rebase in progress, nothing to commit, a refused option, path or message'],
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
}

const MESSAGE_FILE_MAX = 1024 * 1024;

/** `[--message T | --message-file P] [-- paths…]`, strictly: any other option is refused. */
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
    if (a === '--message' || a === '--message-file') set(a === '--message' ? 'message' : 'messageFile', a, args[++i]);
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

export function gitWrite(root: string, config: Config, args: string[], env: NodeJS.ProcessEnv = process.env): { id: string; staged: string[] } | { id: string; sha: string; branch: string; files: string[] } {
  const [sub, id, ...rest] = args;
  if (sub !== 'add' && sub !== 'commit') throw usageError(GIT);
  if (!id || id.startsWith('-')) throw usageError(GIT, sub);
  const job = loadJob(root, id);
  const opts = parseGitWriteArgs(rest);
  if (!job.worktree || !fs.existsSync(job.worktree)) throw new ForgeError(`job ${id} has no worktree`);
  const cwd = fs.realpathSync(job.worktree);
  const genv = gitEnv(env);
  const git = (a: string[], o: { allowFail?: boolean } = {}) => run('git', a, { cwd, env: genv, allowFail: o.allowFail });
  const toplevel = (dir: string) => {
    const r = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env: genv, allowFail: true });
    return r.ok ? fs.realpathSync(r.stdout.trim()) : null;
  };
  const top = toplevel(cwd);
  if (cwd === fs.realpathSync(root) || (top !== null && top === toplevel(root))) throw new ForgeError(`forge git ${sub} refuses to commit in the main checkout (${cwd})`);
  if (top !== cwd) throw new ForgeError(`${cwd} is not the root of a git worktree`);
  const paths = resolveWorktreePaths(cwd, opts.paths);
  // Literal, so a path like `:(top)…` or `*` is a file name, not pathspec magic.
  const add = (ps: string[]) => git(['--literal-pathspecs', 'add', '-A', ...(ps.length ? ['--', ...ps] : [])]);

  if (sub === 'add') {
    if (opts.message !== null || opts.messageFile !== null) throw new ForgeError('forge git add takes only -- and paths');
    if (!paths.length) throw new ForgeError('forge git add needs at least one path after --');
    add(paths);
    return { id, staged: opts.paths };
  }

  const gitPath = (p: string) => path.resolve(cwd, git(['rev-parse', '--git-path', p]).stdout.trim());
  if (fs.existsSync(gitPath('rebase-merge')) || fs.existsSync(gitPath('rebase-apply')) || git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }).ok)
    throw new ForgeError(`a merge or rebase is in progress in ${cwd}; stage resolutions with \`forge git add ${id} -- <files>\` and finish with \`forge integrate ${id} --continue\``);

  // After the merge check: a rebase detaches HEAD, and its message is the useful one.
  const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true }).stdout.trim();
  if (!branch || branch !== job.branch) throw new ForgeError(`the worktree is on ${branch || 'a detached HEAD'}, not the job's branch ${job.branch}`);
  if ((opts.message === null) === (opts.messageFile === null)) throw new ForgeError('pass exactly one of --message or --message-file');
  const dir = fs.realpathSync(jobDir(root, id));
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

  add(paths);
  if (git(['diff', '--cached', '--quiet'], { allowFail: true }).ok) throw new ForgeError(`nothing to commit in ${cwd}`);
  const tmp = path.join(dir, `.commit-msg-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, message);
  try {
    git(['commit', '-q', '-F', tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD']).stdout.split('\n').filter(Boolean);
  return { id, sha, branch, files };
}
