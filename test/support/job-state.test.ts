import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, parkedAt, repoTemplate, withLease, withRound } from '../helpers.ts';
import { jobDir, leaseStatus, loadJob, readEvents } from '#core/job/store.ts';
import { listRequests } from '#core/job/requests.ts';
import { WAITING_ON } from '#api/constants.ts';
import { defaults } from '#core/config/load.ts';

const repo = repoTemplate(() => {});

const types = (root: string, id: string) => readEvents(root, id).map((e) => e.type);
const transitions = (root: string, id: string) => types(root, id).filter((t) => t === 'transition').length;

// Where the pipeline parks each gate (spec Approach table); a new WAITING_ON value without a row fails here.
const PARKED: Record<string, string> = {
  'spec-approval': 'spec',
  'split-approval': 'plan',
  'issue-link': 'spec',
  input: 'build',
  escalation: 'decide',
  infra: 'decide',
  conflicts: 'integrate',
  'rounds-exhausted': 'build',
  'pr-review': 'pr',
  external: 'build',
  budget: 'build',
  human: 'build',
  shelved: 'decide',
};

describe('state builders write through the store', { concurrency: 4 }, () => {
  const rows: { name: string; run: (root: string) => void }[] = [
    {
      name: 'jobAt backlog/queued logs no transition',
      run: (root) => {
        const j = jobAt(root, 'backlog', { state: 'queued' });
        const l = loadJob(root, j.id);
        assert.deepEqual([l.stage, l.state, l.waitingOn], ['backlog', 'queued', null]);
        assert.equal(transitions(root, j.id), 0);
      },
    },
    {
      name: 'jobAt build defaults to running with one transition',
      run: (root) => {
        const j = jobAt(root, 'build');
        const l = loadJob(root, j.id);
        assert.deepEqual([l.stage, l.state, l.reason], ['build', 'running', null]);
        assert.equal(l.title, 'job at build');
        assert.equal(transitions(root, j.id), 1);
      },
    },
    {
      name: 'jobAt done defaults to done with finishedAt',
      run: (root) => {
        const j = jobAt(root, 'done');
        const l = loadJob(root, j.id);
        assert.deepEqual([l.stage, l.state], ['done', 'done']);
        assert.ok(l.finishedAt);
        assert.equal(transitions(root, j.id), 1);
      },
    },
    {
      name: 'jobAt writes waitingOn, reason, pr and fields',
      run: (root) => {
        const pr = { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN' };
        const j = jobAt(root, 'review', { state: 'waiting', waitingOn: 'input', reason: 'why', pr, fields: { reviewers: ['code', 'docs'] } });
        const l = loadJob(root, j.id);
        assert.deepEqual([l.stage, l.state, l.waitingOn, l.reason], ['review', 'waiting', 'input', 'why']);
        assert.equal(l.pr?.number, 3);
        assert.equal(l.pr?.url, pr.url);
        assert.deepEqual(l.reviewers, ['code', 'docs']);
        assert.equal(j.id, l.id);
        assert.equal(transitions(root, j.id), 1);
      },
    },
    ...WAITING_ON.map((gate) => ({
      name: `parkedAt ${gate}`,
      run: (root: string) => {
        const j = parkedAt(root, gate);
        const l = loadJob(root, j.id);
        assert.deepEqual([l.stage, l.state, l.waitingOn], [PARKED[gate], 'waiting', gate], gate);
        assert.equal(transitions(root, j.id), 1);
        if (gate === 'rounds-exhausted') assert.equal(l.round, defaults().pipeline.maxRounds + 1);
        if (gate === 'pr-review') {
          assert.equal(l.pr?.number, 7);
          assert.equal(l.pr?.url, 'https://github.com/o/r/pull/7');
        }
        assert.deepEqual(listRequests(root), [], `${gate}: no gate request`);
      },
    })),
    {
      name: 'parkedAt honours opts.stage',
      run: (root) => {
        const l = loadJob(root, parkedAt(root, 'input', { stage: 'spec' }).id);
        assert.deepEqual([l.stage, l.state, l.waitingOn], ['spec', 'waiting', 'input']);
      },
    },
    {
      name: 'withRound with verdicts',
      run: (root) => {
        const { id } = jobAt(root, 'review');
        const j = withRound(root, id, 2, { code: 'PASS', tests: 'CHANGES' });
        assert.equal(j.round, 2);
        assert.deepEqual(j.verdicts['2'], { code: 'PASS', tests: 'CHANGES' });
        assert.ok(fs.statSync(path.join(jobDir(root, id), 'review', 'round-2')).isDirectory());
        const ev = readEvents(root, id).filter((e) => e.type === 'round' || e.type === 'verdicts');
        assert.deepEqual(ev.map((e) => [e.type, e.round, e.outcome]), [['round', 2, undefined], ['verdicts', 2, 'CHANGES']]);
        // setJob's own `fields` event sits between them, as it does for `forge job verdicts`.
        assert.equal(types(root, id).at(-1), 'verdicts');
      },
    },
    {
      name: 'withRound without verdicts',
      run: (root) => {
        const { id } = jobAt(root, 'build');
        const j = withRound(root, id, 1);
        assert.equal(j.round, 1);
        assert.equal(j.verdicts['1'], undefined);
        assert.ok(!types(root, id).includes('verdicts'));
        assert.equal(types(root, id).at(-1), 'round');
      },
    },
    {
      name: 'withLease',
      run: (root) => {
        const { id } = jobAt(root, 'build');
        const j = withLease(root, id, 'sess-1');
        assert.equal(j.lease.driver, 'sess-1');
        assert.equal(j.lease.epoch, 1);
        const s = leaseStatus(loadJob(root, id));
        assert.equal(s.status, 'live');
        assert.equal(s.session, 'sess-1');
      },
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const r = repo();
      try {
        row.run(r.dir);
      } finally {
        r.cleanup();
      }
    });
  }
});
