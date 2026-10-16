import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { tempRepo, waitFor as waitUntil } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, recordAgent, updateJob } from '../lib/jobs.ts';
import { SCOPE_ENV, enqueue, listRequests } from '../lib/requests.ts';
import { MISSED_END_TEXT, TURN_LINE } from '../lib/daemon.ts';
import { createPool } from '../lib/daemon-pool.ts';

const MISSED_MS = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => new Promise((r) => setImmediate(r));
const waitFor = (cond, what) => waitUntil(cond, { timeoutMs: 3000, intervalMs: 10, what });

/** In-memory children: no real process is ever spawned or signalled. */
function fakeKit() {
  const children: any[] = [];
  const spawn: any = (cmd, args, opts) => {
    const c: any = new EventEmitter();
    c.scope = opts.env[SCOPE_ENV];
    c.pid = 4_100_000 + children.length;
    c.stdin = new PassThrough();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.written = '';
    c.stdin.on('data', (d) => (c.written += d.toString()));
    c.exit = (code, signal) => {
      if (c.exited) return;
      c.exited = true;
      c.stdout.end();
      c.stderr.end();
      c.emit('close', code, signal);
    };
    c.line = (obj) => c.stdout.write(JSON.stringify(obj) + '\n');
    children.push(c);
    return c;
  };
  const killTree = (c) => setImmediate(() => c.exit(null, 'SIGTERM'));
  return { spawn, killTree, last: (scope) => children.filter((c) => c.scope === scope).at(-1) };
}

function pool(dir, kit) {
  const c = defaults();
  Object.assign(c.daemon, { enabled: true, command: 'claude {session} --plugin-dir {pluginRoot} --allowedTools {allowedTools}' });
  return createPool(dir, { spawn: kit.spawn, killTree: kit.killTree, loadConfig: () => ({ config: c }), pollMs: 3_600_000, slotGraceMs: 0, missedEndMs: MISSED_MS });
}

const turnsIn = (child) => child.written.split(TURN_LINE).length - 1;
const logOf = (dir, scope) => {
  const f = path.join(dir, '.forge', 'runtime', 'daemons', `${scope}.log`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const eventsIn = (dir, scope, event) =>
  logOf(dir, scope)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'forge-daemon' && e.event === event);
const nudges = (dir) => listRequests(dir).filter((r) => r.from === 'daemon:supervisor');

function ownBy(root, id, session) {
  const at = new Date().toISOString();
  updateJob(root, id, (j) => {
    j.owner = { session, host: 'test-host', since: at, heartbeat: at };
  });
}
const agentStart = (root, id, role) => recordAgent(root, id, { role, phase: 'start' }, defaults());
const agentEnd = (root, id, role) => recordAgent(root, id, { role, phase: 'end', status: 'done' }, defaults());
const tasks = (...ids) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent' })) });
const init = { type: 'system', subtype: 'init' };

/** A job session whose first turn left `roles` running in the background, as a review round does. */
async function reviewing(roles: string[]) {
  const repo = tempRepo();
  const kit = fakeKit();
  const d = pool(repo.dir, kit);
  const id = createJob(repo.dir, defaults(), { title: 'Job A' }).id;
  enqueue(repo.dir, null, { type: 'resume', job: id, from: 'dashboard' });
  d.start();
  await settle();
  ownBy(repo.dir, id, d.sessionState(id).sessionId);
  for (const r of roles) agentStart(repo.dir, id, r);
  const c = kit.last(id);
  c.line(init);
  c.line(tasks(...roles));
  c.line({ type: 'result', subtype: 'success' });
  await waitFor(() => d.sessionState(id).status === 'idle', 'the first turn to end');
  return { repo, kit, d, id, c };
}

test("a finished agent whose end the orchestrator never recorded gets its job a resume, once per agent run", async () => {
  const { repo, d, id, c } = await reviewing(['reviewer:code', 'reviewer:security']);
  try {
    // The sequence the stalled jobs logged. The code reviewer's report wakes a turn that records it.
    c.line(tasks('reviewer:security'));
    c.line(init);
    agentEnd(repo.dir, id, 'reviewer:code');
    c.line({ type: 'result', subtype: 'success' });
    await waitFor(() => eventsIn(repo.dir, id, 'wake').length === 1 && d.sessionState(id).status === 'idle', 'the code report turn');
    await sleep(MISSED_MS * 2);
    assert.equal(nudges(repo.dir).length, 0, 'not while claude still lists a background agent');
    // The security reviewer finishes: claude lists no task, and its report wakes a turn that ends
    // waiting for the task notification instead of recording the end.
    c.line(tasks());
    c.line(init);
    c.line({ type: 'result', subtype: 'success' });
    // The notification is dequeued into a result no model call made.
    c.line(init);
    c.line({ type: 'result', subtype: 'success', num_turns: 0, duration_api_ms: 0 });
    await waitFor(() => eventsIn(repo.dir, id, 'result').length === 4, 'all four results');
    assert.equal(turnsIn(c), 1);

    await waitFor(() => turnsIn(c) === 2, 'the supervisor to queue a resume and the pool to turn it');
    const [r] = nudges(repo.dir);
    assert.equal(r.type, 'resume');
    assert.equal(r.job, id);
    assert.equal(r.text, MISSED_END_TEXT);
    const [e] = eventsIn(repo.dir, id, 'missed-agent-end');
    assert.deepEqual(e.roles, ['reviewer:security']);
    assert.equal(e.request, r.id);

    // A turn that again leaves the same agent run unrecorded is not nudged twice.
    c.line(init);
    c.line({ type: 'result', subtype: 'success' });
    await waitFor(() => d.sessionState(id).status === 'idle', 'the resume turn to end');
    await sleep(MISSED_MS * 3);
    assert.equal(nudges(repo.dir).length, 1);
    assert.equal(turnsIn(c), 2);

    // A new run of the same role (the next round's reviewer) is a new stuck agent.
    agentEnd(repo.dir, id, 'reviewer:security');
    await sleep(5);
    agentStart(repo.dir, id, 'reviewer:security');
    c.line(init);
    c.line(tasks('reviewer:security'));
    c.line({ type: 'result', subtype: 'success' });
    await waitFor(() => d.sessionState(id).status === 'idle', 'the next round to start');
    c.line(tasks());
    await waitFor(() => nudges(repo.dir).length === 2, 'a resume for the new run');
    await waitFor(() => turnsIn(c) === 3, 'its turn');
  } finally {
    await d.close();
    repo.cleanup();
  }
});

test('no resume while an agent is still listed, a woken turn is running, or nothing is left running', async () => {
  const listed = await reviewing(['builder']);
  try {
    await sleep(MISSED_MS * 3);
    assert.equal(nudges(listed.repo.dir).length, 0, 'claude still lists the builder');
  } finally {
    await listed.d.close();
    listed.repo.cleanup();
  }

  const woken = await reviewing(['builder']);
  try {
    woken.c.line(tasks());
    // Its notification starts a turn within the window: that turn records the end.
    woken.c.line(init);
    await waitFor(() => woken.d.sessionState(woken.id).status === 'busy', 'the woken turn');
    await sleep(MISSED_MS * 3);
    assert.equal(nudges(woken.repo.dir).length, 0, 'not while the woken turn runs');
    agentEnd(woken.repo.dir, woken.id, 'builder');
    woken.c.line({ type: 'result', subtype: 'success' });
    await waitFor(() => woken.d.sessionState(woken.id).status === 'idle', 'the woken turn to end');
    await sleep(MISSED_MS * 3);
    assert.equal(nudges(woken.repo.dir).length, 0, 'the end was recorded');
    assert.equal(turnsIn(woken.c), 1);
  } finally {
    await woken.d.close();
    woken.repo.cleanup();
  }

  // A claude that never reports its background tasks is never second-guessed.
  const repo = tempRepo();
  const kit = fakeKit();
  const d = pool(repo.dir, kit);
  try {
    const id = createJob(repo.dir, defaults(), { title: 'Job B' }).id;
    enqueue(repo.dir, null, { type: 'resume', job: id, from: 'dashboard' });
    d.start();
    await settle();
    ownBy(repo.dir, id, d.sessionState(id).sessionId);
    agentStart(repo.dir, id, 'builder');
    kit.last(id).line({ type: 'result', subtype: 'success' });
    await waitFor(() => d.sessionState(id).status === 'idle', 'B idle');
    await sleep(MISSED_MS * 3);
    assert.equal(nudges(repo.dir).length, 0);
  } finally {
    await d.close();
    repo.cleanup();
  }
});
