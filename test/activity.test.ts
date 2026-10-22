// `forge dash`'s activity log (lib/activity.ts) and the server's onRequest hook it reads requests from.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tempRepo, waitFor } from './helpers.ts';
import { attachActivityLog, formatActivity, jobEventLine, jobEventParts, requestLine, requestLogger, sessionTracker, tailJobEvents } from '../lib/cli/activity.ts';
import { distAllowlist, startServer } from '../lib/server/start.ts';
import { FIXTURE_DIST } from './dist.ts';

const AT = new Date(2026, 9, 19, 9, 5, 7);
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function state(over: Record<string, unknown> = {}) {
  return { scope: '_inbox', wanted: true, running: false, status: 'off', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, failures: 0, held: null, waiting: false, lastError: null, permissions: [], permissionMode: null, kept: null, effort: null, ...over } as any;
}

/** A fake pool: `subscribe(fn)` plus a way to emit. */
function fakePool() {
  const subs = new Set<(e: any) => void>();
  return {
    subscribe(fn: (e: any) => void) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    emit(e: any) {
      for (const fn of subs) fn(e);
    },
    subs,
  };
}

function get(port: number, p: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(opts.method === 'POST' ? '{"type":"sync"}' : undefined);
  });
}

describe('activity log', { concurrency: 4 }, () => {
  test('formats a line with a bracketed time, bare kind and text', () => {
    assert.equal(formatActivity('session', '_inbox spawned (pid 42)', { at: AT, color: false }), '[09:05:07] session _inbox spawned (pid 42)');
    assert.equal(formatActivity('http', 'GET /api/nope 404 3ms', { at: AT, color: false }), '[09:05:07] http GET /api/nope 404 3ms');
    assert.equal(formatActivity('job', '7-demo builder started', { at: AT, color: false }), '[09:05:07] job 7-demo builder started');
    const plain = formatActivity('session', '_inbox error: boom', { at: AT, color: false, error: true });
    assert.ok(!plain.includes('\x1b'));
    const painted = formatActivity('session', '_inbox error: boom', { at: AT, color: true, error: true });
    assert.ok(painted.includes('\x1b[1m'), 'the kind is bold');
    assert.ok(painted.includes('\x1b[31m'), 'error text is red');
    assert.ok(painted.startsWith('[09:05:07] '), 'the timestamp is never painted');
    assert.equal(strip(painted), plain);
    // requestLine renders the same shape.
    assert.equal(requestLine({ method: 'GET', path: '/api/nope', status: 404, ms: 3, sse: false }, { at: AT, color: false }), '[09:05:07] http GET /api/nope 404 3ms');
  });

  test('colours each subject, status and state, and strips back to the plain line', () => {
    const on: string[] = [];
    const off: string[] = [];
    const tracks = [sessionTracker((l) => on.push(l), { color: true, now: () => AT }), sessionTracker((l) => off.push(l), { color: false, now: () => AT })];
    const emit = (scope: string, over: Record<string, unknown>) => tracks.forEach((t) => t({ kind: 'state', scope, state: state({ scope, ...over }) }));
    for (const scope of ['_inbox', '_office', '31-alpha', '32-beta', 'constructor']) {
      emit(scope, {});
      emit(scope, { running: true, status: 'idle', pid: 9 });
    }
    emit('31-alpha', { running: true, status: 'idle', pid: 9, lastError: 'boom' });
    assert.deepEqual(on.map(strip), off);
    assert.ok(on[0].includes('\x1b[1;34m_inbox\x1b[0m'), on[0]);
    assert.ok(on[1].includes('\x1b[1;35m_office\x1b[0m'), on[1]);
    assert.ok(on[0].includes('\x1b[32mspawned\x1b[0m') && on[0].includes('\x1b[2m (pid 9)\x1b[0m'), on[0]);
    const hue = (l: string, subject: string) => new RegExp(`\\x1b\\[([0-9;]+)m${subject}\\x1b`).exec(l)?.[1];
    const alpha = hue(on[2], '31-alpha');
    assert.ok(alpha && !['1;34', '1;35'].includes(alpha), 'jobs never take the inbox or office colour');
    assert.notEqual(hue(on[3], '32-beta'), alpha, 'jobs seen in turn get different colours');
    assert.ok(hue(on[4], 'constructor'), 'an id that names an Object property still gets a colour');
    assert.ok(on[5].includes('\x1b[31merror: boom\x1b[0m'), on[5]);
    // A job's events take the colour its session lines have.
    const job = formatActivity('job', jobEventParts('31-alpha', { v: 1, ts: '', type: 'transition', from: { stage: 'build', state: 'running' } as any, to: { stage: 'verify', state: 'failed' } as any, reason: 'red' }), { at: AT, color: true });
    assert.equal(hue(job, '31-alpha'), alpha);
    assert.ok(job.includes('\x1b[31mverify/failed\x1b[0m') && job.includes('\x1b[2mbuild/running\x1b[0m'), job);
    assert.equal(strip(job), '[09:05:07] job 31-alpha build/running → verify/failed (red)');
    // Requests: the status by its class, a slow one's time in yellow.
    const req = (status: number, ms = 3) => requestLine({ method: 'GET', path: '/api/x', status, ms, sse: false }, { at: AT, color: true })!;
    assert.ok(req(200).includes('\x1b[32m200\x1b[0m') && req(200).includes('\x1b[2m 3ms\x1b[0m'), req(200));
    assert.ok(req(304).includes('\x1b[36m304\x1b[0m'), req(304));
    assert.ok(req(404).includes('\x1b[33m404\x1b[0m') && !req(404).includes('\x1b[31m'), req(404));
    assert.ok(req(500).includes('\x1b[31m /api/x \x1b[0m\x1b[31m500\x1b[0m'), req(500));
    assert.ok(req(200, 1500).includes('\x1b[33m 1500ms\x1b[0m'), req(200, 1500));
    assert.equal(strip(req(500)), '[09:05:07] http GET /api/x 500 3ms');
  });

  test('escapes control characters and caps long text', () => {
    const hostile = 'a\x1b]52;c;ZXZpbA==\x07b\rforged\nnext‮evil';
    const lines: string[] = [];
    const track = sessionTracker((l) => lines.push(l), { color: false, now: () => AT });
    track({ kind: 'line', scope: '_inbox', offset: 0, line: JSON.stringify({ type: 'forge-stderr', text: hostile }) });
    track({ kind: 'state', scope: '_inbox', state: state() });
    track({ kind: 'state', scope: '_inbox', state: state({ lastError: hostile }) });
    lines.push(jobEventLine('7-demo', { v: 1, ts: '', type: 'agent-end', role: 'builder', summary: hostile }));
    lines.push(jobEventLine('7-demo', { v: 1, ts: '', type: 'transition', from: { stage: 'build', state: 'running' } as any, to: { stage: 'verify', state: 'queued' } as any, reason: hostile }));
    const req = requestLine({ method: 'GET', path: `/x${hostile}`, status: 404, ms: 1, sse: false }, { at: AT, color: false })!;
    lines.push(req);
    const all = [...lines.slice(0, 2), formatActivity('job', lines[2], { at: AT, color: false }), formatActivity('job', lines[3], { at: AT, color: false }), req];
    assert.equal(all.length, 5);
    for (const l of all) {
      assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(l), `no raw controls: ${JSON.stringify(l)}`);
      assert.ok(!l.includes('\n'), 'no newline');
      assert.ok(!l.includes('‮'), 'no bidi override');
      assert.ok(l.includes('\\x1b') && l.includes('\\x0d') && l.includes('\\u202e'), `visible escapes: ${l}`);
    }
    const long = formatActivity('job', 'x'.repeat(5000), { at: AT, color: false });
    const text = long.slice('[09:05:07] job '.length);
    assert.equal(text.length, 300);
    assert.ok(text.endsWith('…'));
    // The cap applies before paint, so the closing codes survive.
    const red = formatActivity('session', 'y'.repeat(5000), { at: AT, color: true, error: true });
    assert.ok(red.endsWith('…\x1b[0m'));
    // The cap counts every part's text, and the cut part keeps its closing code.
    const parts = jobEventParts('7-demo', { v: 1, ts: '', type: 'agent-end', role: 'builder', summary: 'z'.repeat(5000) });
    const capped = formatActivity('job', parts, { at: AT, color: true });
    assert.ok(capped.endsWith('…\x1b[0m'), capped.slice(-20));
    assert.equal(strip(capped).slice('[09:05:07] job '.length).length, 300);
  });

  test('session events print only transitions', () => {
    const lines: string[] = [];
    const pool = fakePool();
    pool.subscribe(sessionTracker((l) => lines.push(l), { color: false, now: () => AT }));
    const s = (over: Record<string, unknown>) => pool.emit({ kind: 'state', scope: '_inbox', state: state(over) });
    s({}); // baseline, not running: nothing
    s({}); // repeat: nothing
    s({ running: true, status: 'idle', pid: 42 });
    s({ running: true, status: 'idle', pid: 42 }); // repeat: nothing
    s({ running: true, status: 'busy', pid: 42 });
    s({ running: true, status: 'idle', pid: 42 });
    s({ running: true, status: 'idle', pid: 42, held: 'budget' });
    s({ running: true, status: 'idle', pid: 42, held: 'budget' }); // still held: nothing
    s({ running: true, status: 'idle', pid: 42, held: 'budget', waiting: true });
    s({ running: true, status: 'idle', pid: 42, held: 'budget', waiting: true, lastError: 'boom' });
    s({ running: true, status: 'idle', pid: 42, held: 'budget', waiting: true, lastError: 'boom', permissions: [{}] });
    s({ running: true, status: 'idle', pid: 42, held: 'budget', waiting: true, lastError: 'boom', permissions: [{}] }); // nothing
    s({ running: false, status: 'off', pid: null });
    pool.emit({ kind: 'state', scope: '7-demo', state: state({ scope: '7-demo', running: true, status: 'busy', pid: null }) });
    assert.deepEqual(lines, [
      '[09:05:07] session _inbox spawned (pid 42)',
      '[09:05:07] session _inbox busy',
      '[09:05:07] session _inbox idle',
      '[09:05:07] session _inbox held (budget)',
      '[09:05:07] session _inbox waiting for a slot',
      '[09:05:07] session _inbox error: boom',
      '[09:05:07] session _inbox permission prompt waiting (1)',
      '[09:05:07] session _inbox ended',
      '[09:05:07] session 7-demo spawned',
    ]);
  });

  test('only forge-stderr lines are printed', () => {
    const lines: string[] = [];
    const track = sessionTracker((l) => lines.push(l), { color: false, now: () => AT });
    track({ kind: 'line', scope: '_inbox', offset: 0, line: JSON.stringify({ type: 'forge-stderr', at: 'x', text: 'oops' }) });
    track({ kind: 'line', scope: '_inbox', offset: 1, line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) });
    track({ kind: 'line', scope: '_inbox', offset: 2, line: JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'r' }] } }) });
    track({ kind: 'line', scope: '_inbox', offset: 3, line: 'not json at all' });
    track({ kind: 'line', scope: '_inbox', offset: 4, line: 'null' });
    assert.deepEqual(lines, ['[09:05:07] session _inbox stderr: oops']);
  });

  test('tails job events without replaying history', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-activity-')));
    const jobs = path.join(tmp, '.forge', 'jobs');
    const ev = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ts: new Date().toISOString(), ...o }) + '\n';
    try {
      fs.mkdirSync(path.join(jobs, '1-old'), { recursive: true });
      fs.writeFileSync(path.join(jobs, '1-old', 'events.jsonl'), ev({ type: 'created' }) + ev({ type: 'agent-start', role: 'builder' }));
      // A symlinked events.jsonl pointing elsewhere is never read.
      const outside = path.join(tmp, 'outside.jsonl');
      fs.writeFileSync(outside, '');
      fs.mkdirSync(path.join(jobs, '2-link'));
      fs.symlinkSync(outside, path.join(jobs, '2-link', 'events.jsonl'));
      const got: [string, any][] = [];
      const tail = tailJobEvents(tmp, { intervalMs: 20, onEvent: (id, e) => got.push([id, e]) });
      try {
        await new Promise((r) => setTimeout(r, 80));
        assert.deepEqual(got, [], 'history is never replayed');
        fs.appendFileSync(path.join(jobs, '1-old', 'events.jsonl'), ev({ type: 'transition', from: { stage: 'build', state: 'running' }, to: { stage: 'verify', state: 'queued' }, reason: 'built' }));
        fs.appendFileSync(path.join(jobs, '1-old', 'events.jsonl'), ev({ type: 'agent-end', role: 'builder', summary: 'done' }));
        fs.appendFileSync(outside, ev({ type: 'created' }));
        await waitFor(() => got.length >= 2, { what: 'two appended events' });
        assert.equal(got[0][0], '1-old');
        assert.equal(got[0][1].type, 'transition');
        assert.equal(jobEventLine(got[0][0], got[0][1]), '1-old build/running → verify/queued (built)');
        assert.equal(got[1][1].type, 'agent-end');
        assert.equal(jobEventLine(got[1][0], got[1][1]), '1-old builder ended: done');
        // A job created later is read from its first byte; a partial line waits for its newline.
        fs.mkdirSync(path.join(jobs, '3-new'));
        const line = ev({ type: 'agent-start', role: 'planner' });
        fs.writeFileSync(path.join(jobs, '3-new', 'events.jsonl'), ev({ type: 'created' }) + line.slice(0, 10));
        await waitFor(() => got.length >= 3, { what: 'the new job event' });
        assert.deepEqual([got[2][0], got[2][1].type], ['3-new', 'created']);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(got.length, 3, 'the partial line is held back');
        fs.appendFileSync(path.join(jobs, '3-new', 'events.jsonl'), line.slice(10));
        await waitFor(() => got.length >= 4, { what: 'the completed line' });
        assert.equal(jobEventLine(got[3][0], got[3][1]), '3-new planner started');
        // A rewritten (shrunk) file is read again from its new end, replaying nothing.
        fs.writeFileSync(path.join(jobs, '1-old', 'events.jsonl'), ev({ type: 'created' }));
        await new Promise((r) => setTimeout(r, 80));
        fs.appendFileSync(path.join(jobs, '1-old', 'events.jsonl'), 'not json\n' + ev({ type: 'merged' }));
        await waitFor(() => got.length >= 5, { what: 'the event after the rewrite' });
        assert.equal(jobEventLine(got[4][0], got[4][1]), '1-old merged');
        assert.ok(got.every(([id]) => id !== '2-link'), 'the symlink is skipped');
      } finally {
        tail.stop();
      }
      // stop() clears the timer: nothing more arrives.
      const n = got.length;
      fs.appendFileSync(path.join(jobs, '1-old', 'events.jsonl'), ev({ type: 'late' }));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(got.length, n);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('jobEventLine maps legacy shapes and other events', () => {
    assert.equal(jobEventLine('7-demo', { v: 1, ts: '', type: 'transition', from: 'build', to: 'verify' }), '7-demo build → verify');
    assert.equal(jobEventLine('7-demo', { v: 1, ts: '', type: 'agent-end', role: 'builder' }), '7-demo builder ended');
    assert.equal(jobEventLine('7-demo', { v: 1, ts: '', type: 'created' }), '7-demo created');
  });

  test('attachActivityLog seeds running sessions and detaches', () => {
    const lines: string[] = [];
    const pool = { ...fakePool(), state: () => ({ inbox: state({ running: true, status: 'idle', pid: 7 }), office: state({ scope: '_office' }), jobs: {} }) };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-activity-'));
    try {
      const detach = attachActivityLog(tmp, { pool } as any, { write: (l) => lines.push(l), color: false, now: () => AT });
      assert.deepEqual(lines, ['[09:05:07] session _inbox spawned (pid 7)']);
      assert.equal(pool.subs.size, 1);
      detach();
      assert.equal(pool.subs.size, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('server onRequest', () => {
  test('server onRequest hook reports requests and skips polls, assets and streams', async () => {
    const repo = tempRepo();
    const lines: string[] = [];
    const raw: any[] = [];
    const log = requestLogger((l) => lines.push(l), { color: false });
    const { server, url, close } = await startServer(repo.dir, { port: 0, distDir: FIXTURE_DIST, onRequest: (r) => (raw.push(r), log(r)) });
    const port = Number(new URL(url).port);
    try {
      assert.equal((await get(port, '/api/requests', { method: 'POST', headers: { 'content-type': 'application/json', origin: url } })).status, 403);
      assert.equal((await get(port, '/api/nope')).status, 404);
      assert.equal((await get(port, '/api/state')).status, 200);
      const asset = [...distAllowlist(FIXTURE_DIST).keys()][0];
      assert.ok(asset, 'the manifest lists an asset');
      assert.equal((await get(port, asset)).status, 200);
      assert.equal((await get(port, '/')).status, 200);
      // An event stream: open it, then drop it.
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/events?session=_inbox', headers: { host: `127.0.0.1:${port}` } }, (res) => {
          assert.equal(res.statusCode, 200);
          req.destroy();
          resolve();
        });
        req.on('error', () => {});
        req.on('timeout', reject);
        req.end();
      });
      await waitFor(() => raw.some((r) => r.path === '/api/events'), { what: 'the stream report' });
      assert.equal((await get(port, '/api/nope?token=secret')).status, 404);
      await waitFor(() => raw.length >= 7, { what: 'every request reported' });
      assert.equal(raw.find((r) => r.path === '/api/events').sse, true);
      const http4 = lines.filter((l) => / http /.test(l));
      assert.equal(lines.length, 3, lines.join('\n'));
      assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}\] http POST \/api\/requests 403 \d+ms$/);
      assert.match(lines[1], /^\[\d{2}:\d{2}:\d{2}\] http GET \/api\/nope 404 \d+ms$/);
      assert.match(lines[2], /^\[\d{2}:\d{2}:\d{2}\] http GET \/api\/nope 404 \d+ms$/);
      for (const l of http4) assert.ok(Number(/ (\d+)ms$/.exec(l)![1]) >= 0);
      assert.ok(!lines[2].includes('?') && !lines[2].includes('secret'), lines[2]);
      for (const r of raw) assert.ok(!r.path.includes('secret'));
    } finally {
      await close().catch(() => {});
      server.close();
      repo.cleanup();
    }
  });

  test('a throwing hook never breaks a response', async () => {
    const repo = tempRepo();
    let calls = 0;
    const { server, url, close } = await startServer(repo.dir, {
      port: 0,
      onRequest: () => {
        calls++;
        throw new Error('hook failed');
      },
    });
    const port = Number(new URL(url).port);
    try {
      for (let i = 0; i < 2; i++) {
        const r = await get(port, '/api/state');
        assert.equal(r.status, 200);
        assert.equal(typeof JSON.parse(r.body), 'object');
      }
      assert.equal((await get(port, '/api/nope')).status, 404);
      await waitFor(() => calls >= 3, { what: 'the hook to run' });
    } finally {
      await close().catch(() => {});
      server.close();
      repo.cleanup();
    }
  });
});
