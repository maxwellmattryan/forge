// Renders a component's config sinks (lib/config-sinks.ts) into the job's worktree right before one
// of its commands runs: env vars for the command, env files and config files written at 0o600
// through a temp file plus rename, and project scripts run with the values. The checkout is hostile
// (ARCHITECTURE.md "Untrusted input"): every output stays inside the job's own worktree, a symlink
// there is replaced rather than followed, a symlinked parent or `from` leading outside is refused,
// and an output git tracks or does not ignore is refused so job values never reach a commit. No
// rendered value is ever put in an error, an event or a log header. Must not import worktree.ts
// (it imports this module): the caller passes the command's env and its template filler.

import fs from 'node:fs';
import path from 'node:path';
import { isOwnWorktreePath } from './config.ts';
import { renderEnvFile, renderMerge, renderTemplate, resolveString, sinkProblems } from './config-sinks.ts';
import type { ExprContext } from './config-sinks.ts';
import { jobDir } from './jobs.ts';
import { writeIfChanged } from './links.ts';
import { posixShell } from './platform.ts';
import type { ComponentConfig, Config, ConfigSink, Job } from './types.ts';
import { ForgeError, run } from './util.ts';

/** What a `forge run` result and the `config-sinks` event carry: names, paths and a count, never values. */
export interface SinkSummary {
  component: string;
  /** The env sinks' variable names. */
  env: string[];
  /** The rendered files, relative to the worktree, with `/`. */
  files: string[];
  /** How many command sinks ran. */
  commands: number;
}

export interface AppliedSinks {
  /** The env sinks' variables, merged into the command's environment. */
  env: Record<string, string>;
  summary: SinkSummary;
}

export interface ApplyOptions {
  /** The command's environment (envFor), which command sinks run under too. */
  env: NodeJS.ProcessEnv;
  /** Fills a command sink's `{job}`/`{port}`/`{worktree}`/`{branch}`/`{base}` like other templates. */
  fillCmd: (template: string) => string;
}

const posix = (p: string): string => p.split(path.sep).join('/');

/** Whether `child` resolves inside `parentReal` (a realpath); false when it does not exist. */
function resolvesInside(parentReal: string, child: string): boolean {
  try {
    const rel = path.relative(parentReal, fs.realpathSync.native(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** The nearest ancestor of `p` (or `p` itself) that exists, by lstat, so a dangling symlink counts. */
function deepestExisting(p: string): string {
  let cur = p;
  for (;;) {
    try {
      fs.lstatSync(cur);
      return cur;
    } catch {}
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  return env;
}

/**
 * Renders every sink of `component` for `job` and returns the command's extra env and a summary,
 * or null when the component has no sinks. Throws a ForgeError (nothing partly written outside
 * the worktree) on a forged worktree, an unsafe path, a bad base file or a failing command sink.
 */
export function applySinks(root: string, config: Config, job: Job, component: ComponentConfig, opts: ApplyOptions): AppliedSinks | null {
  const sinks = component.config;
  if (!Array.isArray(sinks) || !sinks.length) return null;
  // `forge run` loads config without validating it, and the env-name rules (no `FORGE_*`, no `PORT`)
  // are what keep a sink from overriding the job markers it is merged over.
  const problems = sinkProblems(sinks, `components ${JSON.stringify(component.name)}.config`, component);
  if (problems.length) throw new ForgeError(`config sinks are invalid: ${problems.join('; ')}`, 'config_invalid');
  if (!isOwnWorktreePath(root, config, job.id, job.worktree)) throw new ForgeError("config sinks need the job's own worktree");
  const worktree = job.worktree!;
  let worktreeReal: string;
  try {
    worktreeReal = fs.realpathSync.native(worktree);
  } catch {
    throw new ForgeError(`job ${job.id} has no worktree yet; run: forge worktree create ${job.id}`);
  }
  const componentDir = path.join(worktree, component.path);
  const ctx: ExprContext = { job: job.id, port: job.port ?? null, worktree, branch: job.branch ?? '', base: job.base ?? '', component: { name: component.name, path: component.path, dir: componentDir } };
  const env: Record<string, string> = {};
  const summary: SinkSummary = { component: component.name, env: [], files: [], commands: 0 };
  const label = (i: number) => `config sink ${i} of component ${JSON.stringify(component.name)}`;

  /** `rel` (relative to the component dir) as an absolute path and its worktree-relative form; refused outside the worktree. */
  const place = (rel: string, what: string): { abs: string; rel: string } => {
    const abs = path.resolve(componentDir, rel);
    const r = path.relative(worktree, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new ForgeError(`${what} ${rel} is outside the job's worktree`);
    return { abs, rel: posix(r) };
  };

  /** Writes `content` to an output path after the git-ignore and confinement checks. */
  const writeOutput = (i: number, rel: string, content: string): void => {
    const out = place(rel, `${label(i)} path`);
    const parent = path.dirname(out.abs);
    // Before and after mkdir: an existing ancestor that is a symlink out of the worktree is refused
    // without creating anything, and a dir that appeared meanwhile is checked again.
    const refuse = () => new ForgeError(`config sink path ${out.rel} has a parent directory that resolves outside the job's worktree`);
    if (!resolvesInside(worktreeReal, deepestExisting(parent))) throw refuse();
    // Tracked files are not ignored (no --no-index), so one refusal covers both; `--` keeps the path from reading as an option.
    const ignored = run('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', 'check-ignore', '-q', '--', out.rel], { cwd: worktree, allowFail: true, env: gitEnv() });
    if (!ignored.ok) throw new ForgeError(`config sink path ${out.rel} must be git-ignored and untracked; add it to .gitignore`);
    fs.mkdirSync(parent, { recursive: true });
    if (!resolvesInside(worktreeReal, parent)) throw refuse();
    writeIfChanged(out.abs, content, 0o600);
    summary.files.push(out.rel);
  };

  /** The text of a `from` file: a regular file (not a symlink or a hard link) inside the worktree. */
  const readFrom = (i: number, rel: string): string => {
    const src = place(rel, `${label(i)} from`);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(src.abs);
    } catch {
      throw new ForgeError(`${label(i)}: from ${src.rel} does not exist`);
    }
    if (!st.isFile()) throw new ForgeError(`${label(i)}: from ${src.rel} must be a regular file, not a symlink or directory`);
    // A hard link resolves inside the worktree but reads a file from anywhere on the filesystem.
    if (st.nlink > 1) throw new ForgeError(`${label(i)}: from ${src.rel} must not be a hard link`);
    if (!resolvesInside(worktreeReal, src.abs)) throw new ForgeError(`${label(i)}: from ${src.rel} resolves outside the job's worktree`);
    return fs.readFileSync(src.abs, 'utf8');
  };

  /** The current output file as a merge base, when it is a regular file; a symlink there is replaced later, never read. */
  const currentText = (rel: string): string | null => {
    const { abs } = place(rel, 'config sink path');
    try {
      return fs.lstatSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null;
    } catch {
      return null;
    }
  };

  const resolved = (i: number, values: Record<string, string> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values ?? {})) out[k] = render(i, () => resolveString(v, ctx));
    return out;
  };

  sinks.forEach((sink: ConfigSink, i: number) => {
    if ('env' in sink) {
      for (const [k, v] of Object.entries(resolved(i, sink.env))) {
        env[k] = v;
        if (!summary.env.includes(k)) summary.env.push(k);
      }
    } else if ('env-file' in sink) {
      writeOutput(i, sink['env-file'], render(i, () => renderEnvFile(sink.values ?? {}, ctx)));
    } else if ('file' in sink) {
      const f = sink.file;
      if (f.mode === 'template') {
        const text = readFrom(i, f.from!);
        writeOutput(i, f.path, render(i, () => renderTemplate(f.format, text, ctx, posix(path.join(component.path, f.from!)))));
      } else {
        const base = f.from ? readFrom(i, f.from) : currentText(f.path);
        const baseName = posix(path.join(component.path, f.from ?? f.path));
        writeOutput(i, f.path, render(i, () => renderMerge(f.format, base, sink.values ?? {}, ctx), { name: baseName, from: Boolean(f.from) }));
      }
    } else {
      runCommandSink(root, job, component, i, sink.command, resolved(i, sink.values), opts);
      summary.commands += 1;
    }
  });
  return { env, summary };
}

/**
 * Runs a renderer, turning its error into a ForgeError that names the sink and, for a merge, the base
 * file. A parser's message quotes the text around the error: that is checkout content for a `from`
 * file, but the previous render at `path` holds job values, so there only a fix hint is given.
 */
function render<T>(i: number, fn: () => T, base?: { name: string; from: boolean }): T {
  try {
    return fn();
  } catch (e) {
    const err = e as Error;
    const where = base ? ` (${base.name})` : '';
    const detail = err.cause instanceof Error ? (base?.from ? `: ${err.cause.message}` : '; delete it or fix it by hand') : '';
    throw new ForgeError(`config sink ${i}${where}: ${err.message}${detail}`);
  }
}

/**
 * A command sink: the project's script, in the component dir, with the values as env and as JSON on
 * stdin. Its output goes only to `<jobDir>/logs/config-<component>-<timestamp>.log`.
 */
function runCommandSink(root: string, job: Job, component: ComponentConfig, i: number, template: string, values: Record<string, string>, opts: ApplyOptions): void {
  const cmd = opts.fillCmd(template);
  const cwd = path.join(job.worktree!, component.path);
  const res = run(posixShell(), ['-lc', cmd], { cwd, env: { ...opts.env, ...values }, input: JSON.stringify(values), allowFail: true });
  const logDir = path.join(jobDir(root, job.id), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `config-${component.name.replace(/[\\/]/g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  fs.writeFileSync(logFile, `$ ${cmd}\n(cwd ${cwd})\n\n${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}\n\n[exit ${res.status}]\n`);
  if (!res.ok) throw new ForgeError(`config sink command ${i} of component ${JSON.stringify(component.name)} exited ${res.status ?? 'without a status'}; see ${logFile}`);
}
