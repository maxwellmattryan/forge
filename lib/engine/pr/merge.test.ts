// mergePr makes at most one merge call, through the GitHub adapter: the in-memory one here, so each
// row is in-process with its own repo and GitHub, and the rows run concurrently.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ghPr, memoryGitHub, parkedAt, tempRepo } from '../../../test/helpers.ts';
import { mergePr } from './merge.ts';
import type { MergeResult } from './merge.ts';
import { defaults } from '#core/config/load.ts';
import { readEvents } from '#core/job/store.ts';

// defaults(): a non-empty policy.protectedPaths and merge.method squash.
const config = defaults();
config.tracker.github.repo = 'o/r';
const SHA = 'c'.repeat(40);

const ROLLUP = {
  passing: [{ name: 'test', conclusion: 'SUCCESS' }],
  pending: [{ name: 'test', status: 'IN_PROGRESS' }],
  failing: [{ name: 'test', conclusion: 'FAILURE' }],
};

/** A single-repo job with PR #7 pushed at SHA, and GitHub's PR #7 at that head. */
function scenario(rollup: keyof typeof ROLLUP, mergeStateStatus = 'CLEAN') {
  const repo = tempRepo();
  const id = parkedAt(repo.dir, 'pr-review', { config, title: 'merge me', pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', pushedSha: SHA } }).id;
  const github = memoryGitHub();
  github.put(ghPr({ headRefOid: SHA, statusCheckRollup: ROLLUP[rollup], mergeStateStatus }));
  return { root: repo.dir, id, github, merges: () => github.calls.filter((c) => c.op === 'merge'), events: () => readEvents(repo.dir, id).map((e) => e.type), cleanup: repo.cleanup };
}

type Scenario = ReturnType<typeof scenario>;

const ROWS: { name: string; arrange: () => Scenario; check: (s: Scenario, r: MergeResult) => void }[] = [
  {
    name: '(a) passing checks: one merge call pinned to the pushed head',
    arrange: () => scenario('passing'),
    check: (s, r) => {
      assert.deepEqual(s.merges(), [{ op: 'merge', slug: 'o/r', number: 7, method: 'squash', auto: false, matchHead: SHA }]);
      assert.deepEqual([r.merged, r.action], [true, 'merged']);
      assert.ok(s.events().includes('pr-merged'));
    },
  },
  {
    name: '(b) failing checks: no merge call, refused',
    arrange: () => scenario('failing'),
    check: (s, r) => {
      assert.deepEqual(s.merges(), []);
      assert.equal(r.action, 'refused');
    },
  },
  {
    name: '(c) pending checks on a BLOCKED PR: held by the protected-paths policy, no merge call',
    arrange: () => scenario('pending', 'BLOCKED'),
    check: (s, r) => {
      assert.deepEqual(s.merges(), []);
      assert.equal(r.action, 'deferred');
    },
  },
  {
    name: "(d) a merge GitHub refuses: one call, failed with GitHub's error",
    arrange: () => {
      const s = scenario('passing');
      s.github.fail('merge', 'auto-merge is not allowed');
      return s;
    },
    check: (s, r) => {
      assert.equal(s.merges().length, 1);
      assert.deepEqual([r.action, r.error], ['failed', 'auto-merge is not allowed']);
      assert.ok(s.events().includes('pr-merge-failed'));
    },
  },
];

describe('mergePr makes at most one merge call through the adapter', { concurrency: 4 }, () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const s = row.arrange();
      try {
        row.check(s, await mergePr(s.root, config, s.github, s.id));
      } finally {
        s.cleanup();
      }
    });
  }
});
