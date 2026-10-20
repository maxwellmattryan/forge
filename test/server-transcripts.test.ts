import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tempRepo, waitFor } from './helpers.ts';
import { startServer } from '../lib/server.ts';
import { FIXTURE_DIST } from './dist.ts';
import { defaults } from '../lib/config.ts';
import { sessionFiles } from '../lib/daemon.ts';
import { attachAgent, claimJob, createJob, recordAgent, updateJob } from '../lib/jobs.ts';
import { projectSlug } from '../lib/transcripts.ts';

const OWNER = '11111111-2222-4333-8444-555555555555';
/** A query string built at run time. */
const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();
const XSS_TEXT = '<script>alert(1)</script> <img src=x onerror=alert(1)>';

const assistant = (content: unknown[], timestamp = '2026-10-15T10:00:00.000Z') => JSON.stringify({ type: 'assistant', timestamp, message: { content } });

function hit(port: number, o: { path: string; headers?: Record<string, string> }): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Stream {
  status: number;
  headers: http.IncomingHttpHeaders;
  frames: Record<string, string>[];
  ended: boolean;
  close: () => void;
}

function sse(port: number, p: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let raw = '';
      const client: Stream = { status: res.statusCode!, headers: res.headers, frames: [], ended: false, close: () => req.destroy() };
      res.setEncoding('utf8');
      res.on('data', (d) => {
        raw += d;
        let i;
        while ((i = raw.indexOf('\n\n')) !== -1) {
          const block = raw.slice(0, i);
          raw = raw.slice(i + 2);
          const f: Record<string, string> = {};
          for (const l of block.split('\n')) {
            const m = /^([a-z]*): ?(.*)$/.exec(l);
            if (m) f[m[1] || 'comment'] = m[2];
          }
          client.frames.push(f);
        }
      });
      res.on('end', () => (client.ended = true));
      res.on('close', () => (client.ended = true));
      res.on('error', () => {});
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * A repo with one job owned by an interactive session, a running reviewer:security (opus) whose
 * transcript ends in a Read, a builder that ended this round, and a server reading a scratch
 * projects dir.
 */
async function setup(opts: { sseMaxAgeMs?: number; agentTail?: string } = {}) {
  const repo = tempRepo();
  const root = repo.dir;
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projects-'));
  const slugDir = path.join(projects, projectSlug(root));
  const config = defaults();
  const job = createJob(root, config, { title: 'Activity' });
  const idle = createJob(root, config, { title: 'Idle' });
  claimJob(root, job.id, OWNER);
  recordAgent(root, job.id, { role: 'builder', phase: 'start', model: 'sonnet' }, config);
  recordAgent(root, job.id, { role: 'builder', phase: 'end', usage: { totalTokens: 1234, toolUses: 3, durationMs: 1000 } }, config);
  // Backdated, so the builder's start can't share a millisecond with the reviewer's and tie the newest-first order.
  updateJob(root, job.id, (j) => {
    j.agents.builder.startedAt = new Date(Date.now() - 60_000).toISOString();
    j.agents.builder.endedAt = new Date(Date.now() - 30_000).toISOString();
  });
  recordAgent(root, job.id, { role: 'reviewer:security', phase: 'start', model: 'opus' }, config);
  attachAgent(root, job.id, 'reviewer:security', 'abc123');
  const agentFile = path.join(slugDir, OWNER, 'subagents', 'agent-abc123.jsonl');
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  const read = assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(root, 'lib', 'server.ts') } }]);
  fs.writeFileSync(agentFile, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Review the diff' } })}\n${opts.agentTail ?? read}\n`);
  const ownerFile = path.join(slugDir, `${OWNER}.jsonl`);
  fs.writeFileSync(ownerFile, `${assistant([{ type: 'text', text: 'Driving the job' }])}\n`);
  const srv = await startServer(root, { port: 0, distDir: FIXTURE_DIST, projectsDir: projects, sseMaxAgeMs: opts.sseMaxAgeMs });
  const port = Number(new URL(srv.url).port);
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)?.[1] ?? '';
  const auth = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}` };
  return {
    root,
    projects,
    slugDir,
    job,
    idle,
    agentFile,
    ownerFile,
    port,
    token,
    auth,
    get: (p: string, headers: Record<string, string> = auth) => hit(port, { path: p, headers }),
    cleanup: async () => {
      await srv.close();
      repo.cleanup();
      fs.rmSync(projects, { recursive: true, force: true });
    },
  };
}

describe('transcript routes', { concurrency: 4 }, () => {
  test('state reports running agent activity', async () => {
    const s = await setup();
    try {
      const st = JSON.parse((await s.get('/api/state')).text);
      const j = st.jobs.find((x: any) => x.id === s.job.id);
      assert.equal(j.activity.length, 1);
      const [a] = j.activity;
      assert.equal(a.role, 'reviewer:security');
      assert.equal(a.model, 'opus');
      assert.ok(Date.parse(a.startedAt));
      assert.deepEqual(a.last, { kind: 'tool', text: 'Read lib/server.ts', at: '2026-10-15T10:00:00.000Z' });
      assert.deepEqual(st.jobs.find((x: any) => x.id === s.idle.id).activity, []);
      // A running agent with no transcript still has its line, with no last activity.
      recordAgent(s.root, s.job.id, { role: 'reviewer:code', phase: 'start', model: 'sonnet' }, defaults());
      const again = JSON.parse((await s.get('/api/state')).text).jobs.find((x: any) => x.id === s.job.id);
      assert.deepEqual(again.activity.map((x: any) => [x.role, x.last === null]).sort(), [['reviewer:code', true], ['reviewer:security', false]]);
    } finally {
      await s.cleanup();
    }
  });

  test('job detail lists round agents and the interactive owner', async () => {
    const s = await setup();
    try {
      updateJob(s.root, s.job.id, (j) => {
        j.agents.planner = { runs: 1, status: 'done', model: 'opus', round: j.round - 1, startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:01:00.000Z' };
      });
      const d = JSON.parse((await s.get(`/api/jobs/${s.job.id}`)).text);
      assert.deepEqual(d.agents.map((a: any) => a.role), ['reviewer:security', 'builder'], 'newest first, older rounds left out');
      const [rev, builder] = d.agents;
      assert.deepEqual({ status: rev.status, model: rev.model, durationMs: rev.durationMs, tokens: rev.tokens, transcript: rev.transcript, endedAt: rev.endedAt }, { status: 'running', model: 'opus', durationMs: null, tokens: null, transcript: true, endedAt: null });
      assert.equal(builder.status, 'done');
      assert.equal(builder.tokens, 1234);
      assert.equal(builder.durationMs, Date.parse(builder.endedAt) - Date.parse(builder.startedAt));
      assert.equal(builder.transcript, false);
      assert.deepEqual(d.ownerTranscript, { session: OWNER });

      // The same owner recorded as a daemon session (here a past id) is not interactive.
      const rec = sessionFiles(s.root, s.job.id).info;
      fs.mkdirSync(path.dirname(rec), { recursive: true });
      fs.writeFileSync(rec, JSON.stringify({ sessionId: '99999999-2222-4333-8444-555555555555', pastSessionIds: [OWNER] }));
      assert.equal(JSON.parse((await s.get(`/api/jobs/${s.job.id}`)).text).ownerTranscript, null);
      assert.equal((await s.get(`/api/jobs/${s.job.id}/transcript`)).status, 404, 'the owner route refuses a daemon session');
      // No owner transcript on disk: null as well.
      fs.rmSync(rec);
      fs.rmSync(s.ownerFile);
      assert.equal(JSON.parse((await s.get(`/api/jobs/${s.job.id}`)).text).ownerTranscript, null);
    } finally {
      await s.cleanup();
    }
  });

  test('transcript page reads backwards', async () => {
    const s = await setup();
    try {
      const lines = Array.from({ length: 1500 }, (_, i) => assistant([{ type: 'text', text: `line ${i}` }]));
      fs.writeFileSync(s.agentFile, lines.join('\n') + '\n');
      const first = await s.get(`/api/jobs/${s.job.id}/transcript?agent=${encodeURIComponent('reviewer:security')}`);
      assert.equal(first.status, 200);
      assert.match(String(first.headers['content-type']), /^application\/json/);
      const p1 = JSON.parse(first.text);
      assert.equal(p1.job, s.job.id);
      assert.equal(p1.source, 'agent');
      assert.equal(p1.role, 'reviewer:security');
      assert.equal(p1.lines.length, 1000);
      assert.equal(p1.more, true);
      assert.equal(p1.lines.at(-1).line, lines.at(-1));
      assert.equal(p1.lines[0].offset, p1.start);
      const raw = fs.readFileSync(s.agentFile);
      assert.equal(raw.subarray(p1.lines[0].offset, p1.lines[0].offset + Buffer.byteLength(lines[500])).toString(), p1.lines[0].line, 'offsets are byte positions');
      const p2 = JSON.parse((await s.get(`/api/jobs/${s.job.id}/transcript?agent=reviewer%3Asecurity&before=${p1.start}`)).text);
      assert.equal(p2.lines.length, 500);
      assert.equal(p2.more, false);
      assert.equal(p2.lines[0].line, lines[0]);
      assert.equal(p2.end, p1.start);
      assert.equal((await s.get(`/api/jobs/${s.job.id}/transcript?agent=reviewer%3Asecurity&before=-1`)).status, 400);

      const owner = JSON.parse((await s.get(`/api/jobs/${s.job.id}/transcript`)).text);
      assert.equal(owner.source, 'owner');
      assert.equal(owner.role, null);
      assert.equal(owner.lines.length, 1);
    } finally {
      await s.cleanup();
    }
  });

  test('transcript routes reject forged paths and foreign callers', async () => {
    const s = await setup();
    try {
      const page = `/api/jobs/${s.job.id}/transcript?agent=reviewer%3Asecurity`;
      assert.equal((await s.get(page)).status, 200);
      const { 'x-forge-token': _t, ...noToken } = s.auth;
      assert.equal((await s.get(page, noToken)).status, 403, 'no token');
      assert.equal((await s.get(page, { ...s.auth, 'x-forge-token': 'wrong' })).status, 403, 'wrong token');
      assert.equal((await s.get(page, { ...s.auth, origin: 'http://evil.example' })).status, 403, 'foreign origin');
      assert.equal((await s.get(page, { ...s.auth, 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site');
      const ev = (q: string) => `/api/jobs/${s.job.id}/transcript/events?${q}&${qs({ token: s.token })}`;
      for (const [hdrs, why] of [[{ origin: 'http://evil.example' }, 'origin'], [{ 'sec-fetch-site': 'cross-site' }, 'fetch metadata']] as const) {
        const r = await sse(s.port, ev('agent=reviewer%3Asecurity'), hdrs as Record<string, string>);
        assert.equal(r.status, 403, why);
        r.close();
      }

      // Forged targets: each is a 404 on both routes.
      updateJob(s.root, s.job.id, (j) => {
        j.agents.evil = { runs: 1, status: 'running', agentId: '../evil', startedAt: new Date().toISOString() };
        j.agents.linked = { runs: 1, status: 'running', agentId: 'link1', startedAt: new Date().toISOString() };
      });
      const outside = path.join(s.projects, '..', `forge-outside-${process.pid}-${s.port}.jsonl`);
      fs.writeFileSync(outside, `${assistant([{ type: 'text', text: 'secret' }])}\n`);
      fs.symlinkSync(outside, path.join(s.slugDir, OWNER, 'subagents', 'agent-link1.jsonl'));
      try {
        const forged = ['agent=__proto__', 'agent=constructor', 'agent=..%2F..%2Fx', 'agent=reviewer%3Anone', 'agent=evil', 'agent=linked', 'agent='];
        for (const q of forged) {
          assert.equal((await s.get(`/api/jobs/${s.job.id}/transcript?${q}`)).status, 404, q);
          const r = await sse(s.port, ev(q));
          assert.equal(r.status, 404, `events ${q}`);
          r.close();
        }
        assert.equal((await s.get(`/api/jobs/no-such-job/transcript?agent=reviewer%3Asecurity`)).status, 404, 'unknown job');
        assert.equal((await s.get(`/api/jobs/..%2F..%2Fetc/transcript`)).status, 404, 'a job id with traversal');
        // The owner route for a daemon session.
        const rec = sessionFiles(s.root, s.job.id).info;
        fs.mkdirSync(path.dirname(rec), { recursive: true });
        fs.writeFileSync(rec, JSON.stringify({ sessionId: OWNER }));
        assert.equal((await s.get(`/api/jobs/${s.job.id}/transcript`)).status, 404, 'daemon owner');
        const r = await sse(s.port, `/api/jobs/${s.job.id}/transcript/events?${qs({ token: s.token })}`);
        assert.equal(r.status, 404, 'daemon owner stream');
        r.close();
      } finally {
        fs.rmSync(outside, { force: true });
      }
    } finally {
      await s.cleanup();
    }
  });

  test('transcript stream tails appended lines', async () => {
    const s = await setup();
    const open: Stream[] = [];
    try {
      const url = `/api/jobs/${s.job.id}/transcript/events?agent=reviewer%3Asecurity&${qs({ token: s.token })}`;
      const a = await sse(s.port, url);
      open.push(a);
      assert.equal(a.status, 200);
      assert.equal(a.headers['content-type'], 'text/event-stream; charset=utf-8');
      await waitFor(() => a.frames.filter((f) => f.event === 'line').length === 2, { what: 'the initial lines' });
      const size = fs.statSync(s.agentFile).size;
      const added = assistant([{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'token' } }]);
      fs.appendFileSync(s.agentFile, added + '\n');
      const got = await waitFor(() => a.frames.find((f) => f.event === 'line' && f.data === added), { timeoutMs: 4000, what: 'the appended line' });
      assert.equal(Number(got.id), size, 'the id is the byte offset');
      // A half-written line waits for its newline.
      fs.appendFileSync(s.agentFile, '{"type":"assistant","partial":');
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(a.frames.filter((f) => f.event === 'line').length, 3);
      fs.appendFileSync(s.agentFile, 'true}\n');
      await waitFor(() => a.frames.filter((f) => f.event === 'line').length === 4, { timeoutMs: 4000, what: 'the completed line' });
      assert.ok(a.frames.every((f) => f.event !== 'state'), 'no pool state frames');

      // Last-Event-ID resumes after that line.
      const b = await sse(s.port, url, { 'last-event-id': String(size) });
      open.push(b);
      await waitFor(() => b.frames.filter((f) => f.event === 'line').length === 1, { what: 'the resumed line' });
      assert.equal(b.frames.find((f) => f.event === 'line')!.data, '{"type":"assistant","partial":true}');

      // The streams count toward the SSE cap.
      while (open.length < 8) open.push(await sse(s.port, url));
      const full = await sse(s.port, url);
      assert.equal(full.status, 503);
      full.close();
      for (const c of open) c.close();
      open.length = 0;
      await waitFor(async () => JSON.parse((await s.get('/api/state')).text).daemons.clients === 0, { what: 'closed streams to leave the count' });
    } finally {
      for (const c of open) c.close();
      await s.cleanup();
    }
  });

  test('transcript stream is recycled', async () => {
    const s = await setup({ sseMaxAgeMs: 200 });
    try {
      const a = await sse(s.port, `/api/jobs/${s.job.id}/transcript/events?agent=reviewer%3Asecurity&${qs({ token: s.token })}`);
      assert.equal(a.status, 200);
      await waitFor(() => a.ended, { what: 'the stream to be recycled' });
    } finally {
      await s.cleanup();
    }
  });

  test('transcript stream needs the token', async () => {
    const s = await setup();
    try {
      const base = `/api/jobs/${s.job.id}/transcript/events?agent=reviewer%3Asecurity`;
      for (const q of ['', '&token=', '&token=wrong', `&${qs({ token: s.token + 'x' })}`, `&${qs({ token: s.token.slice(1) })}`]) {
        const r = await sse(s.port, base + q);
        assert.equal(r.status, 403, q || 'missing');
        r.close();
      }
      // The header alone doesn't open the stream: EventSource can't send it, so the query is the contract.
      const h = await sse(s.port, base, { 'x-forge-token': s.token });
      assert.equal(h.status, 403);
      h.close();
    } finally {
      await s.cleanup();
    }
  });

  test('transcript text is data, not markup', async () => {
    const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: XSS_TEXT }] } });
    const s = await setup({ agentTail: `${result}\n${assistant([{ type: 'text', text: XSS_TEXT }])}` });
    try {
      const r = await s.get(`/api/jobs/${s.job.id}/transcript?agent=reviewer%3Asecurity`);
      assert.match(String(r.headers['content-type']), /^application\/json/);
      const page = JSON.parse(r.text);
      assert.ok(page.lines.some((l: any) => l.line === result), 'the tool result line is returned verbatim');
      assert.ok(page.lines.some((l: any) => JSON.parse(l.line).message?.content?.[0]?.text === XSS_TEXT));
      const a = await sse(s.port, `/api/jobs/${s.job.id}/transcript/events?agent=reviewer%3Asecurity&${qs({ token: s.token })}`);
      try {
        await waitFor(() => a.frames.filter((f) => f.event === 'line').length === 3, { what: 'the lines' });
        assert.ok(a.frames.some((f) => f.data === result));
      } finally {
        a.close();
      }
      const st = JSON.parse((await s.get('/api/state')).text);
      const last = st.jobs.find((x: any) => x.id === s.job.id).activity[0].last;
      assert.deepEqual(last, { kind: 'text', text: XSS_TEXT, at: '2026-10-15T10:00:00.000Z' });
    } finally {
      await s.cleanup();
    }
  });
});
