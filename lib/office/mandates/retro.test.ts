// A mandate's close queues one retro request over its jobs, once, and only with the foreman on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobAt, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { ackRequest, enqueue, listRequests } from '#core/job/requests.ts';
import { isForemanActor } from '#core/job/store.ts';
import { archiveJob } from '#engine/ops/retention.ts';
import { applyInput, blankMandate, fillDefaults } from './contract.ts';
import { readDirectives } from './directives.ts';
import { queueMandateRetro } from './retro.ts';
import { mandateWrite, writeMandate } from './store.ts';
import type { Config } from '#core/types.ts';

function scratch(t: test.TestContext): { root: string; config: Config } {
  const r = tempRepo();
  t.after(() => r.cleanup());
  const config = defaults();
  config.foreman.enabled = true;
  return { root: r.dir, config };
}

function mandate(root: string, config: Config, id: string): void {
  const m = applyInput(blankMandate(id, new Date().toISOString()), fillDefaults(config, { title: id, milestones: ['M1'] }));
  writeMandate(root, () => ({ mandate: m, action: 'new' as const }));
}

const retros = (root: string) => listRequests(root).filter((r) => r.type === 'retro');

test('a mandate queues its retro once, over its live and archived jobs', async (t) => {
  await t.test('nothing with the foreman off, or for a mandate with no jobs', (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1');
    assert.equal(queueMandateRetro(root, config, 'm1'), null, 'no jobs');
    jobAt(root, 'done', { create: { mandate: 'm1' } });
    config.foreman.enabled = false;
    assert.equal(queueMandateRetro(root, config, 'm1'), null, 'foreman off');
    assert.deepEqual(retros(root), []);
  });

  await t.test('one request over a live and an archived job; never a second, whatever its status', (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1');
    jobAt(root, 'build', { create: { mandate: 'm1' } });
    archiveJob(root, jobAt(root, 'done', { create: { mandate: 'm1' } }).id, 'cli');
    jobAt(root, 'done');
    const out = queueMandateRetro(root, config, 'm1');
    assert.equal(out?.jobs, 2);
    assert.deepEqual(
      retros(root).map((r) => [r.id, r.job, r.args, r.from, r.status, r.text]),
      [[out?.request, null, { mandate: 'm1' }, 'forge', 'pending', 'mandate m1 closed: a retro over its 2 jobs']],
    );
    assert.equal(queueMandateRetro(root, config, 'm1'), null, 'pending');
    ackRequest(root, out!.request, { status: 'done' });
    assert.equal(queueMandateRetro(root, config, 'm1'), null, 'done');
    assert.equal(retros(root).length, 1);
  });

  await t.test("an owner's close queues it and logs a retro directive as the owner; closing again queues nothing", (t) => {
    const { root, config } = scratch(t);
    mandate(root, config, 'm1');
    jobAt(root, 'done', { create: { mandate: 'm1' } });
    assert.equal(mandateWrite(root, config, 'close', 'm1', { reason: 'shipped' }).changed, true);
    const [req] = retros(root);
    assert.deepEqual(req?.args, { mandate: 'm1' });
    const directives = readDirectives(root, { mandate: 'm1' });
    assert.deepEqual(directives.map((d) => [d.action, d.reason]), [['retro', `queued request ${req.id} over 1 jobs`]]);
    assert.ok(!isForemanActor(directives[0]), JSON.stringify(directives[0].actor));
    assert.equal(mandateWrite(root, config, 'close', 'm1', { reason: 'again' }).changed, false);
    assert.equal(retros(root).length, 1);
    assert.equal(readDirectives(root, { mandate: 'm1' }).length, 1);
  });

  await t.test('enqueue refuses a retro request whose args.mandate is not a mandate id', (t) => {
    const { root, config } = scratch(t);
    assert.throws(
      () => enqueue(root, config, { type: 'retro', job: null, args: { mandate: 'm1; rm -rf ~' }, from: 'forge' }),
      (e) => e instanceof ForgeError && e.message === "a retro request's args.mandate must be a mandate id",
    );
    assert.deepEqual(listRequests(root), []);
  });
});
