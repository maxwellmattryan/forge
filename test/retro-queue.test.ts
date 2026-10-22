import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeSync, repoTemplate } from './helpers.ts';
import { defaults, loadConfig } from '../lib/core/config/load.ts';
import { syncAll } from '../lib/cli/commands/tracker.ts';
import { createJob, setJob } from '../lib/core/job/store.ts';
import { INBOX_SCOPE, ackRequest, listRequests, requestScope } from '../lib/core/job/requests.ts';
import * as yaml from '../lib/core/format/yaml.ts';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false } }));
  const init = forgeSync(dir, ['init', 'write', '--answers', answers]);
  if (init.status !== 0) throw new Error(init.stderr);
  fs.rmSync(answers);
});

/** A repo with the foreman on (or off), retroEvery 3, and `finished` done jobs. */
function scratch(foreman: boolean, finished: number) {
  const r = template();
  const file = path.join(r.dir, '.forge', 'config.yml');
  const c = yaml.parse(fs.readFileSync(file, 'utf8'));
  c.foreman = { ...(c.foreman ?? {}), enabled: foreman };
  c.improve = { ...(c.improve ?? {}), retroEvery: 3 };
  fs.writeFileSync(file, yaml.stringify(c));
  for (let i = 0; i < finished; i++) setJob(r.dir, createJob(r.dir, defaults(), { title: `Done ${i}` }).id, { state: 'done' });
  const config = () => loadConfig(r.dir).config;
  const retros = () => listRequests(r.dir).filter((q) => q.type === 'retro');
  return { ...r, config, retros, sync: () => syncAll(r.dir, config()) };
}

test('a due retro is queued once', async () => {
  const s = scratch(true, 3);
  try {
    const first = await s.sync();
    const [q] = s.retros();
    assert.ok(q, 'one retro request');
    assert.deepEqual(first.retro, { queued: q.id });
    assert.deepEqual([q.from, q.job, q.status], ['foreman', null, 'pending']);
    assert.equal(requestScope(s.dir, q), INBOX_SCOPE, 'the inbox runs reference/retro.md');
    const second = await s.sync();
    assert.equal('retro' in second, false, 'nothing queued the second time');
    assert.equal(s.retros().length, 1);
  } finally {
    s.cleanup();
  }
});

test('never re-queued while one is open', async () => {
  const s = scratch(true, 0);
  try {
    // An open retro job first, then enough finished jobs after it for the next one to be due.
    const retro = createJob(s.dir, defaults(), { title: 'Retro', kind: 'retro' }).id;
    setJob(s.dir, retro, { stage: 'spec', state: 'waiting', waitingOn: 'spec-approval', reason: 'spec ready' });
    for (let i = 0; i < 3; i++) setJob(s.dir, createJob(s.dir, defaults(), { title: `Later ${i}` }).id, { state: 'done' });
    assert.equal('retro' in (await s.sync()), false, 'the retro job is still open');
    setJob(s.dir, retro, { stage: 'done', state: 'cancelled' });
    // A finished retro resets the cadence, so three more jobs make the next one due.
    for (let i = 0; i < 3; i++) setJob(s.dir, createJob(s.dir, defaults(), { title: `After ${i}` }).id, { state: 'done' });
    const queued = await s.sync();
    assert.ok(queued.retro?.queued);
    // In progress counts as open too.
    ackRequest(s.dir, queued.retro!.queued, { status: 'in-progress' });
    assert.equal('retro' in (await s.sync()), false);
    assert.equal(s.retros().length, 1);
  } finally {
    s.cleanup();
  }
});

test('foreman off or not due queues nothing', async () => {
  for (const [foreman, finished] of [[false, 3], [true, 2]] as const) {
    const s = scratch(foreman, finished);
    try {
      const r = await s.sync();
      assert.equal('retro' in r, false, `foreman ${foreman}, ${finished} finished`);
      assert.deepEqual(s.retros(), []);
    } finally {
      s.cleanup();
    }
  }
});
