// A goal mandate's milestone draft over the dashboard API: GET renders it with its digest, POST decides it
// as the dashboard through the CLI's decideDraft, pinned to the request and digest the card read, and
// /api/state lists the draft while it waits. The POST's guards are security.test.ts's rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { initMilestoneRepo, readyGoal, repoTemplate, seedBacklog, serveProjects } from '../../helpers.ts';

const template = repoTemplate((dir) => {
  initMilestoneRepo(dir);
  seedBacklog(dir);
});

function hit(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

test('the milestone draft gate over the dashboard API', async () => {
  const repo = template();
  const s = await serveProjects([{ dir: repo.dir, name: 'p' }]);
  const port = s.port;
  try {
    const { request, digest } = await readyGoal(repo.dir, 'g1');
    const api = s.api('p', '');
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)![1];
    const headers = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body: unknown) => hit(port, { method: 'POST', path: `${api}/mandates/g1/draft`, headers, body: JSON.stringify(body) });
    const backlog = () => fs.readFileSync(path.join(repo.dir, '.forge', 'backlog.md'), 'utf8');
    const mandate = () => fs.readFileSync(path.join(repo.dir, '.forge', 'runtime', 'mandates', 'g1.md'), 'utf8');

    const got = await hit(port, { path: `${api}/mandates/g1/draft` });
    assert.equal(got.status, 200, got.text);
    assert.deepEqual([got.json.status, got.json.digest, got.json.request, got.json.goal], ['pending', digest, request, 'Halve review rounds']);
    assert.equal(got.json.draft.milestone.title, 'Fewer review rounds');
    assert.equal((await hit(port, { path: `${api}/mandates/..%2Fx/draft` })).status, 404);
    assert.equal((await hit(port, { path: `${api}/mandates/nope/draft` })).status, 404);

    const state = await hit(port, { path: `${api}/state` });
    assert.deepEqual(state.json.drafts.map((d: { mandate: string; digest: string; owner: string }) => [d.mandate, d.digest, d.owner]), [['g1', digest, 'human']]);

    const [b0, m0] = [backlog(), mandate()];
    const stale = await post({ decision: 'approve', request: '1-stale1', digest });
    assert.equal(stale.status, 409, stale.text);
    assert.match(stale.json.error, /the draft changed since you read it/);
    assert.equal((await post({ decision: 'approve', request, digest: 'd'.repeat(64) })).status, 409);
    const noNote = await post({ decision: 'revise', request, digest });
    assert.deepEqual([noNote.status, noNote.json.error], [409, 'revise needs a note: what the drafter should change']);
    for (const body of [{ decision: 'nope', request, digest }, { decision: 'approve', request }, { decision: 'approve', request, digest, extra: 1 }, [request]])
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    assert.deepEqual([backlog(), mandate()], [b0, m0], 'a refused decision writes nothing');

    const ok = await post({ decision: 'approve', request, digest });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.json.decision, typeof ok.json.filing.completedAt], ['approve', 'string']);
    const events = fs.readFileSync(path.join(repo.dir, '.forge', 'runtime', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events.find((e) => e.type === 'mandate-draft-approved')?.actor?.source, 'dashboard');
    assert.deepEqual((await hit(port, { path: `${api}/state` })).json.drafts, [], 'filed: off the list');
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});
