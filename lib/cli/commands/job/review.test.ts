// forge job decision: the approver's decision bound to the HEADs it covers, recorded once per approver run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { jobDir, readEvents, updateJob } from '#core/job/store.ts';
import type { Config, Job, JobAgent } from '#core/types.ts';
import { memberWorktreePath } from '#engine/project/job-repos.ts';
import { decision } from './review.ts';

const REMOTE = 'https://example.com/lib.git';

/** A root repo with a member clone `lib` beside it (local.yml points at it) and a job whose lib worktree is Forge's computed one. */
function linkedJob() {
  const app = tempRepo();
  const lib = tempRepo();
  lib.git('remote', 'add', 'origin', REMOTE);
  const config = defaults();
  config.repos = [{ name: 'lib', remote: REMOTE, defaultBranch: 'main' }] as Config['repos'];
  const id = jobAt(app.dir, 'decide', { config }).id;
  fs.writeFileSync(path.join(app.dir, '.forge', 'local.yml'), `repos:\n  lib:\n    path: ${path.relative(app.dir, lib.dir)}\n`);
  const libWt = memberWorktreePath(app.dir, config, 'lib', id);
  lib.git('worktree', 'add', '-q', '-b', `forge/${id}`, libWt);
  updateJob(app.dir, id, (j) => {
    j.worktree = app.dir;
    j.repos = [...j.repos.slice(0, 1), { repo: 'lib', worktree: libWt, branch: `forge/${id}`, base: 'main', pr: null, verifyOnly: false, interim: null }] as Job['repos'];
  });
  const commit = (cwd: string, file: string) => {
    fs.writeFileSync(path.join(cwd, file), `${file}\n`);
    for (const args of [['add', '-A'], ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', file]]) app.git('-C', cwd, ...args);
    return app.git('-C', cwd, 'rev-parse', 'HEAD').toString().trim();
  };
  const cleanup = () => {
    app.cleanup();
    lib.cleanup();
    fs.rmSync(path.dirname(libWt), { recursive: true, force: true });
  };
  return { root: app.dir, config, id, libWt, commit, cleanup };
}

test('forge job decision binds the decision to the worktree head, once per approver run', () => {
  const s = linkedJob();
  try {
    const head = s.commit(s.root, 'app.txt');
    const libHead = s.commit(s.libWt, 'lib.txt');
    const ended = new Date(Date.now() - 1000).toISOString();
    updateJob(s.root, s.id, (j) => {
      j.agents.approver = { runs: 1, status: 'done', model: 'opus', agentId: 'a1', startedAt: ended, endedAt: ended, round: 1 } as JobAgent;
    });
    const file = path.join(jobDir(s.root, s.id), 'decision.md');
    fs.writeFileSync(file, 'APPROVE: small and reviewed\n\nAuto-merge eligible: no\n');
    const first = decision(s.root, s.config, [s.id], {});
    assert.deepEqual(first, { decision: 'APPROVE', reason: 'small and reviewed', autoMerge: false, head, heads: { lib: libHead }, recorded: true });
    assert.match(head, /^[0-9a-f]{40}$/);
    // The same approver run: an edit to `yes` changes nothing.
    fs.writeFileSync(file, 'APPROVE: small and reviewed\n\nAuto-merge eligible: yes\n');
    assert.deepEqual(decision(s.root, s.config, [s.id], {}), { ...first, recorded: false });
    const events = readEvents(s.root, s.id).filter((e) => e.type === 'decision');
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].autoMerge, events[0].head, events[0].heads], [false, head, { lib: libHead }]);
  } finally {
    s.cleanup();
  }
});
