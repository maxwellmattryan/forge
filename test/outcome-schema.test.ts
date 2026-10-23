import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { defaults, validateConfig } from '#core/config/load.ts';
import { FIELDS } from '#core/config/fields.ts';
import { JOB_SCHEMA_VERSION, cleanOutcome, normalizeJob } from '#core/job/schema.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHA = 'a'.repeat(40);
const good = () => ({
  status: 'final',
  windowDays: 14,
  mergedAt: '2026-10-01T00:00:00.000Z',
  closesAt: '2026-10-15T00:00:00.000Z',
  mergeSha: SHA,
  reverted: true,
  revertedBy: { kind: 'commit', sha: 'b'.repeat(40) },
  followUps: 2,
  followUpRefs: ['o/r#3', 'o/r#4'],
  churn: { commits: 1, lines: 4, files: 1 },
  measuredAt: '2026-10-16T00:00:00.000Z',
  attempts: 0,
});

describe('outcome schema', { concurrency: 4 }, () => {
  test('a stored outcome survives normalisation', () => {
    const kept = normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION,id: 'new', outcome: good() });
    assert.deepEqual(kept.outcome, good());
  });

  test('malformed outcome normalises', () => {
    const bad: [string, (o: any) => void][] = [
      ['status', (o) => (o.status = 'done')],
      ['non-sha mergeSha', (o) => (o.mergeSha = '--upload-pack=x')],
      ['windowDays 0', (o) => (o.windowDays = 0)],
      ['windowDays 1.5', (o) => (o.windowDays = 1.5)],
      ['followUps 1.5', (o) => (o.followUps = 1.5)],
      ['followUps -1', (o) => (o.followUps = -1)],
      ['followUps text', (o) => (o.followUps = 'lots')],
      ['churn lines', (o) => (o.churn.lines = '4')],
      ['attempts', (o) => (o.attempts = -1)],
      ['revertedBy kind', (o) => (o.revertedBy = { kind: 'x', sha: SHA })],
      ['revertedBy sha', (o) => (o.revertedBy = { kind: 'commit', sha: 'HEAD' })],
      ['revertedBy pr 0', (o) => (o.revertedBy = { kind: 'pr', number: 0 })],
      ['reverted text', (o) => (o.reverted = 'yes')],
      ['mergedAt', (o) => (o.mergedAt = 'soon')],
      ['reason newline', (o) => (o.reason = 'a\nb')],
    ];
    for (const [what, mutate] of bad) {
      const o = good();
      mutate(o);
      assert.equal(cleanOutcome(o), null, what);
      assert.equal(normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION,id: 'x', outcome: o }).outcome, null, `${what} through normalizeJob`);
    }
    for (const raw of [null, undefined, 'final', [], 3]) assert.equal(cleanOutcome(raw), null, String(raw));
    const refs = good() as any;
    refs.followUpRefs = ['o/r#1', 'o/r#x', '#5', 'o/r#2\n', 7, 'a b/c#1', ...Array.from({ length: 30 }, (_, i) => `o/r#${i + 10}`)];
    const cleaned = cleanOutcome(refs)!;
    assert.ok(cleaned, 'a bad ref drops the entry, not the outcome');
    assert.equal(cleaned.followUpRefs.length, 20);
    assert.deepEqual(cleaned.followUpRefs.slice(0, 2), ['o/r#1', 'o/r#10']);
    const extra = { ...good(), title: 'from GitHub' } as any;
    assert.equal('title' in cleanOutcome(extra)!, false, 'unknown keys are dropped');
    assert.deepEqual(cleanOutcome({ ...good(), revertedBy: { kind: 'pr', number: 9 }, mergeSha: null, followUps: 'unsupported', churn: null, reason: 'missing merge commit' }), {
      ...good(),
      revertedBy: { kind: 'pr', number: 9 },
      mergeSha: null,
      followUps: 'unsupported',
      churn: null,
      reason: 'missing merge commit',
    });
  });

  test('windowDays validation', async () => {
    assert.equal(defaults().outcomes.windowDays, 14);
    const f = FIELDS.find((x) => x.key === 'outcomes.windowDays');
    assert.ok(f, 'outcomes.windowDays is in the schema');
    assert.equal(f.editable, true);
    assert.equal(f.default, 14);
    for (const v of [0, 366, 1.5, 'abc', null]) {
      const problems = validateConfig({ ...defaults(), outcomes: { windowDays: v } } as any, ROOT);
      assert.ok(problems.some((p: string) => p.startsWith('outcomes.windowDays must be an integer from 1 to 365')), `${v}: ${problems.join('; ')}`);
    }
    assert.ok(!validateConfig({ ...defaults(), outcomes: { windowDays: 365 } } as any, ROOT).some((p: string) => p.startsWith('outcomes')));
    const repo = tempRepo();
    try {
      fs.mkdirSync(path.join(repo.dir, '.forge'));
      fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), 'project:\n  name: t\n');
      const set = await forgeAsync(repo.dir, ['config', 'set', 'outcomes.windowDays', '30']);
      assert.equal(set.status, 0, set.stderr);
      assert.equal(JSON.parse(set.stdout).value, 30);
      assert.match(fs.readFileSync(path.join(repo.dir, '.forge', 'config.yml'), 'utf8'), /outcomes:\n {2}windowDays: 30/);
      for (const bad of ['0', '366', 'abc']) {
        const r = await forgeAsync(repo.dir, ['config', 'set', 'outcomes.windowDays', bad]);
        assert.notEqual(r.status, 0, `${bad} is refused`);
      }
    } finally {
      repo.cleanup();
    }
  });
});
