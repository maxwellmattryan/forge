import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { createJob } from '../lib/core/job/store.ts';
import { dollarConfig, spend } from './repo-budget-fixture.ts';
import { ARCHIVE_SCHEMA_VERSION, JOB_SCHEMA_VERSION } from '../lib/core/job/schema.ts';
import { SPEND_CACHE_VERSION, periodTotals, spendCounters, spendFile, spendLedger } from '../lib/engine/metrics/spend.ts';

function archive(root: string, id: string, rec: Record<string, unknown>): void {
  const dir = path.join(root, '.forge', 'archive');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ archiveVersion: ARCHIVE_SCHEMA_VERSION, id, archivedAt: '2026-10-20T00:00:00.000Z', trigger: 'cli', ...rec }));
}

const job = (id: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: JOB_SCHEMA_VERSION, id, title: id, kind: 'feature', state: 'done', stage: 'done', ...extra });

test('periods, archives and kinds', () => {
  const repo = tempRepo();
  const root = repo.dir;
  try {
    const c = dollarConfig();
    const live = createJob(root, c, { title: 'Live job' });
    const ev = createJob(root, c, { title: 'Eval job', kind: 'eval' });
    const retro = createJob(root, c, { title: 'Retro job', kind: 'retro' });
    spend(root, live.id, 10, '2026-10-31T23:59:59.000Z');
    spend(root, live.id, 7, '2026-11-01T00:00:00.000Z');
    spend(root, ev.id, 2, '2026-10-05T10:00:00.000Z', 'reviewer:code');
    spend(root, retro.id, 3, '2026-10-05T11:00:00.000Z', 'retro');
    // An archive record with agent-end events; a second whose events lost usage but whose summary kept the cost.
    archive(root, 'old-job', { job: job('old-job'), events: [{ v: 2, ts: '2026-10-02T09:00:00.000Z', type: 'agent-end', role: 'builder', model: 'usd-model', usage: { input: 5 } }], summary: { usage: { totalTokens: 5, estCostUsd: 5 } } });
    archive(root, 'summary-only', { job: job('summary-only', { finishedAt: '2026-10-03T12:00:00.000Z' }), events: [], summary: { usage: { totalTokens: 40, estCostUsd: 4 } } });
    // A record whose job is still live never counts twice.
    archive(root, live.id, { job: job(live.id), events: [{ v: 2, ts: '2026-10-02T09:00:00.000Z', type: 'agent-end', role: 'builder', model: 'usd-model', usage: { input: 100 } }], summary: { usage: { totalTokens: 100, estCostUsd: 100 } } });

    const ledger = spendLedger(root, c);
    assert.deepEqual(Object.keys(ledger).sort(), [ev.id, live.id, retro.id, 'old-job', 'summary-only'].sort());
    assert.equal(ledger[live.id].source, 'live', 'the live job wins over its archive record');
    assert.deepEqual(Object.keys(ledger['summary-only'].buckets), ['2026-10-03|unknown|unknown']);
    assert.ok(Object.keys(ledger[ev.id].buckets)[0].includes('|reviewer:code|'), 'a reviewer keeps its lens');

    const oct = periodTotals(ledger, Date.parse('2026-10-31T12:00:00Z'));
    assert.deepEqual(oct, { dayUsd: 10, monthUsd: 10 + 2 + 3 + 5 + 4, monthTokens: 10 + 2 + 3 + 5 + 40 }, '23:59:59Z on the 31st is October');
    const nov = periodTotals(ledger, Date.parse('2026-11-01T08:00:00Z'));
    assert.deepEqual(nov, { dayUsd: 7, monthUsd: 7, monthTokens: 7 }, 'midnight UTC on the 1st is November');
    assert.equal(periodTotals(ledger, Date.parse('2026-10-03T23:00:00Z')).dayUsd, 4, 'a summary-only record counts on its finish day');
  } finally {
    repo.cleanup();
  }
});

test('cache reuse and rebuild', () => {
  const repo = tempRepo();
  const root = repo.dir;
  try {
    const c = dollarConfig();
    const a = createJob(root, c, { title: 'A' });
    const b = createJob(root, c, { title: 'B' });
    spend(root, a.id, 1, '2026-10-10T00:00:00.000Z');
    spend(root, b.id, 2, '2026-10-10T00:00:00.000Z');
    archive(root, 'arch', { job: job('arch'), events: [], summary: { usage: { totalTokens: 1, estCostUsd: 3 } } });
    const at = Date.parse('2026-10-10T12:00:00Z');
    const parsed = () => spendCounters.parsed;

    let before = parsed();
    spendLedger(root, c);
    assert.equal(parsed() - before, 3, 'a first run parses every job and record');
    const file = spendFile(root);
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(cache.version, SPEND_CACHE_VERSION);
    assert.match(cache.pricing, /^[0-9a-f]{64}$/);

    before = parsed();
    assert.equal(periodTotals(spendLedger(root, c), at).monthUsd, 6);
    assert.equal(parsed() - before, 0, 'nothing changed: no events file is parsed');

    spend(root, b.id, 4, '2026-10-10T01:00:00.000Z');
    before = parsed();
    assert.equal(periodTotals(spendLedger(root, c), at).monthUsd, 10);
    assert.equal(parsed() - before, 1, "one job's appended event re-parses only that job");
    const entryA = JSON.parse(fs.readFileSync(file, 'utf8')).jobs[a.id];
    assert.deepEqual(entryA, cache.jobs[a.id], "the other job's entry is untouched");

    const rebuilds = (what: string, mutate: () => void) => {
      mutate();
      const n = parsed();
      assert.equal(periodTotals(spendLedger(root, c), at).monthUsd, 10);
      assert.equal(parsed() - n, 3, `rebuilt when ${what}`);
    };
    rebuilds('missing', () => fs.rmSync(file));
    rebuilds('unparsable', () => fs.writeFileSync(file, '{not json'));
    rebuilds('of another version', () => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version: 99 })));
    rebuilds('of another pricing hash', () => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pricing: 'x'.repeat(64) })));
    // An understated cache planted behind a link is never followed, and its target is left alone.
    const target = path.join(root, 'planted.json');
    const planted = JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), jobs: {} });
    fs.writeFileSync(target, planted);
    rebuilds('a symlink', () => {
      fs.rmSync(file);
      fs.symlinkSync(target, file);
    });
    assert.equal(fs.readFileSync(target, 'utf8'), planted, 'the link target is untouched');
    assert.ok(!fs.lstatSync(file).isSymbolicLink(), 'the rebuilt cache replaced the link');

    const repriced = dollarConfig();
    repriced.usage.pricing.models['usd-model'].input = 2_000_000;
    const n = parsed();
    assert.equal(periodTotals(spendLedger(root, repriced), at).monthUsd, 2 * 7 + 3, 'a price change re-prices every event (the summary-only record keeps its total)');
    assert.equal(parsed() - n, 3);

    // write: false never touches the file.
    fs.rmSync(file);
    spendLedger(root, c, { write: false });
    assert.ok(!fs.existsSync(file));
  } finally {
    repo.cleanup();
  }
});
