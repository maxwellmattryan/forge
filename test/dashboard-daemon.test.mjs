import test from 'node:test';
import assert from 'node:assert/strict';
import { pillModel, daemonBar, lineView, lineHtml, appendLine, postDaemon, MAX_TEXT } from '../dashboard/src/lib/daemon.ts';

const base = { enabled: true, wanted: false, running: false, status: 'off', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, held: null, lastError: null, clients: 0 };
const d = (over = {}) => ({ ...base, ...over });
const ui = (over = {}) => ({ open: false, pending: false, ...over });
const XSS = '<script>alert(1)</script> and <img src=x onerror=alert(1)>';
const button = (html, name) => html.match(new RegExp(`<button[^>]*data-daemon="${name}"[^>]*>`))?.[0] ?? '';
const disabled = (html, name) => / disabled\b/.test(button(html, name));

test('pillModel maps daemon state to label and tone', () => {
  const cases = [
    [d({ status: 'busy', wanted: true, running: true }), 'busy', 'accent'],
    [d({ status: 'idle', wanted: true, running: true }), 'idle', 'ok'],
    [d({ status: 'stopping', running: true }), 'stopping', 'warn'],
    [d({ status: 'off', wanted: true }), 'standby', 'muted'],
    [d({ status: 'off', lastError: 'daemon exited (code 1, signal null)' }), 'error', 'bad'],
    [d({ status: 'off' }), 'stopped', 'muted'],
    [d({ status: 'exploded' }), 'stopped', 'muted'],
    // wanted wins over lastError: the supervisor will retry, so it is standby, not error.
    [d({ status: 'off', wanted: true, lastError: 'x' }), 'standby', 'muted'],
  ];
  for (const [state, label, tone] of cases) {
    const p = pillModel(state);
    assert.equal(p?.label, label, JSON.stringify(state));
    assert.equal(p?.tone, tone, JSON.stringify(state));
  }
  const p = pillModel(d({ status: 'idle', running: true, sessionId: '0123456789abcdef', turns: 3, lastTurnAt: new Date().toISOString(), lastError: 'boom' }));
  assert.match(p.title, /session 01234567\b/);
  assert.match(p.title, /3 turns/);
  assert.match(p.title, /last turn \d+s ago/);
  assert.match(p.title, /boom/);
  const q = pillModel(d());
  assert.match(q.title, /no session/);
  assert.match(q.title, /0 turns/);
  assert.match(q.title, /no turns yet/);
});

test('pillModel hides the bar when the daemon is unused', () => {
  assert.equal(pillModel(undefined), null);
  assert.equal(pillModel(null), null);
  assert.equal(pillModel(d({ enabled: false })), null);
  assert.equal(daemonBar(d({ enabled: false }), ui()), '');
  assert.equal(daemonBar(undefined, ui({ open: true })), '');
  // Disabled in config but still running (e.g. just switched off) keeps the bar.
  assert.ok(pillModel(d({ enabled: false, running: true, status: 'idle' })));
  assert.ok(pillModel(d({ enabled: false, wanted: true })));
});

test('daemonBar enables start/stop by state', () => {
  let h = daemonBar(d(), ui());
  assert.ok(!disabled(h, 'start'), 'enabled, stopped: start on');
  assert.ok(disabled(h, 'stop'), 'nothing to stop');
  assert.match(h, /Daemon stopped/);

  h = daemonBar(d({ status: 'idle', wanted: true, running: true }), ui());
  assert.ok(disabled(h, 'start'));
  assert.ok(!disabled(h, 'stop'));

  h = daemonBar(d({ status: 'off', wanted: true }), ui());
  assert.ok(disabled(h, 'start'), 'standby: already wanted');
  assert.ok(!disabled(h, 'stop'));

  h = daemonBar(d({ enabled: false, running: true, status: 'idle' }), ui());
  assert.ok(disabled(h, 'start'));
  assert.match(button(h, 'start'), /title="Set daemon\.enabled: true in \.forge\/config\.yml"/);
  assert.ok(!disabled(h, 'stop'));

  h = daemonBar(d(), ui({ pending: true }));
  assert.ok(disabled(h, 'start') && disabled(h, 'stop'), 'both off while a request is in flight');
  assert.doesNotMatch(button(h, 'start'), /title=/, 'no config hint when merely pending');

  assert.match(button(daemonBar(d(), ui()), 'log'), /aria-expanded="false"/);
  h = daemonBar(d(), ui({ open: true }));
  assert.match(button(h, 'log'), /aria-expanded="true"/);
  assert.match(h, /data-daemon-log[^>]*max-h-72[^>]*overflow-y-auto/);
  assert.match(h, /No daemon output yet\./);
  assert.match(daemonBar(d(), ui({ open: true, closed: true })), /Log stream closed\. Reopen the log to retry\./);
  assert.doesNotMatch(daemonBar(d(), ui()), /data-daemon-log/);
});

test('daemonBar shows the budget hold', () => {
  const h = daemonBar(d({ status: 'off', wanted: true, held: { reason: 'budget', jobs: ['a-job', 'b-job'] } }), ui());
  assert.match(h, /<span class="chip bg-warn\/15 text-warn" title="a-job, b-job">held: budget<\/span>/);
  assert.doesNotMatch(daemonBar(d(), ui()), /held: budget/);
  const e = daemonBar(d({ status: 'idle', running: true, wanted: true, lastError: 'tick failed: x' }), ui());
  assert.match(e, /class="truncate[^"]*text-muted" title="tick failed: x">tick failed: x</);
  assert.doesNotMatch(daemonBar(d({ lastError: 'x' }), ui()), /class="truncate/, 'the error pill already says it');
});

test('lineView summarises stream-json and forge lines', () => {
  const v = (o) => lineView(typeof o === 'string' ? o : JSON.stringify(o));
  assert.deepEqual(v({ type: 'forge-daemon', at: 't', event: 'error', message: 'boom' }), { tone: 'bad', tag: 'daemon', text: 'error message=boom' });
  assert.deepEqual(v({ type: 'forge-daemon', event: 'resume-failed', sessionId: 's1', code: 1 }), { tone: 'bad', tag: 'daemon', text: 'resume-failed sessionId=s1 code=1' });
  assert.deepEqual(v({ type: 'forge-daemon', event: 'line-truncated', bytes: 9 }), { tone: 'bad', tag: 'daemon', text: 'line-truncated bytes=9' });
  assert.deepEqual(v({ type: 'forge-daemon', event: 'held', requests: 2, jobs: ['a', 'b'] }), { tone: 'warn', tag: 'daemon', text: 'held requests=2 jobs=a, b' });
  assert.deepEqual(v({ type: 'forge-daemon', event: 'spawn', pid: 42, sessionId: 'abc', resume: false, reason: 'boot' }), { tone: 'muted', tag: 'daemon', text: 'spawn pid=42 sessionId=abc reason=boot' });
  assert.deepEqual(v({ type: 'forge-daemon', event: 'exit', code: null, signal: 'SIGTERM' }), { tone: 'muted', tag: 'daemon', text: 'exit signal=SIGTERM' });
  assert.deepEqual(v({ type: 'forge-stderr', text: 'warn: x' }), { tone: 'bad', tag: 'stderr', text: 'warn: x' });
  assert.deepEqual(v({ type: 'forge-raw', text: 'not json' }), { tone: 'muted', tag: 'raw', text: 'not json' });
  assert.deepEqual(v({ type: 'forge-truncated', originalType: 'assistant', bytes: 300000 }), { tone: 'warn', tag: 'truncated', text: 'assistant · 300000 bytes' });
  assert.deepEqual(v({ type: 'forge-truncated', originalType: null, bytes: 5 }), { tone: 'warn', tag: 'truncated', text: 'line · 5 bytes' });
  assert.deepEqual(v({ type: 'system', subtype: 'init', session_id: '0123456789abcdef' }), { tone: 'muted', tag: 'system', text: 'init 01234567' });
  assert.deepEqual(v({ type: 'system', subtype: 'compact_boundary' }), { tone: 'muted', tag: 'system', text: 'compact_boundary' });
  assert.deepEqual(
    v({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Hello' }, { type: 'tool_use', name: 'Agent', input: { subagent_type: 'forge:builder' } }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    { tone: null, tag: 'assistant', text: '(thinking) · Hello · → Agent forge:builder · → Bash' },
  );
  assert.deepEqual(v({ type: 'assistant', message: { content: [] } }), { tone: null, tag: 'assistant', text: '(empty)' });
  assert.deepEqual(
    v({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }, { type: 'tool_result', is_error: true, content: 'no' }] } }),
    { tone: 'muted', tag: 'tool', text: 'result · result (error)' },
  );
  assert.deepEqual(v({ type: 'result', subtype: 'success', num_turns: 4, is_error: false }), { tone: 'ok', tag: 'result', text: 'success · 4 turns' });
  assert.deepEqual(v({ type: 'result', subtype: 'error_max_turns', num_turns: 9, is_error: true }), { tone: 'bad', tag: 'result', text: 'error_max_turns · 9 turns' });
  const rl = v({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  assert.equal(rl.tag, 'rate-limit');
  assert.equal(rl.tone, 'warn');
  assert.match(rl.text, /allowed/);
  assert.deepEqual(v({ type: 'mystery', x: 1 }), { tone: 'muted', tag: 'mystery', text: '{"type":"mystery","x":1}' });
  assert.deepEqual(v({ event: 'thing' }), { tone: 'muted', tag: 'thing', text: '{"event":"thing"}' });
  assert.deepEqual(v('plain text line'), { tone: 'muted', tag: 'raw', text: 'plain text line' });
  assert.deepEqual(v('42'), { tone: 'muted', tag: 'raw', text: '42' }, 'JSON but not an object');
});

test('lineView caps long text', () => {
  const long = 'x'.repeat(1000);
  const t = lineView(JSON.stringify({ type: 'forge-stderr', text: long })).text;
  assert.equal(t.length, MAX_TEXT + 1);
  assert.ok(t.endsWith('…'));
  assert.equal(lineView('y'.repeat(MAX_TEXT)).text, 'y'.repeat(MAX_TEXT), 'exactly at the cap is not cut');
  assert.equal(lineView(JSON.stringify({ type: 'mystery', blob: long })).text.length, MAX_TEXT + 1);
  assert.equal(lineView(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: long }] } })).text.length, MAX_TEXT + 1);
});

test('everything rendered is escaped', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: XSS }, { type: 'tool_use', name: XSS, input: { subagent_type: XSS } }] } }),
    JSON.stringify({ type: 'forge-stderr', text: XSS }),
    JSON.stringify({ type: 'forge-daemon', event: XSS, message: XSS, jobs: [XSS] }),
    JSON.stringify({ type: XSS, x: XSS }),
    JSON.stringify({ type: 'system', subtype: XSS, session_id: XSS }),
    XSS,
  ];
  for (const raw of lines) {
    const h = lineHtml('1"><img src=x>', raw);
    assert.doesNotMatch(h, /<script|<img/i, raw);
    assert.match(h, /&lt;/, raw);
  }
  const bars = [
    daemonBar(d({ status: 'idle', running: true, wanted: true, lastError: XSS, sessionId: XSS, held: { jobs: [XSS, XSS] } }), ui({ open: true })),
    daemonBar(d({ status: XSS, lastError: XSS, sessionId: XSS }), ui()),
    daemonBar(d({ enabled: false, running: true, status: 'idle', lastError: XSS, held: { jobs: XSS } }), ui()),
  ];
  for (const h of bars) {
    assert.doesNotMatch(h, /<script|<img/i);
    assert.match(h, /&lt;script&gt;/);
  }
});

test('appendLine caps, dedupes and resets on a server restart', () => {
  const buf = [];
  for (let i = 1; i <= 3; i++) assert.deepEqual(appendLine(buf, { seq: i, line: `l${i}` }), { buf, added: true, reset: false, dropped: 0 });
  assert.deepEqual(appendLine(buf, { seq: 2, line: 'again' }), { buf, added: false, reset: false, dropped: 0 });
  assert.deepEqual(buf.map((e) => e.seq), [1, 2, 3]);

  const big = [];
  let last;
  for (let i = 1; i <= 505; i++) last = appendLine(big, { seq: i, line: String(i) });
  assert.equal(big.length, 500);
  assert.equal(big[0].seq, 6);
  assert.equal(last.dropped, 1);
  const small = [];
  for (let i = 1; i <= 4; i++) appendLine(small, { seq: i, line: '' }, 3);
  assert.deepEqual(small.map((e) => e.seq), [2, 3, 4]);

  const r = appendLine(buf, { seq: 0, line: 'fresh server' });
  assert.equal(r.reset, true);
  assert.equal(r.added, true);
  assert.deepEqual(buf, [{ seq: 0, line: 'fresh server' }]);
});

test('postDaemon sends the token and surfaces the server error', async () => {
  const calls = [];
  const reply = (status, body, statusText = '') => async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, statusText, text: async () => body };
  };
  const st = await postDaemon('start', 'tok123', reply(200, JSON.stringify({ status: 'idle', running: true })));
  assert.deepEqual(st, { status: 'idle', running: true });
  const { url, init } = calls[0];
  assert.equal(url, '/api/daemon');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['x-forge-token'], 'tok123');
  assert.deepEqual(JSON.parse(init.body), { action: 'start' });

  await assert.rejects(postDaemon('start', 't', reply(409, JSON.stringify({ error: 'daemon.enabled is false in .forge/config.yml' }))), {
    message: 'daemon.enabled is false in .forge/config.yml',
  });
  await assert.rejects(postDaemon('stop', 't', reply(403, 'bad token')), { message: 'bad token' });
  await assert.rejects(postDaemon('stop', 't', reply(500, '', 'Internal Server Error')), { message: 'Internal Server Error' });
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { action: 'stop' });
});
