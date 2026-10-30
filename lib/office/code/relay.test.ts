// The code turn's permission relay against stand-in runners: what the dashboard is shown, what is denied unasked
// and recorded, answers that reach only the runner that asked, timeouts, cancels, and malformed IPC messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobAt, tempRepo, waitFor } from '../../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { readEvents } from '#core/job/store.ts';
import { PROMPT_INPUT_CHARS } from '#integrations/claude/stream.ts';
import { MAX_PROMPTS } from '../session/permissions/control.ts';
import { readPromptHistory } from '../session/permissions/history.ts';
import { createRelay, type RelayRunner } from './relay.ts';

const ACTOR = { login: 'al', source: 'dashboard' } as const;

/** A runner that records what the relay sent it. */
const runner = (): RelayRunner & { sent: any[] } => {
  const sent: any[] = [];
  return { sent, send: (m) => (sent.push(m), true) };
};

const ask = (requestId: string, over: Record<string, unknown> = {}) => ({
  type: 'forge-role',
  role: 'builder',
  event: 'ask',
  requestId,
  tool: 'Bash',
  input: JSON.stringify({ command: 'cp a b' }),
  description: 'Copy the fonts',
  agentId: null,
  blockedPath: null,
  rules: ['Bash(cp a b)'],
  dirs: [],
  ...over,
});

function setup(permissionTimeoutMs: number | null = null) {
  const repo = tempRepo();
  const root = repo.dir;
  const { id } = jobAt(root, 'build');
  const lines: { event: string; extra: Record<string, unknown> }[] = [];
  let changes = 0;
  const relay = createRelay({
    root,
    scope: id,
    config: () => loadConfig(root).config,
    o: { permissionTimeoutMs, redactor: () => [] },
    logEvent: (event, extra = {}) => void lines.push({ event, extra }),
    changed: () => void changes++,
  });
  return { repo, root, id, relay, lines, changes: () => changes };
}

test('the relay shows a runner ask with its role, and answers only that runner', () => {
  const s = setup();
  try {
    const [a, b] = [runner(), runner()];
    s.relay.ask(a, 'builder', ask('r1'));
    s.relay.ask(b, 'reviewer:code', ask('r1', { tool: 'Edit' }));
    const shown = s.relay.permissions();
    assert.deepEqual(
      shown.map((p) => [p.tool, p.role, p.input, p.description, p.sessionRules]),
      [
        ['Bash', 'builder', '{"command":"cp a b"}', 'Copy the fonts', ['Bash(cp a b)']],
        ['Edit', 'reviewer:code', '{"command":"cp a b"}', 'Copy the fonts', ['Bash(cp a b)']],
      ],
    );
    assert.equal(s.relay.answer(shown[0].id, 'allow', ACTOR), 'Bash');
    assert.deepEqual(a.sent, [{ type: 'forge-answer', requestId: 'r1', decision: 'allow' }]);
    assert.deepEqual(b.sent, [], 'the other runner hears nothing');
    assert.equal(s.relay.answer(shown[0].id, 'deny', ACTOR), null, 'answered once');
    assert.deepEqual(s.relay.permissions().map((p) => p.role), ['reviewer:code']);
    assert.deepEqual(readPromptHistory(s.root).map((e) => [e.scope, e.tool, e.decision]), [[s.id, 'Bash', 'allow']]);
  } finally {
    s.repo.cleanup();
  }
});

test('the relay denies unasked what a session would, and records it', () => {
  const s = setup();
  try {
    const r = runner();
    const rows: [string, Record<string, unknown>, string][] = [
      ['null input', { input: null }, 'unserialisable-input'],
      ['an input over the cap', { input: 'x'.repeat(PROMPT_INPUT_CHARS + 1) }, 'too-large'],
      ['a null tool', { tool: null }, 'unusable-tool-name'],
    ];
    for (const [name, over, reason] of rows) {
      r.sent.length = 0;
      s.relay.ask(r, 'builder', ask(`deny-${reason}`, over));
      assert.deepEqual(r.sent, [{ type: 'forge-answer', requestId: `deny-${reason}`, decision: 'deny' }], name);
      assert.equal(readPromptHistory(s.root).at(-1)?.reason, reason, name);
    }
    assert.equal(s.relay.permissions().length, 0);
    for (let i = 0; i < MAX_PROMPTS; i++) s.relay.ask(r, 'builder', ask(`q${i}`));
    r.sent.length = 0;
    s.relay.ask(r, 'builder', ask('one-too-many'));
    assert.deepEqual(r.sent, [{ type: 'forge-answer', requestId: 'one-too-many', decision: 'deny' }]);
    assert.equal(readPromptHistory(s.root).at(-1)?.reason, 'too-many');
    assert.equal(s.relay.permissions().length, MAX_PROMPTS);
  } finally {
    s.repo.cleanup();
  }
});

test('the relay times a prompt out with a deny', async () => {
  const s = setup(30);
  try {
    const r = runner();
    s.relay.ask(r, 'builder', ask('slow'));
    await waitFor(() => r.sent.length === 1, { what: 'the timeout deny' });
    assert.deepEqual(r.sent, [{ type: 'forge-answer', requestId: 'slow', decision: 'deny', why: 'timeout' }]);
    assert.deepEqual([s.relay.permissions().length, s.relay.timedOut().map((p) => [p.tool, p.role])], [0, [['Bash', 'builder']]]);
    assert.deepEqual(readEvents(s.root, s.id).filter((e) => e.type === 'permission-timed-out').map((e) => e.tool), ['Bash']);
  } finally {
    s.repo.cleanup();
  }
});

test("a cancel, or the runner's exit, drops its prompts; malformed messages are ignored", () => {
  const s = setup();
  try {
    const [a, b] = [runner(), runner()];
    s.relay.ask(a, 'builder', ask('r1'));
    s.relay.ask(a, 'builder', ask('r2'));
    s.relay.ask(b, 'reviewer:code', ask('r1'));
    s.relay.cancel(b, 'r2');
    assert.equal(s.relay.permissions().length, 3, "a cancel names the runner's own request");
    s.relay.cancel(a, 'r1');
    assert.deepEqual(s.relay.permissions().map((p) => p.role), ['builder', 'reviewer:code']);
    s.relay.drop(a);
    assert.deepEqual(s.relay.permissions().map((p) => p.role), ['reviewer:code']);

    const before = s.relay.permissions().length;
    const malformed: unknown[] = [
      null,
      'ask',
      [],
      ask(5 as never),
      ask('m1', { tool: 5 }),
      ask('m2', { input: { command: 'x' } }),
      ask('m3', { description: ['x'] }),
      ask('m4', { rules: 'Bash(x)' }),
      ask('m5', { dirs: [7] }),
      ask('x'.repeat(201)),
    ];
    for (const m of malformed) s.relay.ask(b, 'reviewer:code', m);
    // Through the runner's message path: an unknown event, another type, and a cancel with a non-string id.
    for (const m of [{ ...ask('m6'), event: 'grant' }, { ...ask('m7'), type: 'forge-answer' }, { type: 'forge-role', event: 'cancel', requestId: 42 }]) s.relay.message(b, 'reviewer:code', m);
    s.relay.cancel(b, 42);
    assert.equal(s.relay.answer('no-such-prompt', 'allow', ACTOR), null);
    assert.equal(s.relay.permissions().length, before, 'nothing shown');
    assert.deepEqual(b.sent, [], 'nothing answered');
  } finally {
    s.repo.cleanup();
  }
});
