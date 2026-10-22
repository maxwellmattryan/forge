// Repo proposals (issue #180): an agent proposes a member repo with `forge job repo propose`, the job
// parks (step RP1), and a human (or the foreman) approves or rejects it. The CLI's own checks are in
// repo-proposals-cli.test.ts. Scratch repos only (job-repos-fixture.ts: root `app`, member `lib`).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadJob } from '../lib/core/job/store.ts';
import { pendingRepoProposals, repoProposals } from '../lib/repo-proposals.ts';
import { ev } from './step-fixture.ts';
import { dir, project } from './repo-proposals-fixture.ts';

describe('repo proposals: the pipeline', () => {
  test("a spec that changes a library's API proposes its repo and waits for approval", async () => {
    const p = await project();
    p.config((c) => {
      c.components = [
        { name: 'core', repo: 'lib', path: '.', kind: 'library' },
        { name: 'app', repo: null, path: '.', kind: 'service', dependsOn: [{ component: 'core', type: 'build' }] },
      ];
    });
    const j = await p.f('job', 'new', '--title', 'app needs a core API');
    await p.f('job', 'set', j.id, '--stage', 'spec', '--state', 'running');
    fs.writeFileSync(path.join(dir(p, j.id), 'spec.md'), '# Spec\n\nSize: S\n\n## Approach\ncore gains `parse(text)` in lib; app calls it.\n');
    await p.f('job', 'agent', j.id, 'start', '--role', 'spec-writer');
    await p.f('job', 'agent', j.id, 'end', '--role', 'spec-writer', '--status', 'done');
    await p.f('job', 'repo', 'propose', j.id, 'lib', '--reason', "core's parse() API changes; app depends on core (build)");
    const park = await p.f('job', 'step', j.id);
    assert.equal(park.rule, 'RP1');
    assert.deepEqual(park.command, ['job', 'set', j.id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'repo proposal: lib']);
    await p.f(...park.command);
    const waiting = loadJob(p.root, j.id);
    assert.deepEqual([waiting.state, waiting.waitingOn, waiting.reason], ['waiting', 'human', 'repo proposal: lib']);
    assert.match((await p.f('job', 'step', j.id)).tell, /proposes repos \(repo proposal: lib\): .*repo-proposals\.md/);
    await p.f('job', 'human', j.id, 'approve-repos', '--repo', 'lib', '--note', 'yes');
    await p.f('job', 'set', j.id, '--state', 'running');
    const create = await p.f('job', 'step', j.id);
    assert.equal(create.rule, 'RP2');
    assert.deepEqual(create.command, ['worktree', 'create', j.id]);
    await p.f(...create.command);
    assert.ok(fs.existsSync(path.join(p.parent, 'lib.worktrees', j.id)));
    assert.notEqual((await p.f('job', 'step', j.id)).rule, 'RP2');
  });

  test('repoProposals reads only well-formed names and decisions after the proposal', () => {
    const job = { repos: [] } as any;
    const events = [
      ev('repo-proposed', 1, { repo: 'lib', reason: 'a\nb`c' }),
      ev('repo-proposed', 2, { repo: '../evil', reason: 'x' }),
      ev('repo-proposed', 3, { repo: 'tools', reason: 't' }),
      ev('human', 4, { action: 'reject-repos', repos: ['tools', '../evil'], note: 'no', actor: { login: 'a', source: 'gh' } }),
      ev('repo-proposed', 5, { repo: 'lib', reason: 'again' }),
    ];
    const rows = repoProposals(job, events as any);
    assert.deepEqual(rows.map((r) => [r.repo, r.status, r.reason]), [['lib', 'pending', 'again'], ['tools', 'rejected', 't']]);
    assert.deepEqual(rows[1].actor, { login: 'a', source: 'gh' });
    assert.deepEqual(pendingRepoProposals(job, events as any).map((r) => r.repo), ['lib']);
    assert.deepEqual(pendingRepoProposals({ repos: [{ repo: null }, { repo: 'lib' }] } as any, events as any), []);
    assert.equal(repoProposals(job, [ev('repo-proposed', 1, { repo: 'lib', reason: 'a\nb`c' })] as any)[0].reason, 'abc');
  });
});
