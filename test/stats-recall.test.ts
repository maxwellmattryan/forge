import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { defaults } from '../lib/core/config/load.ts';
import { createJob, jobDir, setJob } from '../lib/core/job/store.ts';
import { prepareRetro } from '../lib/engine/evals/retro.ts';
import { ARCHIVE_SCHEMA_VERSION, JOB_SCHEMA_VERSION } from '../lib/core/job/schema.ts';
import { computeStats, utcMonday } from '../lib/engine/metrics/stats.ts';
import type { Config } from '../lib/core/types.ts';

const SHA = 'c'.repeat(40);
const delta = (files: string[]) => ({ status: 'measured', commits: 1, linesAdded: 3, linesDeleted: 1, lines: 4, fileCount: files.length, files });
const outcome = (extra: Record<string, unknown>) => ({
  status: 'final', windowDays: 14, mergedAt: '2026-09-01T00:00:00.000Z', closesAt: '2026-09-15T00:00:00.000Z', mergeSha: SHA,
  reverted: false, revertedBy: null, followUps: 0, followUpRefs: [], churn: { commits: 0, lines: 0, files: 0 }, measuredAt: '2026-09-16T00:00:00.000Z', attempts: 0, ...extra,
});

/** A job the given lenses reviewed in round 1, with job.json fields (pr, outcome, createdAt) set. */
function reviewed(root: string, lenses: string[], fields: Record<string, unknown> = {}): string {
  const { id } = createJob(root, defaults(), { title: `Reviewed ${lenses.join(' ')} ${Math.random()}` });
  const { pr, createdAt, ...rest } = fields;
  const owned = Object.fromEntries(Object.entries({ pr, createdAt }).filter(([, v]) => v !== undefined));
  setJob(root, id, { state: 'done', owned, fields: { 'verdicts.1': Object.fromEntries(lenses.map((l) => [l, 'PASS'])), ...rest } });
  return id;
}

/** Review files for round 1, one per lens. */
function reviews(root: string, id: string, byLens: Record<string, string[]>): void {
  const dir = path.join(jobDir(root, id), 'review', 'round-1');
  fs.mkdirSync(dir, { recursive: true });
  for (const [lens, lines] of Object.entries(byLens)) fs.writeFileSync(path.join(dir, `${lens}.md`), ['VERDICT: CHANGES', '', ...lines, ''].join('\n'));
}

function panelConfig(): Config {
  const c = defaults();
  c.review.panel = [
    { name: 'code', always: true },
    { name: 'security', paths: ['lib/server.ts'] },
    { name: 'docs', paths: ['docs/**'] },
    { name: 'perf', when: 'lib/server.ts hot paths' },
    { name: 'ui', when: 'lib/server.ts', pathsOnly: true },
  ];
  return c;
}

test('escapes are attributed to the lenses that covered them', () => {
  const repo = tempRepo();
  const root = repo.dir;
  try {
    const merged = (extra: Record<string, unknown>) => ({ pr: { number: 1, state: 'MERGED', ...extra } });
    // A measured human delta on lib/server.ts, reviewed by every kind of lens.
    reviewed(root, ['code', 'security', 'docs', 'perf', 'ui', 'lib:realtime', 'gone'], merged({ humanDelta: delta(['lib/server.ts']) }));
    // A revert counts against every lens that reviewed the job.
    reviewed(root, ['code', 'docs'], { ...merged({}), outcome: outcome({ reverted: true }) });
    // A follow-up bug does too.
    reviewed(root, ['code'], { ...merged({}), outcome: outcome({ followUps: 2 }) });
    // A delta outside docs' paths: docs is checked but did not miss it.
    reviewed(root, ['code', 'docs'], merged({ humanDelta: delta(['README.md']) }));
    // Neither a measured delta nor a final outcome: in no denominator.
    reviewed(root, ['code', 'security'], merged({ humanDelta: { ...delta([]), status: 'unavailable' } }));
    reviewed(root, ['code'], { ...merged({}), outcome: outcome({ status: 'open', reverted: true }) });
    // Not merged: a delta on an open PR is no escape.
    reviewed(root, ['code', 'security'], { pr: { number: 2, state: 'OPEN', humanDelta: delta(['lib/server.ts']) } });

    const r = computeStats(root, { config: panelConfig() }).reviewers;
    const miss = (lens: string) => [r[lens].missed, r[lens].missChecked, r[lens].missRate];
    assert.deepEqual(miss('code'), [4, 4, 1], 'always covers every file');
    assert.deepEqual(miss('security'), [1, 1, 1], 'its paths cover lib/server.ts');
    assert.deepEqual(miss('docs'), [1, 3, 0.333], 'the revert only: docs/** covers neither delta');
    assert.deepEqual(miss('perf'), [1, 1, 1], 'a when path token covers it');
    assert.deepEqual(miss('ui'), [0, 1, 0], 'pathsOnly ignores when');
    assert.deepEqual(miss('lib:realtime'), [0, 1, 0], 'a qualified member lens is never covered');
    assert.deepEqual(miss('gone'), [0, 1, 0], 'a lens no longer on the panel is never covered');

    // Without the config nothing is covered by delta files; reverts and follow-ups still count.
    const bare = computeStats(root, {}).reviewers;
    assert.deepEqual([bare.code.missed, bare.code.missChecked], [2, 4]);
    assert.deepEqual([bare.security.missed, bare.security.missChecked, bare.security.missRate], [0, 1, 0]);
  } finally {
    repo.cleanup();
  }
});

test('blocker/major share and its weekly trend', () => {
  const repo = tempRepo();
  const root = repo.dir;
  try {
    // Fourteen jobs, one per week from Monday 2026-07-06, each created on that week's Wednesday.
    const weeks: string[] = [];
    for (let i = 0; i < 14; i++) {
      const created = new Date(Date.UTC(2026, 6, 8 + 7 * i, 15)).toISOString();
      weeks.push(utcMonday(created)!);
      const id = reviewed(root, ['code'], { createdAt: created });
      reviews(root, id, { code: i % 2 ? ['- [major] lib/a.ts — x', '- [nit] lib/c.ts — z', '- [nit] lib/d.ts — w'] : ['- [blocker] lib/a.ts:1 — x', '- [minor] lib/b.ts — y'] });
    }
    assert.equal(weeks[0], '2026-07-06');
    // An archive written before severities: its findings count, but in none of the severity fields.
    const dir = path.join(root, '.forge', 'archive');
    fs.mkdirSync(dir, { recursive: true });
    const job = { schemaVersion: JOB_SCHEMA_VERSION, id: 'old', title: 'Old', kind: 'feature', state: 'done', stage: 'done', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', verdicts: { 1: { code: 'CHANGES' } } };
    const findings = { rounds: [], byLens: { code: { raised: 5, fixed: 0, disputed: 0, recurring: 0 } }, totals: { raised: 5, fixed: 0, disputed: 0, recurring: 0 }, recurring: [], disputed: [] };
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ archiveVersion: ARCHIVE_SCHEMA_VERSION, id: 'old', archivedAt: '2026-07-02T00:00:00.000Z', trigger: 'cli', job, events: [], summary: { findings } }));

    const s = computeStats(root, {}).reviewers.code;
    assert.equal(s.findings, 35 + 5, 'the archive still counts as findings');
    assert.deepEqual([s.blockers, s.blockerMajor, s.severityKnown, s.blockerMajorShare], [7, 14, 35, 0.4]);
    assert.equal(s.severityTrend.length, 12, 'the last 12 weeks with findings');
    assert.deepEqual(s.severityTrend[0], { week: weeks[2], findings: 2, blockerMajor: 1, share: 0.5 }, 'oldest first');
    assert.deepEqual(s.severityTrend[11], { week: weeks[13], findings: 3, blockerMajor: 1, share: 0.333 });
    assert.ok(s.severityTrend.every((t, i) => i === 0 || t.week > s.severityTrend[i - 1].week));
  } finally {
    repo.cleanup();
  }
});

test('retro signals and stats text show per-lens recall', async () => {
  const repo = tempRepo();
  const root = repo.dir;
  try {
    const config = defaults();
    const created = '2026-10-14T12:00:00.000Z';
    const id = reviewed(root, ['code', 'security'], { createdAt: created, pr: { number: 1, state: 'MERGED', humanDelta: delta(['lib/server.ts']) } });
    reviews(root, id, { code: ['- [major] lib/server.ts:3 — x', '- [nit] lib/x.ts — y'] });
    // Only reviews: no merged escape is known, and no finding was raised, so docs gets no line.
    reviewed(root, ['docs'], { createdAt: created });
    const retro = createJob(root, config, { title: 'Retro', kind: 'retro' });
    const res = prepareRetro(root, config, retro.id, { since: '1970-01-01', today: '2026-10-16' });
    const signals = fs.readFileSync(res.signals, 'utf8');
    const at = signals.indexOf('## Per-lens recall\n');
    assert.ok(at >= 0, signals);
    assert.deepEqual(signals.slice(at).split('\n\n')[0].split('\n').slice(1), [
      '- code: missed 1/1 (1) · blocker/major 1/2 (0.5) · trend 2026-10-12:0.5',
      // The default panel's security `when` names no path, so it did not cover the file.
      '- security: missed 0/1 (0) · blocker/major 0/0 (-) · trend -',
    ]);
    const text = await forgeAsync(root, ['stats']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /reviewers: [^\n]*code 0% changes, — disputed, 100% missed/);
    assert.match(text.stdout, /docs 0% changes, — disputed, — missed/);
  } finally {
    repo.cleanup();
  }
});
