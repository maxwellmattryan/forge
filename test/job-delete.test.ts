// `forge job delete` and POST /api/jobs/:id/delete: what goes with the job, what is kept, every
// refusal (checked before anything changes), and the drawer card's helpers.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { startServer } from '../lib/server/start.ts';
import { FIXTURE_DIST } from './dist.ts';
import { confirmMatches, deleteBlocker } from '../dashboard/src/lib/delete-job.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  const r = spawnSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: dir } });
  if (r.status !== 0) throw new Error(r.stderr);
  fs.rmSync(answers);
});

function scratch() {
  const repo = template();
  const root = repo.dir;
  const f = async (...args: string[]) => {
    const r = await forgeAsync(root, args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const job = async (title: string, ...extra: string[]) => (await f('job', 'new', '--title', title, ...extra)).id as string;
  const jobFile = (id: string) => path.join(root, '.forge', 'jobs', id, 'job.json');
  const patchJob = (id: string, patch: Record<string, unknown>) => fs.writeFileSync(jobFile(id), JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile(id), 'utf8')), ...patch }));
  const branches = () => String(repo.git('branch', '--format=%(refname:short)')).split('\n').filter(Boolean);
  const retention = () => {
    const file = path.join(root, '.forge', 'runtime', 'retention.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${root}.wt`, { recursive: true, force: true });
  };
  return { root, git: repo.git, f, job, jobFile, patchJob, branches, retention, cleanup };
}

describe('forge job delete', { concurrency: 4 }, () => {
  test('removes the job dir, worktree, Forge-named branch and session files, rejects open requests, and logs it', async () => {
    const s = scratch();
    try {
      const id = await s.job('Started by mistake');
      const wt = await s.f('worktree', 'create', id);
      assert.ok(fs.existsSync(wt.path));
      assert.ok(s.branches().includes(`forge/${id}`));
      const rq = await s.f('requests', 'add', 'resume', '--job', id);
      const daemons = path.join(s.root, '.forge', 'runtime', 'daemons');
      fs.mkdirSync(daemons, { recursive: true });
      fs.writeFileSync(path.join(daemons, `${id}.log`), 'line\n');
      fs.writeFileSync(path.join(daemons, `${id}.json`), '{}');
      const other = await s.job('Keep me');

      const out = await s.f('job', 'delete', id);
      assert.equal(out.deleted, id);
      assert.equal(out.title, 'Started by mistake');
      assert.equal(out.worktree, wt.path);
      assert.equal(out.branch, `forge/${id}`);
      assert.equal(out.requests, 1);

      assert.ok(!fs.existsSync(path.dirname(s.jobFile(id))));
      assert.ok(!fs.existsSync(wt.path));
      assert.ok(!s.branches().includes(`forge/${id}`));
      assert.ok(!fs.existsSync(path.join(daemons, `${id}.log`)));
      assert.ok(!fs.existsSync(path.join(daemons, `${id}.json`)));
      assert.ok(!fs.existsSync(path.join(s.root, '.forge', 'archive', `${id}.json`)), 'nothing is archived');
      assert.ok(fs.existsSync(s.jobFile(other)), 'other jobs stay');
      const all = await s.f('requests', 'list', '--all');
      assert.equal(all.find((r: { id: string }) => r.id === rq.id).status, 'rejected');
      const [line] = s.retention();
      assert.deepEqual({ type: line.type, kind: line.kind, id: line.id, title: line.title, trigger: line.trigger }, { type: 'deleted', kind: 'job', id, title: 'Started by mistake', trigger: 'cli' });

      const again = await forgeAsync(s.root, ['job', 'delete', id]);
      assert.equal(again.status, 1);
      assert.match(again.stderr, /no job/);
    } finally {
      s.cleanup();
    }
  });

  test('keeps a branch Forge did not name', async () => {
    const s = scratch();
    try {
      s.git('branch', 'my-own-work');
      const id = await s.job('Continue a branch', '--branch', 'my-own-work');
      const out = await s.f('job', 'delete', id);
      assert.equal(out.branch, null);
      assert.ok(s.branches().includes('my-own-work'));
    } finally {
      s.cleanup();
    }
  });

  test('refuses real work and dependents, with nothing changed', async () => {
    const s = scratch();
    try {
      const withPr = await s.job('Has a PR');
      s.patchJob(withPr, { pr: { number: 7, state: 'OPEN' } });
      const evalJob = await s.job('An eval');
      s.patchJob(evalJob, { kind: 'eval' });
      const parent = await s.job('Parent');
      const child = await s.job('Child', '--parent', parent);
      s.patchJob(parent, { children: [child] });
      const dep = await s.job('Dependency');
      await s.f('job', 'set', child, '--field', `dependsOn=["${dep}"]`);
      // --session claims it with a fresh heartbeat: a live interactive owner.
      const owned = await s.job('Owned', '--session', 'sess-1');

      const cases: [string, RegExp][] = [
        [withPr, /has PR #7; cancel it and archive it/],
        [evalJob, /eval jobs stay with their run/],
        [parent, new RegExp(`split children \\(${child}\\)`)],
        [dep, new RegExp(`needed by ${child}`)],
        [owned, /owned by live session sess-1; stop that session or pass --force/],
      ];
      for (const [id, why] of cases) {
        const before = fs.readFileSync(s.jobFile(id), 'utf8');
        const r = await forgeAsync(s.root, ['job', 'delete', id]);
        assert.equal(r.status, 1, id);
        assert.match(r.stderr, why);
        assert.equal(fs.readFileSync(s.jobFile(id), 'utf8'), before, `${id} is untouched`);
      }
      // --force lets a live interactive owner go.
      await s.f('job', 'delete', owned, '--force');
      assert.ok(!fs.existsSync(s.jobFile(owned)));
      assert.deepEqual(s.retention().map((l) => l.id), [owned]);
    } finally {
      s.cleanup();
    }
  });

  test('is a usage error without one id, and refused in a daemon session', async () => {
    const s = scratch();
    try {
      const id = await s.job('Kept');
      assert.equal((await forgeAsync(s.root, ['job', 'delete'])).status, 2);
      assert.equal((await forgeAsync(s.root, ['job', 'delete', id, 'extra'])).status, 2);
      const d = await forgeAsync(s.root, ['job', 'delete', id], { FORGE_DAEMON: '1' });
      assert.equal(d.status, 1);
      assert.ok(fs.existsSync(s.jobFile(id)));
    } finally {
      s.cleanup();
    }
  });
});

function hit(port: number, o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

test('POST /api/jobs/:id/delete needs the token and the id typed back, and answers refusals with 409', { timeout: 60_000 }, async () => {
  const s = scratch();
  const srv = await startServer(s.root, { port: 0, distDir: FIXTURE_DIST });
  try {
    const port = Number(new URL(srv.url).port);
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)![1];
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (id: string, body: unknown, headers: Record<string, string> = good) => hit(port, { method: 'POST', path: `/api/jobs/${id}/delete`, headers, body: JSON.stringify(body) });

    const id = await s.job('Oops');
    const withPr = await s.job('Has a PR');
    s.patchJob(withPr, { pr: { number: 3, state: 'MERGED' } });

    assert.equal((await post(id, { confirm: id }, { ...good, 'x-forge-token': 'nope' })).status, 403);
    assert.equal((await post(id, {})).status, 400);
    assert.equal((await post(id, { confirm: 'something-else' })).status, 400);
    assert.equal((await post('no-such-job', { confirm: 'no-such-job' })).status, 404);
    const refused = await post(withPr, { confirm: withPr });
    assert.equal(refused.status, 409);
    assert.match(JSON.parse(refused.text).error, /has PR #3/);
    assert.ok(fs.existsSync(s.jobFile(id)), 'nothing deleted so far');

    const ok = await post(id, { confirm: id });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).deleted, id);
    assert.ok(!fs.existsSync(s.jobFile(id)));
    assert.equal(s.retention().at(-1).trigger, 'dashboard');
    const state = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.ok(!state.jobs.some((j: { id: string }) => j.id === id));
  } finally {
    await srv.close();
    s.cleanup();
  }
});

test('the drawer card offers the delete only without a PR and outside evals, and arms on the exact id', () => {
  assert.equal(deleteBlocker({ kind: 'feature', pr: null }), null);
  assert.equal(deleteBlocker({ kind: 'feature', pr: { number: 4 } as never }), 'pr');
  assert.equal(deleteBlocker({ kind: 'eval', pr: null }), 'eval');
  assert.ok(confirmMatches(' abc-1 ', 'abc-1'));
  assert.ok(!confirmMatches('abc', 'abc-1'));
  assert.ok(!confirmMatches('', 'abc-1'));
});
