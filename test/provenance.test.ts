import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgeSync, tempRepo } from './helpers.ts';
import { defaults } from '../lib/core/config/load.ts';
import { createJob, jobDir, readEvents, recordAgent, setJob } from '../lib/core/job/store.ts';
import { pluginHash } from '../lib/engine/evals/provenance.ts';
import { ARCHIVE_SCHEMA_VERSION, EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION } from '../lib/core/job/schema.ts';
import type { Config } from '../lib/core/types.ts';

const json = (r: { stdout: string }) => JSON.parse(r.stdout);

test('agent-start records the plugin, prompt and config hashes', () => {
  const repo = tempRepo();
  try {
    const f = (...args: string[]) => forgeSync(repo.dir, args);
    const answers = path.join(repo.dir, '.answers.json');
    fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' } }));
    assert.equal(f('init', 'write', '--answers', answers).status, 0);
    const { id } = json(f('job', 'new', '--title', 'Provenance'));
    for (const role of ['builder', 'reviewer:code', 'orchestrator']) assert.equal(f('job', 'agent', id, 'start', '--role', role).status, 0, role);
    const starts = readEvents(repo.dir, id).filter((e) => e.type === 'agent-start');
    const by = Object.fromEntries(starts.map((e) => [e.role, e]));
    const roster = json(f('roster'));
    const agent = (role: string) => roster.agents.find((a: any) => a.role === role).promptHash;

    for (const e of starts) {
      assert.match(String(e.pluginHash), /^[0-9a-f]{10}$/, `${e.role} pluginHash`);
      assert.match(String(e.configHash), /^[0-9a-f]{10}$/, `${e.role} configHash`);
      assert.equal(e.v, EVENT_SCHEMA_VERSION);
    }
    assert.match(String(by.builder.promptHash), /^[0-9a-f]{12}$/);
    assert.equal(by.builder.promptHash, agent('builder'), 'the roster and the event agree');
    const checklist = roster.reviewers.find((r: any) => r.name === 'code').checklistHash;
    const composite = crypto.createHash('sha256').update(`${agent('reviewer')}\0${checklist ?? ''}`).digest('hex').slice(0, 12);
    assert.equal(by['reviewer:code'].promptHash, composite, 'reviewer prompt plus the lens checklist');
    assert.equal(by.orchestrator.promptHash, null, 'no agents/orchestrator.md');

    // An addendum is part of the role's prompt: the next start is a new hash.
    fs.writeFileSync(path.join(repo.dir, '.forge', 'notes', 'builder.md'), '# Builder addendum\n\n- **x** — y\n');
    f('job', 'agent', id, 'start', '--role', 'builder');
    const again = readEvents(repo.dir, id).filter((e) => e.type === 'agent-start' && e.role === 'builder');
    assert.notEqual(again[1].promptHash, again[0].promptHash);
    assert.equal(again[1].promptHash, json(f('roster')).agents.find((a: any) => a.role === 'builder').promptHash);
  } finally {
    repo.cleanup();
  }
});

test('agent-start provenance is best effort: a hash that throws is null, and the start is still recorded', () => {
  const repo = tempRepo();
  try {
    const config = defaults();
    const { id } = createJob(repo.dir, config, { title: 'Broken panel' });
    // A panel that is not a list makes the lens checklist lookup throw.
    const broken = { ...config, review: { ...config.review, panel: {} } } as unknown as Config;
    recordAgent(repo.dir, id, { role: 'reviewer:code', phase: 'start' }, broken);
    const [start] = readEvents(repo.dir, id).filter((e) => e.type === 'agent-start');
    assert.equal(start.promptHash, null);
    assert.match(String(start.pluginHash), /^[0-9a-f]{10}$/, 'the other hashes are still recorded');
  } finally {
    repo.cleanup();
  }
});

test('pluginHash never follows a linked plugin directory, and caps its walk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plugin-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-'));
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  try {
    put('agents/builder.md', 'builder');
    put('skills/forge/SKILL.md', 'skill');
    put('lib/engine/pipeline/step/order.ts', 'order');
    put('lib/engine/pipeline/brief.ts', 'brief');
    fs.writeFileSync(path.join(outside, 'x.md'), 'outside');
    const real = pluginHash(root);
    // A listed directory, or one above a listed path, that is a link: a marker, and its target is never read.
    for (const rel of ['lib/engine/pipeline/step', 'skills/forge', 'skills', 'lib', 'agents']) {
      const moved = path.join(root, `${rel}.moved`);
      fs.renameSync(path.join(root, rel), moved);
      fs.symlinkSync(outside, path.join(root, rel));
      const linked = pluginHash(root);
      assert.notEqual(linked, real, `${rel}: the link changes the hash`);
      fs.writeFileSync(path.join(outside, 'x.md'), `edited under ${rel}`);
      assert.equal(pluginHash(root), linked, `${rel}: nothing outside the root is hashed`);
      fs.rmSync(path.join(root, rel));
      fs.renameSync(moved, path.join(root, rel));
      assert.equal(pluginHash(root), real, `${rel}: undone`);
    }
    // The walk stops at its caps, and the hash says it stopped.
    assert.equal(pluginHash(root, { entries: 100, bytes: 1024 }), real, 'under the caps nothing changes');
    assert.notEqual(pluginHash(root, { entries: 1, bytes: 1024 }), real, 'past the entry cap');
    assert.notEqual(pluginHash(root, { entries: 100, bytes: 3 }), real, 'past the byte cap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

const START = (role: string, ts: string, promptHash: unknown, pluginHash = 'p000000001', configHash = 'c000000001') => ({ v: EVENT_SCHEMA_VERSION, ts, type: 'agent-start', role, promptHash, pluginHash, configHash });

/** Appends events with chosen timestamps, which cohort order and firstAt depend on. */
function events(root: string, id: string, lines: Record<string, unknown>[]): void {
  fs.appendFileSync(path.join(jobDir(root, id), 'events.jsonl'), lines.map((l) => JSON.stringify(l) + '\n').join(''));
}

test('stats --by prompt groups jobs by the hashes their agents ran on', () => {
  const repo = tempRepo();
  const root = repo.dir;
  try {
    const c = defaults();
    const a = createJob(root, c, { title: 'Job A' });
    const b = createJob(root, c, { title: 'Job B' });
    const none = createJob(root, c, { title: 'Job none' });
    const old = createJob(root, c, { title: 'Job old' });
    const ev = createJob(root, c, { title: 'Job eval', kind: 'eval' });
    setJob(root, a.id, { state: 'done' });
    events(root, a.id, [START('builder', '2026-10-02T10:00:00.000Z', 'aaaaaaaaaaa1'), START('reviewer:code', '2026-10-02T11:00:00.000Z', 'rrrrrrrrrrr1')]);
    // B straddled a prompt change: it is keyed by the last start, and counted as mixed.
    events(root, b.id, [START('builder', '2026-10-03T10:00:00.000Z', 'aaaaaaaaaaa1'), START('builder', '2026-10-04T10:00:00.000Z', 'bbbbbbbbbbb2', 'p000000002')]);
    // A start from before provenance has no hash: unrecorded.
    events(root, old.id, [{ v: 2, ts: '2026-10-01T10:00:00.000Z', type: 'agent-start', role: 'builder' }]); // old-version fixture: an event v2 start
    events(root, ev.id, [START('builder', '2026-10-01T09:00:00.000Z', 'eeeeeeeeeee1')]);
    // An archived job counts, from its archived events.
    const dir = path.join(root, '.forge', 'archive');
    fs.mkdirSync(dir, { recursive: true });
    const archivedJob = { schemaVersion: JOB_SCHEMA_VERSION, id: 'arch', title: 'Archived', kind: 'feature', state: 'done', stage: 'done', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
    fs.writeFileSync(
      path.join(dir, 'arch.json'),
      JSON.stringify({ archiveVersion: ARCHIVE_SCHEMA_VERSION, id: 'arch', archivedAt: '2026-10-05T00:00:00.000Z', trigger: 'cli', job: archivedJob, events: [START('builder', '2026-10-01T12:00:00.000Z', 'aaaaaaaaaaa1', 'p000000000', 'c000000009')], summary: {} }),
    );

    const r = forgeSync(root, ['stats', '--by', 'prompt']);
    assert.equal(r.status, 0, r.stderr);
    const s = json(r);
    assert.deepEqual([s.by, s.role, s.since, s.unrecorded, s.mixed], ['prompt', 'builder', null, 2, 1], 'none and old are unrecorded; the eval is left out');
    assert.deepEqual(
      s.cohorts.map((x: any) => [x.promptHash, x.jobs, x.jobIds, x.firstAt, x.lastAt, x.pluginHashes, x.configHashes]),
      [
        ['aaaaaaaaaaa1', 2, ['arch', a.id], '2026-10-01T12:00:00.000Z', '2026-10-02T10:00:00.000Z', ['p000000000', 'p000000001'], ['c000000009', 'c000000001']],
        ['bbbbbbbbbbb2', 1, [b.id], '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z', ['p000000002'], ['c000000001']],
      ],
    );
    const first = s.cohorts[0].stats;
    assert.deepEqual([first.counts.total, first.counts.done, first.counts.archived], [2, 2, 1], 'stats over the cohort only');
    assert.equal(s.cohorts[1].stats.counts.total, 1);

    const withEvals = json(forgeSync(root, ['stats', '--by', 'prompt', '--include-evals']));
    assert.equal(withEvals.cohorts[0].promptHash, 'eeeeeeeeeee1', 'oldest cohort first');

    const reviewer = json(forgeSync(root, ['stats', '--by', 'prompt', '--role', 'reviewer:code']));
    assert.deepEqual([reviewer.role, reviewer.cohorts.map((x: any) => [x.promptHash, x.jobIds]), reviewer.unrecorded], ['reviewer:code', [['rrrrrrrrrrr1', [a.id]]], 4]);

    const since = json(forgeSync(root, ['stats', '--by', 'prompt', '--since', '2099-01-01']));
    assert.deepEqual([since.since, since.cohorts, since.unrecorded], ['2099-01-01', [], 0]);
  } finally {
    repo.cleanup();
  }
});

test('stats --by prompt refusals', () => {
  const repo = tempRepo();
  try {
    for (const args of [
      ['--by', 'prompt', '--role', 'orchestrator'],
      ['--by', 'prompt', '--role', 'reviewer:Bad!'],
      ['--by', 'prompt', '--role', '../agents/builder'],
      ['--by', 'prompt', '--csv'],
    ]) {
      const r = forgeSync(repo.dir, ['stats', ...args, '--json']);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(json(r).error.code, 'usage', args.join(' '));
    }
    const role = forgeSync(repo.dir, ['stats', '--by', 'role', '--json']);
    assert.equal(role.status, 2);
    assert.match(json(role).error.message, /--by needs --csv/, 'the other --by values keep their error');
  } finally {
    repo.cleanup();
  }
});
