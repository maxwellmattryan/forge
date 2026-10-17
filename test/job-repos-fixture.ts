// A two-repo scratch project for the job repos tests: a root repo `app` and a member clone `lib`,
// each with an `origin` bare remote, all under one temp parent that cleanup removes (worktrees
// included: the default worktrees.root puts them in <parent>/<clone>.worktrees).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, scratchGitConfig } from './helpers.ts';
import * as yaml from '../lib/yaml.ts';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

function initClone(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  scratchGitConfig((...a: string[]) => git(dir, ...a));
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

let template: string | null = null;

async function buildTemplate(): Promise<string> {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-jobrepos-')));
  const app = path.join(parent, 'app');
  const lib = path.join(parent, 'lib');
  initClone(app);
  initClone(lib);
  const answers = path.join(parent, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'echo ROOT-TEST' }, verify: ['test'] }));
  const r = await forgeAsync(app, ['init', 'write', '--answers', answers, '--force']);
  if (r.status !== 0) throw new Error(`forge init write: ${r.stderr}${r.stdout}`);
  fs.rmSync(answers);
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'forge init');
  for (const name of ['app', 'lib']) git(parent, 'clone', '-q', '--bare', name, `${name}.git`);
  process.on('exit', () => fs.rmSync(parent, { recursive: true, force: true }));
  return parent;
}

export interface TwoRepo {
  parent: string;
  root: string;
  lib: string;
  rootBare: string;
  libBare: string;
  git: (cwd: string, ...args: string[]) => string;
  /** forge in the root; throws on a non-zero exit and parses JSON output. */
  f: (...args: string[]) => Promise<any>;
  /** forge in the root, with its exit status and both streams. */
  raw: (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  /** Writes `files` in `cwd` and commits them there. */
  commit: (cwd: string, files: Record<string, string>, msg?: string) => string;
  /** Rewrites .forge/config.yml with `edit` applied to it. */
  config: (edit: (c: any) => void) => void;
  events: (id: string) => any[];
  cleanup: () => void;
}

export const LIB_COMMANDS = {
  test: '[ ! -e FAIL ]',
  where: 'echo WT={worktree} BR={branch} BASE={base}',
};

/** A fresh copy of the two-repo project: lib is a `repos` entry with a `lib` component, and local.yml points at it. */
export async function twoRepo(): Promise<TwoRepo> {
  template ??= await buildTemplate();
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-jobrepos-')));
  fs.cpSync(template, parent, { recursive: true });
  const root = path.join(parent, 'app');
  const lib = path.join(parent, 'lib');
  const rootBare = path.join(parent, 'app.git');
  const libBare = path.join(parent, 'lib.git');
  git(root, 'remote', 'add', 'origin', rootBare);
  git(lib, 'remote', 'add', 'origin', libBare);
  git(root, 'fetch', '-q', 'origin');
  git(lib, 'fetch', '-q', 'origin');
  const configFile = path.join(root, '.forge', 'config.yml');
  const config = (edit: (c: any) => void) => {
    const c = yaml.parse(fs.readFileSync(configFile, 'utf8'));
    edit(c);
    fs.writeFileSync(configFile, yaml.stringify(c));
  };
  config((c) => {
    c.tracker = { ...(c.tracker ?? {}), github: { ...(c.tracker?.github ?? {}), repo: 'o/app' } };
    c.repos = [{ name: 'lib', remote: libBare, defaultBranch: 'main', tracker: { kind: 'github', repo: 'o/lib' } }];
    c.components = [{ name: 'lib', repo: 'lib', path: '.', kind: 'library', commands: { ...LIB_COMMANDS } }];
  });
  fs.writeFileSync(path.join(root, '.forge', 'local.yml'), 'repos:\n  lib:\n    path: ../lib\n');
  const raw = (args: string[], env: NodeJS.ProcessEnv = {}) => forgeAsync(root, args, env);
  const f = async (...args: string[]) => {
    const r = await raw(args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const commit = (cwd: string, files: Record<string, string>, msg = 'work') => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), text);
    }
    git(cwd, 'add', '-A');
    git(cwd, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg);
    return git(cwd, 'rev-parse', 'HEAD').trim();
  };
  const events = (id: string) =>
    fs
      .readFileSync(path.join(root, '.forge', 'jobs', id, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { parent, root, lib, rootBare, libBare, git, f, raw, commit, config, events, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}
