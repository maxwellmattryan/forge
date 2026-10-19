import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { claimJob, createJob, loadJob, readEvents, roundVerdicts, setJob, recordAgent, progress, parseDecision, touchJob, jobDir } from '../lib/jobs.ts';
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
    assert.equal(claimJob(root, a.id, 'session-2', true).owner.session, 'session-2');

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

test('claims stay alive while an agent runs, and heartbeats refresh on touch', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const job = createJob(root, config, { title: 'Long build' });
    claimJob(root, job.id, 'session-1');
    // Every write refreshes the heartbeat, so a stale one has to be planted behind the CLI's back.
    const plantStaleHeartbeat = () => {
      const file = path.join(jobDir(root, job.id), 'job.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.owner.heartbeat = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      fs.writeFileSync(file, JSON.stringify(raw));
    };
    recordAgent(root, job.id, { role: 'builder', phase: 'start', model: 'opus' }, config);
    plantStaleHeartbeat();
    assert.throws(() => claimJob(root, job.id, 'session-2'), /an agent is still running/, 'a running agent keeps the claim alive past the heartbeat window');
    const before = loadJob(root, job.id).owner.heartbeat;
    sleepSync(5);
    touchJob(root, job.id);
    assert.ok(loadJob(root, job.id).owner.heartbeat > before, 'touch refreshes the heartbeat');
    recordAgent(root, job.id, { role: 'builder', phase: 'end' }, config);
    plantStaleHeartbeat();
    assert.equal(claimJob(root, job.id, 'session-2').owner.session, 'session-2', 'a stale claim with no running agent can be taken over');
  } finally {
    repo.cleanup();
  }
});

test('reads a schema v1 job and migrates its verify results', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const job = createJob(root, defaults(), { title: 'Old job' });
    const file = path.join(jobDir(root, job.id), 'job.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.verifyRuns;
    fs.writeFileSync(file, JSON.stringify({ ...raw, schemaVersion: 1, verify: { 1: 'FAIL', 2: 'PASS' } }));
    const loaded = loadJob(root, job.id);
    assert.equal(loaded.schemaVersion, JOB_SCHEMA_VERSION);
    assert.deepEqual(
      loaded.verifyRuns.map((r) => [r.round, r.attempt, r.ok, r.sha]),
      [[1, 1, false, null], [2, 1, true, null]],
      'old per-round results become attempt 1 with no sha',
    );
    assert.equal(loaded.verify[1], 'FAIL', 'the compatible field survives');
  } finally {
    repo.cleanup();
  }
});

test('reads v1 events into the v2 actor shape', () => {
  assert.equal(EVENT_SCHEMA_VERSION, 2);
  const FOREMAN = { login: null, source: 'foreman' };
  const UNKNOWN = { login: null, source: 'unknown' };
  const v1 = { v: 1, ts: 't', type: 'human', action: 'approve' };
  assert.deepEqual(normalizeEvent({ ...v1, actor: 'foreman' }), { ...v1, v: 2, actor: FOREMAN });
  assert.deepEqual(normalizeEvent({ ...v1, actor: 'human' }), { ...v1, v: 2, actor: UNKNOWN });
  assert.deepEqual(normalizeEvent(v1), { ...v1, v: 2, actor: UNKNOWN }, 'a v1 human event without actor');
  const { v: _, ...unversioned } = v1;
  assert.deepEqual(normalizeEvent({ ...unversioned, actor: 'foreman' }), { ...v1, v: 2, actor: FOREMAN }, 'no v reads as v1');
  // Other v1 events are kept and get no actor.
  assert.deepEqual(normalizeEvent({ v: 1, ts: 't', type: 'claimed', session: 's' }), { v: 2, ts: 't', type: 'claimed', session: 's' });
  // A malformed actor on any version reads as unknown, keeping a sanitised login.
  for (const [actor, want] of [
    [{ login: 'al<ice>', source: 'root' }, { login: 'alice', source: 'unknown' }],
    [{ login: 7, source: 'gh' }, UNKNOWN],
    [{ source: 'env' }, UNKNOWN],
    [['x'], UNKNOWN],
    [42, UNKNOWN],
    [{ login: '`@bob`\n', source: 'gh' }, { login: '@bob', source: 'gh' }],
  ] as const)
    assert.deepEqual(normalizeEvent({ v: 2, ts: 't', type: 'budget-ack', actor })!.actor, want, JSON.stringify(actor));
  // A foreman source stays the foreman's whatever its login, so a malformed one never reads as a person's.
  for (const login of [undefined, 7, 'mallory', { x: 1 }])
    assert.deepEqual(normalizeEvent({ v: 2, ts: 't', type: 'human', actor: { login, source: 'foreman' } })!.actor, FOREMAN, String(login));
  // A raw legacy "foreman" on a v2 line is still the foreman's, never a person's.
  assert.deepEqual(normalizeEvent({ v: 2, ts: 't', type: 'human', actor: 'foreman' })!.actor, FOREMAN);
  // A newer Forge's event passes through, except that its actor is sanitised.
  assert.deepEqual(normalizeEvent({ v: 3, ts: 't', type: 'future', extra: { a: 1 } }), { v: 3, ts: 't', type: 'future', extra: { a: 1 } });
  assert.deepEqual(normalizeEvent({ v: 3, ts: 't', type: 'future', actor: { login: 'a$b', source: 'sso' } })!.actor, { login: 'ab', source: 'unknown' });
  for (const junk of [null, 'x', 3, []]) assert.equal(normalizeEvent(junk), null);

  // Through the reader: unparseable lines are still dropped.
  const repo = tempRepo();
  try {
    const id = createJob(repo.dir, defaults(), { title: 'Events' }).id;
    fs.appendFileSync(path.join(jobDir(repo.dir, id), 'events.jsonl'), ['{"v":1,"ts":"t","type":"human","action":"rework","actor":"foreman"}', '{not json', '"a string"', ''].join('\n'));
    const ev = readEvents(repo.dir, id);
    assert.deepEqual(ev.at(-1), { v: 2, ts: 't', type: 'human', action: 'rework', actor: FOREMAN });
    assert.ok(ev.every((e) => e.v === 2 && typeof e.type === 'string'));
  } finally {
    repo.cleanup();
  }
});

test('v9 job gains protectedPaths null', () => {
  const repo = tempRepo();
  try {
    assert.equal(JOB_SCHEMA_VERSION, 14);
    const job = createJob(repo.dir, defaults(), { title: 'Old v9' });
    const file = path.join(jobDir(repo.dir, job.id), 'job.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.protectedPaths;
    fs.writeFileSync(file, JSON.stringify({ ...raw, schemaVersion: 9 }));
    const loaded = loadJob(repo.dir, job.id);
    assert.equal(loaded.schemaVersion, 14);
    assert.equal(loaded.protectedPaths, null);
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 10 }).protectedPaths, null);
    // Tolerant: a hand-edited value without a hits list reads as no flag.
    for (const bad of ['yes', 1, { hits: 'x' }, []]) assert.equal(normalizeJob({ id: 'x', schemaVersion: 10, protectedPaths: bad }).protectedPaths, null, JSON.stringify(bad));
    const flag = { hits: [{ path: 'a', rule: 4, glob: 'a', reason: 'r', blob: null }], more: 0, at: '2026-10-01T00:00:00.000Z', gate: 'commit', head: null };
    assert.deepEqual(normalizeJob({ id: 'x', schemaVersion: 10, protectedPaths: flag }).protectedPaths, flag);
  } finally {
    repo.cleanup();
  }
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
    assert.equal(stale.owner, null);
    const seen: (string | null)[] = [];
    const out = setJob(root, job.id, {
      fields: { 'pr.number': 7 },
      reason: 'static',
      derive: (j) => {
        seen.push(j.owner?.session ?? null);
        return j.owner ? { state: 'waiting', waitingOn: 'conflicts', reason: 'derived', fields: { 'pr.number': 8 }, note: 'derived note' } : { stage: 'integrate', state: 'running' };
      },
    });
    assert.deepEqual(seen, ['session-1'], 'called once, with the job as stored at write time');
    assert.equal(out.stage, 'pr');
    assert.equal(out.waitingOn, 'conflicts');
    assert.equal(out.reason, 'derived', 'the derived value wins over the static one');
    assert.equal(out.pr?.number, 8);
    assert.equal(out.owner?.session, 'session-1', 'the owner is untouched');
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
      assert.throws(() => setJob(root, job.id, { fields: { 'pr.number': 9 }, derive: () => bad }), /unknown|needs --waiting-on/, JSON.stringify(bad));
      assert.ok(fs.readFileSync(file).equals(bytes), `${JSON.stringify(bad)}: job.json is byte-identical`);
      assert.equal(readEvents(root, job.id).length, count, `${JSON.stringify(bad)}: no event`);
    }

    const plain = setJob(root, job.id, { reason: 'static only', fields: { 'pr.number': 10 }, derive: () => null });
    assert.deepEqual([plain.stage, plain.state, plain.waitingOn, plain.reason, plain.pr?.number], ['pr', 'waiting', 'conflicts', 'static only', 10], 'a null result applies the static change');
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
