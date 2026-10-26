// claudeAdapter against the stub test/fixtures/bin/claude (test/fixtures/fake-claude.mjs): a real
// process, its pipes and its process group, with no login (the stub is not claude).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from '../../../test/helpers.ts';
import { claudeAdapter } from './child.ts';
import type { ClaudeChild, ClaudeEvent } from './types.ts';

const CLAUDE = path.resolve(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'bin', 'claude');

test('the real adapter runs claude and reports its events', async (t) => {
  const calls: { cmd: string; args: readonly string[]; opts: any }[] = [];
  const spawn = ((cmd: string, args: readonly string[], opts: any) => {
    calls.push({ cmd, args, opts });
    return nodeSpawn(cmd, args, opts);
  }) as typeof nodeSpawn;
  const started: ClaudeChild[] = [];
  t.after(() => {
    for (const c of started) {
      if (!c.pid) continue;
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {}
    }
  });
  const adapter = claudeAdapter({ spawn });
  const run = (argv: string[], env: NodeJS.ProcessEnv = process.env) => {
    const events: ClaudeEvent[] = [];
    const child = adapter.start(argv, { cwd: os.tmpdir(), env, maxLineBytes: 1 << 20 }, (e) => void events.push(e));
    started.push(child);
    return { child, events, kinds: () => events.filter((e) => e.kind !== 'log') };
  };

  const id = crypto.randomUUID();
  const a = run([CLAUDE, '--session-id', id]);
  assert.deepEqual(calls, [{ cmd: CLAUDE, args: ['--session-id', id], opts: { cwd: os.tmpdir(), env: process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }]);
  a.child.writeTurn();
  await waitFor(() => a.events.some((e) => e.kind === 'turn-ended'), { what: 'the turn to end' });
  assert.deepEqual(a.kinds(), [{ kind: 'turn-started' }, { kind: 'session-id', id }, { kind: 'permission-mode', mode: 'default' }, { kind: 'turn-ended', ok: true, cost: null, text: null }]);
  a.child.endInput();
  await a.child.closed;
  assert.deepEqual(a.events.at(-1), { kind: 'exit', code: 0, signal: null });

  const b = run([CLAUDE, '--session-id', crypto.randomUUID()], { ...process.env, FAKE_CLAUDE_IGNORE_EOF: '1' });
  b.child.endInput();
  b.child.signal('SIGTERM');
  await b.child.closed;
  assert.deepEqual(b.events.at(-1), { kind: 'exit', code: null, signal: 'SIGTERM' });

  const missing = run([path.join(os.tmpdir(), `forge-missing-${crypto.randomUUID()}`, 'claude')]);
  await waitFor(() => missing.events.some((e) => e.kind === 'process-error'), { what: 'the spawn error' });
  assert.deepEqual(
    missing.events.filter((e) => e.kind === 'process-error').map((e) => ({ kind: e.kind, started: (e as { started: boolean }).started })),
    [{ kind: 'process-error', started: false }],
  );
});
