// The dashboard's environment helpers (issue #199): the Environment card's chips and controls, the log viewer's frames
// and cap, the Project page's Running environments rows, and the fetch wrappers behind them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_CAP,
  actionToast,
  backingButtons,
  backingSource,
  devButtons,
  devChip,
  fetchEnvironment,
  fetchEnvironments,
  formatBytes,
  formatPercent,
  logStreamUrl,
  parseFrame,
  postEnvironment,
  projectRows,
  pushLines,
  serviceChip,
} from '../dashboard/src/lib/environment.ts';

const svc = (name: string, state: string, managed = state !== 'external') => ({ name, isolation: managed ? 'per-job' : 'external', managed, container: managed ? `forge-a-${name}` : null, state, health: null, ports: {} }) as any;
const env = (extra: Record<string, unknown> = {}, dev: Record<string, unknown> | null = { state: 'stopped' }) =>
  ({ job: 'a', active: true, worktree: true, dev: dev && { pid: null, port: 4100, listening: null, startedAt: null, tail: [], ...dev }, backing: [], backingError: null, at: '', ...extra }) as any;

test('state chips', () => {
  assert.deepEqual(devChip('running'), { state: 'running', tone: 'ok' });
  assert.deepEqual(devChip('starting'), { state: 'starting', tone: 'live' });
  assert.deepEqual(devChip('down'), { state: 'down', tone: 'bad' });
  assert.deepEqual(devChip('stopped'), { state: 'stopped', tone: 'muted' });
  assert.deepEqual(
    (['running', 'stopped', 'missing', 'unknown', 'external'] as const).map((s) => serviceChip(s).tone),
    ['ok', 'muted', 'warn', 'muted', 'info'],
  );
});

test('dev buttons', () => {
  const b = (state: string, extra = {}) => devButtons(env(extra, { state }));
  assert.deepEqual(b('stopped'), { start: true, stop: false, restart: true, hint: null });
  assert.deepEqual(b('down'), { start: true, stop: false, restart: true, hint: null });
  assert.deepEqual(b('running'), { start: false, stop: true, restart: true, hint: null });
  assert.deepEqual(b('starting'), { start: false, stop: true, restart: true, hint: null });
  assert.deepEqual(b('stopped', { active: false }), { start: false, stop: false, restart: false, hint: 'inactive' });
  assert.deepEqual(b('running', { active: false }), { start: false, stop: true, restart: false, hint: 'inactive' }, 'a done job can still be stopped');
  assert.deepEqual(b('down', { worktree: false }), { start: false, stop: false, restart: false, hint: 'noWorktree' });
  assert.deepEqual(devButtons(null), { start: false, stop: false, restart: false, hint: null }, 'before the first answer');
  assert.deepEqual(devButtons(env({}, null)), { start: false, stop: false, restart: false, hint: null }, 'no dev command');
});

test('backing buttons', () => {
  assert.deepEqual(backingButtons(env({ backing: [svc('postgres', 'running'), svc('queue', 'external')] })), { start: true, stop: true, restart: true, hint: null });
  assert.deepEqual(backingButtons(env({ backing: [svc('queue', 'external')] })), { start: false, stop: false, restart: false, hint: 'noManaged' });
  assert.deepEqual(backingButtons(env({ backing: [] })), { start: false, stop: false, restart: false, hint: null });
  assert.deepEqual(backingButtons(env({ active: false, backing: [svc('postgres', 'running')] })), { start: false, stop: true, restart: false, hint: 'inactive' });
  assert.deepEqual(backingButtons(null), { start: false, stop: false, restart: false, hint: null });
});

test('action toasts', () => {
  assert.equal(actionToast('dev', 'start'), 'devStarted');
  assert.equal(actionToast('dev', 'stop'), 'devStopped');
  assert.equal(actionToast('backing', 'restart'), 'backingRestarted');
});

test('frames and the line cap', () => {
  assert.equal(parseFrame('"a line"'), 'a line');
  assert.equal(parseFrame(JSON.stringify('<script>alert(1)</script>')), '<script>alert(1)</script>', 'text, kept as text');
  assert.equal(parseFrame(JSON.stringify('x\r\n\ndata: y')), 'x\r\n\ndata: y');
  for (const bad of ['null', '{"a":1}', '[1]', '5', 'not json', '', undefined, 5]) assert.equal(parseFrame(bad), null, String(bad));
  assert.equal(LOG_CAP, 1000);
  const many = Array.from({ length: 1200 }, (_, i) => String(i));
  const kept = pushLines([], many);
  assert.equal(kept.length, 1000);
  assert.equal(kept[0], '200', 'the oldest go first');
  assert.equal(kept.at(-1), '1199');
  const buf = ['a'];
  assert.deepEqual(pushLines(buf, ['b', 'c'], 2), ['b', 'c']);
  assert.deepEqual(buf, ['a'], 'the buffer is not changed in place');
});

test('formatting', () => {
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(12.5 * 1024 * 1024), '12.5 MiB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GiB');
  assert.equal(formatPercent(null), '—');
  assert.equal(formatPercent(1.5), '1.5%');
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatPercent(Number.NaN), '—');
});

test('project rows', () => {
  const mib = 1024 * 1024;
  const rows = projectRows([
    { job: 'a', title: 'Alpha', state: 'running', focused: true, dev: { pid: 10, port: 4100, cpu: 2.25, memBytes: 50 * mib }, containers: [{ name: 'forge-a-postgres', backing: 'postgres', cpu: 1.5, memBytes: 10 * mib }, { name: 'forge-a-redis', backing: 'redis', cpu: null, memBytes: 2 * mib }] },
    { job: 'b', title: 'Beta', state: 'waiting', focused: false, dev: { pid: 11, port: null, cpu: null, memBytes: null }, containers: [] },
    { job: null, title: 'Shared services', state: null, focused: false, dev: null, containers: [{ name: 'p-redis', backing: 'redis', cpu: null, memBytes: null }] },
  ] as any);
  assert.deepEqual(rows[0], { key: 'a', job: 'a', title: 'Alpha', state: 'running', devPort: 'localhost:4100', devCpu: '2.3%', devMem: '50.0 MiB', containers: 2, cpu: '1.5%', mem: '12.0 MiB' });
  assert.deepEqual(rows[1], { key: 'b', job: 'b', title: 'Beta', state: 'waiting', devPort: '—', devCpu: '—', devMem: '—', containers: 0, cpu: '—', mem: '—' }, 'Windows: nothing measured');
  assert.equal(rows[2].job, null);
  assert.equal(rows[2].devPort, '—');
  assert.equal(rows[2].cpu, '—', 'Docker could not measure');
  assert.notEqual(rows[2].key, rows[0].key);
  assert.deepEqual(projectRows(null), []);
});

test('fetch wrappers send the token and throw the server error', async () => {
  const calls: { url: string; init: any }[] = [];
  const reply = (status: number, body: unknown) => async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  assert.deepEqual(await fetchEnvironment('a b', 'tok', reply(200, { job: 'a b' }) as any), { job: 'a b' });
  await fetchEnvironments('tok', reply(200, { docker: 'ok', rows: [], at: '' }) as any);
  await postEnvironment('a', 'dev', 'restart', 'tok', reply(200, { ok: true }) as any);
  assert.deepEqual(
    calls.map((c) => [c.url, c.init.method ?? 'GET', c.init.headers['x-forge-token'], c.init.body ?? null]),
    [
      ['/api/jobs/a%20b/environment', 'GET', 'tok', null],
      ['/api/environments', 'GET', 'tok', null],
      ['/api/jobs/a/environment', 'POST', 'tok', '{"target":"dev","action":"restart"}'],
    ],
  );
  await assert.rejects(postEnvironment('a', 'dev', 'stop', 'tok', reply(409, { error: 'cannot prove pid 5' }) as any), /cannot prove pid 5/);
  await assert.rejects(fetchEnvironment('a', 'tok', reply(403, 'bad token') as any), /bad token/);
  await assert.rejects(fetchEnvironment('a', 'tok', reply(404, { error: 'no job a' }) as any), /no job a/);
  assert.equal(logStreamUrl('a b', backingSource('postgres'), 't0k'), '/api/jobs/a%20b/environment/logs?source=backing%3Apostgres&token=t0k');
  assert.equal(logStreamUrl('a', 'dev', 'x'), '/api/jobs/a/environment/logs?source=dev&token=x');
});
