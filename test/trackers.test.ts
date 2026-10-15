import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { loadTracker } from '../lib/trackers/index.ts';
import { token } from './secret-fixtures.ts';
import { defaults } from '../lib/config.ts';
import { createJob, setJob } from '../lib/jobs.ts';
import local from '../lib/trackers/local.ts';
import { statusKey } from '../lib/trackers/status.ts';
import { statusMap } from '../lib/trackers/github.ts';
import { scoreItems, searchTerms } from '../lib/issue-link.ts';
import { execFileSync } from 'node:child_process';

test('local backlog: create, list, claim, update, close', () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const ctx = { root: repo.dir, config };
    fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.forge', 'backlog.md'), '# Backlog\n\n- [ ] First thing\n  with a description\n- [x] Old thing\n');
    local.create(ctx, { title: 'Second thing', body: 'more detail' });
    let ready = local.list(ctx, { ready: true });
    assert.deepEqual(ready.map((i) => i.ref), ['first-thing', 'second-thing']);
    assert.equal(local.get(ctx, 'first-thing').body, 'with a description');

    const job = createJob(repo.dir, config, { title: 'First thing', ref: 'first-thing' });
    assert.deepEqual(local.claim(ctx, 'first-thing', job), { ok: true });
    assert.equal(local.claim(ctx, 'first-thing', { id: 'someone-else' } as any).ok, false);
    ready = local.list(ctx, { ready: true });
    assert.deepEqual(ready.map((i) => i.ref), ['second-thing']);

    local.update(ctx, 'first-thing', setJob(repo.dir, job.id, { stage: 'done', state: 'done' }));
    assert.match(fs.readFileSync(path.join(repo.dir, '.forge', 'backlog.md'), 'utf8'), /- \[x\] First thing → first-thing/);
    local.close(ctx, 'second-thing', { reason: 'not-planned' });
    assert.equal(local.get(ctx, 'second-thing').status, 'dropped');
  } finally {
    repo.cleanup();
  }
});

test('status keys and project option matching', () => {
  assert.equal(statusKey({ state: 'running', stage: 'build' }), 'in-progress');
  assert.equal(statusKey({ state: 'waiting', stage: 'spec', waitingOn: 'spec-approval' }), 'blocked');
  assert.equal(statusKey({ state: 'waiting', stage: 'pr', waitingOn: 'pr-review' }), 'review');
  assert.equal(statusKey({ state: 'done', stage: 'done' }), 'done');
  const config = defaults();
  const options = ['📚 Backlog', '🚫 Blocked', '🔖 Todo', '⏸️ Paused', '🏗 In Progress', '🔎 In Review', '🎉 Done'];
  const map = statusMap({ config }, options);
  assert.deepEqual(map, { queued: '🔖 Todo', 'in-progress': '🏗 In Progress', review: '🔎 In Review', blocked: '🚫 Blocked', done: '🎉 Done', cancelled: null });
  config.tracker.github.project.statusMap = { blocked: '⏸️ Paused' };
  assert.equal(statusMap({ config }, options).blocked, '⏸️ Paused');
});

test('local search is scored and bounded', () => {
  const repo = tempRepo();
  const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: repo.dir } }));
  try {
    const answers = path.join(repo.dir, '.answers.json');
    fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false } }));
    cli('init', 'write', '--answers', answers);
    const many = Array.from({ length: 25 }, (_, n) => `- [ ] Widget number ${n}`).join('\n');
    fs.writeFileSync(
      path.join(repo.dir, '.forge', 'backlog.md'),
      `# Backlog\n\n- [ ] Plain gadget\n  mentions widget and export\n- [ ] Export widget data\n  export as widget csv\n- [x] Export widget done\n- [~] Export claimed → someone\n${many}\n`,
    );
    const r = cli('tracker', 'search', 'export', 'widget', '--limit', '3');
    assert.equal(r.tracker, 'local');
    assert.equal(r.query, 'export widget');
    // Both terms in title and body (6) first; then ties at 2 in backlog order, an in-progress item included.
    assert.deepEqual(r.items.map((i) => [i.ref, i.score]), [['export-widget-data', 6], ['plain-gadget', 2], ['export-claimed', 2]]);
    assert.ok(r.items.every((i) => !('body' in i)), 'bodies never appear');
    assert.deepEqual(Object.keys(r.items[0]), ['ref', 'title', 'url', 'labels', 'status', 'claimedBy', 'score']);
    assert.equal(cli('tracker', 'search', 'widget', '--limit', '50').items.length, 20, 'the limit is clamped to 20');
    assert.equal(cli('tracker', 'search', 'widget', '--limit', '0').items.length, 1, 'and to at least 1');
    assert.equal(cli('tracker', 'search', 'widget').items.length, 5, 'the default is 5');
    assert.deepEqual(cli('tracker', 'search', 'the', 'and').items, [], 'stopwords only: nothing to search for');

    const job = cli('job', 'new', '--title', 'Add CSV export for widgets');
    assert.equal(cli('tracker', 'search', '--job', job.id).query, 'csv export widgets');
  } finally {
    repo.cleanup();
  }
});

test('searchTerms drops stopwords and short words and keeps at most 6', () => {
  assert.deepEqual(searchTerms('Add a dark-mode toggle to the Settings page'), ['dark', 'mode', 'toggle', 'settings', 'page']);
  assert.deepEqual(searchTerms('Fix it: the API is slow, slow, SLOW'), ['api', 'slow']);
  assert.deepEqual(searchTerms('one two three four five six seven eight nine'), ['one', 'two', 'three', 'four', 'five', 'six']);
  assert.deepEqual(searchTerms('Café résumé'), ['cafe', 'resume']);
  assert.deepEqual(searchTerms(''), []);
  assert.deepEqual(
    scoreItems([{ ref: 'a', title: 'x', body: 'csv' }, { ref: 'b', title: 'CSV export' }, { ref: 'c', title: 'nothing' }, { ref: 'd', title: 'csv', body: 'csv' }], ['csv', 'export']).map((i) => [i.ref, i.score]),
    [['b', 4], ['d', 3], ['a', 1]],
  );
});

// A custom adapter that records every call it receives, so a refused write shows as a missing line.
const RECORDING_ADAPTER = `import fs from 'node:fs';
import path from 'node:path';
const log = (ctx, line) => fs.appendFileSync(path.join(ctx.root, 'calls.log'), line + '\\n');
export default {
  name: 'rec',
  list: () => [],
  get: () => null,
  claim(ctx, ref) { log(ctx, 'claim ' + ref); return { ok: true }; },
  update(ctx, ref) { log(ctx, 'update ' + ref); },
  comment(ctx, ref) { log(ctx, 'comment ' + ref); },
  create(ctx) { log(ctx, 'create'); return { ref: 'R-2' }; },
  close() {},
};
`;

test('tracker writes refuse a likely secret', async () => {
  const repo = tempRepo();
  try {
    const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
    fs.writeFileSync(answers, '{}');
    assert.equal((await forgeAsync(repo.dir, ['init', 'write', '--answers', answers])).status, 0);
    fs.rmSync(answers);
    const backlog = path.join(repo.dir, '.forge', 'backlog.md');
    if (!fs.existsSync(backlog)) fs.writeFileSync(backlog, '# Backlog\n');
    const before = fs.readFileSync(backlog);
    const key = token.github('tracker');
    const r = await forgeAsync(repo.dir, ['tracker', 'create', '--title', 'T', '--body', `use ${key}`, '--json']);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error.code, 'secret_found');
    assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key));
    assert.deepEqual(fs.readFileSync(backlog), before, 'the backlog is byte-identical');

    // A custom adapter: no comment for a token body, no update for a job whose title holds one.
    fs.mkdirSync(path.join(repo.dir, '.forge', 'trackers'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.forge', 'trackers', 'rec.mjs'), RECORDING_ADAPTER);
    const config = defaults();
    config.tracker.kind = 'rec';
    const ctx = { root: repo.dir, config };
    const calls = () => (fs.existsSync(path.join(repo.dir, 'calls.log')) ? fs.readFileSync(path.join(repo.dir, 'calls.log'), 'utf8').trim().split('\n') : []);
    const rec = await loadTracker(repo.dir, config);
    const refused = (e: any) => e.code === 'secret_found' && !e.message.includes(key);
    assert.throws(() => rec.comment(ctx, 'R-1', `token: ${key}`), refused);
    assert.throws(() => rec.create(ctx, { title: 'ok', body: `token: ${key}` }), refused);
    const leaky = createJob(repo.dir, defaults(), { title: `Rotate ${key}` });
    assert.throws(() => rec.update(ctx, 'R-1', leaky), refused);
    const claimed = rec.claim(ctx, 'R-1', leaky);
    assert.equal(claimed.ok, false, 'a refused claim reads like any refused claim, so callers cancel');
    assert.match(String(claimed.reason), /^possible secret in the job's title or reason: github-token/);
    assert.ok(!String(claimed.reason).includes(key));
    assert.deepEqual(calls(), [], 'the adapter was never called');
    rec.comment(ctx, 'R-1', 'all clear');
    const clean = createJob(repo.dir, defaults(), { title: 'Rotate the key' });
    assert.deepEqual(rec.claim(ctx, 'R-1', clean), { ok: true });
    assert.deepEqual(calls(), ['comment R-1', 'claim R-1'], 'clean writes go through');

    // The built-in local update sends only a status: the same job is not refused.
    const lctx = { root: repo.dir, config: defaults() };
    const loc = await loadTracker(repo.dir, defaults());
    const item = loc.create(lctx, { title: 'Rotate', body: 'plain' });
    loc.update(lctx, item.ref, leaky);

    // forge job link --create reads request.md, which holds the token.
    const job = await forgeAsync(repo.dir, ['job', 'new', '--title', 'Leaky request', '--body', `the key is ${key}`]);
    const id = JSON.parse(job.stdout).id;
    const linked = await forgeAsync(repo.dir, ['job', 'link', id, '--create', '--json']);
    assert.equal(linked.status, 1);
    assert.equal(JSON.parse(linked.stdout).error.code, 'secret_found');
  } finally {
    repo.cleanup();
  }
});
