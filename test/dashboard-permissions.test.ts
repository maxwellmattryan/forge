// Daemon permission prompts in the dashboard (dashboard/src/lib/permissions.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { grantsMore, pendingPrompts, postPermission, promptInput, readPrompt } from '../dashboard/src/lib/permissions.ts';

const XSS = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const prompt = (o: any = {}) => ({ id: 'p1', tool: 'Bash', input: '{"command":"cp a b"}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-14T00:00:01Z', ...o });

test('pendingPrompts flattens the pool oldest first, optionally for one scope, and drops malformed prompts', () => {
  const pool: any = {
    inbox: { scope: '_inbox', permissions: [prompt({ id: 'i1', at: '2026-10-14T00:00:03Z' })] },
    jobs: {
      'job-a': { scope: 'job-a', permissions: [prompt({ id: 'a1', at: '2026-10-14T00:00:02Z' }), { tool: 'Bash' }, 'junk'] },
      'job-b': { scope: 'job-b', permissions: 'not a list' },
      'job-c': { permissions: [prompt({ id: 'c1' })] },
    },
  };
  assert.deepEqual(
    pendingPrompts(pool).map((p) => [p.scope, p.prompt.id]),
    [
      ['job-a', 'a1'],
      ['_inbox', 'i1'],
    ],
  );
  assert.deepEqual(
    pendingPrompts(pool, 'job-a').map((p) => p.prompt.id),
    ['a1'],
  );
  assert.deepEqual(pendingPrompts(null), []);
  assert.deepEqual(pendingPrompts({ inbox: { scope: '_inbox' } } as any), [], 'an older server sends no permissions');
});

test('readPrompt fills every field from untrusted input', () => {
  assert.equal(readPrompt({}), null);
  assert.deepEqual(readPrompt({ id: 'x', tool: 3, sessionRules: ['Bash(ls)', 4], sessionDirs: null }), {
    id: 'x',
    tool: 'unknown',
    input: '{}',
    description: null,
    agentId: null,
    blockedPath: null,
    sessionRules: ['Bash(ls)'],
    sessionDirs: [],
    at: '',
  });
});

test('promptInput shows the command, path or URL alone, else the input as JSON, and leaves text as text', () => {
  assert.equal(promptInput({ tool: 'Bash', input: JSON.stringify({ command: XSS, description: 'x' }) }), XSS);
  assert.equal(promptInput({ tool: 'Write', input: JSON.stringify({ file_path: '/a/b', content: 'hi' }) }), JSON.stringify({ file_path: '/a/b', content: 'hi' }, null, 2), 'other keys matter, so all of it shows');
  assert.equal(promptInput({ tool: 'Read', input: JSON.stringify({ file_path: '/a/b' }) }), '/a/b');
  assert.equal(promptInput({ tool: 'mcp__x__y', input: '{"a":1}' }), '{\n  "a": 1\n}');
  assert.equal(promptInput({ tool: 'Bash', input: '{"command":"cut…' }), '{"command":"cut…', 'a capped input shows as sent');
});

test('grantsMore is true only when allow-for-session adds a rule or a directory', () => {
  assert.equal(grantsMore(prompt()), false);
  assert.equal(grantsMore(prompt({ sessionRules: ['Bash(cp a b)'] })), true);
  assert.equal(grantsMore(prompt({ sessionDirs: ['/x'] })), true);
});

test('postPermission sends the token and only scope, id and decision, and surfaces the server error', async () => {
  const calls: any[] = [];
  const ok: any = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"wanted":true}', { status: 200 });
  };
  assert.deepEqual(await postPermission('job-a', 'p1', 'session', 'tok', ok), { wanted: true });
  assert.equal(calls[0].url, '/api/daemon/permission');
  assert.equal(calls[0].init.headers['x-forge-token'], 'tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { scope: 'job-a', id: 'p1', decision: 'session' });
  const gone: any = async () => new Response('{"error":"that permission prompt is gone"}', { status: 404 });
  await assert.rejects(postPermission('job-a', 'p1', 'allow', 'tok', gone), /prompt is gone/);
});
