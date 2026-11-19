// Stacking (`stackSource`) against a scratch repo: a job stacks only on a dependency that lands on
// its own base, through a chain of stacked dependencies too, and `forge worktree create` refuses a
// cross-base stack before it creates or writes anything. No remote: refs fall back to local ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, cliEnv, forgeInProcess, repoTemplate } from '../../../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { createJob, loadJob, setJob, updateJob } from '#core/job/store.ts';
import type { Job } from '#core/types.ts';
import { stackSource } from './deps.ts';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: cliEnv(dir), stdio: 'pipe' });
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

/** A template copy with the local branch `feature/x` one commit past main, removed with its worktrees after the test. */
function scratch(t: { after: (fn: () => void) => void }) {
  const repo = template();
  t.after(() => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  });
  const branchOff = (name: string, from: string) => {
    repo.git('checkout', '-q', '-b', name, from);
    repo.git('commit', '-q', '--allow-empty', '-m', `work on ${name}`);
    repo.git('checkout', '-q', 'main');
  };
  branchOff('feature/x', 'main');
  const root = repo.dir;
  const config = loadConfig(root).config;
  /** A job on `base`, with its own branch one commit past the base, so it is unmerged. */
  const dependency = (title: string, base: string): Job => {
    const job = createJob(root, config, { title, base });
    branchOff(job.branch!, base);
    return job;
  };
  const dependent = (title: string, base: string, dep: Job): Job => {
    const job = createJob(root, config, { title, base });
    return setJob(root, job.id, { fields: { dependsOn: [dep.id] } });
  };
  return { root, config, dependency, dependent, branchOff };
}

test('stackSource stacks only on a dependency that lands on the job\'s base', (t) => {
  const { root, config, dependency, dependent } = scratch(t);
  const onMain = dependency('main dependency', 'main');
  const onFeature = dependency('feature dependency', 'feature/x');
  // D stacked on C: D's base is C's branch, so D lands where C does.
  const c = dependency('chain bottom', 'feature/x');
  const d = dependency('chain top', c.branch!);
  const stackedTop = setJob(root, d.id, { fields: { dependsOn: [c.id] } });
  const nullBase = dependency('null base dependency', 'main');
  updateJob(root, nullBase.id, (j) => {
    j.base = null;
  });

  const rows: { name: string; base: string; dep: Job; lands?: string }[] = [
    { name: 'feature job, main dependency', base: 'feature/x', dep: onMain, lands: 'main' },
    { name: 'main job, feature dependency', base: 'main', dep: onFeature, lands: 'feature/x' },
    { name: 'same base', base: 'feature/x', dep: onFeature },
    { name: 'chain, same landing', base: 'feature/x', dep: stackedTop },
    { name: 'chain, other landing', base: 'main', dep: stackedTop, lands: 'feature/x' },
    { name: 'null base', base: 'feature/x', dep: nullBase, lands: 'main' },
  ];
  for (const row of rows) {
    const job = dependent(row.name, row.base, row.dep);
    if (row.lands) {
      assert.throws(
        () => stackSource(root, config, job),
        (e: Error) => {
          assert.match(e.message, new RegExp(`lands on ${row.lands}`), row.name);
          assert.ok([job.id, row.base, row.dep.id].every((s) => e.message.includes(s)), `${row.name}: ${e.message}`);
          return true;
        },
        row.name,
      );
    } else {
      assert.deepEqual(stackSource(root, config, job), { dependency: row.dep.id, start: row.dep.branch, base: row.dep.branch }, row.name);
    }
  }
  // A dependency with no base at all counts as git.base, so a main job still stacks on it.
  const mainJob = dependent('null base, main job', 'main', nullBase);
  assert.deepEqual(stackSource(root, config, mainJob), { dependency: nullBase.id, start: nullBase.branch, base: nullBase.branch });
});

// `forge job new --branch` takes any safe name, and a daemon session may pass it, so a dependency's
// branch is not proof that the job stacked on it or that a person chose it as a base.
test('stackSource stacks only on a dependency whose branch Forge named', (t) => {
  const { root, config, dependency, dependent, branchOff } = scratch(t);
  // A decoy made with `--branch feature/x`: its base is git.base, but its branch is the feature branch.
  const decoy = createJob(root, config, { title: 'decoy', branch: 'feature/x' });
  branchOff('custom/work', 'main');
  const custom = createJob(root, config, { title: 'custom branch', branch: 'custom/work' });
  // A real feature dependency whose dependsOn lists the decoy, to look stacked on it.
  const top = dependency('feature dependency with a decoy', 'feature/x');
  setJob(root, top.id, { fields: { dependsOn: [decoy.id] } });

  const rows: { name: string; dep: Job; message: RegExp }[] = [
    { name: 'decoy whose branch is the feature branch', dep: decoy, message: /branch feature\/x is not the one Forge named for it/ },
    { name: 'free-form branch on the same base', dep: custom, message: /branch custom\/work is not the one Forge named for it/ },
    { name: 'decoy in the chain', dep: top, message: /lands on feature\/x/ },
  ];
  for (const row of rows) {
    const job = dependent(row.name, 'main', row.dep);
    assert.throws(
      () => stackSource(root, config, job),
      (e: Error) => {
        assert.match(e.message, row.message, row.name);
        assert.ok([job.id, row.dep.id].every((s) => e.message.includes(s)), `${row.name}: ${e.message}`);
        return true;
      },
      row.name,
    );
  }
  // A job on the feature branch still stacks on the real dependency: the decoy in its dependsOn is not followed.
  const onFeature = dependent('feature job, real dependency', 'feature/x', top);
  assert.deepEqual(stackSource(root, config, onFeature), { dependency: top.id, start: top.branch, base: top.branch });
});

test('worktree create refuses a cross-base stack before creating anything', async (t) => {
  const { root, dependency, dependent } = scratch(t);
  const job = dependent('main job', 'main', dependency('feature dependency', 'feature/x'));
  const before = loadJob(root, job.id);

  const r = await forgeInProcess(root, ['worktree', 'create', job.id]);
  assert.equal(r.status, 1, JSON.stringify(r.data));
  assert.match(r.error!.message, /lands on feature\/x/);
  assert.equal(fs.existsSync(path.join(`${root}.wt`, job.id)), false);
  const after = loadJob(root, job.id);
  assert.deepEqual([after.base, after.worktree], [before.base, before.worktree]);
  assert.deepEqual([after.base, after.worktree], ['main', null]);
});
