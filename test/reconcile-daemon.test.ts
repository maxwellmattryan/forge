// A job session killed mid-agent: the supervisor marks its agent lost, expires its lease and
// requeues its request, and the pool's next session takes the job over with no person pressing Resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, waitFor } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { initWrite } from '../lib/commands/init.ts';
import { createPool } from '../lib/daemon-pool.ts';
import { createJob, leaseStatus, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { enqueue, listRequests } from '../lib/requests.ts';

const FAKE_BIN = path.resolve(import.meta.dirname, 'fixtures', 'bin', 'claude');
const FAKE_COMMAND = `"${FAKE_BIN}" --plugin-dir {pluginRoot} {session} --allowedTools {allowedTools}`;
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

test('a session killed mid-agent resumes without a person', POSIX, async () => {
  const repo = tempRepo();
  const root = repo.dir;
  initWrite(root, { tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: `../${path.basename(root)}.wt` } }, false);
  const logFile = path.join(root, 'fake-claude.jsonl');
  const records = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const drove = () => records().filter((r) => r.drove || r.droveError);
  const cfg = defaults();
  Object.assign(cfg.daemon, { enabled: true, command: FAKE_COMMAND });
  const env = { ...process.env, FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_DRIVE: '1', FAKE_CLAUDE_FORK: '1', FAKE_CLAUDE_IGNORE_EOF: '1' };
  const pool = createPool(root, { env, loadConfig: () => ({ config: cfg }), pollMs: 50, graceMs: 1000, syncMs: 0, reconcileMs: 0 });
  try {
    const id = createJob(root, defaults(), { title: 'Killed' }).id;
    setJob(root, id, { stage: 'build', state: 'running' });
    const req = enqueue(root, null, { type: 'resume', job: id });
    pool.start();
    await waitFor(() => drove().length >= 1, { timeoutMs: 20_000, what: 'the first session to claim and start its agent' });
    const first = drove()[0];
    assert.ok(first.drove, JSON.stringify(first));
    assert.equal(first.drove.request, req.id);
    assert.equal(first.drove.epoch, 1);
    assert.equal(loadJob(root, id).agents.builder.status, 'running');

    // The child dies under its agent: nobody asked it to stop.
    process.kill(-first.pid, 'SIGKILL');
    await waitFor(() => loadJob(root, id).agents.builder.status === 'lost', { timeoutMs: 10_000, what: 'the agent marked lost' });
    const events = readEvents(root, id);
    assert.ok(events.some((e) => e.type === 'lease-expired' && e.session === first.drove.session), 'the lease expired on exit');
    assert.ok(events.some((e) => e.type === 'note' && String(e.text).includes(`request ${req.id} (resume) is pending again`)), 'the request was requeued');

    await waitFor(() => drove().length >= 2, { timeoutMs: 20_000, what: 'the next session to take the job' });
    const second = drove()[1];
    assert.ok(second.drove, JSON.stringify(second));
    assert.notEqual(second.pid, first.pid);
    assert.equal(second.drove.request, req.id, 'the requeued request reached the new turn');
    assert.equal(second.drove.epoch, 2, 'a new driver, at the next epoch');
    const job = loadJob(root, id);
    assert.deepEqual([job.lease.driver, leaseStatus(job).status], [second.drove.session, 'live']);
    const r = listRequests(root).find((x) => x.id === req.id)!;
    assert.deepEqual([r.status, r.requeues, r.session], ['in-progress', 1, second.drove.session]);
  } finally {
    await pool.close();
    for (const r of records().filter((x) => x.argv)) {
      try {
        process.kill(-r.pid, 'SIGKILL');
      } catch {}
    }
    repo.cleanup();
    fs.rmSync(`${root}.wt`, { recursive: true, force: true });
  }
});
