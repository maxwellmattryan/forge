// daemon.turnTimeoutMinutes: a turn that never sends its result is stopped past its limit, its
// lease expired and its request requeued through the exit path, and the session stays wanted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, waitFor } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { initWrite } from '../lib/commands/init.ts';
import { createPool } from '../lib/daemon-pool.ts';
import { sessionOptions } from '../lib/daemon.ts';
import { createJob, readEvents, setJob } from '../lib/jobs.ts';
import { enqueue } from '../lib/requests.ts';

const FAKE_BIN = path.resolve(import.meta.dirname, 'fixtures', 'bin', 'claude');
const FAKE_COMMAND = `"${FAKE_BIN}" --plugin-dir {pluginRoot} {session} --allowedTools {allowedTools}`;
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

test('a turn past its timeout', POSIX, async () => {
  assert.equal(sessionOptions().turnTimeoutMs, null, 'daemon.turnTimeoutMinutes decides unless a test overrides it');
  const repo = tempRepo();
  const root = repo.dir;
  initWrite(root, { tracker: { kind: 'local' }, pr: { enabled: false } }, false);
  const logFile = path.join(root, 'fake-claude.jsonl');
  const records = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cfg = defaults();
  Object.assign(cfg.daemon, { enabled: true, command: FAKE_COMMAND });
  const env = { ...process.env, FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_DRIVE: '1', FAKE_CLAUDE_IGNORE_EOF: '1' };
  const pool = createPool(root, { env, loadConfig: () => ({ config: cfg }), pollMs: 3_600_000, graceMs: 1000, syncMs: 0, reconcileMs: 0, turnTimeoutMs: 6000 });
  const sessionLog = () => {
    const f = path.join(root, '.forge', 'runtime', 'daemons', `${id}.log`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const id = createJob(root, defaults(), { title: 'Hung turn' }).id;
  try {
    setJob(root, id, { stage: 'build', state: 'running' });
    const req = enqueue(root, null, { type: 'resume', job: id });
    pool.start();
    // The limit leaves the turn's four forge calls time to finish on a loaded machine.
    await waitFor(() => records().some((r) => r.drove || r.droveError), { timeoutMs: 30_000, what: 'the turn to claim the job' });
    assert.equal(records().find((r) => r.droveError)?.droveError, undefined);
    assert.equal(pool.sessionState(id).status, 'busy');
    await waitFor(() => sessionLog().some((e) => e.event === 'turn-timeout'), { timeoutMs: 20_000, what: 'turn-timeout' });
    const timeout = sessionLog().find((e) => e.event === 'turn-timeout');
    assert.equal(timeout.minutes, 0.1);
    await waitFor(() => readEvents(root, id).some((e) => e.type === 'lease-expired'), { timeoutMs: 10_000, what: 'the lease to expire' });
    assert.ok(sessionLog().some((e) => e.event === 'stop' && e.reason === 'turn-timeout'), 'stopped for the timeout');
    assert.ok(readEvents(root, id).some((e) => e.type === 'note' && String(e.text).includes(`request ${req.id} (resume) is pending again`)), 'its request was requeued');
    assert.equal(pool.sessionState(id).wanted, true, 'the session stays wanted');
  } finally {
    await pool.close();
    for (const r of records().filter((x) => x.argv)) {
      try {
        process.kill(-r.pid, 'SIGKILL');
      } catch {}
    }
    repo.cleanup();
  }
});
