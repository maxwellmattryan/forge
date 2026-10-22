import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { claimJob, createJob, loadJob, readEvents, roundVerdicts, setJob, recordAgent, progress, parseDecision, AGENT_LEASE_MS, renewLease, jobDir } from '../lib/jobs.ts';
import { computeStats } from '../lib/stats.ts';
import { EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION, normalizeEvent, normalizeJob } from '../lib/schema.ts';
import { sleepSync } from '../lib/util.ts';

test('job lifecycle: ids, transitions, claims, usage, verdict policy', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const a = createJob(root, config, { title: 'Add dark mode toggle', issues: [{ tracker: 'local', ref: '42', url: null }] });
    assert.equal(a.id, '42-add-dark-mode-toggle');
    assert.equal(a.branch, 'forge/42-add-dark-mode-toggle');
    const b = createJob(root, config, { title: 'Add dark mode toggle', issues: [{ tracker: 'local', ref: '42', url: null }] });
    assert.equal(b.id, '42-add-dark-mode-toggle-2');
    const c = createJob(root, config, { title: 'Reading time', issues: [{ tracker: 'local', ref: 'reading-time', url: null }] });
    assert.equal(c.id, 'reading-time');

    assert.throws(() => setJob(root, a.id, { stage: 'nope' }), /unknown stage/);
    assert.throws(() => setJob(root, a.id, { state: 'waiting' }), /needs --waiting-on/);
    const w = setJob(root, a.id, { stage: 'spec', state: 'waiting', waitingOn: 'spec-approval' });
    assert.equal(w.waitingOn, 'spec-approval');
    const r = setJob(root, a.id, { stage: 'build', state: 'running' });
    assert.equal(r.waitingOn, null, 'leaving waiting clears waitingOn');

    claimJob(root, a.id, 'session-1');
    assert.throws(() => claimJob(root, a.id, 'session-2'), /being driven by session session-1/);
    assert.equal(claimJob(root, a.id, 'session-2', true).lease.driver, 'session-2');

    recordAgent(root, a.id, { role: 'builder', phase: 'start', model: 'opus' }, config);
    const after = recordAgent(root, a.id, { role: 'builder', phase: 'end', usage: { input: 1000, output: 2000, cacheRead: 100000, cacheWrite: 5000 } }, config);
    assert.equal(after.usage.totalTokens, 108000);
    assert.ok(after.usage.byModel['claude-opus-5-5'].estCostUsd > 0);

    fs.writeFileSync(path.join(jobDir(root, a.id), 'tasks.md'), '- [x] one\n- [ ] two\n  - [X] nested\n');
    assert.deepEqual(progress(root, a.id), { done: 2, total: 3 });

    const dir = path.join(jobDir(root, a.id), 'review', 'round-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'code.md'), 'VERDICT: PASS\n\n- [nit] naming\n');
    fs.writeFileSync(path.join(dir, 'ui.md'), 'VERDICT: PASS\n\n- [major] contrast\n');
    let v = roundVerdicts(root, a.id, 1, ['code', 'ui', 'tests'], ['blocker', 'major']);
    assert.equal(v.outcome, 'PENDING');
    fs.writeFileSync(path.join(dir, 'tests.md'), 'Looks fine to me\n');
    v = roundVerdicts(root, a.id, 1, ['code', 'ui', 'tests'], ['blocker', 'major']);
    assert.equal(v.reviewers.code.verdict, 'PASS');
    assert.equal(v.reviewers.ui.verdict, 'CHANGES', 'a tagged major overrides a declared PASS');
    assert.equal(v.reviewers.tests.verdict, 'MALFORMED');
    assert.equal(v.outcome, 'MALFORMED');
    const lenient = roundVerdicts(root, a.id, 1, ['code', 'ui'], ['blocker']);
    assert.equal(lenient.outcome, 'PASS', 'blockOn policy decides what forces a round');
    fs.writeFileSync(path.join(dir, 'security.md'), 'Forgot the verdict line\n\n- [blocker] secret in log\n');
    assert.equal(roundVerdicts(root, a.id, 1, ['security'], ['blocker']).reviewers.security.verdict, 'CHANGES', 'tagged blockers decide even without a verdict line');
    const coerced = roundVerdicts(root, a.id, 1, ['tests'], ['blocker'], { malformedAs: 'changes' }).reviewers.tests;
    assert.equal(coerced.verdict, 'CHANGES');
    assert.equal(coerced.coerced, true, 'a second malformed review is counted as CHANGES, not left pending');

    const idir = path.join(jobDir(root, a.id), 'review', 'integration');
    assert.equal(roundVerdicts(root, a.id, 'integration', ['code'], ['blocker', 'major']).outcome, 'PENDING');
    fs.mkdirSync(idir, { recursive: true });
    fs.writeFileSync(path.join(idir, 'code.md'), 'VERDICT: PASS\n\n- [nit] comment\n');
    const integ = roundVerdicts(root, a.id, 'integration', ['code'], ['blocker', 'major']);
    assert.equal(integ.outcome, 'PASS', 'the integration review reads review/integration/, not a round dir');
    assert.equal(integ.round, 'integration');
    assert.equal(integ.reviewers.code.file, path.join('review', 'integration', 'code.md'));
    fs.writeFileSync(path.join(idir, 'code.md'), 'VERDICT: PASS\n\n- [major] dropped a base-side guard\n');
    assert.equal(roundVerdicts(root, a.id, 'integration', ['code'], ['blocker', 'major']).outcome, 'CHANGES');
    fs.writeFileSync(path.join(idir, 'code.md'), 'resolution looks fine\n');
    assert.equal(roundVerdicts(root, a.id, 'integration', ['code'], ['blocker', 'major']).outcome, 'MALFORMED');

    fs.writeFileSync(path.join(jobDir(root, a.id), 'decision.md'), 'ESCALATE: touches the deploy pipeline\n\nRisk: high\n');
    assert.deepEqual(parseDecision(root, a.id), { decision: 'ESCALATE', reason: 'touches the deploy pipeline' });

    setJob(root, a.id, { fields: { 'verdicts.1': { code: 'PASS', ui: 'CHANGES' }, 'verdicts.2': { code: 'PASS', ui: 'PASS' }, decision: 'APPROVE' } });
    const s = computeStats(root);
    assert.equal(s.counts.total, 3);
    assert.equal(s.quality.firstPassReviewRate, 0);
    assert.equal(s.quality.avgRounds, 2);
    assert.equal((s.reviewers.ui as any).changeRate, 0.5);
    assert.equal(loadJob(root, a.id).verdicts['2'].ui, 'PASS');
  } finally {
    repo.cleanup();
  }
});

test('an agent start keeps the lease live past the claim window, and renewals extend it', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const job = createJob(root, config, { title: 'Long build' });
    claimJob(root, job.id, 'session-1');
    // Renewed 45 minutes ago, planted behind the CLI's back: the lease then ends at `expiresAt`.
    const plantRenewal = (expiresInMin: number) => {
      const file = path.join(jobDir(root, job.id), 'job.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.lease.renewedAt = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      raw.lease.expiresAt = new Date(Date.now() + expiresInMin * 60 * 1000).toISOString();
      fs.writeFileSync(file, JSON.stringify(raw));
    };
    // `forge job agent start` records the agent and renews the lease for the longest agent run.
    recordAgent(root, job.id, { role: 'builder', phase: 'start', model: 'opus' }, config);
    renewLease(root, job.id, { ttl: AGENT_LEASE_MS });
    plantRenewal(75);
    assert.throws(() => claimJob(root, job.id, 'session-2'), /being driven by session session-1/, 'an agent lease keeps the claim live past the 30-minute window');
    const before = loadJob(root, job.id).lease.renewedAt!;
    sleepSync(5);
    renewLease(root, job.id);
    assert.ok(loadJob(root, job.id).lease.renewedAt! > before, 'a session-less renewal renews a live lease');
    recordAgent(root, job.id, { role: 'builder', phase: 'end' }, config);
    plantRenewal(-15);
    assert.equal(claimJob(root, job.id, 'session-2').lease.driver, 'session-2', 'an expired lease can be taken over');
  } finally {
    repo.cleanup();
  }
});

test('normalizeEvent sanitises actors and keeps newer events', () => {
  const V = EVENT_SCHEMA_VERSION;
  const FOREMAN = { login: null, source: 'foreman' };
  const UNKNOWN = { login: null, source: 'unknown' };
  // A malformed actor on any version reads as unknown, keeping a sanitised login.
  for (const [actor, want] of [
    [{ login: 'al<ice>', source: 'root' }, { login: 'alice', source: 'unknown' }],
    [{ login: 7, source: 'gh' }, UNKNOWN],
    [{ source: 'env' }, UNKNOWN],
    [['x'], UNKNOWN],
    [42, UNKNOWN],
    [{ login: '`@bob`\n', source: 'gh' }, { login: '@bob', source: 'gh' }],
  ] as const)
    assert.deepEqual(normalizeEvent({ v: V, ts: 't', type: 'budget-ack', actor })!.actor, want, JSON.stringify(actor));
  // A foreman source stays the foreman's whatever its login, so a malformed one never reads as a person's.
  for (const login of [undefined, 7, 'mallory', { x: 1 }])
    assert.deepEqual(normalizeEvent({ v: V, ts: 't', type: 'human', actor: { login, source: 'foreman' } })!.actor, FOREMAN, String(login));
  // A raw legacy "foreman" on a current line is still the foreman's, never a person's.
  assert.deepEqual(normalizeEvent({ v: V, ts: 't', type: 'human', actor: 'foreman' })!.actor, FOREMAN);
  // A newer Forge's event passes through, except that its actor is sanitised.
  assert.deepEqual(normalizeEvent({ v: V + 1, ts: 't', type: 'future', extra: { a: 1 } }), { v: V + 1, ts: 't', type: 'future', extra: { a: 1 } });
  assert.deepEqual(normalizeEvent({ v: V + 1, ts: 't', type: 'future', actor: { login: 'a$b', source: 'sso' } })!.actor, { login: 'ab', source: 'unknown' });
  for (const junk of [null, 'x', 3, []]) assert.equal(normalizeEvent(junk), null);

  // Through the reader: unparseable lines are still dropped.
  const repo = tempRepo();
  try {
    const id = createJob(repo.dir, defaults(), { title: 'Events' }).id;
    fs.appendFileSync(path.join(jobDir(repo.dir, id), 'events.jsonl'), ['{"v":1,"ts":"t","type":"human","action":"rework","actor":"foreman"}', '{not json', '"a string"', ''].join('\n'));
    const ev = readEvents(repo.dir, id);
    assert.deepEqual(ev.at(-1), { v: V, ts: 't', type: 'human', action: 'rework', actor: FOREMAN });
    assert.ok(ev.every((e) => e.v === V && typeof e.type === 'string'));
  } finally {
    repo.cleanup();
  }
});

test('a stored protectedPaths without a hits list reads as no flag', () => {
  const v = JOB_SCHEMA_VERSION;
  assert.equal(normalizeJob({ id: 'x', schemaVersion: v }).protectedPaths, null);
  // Tolerant: a hand-edited value without a hits list reads as no flag.
  for (const bad of ['yes', 1, { hits: 'x' }, []]) assert.equal(normalizeJob({ id: 'x', schemaVersion: v, protectedPaths: bad }).protectedPaths, null, JSON.stringify(bad));
  const flag = { hits: [{ path: 'a', rule: 4, glob: 'a', reason: 'r', blob: null }], more: 0, at: '2026-10-01T00:00:00.000Z', gate: 'commit', head: null };
  assert.deepEqual(normalizeJob({ id: 'x', schemaVersion: v, protectedPaths: flag }).protectedPaths, flag);
});

test('setJob derive decides from the locked job', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const job = createJob(root, defaults(), { title: 'Derived' });
    const file = path.join(jobDir(root, job.id), 'job.json');
    setJob(root, job.id, { stage: 'pr', state: 'waiting', waitingOn: 'pr-review' });
    // The caller loaded `stale` before a session claimed the job: derive must see the claim.
    const stale = loadJob(root, job.id);
    claimJob(root, job.id, 'session-1');
    assert.equal(stale.lease.driver, null);
    const seen: (string | null)[] = [];
    const out = setJob(root, job.id, {
      owned: { 'pr.number': 7 },
      reason: 'static',
      derive: (j) => {
        seen.push(j.lease.driver);
        return j.lease.driver ? { state: 'waiting', waitingOn: 'conflicts', reason: 'derived', owned: { 'pr.number': 8 }, note: 'derived note' } : { stage: 'integrate', state: 'running' };
      },
    });
    assert.deepEqual(seen, ['session-1'], 'called once, with the job as stored at write time');
    assert.equal(out.stage, 'pr');
    assert.equal(out.waitingOn, 'conflicts');
    assert.equal(out.reason, 'derived', 'the derived value wins over the static one');
    assert.equal(out.pr?.number, 8);
    assert.equal(out.lease.driver, 'session-1', 'the lease is untouched');
    const stored = loadJob(root, job.id);
    assert.deepEqual([stored.waitingOn, stored.reason, stored.pr?.number], ['conflicts', 'derived', 8], 'applied in the same write');
    const evs = readEvents(root, job.id);
    const tr = evs.filter((e) => e.type === 'transition').at(-1)!;
    assert.deepEqual([(tr.to as { waitingOn: string | null }).waitingOn, tr.reason], ['conflicts', 'derived'], 'the transition event reads the effective change');
    assert.deepEqual(evs.filter((e) => e.type === 'fields').at(-1)!.fields, { 'pr.number': 8 });
    assert.equal(evs.filter((e) => e.type === 'note').at(-1)!.text, 'derived note');

    for (const bad of [{ stage: 'nope' }, { state: 'nope' }, { waitingOn: 'nope' }, { state: 'waiting', waitingOn: null }]) {
      const bytes = fs.readFileSync(file);
      const count = readEvents(root, job.id).length;
      assert.throws(() => setJob(root, job.id, { owned: { 'pr.number': 9 }, derive: () => bad }), /unknown|needs --waiting-on/, JSON.stringify(bad));
      assert.ok(fs.readFileSync(file).equals(bytes), `${JSON.stringify(bad)}: job.json is byte-identical`);
      assert.equal(readEvents(root, job.id).length, count, `${JSON.stringify(bad)}: no event`);
    }

    const plain = setJob(root, job.id, { reason: 'static only', owned: { 'pr.number': 10 }, derive: () => null });
    assert.deepEqual([plain.stage, plain.state, plain.waitingOn, plain.reason, plain.pr?.number], ['pr', 'waiting', 'conflicts', 'static only', 10], 'a null result applies the static change');
  } finally {
    repo.cleanup();
  }
});

test('setJob refuses locked fields and prototype keys from any caller', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const job = createJob(root, defaults(), { title: 'Locked' });
    const file = path.join(jobDir(root, job.id), 'job.json');
    const eventsFile = path.join(jobDir(root, job.id), 'events.jsonl');
    const refused: [Parameters<typeof setJob>[2], RegExp][] = [
      [{ fields: { branch: 'main' } }, /^--field branch is not settable; use forge job new --branch$/],
      [{ fields: { 'pr.number': 1 } }, /^--field pr is not settable; use forge pr find\|open\|sync$/],
      [{ fields: { '__proto__.polluted': 1 } }, /^--field __proto__\.polluted: __proto__, constructor and prototype are not field names$/],
      [{ fields: { 'meta.constructor.x': 1 } }, /^--field meta\.constructor\.x: __proto__, constructor and prototype are not field names$/],
      [{ fields: { reviewers: 'code' } }, /^--field reviewers must be a JSON array of strings/],
      // A nested key must not write into a list or over the kind, past the whole-value rules.
      [{ fields: { 'reviewers.0': 5 } }, /^--field reviewers must be a JSON array of strings/],
      [{ fields: { 'dependsOn.0': 'nope' } }, /^--field dependsOn must be a JSON array of strings/],
      [{ fields: { complexity: 'huge' } }, /^--field complexity must be low, medium or high, or null$/],
      [{ fields: { 'complexity.x': 1 } }, /^--field complexity must be low, medium or high, or null$/],
      [{ fields: { kind: 'retro' } }, /^--field kind=retro is not settable; use forge job new --kind retro$/],
      [{ fields: { 'kind.x': 1 } }, /^--field kind\.x is not settable; kind is one value/],
      [{ fields: { kind: 'bug', 'kind.x': 1 } }, /^--field kind\.x is not settable; kind is one value/],
      [{ state: 'running', derive: () => ({ fields: { worktree: '/tmp/x' } }) }, /^--field worktree is not settable/],
      [{ owned: { round: 2 } }, /^owned field round is not a locked field; write it through fields$/],
      [{ owned: { 'pr.__proto__.x': 1 } }, /__proto__, constructor and prototype are not field names$/],
      // `owned` never slips a non-locked key past the field rules.
      [{ owned: { worktree: '/tmp/x', reviewers: 'code' } }, /^owned field reviewers is not a locked field/],
    ];
    for (const [change, re] of refused) {
      const bytes = fs.readFileSync(file);
      const events = fs.readFileSync(eventsFile);
      assert.throws(() => setJob(root, job.id, change), (e: Error) => re.test(e.message), JSON.stringify(change));
      assert.ok(fs.readFileSync(file).equals(bytes), `${JSON.stringify(change)}: job.json is byte-identical`);
      assert.ok(fs.readFileSync(eventsFile).equals(events), `${JSON.stringify(change)}: events.jsonl is byte-identical`);
      assert.equal(({} as any).polluted, undefined);
      assert.equal(({} as any).x, undefined);
    }
    assert.throws(() => setJob(root, job.id, { owned: { round: 2 } }), (e: any) => e.code === 'internal');

    // The owning module's write: both keys land, logged as one fields event.
    const out = setJob(root, job.id, { owned: { worktree: '/tmp/wt', port: 4101 }, fields: { size: 'S' } });
    assert.deepEqual([out.worktree, out.port, out.size], ['/tmp/wt', 4101, 'S']);
    assert.deepEqual(readEvents(root, job.id).filter((e) => e.type === 'fields').at(-1)!.fields, { worktree: '/tmp/wt', port: 4101, size: 'S' });

    // A retro job's kind is read inside the lock and can't be changed through fields.
    const retro = createJob(root, defaults(), { title: 'Retro', kind: 'retro' });
    assert.throws(() => setJob(root, retro.id, { fields: { kind: 'feature' } }), (e: Error) => e.message === `job ${retro.id} is a retro job; its kind is not settable`);
    assert.throws(() => setJob(root, retro.id, { fields: { 'kind.x': 1 } }), (e: Error) => e.message === `job ${retro.id} is a retro job; its kind is not settable`);
    assert.equal(loadJob(root, retro.id).kind, 'retro', 'still the string, not an object');
  } finally {
    repo.cleanup();
  }
});

test('agent attach records the id on a running role', async () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const cli = (...args: string[]) => forgeAsync(root, args);
    const answers = path.join(root, '.answers.json');
    fs.writeFileSync(answers, '{}');
    assert.equal((await cli('init', 'write', '--answers', answers)).status, 0);
    const job = createJob(root, config, { title: 'Attach' });
    const off = await cli('job', 'agent', job.id, 'attach', '--role', 'reviewer:code', '--agent-id', 'abc123');
    assert.equal(off.status, 1, 'a role that never started');
    recordAgent(root, job.id, { role: 'reviewer:code', phase: 'start', model: 'opus' }, config);
    const before = loadJob(root, job.id).agents['reviewer:code'];
    const events = readEvents(root, job.id).length;
    const ok = await cli('job', 'agent', job.id, 'attach', '--role', 'reviewer:code', '--agent-id', 'abc123');
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout), { role: 'reviewer:code', status: 'running', agentId: 'abc123' });
    const after = loadJob(root, job.id).agents['reviewer:code'];
    assert.equal(after.agentId, 'abc123');
    assert.deepEqual({ runs: after.runs, startedAt: after.startedAt, status: after.status }, { runs: before.runs, startedAt: before.startedAt, status: before.status });
    assert.equal(readEvents(root, job.id).length, events, 'attach logs no event');

    const file = path.join(jobDir(root, job.id), 'job.json');
    const raw = fs.readFileSync(file, 'utf8');
    for (const bad of ['../x', 'a/b', '']) {
      const r = await cli('job', 'agent', job.id, 'attach', '--role', 'reviewer:code', '--agent-id', bad);
      assert.equal(r.status, 2, bad);
      assert.match(r.stderr, /--agent-id/);
    }
    assert.equal((await cli('job', 'agent', job.id, 'attach', '--role', 'reviewer:code')).status, 2, 'no --agent-id');
    assert.equal(fs.readFileSync(file, 'utf8'), raw, 'a refused id writes nothing');

    recordAgent(root, job.id, { role: 'reviewer:code', phase: 'end' }, config);
    assert.equal((await cli('job', 'agent', job.id, 'attach', '--role', 'reviewer:code', '--agent-id', 'def456')).status, 1, 'an ended role');
    assert.equal((await cli('job', 'agent', job.id, 'attach', '--role', '__proto__', '--agent-id', 'def456')).status, 1);
  } finally {
    repo.cleanup();
  }
});

test('finishing a job ends the agents it still marks running', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    for (const state of ['cancelled', 'done']) {
      const job = createJob(root, config, { title: `Finished ${state}` });
      setJob(root, job.id, { stage: 'build', state: 'running' });
      recordAgent(root, job.id, { role: 'builder', phase: 'start', model: 'opus' }, config);
      recordAgent(root, job.id, { role: 'spec-writer', phase: 'start', model: 'opus' }, config);
      recordAgent(root, job.id, { role: 'spec-writer', phase: 'end', summary: 'SPEC: ready' }, config);
      setJob(root, job.id, { state: 'failed' });
      assert.equal(loadJob(root, job.id).agents.builder.status, 'running', 'a failed job can resume, so its agents stay');

      const after = setJob(root, job.id, { state });
      assert.equal(after.agents.builder.status, 'lost');
      assert.equal(after.agents.builder.summary, `lost: the job was ${state} while it ran`);
      assert.ok(after.agents.builder.endedAt);
      assert.deepEqual({ status: after.agents['spec-writer'].status, summary: after.agents['spec-writer'].summary }, { status: 'done', summary: 'SPEC: ready' }, 'an ended agent is left alone');
      assert.equal(loadJob(root, job.id).agents.builder.status, 'lost', 'written to job.json');

      const events = readEvents(root, job.id);
      const end = events.findLast((e) => e.type === 'agent-end');
      assert.deepEqual({ role: end?.role, status: end?.status, model: end?.model }, { role: 'builder', status: 'lost', model: 'opus' });
      assert.ok(events.indexOf(end!) > events.findLastIndex((e) => e.type === 'transition'), 'the agent ends after the transition that finished the job');

      setJob(root, job.id, { state });
      assert.equal(readEvents(root, job.id).filter((e) => e.type === 'agent-end').length, events.filter((e) => e.type === 'agent-end').length, 'a repeated set has nothing left to end');
    }
  } finally {
    repo.cleanup();
  }
});

test('an old finished job with an agent marked running reads it as lost', () => {
  const builder = { runs: 2, status: 'running', model: 'opus', agentId: null, startedAt: '2026-10-14T04:40:09.739Z', endedAt: null, round: 1 };
  const base = { schemaVersion: 6, id: 'old', agents: { builder, approver: { runs: 1, status: 'done', endedAt: '2026-10-14T05:00:00.000Z' } }, updatedAt: '2026-10-14T07:18:18.881Z' }; // old-version fixture
  const cancelled = normalizeJob({ ...base, state: 'cancelled', finishedAt: '2026-10-14T07:16:50.745Z' });
  assert.deepEqual(
    { status: cancelled.agents.builder.status, endedAt: cancelled.agents.builder.endedAt, summary: cancelled.agents.builder.summary },
    { status: 'lost', endedAt: '2026-10-14T07:16:50.745Z', summary: 'lost: the job was cancelled while it ran' },
  );
  assert.equal(cancelled.agents.builder.startedAt, builder.startedAt);
  assert.equal(cancelled.agents.approver.status, 'done');
  assert.equal(normalizeJob({ ...base, state: 'done' }).agents.builder.endedAt, base.updatedAt, 'no finishedAt falls back to updatedAt');
  for (const state of ['running', 'failed', 'waiting']) assert.equal(normalizeJob({ ...base, state }).agents.builder.status, 'running', state);
  assert.equal(builder.status, 'running', 'the raw record is not mutated');
});
