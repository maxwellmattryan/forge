// Linked PRs: sibling links in every PR body, a job done only when every PR merged, and merges in
// the components' dependency order. Scratch repos with bare remotes and the fake gh in
// job-repos-fixture.ts; no real GitHub repo is touched.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dependsOn, prProject, ready } from './job-repos-fixture.ts';
import type { PrProject } from './job-repos-fixture.ts';
import { loadJob } from '../lib/jobs.ts';
import { SIBLINGS_END, SIBLINGS_START } from '../lib/pr.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

// The fake gh is a sh script.
const skip = process.platform === 'win32';

/** A two-repo job, verified, with both PRs open: lib #7 and app #11. */
async function opened(p: PrProject) {
  const j = await ready(p);
  await p.f('verify', j.id);
  const r = await p.pr(['open', j.id]);
  assert.equal(r.status, 0, r.stderr);
  return j;
}

const section = (line: string) => `${SIBLINGS_START}\n${line}\n${SIBLINGS_END}`;
const edits = (p: PrProject, slug?: string) => p.calls().filter((c) => c.startsWith('pr edit') && (!slug || c.includes(`-R ${slug} `)));

describe('linked PRs: sibling links', { concurrency: 4, skip }, () => {
  test('pr open links sibling PRs in graph order', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    const line = `Part of job ${j.id}: o/lib#7 then o/app#11`;
    const dir = path.join(p.root, '.forge', 'jobs', j.id);
    for (const [name, file] of [['app', 'pr-body.md'], ['lib', 'pr-body-lib.md']]) {
      const created = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.ok(created.includes(`${SIBLINGS_START}\n${SIBLINGS_END}`), `${name}: the PR is created with an empty section`);
      assert.equal(p.body(name), created.replace(`${SIBLINGS_START}\n${SIBLINGS_END}`, section(line)), `${name}: only the section changed`);
    }
    assert.equal(edits(p).length, 2);
    assert.deepEqual(
      p.events(j.id).filter((e) => e.type === 'pr-links-updated').map((e) => [e.repo ?? null, e.number, e.line]),
      [['lib', 7, line], [null, 11, line]],
    );
    const again = await p.pr(['open', j.id]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(edits(p).length, 2, 'a second pr open makes no pr edit call');
  });

  test('sync rewrites sibling links only when they change', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    const sync = async () => {
      const r = await p.pr(['sync', j.id]);
      assert.equal(r.status, 0, r.stderr);
    };
    const kinds = (type: string) => p.events(j.id).filter((e) => e.type === type).map((e) => [e.repo ?? null, e.number]);
    await sync();
    assert.equal(edits(p).length, 2, 'an unchanged line is not written again');

    // The member PR's number changes: both bodies get the new line.
    p.fake('lib.num', '8');
    await sync();
    const line8 = `Part of job ${j.id}: o/lib#8 then o/app#11`;
    assert.equal(edits(p).length, 4);
    assert.ok(p.body('lib').includes(section(line8)) && p.body('app').includes(section(line8)));

    // A human removed the markers from the root body: it is left alone, and skipped once per line.
    const human = 'Rewritten by a person.\n';
    p.fake('app.body', human);
    p.fake('lib.num', '9');
    await sync();
    await sync();
    assert.equal(p.body('app'), human);
    assert.deepEqual(kinds('pr-links-skipped'), [[null, 11]]);
    assert.equal(p.events(j.id).find((e) => e.type === 'pr-links-skipped').reason, 'markers');
    assert.equal(edits(p, 'o/app').length, 2, 'no edit of the root body without markers');

    // A failing edit is logged and never fails sync.
    p.fake('lib.editfail', '');
    p.fake('lib.num', '10');
    await sync();
    assert.deepEqual(kinds('pr-links-failed'), [['lib', 10]]);
    p.fake('lib.editfail', null);

    // A MERGED PR is never edited, and the open one still is.
    p.fake('app.body', `x\n${SIBLINGS_START}\n${SIBLINGS_END}\n`);
    p.fake('app.state', 'MERGED');
    p.fake('lib.num', '12');
    const before = edits(p, 'o/app').length;
    await sync();
    assert.equal(edits(p, 'o/app').length, before, 'no edit of a merged PR');
    assert.ok(p.body('lib').includes(section(`Part of job ${j.id}: o/lib#12 then o/app#11`)));
  });

  test('no sibling section without a PR member', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const v = await ready(p, { verifyOnly: true });
    await p.f('verify', v.id);
    assert.equal((await p.pr(['open', v.id])).status, 0);
    await p.f('job', 'set', v.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    assert.equal((await p.pr(['sync', v.id])).status, 0);
    const title = loadJob(p.root, v.id).title;
    assert.equal(p.body('app'), `## Summary\n\n${title}\n\n<!-- forge -->\n`, 'a verify-only member keeps the single-repo body');

    const s = await p.f('job', 'new', '--title', 'Single repo change');
    await p.f('worktree', 'create', s.id);
    p.commit(path.join(p.parent, 'app.worktrees', s.id), { 'one.txt': 'one\n' }, 'feat: one');
    await p.f('job', 'round', s.id);
    await p.f('verify', s.id);
    p.fake('app.pr', null);
    assert.equal((await p.pr(['open', s.id])).status, 0);
    await p.f('job', 'set', s.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    assert.equal((await p.pr(['sync', s.id])).status, 0);
    assert.equal(p.body('app'), `## Summary\n\nSingle repo change\n\n<!-- forge -->\n`);
    assert.deepEqual(p.calls().filter((c) => c.startsWith('pr edit') || c.includes('--json body')), [], 'no edit or body read');
  });
});
