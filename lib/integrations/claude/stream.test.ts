// createStream as a pure decoder: claude's stream-json chunks in, ClaudeEvents and stdin lines out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_DENIED, TURN_LINE, createStream, sessionGrant } from './stream.ts';
import type { ClaudeEvent } from './types.ts';

/** One stream over in-memory sinks. */
function decoder(maxLineBytes = 1 << 20) {
  const events: ClaudeEvent[] = [];
  const written: string[] = [];
  const s = createStream((l) => void written.push(l), (e) => void events.push(e), maxLineBytes);
  return { s, events, written };
}

const line = (o: unknown) => JSON.stringify(o) + '\n';
/** The receipt time and mode-request ids vary per run; tests compare them as placeholders. */
const norm = (text: string) => text.replace(/"at":"[^"]+"/g, '"at":"<at>"').replace(/forge-mode-[0-9a-f-]{36}/g, 'forge-mode-<id>');
const normEvents = (events: ClaudeEvent[]) => events.map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === 'string' ? norm(v) : v])));
/** The stdout log event a JSON line without a timestamp becomes. */
const logged = (o: Record<string, unknown>): ClaudeEvent => ({ kind: 'log', stream: 'stdout', line: JSON.stringify({ ...o, at: '<at>' }) });

const init = { type: 'system', subtype: 'init', session_id: 'abc', permissionMode: 'default' };
const status = { type: 'system', subtype: 'status', permissionMode: 'auto' };
const ask = {
  type: 'control_request',
  request_id: 'req-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'cp a b' },
    description: 'Copy it',
    agent_id: 'a1',
    blocked_path: '/elsewhere/b',
    permission_suggestions: [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cp a b' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/elsewhere', 'relative'], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ],
  },
};
const askedEvent: ClaudeEvent = { kind: 'permission-asked', requestId: 'req-1', tool: 'Bash', input: JSON.stringify({ command: 'cp a b' }), description: 'Copy it', agentId: 'a1', blockedPath: '/elsewhere/b', rules: ['Bash(cp a b)'], dirs: ['/elsewhere'] };
const errorResult = (result: string) => ({ type: 'result', subtype: 'success', is_error: true, result });
const resetSeconds = 2_000_000_000;

test("claude's stream-json lines become domain events", () => {
  type S = ReturnType<typeof decoder>['s'];
  const rows: { name: string; max?: number; feed: (s: S) => void; events: ClaudeEvent[]; written?: unknown[] }[] = [
    { name: 'init', feed: (s) => s.stdout(line(init)), events: [logged(init), { kind: 'turn-started' }, { kind: 'session-id', id: 'abc' }, { kind: 'permission-mode', mode: 'default' }] },
    { name: 'status', feed: (s) => s.stdout(line(status)), events: [logged(status), { kind: 'permission-mode', mode: 'auto' }] },
    {
      name: 'background tasks',
      feed: (s) => s.stdout(line({ type: 'system', subtype: 'background_tasks_changed', tasks: [{}, {}] })),
      events: [logged({ type: 'system', subtype: 'background_tasks_changed', tasks: [{}, {}] }), { kind: 'background', count: 2 }],
    },
    { name: 'background without tasks', feed: (s) => s.stdout(line({ type: 'system', subtype: 'background_tasks_changed' })), events: [logged({ type: 'system', subtype: 'background_tasks_changed' })] },
    { name: 'a working result', feed: (s) => s.stdout(line({ type: 'result', is_error: false })), events: [logged({ type: 'result', is_error: false }), { kind: 'turn-ended', ok: true }] },
    {
      name: 'a failed result',
      feed: (s) => s.stdout(line(errorResult('Failed to authenticate'))),
      events: [logged(errorResult('Failed to authenticate')), { kind: 'turn-ended', ok: false, reason: 'Failed to authenticate', limit: false, resetsAt: null }],
    },
    {
      name: 'a result in the quota wording',
      feed: (s) => s.stdout(line(errorResult('API Error: 400 You have reached your specified API usage limits'))),
      events: [
        logged(errorResult('API Error: 400 You have reached your specified API usage limits')),
        { kind: 'turn-ended', ok: false, reason: 'API Error: 400 You have reached your specified API usage limits', limit: true, resetsAt: null },
      ],
    },
    ...[resetSeconds, resetSeconds * 1000].map((resetsAt) => ({
      name: `a rejected rate limit (resetsAt ${resetsAt})`,
      feed: (s: S) => s.stdout(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } }) + line(errorResult('boom'))),
      events: [
        logged({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } }),
        logged(errorResult('boom')),
        { kind: 'turn-ended', ok: false, reason: 'boom', limit: true, resetsAt: resetSeconds * 1000 } as ClaudeEvent,
      ],
    })),
    {
      name: 'a rejected rate limit before a later turn',
      feed: (s) => {
        s.stdout(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetSeconds } }));
        s.writeTurn();
        s.stdout(line(errorResult('boom')));
      },
      events: [logged({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetSeconds } }), logged(errorResult('boom')), { kind: 'turn-ended', ok: false, reason: 'boom', limit: false, resetsAt: null }],
      written: [TURN_LINE],
    },
    { name: 'can_use_tool', feed: (s) => s.stdout(line(ask)), events: [logged(ask), askedEvent] },
    ...[7, 'T'.repeat(201)].map((tool_name) => {
      const ev = { ...ask, request: { ...ask.request, tool_name } };
      return { name: `tool name ${String(tool_name).slice(0, 10)}`, feed: (s: S) => s.stdout(line(ev)), events: [logged(ev), { ...askedEvent, tool: null } as ClaudeEvent] };
    }),
    ...[undefined, 'r'.repeat(201)].map((request_id) => {
      const ev = { ...ask, request_id };
      return { name: `request_id ${String(request_id).slice(0, 10)}`, feed: (s: S) => s.stdout(line(ev)), events: [logged(ev), { kind: 'protocol-error', message: 'ignored a control_request without a usable request_id' } as ClaudeEvent] };
    }),
    {
      name: 'hook_callback',
      feed: (s) => s.stdout(line({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } })),
      events: [logged({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } })],
      written: [{ type: 'control_response', response: { subtype: 'error', request_id: 'h1', error: 'forge does not handle hook_callback control requests' } }],
    },
    {
      name: 'a cancel for an asked id, then an unknown one',
      feed: (s) => s.stdout(line(ask) + line({ type: 'control_cancel_request', request_id: 'req-1' }) + line({ type: 'control_cancel_request', request_id: 'nope' })),
      events: [logged(ask), askedEvent, logged({ type: 'control_cancel_request', request_id: 'req-1' }), { kind: 'permission-cancelled', requestId: 'req-1' }, logged({ type: 'control_cancel_request', request_id: 'nope' })],
    },
    {
      name: 'answers to a mode request it sent, and to one it never sent',
      feed: (s) => {
        const id = s.setPermissionMode('auto')!;
        const id2 = s.setPermissionMode('default')!;
        s.stdout(line({ type: 'control_response', response: { subtype: 'success', request_id: id } }));
        s.stdout(line({ type: 'control_response', response: { subtype: 'error', request_id: id2, error: 'nope' } }));
        s.stdout(line({ type: 'control_response', response: { subtype: 'success', request_id: id } }));
        s.stdout(line({ type: 'control_response', response: { subtype: 'success', request_id: 'forged' } }));
      },
      events: [
        logged({ type: 'control_response', response: { subtype: 'success', request_id: 'forge-mode-<id>' } }),
        { kind: 'mode-answer', requestId: 'forge-mode-<id>', ok: true, error: null },
        logged({ type: 'control_response', response: { subtype: 'error', request_id: 'forge-mode-<id>', error: 'nope' } }),
        { kind: 'mode-answer', requestId: 'forge-mode-<id>', ok: false, error: 'nope' },
        logged({ type: 'control_response', response: { subtype: 'success', request_id: 'forge-mode-<id>' } }),
        logged({ type: 'control_response', response: { subtype: 'success', request_id: 'forged' } }),
      ],
      written: [
        { type: 'control_request', request_id: 'forge-mode-<id>', request: { subtype: 'set_permission_mode', mode: 'auto' } },
        { type: 'control_request', request_id: 'forge-mode-<id>', request: { subtype: 'set_permission_mode', mode: 'default' } },
      ],
    },
    { name: 'non-JSON text', feed: (s) => s.stdout('not json\n'), events: [{ kind: 'log', stream: 'stdout', line: JSON.stringify({ type: 'forge-raw', at: '<at>', text: 'not json' }) }] },
    {
      name: 'a line with a timestamp',
      feed: (s) => s.stdout('{"type":"assistant","timestamp":"2026-01-01T00:00:00Z"}\n'),
      events: [{ kind: 'log', stream: 'stdout', line: '{"type":"assistant","timestamp":"2026-01-01T00:00:00Z"}' }],
    },
    {
      name: 'a split line, CRLF and blank lines',
      feed: (s) => {
        s.stdout('{"type":"system","subtype"');
        s.stdout(':"status","permissionMode":"auto"}\r\n\n  \n');
      },
      events: [logged(status), { kind: 'permission-mode', mode: 'auto' }],
    },
    {
      name: 'a line over maxLineBytes',
      max: 64,
      feed: (s) => s.stdout('x'.repeat(100) + '\n' + line(status)),
      events: [{ kind: 'line-too-long', bytes: 100 }, logged(status), { kind: 'permission-mode', mode: 'auto' }],
    },
    {
      name: 'a stderr line over 4096 bytes',
      feed: (s) => s.stderr('e'.repeat(5000) + '\n'),
      events: [{ kind: 'log', stream: 'stderr', line: JSON.stringify({ type: 'forge-stderr', at: '<at>', text: 'e'.repeat(4096) }) }],
    },
  ];
  for (const row of rows) {
    const d = decoder(row.max);
    row.feed(d.s);
    assert.deepEqual(normEvents(d.events), row.events, row.name);
    assert.deepEqual(
      d.written.map((w) => (w === TURN_LINE ? w : JSON.parse(norm(w)))),
      row.written ?? [],
      `${row.name}: stdin`,
    );
  }
});

test('every stdin line is built from fixed text', () => {
  const stdin = (d: ReturnType<typeof decoder>) => d.written.map((w) => JSON.parse(w));
  const turn = decoder();
  turn.s.writeTurn();
  assert.deepEqual(turn.written, [TURN_LINE]);
  assert.equal(JSON.parse(TURN_LINE).message.content[0].text, '/forge requests');

  const input = { command: 'cp a b', nested: { keep: [1, 2] } };
  const answer = (decision: 'allow' | 'session' | 'deny') => {
    const d = decoder();
    d.s.stdout(line({ ...ask, request: { ...ask.request, input } }));
    assert.equal(d.s.answerPermission('req-1', decision), true, decision);
    return stdin(d)[0].response;
  };
  assert.deepEqual(answer('allow'), { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: input } });
  assert.deepEqual(answer('session'), {
    subtype: 'success',
    request_id: 'req-1',
    response: {
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cp a b' }], behavior: 'allow', destination: 'session' },
        { type: 'addDirectories', directories: ['/elsewhere'], destination: 'session' },
      ],
    },
  });
  assert.deepEqual(answer('deny'), { subtype: 'success', request_id: 'req-1', response: { behavior: 'deny', message: PERMISSION_DENIED } });

  const once = decoder();
  once.s.stdout(line(ask) + line({ ...ask, request_id: 'req-2' }) + line({ type: 'control_cancel_request', request_id: 'req-2' }));
  assert.equal(once.s.answerPermission('req-1', 'allow'), true);
  const after = once.written.length;
  assert.equal(once.s.answerPermission('req-1', 'allow'), false, 'a second answer');
  assert.equal(once.s.answerPermission('unknown', 'allow'), false, 'an unknown id');
  assert.equal(once.s.answerPermission('req-2', 'allow'), false, 'a cancelled request');
  assert.equal(once.written.length, after, 'none of them writes');

  const mode = decoder();
  assert.equal(mode.s.setPermissionMode('bypassPermissions' as any), null);
  assert.deepEqual(mode.written, []);
  const id = mode.s.setPermissionMode('dontAsk');
  assert.match(id ?? '', /^forge-mode-/);
  assert.deepEqual(stdin(mode), [{ type: 'control_request', request_id: id, request: { subtype: 'set_permission_mode', mode: 'dontAsk' } }]);

  const rule = (ruleContent?: string) => ({ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ...(ruleContent === undefined ? {} : { ruleContent }) }] });
  const grants: { name: string; suggestions: unknown; rules: string[]; dirs: string[] }[] = [
    { name: 'a deny rule', suggestions: [{ ...rule('cp a b'), behavior: 'deny' }], rules: [], dirs: [] },
    { name: 'a setMode suggestion', suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }], rules: [], dirs: [] },
    { name: 'a relative directory', suggestions: [{ type: 'addDirectories', directories: ['rel/dir', '/abs'] }], rules: [], dirs: ['/abs'] },
    { name: 'a bare tool name', suggestions: [rule()], rules: [], dirs: [] },
    ...['*', ':*', '**', ' ', ''].map((w) => ({ name: `wildcard ${JSON.stringify(w)}`, suggestions: [rule(w)], rules: [], dirs: [] })),
    { name: 'a prefix rule', suggestions: [rule('cp:*')], rules: ['Bash(cp:*)'], dirs: [] },
  ];
  for (const g of grants) {
    const got = sessionGrant(g.suggestions);
    assert.deepEqual({ rules: got.rules.map((r) => `${r.toolName}(${r.ruleContent})`), dirs: got.dirs }, { rules: g.rules, dirs: g.dirs }, g.name);
  }
});
