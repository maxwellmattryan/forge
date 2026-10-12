import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { defaults } from '../lib/config.mjs';
import { createJob, setJob } from '../lib/jobs.mjs';
import local from '../lib/trackers/local.mjs';
import { statusKey } from '../lib/trackers/status.mjs';
import { statusMap } from '../lib/trackers/github.mjs';

test('local backlog: create, list, claim, update, close', () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const ctx = { root: repo.dir, config };
    fs.mkdirSync(path.join(repo.dir, '.factory'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.factory', 'backlog.md'), '# Backlog\n\n- [ ] First thing\n  with a description\n- [x] Old thing\n');
    local.create(ctx, { title: 'Second thing', body: 'more detail' });
    let ready = local.list(ctx, { ready: true });
    assert.deepEqual(ready.map((i) => i.ref), ['first-thing', 'second-thing']);
    assert.equal(local.get(ctx, 'first-thing').body, 'with a description');

    const job = createJob(repo.dir, config, { title: 'First thing', ref: 'first-thing' });
    assert.deepEqual(local.claim(ctx, 'first-thing', job), { ok: true });
    assert.equal(local.claim(ctx, 'first-thing', { id: 'someone-else' }).ok, false);
    ready = local.list(ctx, { ready: true });
    assert.deepEqual(ready.map((i) => i.ref), ['second-thing']);

    local.update(ctx, 'first-thing', setJob(repo.dir, job.id, { stage: 'done', state: 'done' }));
    assert.match(fs.readFileSync(path.join(repo.dir, '.factory', 'backlog.md'), 'utf8'), /- \[x\] First thing → first-thing/);
    local.close(ctx, 'second-thing', { reason: 'not-planned' });
    assert.equal(local.get(ctx, 'second-thing').status, 'dropped');
  } finally {
    repo.cleanup();
  }
});

test('status keys and project option matching', () => {
  assert.equal(statusKey({ state: 'running', stage: 'build' }), 'in-progress');
  assert.equal(statusKey({ state: 'waiting', stage: 'spec', waitingOn: 'spec-approval' }), 'blocked');
  assert.equal(statusKey({ state: 'waiting', stage: 'pr', waitingOn: 'pr-review' }), 'review');
  assert.equal(statusKey({ state: 'done', stage: 'done' }), 'done');
  const config = defaults();
  const options = ['📚 Backlog', '🚫 Blocked', '🔖 Todo', '⏸️ Paused', '🏗 In Progress', '🔎 In Review', '🎉 Done'];
  const map = statusMap({ config }, options);
  assert.deepEqual(map, { queued: '🔖 Todo', 'in-progress': '🏗 In Progress', review: '🔎 In Review', blocked: '🚫 Blocked', done: '🎉 Done', cancelled: null });
  config.tracker.github.project.statusMap = { blocked: '⏸️ Paused' };
  assert.equal(statusMap({ config }, options).blocked, '⏸️ Paused');
});
