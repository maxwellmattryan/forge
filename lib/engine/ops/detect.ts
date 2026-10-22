// Inspects a repository so `/forge init` can propose answers instead of asking blind
// questions. Everything here is a suggestion; the human confirms during the interview.
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../../core/config/load.ts';
import { cargoMembers as membersOf, detectComponents, npmWorkspaces } from './detect-components.ts';
import { git as runGit } from '../../integrations/git/runner.ts';
import { exists } from '../../core/paths.ts';
import type { ProtectedRule } from '../../core/types.ts';
import { hasBinary } from '../../core/os/process.ts';
import { readText } from '../../core/os/fs.ts';
import * as yaml from '../../core/format/yaml.ts';

/** .github/project-config.yml as read for init: its fields are raw YAML, or `error` when it does not parse. */
export interface DetectedProject {
  file: string;
  owner?: any;
  number?: any;
  name?: any;
  statusField?: any;
  statusOptions?: any;
  error?: string;
}

/** What `forge init detect` prints: detect. */
export interface Detection {
  repo: { name: string; remoteUrl: string | null; github: string | null; branches: string[]; suggestedBase: string; originHead: string | null };
  instructions: { tracked: string[]; ignored: string[] };
  untracked: { env: string[] };
  stack: { kinds: string[]; packageManager: string | null; ui: string[]; cargoWorkspace: boolean; monorepo: boolean; workspaces: string[] };
  commands: Record<string, string | null>;
  infra: { files: string[]; clis: string[] };
  github: { project: DetectedProject | null; workflows: string[]; ghInstalled: boolean };
  design: { figma: string[] };
  repoAgents: string[];
  tools: { agentBrowser: boolean; playwright: boolean; cypress: boolean };
  suggestions: Record<string, unknown>;
}

const has = (root: string, rel: string): boolean => exists(path.join(root, rel));

// Parsed package.json: raw input.
function readJsonSafe(root: string, rel: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  } catch {
    return null;
  }
}

/** Dependencies that make a package a UI: the root's `stack.ui`, and an `app` component. */
const UI_PACKAGES = ['svelte', '@sveltejs/kit', 'react', 'next', 'vue', 'nuxt', 'solid-js', '@angular/core', 'astro', 'tauri', '@tauri-apps/api'];

const OUTPUT_DIRS = new Set(['dist', 'build', 'out']);

/** Committed build output a build command likely regenerates: `dist|build|out` at the top level or one below. */
function generatedDirs(tracked: string[]): string[] {
  const out = new Set<string>();
  for (const f of tracked) {
    const parts = f.split('/');
    if (parts.length >= 2 && OUTPUT_DIRS.has(parts[0])) out.add(`${parts[0]}/**`);
    else if (parts.length >= 3 && OUTPUT_DIRS.has(parts[1])) out.add(`${parts[0]}/${parts[1]}/**`);
  }
  return [...out].sort();
}

/** Lockfiles per ecosystem marker, for the protected-paths suggestion's lockfile rule. */
const LOCKFILES: [string, string[]][] = [
  ['package.json', ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']],
  ['Cargo.toml', ['Cargo.lock']],
  ['go.mod', ['go.sum']],
  ['pyproject.toml', ['poetry.lock', 'uv.lock']],
  ['Gemfile', ['Gemfile.lock']],
];

/** The default policy with the lockfile rule narrowed to the detected ecosystems, or dropped when none is. */
function protectedPathsFor(root: string): ProtectedRule[] {
  const locks = LOCKFILES.filter(([marker]) => has(root, marker)).flatMap(([, files]) => files);
  return defaults().policy.protectedPaths.flatMap((r) => (r.reason !== 'dependency lockfile' ? [r] : locks.length ? [{ ...r, paths: locks }] : []));
}

export function detect(root: string): Detection {
  const git = (args: string[]) => runGit(root, args, { allowFail: true });
  const remoteUrl = git(['remote', 'get-url', 'origin']).stdout.trim() || null;
  const ghSlug = remoteUrl?.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] ?? null;
  const originHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).stdout.trim().replace(/^origin\//, '') || null;
  const branches = git(['branch', '--format=%(refname:short)']).stdout.split('\n').filter(Boolean);
  const base = branches.includes('develop') ? 'develop' : originHead ?? (branches.includes('main') ? 'main' : branches.includes('master') ? 'master' : branches[0] ?? 'main');

  const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard']).stdout.split('\n').filter(Boolean);
  const notHeavy = (f: string) => !/(^|\/)(node_modules|target|dist|build|\.git|\.svelte-kit|\.next)\//.test(f);
  const instructionFiles = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'CONTRIBUTING.md'].filter((f) => has(root, f));
  const ignoredInstructions = ignored.filter((f) => notHeavy(f) && /(^|\/)(CLAUDE|AGENTS)\.md$/.test(f));
  const envFiles = ignored.filter((f) => notHeavy(f) && /(^|\/)\.env(\.[\w-]+)?$/.test(f) && !/\.example$/.test(f));

  const pkg = readJsonSafe(root, 'package.json');
  const pm = has(root, 'yarn.lock') ? 'yarn' : has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'bun.lockb') || has(root, 'bun.lock') ? 'bun' : pkg ? 'npm' : null;
  const runScript = (s: string) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
  const scripts = pkg?.scripts ?? {};
  const cargo = readText(path.join(root, 'Cargo.toml'));
  const isCargoWorkspace = /^\[workspace\]/m.test(cargo);
  const scriptsDir = ['build.sh', 'test.sh', 'format.sh', 'lint.sh'].filter((f) => has(root, `scripts/${f}`));
  const makeTargets = (readText(path.join(root, 'Makefile')).match(/^([a-zA-Z][\w-]*):/gm) ?? []).map((t) => t.slice(0, -1));

  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const cfgFile = (name: string) => ['js', 'ts', 'mjs', 'cjs'].some((e) => has(root, `${name}.config.${e}`));
  const playwrightDep = '@playwright/test' in deps || 'playwright' in deps;
  const cypressDep = 'cypress' in deps;
  const playwright = playwrightDep || cfgFile('playwright');
  const cypress = cypressDep || cfgFile('cypress');
  const pmExec = (cmd: string) => ({ npm: `npx ${cmd}`, pnpm: `pnpm exec ${cmd}`, yarn: `yarn ${cmd}`, bun: `bunx ${cmd}` })[pm ?? 'npm'];

  const commands: Record<string, string | null> = { setup: null, build: null, test: null, lint: null, format: null, typecheck: null, dev: null, e2e: null };
  if (pkg) {
    commands.setup = pm === 'yarn' ? 'yarn install --frozen-lockfile' : pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'bun' ? 'bun install' : 'npm ci';
    if (scripts.build) commands.build = runScript('build');
    if (scripts.test) commands.test = runScript('test');
    if (scripts['lint:check']) commands.lint = runScript('lint:check');
    else if (scripts.lint) commands.lint = runScript('lint');
    if (scripts.format) commands.format = runScript('format');
    if (scripts.check) commands.typecheck = runScript('check');
    else if (scripts.typecheck) commands.typecheck = runScript('typecheck');
    if (scripts.dev) commands.dev = `${runScript('dev')} --port {port}`;
    if (scripts['test:e2e']) commands.e2e = runScript('test:e2e');
    if (!commands.e2e && scripts.e2e) commands.e2e = runScript('e2e');
  }
  // Only for an installed dependency: with a config file alone, npx/bunx would fetch and run an
  // unpinned package from the registry inside verify. The config file still sets tools.*.
  if (!commands.e2e && playwrightDep) commands.e2e = pmExec('playwright test');
  else if (!commands.e2e && cypressDep) commands.e2e = pmExec('cypress run');
  if (cargo) {
    const ws = isCargoWorkspace ? ' --workspace' : '';
    commands.build ??= `cargo build${ws}`;
    commands.test ??= `cargo test${ws}`;
    commands.lint ??= `cargo clippy${ws} -- -D warnings`;
    commands.format ??= 'cargo fmt --check';
  }
  if (has(root, 'go.mod')) {
    commands.build ??= 'go build ./...';
    commands.test ??= 'go test ./...';
    commands.lint ??= 'go vet ./...';
  }
  if (has(root, 'pyproject.toml')) {
    commands.test ??= 'pytest';
    commands.lint ??= 'ruff check .';
  }
  if (has(root, 'CMakeLists.txt')) {
    commands.build ??= 'cmake -B build && cmake --build build';
    commands.test ??= 'ctest --test-dir build';
  }
  for (const s of scriptsDir) {
    const key = s.replace('.sh', '');
    if (key in commands && !commands[key]) commands[key] = `./scripts/${s}`;
  }
  for (const t of ['build', 'test', 'lint', 'format']) if (!commands[t] && makeTargets.includes(t)) commands[t] = `make ${t}`;

  const ui = UI_PACKAGES.filter((d) => d in deps);
  const kinds: string[] = [];
  if (ui.length) kinds.push('web-ui');
  if (cargo) kinds.push('rust');
  if (pkg && !ui.length) kinds.push('node');
  if (has(root, 'go.mod')) kinds.push('go');
  if (has(root, 'pyproject.toml') || has(root, 'requirements.txt')) kinds.push('python');
  if (has(root, 'CMakeLists.txt')) kinds.push('cpp');
  if (/juce/i.test(readText(path.join(root, 'CMakeLists.txt')))) kinds.push('audio-plugin');
  if (/no_std|cortex-m|embassy|stm32/i.test(cargo)) kinds.push('embedded');
  if (/\b(bbx_dsp|cpal|rodio|dasp|fundsp)\b/.test(cargo)) kinds.push('realtime-audio');

  const workspaces = npmWorkspaces(pkg);
  const cargoMembers = membersOf(cargo);
  const monorepo = workspaces.length > 1 || cargoMembers.length > 1;

  const infraFiles = ['Dockerfile', 'docker-compose.yml', 'compose.yaml', 'wrangler.toml', 'wrangler.jsonc', 'fly.toml', 'vercel.json', 'netlify.toml', 'serverless.yml', 'app.yaml', 'Pulumi.yaml'].filter((f) => has(root, f));
  // The globs behind infraFiles' display labels, for a panel lens's `paths`.
  const infraPaths = [...infraFiles];
  const tracked = git(['ls-files', '-z']).stdout.split('\0');
  if (tracked.some((f) => f.endsWith('.tf'))) {
    infraFiles.push('*.tf (terraform)');
    infraPaths.push('*.tf');
  }
  if (tracked.some((f) => /(^|\/)(k8s|kubernetes|helm|charts)\//.test(f))) {
    infraFiles.push('kubernetes manifests');
    infraPaths.push('**/k8s/**', '**/kubernetes/**', '**/helm/**', '**/charts/**');
  }
  const generated = commands.build ? generatedDirs(tracked) : [];
  const cloudClis = ['gcloud', 'aws', 'az', 'kubectl', 'terraform', 'wrangler', 'flyctl', 'vercel', 'pulumi'].filter(hasBinary);

  let project: DetectedProject | null = null;
  if (has(root, '.github/project-config.yml')) {
    try {
      const pc = yaml.parse(readText(path.join(root, '.github/project-config.yml')));
      project = { file: '.github/project-config.yml', owner: pc?.project?.owner ?? null, number: pc?.project?.number ?? null, name: pc?.project?.name ?? null, statusField: pc?.fields?.status?.name ?? null, statusOptions: pc?.fields?.status?.options ?? [] };
    } catch (e) {
      project = { file: '.github/project-config.yml', error: (e as Error).message };
    }
  }

  const docs = ['README.md', 'docs/README.md', 'DESIGN.md'].map((f) => readText(path.join(root, f))).join('\n');
  const figma = [...new Set(docs.match(/https:\/\/(?:www\.)?figma\.com\/[^\s)"'>]+/g) ?? [])].slice(0, 5);
  const repoAgents = has(root, '.claude/agents') ? fs.readdirSync(path.join(root, '.claude/agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')) : [];
  const workflows = has(root, '.github/workflows') ? fs.readdirSync(path.join(root, '.github/workflows')) : [];

  const reviewers: string[] = ['code', 'tests'];
  if (ui.length) reviewers.push('design');
  if (pkg || has(root, 'go.mod') || has(root, 'pyproject.toml') || infraFiles.length) reviewers.push('security');
  if (kinds.includes('realtime-audio') || kinds.includes('audio-plugin') || kinds.includes('embedded')) reviewers.push('performance', 'realtime');
  if (infraFiles.length) reviewers.push('infra');
  if (pkg?.main || pkg?.exports || /\[lib\]/.test(cargo) || (cargo && !/\[\[bin\]\]/.test(cargo) && has(root, 'src/lib.rs'))) reviewers.push('api');
  reviewers.push('docs');
  const manifests = ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'requirements.txt', 'uv.lock'].filter((f) => has(root, f));
  const lensPaths: Record<string, string[]> = {
    design: defaults().verifyE2e.paths,
    security: [...manifests, ...infraPaths],
    infra: infraPaths,
    docs: ['*.md', 'docs/**'],
  };
  // Only suggested lenses that aren't always-on and have something to match.
  const panelPaths = Object.fromEntries(reviewers.filter((r) => lensPaths[r]?.length).map((r) => [r, lensPaths[r]]));

  return {
    repo: { name: path.basename(root), remoteUrl, github: ghSlug, branches, suggestedBase: base, originHead },
    instructions: { tracked: instructionFiles, ignored: ignoredInstructions },
    untracked: { env: envFiles },
    stack: { kinds, packageManager: pm, ui, cargoWorkspace: isCargoWorkspace, monorepo, workspaces: [...workspaces, ...cargoMembers] },
    commands,
    infra: { files: infraFiles, clis: cloudClis },
    github: { project, workflows, ghInstalled: hasBinary('gh') },
    design: { figma },
    repoAgents,
    tools: { agentBrowser: hasBinary('agent-browser'), playwright, cypress },
    suggestions: {
      'git.base': base,
      'worktrees.copy': [...new Set([...ignoredInstructions, ...envFiles])],
      'worktrees.setup': commands.setup ? [commands.setup] : [],
      'worktrees.cargo.sharedTarget': Boolean(cargo),
      'worktrees.generated': generated,
      'tracker.kind': ghSlug ? 'github' : 'local',
      'tracker.github.statusSync': project?.number ? 'project' : 'none',
      'review.panel': reviewers,
      'review.panelPaths': panelPaths,
      'pipeline.design': ui.length ? (figma.length ? 'reference' : 'none') : 'none',
      'infra.mode': infraFiles.length ? 'plan-only' : 'human',
      'policy.protectedPaths': protectedPathsFor(root),
      components: detectComponents(root, { pm, ui: UI_PACKAGES, pkg, cargo }),
    },
  };
}
