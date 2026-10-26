// Mandates over the dashboard API, the Foreman page's reads and writes: the list with its directives,
// grantable classes and defaults, the detail with the owner's guidance, and the writes through the same
// mandateWrite `forge mandate` calls, as the dashboard, with the CLI's refusals. A refused write writes
// nothing. The POSTs' and the detail's guards are security.test.ts's rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { forgeInProcess, initMilestoneRepo, repoTemplate, serveProjects } from '../../helpers.ts';
import { logDirective } from '#office/mandates/directives.ts';

// The foreman on, delegating four classes, one of them reserved with gate:<class>.
const template = repoTemplate((dir) => initMilestoneRepo(dir, { decides: ['spec-approval', 'conflicts', 'escalation', 'milestone-approval'], reserved: ['gate:conflicts'] }));

function hit(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

/** A served repo and its calls: GET with or without the token, and a guarded POST. */
async function served() {
  const repo = template();
  const s = await serveProjects([{ dir: repo.dir, name: 'p' }]);
  const port = s.port;
  const api = s.api('p', '');
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)![1]!;
  const headers = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  const mandatesDir = path.join(repo.dir, '.forge', 'runtime', 'mandates');
  const audit = path.join(repo.dir, '.forge', 'runtime', 'audit.jsonl');
  return {
    repo,
    get: (p: string, auth = false) => hit(port, { path: `${api}${p}`, headers: auth ? { 'x-forge-token': token } : {} }),
    post: (p: string, body: unknown) => hit(port, { method: 'POST', path: `${api}${p}`, headers, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    file: (id: string) => fs.readFileSync(path.join(mandatesDir, `${id}.md`), 'utf8'),
    auditEvents: () => (fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    /** Every file under the mandates dir with its bytes, and the repo audit log: what a refused write must leave alone. */
    snapshot: () => {
      const files = fs.existsSync(mandatesDir) ? (fs.readdirSync(mandatesDir, { recursive: true }) as string[]).sort() : [];
      const body = files.map((f) => [f, fs.statSync(path.join(mandatesDir, f)).isFile() ? fs.readFileSync(path.join(mandatesDir, f), 'utf8') : 'dir']);
      return { body, audit: fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8') : '' };
    },
    cleanup: async () => {
      await s.cleanup();
      repo.cleanup();
    },
  };
}

test('mandates over the dashboard API', async () => {
  const t = await served();
  try {
    // AC5: a new mandate takes every other term from foreman.mandate, the default decides cut to the grantable classes.
    const created = await t.post('/mandates', { id: 'm1', title: 'First', milestones: ['M1'], body: 'Prefer small PRs.' });
    assert.equal(created.status, 200, created.text);
    assert.deepEqual([created.json.ok, created.json.changed, created.json.mandate.status, created.json.mandate.state], [true, true, 'active', 'active']);
    assert.deepEqual(created.json.mandate.contract, {
      until: 'merge-ready',
      maxJobs: 2,
      order: 'graph',
      decides: ['spec-approval'],
      budget: { usd: 150, jobs: 5 },
      stall: { cadences: 3, bounces: 3 },
      onUnfinishable: 'park',
    });
    const newEvent = t.auditEvents().find((e) => e.type === 'mandate-new' && e.mandate === 'm1');
    assert.equal(newEvent?.actor?.source, 'dashboard');
    const dup = await t.post('/mandates', { id: 'm1', title: 'Again', milestones: ['M1'] });
    assert.deepEqual([dup.status, dup.json.error], [409, 'mandate m1 exists; change it with forge mandate edit']);

    // A second link, a goal mandate and an unreadable file, then the directives.
    assert.equal((await t.post('/mandates', { id: 'm2', title: 'Second', labels: ['infra'], after: 'm1' })).status, 200);
    const goal = await forgeInProcess(t.repo.dir, ['mandate', 'new', 'g1', '--title', 'Goal', '--goal', 'Halve review rounds']);
    assert.equal(goal.status, 0, JSON.stringify(goal.error));
    fs.writeFileSync(path.join(t.repo.dir, '.forge', 'runtime', 'mandates', 'bad.md'), 'not a mandate\n');
    for (let i = 0; i < 55; i++) logDirective(t.repo.dir, { mandate: 'm1', action: 'note', reason: `note ${i}`, actor: { login: null, source: 'foreman' } });

    // AC3: the list.
    const list = await t.get('/mandates');
    assert.equal(list.status, 200, list.text);
    const byId = Object.fromEntries(list.json.mandates.map((m: { id: string }) => [m.id, m]));
    assert.deepEqual(Object.keys(byId).sort(), ['bad', 'g1', 'm1', 'm2']);
    assert.deepEqual(byId.bad, { id: 'bad', problem: 'no frontmatter between --- lines' });
    const m1 = byId.m1;
    assert.equal(m1.title, 'First');
    assert.deepEqual(m1.effective.decides, ['spec-approval']);
    assert.deepEqual(m1.capped, []);
    assert.deepEqual([m1.chain, m1.activeLink], [['m1', 'm2'], 'm1']);
    assert.deepEqual(m1.progress.jobs, { reached: 0, inFlight: 0, handled: 0, unfinishable: 0 });
    assert.deepEqual([m1.progress.spend, m1.progress.started], [{ usd: 0, budget: 150 }, { jobs: 0, budget: 5 }]);
    assert.equal(typeof m1.progress.lastActivity, 'string');
    assert.equal(m1.draft, null);
    assert.equal(byId.m2.state, 'waiting');
    assert.deepEqual(byId.g1.draft, { status: 'queued', gate: 'none' });
    for (const m of list.json.mandates) assert.ok(!('body' in m) && !('goal' in m), `${m.id} carries no body or goal`);
    assert.equal(list.json.directives.length, 50);
    assert.deepEqual([list.json.directives[0].reason, list.json.directives.at(-1).reason], ['note 5', 'note 54'], 'the latest 50, oldest first');
    assert.deepEqual(list.json.grantable, ['spec-approval', 'escalation', 'milestone-approval']);
    assert.deepEqual(list.json.defaults, created.json.mandate.contract);

    // AC4: the detail, with the token.
    const detail = await t.get('/mandates/m1', true);
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual([detail.json.id, detail.json.body, detail.json.goal, detail.json.directives.length], ['m1', 'Prefer small PRs.', null, 20]);
    assert.equal((await t.get('/mandates/g1', true)).json.goal, 'Halve review rounds');
    for (const p of ['/mandates/..%2Fx', '/mandates/none', '/mandates/nope']) assert.equal((await t.get(p, true)).status, 404, p);
    assert.equal((await t.get('/mandates/bad', true)).status, 409);

    // AC6: an edit replaces only the terms sent, pinned to the updatedAt it read.
    const before = created.json.mandate.updatedAt;
    const edited = await t.post('/mandates/m1/edit', { updatedAt: before, maxJobs: 3 });
    assert.equal(edited.status, 200, edited.text);
    assert.deepEqual([edited.json.changed, edited.json.mandate.contract.maxJobs, edited.json.mandate.title, edited.json.mandate.scope.milestones], [true, 3, 'First', ['M1']]);
    const same = await t.post('/mandates/m1/edit', { updatedAt: edited.json.mandate.updatedAt, maxJobs: 3 });
    assert.deepEqual([same.status, same.json.changed], [200, false]);
    const file = t.file('m1');
    const stale = await t.post('/mandates/m1/edit', { updatedAt: before, maxJobs: 4 });
    assert.deepEqual([stale.status, stale.json.error], [409, 'mandate m1 changed since you read it; reload and edit again']);
    assert.equal(t.file('m1'), file, 'a stale edit leaves the file byte-identical');

    // AC7: the status moves, each idempotent; pause and close keep the reason.
    const paused = await t.post('/mandates/m1/pause', { reason: 'waiting on infra' });
    assert.deepEqual([paused.status, paused.json.changed, paused.json.mandate.status, paused.json.mandate.reason], [200, true, 'paused', 'waiting on infra']);
    assert.deepEqual([(await t.post('/mandates/m1/pause', {})).json.changed], [false]);
    const resumed = await t.post('/mandates/m1/resume', {});
    assert.deepEqual([resumed.json.changed, resumed.json.mandate.status, resumed.json.mandate.reason], [true, 'active', null]);
    assert.equal((await t.post('/mandates/m1/resume', {})).json.changed, false);
    const closed = await t.post('/mandates/m1/close', { reason: 'done for now' });
    assert.deepEqual([closed.json.changed, closed.json.mandate.status, closed.json.mandate.reason], [true, 'closed', 'done for now']);
    assert.equal((await t.post('/mandates/m1/close', { reason: null })).json.changed, false);
    for (const [p, body] of [['edit', { updatedAt: closed.json.mandate.updatedAt, maxJobs: 2 }], ['pause', {}], ['resume', {}]] as const) {
      const r = await t.post(`/mandates/m1/${p}`, body);
      assert.deepEqual([r.status, r.json.error], [409, 'mandate m1 is closed'], p);
    }
    assert.equal((await t.post('/mandates/nope/close', {})).status, 404);
    assert.equal((await t.get('/mandates')).json.mandates.find((m: { id: string }) => m.id === 'm2').state, 'active', 'closing m1 starts the next link');
  } finally {
    await t.cleanup();
  }
});

test('mandate writes the dashboard refuses write nothing', async () => {
  const t = await served();
  try {
    const a1 = await t.post('/mandates', { id: 'a1', title: 'A1', milestones: ['M1'] });
    assert.equal(a1.status, 200, a1.text);
    assert.equal((await t.post('/mandates', { id: 'a2', title: 'A2', milestones: ['M2'], after: 'a1' })).status, 200);
    const updatedAt = a1.json.mandate.updatedAt;
    const ok = { id: 'n1', title: 'N1', milestones: ['M1'] };
    const rows: [string, unknown, number, RegExp | string][] = [
      // 400: the body's shape, before anything is read.
      ['/mandates', { ...ok, bogus: 1 }, 400, /^body must be/],
      ['/mandates', [ok], 400, /^body must be/],
      ['/mandates', '"n1"', 400, /^body must be/],
      ['/mandates', { ...ok, title: 5 }, 400, /^body must be/],
      ['/mandates', { ...ok, milestones: 'M1' }, 400, /^body must be/],
      ['/mandates', { ...ok, labels: Array.from({ length: 101 }, (_, i) => `l${i}`) }, 400, /^body must be/],
      ['/mandates', { ...ok, title: 'x'.repeat(1001) }, 400, /^body must be/],
      ['/mandates', { ...ok, until: 'x'.repeat(41) }, 400, /^body must be/],
      ['/mandates', { ...ok, milestones: ['x'.repeat(201)] }, 400, /^body must be/],
      ['/mandates', { ...ok, body: 'x'.repeat(8001) }, 400, /^body must be/],
      ['/mandates', { ...ok, maxJobs: '3' }, 400, /^body must be/],
      ['/mandates', { ...ok, after: 'x'.repeat(61) }, 400, /^body must be/],
      ['/mandates', { title: 'N1', milestones: ['M1'] }, 400, /^body must be/],
      ['/mandates', { id: 'n1', milestones: ['M1'] }, 400, /^body must be/],
      ['/mandates', { ...ok, id: 'Bad' }, 400, /^body must be/],
      ['/mandates', { ...ok, id: 'none' }, 400, /^body must be/],
      ['/mandates', { ...ok, id: '../x' }, 400, /^body must be/],
      ['/mandates/a1/edit', { maxJobs: 2 }, 400, /^body must be/],
      ['/mandates/a1/edit', { updatedAt, id: 'a1' }, 400, /^body must be/],
      ['/mandates/a1/pause', { reason: 5 }, 400, /^body must be/],
      ['/mandates/a1/close', { reason: 'x'.repeat(1001) }, 400, /^body must be/],
      ['/mandates/a1/resume', { reason: 'x' }, 400, 'body must be {}'],
      ['/mandates', '{"id":', 400, 'body is not JSON'],
      // 404: an id that can't be one, or no such mandate.
      ['/mandates/none/pause', {}, 404, 'no such mandate'],
      ['/mandates/nope/edit', { updatedAt, title: 'x' }, 404, 'no mandate "nope"'],
      // 409: the contract's own refusals, as the CLI words them.
      ['/mandates', { ...ok, decides: ['release'] }, 409, 'release is not in foreman.decides'],
      ['/mandates', { ...ok, decides: ['conflicts'] }, 409, 'conflicts is reserved (gate:conflicts)'],
      ['/mandates', { ...ok, milestones: ['-x'] }, 409, 'milestone "-x" must be 1-200 characters, not start with "-" and have no control or hidden characters'],
      ['/mandates', { id: 'n1', title: 'N1', issues: ['old-item'] }, 409, /scope\.issues needs order listed/],
      ['/mandates/a1/edit', { updatedAt, after: 'a2' }, 409, '--after a2: that would close a cycle (a2 already comes after a1)'],
    ];
    const before = t.snapshot();
    for (const [p, body, status, error] of rows) {
      const r = await t.post(p, body);
      const label = `${p} ${typeof body === 'string' ? body : JSON.stringify(body).slice(0, 80)}`;
      assert.equal(r.status, status, `${label}: ${r.text.slice(0, 200)}`);
      if (typeof error === 'string') assert.equal(r.json.error, error, label);
      else assert.match(r.json.error, error, label);
    }
    assert.deepEqual(t.snapshot(), before, 'no mandate file and no audit line');

    // The CLI refuses the same terms with the same text.
    const cli = await forgeInProcess(t.repo.dir, ['mandate', 'new', 'n1', '--title', 'N1', '--milestones', 'M1', '--decides', 'conflicts']);
    assert.equal(cli.error?.message, 'conflicts is reserved (gate:conflicts)');
  } finally {
    await t.cleanup();
  }
});
