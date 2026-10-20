// Hidden check for the eval task `api-job-events-after`: GET /api/jobs/<id>/events pages a job's
// events. Black-box: it runs `forge dash` in the foreground and talks to it over HTTP.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { BIN, json, scratch, waitFor } from './eval-check-harness.ts';

interface Reply {
  status: number;
  type: string;
  body: string;
}

function get(base: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), path, headers: { host: u.host, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function parse(r: Reply, what: string): any {
  try {
    return JSON.parse(r.body);
  } catch {
    throw new Error(`${what}: not JSON (status ${r.status}, ${r.type}): ${r.body.slice(0, 200)}`);
  }
}

describe('GET /api/jobs/<id>/events', { timeout: 60_000 }, () => {
  const s = scratch({ daemon: { enabled: false } });
  const notes = ['first note', 'second note', 'third note', 'fourth note', 'fifth note'];
  let dash: ChildProcess | null = null;
  let base = '';
  let id = '';

  before(async () => {
    const created = json(await s.forge(['job', 'new', '--title', 'Paging events', '--body', 'eval']));
    id = created.id;
    assert.ok(id, 'job new returned an id');
    for (const n of notes) {
      const r = await s.forge(['job', 'note', id, n]);
      assert.equal(r.status, 0, `job note: ${r.stderr}`);
    }
    // `--port 0` takes a free port; daemon.enabled is false, so no session starts.
    dash = spawn(process.execPath, [BIN, 'dash', '--foreground', '--port', '0'], { cwd: s.dir, env: { ...process.env, FORGE_ROOT: s.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    dash.stdout!.on('data', (d) => (out += d));
    dash.stderr!.on('data', (d) => (err += d));
    const proc = dash;
    base = await waitFor(() => {
      if (proc.exitCode !== null) throw new Error(`forge dash exited ${proc.exitCode}: ${err}`);
      return /(http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
    }, 15_000);
  });

  after(async () => {
    if (dash && dash.exitCode === null && dash.signalCode === null) {
      const p = dash;
      const gone = new Promise((r) => p.once('exit', r));
      p.kill('SIGTERM');
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    }
    s.cleanup();
  });

  test('returns every event in log order with next and total', async () => {
    const all = await get(base, `/api/jobs/${id}/events?limit=1000`);
    assert.equal(all.status, 200, `full list: ${all.body.slice(0, 200)}`);
    const full = parse(all, 'full list');
    assert.ok(Array.isArray(full.events), 'events is an array');
    const total: number = full.total;
    assert.equal(total, full.events.length, 'total counts every event');
    assert.equal(full.next, total, 'a page that reaches the end has next = total');
    const noteTexts = full.events.filter((e: any) => e.type === 'note').map((e: any) => e.text);
    assert.deepEqual(noteTexts, notes, 'notes in log order');
    assert.ok(total >= notes.length + 1, 'the created event is counted too');
    for (const e of full.events) assert.equal(typeof e.type, 'string');
    // The defaults: after = 0, a limit large enough for this handful of events.
    assert.deepEqual(parse(await get(base, `/api/jobs/${id}/events`), 'defaults'), full, 'no after or limit is the whole short log');
  });

  test('two pages join to the full list', async () => {
    const full = parse(await get(base, `/api/jobs/${id}/events?limit=1000`), 'full list');
    const total: number = full.total;
    const split = 3;
    const p1r = await get(base, `/api/jobs/${id}/events?limit=${split}`);
    assert.equal(p1r.status, 200);
    const p1 = parse(p1r, 'page 1');
    assert.equal(p1.events.length, split);
    assert.equal(p1.next, split);
    assert.equal(p1.total, total);
    const p2 = parse(await get(base, `/api/jobs/${id}/events?after=${p1.next}&limit=1000`), 'page 2');
    assert.equal(p2.events.length, total - split);
    assert.equal(p2.next, total);
    assert.equal(p2.total, total);
    assert.deepEqual([...p1.events, ...p2.events], full.events, 'two pages join to the full list');

    const mid = parse(await get(base, `/api/jobs/${id}/events?after=2&limit=2`), 'middle page');
    assert.deepEqual(mid.events, full.events.slice(2, 4));
    assert.equal(mid.next, 4);
    assert.equal(mid.total, total);

    const past = await get(base, `/api/jobs/${id}/events?after=${total + 50}`);
    assert.equal(past.status, 200);
    const pastBody = parse(past, 'past the end');
    assert.deepEqual(pastBody.events, []);
    assert.equal(pastBody.next, total, 'next never passes total');
    assert.equal(pastBody.total, total);

    const over = await get(base, `/api/jobs/${id}/events?limit=100000`);
    assert.equal(over.status, 200, 'a limit over the maximum is capped, not refused');
    assert.deepEqual(parse(over, 'over limit').events, full.events);
  });

  test('an unknown job is a 404 with an error', async () => {
    const missing = await get(base, '/api/jobs/no-such-job-here/events');
    assert.equal(missing.status, 404);
    const m = parse(missing, 'unknown job');
    assert.equal(typeof m.error, 'string', '404 has the {error} shape');
    assert.ok(m.error.length > 0);
  });

  test('a negative, fractional, empty or non-numeric after or limit is a 400 with an error', async () => {
    for (const q of ['after=-1', 'after=1.5', 'after=abc', 'after=', 'limit=-3', 'limit=2.5', 'limit=ten', 'limit=0']) {
      const r = await get(base, `/api/jobs/${id}/events?${q}`);
      assert.equal(r.status, 400, `${q} is refused`);
      assert.equal(typeof parse(r, q).error, 'string', `${q} has the {error} shape`);
    }
  });

  test('follows the read rules: loopback Host only, no foreign Origin', async () => {
    assert.equal((await get(base, `/api/jobs/${id}/events`)).status, 200, 'no token needed');
    assert.equal((await get(base, `/api/jobs/${id}/events`, { host: 'evil.example' })).status, 421);
    assert.equal((await get(base, `/api/jobs/${id}/events`, { origin: 'http://evil.example' })).status, 403);
  });
});
