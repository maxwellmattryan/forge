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
import { isOwnWorktreePath } from './core/config/load.ts';
import { renderEnvFile, renderMerge, renderTemplate, resolveString, sinkProblems } from './core/config/sinks.ts';
import type { ExprContext } from './core/config/sinks.ts';
import { git } from './git.ts';
import { jobDir } from './core/job/store.ts';
import { recordKnown, redactKnown } from './known-secrets.ts';
import { writeIfChanged } from './links.ts';
import { posixShell } from './core/os/platform.ts';
import { resolveSecret } from './secret-refs.ts';
import { declaredSecrets } from './core/config/validators/secret-refs.ts';
import type { ComponentConfig, Config, ConfigSink, Job } from './core/types.ts';
import { ForgeError } from './core/errors.ts';
import { run } from './core/os/process.ts';

/** What a `forge run` result and the `config-sinks` event carry: names, paths and a count, never values. */
export interface SinkSummary {
  component: string;
  /** The env sinks' variable names. */
  env: string[];
  /** The rendered files, relative to the worktree, with `/`. */
  files: string[];
  /** How many command sinks ran. */
  commands: number;
  /** The `{secret.NAME}` names this render resolved, sorted; never their values. */
  secrets: string[];
}

export interface AppliedSinks {
  /** The env sinks' variables, merged into the command's environment. */
  env: Record<string, string>;
  summary: SinkSummary;
  /** The secret values this render resolved: in memory only, for redacting what the command writes. */
  values: string[];
}

export interface ApplyOptions {
  /** The command's environment (envFor), which command sinks run under too. */
  env: NodeJS.ProcessEnv;
  /** Fills a command sink's `{job}`/`{port}`/`{worktree}`/`{branch}`/`{base}` like other templates. */
  fillCmd: (template: string) => string;
}

const posix = (p: string): string => p.split(path.sep).join('/');

/** The realpath of `child` when it resolves inside `parentReal` (a realpath); null otherwise or when it does not exist. */
function realInside(parentReal: string, child: string): string | null {
  try {
    const real = fs.realpathSync.native(child);
    const rel = path.relative(parentReal, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? real : null;
  } catch {
    return null;
  }
}

const resolvesInside = (parentReal: string, child: string): boolean => realInside(parentReal, child) !== null;

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
  const problems = sinkProblems(sinks, `components ${JSON.stringify(component.name)}.config`, component, declaredSecrets(config));
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
  const resolvedSecrets = new Map<string, string>();
  // Only names an expression reaches are read; each value is recorded before any write or command
  // sink, so serve-time redaction knows it even when the render fails later.
  const secret = (name: string): string => {
    const hit = resolvedSecrets.get(name);
    if (hit !== undefined) return hit;
    const v = resolveSecret(root, config, name);
    resolvedSecrets.set(name, v);
    recordKnown(root, job.id, { [name]: v });
    return v;
  };
  const ctx: ExprContext = { job: job.id, port: job.port ?? null, worktree, branch: job.branch ?? '', base: job.base ?? '', component: { name: component.name, path: component.path, dir: componentDir }, secret };
  const env: Record<string, string> = {};
  const summary: SinkSummary = { component: component.name, env: [], files: [], commands: 0, secrets: [] };
  const label = (i: number) => `config sink ${i} of component ${JSON.stringify(component.name)}`;

  /** `rel` (relative to the component dir) as an absolute path and its worktree-relative form; refused outside the worktree. */
  const place = (rel: string, what: string): { abs: string; rel: string } => {
    const abs = path.resolve(componentDir, rel);
    const r = path.relative(worktree, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new ForgeError(`${what} ${rel} is outside the job's worktree`);
    return { abs, rel: posix(r) };
  };

  /** Writes `content` to an output path after the confinement and git-ignore checks. */
  const writeOutput = (i: number, rel: string, content: string): void => {
    const out = place(rel, `${label(i)} path`);
    const parent = path.dirname(out.abs);
    // Before and after mkdir: an existing ancestor that is a symlink out of the worktree is refused
    // without creating anything, and a dir that appeared meanwhile is checked again.
    const refuse = () => new ForgeError(`config sink path ${out.rel} has a parent directory that resolves outside the job's worktree`);
    if (!resolvesInside(worktreeReal, deepestExisting(parent))) throw refuse();
    fs.mkdirSync(parent, { recursive: true });
    const parentReal = realInside(worktreeReal, parent);
    if (parentReal === null) throw refuse();
    // git judges the file's real location: a parent symlink that stays inside the worktree (`out -> ../..`)
    // would let an ignored logical path land on a tracked file. Tracked files are not ignored (no
    // --no-index), so one refusal covers both; `--` keeps the path from reading as an option.
    const realRel = posix(path.join(path.relative(worktreeReal, parentReal), path.basename(out.abs)));
    const ignored = git(worktreeReal, ['check-ignore', '-q', '--', realRel], { allowFail: true });
    if (!ignored.ok) throw new ForgeError(`config sink path ${out.rel}${realRel === out.rel ? '' : ` (${realRel})`} must be git-ignored and untracked; add it to .gitignore`);
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
    const out = place(rel, 'config sink path');
    let st: fs.Stats;
    try {
      st = fs.lstatSync(out.abs);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    // As for `from`: a hard link would merge a file from anywhere into a render the checkout can read.
    if (st.nlink > 1) throw new ForgeError(`config sink path ${out.rel} must not be a hard link`);
    return fs.readFileSync(out.abs, 'utf8');
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
      runCommandSink(root, job, component, i, sink.command, resolved(i, sink.values), opts, [...resolvedSecrets.values()]);
      summary.commands += 1;
    }
  });
  summary.secrets = [...resolvedSecrets.keys()].sort();
  return { env, summary, values: [...resolvedSecrets.values()] };
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
    const detail = !base || !(err.cause instanceof Error) ? '' : base.from ? `: ${err.cause.message}` : '; delete it or fix it by hand';
    throw new ForgeError(`config sink ${i}${where}: ${err.message}${detail}`);
  }
}

/**
 * A command sink: the project's script, in the component dir, with the values as env and as JSON on
 * stdin. Its output goes only to `<jobDir>/logs/config-<component>-<timestamp>-<i>.log`, with the
 * secret values resolved so far (`known`) redacted.
 */
function runCommandSink(root: string, job: Job, component: ComponentConfig, i: number, template: string, values: Record<string, string>, opts: ApplyOptions, known: string[]): void {
  const cmd = opts.fillCmd(template);
  const cwd = path.join(job.worktree!, component.path);
  const res = run(posixShell(), ['-lc', cmd], { cwd, env: { ...opts.env, ...values }, input: JSON.stringify(values), allowFail: true });
  const logDir = path.join(jobDir(root, job.id), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  // `i` keeps two sinks that finish in the same millisecond from sharing a log.
  const logFile = path.join(logDir, `config-${component.name.replace(/[\\/]/g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-')}-${i}.log`);
  fs.writeFileSync(logFile, redactKnown(`$ ${cmd}\n(cwd ${cwd})\n\n${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}\n\n[exit ${res.status}]\n`, known));
  if (!res.ok) throw new ForgeError(`config sink command ${i} of component ${JSON.stringify(component.name)} exited ${res.status ?? 'without a status'}; see ${logFile}`);
}
