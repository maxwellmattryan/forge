// The recorded inputs `forge job step` decides from (issue #68): schema v6, output checks at
// `agent end`, `agent start --output/--retry`, and the facts other commands now record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, loadJob, readEvents } from '../lib/jobs.ts';
import { JOB_SCHEMA_VERSION, normalizeJob } from '../lib/schema.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

function scratch(answers: Record<string, unknown> = {}) {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const raw = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env });
  const f = (...args: string[]) => {
    const r = raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const answersFile = path.join(path.dirname(repo.dir), `answers-${path.basename(repo.dir)}.json`);
  const init = (a: Record<string, unknown>) => {
    fs.writeFileSync(answersFile, JSON.stringify({ worktrees: { root: `../${path.basename(repo.dir)}.wt` }, ...a }));
    f('init', 'write', '--answers', answersFile);
  };
  init(answers);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
  };
  return { repo, root: repo.dir, f, raw, init, cleanup };
}

const commitAll = (cwd: string, msg: string) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};

/** Every file under dir with its bytes, so a test can assert nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    const p = path.join(dir, f);
    const st = fs.lstatSync(p);
    out[f] = st.isSymbolicLink() ? `<link ${fs.readlinkSync(p)}>` : st.isDirectory() ? '<dir>' : fs.readFileSync(p, 'base64');
  }
  return out;
}

test('reads a v5 job', () => {
  const s = scratch();
  try {
    assert.equal(JOB_SCHEMA_VERSION, 17);
    const job = createJob(s.root, defaults(), { title: 'Old v5' });
    const file = path.join(jobDir(s.root, job.id), 'job.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.splitMode;
    raw.schemaVersion = 5;
    raw.agents = { builder: { runs: 2, status: 'done', agentId: 'a1', startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:02:00.000Z', round: 1, importedThrough: { a1: '2026-10-01T10:02:00.000Z' } } };
    raw.verifyRuns = [{ round: 1, attempt: 1, sha: 'abc', ok: false, at: '2026-10-01T10:03:00.000Z', file: 'verify/round-1.md' }];
    fs.writeFileSync(file, JSON.stringify(raw));
    const loaded = loadJob(s.root, job.id);
    assert.equal(loaded.schemaVersion, 17);
    assert.equal(loaded.splitMode, null);
    assert.equal(loaded.effort, null);
    assert.deepEqual(loaded.agents, raw.agents, 'agents are otherwise unchanged');
    assert.deepEqual(loaded.verifyRuns, raw.verifyRuns, 'verify runs are otherwise unchanged');
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 5 }).splitMode, null);
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 18 })._unsupported, true);

    const migrated = s.f('migrate');
    assert.ok(migrated.changed.includes(path.relative(s.root, file)));
    const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rewritten.schemaVersion, 17);
    assert.equal(rewritten.splitMode, null);
    assert.equal(rewritten.effort, null);
  } finally {
    s.cleanup();
  }
});

test('agent end flags a reviewer that wrote no review', () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'Reviewer output');
    s.f('job', 'round', id);
    s.f('job', 'agent', id, 'start', '--role', 'reviewer:code', '--model', 'opus');
    const end = s.f('job', 'agent', id, 'end', '--role', 'reviewer:code', '--summary', 'VERDICT: PASS');
    assert.equal(end.outputMissing, true, 'in the JSON result');
    assert.equal(loadJob(s.root, id).agents['reviewer:code'].outputMissing, true, 'on the agent record');
    const ev = readEvents(s.root, id).filter((e) => e.type === 'agent-end').at(-1)!;
    assert.equal(ev.outputMissing, true, 'in the agent-end event');

    s.f('job', 'agent', id, 'start', '--role', 'reviewer:code', '--model', 'opus');
    assert.equal(loadJob(s.root, id).agents['reviewer:code'].outputMissing, undefined, 'a new start clears it');
    fs.writeFileSync(path.join(jobDir(s.root, id), 'review', 'round-1', 'code.md'), 'VERDICT: PASS\n');
    const ok = s.f('job', 'agent', id, 'end', '--role', 'reviewer:code', '--summary', 'VERDICT: PASS');
    assert.equal(ok.outputMissing, false);
    assert.equal(loadJob(s.root, id).agents['reviewer:code'].outputMissing, false);
    assert.equal(readEvents(s.root, id).filter((e) => e.type === 'agent-end').at(-1)!.outputMissing, false);

    // A role with no known output records nothing.
    s.f('job', 'agent', id, 'start', '--role', 'builder');
    const b = s.f('job', 'agent', id, 'end', '--role', 'builder');
    assert.equal('outputMissing' in b, false);
    assert.equal(loadJob(s.root, id).agents.builder.outputMissing, undefined);
  } finally {
    s.cleanup();
  }
});

test('agent end checks approver and spec-writer outputs', () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'Approver output');
    const dir = jobDir(s.root, id);
    // A decision.md from an earlier run predates this start, so it does not count.
    fs.writeFileSync(path.join(dir, 'decision.md'), 'APPROVE: old\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, 'decision.md'), old, old);
    s.f('job', 'agent', id, 'start', '--role', 'approver');
    assert.equal(s.f('job', 'agent', id, 'end', '--role', 'approver').outputMissing, true, 'stale decision.md');
    s.f('job', 'agent', id, 'start', '--role', 'approver');
    fs.writeFileSync(path.join(dir, 'decision.md'), 'APPROVE: fresh\n');
    assert.equal(s.f('job', 'agent', id, 'end', '--role', 'approver').outputMissing, false);

    s.f('job', 'agent', id, 'start', '--role', 'spec-writer');
    assert.equal(s.f('job', 'agent', id, 'end', '--role', 'spec-writer', '--summary', 'SPEC: done').outputMissing, true);
    s.f('job', 'agent', id, 'start', '--role', 'spec-writer');
    assert.equal(s.f('job', 'agent', id, 'end', '--role', 'spec-writer', '--summary', 'NEEDS-INPUT').outputMissing, true, 'NEEDS-INPUT without questions.md');
    s.f('job', 'agent', id, 'start', '--role', 'spec-writer');
    fs.writeFileSync(path.join(dir, 'questions.md'), '1. Which?\n');
    assert.equal(s.f('job', 'agent', id, 'end', '--role', 'spec-writer', '--summary', 'NEEDS-INPUT').outputMissing, false, 'questions.md answers for it');
    s.f('job', 'agent', id, 'start', '--role', 'spec-writer');
    fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec\n');
    assert.equal(s.f('job', 'agent', id, 'end', '--role', 'spec-writer', '--summary', 'SPEC: done').outputMissing, false);
  } finally {
    s.cleanup();
  }
});

test('agent start records output and retry, refuses escapes', () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'Output flags');
    const dir = jobDir(s.root, id);
    s.f('job', 'agent', id, 'start', '--role', 'planner', '--output', path.join(dir, 'nested', 'deeper', 'plan.md'), '--retry');
    let a = loadJob(s.root, id).agents.planner;
    assert.equal(a.output, path.join('nested', 'deeper', 'plan.md'));
    assert.equal(a.retry, true);
    assert.ok(fs.statSync(path.join(dir, 'nested', 'deeper')).isDirectory(), 'the parent dir is created');
    s.f('job', 'agent', id, 'end', '--role', 'planner');
    assert.equal(loadJob(s.root, id).agents.planner.outputMissing, true, 'the recorded output is checked');

    s.f('job', 'agent', id, 'start', '--role', 'planner', '--output', 'plan.md');
    a = loadJob(s.root, id).agents.planner;
    assert.equal(a.output, 'plan.md', 'relative to the job dir');
    assert.equal(a.retry, false);

    const outside = path.join(path.dirname(s.root), `escape-${path.basename(s.root)}`);
    const absent = path.join(path.dirname(s.root), `escape-abs-${path.basename(s.root)}`);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dir, 'link'));
    // A dangling link is an existing entry too: it resolves outside, so it is refused, not skipped.
    fs.symlinkSync(path.join(outside, 'not-yet'), path.join(dir, 'dangling'));
    try {
      for (const bad of ['../x/y.md', path.join(absent, 'y.md'), 'link/sub/y.md', 'dangling/sub/y.md', '.']) {
        const before = snapshot(dir);
        const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
        const r = s.raw('job', 'agent', id, 'start', '--role', 'reviewer:code', '--output', bad);
        assert.equal(r.status, 1, bad);
        assert.match(r.stderr, /--output must be inside the job dir/, bad);
        assert.deepEqual(snapshot(dir), before, `${bad}: nothing written`);
        assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), events);
      }
      assert.deepEqual(fs.readdirSync(outside), [], 'no directory created through the symlink');
      assert.equal(fs.existsSync(path.join(path.dirname(dir), 'x')), false);
      assert.equal(fs.existsSync(absent), false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    s.cleanup();
  }
});

test('recorded inputs for step', () => {
  const s = scratch({ tracker: { kind: 'local' } });
  try {
    // from-ref names the split mode of the job it creates; next --claim does not.
    s.f('tracker', 'create', '--title', 'Picked issue');
    s.f('tracker', 'create', '--title', 'Queued issue');
    const picked = s.f('job', 'from-ref', 'picked-issue', '--session', 's0');
    assert.equal(loadJob(s.root, picked.id).splitMode, 'never');
    const next = s.f('next', '--claim', '--session', 's1');
    assert.equal(next.id, 'queued-issue');
    assert.equal(loadJob(s.root, next.id).splitMode, null);
    const again = s.f('job', 'from-ref', 'queued-issue');
    assert.equal(again.existing, true);
    assert.equal(loadJob(s.root, next.id).splitMode, null, 'an existing job is not changed');

    s.f('job', 'human', next.id, 'revise-split', '--note', 'one job');
    assert.equal(loadJob(s.root, next.id).splitMode, 'never');
    assert.equal(readEvents(s.root, next.id).filter((e) => e.type === 'human').at(-1)!.action, 'revise-split');
  } finally {
    s.cleanup();
  }

  const v = scratch({ commands: { test: 'test -f ok.txt' }, verify: ['test'] });
  try {
    fs.mkdirSync(path.join(v.root, 'test'));
    fs.writeFileSync(path.join(v.root, 'test', 'a.test.mjs'), "test('one', () => {});\n");
    commitAll(v.root, 'tests');
    const { id } = v.f('job', 'new', '--title', 'Verify failure');
    const wt = v.f('worktree', 'create', id).path;
    v.f('job', 'round', id);
    const last = () => loadJob(v.root, id).verifyRuns.at(-1)!;
    assert.equal(v.raw('verify', id).status, 1);
    assert.equal(last().failure, 'test', 'a failing test step');
    fs.writeFileSync(path.join(wt, 'ok.txt'), 'x');
    commitAll(wt, 'ok');
    assert.equal(v.raw('verify', id).status, 0);
    assert.equal(last().failure, null, 'a pass');
    fs.rmSync(path.join(wt, 'test', 'a.test.mjs'));
    commitAll(wt, 'drop a test');
    v.init({ commands: { test: 'test -f ok.txt' }, verify: ['test'], verifyIntegrity: 'block' });
    assert.equal(v.raw('verify', id).status, 1);
    assert.equal(last().failure, 'integrity', 'under verifyIntegrity: block');

    fs.writeFileSync(path.join(jobDir(v.root, id), 'spec.md'), '# Spec\n\n## Approach\n- `ok.txt`\n');
    const scope = v.f('job', 'scope', id);
    const ev = readEvents(v.root, id).filter((e) => e.type === 'scope').at(-1)!;
    assert.deepEqual({ round: ev.round, head: ev.head }, { round: 1, head: scope.head });
  } finally {
    v.cleanup();
  }
});

test('job panel records the event step reads', () => {
  const s = scratch({ commands: { test: 'true' }, verify: ['test'] });
  try {
    const { id } = s.f('job', 'new', '--title', 'Panel event');
    const wt = s.f('worktree', 'create', id).path;
    s.f('job', 'round', id);
    fs.writeFileSync(path.join(jobDir(s.root, id), 'spec.md'), '# Spec\n\nSuggested reviewers: security\n\n## Approach\n- `ok.txt`\n');
    fs.writeFileSync(path.join(wt, 'ok.txt'), 'x');
    commitAll(wt, 'ok');
    assert.equal(s.raw('verify', id).status, 0);
    s.f('job', 'set', id, '--stage', 'review', '--state', 'running');
    let a = s.f('job', 'step', id);
    assert.deepEqual([a.rule, a.command], ['RV9', ['job', 'panel', id]]);
    const panel = s.f(...a.command);
    const ev = readEvents(s.root, id).filter((e) => e.type === 'panel').at(-1)!;
    assert.deepEqual({ round: ev.round, head: ev.head, lenses: ev.lenses }, { round: 1, head: panel.head, lenses: ['code', 'tests', 'security'] });
    a = s.f('job', 'step', id);
    assert.deepEqual([a.rule, a.command], ['RV2', ['job', 'scope', id]]);
    // A later verify makes the panel stale again.
    assert.equal(s.raw('verify', id).status, 0);
    assert.equal(s.f('job', 'step', id).rule, 'RV9');
  } finally {
    s.cleanup();
  }
});
