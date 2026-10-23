import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { token } from './secret-fixtures.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, setJob } from '#core/job/store.ts';
import local from '#integrations/backlog/tracker.ts';
import { statusKey } from '#api/tracker.ts';
import { statusMap } from '#integrations/github/tracker.ts';
import { scoreItems, searchTerms } from '#core/job/issue-link.ts';
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

    const job = createJob(repo.dir, config, { title: 'First thing', issues: [{ tracker: 'local', ref: 'first-thing', url: null }] });
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

test('local backlog: [?] needs-info mark and note line', () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const ctx = { root: repo.dir, config };
    const file = path.join(repo.dir, '.forge', 'backlog.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '# Backlog\n\n- [?] Vague thing\n  some words\n  Needs info: a clear outcome\n- [ ] Clear thing\n  line one\n  line two\n- [~] Taken thing → job-1\n- [x] Done thing\n- [-] Dropped thing\n',
    );
    const read = () => fs.readFileSync(file, 'utf8');
    const vague = local.get(ctx, 'vague-thing')!;
    assert.equal(vague.status, 'needs-info');
    assert.equal(vague.needsInfo, true);
    assert.equal(vague.body, 'some words', 'the note line is never part of the body');
    assert.equal(local.get(ctx, 'clear-thing')!.needsInfo, false);
    assert.deepEqual(local.list(ctx, { ready: true }).map((i) => i.ref), ['clear-thing']);
    assert.deepEqual(local.search!(ctx, 'vague', { limit: 5 }).map((i) => i.ref), ['vague-thing'], 'search includes needs-info items');

    // Set: the mark becomes [?] and one note line goes right after the body, keeping it contiguous.
    local.setNeedsInfo!(ctx, 'clear-thing', 'acceptance criteria or a reproduction');
    assert.match(read(), /- \[\?\] Clear thing\n {2}line one\n {2}line two\n {2}Needs info: acceptance criteria or a reproduction\n- \[~\] Taken thing/);
    assert.equal(local.get(ctx, 'clear-thing')!.body, 'line one\nline two');
    // Replace: still a single note line.
    local.setNeedsInfo!(ctx, 'clear-thing', 'a bounded scope');
    assert.equal(read().match(/Needs info:/g)!.length, 2);
    assert.match(read(), /line two\n {2}Needs info: a bounded scope\n- \[~\]/);
    // Clear: the line goes and [?] turns back into [ ].
    local.setNeedsInfo!(ctx, 'clear-thing', null);
    assert.match(read(), /- \[ \] Clear thing\n {2}line one\n {2}line two\n- \[~\] Taken thing/);
    local.setNeedsInfo!(ctx, 'vague-thing', null);
    assert.match(read(), /- \[ \] Vague thing\n {2}some words\n- \[ \] Clear thing/);
    assert.ok(!read().includes('Needs info:'));

    // Never touches [~], [x] or [-].
    const before = read();
    for (const ref of ['taken-thing', 'done-thing', 'dropped-thing']) {
      local.setNeedsInfo!(ctx, ref, 'a clear outcome');
      local.setNeedsInfo!(ctx, ref, null);
    }
    assert.equal(read(), before);

    // A [?] item is still claimable on purpose.
    local.setNeedsInfo!(ctx, 'vague-thing', 'a clear outcome');
    const job = createJob(repo.dir, config, { title: 'Vague thing', issues: [{ tracker: 'local', ref: 'vague-thing', url: null }] });
    assert.deepEqual(local.claim(ctx, 'vague-thing', job), { ok: true });
    assert.equal(local.get(ctx, 'vague-thing')!.status, 'in-progress');
    assert.equal(local.get(ctx, 'vague-thing')!.body, 'some words');
  } finally {
    repo.cleanup();
  }
});

// A stand-in `gh`: each call's argv goes to the log one element per line, then a separator.
const FAKE_GH = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_GH_LOG"; done
echo '--' >> "$FAKE_GH_LOG"
case "$1 $2" in
  "issue list") cat "$FAKE_GH_ISSUES" ;;
  "issue view") cat "$FAKE_GH_ISSUE" ;;
esac
`;

test('github: needs-info label', { skip: process.platform === 'win32' }, async () => {
  const repo = tempRepo();
  const bin = path.join(repo.dir, '..', `fakebin-${path.basename(repo.dir)}`);
  const saved = { ...process.env };
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    const log = path.join(bin, 'calls.log');
    const issues = path.join(bin, 'issues.json');
    const issue = path.join(bin, 'issue.json');
    fs.writeFileSync(log, '');
    fs.writeFileSync(
      issues,
      JSON.stringify([
        { number: 1, title: 'Vague', url: 'https://github.com/o/r/issues/1', labels: [{ name: 'forge:needs-info' }], assignees: [] },
        { number: 2, title: 'Clear', url: 'https://github.com/o/r/issues/2', labels: [], assignees: [] },
        { number: 3, title: 'Running', url: 'https://github.com/o/r/issues/3', labels: [{ name: 'forge:in-progress' }], assignees: [] },
      ]),
    );
    fs.writeFileSync(issue, JSON.stringify({ number: 1, title: 'Vague', body: 'b', url: 'https://github.com/o/r/issues/1', labels: [{ name: 'forge:needs-info' }, { name: 'bug' }], assignees: [], comments: [], state: 'OPEN', author: { login: 'a' } }));
    Object.assign(process.env, { PATH: `${bin}${path.delimiter}${saved.PATH}`, FAKE_GH_LOG: log, FAKE_GH_ISSUES: issues, FAKE_GH_ISSUE: issue });
    const config = defaults();
    config.tracker.kind = 'github';
    config.tracker.github.repo = 'o/r';
    const ctx = { root: repo.dir, config };
    const gh = await loadTracker(repo.dir, config);
    const all = gh.list(ctx, {});
    assert.deepEqual(all.map((i) => [i.ref, i.needsInfo, i.claimedBy]), [['1', true, null], ['2', false, null], ['3', false, 'forge (label)']], 'needs-info is not a claim');
    assert.deepEqual(gh.list(ctx, { ready: true }).map((i) => i.ref), ['2']);
    assert.equal(gh.get(ctx, '1')!.needsInfo, true);

    const calls = () => fs.readFileSync(log, 'utf8').split('--\n').filter(Boolean).map((c) => c.split('\n').filter(Boolean));
    fs.writeFileSync(log, '');
    gh.setNeedsInfo!(ctx, '2', 'acceptance criteria or a reproduction');
    assert.deepEqual(calls(), [
      ['label', 'create', 'forge:needs-info', '-R', 'o/r', '--color', 'D97706', '--description', 'Forge: needs more information', '--force'],
      ['issue', 'edit', '2', '-R', 'o/r', '--add-label', 'forge:needs-info'],
    ]);
    assert.ok(!calls().flat().some((a) => a.includes('acceptance')), 'the note never reaches gh');
    fs.writeFileSync(log, '');
    gh.setNeedsInfo!(ctx, '1', null);
    assert.deepEqual(calls(), [['issue', 'edit', '1', '-R', 'o/r', '--remove-label', 'forge:needs-info']]);

    // A claim with label sync drops it like any other stale prefix label.
    config.tracker.github.statusSync = 'labels';
    fs.writeFileSync(log, '');
    gh.update(ctx, '1', { state: 'running', stage: 'build' } as any);
    const edit = calls().find((c) => c[0] === 'issue' && c[1] === 'edit')!;
    assert.deepEqual(edit, ['issue', 'edit', '1', '-R', 'o/r', '--add-label', 'forge:in-progress', '--remove-label', 'forge:needs-info']);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(bin, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('mirror and approval comment act on each native issue', async () => {
  const repo = tempRepo();
  try {
    const { commentApproval } = await import('../lib/cli/commands/tracker.ts');
    const { mirrorToTracker } = await import('#engine/trackers/mirror.ts');
    const { logEvent, loadJob } = await import('#core/job/store.ts');
    const calls: string[] = [];
    (globalThis as any).__issueRefsCalls = calls;
    fs.mkdirSync(path.join(repo.dir, '.forge', 'trackers'), { recursive: true });
    fs.writeFileSync(
      path.join(repo.dir, '.forge', 'trackers', 'acme.mjs'),
      `const log = (s) => globalThis.__issueRefsCalls.push(s);
export default { name: 'acme', list: () => [], get: () => null, claim: () => ({ ok: true }), update(_c, ref, job) { log('update ' + ref + ' ' + job.state); }, comment(_c, ref) { log('comment ' + ref); }, create: () => ({ ref: 'A-9' }), close() {} };
`,
    );
    const config = defaults();
    config.tracker.kind = 'acme';
    const acme = (ref: string) => ({ tracker: 'acme', ref, url: null });
    const a = createJob(repo.dir, config, { title: 'Sharer A', issues: [acme('A-1'), acme('A-2'), { tracker: 'github', ref: 'o/r#3', url: null }] });
    createJob(repo.dir, config, { title: 'Sharer B', issues: [acme('A-2')] });
    setJob(repo.dir, a.id, { stage: 'build', state: 'running' });
    await mirrorToTracker(repo.dir, config, loadJob(repo.dir, a.id));
    assert.deepEqual(calls.splice(0), ['update A-1 running', 'update A-2 running'], 'each native issue, never another kind');
    setJob(repo.dir, a.id, { stage: 'done', state: 'done' });
    await mirrorToTracker(repo.dir, config, loadJob(repo.dir, a.id));
    assert.deepEqual(calls.splice(0), ['update A-1 done'], 'a finished job leaves a shared issue alone');

    setJob(repo.dir, a.id, { owned: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED' } } });
    logEvent(repo.dir, a.id, 'transition', { from: { stage: 'decide', state: 'running', waitingOn: null }, to: { stage: 'decide', state: 'waiting', waitingOn: 'escalation' }, reason: 'auth change' });
    logEvent(repo.dir, a.id, 'human', { action: 'approve', note: 'ok', actor: { login: 'alice', source: 'env' } });
    logEvent(repo.dir, a.id, 'transition', { from: { stage: 'decide', state: 'waiting', waitingOn: 'escalation' }, to: { stage: 'integrate', state: 'running', waitingOn: null } });
    await commentApproval(repo.dir, config, loadJob(repo.dir, a.id));
    await commentApproval(repo.dir, config, loadJob(repo.dir, a.id));
    assert.deepEqual(calls.splice(0), ['comment A-1', 'comment A-2'], 'each native issue, once');
    const { readEvents } = await import('#core/job/store.ts');
    const ev = readEvents(repo.dir, a.id).filter((e) => e.type === 'tracker-approval-comment') as any[];
    assert.deepEqual(ev.map((e) => [e.refs, e.pr]), [[['A-1', 'A-2'], 7]]);
  } finally {
    delete (globalThis as any).__issueRefsCalls;
    repo.cleanup();
  }
});
