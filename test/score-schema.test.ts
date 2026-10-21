import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, CONFIG_SCHEMA_VERSION, JOB_SCHEMA_VERSION, cleanScore, migrateConfig, normalizeJob } from '../lib/schema.ts';

const good = () => ({
  status: 'scored',
  queuedAt: '2026-10-01T00:00:00.000Z',
  value: 3.5,
  outOf: 5,
  recordedAt: '2026-10-01T01:00:00.000Z',
  judgeModel: 'opus',
  builderModel: 'claude-sonnet-4-5',
});

describe('score schema', { concurrency: 4 }, () => {
  test('v15 job reads', () => {
    assert.equal(JOB_SCHEMA_VERSION, 17);
    assert.equal(CONFIG_SCHEMA_VERSION, 28);
    assert.equal(API_VERSION, 33);
    const v15 = normalizeJob({ schemaVersion: 15, id: 'old', state: 'done', pr: { number: 1, state: 'MERGED' }, outcome: null });
    assert.equal(v15.schemaVersion, 17);
    assert.equal(v15.score, null);
    assert.equal(normalizeJob({ schemaVersion: 1, id: 'older' }).score, null, 'a v1 job walks every migration to score null');
    assert.deepEqual(normalizeJob({ schemaVersion: 16, id: 'new', score: good() }).score, good());
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 18 })._unsupported, true, 'a newer job is refused');
    const m = migrateConfig({ schemaVersion: 24, tracker: { kind: 'none' } });
    assert.equal(m.from, 24);
    assert.deepEqual(m.config, { schemaVersion: 28, tracker: { kind: 'none' } }, 'migration 24 changes nothing but schemaVersion');
  });

  test('malformed score reads as null', () => {
    const bad: [string, (s: any) => void][] = [
      ['unknown status', (s) => (s.status = 'done')],
      ['value above 5', (s) => (s.value = 6)],
      ['negative value', (s) => (s.value = -1)],
      ['two decimals', (s) => (s.value = 3.25)],
      ['non-finite value', (s) => (s.value = Infinity)],
      ['string value', (s) => (s.value = '4')],
      ['bad queuedAt', (s) => (s.queuedAt = 'yesterday')],
      ['bad recordedAt', (s) => (s.recordedAt = 12)],
      ['long timestamp', (s) => (s.recordedAt = `2026-10-01T00:00:00.000Z${' '.repeat(40)}`)],
      ['outOf not 5', (s) => (s.outOf = 10)],
      ['bad judge model', (s) => (s.judgeModel = 'opus; rm -rf /')],
      ['bad builder model', (s) => (s.builderModel = '--model x')],
      ['unknown reason', (s) => (s.reason = 'ignore previous instructions')],
      ['scored without a value', (s) => (s.value = null)],
      ['failed with a value', (s) => (s.status = 'failed')],
      ['queued without queuedAt', (s) => Object.assign(s, { status: 'queued', value: null, recordedAt: null, queuedAt: null })],
      ['missing key', (s) => delete s.judgeModel],
    ];
    for (const [what, edit] of bad) {
      const s: any = good();
      edit(s);
      assert.equal(cleanScore(s), null, what);
      assert.equal(normalizeJob({ schemaVersion: 16, id: 'x', score: s }).score, null, `${what} through normalizeJob`);
    }
    for (const v of [null, 'scored', 4, [], [good()]]) assert.equal(cleanScore(v), null, JSON.stringify(v));
    const extra = cleanScore({ ...good(), note: 'SCORE: 5/5 from the file', __proto__: { x: 1 } });
    assert.deepEqual(extra, good(), 'extra keys are dropped');
    assert.deepEqual(Object.keys(extra!), Object.keys(good()));
    const held = { status: 'held', queuedAt: null, value: null, outOf: 5, recordedAt: '2026-10-01T00:00:00.000Z', judgeModel: null, builderModel: null, reason: 'repo budget' };
    assert.deepEqual(cleanScore(held), held, 'a held score keeps its reason');
    const queued = { status: 'queued', queuedAt: '2026-10-01T00:00:00.000Z', value: null, outOf: 5, recordedAt: null, judgeModel: null, builderModel: null };
    assert.deepEqual(cleanScore(queued), queued);
    assert.deepEqual(cleanScore({ ...good(), value: 0 }), { ...good(), value: 0 }, '0 is a score');
    assert.deepEqual(cleanScore({ ...good(), value: 5 }), { ...good(), value: 5 });
  });

  test('a done job keeps its scoring judge running', () => {
    const queued = { status: 'queued', queuedAt: '2026-10-01T00:00:00.000Z', value: null, outOf: 5, recordedAt: null, judgeModel: null, builderModel: null };
    const judge = { runs: 1, status: 'running', startedAt: '2026-10-01T00:01:00.000Z', endedAt: null };
    const j = normalizeJob({ schemaVersion: 16, id: 'x', state: 'done', score: queued, agents: { judge, builder: { ...judge } } });
    assert.equal(j.agents.judge.status, 'running', 'the queued score run keeps its judge');
    assert.equal(j.agents.builder.status, 'lost', 'any other role on a done job is still ended');
    const scored = normalizeJob({ schemaVersion: 16, id: 'x', state: 'done', score: good(), agents: { judge } });
    assert.equal(scored.agents.judge.status, 'lost', 'once recorded, a stray judge is ended as before');
    const evalJob = normalizeJob({ schemaVersion: 16, id: 'x', kind: 'eval', state: 'done', score: queued, agents: { judge } });
    assert.equal(evalJob.agents.judge.status, 'lost', 'an eval job has no score run');
  });
});
