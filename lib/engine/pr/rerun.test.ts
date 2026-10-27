// The CI re-run after a CI rework with no new commit, through syncPr and the in-memory GitHub: each
// test has its own repo and GitHub. The memory GitHub's rerunFailed never changes the rollup, so each
// test patches what GitHub would report next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ghPr, memoryGitHub, parkedAt, tempRepo } from '../../../test/helpers.ts';
import { syncPr } from './sync.ts';
import { defaults } from '#core/config/load.ts';
import { loadJob, logHumanEvent, readEvents, setJob } from '#core/job/store.ts';
import { listRequests } from '#core/job/requests.ts';
import type { Config, Job, JobEvent } from '#core/types.ts';

const SHA = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const NAME = 'verify (node 22.18.0, shard 2/2)';
const STILL_FAILING = `CI re-run: ${NAME} still failing on PR #7 at bbbbbbbbbbbb after a CI rework with no new commit and one re-run. Local verify passes. A human decides`;
const notRerun = (checks: string) => `CI re-run: ${checks} failing on PR #7 at bbbbbbbbbbbb after a CI rework with no new commit, and Forge could not re-run them. Local verify passes. A human decides`;

const jobUrl = (run: number, job: number, slug = 'o/r') => `https://github.com/${slug}/actions/runs/${run}/job/${job}`;
/** A check run in the rollup, as gh prints it: `NAME` by default, a GitHub Actions job of run 101. */
const check = (conclusion: string, job = 201, run = 101, over: Record<string, unknown> = {}) => ({ __typename: 'CheckRun', name: NAME, status: 'COMPLETED', conclusion, detailsUrl: jobUrl(run, job), ...over });
const pending = (job: number, run: number, name = 'lint') => ({ __typename: 'CheckRun', name, status: 'IN_PROGRESS', conclusion: '', detailsUrl: jobUrl(run, job) });

/** The foreman on, with the default foreman.reserved (which lists CI) and the daemon on. */
function foremanConfig(edit: (c: Config) => void = () => {}): Config {
  const c = defaults();
  c.tracker.github.repo = 'o/r';
  c.daemon = { ...c.daemon, enabled: true };
  c.foreman = { ...c.foreman, enabled: true };
  edit(c);
  return c;
}

const at = (j: Job) => [j.stage, j.state, j.waitingOn];
const fields = (e: JobEvent, keys: string[]) => Object.fromEntries(keys.map((k) => [k, e[k as keyof JobEvent]]));

/**
 * A job whose first sync started the foreman's CI rework on the red head SHA, and whose round then
 * ended with no new commit: parked on pr-review again at the same head. Run 101 is on SHA and completed.
 */
async function reworked(opts: { config?: Config; rollup?: unknown[]; run?: unknown } = {}) {
  const config = opts.config ?? foremanConfig();
  const repo = tempRepo();
  const id = parkedAt(repo.dir, 'pr-review', { config, title: 'rerun me', pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', pushedSha: SHA } }).id;
  const github = memoryGitHub();
  github.put(ghPr({ headRefOid: SHA, statusCheckRollup: opts.rollup ?? [check('FAILURE')] }));
  github.setRun('101', opts.run ?? { headSha: SHA, status: 'completed', conclusion: 'failure' });
  const s = {
    root: repo.dir,
    id,
    github,
    config,
    sync: (c: Config = config) => syncPr(repo.dir, c, github, id),
    job: () => loadJob(repo.dir, id),
    /** The round ended with no new commit: the job waits on review again, at the same head. */
    repark: () => setJob(repo.dir, id, { stage: 'pr', state: 'waiting', waitingOn: 'pr-review' }),
    rollup: (rollup: unknown[], head = SHA) => github.patch(7, { headRefOid: head, statusCheckRollup: rollup }),
    events: (type: string) => readEvents(repo.dir, id).filter((e) => e.type === type),
    reworks: () => readEvents(repo.dir, id).filter((e) => e.type === 'human' && e.action === 'rework'),
    gates: () => listRequests(repo.dir, { status: 'pending' }).filter((r) => r.type === 'gate' && r.job === id),
    resumes: () => listRequests(repo.dir, { status: 'pending' }).filter((r) => r.type === 'resume' && r.job === id),
    ghCalls: () => github.calls.filter((c) => c.op === 'viewRun' || c.op === 'rerunFailed'),
    cleanup: repo.cleanup,
  };
  await s.sync();
  assert.deepEqual(at(s.job()), ['build', 'running', null], 'the first sync starts the CI rework');
  s.repark();
  return s;
}

type Reworked = Awaited<ReturnType<typeof reworked>>;

/** Nothing moved: no gh re-run call, no re-run event, the same reason and no gate. */
function nothingHappened(s: Reworked, calls: number, reason: string | null | undefined, label: string) {
  assert.equal(s.ghCalls().length, calls, `${label}: no viewRun or rerunFailed call`);
  assert.equal(s.events('ci-rerun-failed').length, 0, `${label}: no ci-rerun-failed`);
  assert.equal(s.job().reason, reason, `${label}: the reason stays`);
  assert.deepEqual(s.gates(), [], `${label}: no gate`);
}

test('a CI rework with no new commit re-runs the failed checks once', async () => {
  const s = await reworked();
  try {
    await s.sync();
    assert.deepEqual(s.ghCalls(), [
      { op: 'viewRun', slug: 'o/r', run: '101' },
      { op: 'rerunFailed', slug: 'o/r', run: '101' },
    ]);
    assert.deepEqual(
      s.events('ci-rerun').map((e) => fields(e, ['head', 'runs', 'jobs', 'checks'])),
      [{ head: SHA, runs: ['101'], jobs: ['201'], checks: [NAME] }],
    );
    assert.deepEqual(at(s.job()), ['pr', 'waiting', 'pr-review']);
    assert.deepEqual(s.gates(), []);
    assert.equal(s.resumes().length, 1, 'still the one resume the rework queued');
    assert.equal(s.reworks().length, 1, 'still the one rework');
  } finally {
    s.cleanup();
  }
});

test('the re-run waits for finished checks and for GitHub to register it', async () => {
  const s = await reworked();
  try {
    const reason = s.job().reason;
    // (b) A check still running on a head not yet re-run: wait.
    s.rollup([check('FAILURE'), pending(202, 102)]);
    await s.sync();
    nothingHappened(s, 0, reason, 'pending before the re-run');
    assert.equal(s.events('ci-rerun').length, 0);
    // (c) Once it completes, the re-run happens.
    s.rollup([check('FAILURE'), check('SUCCESS', 202, 102, { name: 'lint' })]);
    await s.sync();
    assert.deepEqual(s.ghCalls().map((c) => c.op), ['viewRun', 'rerunFailed']);
    assert.equal(s.events('ci-rerun').length, 1);
    // (a) GitHub still lists job 201, the one re-run, as failing: wait.
    await s.sync();
    nothingHappened(s, 2, reason, 'the re-run job still listed');
    assert.equal(s.events('ci-rerun').length, 1);
    // (b) A check still running after the re-run: wait.
    s.rollup([pending(203, 101, NAME), check('FAILURE', 204, 102, { name: 'lint' })]);
    await s.sync();
    nothingHappened(s, 2, reason, 'pending after the re-run');
  } finally {
    s.cleanup();
  }
});

test('a passing re-run leaves the job to merge', async () => {
  const s = await reworked();
  try {
    await s.sync();
    s.rollup([check('SUCCESS', 202)]);
    await s.sync();
    const j = s.job();
    assert.deepEqual(at(j), ['pr', 'waiting', 'pr-review']);
    assert.equal(j.pr?.checks?.state, 'passing');
    assert.ok(!j.reason?.startsWith('CI re-run:'), String(j.reason));
    assert.equal(s.events('ci-rerun-failed').length, 0);
    assert.deepEqual(s.gates(), []);
    assert.equal(s.reworks().length, 1);
  } finally {
    s.cleanup();
  }
});

test('a failed re-run parks the job for a human, once per head', async () => {
  const s = await reworked();
  try {
    await s.sync();
    s.rollup([check('FAILURE', 202)]);
    await s.sync();
    assert.equal(s.job().reason, STILL_FAILING);
    assert.deepEqual(at(s.job()), ['pr', 'waiting', 'pr-review']);
    assert.deepEqual(
      s.events('ci-rerun-failed').map((e) => fields(e, ['head', 'cause', 'checks'])),
      [{ head: SHA, cause: 'still-failing', checks: [NAME] }],
    );
    assert.deepEqual(s.gates(), [], 'no gate under the default foreman.reserved');
    assert.equal(s.reworks().length, 1, 'no new rework');
    assert.equal(s.resumes().length, 1, 'no second resume');

    const count = (types: string[]) => readEvents(s.root, s.id).filter((e) => types.includes(e.type)).length;
    const WATCHED = ['ci-rerun', 'ci-rerun-failed', 'human', 'ci-rework-capped'];
    const before = count(WATCHED);
    await s.sync();
    assert.equal(count(WATCHED), before, 'a second sync logs nothing more');
    assert.deepEqual(s.gates(), []);

    // A person looks, and the job comes back to pr-review on the same head: no second re-run.
    logHumanEvent(s.root, s.id, 'human', { action: 'rework', note: 'try again' }, { login: 'al', source: 'env' });
    s.repark();
    const reruns = s.github.calls.filter((c) => c.op === 'rerunFailed').length;
    const marked = count(WATCHED);
    await s.sync();
    assert.equal(s.github.calls.filter((c) => c.op === 'rerunFailed').length, reruns, 'no rerunFailed call');
    assert.equal(count(WATCHED), marked, 'no new event');
    assert.equal(s.job().reason, STILL_FAILING);
    assert.deepEqual(s.gates(), []);
  } finally {
    s.cleanup();
  }
});

test("a head Forge can't re-run parks for a human", async () => {
  const rows: { name: string; rollup?: unknown[]; run?: unknown; fail?: ['viewRun' | 'rerunFailed', string]; checks?: string; calls: string[] }[] = [
    { name: '(a) a commit status', rollup: [{ __typename: 'StatusContext', context: 'ci/x', state: 'FAILURE', targetUrl: jobUrl(101, 201) }], checks: 'ci/x', calls: [] },
    { name: '(b) a job in another repo', rollup: [check('FAILURE', 201, 101, { detailsUrl: jobUrl(101, 201, 'evil/r') })], calls: [] },
    { name: '(c) a run on another head', run: { headSha: OTHER, status: 'completed' }, calls: ['viewRun'] },
    { name: '(c) a run still in progress', run: { headSha: SHA, status: 'in_progress' }, calls: ['viewRun'] },
    { name: '(d) gh refuses the re-run', fail: ['rerunFailed', 'HTTP 403'], calls: ['viewRun', 'rerunFailed'] },
    { name: '(e) gh cannot show the run', fail: ['viewRun', 'HTTP 404'], calls: ['viewRun'] },
  ];
  for (const row of rows) {
    const s = await reworked({ rollup: row.rollup, run: row.run });
    try {
      if (row.fail) s.github.fail(...row.fail);
      await s.sync();
      assert.deepEqual(s.ghCalls().map((c) => c.op), row.calls, `${row.name}: gh calls`);
      assert.equal(s.job().reason, notRerun(row.checks ?? NAME), row.name);
      assert.deepEqual(at(s.job()), ['pr', 'waiting', 'pr-review'], row.name);
      assert.deepEqual(s.events('ci-rerun-failed').map((e) => e.cause), ['not-rerun'], row.name);
      assert.equal(s.events('ci-rerun').length, 0, row.name);
      assert.deepEqual(s.gates(), [], `${row.name}: no gate`);
      assert.equal(s.reworks().length, 1, `${row.name}: no rework`);
    } finally {
      s.cleanup();
    }
  }
});

test('at most five runs are re-run, each once', async () => {
  // 7 failing jobs across runs 101-106, run 101 listed twice.
  const order: [number, number][] = [[101, 201], [102, 202], [101, 207], [103, 203], [104, 204], [105, 205], [106, 206]];
  const rollup = order.map(([run, job], i) => check('FAILURE', job, run, { name: `job ${i}` }));
  const s = await reworked({ rollup });
  try {
    for (const run of [102, 103, 104, 105, 106]) s.github.setRun(String(run), { headSha: SHA, status: 'completed', conclusion: 'failure' });
    await s.sync();
    assert.deepEqual(s.github.calls.filter((c) => c.op === 'rerunFailed').map((c) => c.run), ['101', '102', '103', '104', '105']);
    assert.deepEqual(
      s.events('ci-rerun').map((e) => fields(e, ['runs', 'jobs'])),
      [{ runs: ['101', '102', '103', '104', '105'], jobs: ['201', '202', '207', '203', '204', '205'] }],
    );
  } finally {
    s.cleanup();
  }
});

test('the CI rework cap still applies and a re-run is not a rework', async () => {
  const s = await reworked({ config: foremanConfig((c) => (c.pr.maxCiReworks = 1)) });
  try {
    // Head A reached the cap with its own rework, and is still re-run.
    await s.sync();
    assert.equal(s.github.calls.filter((c) => c.op === 'rerunFailed').length, 1, 'a re-run on head A');
    assert.ok(!s.job().reason?.startsWith('CI rework cap:'), String(s.job().reason));
    // A new red head B is capped as before.
    s.rollup([check('FAILURE', 301, 201)], OTHER);
    await s.sync();
    assert.equal(s.job().reason, `CI rework cap: 1 CI reworks in a row, checks still failing on PR #7: ${NAME}. A human decides`);
    assert.deepEqual(
      s.events('ci-rework-capped').map((e) => fields(e, ['head', 'count', 'max'])),
      [{ head: OTHER, count: 1, max: 1 }],
    );
    assert.deepEqual(s.reworks().map((e) => e.ciHead), [SHA], 'no rework on head B');
    assert.deepEqual(s.gates(), []);
  } finally {
    s.cleanup();
  }

  // Without the daemon, a re-parked head with a CI rework is the gate's, never a re-run.
  const d = await reworked();
  try {
    await d.sync(foremanConfig((c) => (c.daemon.enabled = false)));
    assert.deepEqual(d.ghCalls(), []);
    assert.equal(d.events('ci-rerun').length, 0);
  } finally {
    d.cleanup();
  }
});
