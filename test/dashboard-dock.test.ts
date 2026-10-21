// The job drawer's action dock (dashboard/src/lib/dock.ts) and the session log's follow rule (atBottom in session-log.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dockModel } from '../dashboard/src/lib/dock.ts';
import { resumeModel } from '../dashboard/src/lib/view.ts';
import { atBottom, FOLLOW_SLACK } from '../dashboard/src/lib/session-log.ts';

const p = (id: string) => ({ id, tool: 'Bash', input: '{"command":"ls"}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-14T00:00:01Z' });
const os = (status: string): any => ({ status, session: status === 'none' ? null : 's1', since: null, renewedAt: null, expiresAt: null, epoch: 1, jobSession: false });
const pool = (j1: unknown[] = []): any => ({
  inbox: { scope: '_inbox', permissions: [p('i1')] },
  jobs: { j1: { scope: 'j1', permissions: j1 }, other: { scope: 'other', permissions: [p('o1')] } },
});

test('dockModel: when the dock shows and what it holds', () => {
  const job = (state: string, o: any = {}): any => ({ id: 'j1', kind: 'feature', state, waitingOn: null, ...o });
  const cases: [string, any, any, { show: boolean; actionable: boolean; prompts: string[] }][] = [
    ['running, live owner, no prompts', job('running', { ownerStatus: os('live') }), pool(), { show: false, actionable: false, prompts: [] }],
    ['running, no ownerStatus, no prompts', job('running'), pool(), { show: false, actionable: false, prompts: [] }],
    ['waiting on pr-review', job('waiting', { waitingOn: 'pr-review', ownerStatus: os('none') }), pool(), { show: false, actionable: false, prompts: [] }],
    ['waiting on spec-approval', job('waiting', { waitingOn: 'spec-approval', ownerStatus: os('none') }), pool(), { show: true, actionable: true, prompts: [] }],
    ['waiting on input', job('waiting', { waitingOn: 'input', ownerStatus: os('live') }), pool(), { show: true, actionable: true, prompts: [] }],
    ['failed', job('failed', { ownerStatus: os('none') }), pool(), { show: true, actionable: true, prompts: [] }],
    ['blocked', job('blocked', { ownerStatus: os('live') }), pool(), { show: true, actionable: true, prompts: [] }],
    ['running, expired lease', job('running', { ownerStatus: os('expired') }), pool(), { show: true, actionable: false, prompts: [] }],
    ['running, own prompt', job('running', { ownerStatus: os('live') }), pool([p('j1a'), { tool: 'Bash' }]), { show: true, actionable: false, prompts: ['j1a'] }],
  ];
  for (const [name, j, pl, want] of cases) {
    const m = dockModel(j, pl);
    assert.equal(m.show, want.show, `${name}: show`);
    assert.equal(m.actionable, want.actionable, `${name}: actionable`);
    assert.deepEqual(
      m.prompts.map((x) => [x.scope, x.prompt.id]),
      want.prompts.map((id) => ['j1', id]),
      `${name}: only the job's own prompts, never the inbox's or another job's`,
    );
    assert.deepEqual(m.resume, resumeModel(j), `${name}: resume`);
  }
  assert.equal(dockModel(job('running', { ownerStatus: os('expired') }), pool()).resume.show, true, 'the expired lease shows the dock through resume');
  assert.equal(dockModel(job('done'), null).show, false, 'no pool and nothing to do');
  assert.equal(dockModel(job('cancelled'), undefined).show, false);
  assert.equal(dockModel(job('running', { ownerStatus: os('live') }), { jobs: { x: { scope: 'j1', permissions: [p('k')] } } } as any).prompts.length, 1, 'scope, not the map key, picks the session');
});

test('atBottom: the 24 px slack and short content', () => {
  assert.equal(FOLLOW_SLACK, 24);
  assert.equal(atBottom(1000, 476, 500, 24), true, 'exactly 24 px from the bottom');
  assert.equal(atBottom(1000, 475, 500, 24), false, '25 px from the bottom');
  assert.equal(atBottom(1000, 500, 500, 24), true, 'at the bottom');
  assert.equal(atBottom(300, 0, 500, 24), true, 'content shorter than the pane');
  assert.equal(atBottom(1000, 476, 500), true, 'slack defaults to 24');
  assert.equal(atBottom(1000, 475, 500), false);
  assert.equal(atBottom(1000, 490, 500, 0), false, 'a custom slack');
});
