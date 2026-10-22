import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gh, ghAsync, ghGraphql, ghJson } from '../lib/integrations/github/gh.ts';
import { ForgeError } from '../lib/core/errors.ts';
import { fakeGh } from './helpers.ts';

test('a hung gh times out', { skip: process.platform === 'win32' }, async () => {
  const fake = fakeGh({ api: { stdout: '{}', sleepMs: 30_000 } });
  const env = { ...process.env, ...fake.env };
  try {
    let t = Date.now();
    assert.throws(
      () => gh(undefined, ['api', 'user'], { env, timeoutMs: 300 }),
      (e: any) => e instanceof ForgeError && e.code === 'external' && e.exitCode === 5 && e.message === 'gh api timed out after 1 s',
    );
    assert.ok(Date.now() - t < 5000, `sync took ${Date.now() - t} ms`);

    t = Date.now();
    const soft = gh(undefined, ['api', 'user'], { env, timeoutMs: 300, allowFail: true });
    assert.deepEqual(soft, { ok: false, stdout: '', stderr: 'gh api timed out after 1 s', status: null, timedOut: true });
    assert.ok(Date.now() - t < 5000, `allowFail took ${Date.now() - t} ms`);

    t = Date.now();
    const r = await ghAsync(undefined, ['api', 'user'], { env, timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.equal(r.code, null);
    assert.equal(r.stderr, 'gh api timed out after 1 s');
    assert.ok(Date.now() - t < 5000, `async took ${Date.now() - t} ms`);
  } finally {
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('ghJson parses gh output and refuses non-JSON', { skip: process.platform === 'win32' }, () => {
  const fake = fakeGh({
    'pr view': '{"number":7,"title":"x"}',
    'pr list': 'not json',
    'issue view': { stderr: 'boom', status: 1 },
    'api graphql': '{"data":{"repository":{"id":"R_1"}}}',
  });
  const env = { ...process.env, ...fake.env };
  try {
    assert.deepEqual(ghJson(undefined, ['pr', 'view', '7'], { env }), { number: 7, title: 'x' });
    assert.throws(
      () => ghJson(undefined, ['pr', 'list'], { env }),
      (e: any) => e instanceof ForgeError && e.code === 'external' && e.exitCode === 5 && e.message === 'gh pr printed output that is not JSON',
    );
    assert.equal(ghJson(undefined, ['pr', 'list'], { env, allowFail: true }), null);
    assert.equal(ghJson(undefined, ['issue', 'view', '1'], { env, allowFail: true }), null);
    assert.throws(() => ghJson(undefined, ['issue', 'view', '1'], { env }), (e: any) => e instanceof ForgeError && e.code === 'external' && /boom/.test(e.message));

    assert.deepEqual(ghGraphql(undefined, 'query($owner: String!, $n: Int!) { x }', { owner: 'o', n: 3 }, { env }), { repository: { id: 'R_1' } });
    const call = fake.calls().at(-1)!;
    assert.deepEqual(call.args, ['api', 'graphql', '-f', 'query=query($owner: String!, $n: Int!) { x }', '-f', 'owner=o', '-F', 'n=3']);
  } finally {
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});
