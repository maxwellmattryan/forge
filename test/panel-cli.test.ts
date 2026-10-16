// `forge job panel` end to end: the lenses come from the committed diff as git stores it, and a
// lens the rules select can't be hidden by anything the builder controls (its commits, the
// worktree's git config, replace objects, or job.reviewers).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { evalTaskYml, forgeAsync, repoTemplate, scratchGitConfig } from './helpers.ts';
import { jobDir, loadJob, readEvents } from '../lib/jobs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

const PANEL = [
  { name: 'code', always: true },
  { name: 'security', when: 'anything that ingests tracker text', paths: ['lib/trackers/**', 'package.json'] },
  { name: 'docs', paths: ['docs/**', '*.md'] },
  { name: 'design', paths: ['*.svelte'] },
];

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, review: { panel: PANEL } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge init'], { cwd: dir, stdio: 'pipe' });
});

const write = (dir: string, rel: string, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const commitAll = (cwd: string, msg: string) => {
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, 'commit', '-qm', msg);
};

const SPEC = '# Spec\n\nSize: S\nSuggested reviewers: -\n\n## Approach\n- `src/a.ts`\n';

/** A scratch repo with one job, its worktree and spec.md; `base` files are committed to main first. */
async function setup(o: { spec?: string; base?: Record<string, string> } = {}) {
  const repo = template();
  const raw = (...args: string[]) => forgeAsync(repo.dir, args);
  const f = async (...args: string[]) => {
    const r = await raw(...args);
    assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  for (const [rel, text] of Object.entries(o.base ?? {})) write(repo.dir, rel, text);
  if (o.base) commitAll(repo.dir, 'base files');
  const { id } = await f('job', 'new', '--title', 'Panel check');
  const wt: string = (await f('worktree', 'create', id)).path;
  await f('job', 'round', id);
  fs.writeFileSync(path.join(jobDir(repo.dir, id), 'spec.md'), o.spec ?? SPEC);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  };
  return { root: repo.dir, id, wt, f, raw, cleanup };
}

const events = (root: string, id: string, type: string) => readEvents(root, id).filter((e) => e.type === type);

/**
 * evalScratch's repo (Forge initialised, eval task `t` committed), built in place rather than
 * copied from a shared template: every commit starts a detached `git maintenance run --auto`, which
 * can add and remove files under .git/objects while a copy walks it (ENOENT on a CI runner). Auto
 * maintenance is off before the first commit, so nothing writes to the repo behind the test.
 */
function evalRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'maintenance.auto', 'false');
  scratchGitConfig(git);
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { build: 'true', test: 'true', lint: 'true' }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  write(dir, '.forge/evals/t/check/files/t.txt', 't\n');
  write(dir, '.forge/evals/t/task.yml', evalTaskYml('t'));
  commitAll(dir, 'forge and eval task');
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.wt`, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

describe('forge job panel', { concurrency: 4 }, () => {
  test('forge job panel adds a lens whose paths the diff touches and leaves it out otherwise', async () => {
    const s = await setup();
    try {
      write(s.wt, 'src/a.ts');
      commitAll(s.wt, 'in spec');
      let r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.lenses, ['code']);
      assert.deepEqual(r.reasons, { code: ['always'] });
      assert.equal(r.changed, 1);

      write(s.wt, 'lib/trackers/github.ts');
      write(s.wt, 'lib/trackers/local.ts');
      commitAll(s.wt, 'wanders into trackers');
      r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.lenses, ['code', 'security']);
      assert.deepEqual(r.reasons.code, ['always', 'carried']);
      assert.deepEqual(r.reasons.security, ['paths lib/trackers/**: lib/trackers/github.ts (+1 more)']);
      assert.deepEqual(loadJob(s.root, s.id).reviewers, ['code', 'security']);

      // The usage line and help list the command.
      const usage = await s.raw('job');
      assert.match(usage.stderr, /\|panel\|/);
      assert.match((await s.raw('help', 'job')).stdout, /forge job panel <id>/);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel records reviewers, a panel event and added', async () => {
    const s = await setup({ spec: SPEC.replace('Suggested reviewers: -', 'Suggested reviewers: docs, nope') });
    try {
      await s.f('job', 'set', s.id, '--field', 'reviewers=["code","extra"]');
      write(s.wt, 'ui/Card.svelte');
      commitAll(s.wt, 'a component');
      const fieldsBefore = events(s.root, s.id, 'fields').length;
      const r = await s.f('job', 'panel', s.id);
      assert.deepEqual(Object.keys(r), ['id', 'round', 'base', 'mergeBase', 'head', 'dirty', 'changed', 'lenses', 'reasons', 'added']);
      assert.equal(r.id, s.id);
      assert.equal(r.round, 1);
      assert.equal(r.base, 'main');
      assert.match(r.mergeBase, /^[0-9a-f]{40}$/);
      assert.equal(r.head, gitIn(s.wt, 'rev-parse', 'HEAD'));
      assert.equal(r.dirty, false);
      assert.deepEqual(r.lenses, ['code', 'docs', 'design', 'extra']);
      assert.deepEqual(r.reasons, { code: ['always', 'carried'], docs: ['suggested'], design: ['paths *.svelte: ui/Card.svelte'], extra: ['carried'] });
      assert.deepEqual(r.added, ['docs', 'design']);
      assert.deepEqual(loadJob(s.root, s.id).reviewers, r.lenses);
      assert.equal(events(s.root, s.id, 'fields').length, fieldsBefore + 1);
      const ev = events(s.root, s.id, 'panel');
      assert.equal(ev.length, 1);
      assert.deepEqual(
        { round: ev[0].round, head: ev[0].head, mergeBase: ev[0].mergeBase, lenses: ev[0].lenses, reasons: ev[0].reasons, added: ev[0].added },
        { round: r.round, head: r.head, mergeBase: r.mergeBase, lenses: r.lenses, reasons: r.reasons, added: r.added },
      );

      // Unchanged: one more panel event, no fields event.
      const again = await s.f('job', 'panel', s.id);
      assert.deepEqual(again.lenses, r.lenses);
      assert.deepEqual(again.added, []);
      assert.equal(events(s.root, s.id, 'fields').length, fieldsBefore + 1);
      assert.equal(events(s.root, s.id, 'panel').length, 2);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel reads the committed diff as git stores it', async () => {
    const s = await setup({ base: { 'lib/trackers/old.ts': 'export const tracker = 1;\n'.repeat(20) } });
    try {
      // An uncommitted change alone adds nothing, and is reported.
      write(s.wt, 'lib/trackers/dirty.ts');
      let r = await s.f('job', 'panel', s.id);
      assert.equal(r.dirty, true);
      assert.equal(r.changed, 0);
      assert.deepEqual(r.lenses, ['code']);
      fs.rmSync(path.join(s.wt, 'lib/trackers/dirty.ts'));

      // A rename keeps the old path, which is the one the glob matches.
      gitIn(s.wt, 'config', 'diff.renames', 'true');
      fs.mkdirSync(path.join(s.wt, 'src'), { recursive: true });
      gitIn(s.wt, 'mv', 'lib/trackers/old.ts', 'src/moved.ts');
      commitAll(s.wt, 'move out of trackers');
      r = await s.f('job', 'panel', s.id);
      assert.equal(r.dirty, false);
      assert.deepEqual(r.reasons.security, ['paths lib/trackers/**: lib/trackers/old.ts']);

      // A non-ASCII path stays raw under core.quotePath=true.
      gitIn(s.wt, 'config', 'core.quotePath', 'true');
      write(s.wt, 'docs/naïve-über.txt');
      commitAll(s.wt, 'non-ascii doc');
      r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.reasons.docs, ['paths docs/**: docs/naïve-über.txt']);

      // diff.relative in the repo config doesn't narrow the diff.
      gitIn(s.wt, 'config', 'diff.relative', 'true');
      write(s.wt, 'web/deep/Card.svelte');
      commitAll(s.wt, 'component');
      r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.reasons.design, ['paths *.svelte: web/deep/Card.svelte']);
      assert.deepEqual(r.lenses, ['code', 'security', 'docs', 'design']);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel ignores replace objects', async () => {
    const s = await setup();
    try {
      write(s.wt, 'lib/trackers/evil.ts');
      commitAll(s.wt, 'tracker change');
      const parent = gitIn(s.wt, 'rev-parse', 'HEAD~1');
      // A commit with the parent's tree, put in place of HEAD: plain git now sees no change.
      const fake = gitIn(s.wt, 'commit-tree', `${parent}^{tree}`, '-p', parent, '-m', 'nothing to see');
      gitIn(s.wt, 'replace', 'HEAD', fake);
      assert.equal(gitIn(s.wt, 'diff', '--name-only', parent, 'HEAD'), '', 'the replace hides the change from plain git');
      const r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.lenses, ['code', 'security']);
      assert.deepEqual(r.reasons.security, ['paths lib/trackers/**: lib/trackers/evil.ts']);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel never drops a computed lens', async () => {
    const s = await setup({ spec: SPEC.replace('Suggested reviewers: -', 'Suggested reviewers: docs') });
    try {
      write(s.wt, 'lib/trackers/a.ts');
      commitAll(s.wt, 'tracker change');
      await s.f('job', 'set', s.id, '--field', 'reviewers=[]');
      const r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.lenses, ['code', 'security', 'docs']);
      assert.deepEqual(loadJob(s.root, s.id).reviewers, ['code', 'security', 'docs']);
      // A retro job's panel is fixed at code and docs, so turning this job into one would drop security.
      for (const kind of ['retro', 'eval']) {
        const refused = await s.raw('job', 'set', s.id, '--field', `kind=${kind}`);
        assert.equal(refused.status, 1, refused.stdout);
        assert.match(refused.stderr, new RegExp(`--field kind=${kind} is not settable; use `));
      }
      assert.equal(loadJob(s.root, s.id).kind, 'feature');
      const again = await s.f('job', 'panel', s.id);
      assert.deepEqual(again.lenses, ['code', 'security', 'docs']);
      assert.deepEqual(loadJob(s.root, s.id).reviewers, ['code', 'security', 'docs']);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel fails on a missing job, worktree or spec', async () => {
    const s = await setup();
    try {
      let r = await s.raw('job', 'panel', 'no-such-job');
      assert.equal(r.status, 1, r.stderr);
      const { id } = await s.f('job', 'new', '--title', 'No worktree');
      r = await s.raw('job', 'panel', id);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`job ${id} has no worktree yet`));
      fs.rmSync(path.join(jobDir(s.root, s.id), 'spec.md'));
      r = await s.raw('job', 'panel', s.id);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`job ${s.id} has no spec.md`));
      assert.equal(events(s.root, s.id, 'panel').length, 0);
    } finally {
      s.cleanup();
    }
  });

  test("forge job panel applies an eval job's overlay", async () => {
    const s = evalRepo();
    try {
      const overlay = 'review.panel=[{name: code, always: true}, {name: security, paths: ["t.txt"]}, {name: docs, paths: ["*.md"]}]';
      const started = await forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', '--set', overlay]);
      assert.equal(started.status, 0, started.stderr);
      const id = JSON.parse(started.stdout).tasks[0].job;
      const created = await forgeAsync(s.dir, ['worktree', 'create', id]);
      assert.equal(created.status, 0, created.stderr);
      const wt = loadJob(s.dir, id).worktree!;
      fs.writeFileSync(path.join(jobDir(s.dir, id), 'spec.md'), SPEC);
      write(wt, 't.txt');
      commitAll(wt, 'task work');
      const r = await forgeAsync(s.dir, ['job', 'panel', id]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      // The base config's panel (code and tests, always) is not the one used.
      assert.deepEqual(out.lenses, ['code', 'security']);
      assert.deepEqual(out.reasons.security, ['paths t.txt: t.txt']);
    } finally {
      s.cleanup();
    }
  });
});
