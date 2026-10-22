// A three-repo scratch project for the downstream verification tests (issue #186): a root repo `core`
// holding the library component `core`, and member clones `app-a` and `app-b`, each with a component
// that depends on `core` through a cmake link. Each consumer's `test` reads $FORGE_CMAKE_ARGS for the
// linked dir and fails when `<dir>/BREAK-<repo>` exists, so a break only one consumer sees is easy to
// stage. Every repo has an `origin` bare remote; all of it sits under one temp parent that cleanup
// removes (worktrees included: worktrees.root puts them in <parent>/<clone>.worktrees). No real
// toolchain and no GitHub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, scratchGitConfig } from './helpers.ts';
import * as yaml from '../lib/core/format/yaml.ts';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

export const CONSUMERS = ['app-a', 'app-b'] as const;

function initClone(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  scratchGitConfig((...a: string[]) => git(dir, ...a));
  for (const [rel, text] of Object.entries({ 'README.md': `# ${path.basename(dir)}\n`, ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

/** The consumer's test: the linked core dir must be there, and must not hold BREAK-<repo>. */
export const consumerTest = (repo: string) =>
  `d=$(printf '%s' "$FORGE_CMAKE_ARGS" | sed -e "s/^'-DFETCHCONTENT_SOURCE_DIR_CORE=//" -e "s/'$//"); test -d "$d" && test -f "$d/core.txt" && test ! -e "$d/BREAK-${repo}" && echo "${repo} OK against $d"`;

let template: string | null = null;

async function buildTemplate(): Promise<string> {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-downstream-')));
  const core = path.join(parent, 'core');
  initClone(core, { 'core/core.txt': 'core v1\n' });
  for (const name of CONSUMERS) initClone(path.join(parent, name), { 'app.txt': `${name}\n` });
  const answers = path.join(parent, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'echo ROOT-TEST' }, verify: ['test'] }));
  const r = await forgeAsync(core, ['init', 'write', '--answers', answers, '--force']);
  if (r.status !== 0) throw new Error(`forge init write: ${r.stderr}${r.stdout}`);
  fs.rmSync(answers);
  git(core, 'add', '-A');
  git(core, 'commit', '-qm', 'forge init');
  for (const name of ['core', ...CONSUMERS]) git(parent, 'clone', '-q', '--bare', name, `${name}.git`);
  process.on('exit', () => fs.rmSync(parent, { recursive: true, force: true }));
  return parent;
}

export interface DownstreamProject {
  parent: string;
  root: string;
  clone: (name: string) => string;
  git: (cwd: string, ...args: string[]) => string;
  /** forge in the root; throws on a non-zero exit and parses JSON output. */
  f: (...args: string[]) => Promise<any>;
  /** forge in the root, with its exit status and both streams. */
  raw: (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  /** Rewrites .forge/config.yml with `edit` applied to it. */
  config: (edit: (c: any) => void) => void;
  events: (id: string) => any[];
  jobFile: (id: string) => string;
  /** Where job `id`'s worktree of `repo` (null: the root) goes. */
  worktree: (id: string, repo?: string | null) => string;
  cleanup: () => void;
}

/** A fresh copy of the project: app-a and app-b are `repos` entries, local.yml points at both. */
export async function downstreamProject(): Promise<DownstreamProject> {
  template ??= await buildTemplate();
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-downstream-')));
  fs.cpSync(template, parent, { recursive: true });
  const root = path.join(parent, 'core');
  const clone = (name: string) => path.join(parent, name);
  for (const name of ['core', ...CONSUMERS]) {
    git(clone(name), 'remote', 'add', 'origin', path.join(parent, `${name}.git`));
    git(clone(name), 'fetch', '-q', 'origin');
  }
  const configFile = path.join(root, '.forge', 'config.yml');
  const config = (edit: (c: any) => void) => {
    const c = yaml.parse(fs.readFileSync(configFile, 'utf8'));
    edit(c);
    fs.writeFileSync(configFile, yaml.stringify(c));
  };
  config((c) => {
    c.tracker = { kind: 'none' };
    c.repos = CONSUMERS.map((name) => ({ name, remote: path.join(parent, `${name}.git`), defaultBranch: 'main', tracker: { kind: 'none' } }));
    c.components = [
      { name: 'core', path: 'core', kind: 'library' },
      ...CONSUMERS.map((name) => ({
        name: `${name}-app`,
        repo: name,
        path: '.',
        kind: 'app',
        commands: { test: consumerTest(name) },
        dependsOn: [{ component: 'core', type: 'build', link: { ecosystem: 'cmake', name: 'core' } }],
      })),
    ];
  });
  fs.writeFileSync(path.join(root, '.forge', 'local.yml'), `repos:\n${CONSUMERS.map((n) => `  ${n}:\n    path: ../${n}\n`).join('')}`);
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
  const jobFile = (id: string) => path.join(root, '.forge', 'jobs', id, 'job.json');
  const events = (id: string) =>
    fs
      .readFileSync(path.join(root, '.forge', 'jobs', id, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const worktree = (id: string, repo: string | null = null) => path.join(parent, `${repo ?? 'core'}.worktrees`, id);
  return { parent, root, clone, git, f, raw, config, events, jobFile, worktree, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}
