// writeRoots, denyRules and confineDigest against scratch checkouts: a root repo `app` beside a
// member clone `lib`, under one temp parent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scratchGitConfig } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { DENY_TOOLS } from '#integrations/claude/argv.ts';
import { confineDigest, denyRules, writeRoots } from './confine.ts';
import type { Config } from '#core/types.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  scratchGitConfig((...a: string[]) => git(dir, ...a));
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

/** `<parent>/app` with `.forge/`, `<parent>/lib` with an origin, and a config naming lib (set up in local.yml unless `member: false`). */
function project(t: any, opts: { member?: boolean } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-confine-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'app');
  const lib = path.join(parent, 'lib');
  initRepo(root);
  initRepo(lib);
  git(lib, 'remote', 'add', 'origin', 'https://github.com/o/lib');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  if (opts.member !== false) fs.writeFileSync(path.join(root, '.forge', 'local.yml'), 'repos:\n  lib:\n    path: ../lib\n');
  const config: Config = defaults();
  config.repos = [{ name: 'lib', remote: 'https://github.com/o/lib', defaultBranch: 'main' }];
  return { parent, root, lib, config };
}

test('writeRoots lists the job folders and every worktrees root', (t) => {
  type P = ReturnType<typeof project>;
  const rows: { name: string; member?: boolean; edit?: (p: P) => { root?: string } | void; want?: (p: P) => { jobs: string; worktrees: string[] }; throws?: RegExp }[] = [
    { name: 'the root and a member that is set up', want: (p) => ({ jobs: path.join(p.root, '.forge', 'jobs'), worktrees: [path.join(p.parent, 'app.worktrees'), path.join(p.parent, 'lib.worktrees')] }) },
    { name: 'a member not set up is left out', member: false, want: (p) => ({ jobs: path.join(p.root, '.forge', 'jobs'), worktrees: [path.join(p.parent, 'app.worktrees')] }) },
    {
      name: 'a shared worktrees root is listed once',
      edit: (p) => void (p.config.worktrees.root = '../shared'),
      want: (p) => ({ jobs: path.join(p.root, '.forge', 'jobs'), worktrees: [path.join(p.parent, 'shared')] }),
    },
    {
      name: 'a root reached through a symlink gives realpaths',
      edit: (p) => {
        const link = path.join(p.parent, 'link');
        fs.symlinkSync(p.root, link, 'dir');
        p.config.repos = [];
        return { root: link };
      },
      want: (p) => ({ jobs: path.join(p.root, '.forge', 'jobs'), worktrees: [path.join(p.parent, 'link.worktrees')] }),
    },
    { name: 'a worktrees root that contains the checkout', edit: (p) => void (p.config.worktrees.root = '..'), throws: /contains it/ },
    { name: 'a worktrees root that is the checkout', edit: (p) => void (p.config.worktrees.root = '.'), throws: /contains it/ },
    { name: 'a worktrees root a rule cannot carry', edit: (p) => void (p.config.worktrees.root = '../wt(1)'), throws: /can't be a permission rule/ },
  ];
  for (const row of rows) {
    const p = project(t, { member: row.member });
    let root = p.root;
    try {
      root = (row.edit?.(p) as { root?: string } | undefined)?.root ?? p.root;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') {
        t.diagnostic(`${row.name}: skipped, no symlinks here`);
        continue;
      }
      throw e;
    }
    if (row.throws) assert.throws(() => writeRoots(root, p.config), row.throws, row.name);
    else assert.deepEqual(writeRoots(root, p.config), row.want!(p), row.name);
  }
});

test('denyRules covers the protected paths, the instruction files and an in-checkout hooks path', (t) => {
  type P = ReturnType<typeof project>;
  const rows: { name: string; edit?: (p: P) => void; has: (p: P) => string[]; lacks?: (p: P) => string[]; throws?: RegExp }[] = [
    {
      name: 'the defaults',
      has: (p) => [
        ...DENY_TOOLS.map((d) => `Edit(/${p.root}/${d.slice(5, -1)})`),
        `Edit(/${p.root}/CLAUDE.md)`,
        `Edit(/${p.root}/CLAUDE.local.md)`,
        `Edit(/${p.root}/AGENTS.md)`,
        'Edit(**/CLAUDE.md)',
        'Edit(**/CLAUDE.local.md)',
        `Edit(/${p.root}/**/CLAUDE.md)`,
        `Edit(/${p.root}/**/CLAUDE.local.md)`,
      ],
      lacks: () => ['Edit(CLAUDE.md)', 'Edit(AGENTS.md)', 'Edit(.githooks/**)'],
    },
    {
      name: 'a configured instruction file',
      edit: (p) => void (p.config.project.instructions = { default: ['AGENTS.md'], reviewer: ['docs/RULES.md'] }),
      has: (p) => [`Edit(/${p.root}/docs/RULES.md)`],
    },
    {
      name: 'a worktrees root inside the checkout keeps nested CLAUDE.md writable there',
      edit: (p) => void (p.config.worktrees.root = '.worktrees'),
      has: (p) => [`Edit(/${p.root}/CLAUDE.md)`],
      lacks: (p) => ['Edit(**/CLAUDE.md)', `Edit(/${p.root}/**/CLAUDE.md)`],
    },
    {
      name: 'core.hooksPath inside the checkout',
      edit: (p) => void git(p.root, 'config', 'core.hooksPath', '.githooks'),
      has: (p) => ['Edit(.githooks/**)', `Edit(/${p.root}/.githooks/**)`],
    },
    {
      name: 'core.hooksPath outside the checkout',
      edit: (p) => void git(p.root, 'config', 'core.hooksPath', path.join(p.parent, 'hooks')),
      has: () => [],
      lacks: (p) => [`Edit(/${path.join(p.parent, 'hooks')}/**)`, 'Edit(../hooks/**)'],
    },
    {
      name: 'an instruction file a rule cannot carry',
      edit: (p) => void (p.config.project.instructions = ['docs/a(1).md']),
      has: () => [],
      throws: /can't be a permission rule/,
    },
  ];
  for (const row of rows) {
    const p = project(t);
    row.edit?.(p);
    if (row.throws) {
      assert.throws(() => denyRules(p.root, p.config), row.throws, row.name);
      continue;
    }
    const deny = denyRules(p.root, p.config);
    for (const r of row.has(p)) assert.ok(deny.includes(r), `${row.name}: has ${r}`);
    for (const r of row.lacks?.(p) ?? []) assert.ok(!deny.includes(r), `${row.name}: lacks ${r}`);
  }
});

test('confineDigest sees content changes under the protected pathspecs', (t) => {
  const put = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  type P = ReturnType<typeof project>;
  const rows: { name: string; before?: (p: P) => void; change: (p: P) => void; changes: boolean }[] = [
    { name: 'a committed learnings file edited', change: (p) => put(p.root, '.forge/notes/learnings.md', 'two\n'), changes: true },
    { name: 'a committed learnings file deleted', change: (p) => fs.rmSync(path.join(p.root, '.forge/notes/learnings.md')), changes: true },
    { name: 'a new untracked lib/CLAUDE.md', change: (p) => put(p.root, 'lib/CLAUDE.md', 'x\n'), changes: true },
    { name: 'a nested CLAUDE.local.md', change: (p) => put(p.root, 'a/b/CLAUDE.local.md', 'x\n'), changes: true },
    { name: 'a dirty notes file edited again', before: (p) => put(p.root, '.forge/notes/draft.md', 'one\n'), change: (p) => put(p.root, '.forge/notes/draft.md', 'two\n'), changes: true },
    { name: 'a reviewer checklist created', change: (p) => put(p.root, '.forge/reviewers/code.md', 'x\n'), changes: true },
    { name: 'a configured instruction file', before: (p) => void (p.config.project.instructions = ['docs/RULES.md']), change: (p) => put(p.root, 'docs/RULES.md', 'x\n'), changes: true },
    {
      name: 'a new file in an in-checkout hooks dir',
      before: (p) => void git(p.root, 'config', 'core.hooksPath', '.githooks'),
      change: (p) => put(p.root, '.githooks/post-checkout', '#!/bin/sh\n'),
      changes: true,
    },
    { name: 'source code', change: (p) => put(p.root, 'src/app.ts', 'x\n'), changes: false },
    { name: 'an eval run record', change: (p) => put(p.root, '.forge/evals/runs/r.json', '{}\n'), changes: false },
    { name: 'a recall run record', change: (p) => put(p.root, '.forge/evals/recall/runs/x.json', '{}\n'), changes: false },
    { name: 'a job folder file', change: (p) => put(p.root, '.forge/jobs/j1/build.md', 'x\n'), changes: false },
  ];
  for (const row of rows) {
    const p = project(t, { member: false });
    put(p.root, '.forge/notes/learnings.md', 'one\n');
    git(p.root, 'add', '-A');
    git(p.root, 'commit', '-qm', 'forge');
    row.before?.(p);
    const before = confineDigest(p.root, p.config);
    assert.equal(confineDigest(p.root, p.config), before, `${row.name}: stable`);
    row.change(p);
    assert.equal(confineDigest(p.root, p.config) !== before, row.changes, row.name);
  }
});
