// Shared harness for the hidden checks of the paired eval tasks (.forge/evals/*, tag
// `restructure-pre`/`restructure-post`). Each task carries an identical copy under
// check/files/test/, because a check may only rely on what it brings: it drives `bin/forge` and the
// dashboard server from the outside and never imports lib/, so the same check grades a candidate
// on either side of a restructure of the engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

export const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

// Host git config (gpgsign, hooksPath) and a daemon session's markers must not decide a grade.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = os.devNull;
for (const k of Object.keys(process.env)) if (/^FORGE_DAEMON(_|$)|^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)) delete process.env[k];
delete process.env.CLAUDE_CONFIG_DIR;
process.env.FORGE_ACTOR = 'forge-eval';
process.env.FORGE_MODE = 'agent';

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Scratch {
  dir: string;
  git: (...args: string[]) => string;
  forge: (args: string[], env?: NodeJS.ProcessEnv) => Promise<CliResult>;
  cleanup: () => void;
}

/**
 * A throwaway git repo with Forge initialised from `answers` (merged over build, test and lint
 * set to `true`, worktrees in the `<dir>.wt` sibling). FORGE_ROOT pins every CLI call to it.
 */
export function scratch(answers: Record<string, unknown> = {}): Scratch {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eval-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'eval@example.com');
  git('config', 'user.name', 'Eval');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# eval\n');
  const file = path.join(os.tmpdir(), `forge-eval-answers-${process.pid}-${Date.now()}.json`);
  const { commands, ...rest } = answers as { commands?: Record<string, unknown> };
  fs.writeFileSync(file, JSON.stringify({ commands: { build: 'true', test: 'true', lint: 'true', ...commands }, worktrees: { root: '../{repo}.wt' }, ...rest }));
  try {
    execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', file], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  } finally {
    fs.rmSync(file, { force: true });
  }
  git('add', '-A');
  git('commit', '-qm', 'init');
  const forge = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    new Promise<CliResult>((resolve) => {
      execFile(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: dir, ...env }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (err as { code?: unknown }).code : 0;
        resolve({ status: typeof code === 'number' ? code : null, stdout, stderr });
      });
    });
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.wt`, { recursive: true, force: true });
  };
  return { dir, git, forge, cleanup };
}

/** The CLI's JSON reply on stdout, or a failure that shows what it printed instead. */
export function json(r: CliResult): any {
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`not JSON (exit ${r.status}):\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
}

/** Polls `predicate` until it returns something truthy. */
export async function waitFor<T>(predicate: () => T | Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`waitFor: still false after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
