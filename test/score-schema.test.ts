import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { JOB_SCHEMA_VERSION, cleanScore, normalizeJob } from '#core/job/schema.ts';

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
  test('a stored score survives normalisation', () => {
    assert.deepEqual(normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION,id: 'new', score: good() }).score, good());
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
      assert.equal(normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION,id: 'x', score: s }).score, null, `${what} through normalizeJob`);
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
    const j = normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION,id: 'x', state: 'done', score: queued, agents: { judge, builder: { ...judge } } });
    assert.equal(j.agents.judge.status, 'running', 'the queued score run keeps its judge');
    assert.equal(j.agents.builder.status, 'lost', 'any other role on a done job is still ended');
    const scored = normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION,id: 'x', state: 'done', score: good(), agents: { judge } });
    assert.equal(scored.agents.judge.status, 'lost', 'once recorded, a stray judge is ended as before');
    const evalJob = normalizeJob({ schemaVersion: JOB_SCHEMA_VERSION,id: 'x', kind: 'eval', state: 'done', score: queued, agents: { judge } });
    assert.equal(evalJob.agents.judge.status, 'lost', 'an eval job has no score run');
  });
});
