// dashboard/src/lib/session-log.ts: a session's raw stream-json lines into turns, items and subagent groups.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FILTERS, FOLLOW_SLACK, LONG_TEXT, MAX_ENTRIES, PREVIEW_CHARS, atBottom, buildSessionView, filtersActive, latestInitModel, mergeEntry, parseEntry, readFilters, taskText, toolSummary } from '../dashboard/src/lib/session-log.ts';

const XSS = '<script>alert(1)</script><img src=x onerror=alert(2)>';

/** Lines with offsets as the server would number them. */
function entries(lines: unknown[]) {
  let at = 1000;
  return lines.map((l) => {
    const line = typeof l === 'string' ? l : JSON.stringify(l);
    const e = { offset: at, line };
    at += Buffer.byteLength(line) + 1;
    return e;
  });
}

const sup = (event: string, extra = {}) => ({ type: 'forge-daemon', at: 't', event, ...extra });
const assistant = (content: unknown[], parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content } });
const user = (content: unknown[], parent: string | null = null) => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content } });

const FIXTURE = entries([
  sup('spawn', { pid: 42, sessionId: 'abc', resume: false, reason: 'work' }),
  { type: 'system', subtype: 'init', session_id: '0123456789abcdef', model: 'claude-opus-5-5' },
  sup('turn', { requests: 2 }),
  assistant([{ type: 'thinking', thinking: 'Let me look at the requests.' }, { type: 'text', text: 'Handling 2 requests.' }]),
  assistant([{ type: 'tool_use', id: 't_bash', name: 'Bash', input: { command: 'forge requests\nsecond line' } }]),
  user([{ type: 'tool_result', tool_use_id: 't_bash', content: 'x'.repeat(500) }]),
  assistant([{ type: 'tool_use', id: 't_read', name: 'Read', input: { file_path: '/repo/spec.md' } }]),
  user([{ type: 'tool_result', tool_use_id: 't_read', is_error: true, content: [{ type: 'text', text: 'ENOENT: no such file' }] }]),
  assistant([{ type: 'tool_use', id: 't_agent', name: 'Agent', input: { subagent_type: 'forge:builder', description: 'Build round 1', prompt: 'Implement it.' } }]),
  assistant([{ type: 'tool_use', id: 't_child', name: 'Grep', input: { pattern: 'TODO', path: 'lib' } }], 't_agent'),
  user([{ type: 'tool_result', tool_use_id: 't_child', content: XSS }], 't_agent'),
  assistant([{ type: 'text', text: 'Builder done.' }], 't_agent'),
  assistant([{ type: 'text', text: 'From nowhere.' }], 't_ghost'),
  user([{ type: 'tool_result', tool_use_id: 't_agent', content: 'BUILD: done · 2 commits' }]),
  { type: 'result', subtype: 'success', is_error: false, num_turns: 7, duration_ms: 61000, total_cost_usd: 0.5 },
  { type: 'forge-stderr', at: 't', text: 'warn: something' },
  { type: 'forge-raw', at: 't', text: 'plain' },
  { type: 'forge-truncated', originalType: 'assistant', bytes: 99999 },
  sup('held', { held: 'budget' }),
  sup('turn', { requests: 1 }),
  { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9, total_cost_usd: 0.25 },
  sup('exit', { code: 1, signal: null }),
  sup('error', { message: 'daemon exited (code 1, signal null)' }),
]);

/** The fixture's Agent call (forge:builder, prompt "Implement it."). */
function FIXTURE_AGENT() {
  const it = buildSessionView(FIXTURE).turns[1].items.find((i) => i.kind === 'subagent' && i.known);
  assert.ok(it?.kind === 'subagent');
  return it;
}

test('turns, items and subagent groups from a fixture stream', () => {
  const v = buildSessionView(FIXTURE, { ...DEFAULT_FILTERS, thinking: true });
  assert.deepEqual(v.turns.map((t) => t.label), ['Session start', 'Turn 1 · 2 requests', 'Turn 2 · 1 request']);
  assert.deepEqual(v.totals, { turns: 2, costUsd: 0.75, results: 2 });
  const [start, t1, t2] = v.turns;
  assert.deepEqual(start.items.map((i) => i.kind), ['supervisor', 'init']);
  assert.deepEqual(start.items[1], { kind: 'init', offset: FIXTURE[1].offset, at: null, tone: 'muted', model: 'claude-opus-5-5', session: '01234567' });
  assert.equal(start.items[0].kind === 'supervisor' && start.items[0].text, 'spawn pid=42 sessionId=abc reason=work');
  assert.deepEqual(t1.items.map((i) => i.kind), ['thinking', 'text', 'tool', 'tool', 'subagent', 'subagent', 'result', 'stderr', 'raw', 'truncated', 'supervisor']);

  const bash = t1.items[2];
  assert.ok(bash.kind === 'tool');
  assert.equal(bash.name, 'Bash');
  assert.equal(bash.summary, 'forge requests', 'the first line of the command');
  assert.equal(bash.input, JSON.stringify({ command: 'forge requests\nsecond line' }, null, 2));
  assert.equal(bash.result?.preview.length, PREVIEW_CHARS + 1);
  assert.equal(bash.result?.full.length, 500);
  assert.equal(bash.result?.more, true);
  assert.equal(bash.result?.isError, false);
  const read = t1.items[3];
  assert.ok(read.kind === 'tool');
  assert.equal(read.summary, '/repo/spec.md');
  assert.deepEqual(read.result, { isError: true, preview: 'ENOENT: no such file', full: 'ENOENT: no such file', more: false });
  assert.equal(read.tone, 'bad');

  const agent = t1.items[4];
  assert.ok(agent.kind === 'subagent');
  assert.equal(agent.role, 'forge:builder');
  assert.equal(agent.description, 'Build round 1');
  assert.equal(agent.summary, 'forge:builder: Build round 1');
  assert.equal(agent.known, true);
  assert.deepEqual(agent.items.map((i) => i.kind), ['tool', 'text'], 'children nest by parent_tool_use_id');
  const child = agent.items[0];
  assert.ok(child.kind === 'tool');
  assert.equal(child.summary, 'TODO in lib');
  assert.equal(child.result?.full, XSS, 'strings come back unescaped: the renderer escapes');
  assert.equal(agent.result?.preview, 'BUILD: done · 2 commits');
  const ghost = t1.items[5];
  assert.ok(ghost.kind === 'subagent');
  assert.equal(ghost.role, 'Subagent (unknown call)');
  assert.equal(ghost.known, false);
  assert.deepEqual(ghost.items.map((i) => (i.kind === 'text' ? i.text : '')), ['From nowhere.']);

  const res = t1.items[6];
  assert.ok(res.kind === 'result');
  assert.equal(res.tone, 'ok');
  assert.equal(res.text, 'success · 7 turns · 61s · $0.5000');
  assert.equal(res.costUsd, 0.5);
  assert.equal(t1.items[10].tone, 'warn', 'held is a warning');
  assert.deepEqual(t2.items.map((i) => [i.kind, i.tone]), [['result', 'bad'], ['supervisor', 'muted'], ['supervisor', 'bad']]);
  const failed: any = buildSessionView(entries([{ type: 'result', subtype: 'success', is_error: true, num_turns: 1, result: 'Failed to authenticate' }])).turns[0].items[0];
  assert.equal(failed.text, 'turn failed · Failed to authenticate · 1 turns', 'a failed turn never reads as success');
});

test('one-line tool summaries', () => {
  assert.equal(toolSummary('Bash', { command: `echo ${'a'.repeat(200)}\nnext` }).length, 121);
  assert.equal(toolSummary('Bash', { command: 'ls -la\nrm x' }), 'ls -la');
  for (const n of ['Read', 'Edit', 'Write', 'MultiEdit']) assert.equal(toolSummary(n, { file_path: '/a/b.ts', content: 'x' }), '/a/b.ts');
  assert.equal(toolSummary('Glob', { pattern: '**/*.ts' }), '**/*.ts');
  assert.equal(toolSummary('Grep', { pattern: 'foo', path: 'lib' }), 'foo in lib');
  assert.equal(toolSummary('Agent', { subagent_type: 'forge:reviewer', description: 'Review code' }), 'forge:reviewer: Review code');
  assert.equal(toolSummary('Task', { description: 'x' }), 'agent: x');
  assert.equal(toolSummary('Skill', { skill: 'forge:forge', args: 'requests' }), 'forge:forge requests');
  assert.equal(toolSummary('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(toolSummary('TodoWrite', { todos: [1, 2] }), '2 todos');
  assert.equal(toolSummary('mcp__x__y', { a: 1 }), '{"a":1}');
  assert.equal(toolSummary('Other', { blob: 'z'.repeat(300) }).length, 121);
});

test('filters: text, tools, thinking and subagents', () => {
  const kinds = (f) => buildSessionView(FIXTURE, { ...DEFAULT_FILTERS, ...f }).turns.flatMap((t) => t.items.map((i) => i.kind));
  assert.equal(DEFAULT_FILTERS.thinking, false);
  assert.ok(!kinds({}).includes('thinking'), 'thinking is hidden by default');
  assert.ok(kinds({ thinking: true }).includes('thinking'));
  assert.ok(!kinds({ tools: false }).includes('tool'), 'tools off hides tool calls');
  assert.ok(kinds({ tools: false }).includes('subagent'), 'but not subagent blocks');
  const off = buildSessionView(FIXTURE, { ...DEFAULT_FILTERS, subagents: false }).turns[1].items.find((i) => i.kind === 'subagent' && i.known);
  assert.ok(off?.kind === 'subagent');
  assert.deepEqual(off.items, [], 'subagents off: only the summary and result');
  assert.equal(off.hidden, 2);
  assert.equal(off.result?.preview, 'BUILD: done · 2 commits');

  const enoent = buildSessionView(FIXTURE, { ...DEFAULT_FILTERS, text: 'enoent' });
  assert.deepEqual(enoent.turns.map((t) => t.items.map((i) => i.kind)), [['tool']], 'text matches tool results, case-insensitively');
  const nested = buildSessionView(FIXTURE, { ...DEFAULT_FILTERS, text: 'builder done' }).turns.flatMap((t) => t.items);
  assert.equal(nested.length, 1);
  assert.ok(nested[0].kind === 'subagent');
  assert.deepEqual(nested[0].items.map((i) => i.kind), ['text'], 'a match inside a subagent keeps the block with the matching children');
  const block = buildSessionView(FIXTURE, { ...DEFAULT_FILTERS, text: 'Build round' }).turns.flatMap((t) => t.items);
  assert.ok(block[0].kind === 'subagent' && block[0].items.length === 2, 'a match on the block keeps its children');
  assert.deepEqual(buildSessionView(FIXTURE, { ...DEFAULT_FILTERS, text: 'nothing matches this' }).turns, []);
  assert.equal(buildSessionView(FIXTURE, { ...DEFAULT_FILTERS, text: 'nothing matches this' }).totals.turns, 2, 'totals ignore filters');
});

test('filtersActive flags any change from the defaults', () => {
  assert.equal(filtersActive({ ...DEFAULT_FILTERS }), false, 'the defaults');
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, text: '   ' }), false, 'whitespace-only text is no filter');
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, text: 'bash' }), true, 'search text');
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, tools: !DEFAULT_FILTERS.tools }), true, 'tools');
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, thinking: !DEFAULT_FILTERS.thinking }), true, 'thinking');
  assert.equal(filtersActive({ ...DEFAULT_FILTERS, subagents: !DEFAULT_FILTERS.subagents }), true, 'subagents');
  assert.equal(filtersActive(readFilters('garbage')), false, 'an unreadable pref reads as the defaults');
});

test('long text, empty logs and odd lines', () => {
  const long = 'L'.repeat(LONG_TEXT + 1);
  const v = buildSessionView(entries([assistant([{ type: 'text', text: long }, { type: 'text', text: 'short' }])]));
  assert.deepEqual(v.turns[0].items.map((i) => i.kind === 'text' && i.long), [true, false]);
  assert.deepEqual(buildSessionView([]), { turns: [], totals: { turns: 0, costUsd: 0, results: 0 } });
  const odd = buildSessionView(entries(['not json', '42', { type: 'mystery', x: 1 }, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, user([{ type: 'tool_result', tool_use_id: 'nope', content: 'r' }])]));
  assert.deepEqual(odd.turns[0].items.map((i) => i.kind), ['raw', 'raw', 'other', 'rate-limit', 'other']);
  // A child line that arrives before its Agent call (out-of-order lines) is adopted by the call.
  const early = buildSessionView(entries([assistant([{ type: 'text', text: 'child' }], 'a1'), assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'forge:planner', description: 'Plan' } }])]));
  assert.equal(early.turns[0].items.length, 1);
  const a = early.turns[0].items[0];
  assert.ok(a.kind === 'subagent' && a.known && a.role === 'forge:planner' && a.items.length === 1);
  assert.equal(parseEntry(FIXTURE[3]), parseEntry(FIXTURE[3]), 'parsed lines are cached per entry');
  // A window that starts mid-log says so, and the supervisor's turn number wins over counting.
  const mid = buildSessionView(entries([assistant([{ type: 'text', text: 'tail of turn 6' }]), sup('turn', { requests: 1, turn: 7 })]), DEFAULT_FILTERS, { partial: true });
  assert.deepEqual(mid.turns.map((t) => t.label), ['Earlier lines', 'Turn 7 · 1 request']);
});

test('strings are returned unescaped', () => {
  const v = buildSessionView(
    entries([
      sup('error', { message: XSS }),
      assistant([{ type: 'text', text: XSS }, { type: 'tool_use', id: 'x1', name: XSS, input: { command: XSS } }]),
      user([{ type: 'tool_result', tool_use_id: 'x1', content: XSS }]),
      assistant([{ type: 'tool_use', id: 'x2', name: 'Agent', input: { subagent_type: 'forge:builder', description: 'd', prompt: XSS } }]),
      { type: 'forge-stderr', text: XSS },
      XSS,
    ]),
    { ...DEFAULT_FILTERS, text: '' },
  );
  const text = JSON.stringify(v);
  assert.ok(text.includes('<script>alert(1)</script>'));
  assert.ok(!text.includes('&lt;'));
  const agent = v.turns[0].items.find((i) => i.kind === 'subagent');
  assert.ok(agent?.kind === 'subagent');
  assert.equal(agent.prompt, XSS, 'the prompt comes back unescaped: md() escapes');
});

test('subagent carries its prompt', () => {
  const agent = FIXTURE_AGENT();
  assert.equal(agent.prompt, 'Implement it.');
  for (const name of ['Agent', 'Task']) {
    const it: any = buildSessionView(entries([assistant([{ type: 'tool_use', id: 'a1', name, input: { subagent_type: 'forge:planner', prompt: '# Plan\n- **one**' } }])])).turns[0].items[0];
    assert.equal(it.kind, 'subagent', name);
    assert.equal(it.prompt, '# Plan\n- **one**', name);
  }
  const bare: any = buildSessionView(entries([assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'forge:planner' } }])])).turns[0].items[0];
  assert.equal(bare.prompt, '', 'no input.prompt: empty');
  // An unknown call, then the same placeholder once its call arrives (out-of-order lines).
  const ghost: any = buildSessionView(entries([assistant([{ type: 'text', text: 'child' }], 'a1')])).turns[0].items[0];
  assert.ok(ghost.kind === 'subagent' && !ghost.known);
  assert.equal(ghost.prompt, '', 'an unknown call has no prompt');
  const adopted: any = buildSessionView(entries([assistant([{ type: 'text', text: 'child' }], 'a1'), assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'forge:planner', prompt: 'Plan it.' } }])])).turns[0].items;
  assert.equal(adopted.length, 1);
  assert.ok(adopted[0].known && adopted[0].items.length === 1);
  assert.equal(adopted[0].prompt, 'Plan it.', 'the adopted placeholder carries the call prompt');
  // A text filter that matches only the prompt keeps the block. The input JSON escapes the quotes, so only the prompt matches.
  const quoted = entries([assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'forge:planner', description: 'Plan', prompt: 'Run "forge verify" now.' } }]), assistant([{ type: 'text', text: 'unrelated' }])]);
  const hit = buildSessionView(quoted, { ...DEFAULT_FILTERS, text: 'run "forge verify"' }).turns.flatMap((t) => t.items);
  assert.deepEqual(hit.map((i) => i.kind), ['subagent']);
  assert.equal(hit[0].kind === 'subagent' && hit[0].role, 'forge:planner');
});

test('mergeEntry inserts by offset without duplicates or older lines', () => {
  const buf = [];
  assert.equal(mergeEntry(buf, { offset: 10, line: 'a' }), true);
  assert.equal(mergeEntry(buf, { offset: 30, line: 'c' }), true);
  assert.equal(mergeEntry(buf, { offset: 20, line: 'b' }), true, 'in-order insert');
  assert.equal(mergeEntry(buf, { offset: 20, line: 'dupe' }), false);
  assert.equal(mergeEntry(buf, { offset: 5, line: 'older than the window' }), false);
  assert.equal(mergeEntry(buf, { offset: NaN, line: 'x' }), false);
  assert.deepEqual(buf.map((e) => e.line), ['a', 'b', 'c']);
  assert.equal(MAX_ENTRIES, 5000);
});

test('readFilters falls back to the defaults', () => {
  assert.deepEqual(readFilters(null), DEFAULT_FILTERS);
  assert.deepEqual(readFilters('{oops'), DEFAULT_FILTERS);
  assert.deepEqual(readFilters(JSON.stringify({ text: 'x', tools: false, thinking: 'yes' })), { ...DEFAULT_FILTERS, text: 'x', tools: false });
});

test('supervisor and forge lines are tagged and toned like the old daemon pane', () => {
  const one = (o) => {
    const items = buildSessionView(entries([o])).turns.flatMap((t) => t.items);
    assert.equal(items.length, 1, JSON.stringify(o));
    const it: any = items[0];
    return [it.kind, it.tone, it.text ?? null];
  };
  assert.deepEqual(one(sup('error', { message: 'boom' })), ['supervisor', 'bad', 'error message=boom']);
  assert.deepEqual(one(sup('resume-failed', { sessionId: 's1', code: 1 })), ['supervisor', 'bad', 'resume-failed sessionId=s1 code=1']);
  assert.deepEqual(one(sup('line-truncated', { bytes: 9 })), ['supervisor', 'bad', 'line-truncated bytes=9']);
  assert.deepEqual(one(sup('held', { held: 'budget' })), ['supervisor', 'warn', 'held held=budget']);
  assert.deepEqual(one(sup('waiting', { maxConcurrent: 2 })), ['supervisor', 'warn', 'waiting maxConcurrent=2']);
  assert.deepEqual(one(sup('spawn', { pid: 42, sessionId: 'abc', resume: false, reason: 'boot' })), ['supervisor', 'muted', 'spawn pid=42 sessionId=abc reason=boot']);
  assert.deepEqual(one(sup('exit', { code: null, signal: 'SIGTERM' })), ['supervisor', 'muted', 'exit signal=SIGTERM']);
  assert.deepEqual(one(sup('idle-stop', { pid: 3, reason: 'slot' })), ['supervisor', 'muted', 'idle-stop pid=3 reason=slot']);
  assert.deepEqual(one(sup('finished', { state: 'done' })), ['supervisor', 'muted', 'finished state=done']);
  assert.deepEqual(one(sup('stop', { pid: 3, reason: 'job-finished' })), ['supervisor', 'muted', 'stop pid=3 reason=job-finished']);
  assert.deepEqual(one(sup('session-changed', { from: 'a', to: 'b' })), ['supervisor', 'muted', 'session-changed from=a to=b']);
  assert.deepEqual(one(sup('reaped', { pid: 7 })), ['supervisor', 'muted', 'reaped pid=7']);
  assert.deepEqual(one(sup('wake')), ['supervisor', 'muted', 'wake']);
  assert.deepEqual(one(sup('agents-lost', { roles: ['builder', 'reviewer:code'] })), ['supervisor', 'warn', 'agents-lost roles=builder, reviewer:code']);
  assert.deepEqual(one(sup('missed-agent-end', { roles: ['reviewer:security'], request: 'r-1' })), ['supervisor', 'warn', 'missed-agent-end roles=reviewer:security']);
  assert.deepEqual(one({ type: 'forge-truncated', originalType: null, bytes: 5 }), ['truncated', 'warn', 'line · 5 bytes']);
  assert.deepEqual(one({ type: 'system', subtype: 'compact_boundary' }), ['other', 'muted', 'system compact_boundary']);
  assert.deepEqual(one({ event: 'thing' }), ['other', 'muted', '{"event":"thing"}']);
  assert.deepEqual(one({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'Permission to use Bash has been denied' }), ['denied', 'warn', 'Bash: Permission to use Bash has been denied']);
  assert.deepEqual(one({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup', outcome: 'success', exit_code: 0, stdout: 'x' }), ['hook', 'muted', 'SessionStart:startup · success · exit 0']);
  assert.deepEqual(one({ type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse:Bash', outcome: 'blocking', exit_code: 2, stderr: 'no AI attribution\n' }), ['hook', 'warn', 'PreToolUse:Bash · blocking · exit 2 · no AI attribution']);
  assert.deepEqual(one({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.04 }, seven_day: { utilization: 0.361 } } } }), ['rate-limit', 'muted', 'allowed · five_hour · five_hour 4% · seven_day 36%']);
  assert.deepEqual(one({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true } }), ['rate-limit', 'warn', 'rejected · five_hour · overage']);
  // What claude 2.1.296 printed when its login had expired.
  assert.deepEqual(one({ type: 'assistant', error: 'authentication_failed', is_api_error_message: true, message: { content: [{ type: 'text', text: 'Failed to authenticate' }] } }), ['text', 'bad', 'Failed to authenticate']);
});

test('background task lines fold into the call they report on, with a time on every line', () => {
  const T = (n: number) => `2026-10-14T04:36:0${n}.000Z`;
  const task = (subtype: string, tool_use_id: string, extra = {}, at: string | null = null) => ({ type: 'system', subtype, tool_use_id, task_id: `task-${tool_use_id}`, ...(at ? { at } : {}), ...extra });
  const v = buildSessionView(
    entries([
      { ...sup('turn', { requests: 1 }), at: T(0) },
      { ...assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'forge:builder', description: 'Build round 1' } }]), timestamp: T(1) },
      task('task_started', 'a1', { description: 'Build round 1', task_type: 'local_agent', subagent_type: 'forge:builder' }, T(2)),
      task('task_progress', 'a1', { description: 'Running npm test', subagent_type: 'forge:builder', usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 7007 }, last_tool_name: 'Bash' }, T(3)),
      task('task_progress', 'a1', { description: 'Editing lib/step.ts', subagent_type: 'forge:builder', usage: { total_tokens: 32327, tool_uses: 12, duration_ms: 67007 }, last_tool_name: 'Edit' }, T(4)),
      { type: 'tool_progress', tool_use_id: 'a1-heartbeat-0', tool_name: 'Agent', parent_tool_use_id: 'a1', elapsed_time_seconds: 30, heartbeat: true },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 },
      { type: 'system', subtype: 'commands_changed', commands: [{ name: 'x', description: 'y' }] },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
      { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' },
      // task_updated names only the task, resolved through the lines above that carry both ids.
      { type: 'system', subtype: 'task_updated', task_id: 'task-a1', patch: { status: 'completed', end_time: 1 }, at: T(5) },
      { type: 'system', subtype: 'task_updated', task_id: 'never-seen', patch: { status: 'completed' } },
      task('task_notification', 'a1', { status: 'completed', summary: 'Build round 1' }, T(6)),
      { ...assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test', run_in_background: true } }]), timestamp: T(7) },
      task('task_started', 'b1', { description: 'Run the test suite', task_type: 'local_bash' }, T(7)),
      task('task_notification', 'b1', { status: 'failed', summary: 'Run the test suite' }, T(8)),
      // A task whose call is not in the window: one line, kept current, never one per progress event.
      task('task_progress', 'gone', { description: 'Reading spec', subagent_type: 'forge:reviewer', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 1000 } }, T(8)),
      task('task_progress', 'gone', { description: 'Writing review', subagent_type: 'forge:reviewer', usage: { total_tokens: 2000, tool_uses: 4, duration_ms: 9000 } }, T(9)),
      task('task_notification', 'gone', { status: 'completed' }, T(9)),
    ]),
  );
  assert.equal(v.turns.length, 1);
  const [turn] = v.turns;
  assert.equal(turn.at, T(0), 'the turn header carries the turn event time');
  assert.deepEqual(turn.items.map((i) => i.kind), ['subagent', 'tool', 'task'], 'noise lines are dropped and task lines fold into their calls');
  const agent = turn.items[0];
  assert.ok(agent.kind === 'subagent');
  assert.equal(agent.at, T(1), "claude's own timestamp is the line's time");
  assert.equal(agent.task?.status, 'completed');
  assert.equal(buildSessionView(entries([{ type: 'system', subtype: 'task_updated', task_id: 'never-seen', patch: { status: 'completed' } }])).turns.length, 0, 'an unresolvable task_updated is dropped');
  assert.equal(agent.task?.activity, 'Editing lib/step.ts', 'the latest progress wins');
  assert.equal(agent.task?.at, T(6));
  assert.equal(agent.task?.text, 'completed · Editing lib/step.ts · 12 tools · 32k tokens · 1m 7s');
  assert.equal(agent.tone, 'info');
  const bash = turn.items[1];
  assert.ok(bash.kind === 'tool');
  assert.equal(bash.task?.text, 'failed');
  assert.equal(bash.tone, 'bad', 'a failed task marks its call');
  const orphan = turn.items[2];
  assert.ok(orphan.kind === 'task');
  assert.equal(orphan.id, 'gone');
  assert.equal(orphan.role, 'forge:reviewer');
  assert.equal(orphan.at, T(8), 'the item keeps the time of its first line');
  assert.equal(orphan.text, 'completed · Writing review · 4 tools · 2k tokens · 0m 9s');
  assert.equal(taskText({ status: null, activity: '', tokens: null, toolUses: 1, durationMs: null, at: null }), '1 tool');
  // Filters see the folded task text.
  assert.equal(buildSessionView(entries([assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: {} }]), task('task_progress', 'a1', { description: 'Editing lib/step.ts' })]), { ...DEFAULT_FILTERS, text: 'step.ts' }).turns[0].items.length, 1);
  // Lines without a time (logs written before the supervisor stamped them) have at: null.
  const old = buildSessionView(entries([{ type: 'result', subtype: 'success' }, sup('exit', { code: 0 })])).turns[0].items;
  assert.deepEqual(old.map((i) => i.at), [null, 't']);
});

test("permission prompts show as the supervisor's events; claude's raw control lines are dropped", () => {
  const [asked, ctl, cancel, answered] = entries([
    sup('permission-asked', { id: 'p1', tool: 'Bash' }),
    { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: XSS } } },
    { type: 'control_cancel_request', request_id: 'r1' },
    sup('permission', { id: 'p1', tool: 'Bash', decision: 'deny' }),
  ]).map(parseEntry);
  assert.deepEqual(ctl, []);
  assert.deepEqual(cancel, []);
  const item = (p: any) => p[0].item;
  assert.equal(item(asked).text, 'permission-asked tool=Bash');
  assert.equal(item(asked).tone, 'warn');
  assert.equal(item(answered).text, 'permission tool=Bash decision=deny');
});

test('a mode switch shows as the supervisor’s events with the mode; claude’s control_response is dropped', () => {
  const [set, response, failed] = entries([
    sup('permission-mode', { mode: 'auto' }),
    { type: 'control_response', response: { subtype: 'success', request_id: 'forge-mode-1', response: { mode: 'auto' } } },
    sup('error', { message: 'claude refused permission mode auto: no' }),
  ]).map(parseEntry);
  assert.deepEqual(response, []);
  const item = (p: any) => p[0].item;
  assert.equal(item(set).text, 'permission-mode mode=auto');
  assert.equal(item(failed).tone, 'bad');
});

test('the effort a session started with shows as a supervisor line', () => {
  const [high, inherit] = entries([sup('effort', { level: 'high', source: 'job' }), sup('effort', { level: 'inherit', source: 'none' })]).map(parseEntry);
  const item = (p: any) => p[0].item;
  assert.equal(item(high).kind, 'supervisor');
  assert.equal(item(high).text, 'effort level=high source=job');
  assert.equal(item(high).tone, 'muted');
  assert.equal(item(inherit).text, 'effort level=inherit source=none');
});

test('drops transcript bookkeeping lines', () => {
  const noise = ['file-history-snapshot', 'queue-operation', 'summary', 'progress', 'attachment', 'last-prompt'].map((type) => ({ type, snapshot: { x: 1 }, timestamp: '2026-10-15T10:00:00.000Z' }));
  const meta = { type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/clear</command-name>' } };
  const prompt = { type: 'user', isSidechain: true, message: { role: 'user', content: `Review the diff ${XSS}` }, timestamp: '2026-10-15T10:00:01.000Z' };
  for (const e of entries([...noise, meta])) assert.deepEqual(parseEntry(e), [], e.line);
  const [first] = parseEntry(entries([prompt])[0]);
  assert.equal(first.kind, 'item');
  assert.equal(first.kind === 'item' && first.item.kind, 'text');
  assert.equal(first.kind === 'item' && first.item.kind === 'text' && first.item.text, `Review the diff ${XSS}`, 'the subagent prompt stays text, unescaped for md()');
  const view = buildSessionView(entries([...noise, meta, prompt]));
  assert.equal(view.turns.flatMap((t) => t.items).length, 1);
});

test("latestInitModel returns the newest init line's model", () => {
  const init = (model: unknown, extra = {}) => ({ type: 'system', subtype: 'init', session_id: 's', model, ...extra });
  assert.equal(latestInitModel([]), null, 'no lines');
  assert.equal(latestInitModel(entries([sup('spawn'), assistant([{ type: 'text', text: 'hi' }])])), null, 'no init line');
  assert.equal(latestInitModel(FIXTURE), 'claude-opus-5-5');
  const respawned = entries([init('claude-sonnet-4-5'), sup('turn', { requests: 1 }), assistant([{ type: 'text', text: 'ok' }]), sup('spawn'), init('claude-opus-5-5'), assistant([{ type: 'text', text: 'again' }])]);
  assert.equal(latestInitModel(respawned), 'claude-opus-5-5', 'the newest init wins after a respawn');
  // A subagent's init reports the subagent's model, not the session's.
  assert.equal(latestInitModel(entries([init('claude-opus-5-5'), init('claude-haiku-4-5', { parent_tool_use_id: 't_agent' })])), 'claude-opus-5-5');
  assert.equal(latestInitModel(entries([init(''), 'not json'])), null, 'an init with no model names none');
  assert.equal(latestInitModel(entries([init(XSS)])), XSS, 'session output passes through as data; SessionLog renders it as text');
});

test('atBottom: the 24 px slack and short content', () => {
  assert.equal(FOLLOW_SLACK, 24);
  assert.equal(atBottom(1000, 476, 500, 24), true, 'exactly 24 px from the bottom');
  assert.equal(atBottom(1000, 475, 500, 24), false, '25 px from the bottom');
  assert.equal(atBottom(1000, 500, 500, 24), true, 'at the bottom');
  assert.equal(atBottom(300, 0, 500, 24), true, 'content shorter than the pane');
  assert.equal(atBottom(1000, 476, 500), true, 'slack defaults to 24');
  assert.equal(atBottom(1000, 475, 500), false);
  assert.equal(atBottom(1000, 490, 500, 0), false, 'a custom slack');
});
