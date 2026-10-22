// integrationTouched: what a conflict resolution changed beyond git's own merge, which decides
// whether a docs-only conflict may skip the integration review (step rule IG11).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/core/config/load.ts';
import { integrationTouched } from '../lib/engine/pipeline/scope.ts';
import { loadIntegrationTouched } from '../lib/engine/pipeline/step.ts';

function scenario() {
  const repo = tempRepo();
  const git = (...args: string[]) => repo.git(...args).toString().trim();
  const write = (files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo.dir, f)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, f), text);
    }
  };
  const commit = (files: Record<string, string>, msg: string) => {
    write(files);
    git('add', '-A');
    git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  commit({ 'lib/a.ts': 'a\n', 'lib/b.ts': 'b\n' }, 'code');
  git('checkout', '-q', '-b', 'job');
  const head = commit({ 'README.md': '# ours\n', 'lib/a.ts': 'a job\n' }, 'job');
  git('checkout', '-q', 'main');
  const upstream = commit({ 'README.md': '# theirs\n', 'lib/b.ts': 'b base\n' }, 'base');
  git('checkout', '-q', 'job');
  // The merge stops on README.md; the integrator resolves it.
  assert.throws(() => git('merge', '--no-edit', 'main'));
  write({ 'README.md': '# both\n' });
  return { repo, git, write, commit, head, upstream };
}

test('integrationTouched lists only the resolved conflict for a plain resolution', () => {
  const s = scenario();
  try {
    const sha = s.commit({}, 'merge');
    assert.deepEqual(integrationTouched(s.repo.dir, s.head, s.upstream, sha), ['README.md']);
  } finally {
    s.repo.cleanup();
  }
});

test('integrationTouched sees code staged into the merge, committed after it, or a base change undone', () => {
  const s = scenario();
  try {
    const merge = s.commit({ 'lib/c.ts': 'sneaked in\n' }, 'merge');
    assert.deepEqual(integrationTouched(s.repo.dir, s.head, s.upstream, merge), ['README.md', 'lib/c.ts']);
    const fallout = s.commit({ 'lib/a.ts': 'a changed after\n' }, 'fallout');
    assert.deepEqual(integrationTouched(s.repo.dir, s.head, s.upstream, fallout), ['README.md', 'lib/a.ts', 'lib/c.ts']);
    const undone = s.commit({ 'lib/b.ts': 'b\n' }, 'undo the base change');
    assert.deepEqual(integrationTouched(s.repo.dir, s.head, s.upstream, undone), ['README.md', 'lib/a.ts', 'lib/b.ts', 'lib/c.ts']);
  } finally {
    s.repo.cleanup();
  }
});

test('loadStepInput reads the resolution diff only in integrate under code-only, at the last passing verify', () => {
  const s = scenario();
  try {
    const sha = s.commit({ 'lib/c.ts': 'x\n' }, 'merge');
    const events: any[] = [{ v: 1, ts: 't1', type: 'integrate-conflicts', conflicts: ['README.md'], head: s.head, upstream: s.upstream }];
    const job: any = { stage: 'integrate', worktree: s.repo.dir, verifyRuns: [{ ok: true, sha }] };
    const config = defaults();
    assert.deepEqual(loadIntegrationTouched(job, config, events), { head: s.head, upstream: s.upstream, sha, files: ['README.md', 'lib/c.ts'] });
    assert.equal(loadIntegrationTouched({ ...job, stage: 'decide' }, config, events), null);
    assert.equal(loadIntegrationTouched({ ...job, verifyRuns: [{ ok: false, sha }] }, config, events), null);
    assert.equal(loadIntegrationTouched(job, config, [{ ...events[0], head: undefined }]), null);
    config.pr.integrationReview = 'always';
    assert.equal(loadIntegrationTouched(job, config, events), null, 'no git work when the review always runs');
  } finally {
    s.repo.cleanup();
  }
});

test('integrationTouched is null when it cannot tell', () => {
  const s = scenario();
  try {
    const sha = s.commit({}, 'merge');
    assert.equal(integrationTouched(s.repo.dir, 'HEAD', s.upstream, sha), null, 'refs are not shas');
    assert.equal(integrationTouched(s.repo.dir, s.head, '--output=/tmp/x', sha), null);
    assert.equal(integrationTouched(s.repo.dir, s.head, s.upstream, 'f'.repeat(40)), null, 'an unknown commit');
  } finally {
    s.repo.cleanup();
  }
});
