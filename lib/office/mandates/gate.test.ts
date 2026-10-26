// The milestone-approval gate: its status from the draft, the requests and the filing record; who owns
// it; the gate request and notification a recorded draft queues; and the decision note's rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MILESTONE_DRAFT, forgeInProcess, initMilestoneRepo, readyGoal, repoTemplate, writeDraftFile } from '../../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { ackRequest, claimRequest, enqueue, listRequests } from '#core/job/requests.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { FILING_SCHEMA_VERSION } from '#core/versions/filing.ts';
import { REASONS } from '../notify.ts';
import type { QueueNotify } from '../notify.ts';
import { filingFile } from './filing.ts';
import { cleanDraftNote, draftGate, draftGateOwner, draftGates, onDraftRecorded } from './gate.ts';
import { readMandate, writeMandate } from './store.ts';
import type { Config, ForgeRequest } from '#core/types.ts';
import type { Filing, Mandate } from './types.ts';

const scratch = repoTemplate((dir) => initMilestoneRepo(dir));

async function cli(root: string, args: string[]): Promise<any> {
  const r = await forgeInProcess(root, args);
  assert.equal(r.status, 0, `${args.join(' ')}: ${JSON.stringify(r.error)}`);
  return r.data;
}

const mandate = (root: string, id: string): Mandate => readMandate(root, id) as Mandate;

/** An approved, incomplete filing record for mandate `id`. */
function stoppedFiling(root: string, id: string, request: string, digest: string): void {
  const rec: Filing = {
    schemaVersion: FILING_SCHEMA_VERSION,
    mandate: id,
    request,
    digest,
    tracker: 'local',
    approvedAt: '2026-10-26T00:00:00.000Z',
    actor: { login: null, source: 'os' },
    note: null,
    milestone: { title: MILESTONE_DRAFT.milestone.title, ref: MILESTONE_DRAFT.milestone.title, url: null, startedAt: '2026-10-26T00:00:00.000Z' },
    issues: {},
    error: 'boom',
    completedAt: null,
  };
  writeJsonAtomic(filingFile(root, id), rec);
}

test('the gate follows the draft, the requests and the filing record', async () => {
  const r = scratch();
  try {
    const root = r.dir;
    const goal = async (id: string) => (await cli(root, ['mandate', 'new', id, '--title', id, '--goal', 'Halve review rounds'])).draft.request as string;
    await goal('queued');
    claimRequest(root, await goal('drafting'), 'office-1');
    ackRequest(root, await goal('absent'), { status: 'done' });
    const u = await goal('unreadable');
    ackRequest(root, u, { status: 'done' });
    writeDraftFile(root, 'unreadable', u, { milestone: MILESTONE_DRAFT.milestone, issues: [] });
    await readyGoal(root, 'closed');
    await cli(root, ['mandate', 'close', 'closed']);
    const pending = await readyGoal(root, 'pending');
    await readyGoal(root, 'paused');
    await cli(root, ['mandate', 'pause', 'paused']);
    const f = await readyGoal(root, 'filing');
    stoppedFiling(root, 'filing', f.request, f.digest);
    await readyGoal(root, 'filed');
    const m = mandate(root, 'filed');
    writeMandate(root, () => ({ mandate: { ...m, scope: { milestones: ['M1'], labels: [], issues: [] }, filedAt: '2026-10-26T00:00:00.000Z' }, action: 'filed' as const }));
    const { config } = loadConfig(root);
    const rows: [string, string][] = [
      ['queued', 'none'],
      ['drafting', 'none'],
      ['absent', 'none'],
      ['unreadable', 'none'],
      ['closed', 'none'],
      ['pending', 'pending'],
      ['paused', 'pending'],
      ['filing', 'filing'],
      ['filed', 'filed'],
    ];
    for (const [id, want] of rows) assert.equal(draftGate(root, config, mandate(root, id)).status, want, id);
    assert.equal(draftGate(root, config, mandate(root, 'pending')).request, pending.request);
    const gates = draftGates(root, config);
    assert.deepEqual(gates.map((g) => [g.mandate, g.status]), [['pending', 'pending'], ['filing', 'filing']], 'active mandates only, by creation time');
    assert.deepEqual([gates[0].issues, gates[0].waves, gates[0].existing, gates[1].error], [3, 2, 1, 'boom']);
    assert.match(gates[0].digest, /^[0-9a-f]{64}$/);
  } finally {
    r.cleanup();
  }
});

test('who owns a milestone draft', async () => {
  const r = scratch();
  try {
    const root = r.dir;
    const { request, digest } = await readyGoal(root, 'g1', ['--decides', 'milestone-approval']);
    await readyGoal(root, 'g2', ['--decides', 'spec-approval']);
    const f = await readyGoal(root, 'g3', ['--decides', 'milestone-approval']);
    stoppedFiling(root, 'g3', f.request, f.digest);
    const { config } = loadConfig(root);
    const patched = (patch: (c: any) => void): Config => {
      const c = structuredClone(config);
      patch(c);
      return c;
    };
    const gate = (status: ForgeRequest['status'], key = request): ForgeRequest => ({
      id: `1-${status}`,
      type: 'gate',
      job: null,
      text: null,
      args: { gate: 'milestone-approval', mandate: 'g1', key, digest, reserved: null },
      from: 'forge',
      status,
      createdAt: '2026-10-26T00:00:00.000Z',
    });
    const rows: [string, Config, string, ForgeRequest[], { owner: string | null; leftForHuman: boolean }][] = [
      ['the foreman off', patched((c) => (c.foreman.enabled = false)), 'g1', [gate('pending')], { owner: null, leftForHuman: false }],
      ['assistants off', patched((c) => (c.foreman.assistants.enabled = false)), 'g1', [gate('pending')], { owner: 'human', leftForHuman: false }],
      ['a stopped filing', config, 'g3', [], { owner: 'human', leftForHuman: false }],
      ['a reserved hit', patched((c) => (c.foreman.reserved = ['review rounds'])), 'g1', [gate('pending')], { owner: 'human', leftForHuman: false }],
      ["the mandate's decides leaves it out", config, 'g2', [], { owner: 'human', leftForHuman: false }],
      ['no gate request for the key', config, 'g1', [gate('pending', '2-older')], { owner: 'human', leftForHuman: false }],
      ['the latest request for the key rejected', config, 'g1', [gate('done'), gate('rejected')], { owner: 'human', leftForHuman: true }],
      ['a pending request', config, 'g1', [gate('pending')], { owner: 'foreman', leftForHuman: false }],
    ];
    for (const [name, c, id, requests, want] of rows) assert.deepEqual(draftGateOwner(root, c, mandate(root, id), requests), want, name);
  } finally {
    r.cleanup();
  }
});

test('a recorded draft notifies and queues its gate', async () => {
  const r = scratch();
  try {
    const root = r.dir;
    const { config } = loadConfig(root);
    const calls: unknown[][] = [];
    const notify: QueueNotify = (...args) => (calls.push(args), true);
    const { request, digest } = await readyGoal(root, 'g1', ['--decides', 'milestone-approval']);
    const queued = onDraftRecorded(root, config, mandate(root, 'g1'), { request, digest }, { notify });
    assert.deepEqual(calls, [[root, ['gate'], { job: null, reason: 'milestone-approval' }]]);
    assert.equal(REASONS['milestone-approval'], 'A milestone draft is waiting for approval');
    assert.deepEqual(queued && { type: queued.type, job: queued.job, args: queued.args, from: queued.from }, {
      type: 'gate',
      job: null,
      args: { gate: 'milestone-approval', mandate: 'g1', key: request, digest, reserved: null },
      from: 'forge',
    });
    assert.equal(onDraftRecorded(root, config, mandate(root, 'g1'), { request, digest }, { notify }), null, 'one gate request per key, in any status');
    assert.equal(calls.length, 2, 'the owner is told each time, whoever owns the gate');

    const paused = await readyGoal(root, 'g2', ['--decides', 'milestone-approval']);
    await cli(root, ['mandate', 'pause', 'g2']);
    assert.equal(onDraftRecorded(root, config, mandate(root, 'g2'), paused, { notify }), null, 'a paused mandate');

    const capped = await readyGoal(root, 'g3', ['--decides', 'milestone-approval']);
    for (let i = 0; i < 2; i++) {
      const rid = enqueue(root, config, { type: 'draft', args: { mandate: 'g3', note: 'split it', revises: capped.request, foreman: true }, from: 'forge' }).id;
      claimRequest(root, rid, 'office-1');
      ackRequest(root, rid, { status: 'done' });
    }
    assert.equal(onDraftRecorded(root, config, mandate(root, 'g3'), capped, { notify }), null, 'two foreman revisions: the owner decides');

    const narrow = await readyGoal(root, 'g4', ['--decides', 'spec-approval']);
    assert.equal(onDraftRecorded(root, config, mandate(root, 'g4'), narrow, { notify }), null, "the mandate's decides leaves it out");
    assert.equal(listRequests(root).filter((x) => x.type === 'gate').length, 1);
  } finally {
    r.cleanup();
  }
});

test('draft notes', () => {
  assert.deepEqual(cleanDraftNote('\r\n  split issue b\r\nthen\rmore  \n'), { note: 'split issue b\nthen\nmore' });
  assert.deepEqual(cleanDraftNote('tab\tok'), { note: 'tab\tok' });
  const rows: [string, unknown][] = [
    ['empty', ''],
    ['whitespace', ' \n\t '],
    ['U+0007', 'ring\u0007'],
    ['a zero-width space', `a${String.fromCharCode(0x200b)}b`],
    ['an HTML comment', 'a <!-- hidden --> b'],
    ['a line separator', `a${String.fromCharCode(0x2028)}b`],
    ['2001 characters', 'n'.repeat(2001)],
    ['not text', 7],
  ];
  for (const [name, raw] of rows) assert.ok('problem' in cleanDraftNote(raw), name);
  assert.deepEqual(cleanDraftNote('n'.repeat(2000)), { note: 'n'.repeat(2000) });
});
