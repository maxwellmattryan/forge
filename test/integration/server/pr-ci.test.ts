// POST /api/p/:project/jobs/:id/ci: the Needs you PR row's Re-run failed checks and Fix CI. Only an exact
// {action, head} body, only behind the login, a matching Origin and JSON, through the GitHub adapter the
// server is given (the in-memory one here, so nothing is spawned), and as the dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ghPr, memoryGitHub, parkedAt, serveProjects, tempRepo } from '../../helpers.ts';
import { loadJob, readEvents, setJob } from '#core/job/store.ts';

function hit(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

const SHA = 'b'.repeat(40);
const SHAPE = /body must be \{"action": "rerun"\|"fix-ci", "head": "<the PR head sha>"\}/;

test('POST /api/p/:project/jobs/:id/ci re-runs or fixes CI as the dashboard, only at the head the row showed', async () => {
  const repo = tempRepo();
  const other = tempRepo();
  const github = memoryGitHub();
  const s = await serveProjects([{ dir: other.dir, name: 'a' }, { dir: repo.dir, name: 'b' }], { github });
  const port = s.port;
  try {
    // PR #7 red at SHA, as the last sync recorded it: one failing GitHub Actions job of run 101, on SHA and finished.
    const id = parkedAt(repo.dir, 'pr-review', { title: 'red PR' }).id;
    const pr = loadJob(repo.dir, id).pr!;
    setJob(repo.dir, id, { owned: { pr: { ...pr, headOid: SHA, checks: { state: 'failing', passing: 0, failing: 1, pending: 0 }, failingChecks: { names: ['test'], more: 0, actions: 1 } } } });
    github.put(ghPr({ headRefOid: SHA, statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/101/job/201' }] }));
    github.setRun('101', { headSha: SHA, status: 'completed', conclusion: 'failure' });
    const headers = { 'x-forge-token': s.token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (job: string, body: unknown, h: Record<string, string> = headers, prefix = s.api('b', '')) => hit(port, { method: 'POST', path: `${prefix}/jobs/${job}/ci`, headers: h, body: JSON.stringify(body) });
    const reruns = () => github.calls.filter((c) => c.op === 'rerunFailed');

    const good = { action: 'rerun', head: SHA };
    const { origin: _o, ...noOrigin } = headers;
    assert.equal((await post(id, good, { ...headers, 'x-forge-token': 'wrong' })).status, 401);
    assert.equal((await post(id, good, noOrigin)).status, 403);
    assert.equal((await post(id, good, { ...headers, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(id, good, headers, s.api('a', ''))).status, 404, "another project's route never finds the job");

    for (const body of [{ ...good, extra: 1 }, { action: 'retry', head: SHA }, { action: 'rerun', head: SHA.slice(0, 12) }, { action: 'fix-ci', head: SHA.toUpperCase() }, { action: 'rerun' }, ['rerun', SHA]]) {
      const r = await post(id, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(JSON.parse(r.text).error, SHAPE);
    }
    assert.equal((await post('no-such-job', good)).status, 404);
    const stale = await post(id, { action: 'rerun', head: 'c'.repeat(40) });
    assert.equal(stale.status, 409);
    assert.match(JSON.parse(stale.text).error, /^PR #7 head is bbbbbbbbbbbb now, not cccccccccccc; nothing re-run$/);
    assert.deepEqual(reruns(), [], 'a refused request re-runs nothing');

    const rerun = await post(id, good);
    assert.equal(rerun.status, 200, rerun.text);
    assert.deepEqual(JSON.parse(rerun.text), { action: 'rerun', id, head: SHA, runs: ['101'], jobs: ['201'], checks: ['test'] });
    assert.deepEqual(reruns().map((c) => [c.slug, c.run]), [['o/r', '101']]);
    assert.equal(readEvents(repo.dir, id).find((e) => e.type === 'ci-rerun')?.actor?.source, 'dashboard');
    assert.deepEqual([loadJob(repo.dir, id).stage, loadJob(repo.dir, id).waitingOn], ['pr', 'pr-review'], 'a re-run moves nothing');

    const fix = await post(id, { action: 'fix-ci', head: SHA });
    assert.equal(fix.status, 200, fix.text);
    assert.deepEqual(JSON.parse(fix.text), { action: 'fix-ci', id, head: SHA, checks: ['test'] });
    const rework = readEvents(repo.dir, id).find((e) => e.type === 'human' && e.action === 'rework');
    assert.deepEqual([rework?.actor?.source, rework?.note], ['dashboard', 'fix the failing checks on PR #7 at bbbbbbbbbbbb: test']);
    assert.deepEqual([loadJob(repo.dir, id).stage, loadJob(repo.dir, id).state], ['build', 'running']);
    const again = await post(id, { action: 'fix-ci', head: SHA });
    assert.equal(again.status, 409, 'the job left pr-review');
  } finally {
    await s.cleanup();
    repo.cleanup();
    other.cleanup();
  }
});
