// The CLI passes the gh adapter, so `forge pr sync` still reads the PR through `gh`. One spawned
// test: fakeGh goes in the child's env only, never in this process's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeGh, forgeAsync, ghPr, tempRepo } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { createJob, setJob } from '#core/job/store.ts';

const VIEW_FIELDS = 'number,url,state,isDraft,isCrossRepository,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt';

test('forge pr sync reads the PR through gh', { skip: process.platform === 'win32' }, async () => {
  const repo = tempRepo();
  const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
  const gh = fakeGh({
    'pr view': JSON.stringify(ghPr({ statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] })),
    'api graphql': JSON.stringify({ data: { repository: { pullRequest: {} } } }),
  });
  try {
    fs.writeFileSync(answers, JSON.stringify({ tracker: { github: { repo: 'o/r' } } }));
    const init = await forgeAsync(repo.dir, ['init', 'write', '--answers', answers]);
    assert.equal(init.status, 0, init.stderr);
    const id = createJob(repo.dir, loadConfig(repo.dir).config, { title: 'sync through gh' }).id;
    setJob(repo.dir, id, { owned: { pr: { number: 7 } } });
    const r = await forgeAsync(repo.dir, ['pr', 'sync', id], gh.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.pr.state, out.pr.checks.state], ['OPEN', 'passing']);
    assert.ok(
      gh.calls().some((c) => c.args.join(' ') === `pr view 7 -R o/r --json ${VIEW_FIELDS}`),
      JSON.stringify(gh.calls().map((c) => c.args.slice(0, 4))),
    );
  } finally {
    fs.rmSync(answers, { force: true });
    fs.rmSync(gh.dir, { recursive: true, force: true });
    repo.cleanup();
  }
});
