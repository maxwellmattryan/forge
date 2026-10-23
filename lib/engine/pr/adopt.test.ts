// findPr never adopts a fork's PR, even on the job's own branch: untrusted code must not become the
// job's PR (docs/architecture/untrusted-input.md). Kept through the test rewrite
// (docs/test-rewrite/README.md): the security posture AGENTS.md says to preserve. GitHub is the
// in-memory adapter, so no gh script, PATH or env change, and the table runs concurrently.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ghPr, memoryGitHub, tempRepo } from '../../../test/helpers.ts';
import { findPr } from './adopt.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, loadJob, readEvents, setJob } from '#core/job/store.ts';
import { parsePr } from '#integrations/github/pull-requests.ts';
import type { PrSnapshot } from '#integrations/github/types.ts';

const config = defaults();
config.tracker.github.repo = 'o/r';

/** A scratch repo with one job linked to issue o/r#5, and an empty memory GitHub. */
function scenario() {
  const repo = tempRepo();
  const id = createJob(repo.dir, config, { title: 'adopt me', issues: [{ tracker: 'github', ref: 'o/r#5', url: null }] }).id;
  const github = memoryGitHub();
  return { root: repo.dir, id, github, job: () => loadJob(repo.dir, id), events: () => readEvents(repo.dir, id), cleanup: repo.cleanup };
}

type Scenario = ReturnType<typeof scenario>;

test("findPr never adopts a fork PR on the job's branch", () => {
  const s = scenario();
  try {
    const root = s.root;
    const id = s.id;
    // No recorded PR, so the lookup goes by branch, and GitHub lists only a fork's PR on it.
    setJob(root, id, { owned: { pr: null } });
    s.github.put(ghPr({ headRefName: s.job().branch, isCrossRepository: true }));
    assert.equal(findPr(root, config, s.github, id), null);
    assert.equal(loadJob(root, id).pr, null);
    const evs = readEvents(root, id);
    assert.ok(evs.some((e) => e.type === 'pr-find' && e.found === false));
    assert.ok(!evs.some((e) => e.type === 'pr-adopted'));
  } finally {
    s.cleanup();
  }
});

const closing = (number: number, over: Record<string, unknown> = {}) => ({ number, state: 'OPEN', headRefName: 'forge/x', isCrossRepository: false, authorAssociation: 'MEMBER', ...over });
const pr9 = ghPr({ number: 9, url: 'https://github.com/o/r/pull/9' });

/** Nothing adopted: null back, the lookup recorded, no pr-adopted, no PR on the job. */
function notAdopted(s: Scenario, result: PrSnapshot | null): void {
  assert.equal(result, null);
  assert.equal(s.job().pr, null);
  assert.ok(s.events().some((e) => e.type === 'pr-find' && e.found === false));
  assert.ok(!s.events().some((e) => e.type === 'pr-adopted'));
  assert.ok(!s.github.calls.some((c) => c.op === 'view'), 'no PR is viewed');
}

const ROWS: { name: string; arrange: (s: Scenario) => void; check: (s: Scenario, run: () => PrSnapshot | null) => void }[] = [
  {
    name: '(a) a branch-listed PR with no isCrossRepository counts as a fork',
    arrange: (s) => {
      const raw = ghPr({ headRefName: s.job().branch });
      delete raw.isCrossRepository;
      s.github.put(raw);
    },
    check: (s, run) => notAdopted(s, run()),
  },
  {
    name: '(b) a closing PR from a fork is not adopted',
    arrange: (s) => {
      s.github.setClosing(5, [closing(9, { isCrossRepository: true })]);
      s.github.put(pr9);
    },
    check: (s, run) => notAdopted(s, run()),
  },
  {
    name: '(b) a closing PR by a CONTRIBUTOR is not adopted',
    arrange: (s) => {
      s.github.setClosing(5, [closing(9, { authorAssociation: 'CONTRIBUTOR' })]);
      s.github.put(pr9);
    },
    check: (s, run) => notAdopted(s, run()),
  },
  {
    name: '(c) a trusted same-repo closing PR is viewed and adopted',
    arrange: (s) => {
      s.github.setClosing(5, [closing(8, { isCrossRepository: true }), closing(10, { authorAssociation: 'NONE' }), closing(9)]);
      s.github.put(pr9);
    },
    check: (s, run) => {
      assert.equal(run()?.number, 9);
      assert.deepEqual(s.github.calls.filter((c) => c.op === 'view').map((c) => c.number), [9]);
      assert.equal(s.job().pr?.number, 9);
      assert.ok(s.events().some((e) => e.type === 'pr-adopted' && e.number === 9));
    },
  },
  {
    name: '(d) a same-repo PR with an option-like headRefName is refused',
    arrange: (s) => {
      s.github.setClosing(5, [closing(7)]);
      s.github.put(ghPr({ headRefName: '--upload-pack=x' }));
    },
    check: (s, run) => {
      assert.throws(run, /unsafe headRefName/);
      const refused = s.events().filter((e) => e.type === 'pr-adopt-refused');
      assert.deepEqual(
        refused.map((e) => ({ number: e.number, field: e.field })),
        [{ number: 7, field: 'headRefName' }],
      );
      assert.equal(s.job().pr, null);
      assert.ok(!s.events().some((e) => e.type === 'pr-adopted'));
    },
  },
  {
    name: '(e) a same-repo PR on forge/x → main is adopted',
    arrange: (s) => {
      s.github.setClosing(5, [closing(7)]);
      s.github.put(ghPr());
    },
    check: (s, run) => {
      const result = run();
      assert.deepEqual(result, parsePr(ghPr()));
      const pr = s.job().pr!;
      assert.equal(typeof pr.lastSyncedAt, 'string');
      assert.deepEqual(pr, { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, lastSyncedAt: pr.lastSyncedAt });
      assert.equal(s.job().branch, 'forge/x');
      assert.ok(s.events().some((e) => e.type === 'pr-adopted' && e.number === 7 && e.branch === 'forge/x'));
    },
  },
];

describe('findPr adopts only a same-repo PR with safe refs', { concurrency: 4 }, () => {
  for (const row of ROWS) {
    test(row.name, () => {
      const s = scenario();
      try {
        row.arrange(s);
        row.check(s, () => findPr(s.root, config, s.github, s.id));
      } finally {
        s.cleanup();
      }
    });
  }
});
