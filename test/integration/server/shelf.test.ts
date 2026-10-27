// POST /api/p/:project/shelf, the Shelved list's batch actions: the dashboard's half of the human channel
// for `forge job unshelve`. It acts only on entries still shelved at the time the list showed, only for
// the parks a batch may decide, and its events carry the dashboard's actor. And POST /requests refuses
// what would restart a shelved job. The guards it shares with every POST are in security.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parkedAt, serveProjects, tempRepo } from '../../helpers.ts';
import { jobDir, loadJob, readEvents } from '#core/job/store.ts';
import { listRequests } from '#core/job/requests.ts';
import { loadConfig } from '#core/config/load.ts';
import { shelveJob } from '#engine/pipeline/moves/shelve.ts';
import type { WaitingOn } from '#core/types.ts';

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

/** A served scratch repo, a POST helper with the server's token, and a job shelved from `gate`. */
async function served() {
  const repo = tempRepo();
  const s = await serveProjects([{ dir: repo.dir, name: 'a' }]);
  const headers = { 'x-forge-token': s.token, origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' };
  const post = async (p: string, body: unknown) => {
    const r = await hit(s.port, { method: 'POST', path: s.api('a', p), headers, body: JSON.stringify(body) });
    return { status: r.status, body: JSON.parse(r.text) };
  };
  const shelved = async (gate: WaitingOn) => {
    const id = parkedAt(repo.dir, gate, { reason: `waits on ${gate}` }).id;
    const r = await shelveJob(repo.dir, loadConfig(repo.dir).config, id, { reason: 'later', actor: { login: 'al', source: 'env' } });
    return { id, shelvedAt: r.shelved.at };
  };
  const cleanup = async () => {
    await s.cleanup();
    repo.cleanup();
  };
  return { root: repo.dir, post, shelved, cleanup };
}

const files = (root: string, id: string) => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(jobDir(root, id), f), 'utf8'));
const unshelved = (root: string, id: string) => readEvents(root, id).filter((e) => e.type === 'unshelved');

test('the shelf route acts on exactly the jobs the list showed', async () => {
  const t = await served();
  try {
    const esc = await t.shelved('escalation');
    const budget = await t.shelved('budget');
    const stale = await t.shelved('rounds-exhausted');
    const closing = await t.shelved('pr-review');

    const before = [esc, budget, stale, closing].map((e) => files(t.root, e.id));
    const shape = /^body must be \{"action": "approve"\|"rework"\|"unshelve"\|"close"/;
    const many = Array.from({ length: 51 }, () => esc);
    for (const body of [
      [esc],
      { action: 'merge', jobs: [esc] },
      { action: 'approve', jobs: [] },
      { action: 'approve', jobs: many },
      { action: 'approve', jobs: [{ id: esc.id }] },
      { action: 'approve', jobs: [{ ...esc, extra: 1 }] },
      { action: 'approve', jobs: [{ id: '../x', shelvedAt: esc.shelvedAt }] },
      { action: 'approve', jobs: [esc], note: 3 },
      { action: 'approve', jobs: [esc], note: 'x'.repeat(2001) },
      { action: 'approve', jobs: [esc], force: true },
    ]) {
      const r = await t.post('/shelf', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 200));
      assert.match(r.body.error, shape);
    }
    const noNote = await t.post('/shelf', { action: 'rework', jobs: [esc], note: '  ' });
    assert.deepEqual([noNote.status, noNote.body.error], [400, 'rework needs a note']);
    assert.deepEqual([esc, budget, stale, closing].map((e) => files(t.root, e.id)), before, 'a refused body writes nothing');
    assert.deepEqual(listRequests(t.root), []);

    const approve = await t.post('/shelf', { action: 'approve', note: 'ship it', jobs: [esc, budget, { id: stale.id, shelvedAt: '2020-01-01T00:00:00.000Z' }, { id: 'no-such-job', shelvedAt: esc.shelvedAt }] });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.deepEqual(approve.body.results, [
      { id: esc.id, outcome: 'approved' },
      { id: budget.id, outcome: 'skipped', reason: "waits on budget, where a batch approve doesn't apply; un-shelve it and decide it at its gate" },
      { id: stale.id, outcome: 'skipped', reason: 'shelved again since the list loaded' },
      { id: 'no-such-job', outcome: 'skipped', reason: 'no such job' },
    ]);
    const j = loadJob(t.root, esc.id);
    assert.deepEqual([j.stage, j.state, j.waitingOn, j.shelved], ['decide', 'waiting', 'escalation', null]);
    assert.deepEqual(
      listRequests(t.root).map((r) => [r.type, r.job, r.text, r.from]),
      [['approve', esc.id, 'ship it', 'dashboard']],
      'one approve request, as the gate card sends',
    );
    assert.deepEqual(unshelved(t.root, esc.id).map((e) => [e.channel, e.actor?.source]), [['dashboard', 'dashboard']]);
    for (const e of [budget, stale]) assert.equal(loadJob(t.root, e.id).waitingOn, 'shelved', `${e.id} stays shelved`);

    // The same click again: the job is no longer on the shelf.
    assert.deepEqual((await t.post('/shelf', { action: 'approve', jobs: [esc] })).body.results, [{ id: esc.id, outcome: 'skipped', reason: 'not shelved' }]);

    const close = await t.post('/shelf', { action: 'close', jobs: [closing] });
    assert.deepEqual(close.body.results, [{ id: closing.id, outcome: 'closed' }]);
    const c = loadJob(t.root, closing.id);
    assert.deepEqual([c.state, c.reason, c.shelved], ['cancelled', 'closed from the shelf', null]);
    assert.deepEqual(unshelved(t.root, closing.id).map((e) => [e.to, e.actor?.source]), [[{ state: 'cancelled', waitingOn: null }, 'dashboard']]);
    assert.equal(listRequests(t.root).length, 1, 'close queues nothing');

    const un = await t.post('/shelf', { action: 'unshelve', jobs: [budget] });
    assert.deepEqual(un.body.results, [{ id: budget.id, outcome: 'unshelved' }]);
    assert.deepEqual([loadJob(t.root, budget.id).waitingOn, listRequests(t.root).length], ['budget', 1], 'un-shelve queues nothing');
  } finally {
    await t.cleanup();
  }
});

test('requests that would restart a shelved job are refused', async () => {
  const t = await served();
  try {
    const { id } = await t.shelved('escalation');
    for (const type of ['resume', 'approve', 'rework', 'revise-spec', 'answer']) {
      const r = await t.post('/requests', { type, job: id, text: 'go' });
      assert.equal(r.status, 409, type);
      assert.equal(r.body.error, `job ${id} is shelved; un-shelve it first (the Shelved list in Needs you, or forge job unshelve ${id} in your own terminal)`);
    }
    assert.deepEqual(listRequests(t.root), [], 'nothing queued');
    const cancel = await t.post('/requests', { type: 'cancel', job: id });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.deepEqual(listRequests(t.root).map((r) => [r.type, r.job]), [['cancel', id]]);
  } finally {
    await t.cleanup();
  }
});
