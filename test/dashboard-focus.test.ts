// The dashboard's focus helpers (issue #177): what the status bar's focus fact and the drawer's Environment section show,
// and the POST wrappers behind them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentModel, focusFact, postEditor, postFocus } from '../dashboard/src/lib/focus.ts';

const dev = (port: number, live: boolean | null = false, name = 'dev') => ({ kind: 'component' as const, name, url: `http://localhost:${port}/`, port, live });
const backing = (port: number, name = 'postgres') => ({ kind: 'backing' as const, name, url: null, port, live: null });
const job = (id: string, state = 'running', extra: Record<string, unknown> = {}) => ({ id, title: id.toUpperCase(), state, worktree: `/wt/${id}`, endpoints: [dev(4100)], ...extra }) as any;

test('focusFact', () => {
  const since = '2026-10-16T00:00:00.000Z';
  assert.equal(focusFact(null), null);
  assert.equal(focusFact({ focus: null, jobs: [job('a')] }), null, 'no focus');
  assert.equal(focusFact({ focus: { id: 'gone', title: 'Gone', since }, jobs: [job('a')] }), null, 'the job is not in the list');
  for (const state of ['done', 'cancelled']) assert.equal(focusFact({ focus: { id: 'a', title: 'A', since }, jobs: [job('a', state)] }), null, state);
  assert.deepEqual(focusFact({ focus: { id: 'a', title: 'A', since }, jobs: [job('a', 'waiting')] }), { id: 'a', title: 'A' });
  assert.equal(focusFact({ focus: { id: 'a', title: 'A', since } }), null, 'no jobs yet');
});

test('environmentModel', () => {
  const a = environmentModel(job('a'), null);
  assert.deepEqual(a, { visible: true, focused: false, focusLabel: 'environment.focus', editorDisabled: false, endpoints: [dev(4100)] });
  const focused = environmentModel(job('a'), 'a');
  assert.equal(focused.focused, true);
  assert.equal(focused.focusLabel, 'environment.unfocus');
  assert.equal(environmentModel(job('a'), 'b').focusLabel, 'environment.focus', 'another job is focused');
  for (const state of ['done', 'cancelled']) assert.equal(environmentModel(job('a', state), null).visible, false, state);
  for (const state of ['queued', 'running', 'waiting', 'blocked', 'failed']) assert.equal(environmentModel(job('a', state), null).visible, true, state);
  const bare = environmentModel(job('a', 'running', { worktree: null, endpoints: [] }), null);
  assert.equal(bare.editorDisabled, true, 'no worktree: Open in editor is disabled');
  assert.deepEqual(bare.endpoints, []);
  assert.deepEqual(environmentModel(job('a', 'running', { endpoints: undefined }), null).endpoints, [], 'an older server sends none');
  const hostile = [
    { ...dev(1, true), url: 'javascript:alert(1)' },
    { ...dev(80), url: 'http://evil.example/' },
    { ...dev(4100), url: 'http://localhost:4100/x' },
    { ...dev(4100), kind: 'shell' },
    { ...dev(4100), live: 'yes' },
    { ...dev(4100), name: '' },
    { ...dev(4100), port: '4100' },
    { ...backing(4105), url: 'http://localhost:4105/' },
    { ...backing(4105), live: false },
    { name: 'dev', url: 'http://localhost:4100/', port: 4100, live: false },
    null,
    'http://localhost:1/',
  ];
  const kept = environmentModel(job('a', 'running', { endpoints: [...hostile, dev(4101, true), dev(4102, null, 'web'), backing(4105)] }), null);
  assert.deepEqual(kept.endpoints, [dev(4101, true), dev(4102, null, 'web'), backing(4105)], 'component rows with a localhost URL the server built, backing rows with none');
  const noDev = environmentModel(job('a', 'running', { endpoints: [dev(4101, null), dev(4102, null, 'web'), backing(4105)] }), null);
  assert.equal(noDev.endpoints.length, 3, 'the rows still show');
});

test('the POST wrappers send JSON with the token and throw the server error', async () => {
  const calls: { url: string; init: any }[] = [];
  const reply = (status: number, body: unknown) => async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  assert.deepEqual(await postFocus('a', 'tok', reply(200, { focus: null, previous: null }) as any), { focus: null, previous: null });
  await postFocus(null, 'tok', reply(200, { focus: null, previous: 'a' }) as any);
  await postEditor('a', 'tok', reply(200, { ok: true, editor: 'code' }) as any);
  assert.deepEqual(
    calls.map((c) => [c.url, c.init.method, c.init.headers['x-forge-token'], c.init.headers['content-type'], c.init.body]),
    [
      ['/api/focus', 'POST', 'tok', 'application/json', '{"job":"a"}'],
      ['/api/focus', 'POST', 'tok', 'application/json', '{"job":null}'],
      ['/api/jobs/a/editor', 'POST', 'tok', 'application/json', '{}'],
    ],
  );
  await assert.rejects(postEditor('a', 'tok', reply(409, { error: 'no editor "code" found: set FORGE_EDITOR to your editor\'s command' }) as any), /set FORGE_EDITOR/);
  await assert.rejects(postFocus('a', 'tok', reply(403, 'bad token') as any), /bad token/);
});
