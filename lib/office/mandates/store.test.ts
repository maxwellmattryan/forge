// The owner's mandate writes: a close that writes queues the mandate's retro and logs its directive as the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobAt, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { listRequests } from '#core/job/requests.ts';
import { isForemanActor } from '#core/job/store.ts';
import { applyInput, blankMandate, fillDefaults } from './contract.ts';
import { readDirectives } from './directives.ts';
import { mandateWrite, writeMandate } from './store.ts';

test("an owner's close queues one retro and logs a retro directive as the owner; closing again queues nothing", (t) => {
  const r = tempRepo();
  t.after(() => r.cleanup());
  const root = r.dir;
  const config = defaults();
  config.foreman.enabled = true;
  const m = applyInput(blankMandate('m1', new Date().toISOString()), fillDefaults(config, { title: 'm1', milestones: ['M1'] }));
  writeMandate(root, () => ({ mandate: m, action: 'new' as const }));
  jobAt(root, 'done', { create: { mandate: 'm1' } });
  const retros = () => listRequests(root).filter((x) => x.type === 'retro');

  assert.equal(mandateWrite(root, config, 'close', 'm1', { reason: 'shipped' }).changed, true);
  const [req] = retros();
  assert.deepEqual([req?.args, req?.from], [{ mandate: 'm1' }, 'forge']);
  const directives = readDirectives(root, { mandate: 'm1' });
  assert.deepEqual(directives.map((d) => [d.action, d.reason]), [['retro', `queued request ${req.id} over 1 jobs`]]);
  assert.ok(!isForemanActor(directives[0]), JSON.stringify(directives[0].actor));

  assert.equal(mandateWrite(root, config, 'close', 'm1', { reason: 'again' }).changed, false);
  assert.equal(retros().length, 1);
  assert.equal(readDirectives(root, { mandate: 'm1' }).length, 1);
});
