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

// Per slug `o/<name>`: <name>.pr holds the PR's head branch once created; <name>.state, .url, .num,
// .head, .checks (passing|pending|failing) and .mergestate override what gh reports; <name>.cross
// makes it a fork PR; .headref and .baseref override the branches gh reports; .racebody replaces the
// body right after a `pr view --json body…` prints it (a human edit between two reads); <name>.fail makes `pr create` fail, .viewfail `pr view`, .editfail `pr edit` and
// .mergefail `pr merge`. <name>.body is the PR body: `pr create` and `pr edit` write it from
// --body-file and `pr view --json body` prints it. `pr merge` without --auto makes the PR MERGED.
// Issues: `issue list` prints <name>.issues (default []), and <name>.issuefail makes it fail;
// `issue view N` prints <name>.issue-N, else an open issue N carrying the labels in <name>.labels-N;
// `issue edit N --add-label L` writes L to <name>.labels-N; `issue comment N` writes its body to
// <name>.comment-N, and <name>.commentfail makes it fail. `api user` is forge-bot.
const FAKE_GH = `#!/bin/sh
d="$FAKE_GH_DIR"
echo "$*" >> "$d/calls.log"
slug=""; head=""; open=""; prev=""; bodyfile=""; json=""; auto=""
for a in "$@"; do
  [ "$prev" = "-R" ] && slug="$a"
  [ "$prev" = "--head" ] && head="$a"
  [ "$prev" = "--state" ] && [ "$a" = "open" ] && open=1
  [ "$prev" = "--body-file" ] && bodyfile="$a"
  [ "$prev" = "--json" ] && json="$a"
  [ "$a" = "--auto" ] && auto=1
  prev="$a"
done
name="\${slug#*/}"
num() { if [ -f "$d/$name.num" ]; then cat "$d/$name.num"; elif [ "$name" = lib ]; then echo 7; else echo 11; fi; }
url() { if [ -f "$d/$name.url" ]; then cat "$d/$name.url"; else echo "https://github.com/$slug/pull/$(num)"; fi; }
state() { if [ -f "$d/$name.state" ]; then cat "$d/$name.state"; else echo OPEN; fi; }
cross() { if [ -f "$d/$name.cross" ]; then echo true; else echo false; fi; }
merged() { if [ "$(state)" = MERGED ]; then echo '"2026-10-02T00:00:00Z"'; else echo null; fi; }
branch() { if [ -f "$d/$name.headref" ]; then cat "$d/$name.headref"; else cat "$d/$name.pr" 2>/dev/null; fi; }
baseref() { if [ -f "$d/$name.baseref" ]; then cat "$d/$name.baseref"; else echo main; fi; }
headoid() { if [ -f "$d/$name.head" ]; then cat "$d/$name.head"; else echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi; }
mstate() { if [ -f "$d/$name.mergestate" ]; then cat "$d/$name.mergestate"; else echo CLEAN; fi; }
rollup() {
  case "$(cat "$d/$name.checks" 2>/dev/null)" in
    passing) echo '[{"conclusion":"SUCCESS"}]' ;;
    pending) echo '[{"status":"IN_PROGRESS"}]' ;;
    failing) echo '[{"conclusion":"FAILURE"}]' ;;
    *) echo '[]' ;;
  esac
}
case "$1 $2" in
  "pr create")
    if [ -f "$d/$name.fail" ]; then echo "create failed for $slug" >&2; exit 1; fi
    echo "$head" > "$d/$name.pr"
    if [ -n "$bodyfile" ]; then cp "$bodyfile" "$d/$name.body"; fi
    url ;;
  "pr edit")
    if [ -f "$d/$name.editfail" ]; then echo "edit failed for $slug" >&2; exit 1; fi
    if [ -n "$bodyfile" ]; then cp "$bodyfile" "$d/$name.body"; fi ;;
  "pr list")
    if { [ -f "$d/$name.pr" ] || [ -f "$d/$name.cross" ]; } && { [ -z "$open" ] || [ "$(state)" = OPEN ]; }; then
      printf '[{"number":%s,"url":"%s","state":"%s","isDraft":false,"isCrossRepository":%s,"headRefName":"%s","baseRefName":"main"}]' "$(num)" "$(url)" "$(state)" "$(cross)" "$head"
    else echo '[]'; fi ;;
  "pr view")
    if [ -f "$d/$name.viewfail" ]; then echo "view failed for $slug" >&2; exit 1; fi
    if [ "\${json%%,*}" = body ]; then
      node -e 'const fs = require("fs"); let b = ""; try { b = fs.readFileSync(process.argv[1], "utf8"); } catch {} process.stdout.write(JSON.stringify({ body: b, headRefName: process.argv[2], baseRefName: process.argv[3] }));' "$d/$name.body" "$(branch)" "$(baseref)"
      if [ -f "$d/$name.racebody" ]; then mv "$d/$name.racebody" "$d/$name.body"; fi
      exit 0
    fi
    printf '{"number":%s,"url":"%s","state":"%s","isDraft":false,"isCrossRepository":%s,"headRefOid":"%s","mergeable":"MERGEABLE","mergeStateStatus":"%s","reviewDecision":"","statusCheckRollup":%s,"mergedAt":%s,"closedAt":null,"headRefName":"%s","baseRefName":"%s","title":"t","author":{"login":"x"}}' "$(num)" "$(url)" "$(state)" "$(cross)" "$(headoid)" "$(mstate)" "$(rollup)" "$(merged)" "$(branch)" "$(baseref)" ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{},"issue":null}}}' ;;
  "api user") echo forge-bot ;;
  "repo view") echo o/app ;;
  "label create") ;;
  "issue list")
    if [ -f "$d/$name.issuefail" ]; then echo "issue list failed for $slug" >&2; exit 1; fi
    if [ -f "$d/$name.issues" ]; then cat "$d/$name.issues"; else echo '[]'; fi ;;
  "issue view")
    if [ -f "$d/$name.issue-$3" ]; then cat "$d/$name.issue-$3"; exit 0; fi
    labels='[]'
    if [ -f "$d/$name.labels-$3" ]; then labels="$(cat "$d/$name.labels-$3")"; fi
    printf '{"number":%s,"title":"Issue %s","body":"b","url":"https://github.com/%s/issues/%s","labels":%s,"assignees":[],"comments":[],"state":"OPEN","author":{"login":"x"}}' "$3" "$3" "$slug" "$3" "$labels" ;;
  "issue edit")
    label=""; p2=""
    for a in "$@"; do [ "$p2" = "--add-label" ] && label="$a"; p2="$a"; done
    if [ -n "$label" ]; then printf '[{"name":"%s"}]' "$label" > "$d/$name.labels-$3"; fi ;;
  "issue comment")
    if [ -f "$d/$name.commentfail" ]; then echo "comment failed for $slug" >&2; exit 1; fi
    cat > "$d/$name.comment-$3" ;;
  "pr merge")
    if [ -f "$d/$name.mergefail" ]; then echo "merge failed for $slug" >&2; exit 1; fi
    if [ -z "$auto" ]; then echo MERGED > "$d/$name.state"; fi ;;
esac
`;

export interface PrProject extends TwoRepo {
  env: NodeJS.ProcessEnv;
  /** The fake gh's state directory. */
  gh: string;
  calls: () => string[];
  pr: (args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  heads: (bare: string) => string;
  /** Writes `<name>.<what>` in the fake gh's directory; null removes it. */
  fake: (file: string, text: string | null) => void;
  /** The PR body the fake gh holds for `o/<name>`. */
  body: (name: string) => string;
}

/** The two-repo project with the fake gh first on PATH; its cleanup goes into `cleanups`. */
export async function prProject(cleanups: (() => void)[]): Promise<PrProject> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  const gh = path.join(p.parent, 'gh');
  fs.mkdirSync(path.join(gh, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(gh, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(gh, 'calls.log'), '');
  const env = { PATH: `${path.join(gh, 'bin')}${path.delimiter}${process.env.PATH}`, FAKE_GH_DIR: gh };
  return {
    ...p,
    env,
    gh,
    calls: () => fs.readFileSync(path.join(gh, 'calls.log'), 'utf8').split('\n').filter(Boolean),
    pr: (args) => p.raw(['pr', ...args], env),
    heads: (bare) => p.git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').trim(),
    fake: (file, text) => (text === null ? fs.rmSync(path.join(gh, file), { force: true }) : fs.writeFileSync(path.join(gh, file), text)),
    body: (name) => fs.readFileSync(path.join(gh, `${name}.body`), 'utf8'),
  };
}

/** A job with member lib, both repos committed and verified. */
export async function ready(p: PrProject, opts: { verifyOnly?: boolean; libCommit?: boolean; libFiles?: Record<string, string> } = {}) {
  const j = await p.f('job', 'new', '--title', `Two repo change ${Math.random().toString(36).slice(2, 8)}`);
  await p.f('job', 'repo', 'add', ...(opts.verifyOnly ? ['--verify-only'] : []), j.id, 'lib');
  await p.f('worktree', 'create', j.id);
  const rootWt = path.join(p.parent, 'app.worktrees', j.id);
  const libWt = path.join(p.parent, 'lib.worktrees', j.id);
  p.commit(rootWt, { 'app.txt': 'app\n' }, 'feat: app');
  if (!opts.verifyOnly && opts.libCommit !== false) p.commit(libWt, opts.libFiles ?? { 'lib.txt': 'lib\n' }, 'feat: lib');
  await p.f('job', 'round', j.id);
  return { id: j.id as string, rootWt, libWt, branch: `forge/${j.id}` };
}

/** Adds an `app` component in the root that depends on lib's component (`type`), or the reverse. */
export function dependsOn(p: TwoRepo, edge: 'app-on-lib' | 'lib-on-app' | 'cycle', type: 'build' | 'runtime' = 'build'): void {
  p.config((c) => {
    const lib = c.components.find((x: any) => x.name === 'lib');
    const app = { name: 'app', repo: null, path: '.', kind: 'service', dependsOn: [] as any[] };
    if (edge !== 'lib-on-app') app.dependsOn.push({ component: 'lib', type });
    if (edge !== 'app-on-lib') lib.dependsOn = [{ component: 'app', type }];
    c.components = [...c.components.filter((x: any) => x.name !== 'app'), app];
  });
}
