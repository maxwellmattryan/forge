// POST /api/p/:project/jobs/:id/merge: the dashboard's half of the human channel for `forge pr merge
// --now`. It merges only with `now: true` and the job id typed back, as the dashboard, through the
// GitHub adapter the server is given (the in-memory one here, so nothing is spawned), and only behind
// the token, a matching Origin and JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ghPr, memoryGitHub, parkedAt, serveProjects, tempRepo } from '../../helpers.ts';
import { createJob, readEvents } from '#core/job/store.ts';
import { loadConfig } from '#core/config/load.ts';

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

test('POST /api/p/:project/jobs/:id/merge merges now as the dashboard, only with the id typed back', async () => {
  const repo = tempRepo();
  const other = tempRepo();
  const github = memoryGitHub();
  const s = await serveProjects([{ dir: other.dir, name: 'a' }, { dir: repo.dir, name: 'b' }], { github });
  const port = s.port;
  try {
    // PR #7 open with failing checks and no decision: only --now merges it.
    const id = parkedAt(repo.dir, 'pr-review', { title: 'merge me' }).id;
    github.put(ghPr({ statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] }));
    const noPr = createJob(repo.dir, loadConfig(repo.dir).config, { title: 'no pr yet' }).id;
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)![1];
    const headers = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (job: string, body: unknown, h: Record<string, string> = headers, prefix = s.api('b', '')) => hit(port, { method: 'POST', path: `${prefix}/jobs/${job}/merge`, headers: h, body: JSON.stringify(body) });
    const merges = () => github.calls.filter((c) => c.op === 'merge');

    const good = { now: true, confirm: id };
    const { origin: _o, ...noOrigin } = headers;
    assert.equal((await post(id, good, { ...headers, 'x-forge-token': 'wrong' })).status, 403);
    assert.equal((await post(id, good, noOrigin)).status, 403);
    assert.equal((await post(id, good, { ...headers, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(id, good, headers, '/api')).status, 404, 'the bare path is gone');
    assert.equal((await post(id, good, headers, s.api('a', ''))).status, 404, "another project's route never finds the job");
    assert.deepEqual(merges(), [], 'a refused request makes no merge call');

    for (const body of [{ confirm: id }, { now: true, confirm: 'other' }, { now: 'yes', confirm: id }, [true, id]]) {
      const r = await post(id, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(JSON.parse(r.text).error, /body must be \{"now": true, "confirm": "<the job id>"\}/);
    }
    assert.deepEqual(merges(), [], 'a refused body makes no merge call');

    assert.equal((await post('no-such-job', { now: true, confirm: 'no-such-job' })).status, 404);
    const none = await post(noPr, { now: true, confirm: noPr });
    assert.equal(none.status, 409);
    assert.match(JSON.parse(none.text).error, /has no PR/);

    const ok = await post(id, { now: true, confirm: id });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(JSON.parse(ok.text).action, 'merged');
    assert.deepEqual(
      merges().map((c) => [c.number, c.auto]),
      [[7, false]],
      'one plain merge call',
    );
    const events = readEvents(repo.dir, id);
    for (const type of ['pr-merge-bypass', 'pr-merged']) assert.equal(events.find((e) => e.type === type)?.actor?.source, 'dashboard', type);
  } finally {
    await s.cleanup();
    repo.cleanup();
    other.cleanup();
  }
});
