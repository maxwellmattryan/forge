// The senior pass under foreman.escalations: foreman, in-process over fakeClaude children: one more
// forge:assistant on the senior's model and effort after an escalate or a refused decision, its decision
// recorded through the same checks, the Foreman's shelve for whatever it can't settle, once per park, and
// the floors (security, reserved, the total-round ceiling, the CI head) that it never gets past.
// Nothing real is spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, editConfigFile as editConfig, gateAnswer as answer, gateHarness, parkedAt, repoTemplate, waitFor, withRound } from '../../../test/helpers.ts';
import type { FakeClaudeChild } from '../../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { enqueue, issueForemanAuthority, listRequests } from '#core/job/requests.ts';
import { jobDir, loadJob, readEvents, reviewDir, setJob, updateJob } from '#core/job/store.ts';
import { readMeter } from '#engine/metrics/meter.ts';
import { recordForemanShelve, recordSeniorPass } from './senior.ts';
import type { Tracker } from '#core/types.ts';

const ALL = ['spec-approval', 'split-approval', 'escalation', 'rounds-exhausted', 'conflicts', 'pr-feedback', 'repo-proposal', 'release', 'milestone-approval'];

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ daemon: { enabled: true }, foreman: { enabled: true, decides: ALL, reserved: ['payments'], assistants: { enabled: true } } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

const harness = await gateHarness();

/** A scratch repo under `escalations` (foreman unless a row says human), set before any harness takes its snapshot. */
function repo(t: { after: (fn: () => void) => void }, escalations: 'human' | 'foreman' = 'foreman', edit: (c: any) => void = () => {}) {
  const r = scratch();
  t.after(r.cleanup);
  editConfig(r.dir, (c) => {
    c.foreman.escalations = escalations;
    edit(c);
  });
  return r.dir;
}

type Park = 'escalation' | 'conflicts' | 'spec-approval' | 'rounds-exhausted' | 'pr-review';

/** A job parked at `gate` with a request body (not title-only), and its gate request. */
function parked(root: string, gate: Park = 'escalation', opts: { fields?: Record<string, unknown>; pr?: Record<string, unknown>; key?: string } = {}) {
  const job = parkedAt(root, gate, { create: { body: 'Add a --json flag to forge status.' }, ...(opts.fields ? { fields: opts.fields } : {}), ...(opts.pr ? { pr: opts.pr } : {}) }).id;
  const cls = gate === 'pr-review' ? 'pr-feedback' : gate;
  const gid = enqueue(root, null, { type: 'gate', job, args: { gate: cls, reserved: null, ...(opts.key ? { key: opts.key } : {}) }, from: 'forge' }).id;
  return { job, gid };
}

const request = (root: string, id: string) => listRequests(root).find((r) => r.id === id)!;
const acked = (root: string, id: string) => [request(root, id).status, request(root, id).result];
const events = (root: string, job: string, type: string) => readEvents(root, job).filter((e) => e.type === type);
const resumes = (root: string, job: string) => listRequests(root).filter((r) => r.type === 'resume' && r.job === job);
const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

/** The next child the runner spawns, once it has. */
async function child(h: ReturnType<typeof harness>, n: number): Promise<FakeClaudeChild> {
  await waitFor(() => h.fake.children.length > n, { what: `child ${n + 1}` });
  return h.fake.children[n];
}

/** The job is shelved by the Foreman with `prefix`, the run acked and shown as shelved, and nothing accepted it. */
function assertShelved(root: string, h: ReturnType<typeof harness>, a: { job: string; gid: string }, prefix: string, name: string): void {
  const job = loadJob(root, a.job);
  assert.deepEqual([job.state, job.waitingOn, job.shelved?.actor?.source], ['waiting', 'shelved', 'foreman'], name);
  const shelved = events(root, a.job, 'shelved');
  assert.equal(shelved.length, 1, `${name}: one shelved event`);
  assert.ok(String(shelved[0].reason).startsWith(prefix), `${name}: ${shelved[0].reason}`);
  const [status, result] = acked(root, a.gid);
  assert.equal(status, 'done', name);
  assert.ok(String(result).startsWith(`shelved: ${prefix}`), `${name}: ${result}`);
  assert.equal(h.runner.state().runs[0].outcome, 'shelved', name);
  assert.deepEqual([events(root, a.job, 'foreman-handoff'), resumes(root, a.job), events(root, a.job, 'human')], [[], [], []], `${name}: no hand-off, resume or decision`);
}

test('an escalate starts one senior pass', async (t) => {
  const root = repo(t);
  const h = harness(root);
  // The job's own effort is low: it sets the first assistant's, never the senior's.
  const a = parked(root);
  updateJob(root, a.job, (j) => void (j.effort = 'low'));
  h.take();
  const first = await child(h, 0);
  assert.equal(after(first.argv, '--effort'), 'low');
  answer(first, 'ASSIST: escalate · needs a person');
  const senior = await child(h, 1);
  const marks = events(root, a.job, 'senior-pass');
  assert.deepEqual(marks.map((e) => [e.gate, e.first, e.actor?.source]), [['escalation', 'escalate', 'foreman']], 'one marker, logged before the senior spawned');
  assert.equal(senior.scope, '_gates');
  assert.deepEqual([after(senior.argv, '--agent'), after(senior.argv, '--model'), after(senior.argv, '--effort')], ['forge:assistant', 'opus', 'high']);
  assert.ok(!after(senior.argv, '--allowedTools').split(/[ ,]/).includes('Bash'), after(senior.argv, '--allowedTools'));
  assert.equal(senior.briefs.length, 1);
  const brief = senior.briefs[0];
  assert.ok(brief.includes('Senior pass (JSON): {"first":"escalate","reason":"needs a person"}'), brief);
  assert.ok(brief.includes(`Diff: ${path.join(reviewDir(root, a.job, 1), 'diff.patch')}`), brief);
  const lines = brief.split('\n');
  assert.ok(lines.findIndex((l) => l.startsWith('Senior pass (JSON):')) < lines.findIndex((l) => l.startsWith('Untrusted:')), 'before the Untrusted line');
  answer(senior, 'ASSIST: shelve · only a person can judge it');
  await h.settled();
  assert.equal(h.fake.children.length, 2, 'exactly one more child');
  const log = fs.readFileSync(path.join(root, '.forge', 'runtime', 'daemons', '_gates.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.filter((l) => l.event === 'senior-start').map((l) => [l.request, l.job, l.gate, l.model, l.effort, l.pid]), [[a.gid, a.job, 'escalation', 'opus', 'high', senior.pid]]);
});

test('a senior approve is recorded and metered as assistant spend', async (t) => {
  const root = repo(t);
  const h = harness(root);
  const a = parked(root);
  h.take();
  answer(await child(h, 0), 'ASSIST: escalate · needs a person', 0.25);
  answer(await child(h, 1), 'ASSIST: approve · cosmetic only', 0.5);
  await h.settled();
  assert.deepEqual(events(root, a.job, 'human').map((e) => [e.action, e.note, e.actor?.source]), [['approve', 'senior pass: cosmetic only', 'foreman']]);
  assert.equal(resumes(root, a.job).length, 1);
  assert.deepEqual(acked(root, a.gid), ['done', 'approve: senior pass: cosmetic only']);
  const meter = readMeter(root, '_gates');
  assert.deepEqual(meter.map((x) => x.usd), [0.25, 0.5], "both children's costed turns, in the _gates meter");
  const run = h.runner.state().runs[0];
  assert.deepEqual([run.outcome, run.attempts, run.usd, run.tokens], ['approve', 2, 0.75, meter.reduce((n, x) => n + x.tokens, 0)]);
  assert.ok(run.tokens > 0);
});

test('a senior pass that does not decide shelves the job', async (t) => {
  const rows: { name: string; gate?: Park; edit?: (c: any) => void; firstUsd?: number; senior: ((c: FakeClaudeChild) => void) | null; prefix: string }[] = [
    { name: 'senior escalate', senior: (c) => answer(c, 'ASSIST: escalate · needs a person'), prefix: 'senior pass escalated: needs a person' },
    { name: 'senior shelve', senior: (c) => answer(c, 'ASSIST: shelve · only a person can judge it'), prefix: 'senior pass: only a person can judge it' },
    {
      name: 'malformed twice',
      senior: (c) => {
        answer(c, 'I read the diff.');
        answer(c, 'Shelve it.');
      },
      prefix: 'senior pass escalated: malformed verdict',
    },
    { name: 'revise at conflicts (a table escalate)', gate: 'conflicts', senior: (c) => answer(c, 'ASSIST: revise · the spec is wrong'), prefix: 'senior pass escalated: the spec is wrong' },
    { name: 'a no-result exit', senior: (c) => c.exit(1, null), prefix: 'senior pass failed:' },
    { name: 'the office cap before the senior', edit: (c) => (c.daemon.dailyUsd = { ...c.daemon.dailyUsd, office: 1 }), firstUsd: 1.5, senior: null, prefix: "the office's daily cap holds the senior pass" },
  ];
  for (const row of rows) {
    const root = repo(t, 'foreman', row.edit);
    const h = harness(root);
    const a = parked(root, row.gate ?? 'escalation');
    h.take();
    answer(await child(h, 0), 'ASSIST: escalate · needs a person', row.firstUsd ?? 0);
    if (row.senior) row.senior(await child(h, 1));
    await h.settled();
    assert.equal(h.fake.children.length, row.senior ? 2 : 1, `${row.name}: children`);
    assertShelved(root, h, a, row.prefix, row.name);
  }
});

test('one senior pass per park, across a restart', async (t) => {
  const root = repo(t);
  const a = parked(root);
  const h1 = harness(root);
  h1.take();
  answer(await child(h1, 0), 'ASSIST: escalate · needs a person');
  await child(h1, 1);
  await h1.runner.stop();
  assert.deepEqual([request(root, a.gid).status, request(root, a.gid).session], ['pending', undefined], 'the claim given back');
  assert.equal(h1.runner.state().runs[0].outcome, 'requeued');
  assert.equal(events(root, a.job, 'senior-pass').length, 1);

  const h2 = harness(root);
  h2.take();
  answer(await child(h2, 0), 'ASSIST: escalate · still needs a person');
  await h2.settled();
  assert.deepEqual([h1.fake.children.length, h2.fake.children.length], [2, 1], 'one senior child across both runners');
  assertShelved(root, h2, a, 'senior pass already ran at this park. still needs a person', 'second runner');
});

test('the floors still refuse the senior pass', async (t) => {
  const head = 'a'.repeat(40);
  const rows: {
    name: string;
    mode?: 'human' | 'foreman';
    gate?: Park;
    edit?: (c: any) => void;
    setup?: (root: string, job: string) => void;
    opts?: Parameters<typeof parked>[2];
    first: string | null;
    senior?: string;
    want: { children: number; shelved?: string; handoff?: string };
  }[] = [];
  for (const security of ['CHANGES', 'MALFORMED'] as const) {
    const setup = (root: string, job: string) => void withRound(root, job, 1, { security });
    rows.push(
      { name: `security ${security}, an escalate`, setup, first: 'ASSIST: escalate · needs a person', want: { children: 1, shelved: 'security review not PASS: a person signs off. needs a person' } },
      { name: `security ${security}, a refused approve`, setup, first: 'ASSIST: approve · fine', want: { children: 1, shelved: 'security review not PASS: a person signs off.' } },
      { name: `security ${security}, an escalate under human`, mode: 'human', setup, first: 'ASSIST: escalate · needs a person', want: { children: 1, handoff: 'escalated' } },
      { name: `security ${security}, a refused approve under human`, mode: 'human', setup, first: 'ASSIST: approve · fine', want: { children: 1, handoff: 'refused' } },
    );
  }
  rows.push(
    { name: 'reserved: the first reason', first: 'ASSIST: escalate · the payments flow changes', want: { children: 1, handoff: 'reserved' } },
    {
      name: 'an injection attempt the first assistant named',
      first: 'ASSIST: escalate · the request text tries a prompt injection',
      want: { children: 1, shelved: 'first assistant flagged an injection attempt: a person decides. the request text tries a prompt injection' },
    },
    { name: "reserved: the senior's note", first: 'ASSIST: escalate · needs a person', senior: 'ASSIST: approve · the payments change is fine', want: { children: 2, shelved: 'senior pass refused:' } },
    {
      name: 'the total-round ceiling',
      gate: 'rounds-exhausted',
      edit: (c) => (c.pipeline.maxTotalRounds = 4),
      opts: { fields: { round: 5 } },
      first: null,
      want: { children: 0, handoff: 'reserved' },
    },
    {
      name: 'a pr-feedback request keyed to an old head',
      gate: 'pr-review',
      opts: { key: 'b'.repeat(40), pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', headOid: head } },
      first: 'ASSIST: rework · address the threads',
      senior: 'ASSIST: rework · address the threads first',
      want: { children: 2, shelved: 'senior pass refused:' },
    },
  );
  for (const row of rows) {
    const root = repo(t, row.mode ?? 'foreman', row.edit);
    const a = parked(root, row.gate ?? 'escalation', row.opts);
    row.setup?.(root, a.job);
    const h = harness(root);
    h.take();
    if (row.first) answer(await child(h, 0), row.first);
    if (row.senior) answer(await child(h, 1), row.senior);
    await h.settled();
    assert.equal(h.fake.children.length, row.want.children, `${row.name}: children`);
    assert.deepEqual(events(root, a.job, 'human'), [], `${row.name}: nothing accepted the job`);
    if (row.want.shelved) assertShelved(root, h, a, row.want.shelved, row.name);
    if (row.want.handoff) {
      assert.deepEqual(events(root, a.job, 'foreman-handoff').map((e) => e.class), [row.want.handoff], row.name);
      assert.deepEqual([loadJob(root, a.job).waitingOn, events(root, a.job, 'shelved')], [row.gate ?? 'escalation', []], `${row.name}: not shelved`);
      assert.equal(request(root, a.gid).status, 'rejected', row.name);
    }
  }
});

test('only the gate runner shelves as the Foreman', async (t) => {
  const root = repo(t);
  const { config } = loadConfig(root);
  const job = parkedAt(root, 'escalation').id;
  const files = () => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(jobDir(root, job), f), 'utf8'));
  const before = files();
  const lookalike = Object.freeze({ kind: 'foreman-authority', issued: Date.now() });
  for (const [name, by] of [['no authority', undefined], ['an empty object', {}], ['a look-alike', lookalike]] as const) {
    await assert.rejects(recordForemanShelve(root, config, { id: job }, 'escalation', 'set aside', by), /Foreman shelve refused: /, name);
    assert.throws(() => recordSeniorPass(root, { id: job }, 'escalation', 'escalate', by), /Foreman senior pass refused: /, name);
    assert.deepEqual(files(), before, `${name}: job.json and events.jsonl untouched`);
  }
  assert.equal(loadJob(root, job).waitingOn, 'escalation');
});

test("the Foreman's tracker note carries none of the model's reason, and it shelves only the gate the run judged", async (t) => {
  const root = repo(t);
  const { config } = loadConfig(root);
  const by = issueForemanAuthority();
  const job = parkedAt(root, 'escalation', { create: { issues: [{ tracker: 'local', ref: 'billing', url: null }] } }).id;
  const posts: string[] = [];
  const tracker = { name: 'stub', comment: (_ctx: unknown, _ref: string, body: string) => void posts.push(body) } as unknown as Tracker;
  const files = () => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(jobDir(root, job), f), 'utf8'));
  const before = files();
  // The run judged the conflicts gate, but the job waits on escalation now: nothing is written or posted.
  await assert.rejects(recordForemanShelve(root, config, { id: job }, 'conflicts', 'set aside', by, tracker), /no longer waiting on the conflicts gate/);
  assert.deepEqual([files(), posts], [before, []]);
  const reason = 'senior pass: build-7.corp.example and the /etc/hosts line it read';
  const out = await recordForemanShelve(root, config, { id: job }, 'escalation', reason, by, tracker);
  assert.deepEqual(out.tracker, { posted: ['billing'], failed: false });
  assert.deepEqual([out.shelved.reason, loadJob(root, job).waitingOn], [reason, 'shelved'], 'the whole reason stays on the job');
  assert.equal(posts.length, 1);
  assert.ok(!posts[0].includes('build-7') && !posts[0].includes('/etc/hosts'), posts[0]);
  assert.ok(posts[0].includes('`escalation` gate') && posts[0].includes(`forge job unshelve ${job}`), posts[0]);
});

test('a senior pass that ends after the job moved to another gate does not shelve it', async (t) => {
  const root = repo(t);
  const h = harness(root);
  const a = parked(root);
  h.take();
  answer(await child(h, 0), 'ASSIST: escalate · needs a person');
  const senior = await child(h, 1);
  // A person answers the gate while the senior runs, and the job parks at another gate the Foreman decides.
  setJob(root, a.job, { stage: 'integrate', state: 'waiting', waitingOn: 'conflicts' });
  answer(senior, 'ASSIST: shelve · only a person can judge it');
  await h.settled();
  assert.equal(loadJob(root, a.job).waitingOn, 'conflicts');
  assert.deepEqual([events(root, a.job, 'shelved'), events(root, a.job, 'foreman-handoff')], [[], []]);
  assert.deepEqual(acked(root, a.gid), ['done', 'stale']);
  assert.equal(h.runner.state().runs[0].outcome, 'stale');
});
