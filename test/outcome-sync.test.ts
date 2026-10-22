import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { syncAll } from '../lib/commands/tracker.ts';

// A stand-in `gh` on PATH, as FAKE_GH in test/pr.test.ts: answers the outcome pass's three calls.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr view") printf '{"title":"Add a","mergeCommit":{"oid":"%s"},"mergedAt":null}' "$FAKE_MERGE_OID" ;;
  "pr list") echo '[]' ;;
  "issue list") echo '[]' ;;
  "repo view") echo o/r ;;
esac
`;

// These tests change PATH, so they run one at a time.
function harness() {
  const repo = tempRepo();
  const bin = path.join(repo.dir, '..', `fakebin-${path.basename(repo.dir)}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(log, '');
  const saved = { ...process.env };
  // The merge commit has a parent, as every merge into a base branch does.
  fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'a\n');
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'Add a (#101)');
  const oid = repo.git('rev-parse', 'HEAD').toString().trim();
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${saved.PATH}`, FAKE_GH_LOG: log, FAKE_MERGE_OID: oid });
  const config = defaults();
  config.tracker.github.repo = 'o/r';
  config.pr.enabled = true;
  let n = 0;
  const merged = (mergedAt: string, extra: { kind?: string } = {}) => {
    const job = createJob(repo.dir, config, { title: `job ${++n}`, ...extra });
    setJob(repo.dir, job.id, { stage: 'done', state: 'done', owned: { pr: { number: 100 + n, url: `https://github.com/o/r/pull/${100 + n}`, state: 'MERGED', isDraft: false, lastSyncedAt: mergedAt, mergedAt } } });
    return job.id;
  };
  return {
    dir: repo.dir,
    config,
    merged,
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    cleanup: () => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      repo.cleanup();
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}

const longAgo = '2026-01-01T00:00:00.000Z';

test('sync measures done merged jobs', async () => {
  const h = harness();
  try {
    const id = h.merged(longAgo);
    const evalJob = h.merged(longAgo, { kind: 'eval' });
    const before = loadJob(h.dir, id);
    const r = await syncAll(h.dir, h.config);
    assert.deepEqual(r.outcomes, { measured: 1, finalized: [id] });
    const after = loadJob(h.dir, id);
    assert.equal(after.outcome?.status, 'final', 'a long-merged job goes straight to final');
    assert.equal(after.outcome?.reverted, false);
    assert.equal(after.outcome?.followUps, 'unsupported');
    assert.deepEqual([after.stage, after.state, after.waitingOn], [before.stage, before.state, before.waitingOn], 'sync never moves the job');
    const ev = readEvents(h.dir, id).filter((e) => e.type === 'outcome');
    assert.deepEqual(ev.map(({ v: _v, ts: _t, ...e }) => e), [{ type: 'outcome', status: 'final', reverted: false, followUps: 'unsupported', churnCommits: 0 }]);
    assert.ok(!readEvents(h.dir, id).some((e) => e.type === 'transition' && Date.parse(e.ts) >= Date.parse(after.outcome!.measuredAt)), 'no transition logged');
    assert.equal(loadJob(h.dir, evalJob).outcome, null, 'eval jobs are skipped');
    const again = await syncAll(h.dir, h.config);
    assert.equal(again.outcomes, undefined, 'nothing measured: no outcomes key');
    h.config.pr.enabled = false;
    const off = h.merged(longAgo);
    await syncAll(h.dir, h.config);
    assert.equal(loadJob(h.dir, off).outcome, null, 'the pass runs only with pr.enabled');
  } finally {
    h.cleanup();
  }
});

test('at most 10 per sync', async () => {
  const h = harness();
  try {
    const ids = Array.from({ length: 12 }, () => h.merged(longAgo));
    const first = await syncAll(h.dir, h.config);
    assert.equal(first.outcomes?.measured, 10);
    assert.equal(ids.filter((id) => loadJob(h.dir, id).outcome).length, 10);
    const second = await syncAll(h.dir, h.config);
    assert.equal(second.outcomes?.measured, 2, 'the two never measured come next');
    assert.ok(ids.every((id) => loadJob(h.dir, id).outcome?.status === 'final'));
  } finally {
    h.cleanup();
  }
});

test('open outcome re-measured after 24h only', async () => {
  const h = harness();
  try {
    const id = h.merged(new Date(Date.now() - 86_400_000).toISOString());
    assert.equal((await syncAll(h.dir, h.config)).outcomes?.measured, 1);
    const open = loadJob(h.dir, id).outcome!;
    assert.equal(open.status, 'open');
    assert.equal((await syncAll(h.dir, h.config)).outcomes, undefined, 'not again the same day');
    setJob(h.dir, id, { fields: { 'outcome.measuredAt': new Date(Date.now() - 25 * 3_600_000).toISOString() } });
    assert.equal((await syncAll(h.dir, h.config)).outcomes?.measured, 1, 'again once a day has passed');
    assert.equal(loadJob(h.dir, id).outcome?.status, 'open', 'still inside the window');
    assert.equal(h.calls().filter((c) => c.startsWith('pr view')).length, 2);
  } finally {
    h.cleanup();
  }
});
