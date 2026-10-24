// budgetCmd in-process: --set and --ack change a job's spend limits only with a person's grant, and
// their events say who; a plain read needs none.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { createJob, readEvents, updateJob } from '#core/job/store.ts';
import { jobDir } from '#core/paths.ts';
import type { HumanGrant } from '#core/types.ts';
import { budgetCmd } from './budget.ts';

const config = defaults();
config.pipeline.budget = { ...config.pipeline.budget, usd: 10 };
const GRANT: HumanGrant = { channel: 'terminal', actor: { login: 'alice', source: 'env' } };

test("budgetCmd changes limits and acks only with a person's grant", () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const id = createJob(root, config, { title: 'over budget' }).id;
    updateJob(root, id, (j) => {
      j.usage = { ...j.usage, estCostUsd: 12 };
    });
    const files = () => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(jobDir(root, id), f), 'utf8'));
    const refused: [string, Parameters<typeof budgetCmd>[3]][] = [
      ['--set without a grant', { set: ['usd=1000000'] }],
      ['--ack without a grant', { ack: true }],
      ['--set with a stray true', { set: ['usd=1000000'], grant: true as never }],
      ['--ack with a grant of an unknown channel', { ack: true, grant: { channel: 'env', actor: GRANT.actor } as never }],
      ['--ack with a grant whose actor has no source', { ack: true, grant: { channel: 'terminal', actor: { login: 'x' } } as never }],
    ];
    for (const [name, opts] of refused) {
      const before = files();
      assert.throws(() => budgetCmd(root, config, id, opts), (e: unknown) => e instanceof ForgeError && e.code === 'human_only' && e.exitCode === 1, name);
      assert.deepEqual(files(), before, `${name}: job.json and events.jsonl unchanged`);
    }

    const read = budgetCmd(root, config, id);
    assert.deepEqual([read.exceeded, read.acked], [['usd'], []]);

    const acked = budgetCmd(root, config, id, { ack: true, grant: GRANT });
    assert.deepEqual([acked.acked, acked.stillExceeded], [['usd'], []]);
    const set = budgetCmd(root, config, id, { set: ['usd=20'], grant: { channel: 'dashboard', actor: { login: 'bob', source: 'dashboard' } } });
    assert.equal(set.limits.usd, 20);
    const events = readEvents(root, id);
    assert.deepEqual(events.find((e) => e.type === 'budget-ack')?.actor, GRANT.actor);
    assert.deepEqual(events.find((e) => e.type === 'budget-set')?.actor, { login: 'bob', source: 'dashboard' });
  } finally {
    repo.cleanup();
  }
});
