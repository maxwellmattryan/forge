// The human-command table: the plan each job request gets on the job it names (requestPlan), and the issue link an
// approve carries (requestLink). Pure: what `forge job apply` then records is test/integration/cli/apply.test.ts's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJob } from '#core/job/schema.ts';
import type { ForgeRequest, Job } from '#core/types.ts';
import { requestLink, requestPlan, type RequestPlan } from './request-table.ts';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const job = (o: Partial<Job> = {}): Job => ({ ...normalizeJob({ id: 'j' }), ...o }) as Job;
const parked = (waitingOn: string, reason: string | null = null, o: Partial<Job> = {}): Job => job({ state: 'waiting', waitingOn: waitingOn as Job['waitingOn'], reason, ...o });
const req = (type: string, o: Partial<ForgeRequest> = {}): ForgeRequest => ({ id: '1-a', type: type as ForgeRequest['type'], job: 'j', text: null, args: {}, from: 'dashboard', status: 'pending', createdAt: NOW.toISOString(), ...o });
const REPO_PROPOSAL = parked('human', 'repo proposal: lib');
const PROPOSAL_REFUSAL = 'decide repo proposals in the dashboard drawer or your own terminal: forge job human j approve-repos|reject-repos --repo <names>';

test('the human-command table', () => {
  type Row = [name: string, r: ForgeRequest, j: Job, want: RequestPlan, stillExceeded?: string[] | null];
  const rows: Row[] = [
    // Provenance first: a decision only from a person.
    ['an approve from the inbox session', req('approve', { from: 'daemon:_inbox' }), parked('escalation'), { refuse: 'human decisions come from a person (this approve came from daemon:_inbox)' }],
    ['an approve from forge', req('approve', { from: 'forge' }), parked('escalation'), { refuse: 'human decisions come from a person (this approve came from forge)' }],
    ['an approve from sync', req('approve', { from: 'sync' }), parked('escalation'), { refuse: 'human decisions come from a person (this approve came from sync)' }],
    ['a cancel from the code driver', req('cancel', { from: 'code-driver' }), job(), { refuse: 'human decisions come from a person (this cancel came from code-driver)' }],
    ['a rework with no from', req('rework', { from: undefined as unknown as string }), parked('escalation'), { refuse: 'human decisions come from a person (this rework came from nowhere)' }],
    ['a resume from sync on an infra park', req('resume', { from: 'sync' }), parked('infra'), { steps: [{ human: 'approve', note: 'steps done' }] }],
    // The shelf.
    ['an approve on a shelved job', req('approve', { from: 'cli' }), parked('shelved'), { refuse: 'job j is shelved; un-shelve it first (the Shelved list in Needs you, or forge job unshelve j in your own terminal)' }],
    ['a resume on a shelved job', req('resume'), parked('shelved'), { refuse: 'job j is shelved; un-shelve it first (the Shelved list in Needs you, or forge job unshelve j in your own terminal)' }],
    ['a cancel on a shelved job', req('cancel', { text: 'not needed' }), parked('shelved'), { steps: [{ set: { state: 'cancelled', reason: 'not needed' } }] }],
    // approve
    ['approve at spec-approval', req('approve', { text: 'go ahead' }), parked('spec-approval', 'spec ready'), { steps: [{ human: 'approve-spec', note: 'go ahead' }] }],
    ['approve at escalation', req('approve', { text: 'ship' }), parked('escalation'), { steps: [{ human: 'approve', note: 'ship' }] }],
    ['approve at rounds-exhausted', req('approve'), parked('rounds-exhausted'), { steps: [{ human: 'approve', note: null }] }],
    ['approve at infra', req('approve'), parked('infra'), { steps: [{ human: 'approve', note: null }] }],
    ['approve at conflicts', req('approve'), parked('conflicts'), { steps: [{ human: 'approve', note: null }] }],
    ['approve at a repo budget hold, monthly', req('approve'), parked('budget', 'repo budget: $5.00 of $4.00 this month'), { refuse: 'the repo budget holds this job: a person runs forge budget ack --period 2026-10 or raises budget.*' }],
    ['approve at a repo budget hold, daily', req('approve'), parked('budget', 'repo budget: $5.00 of $4.00 today'), { refuse: 'the repo budget holds this job: a person runs forge budget ack --period 2026-10-30 or raises budget.*' }],
    ['approve at a job budget nothing is over', req('approve'), parked('budget', 'budget: tokens'), { steps: [{ human: 'approve', note: null }] }, []],
    [
      'approve at a job budget still over',
      req('approve'),
      parked('budget', 'budget: tokens'),
      { refuse: "still over budget: tokens, usd: raise or acknowledge it on the dashboard's budget gate, or with forge job budget j --set or --ack in your own terminal" },
      ['tokens', 'usd'],
    ],
    ['approve at split-approval', req('approve'), parked('split-approval'), { steps: [{ human: 'approve-split', note: null }] }],
    ['approve at a repo proposal', req('approve'), REPO_PROPOSAL, { refuse: PROPOSAL_REFUSAL }],
    ['approve at a human park', req('approve', { text: 'fine' }), parked('human', 'secret scan blocked forge pr open'), { steps: [{ human: 'approve', note: 'fine' }] }],
    ['approve at a held push', req('approve'), parked('human', 'push held: escalation: security'), { steps: [{ human: 'approve', note: null }] }],
    ['approve on a running job', req('approve'), job({ state: 'running' }), { refuse: 'j is running: an approve answers no gate there' }],
    ['approve at input', req('approve'), parked('input'), { refuse: 'j is waiting on input: an approve answers no gate there' }],
    // revise-spec
    ['revise-spec at split-approval with text', req('revise-spec', { text: 'one job' }), parked('split-approval'), { steps: [{ human: 'revise-split', note: 'one job' }, { feedback: true }] }],
    ['revise-spec at split-approval without text', req('revise-spec'), parked('split-approval'), { steps: [{ human: 'revise-split', note: null }] }],
    ['revise-spec at a repo proposal', req('revise-spec', { text: 'no' }), REPO_PROPOSAL, { refuse: PROPOSAL_REFUSAL }],
    ['revise-spec at the spec gate', req('revise-spec', { text: 'smaller' }), parked('spec-approval', 'spec ready'), { steps: [{ human: 'revise-spec', note: 'smaller' }, { feedback: true }] }],
    // answer
    ['answer at input', req('answer', { text: 'use main' }), parked('input'), { steps: [{ human: 'answer', note: 'use main' }, { answer: true }] }],
    ['answer with no text', req('answer', { text: '  ' }), parked('input'), { refuse: 'an answer needs text' }],
    ['answer off input', req('answer', { text: 'x' }), parked('escalation'), { refuse: 'j is not waiting on input' }],
    // rework
    ['rework at conflicts', req('rework'), parked('conflicts'), { steps: [{ human: 'approve', note: null }] }],
    ['rework at a repo proposal', req('rework', { text: 'x' }), REPO_PROPOSAL, { refuse: PROPOSAL_REFUSAL }],
    ['rework with a note', req('rework', { text: 'fix the test' }), parked('pr-review'), { steps: [{ human: 'rework', note: 'fix the test' }, { feedback: true }] }],
    ['rework with no note', req('rework'), parked('escalation'), { steps: [{ human: 'rework', note: null }] }],
    // cancel
    ['cancel with a reason', req('cancel', { text: 'dup\nof #3' }), job(), { steps: [{ set: { state: 'cancelled', reason: 'dup of #3' } }] }],
    ['cancel with a long reason', req('cancel', { text: 'x'.repeat(300) }), job(), { steps: [{ set: { state: 'cancelled', reason: 'x'.repeat(200) } }] }],
    ['cancel with no reason', req('cancel'), parked('spec-approval'), { steps: [{ set: { state: 'cancelled', reason: 'cancelled by a person' } }] }],
    // resume
    ['resume at infra', req('resume'), parked('infra'), { steps: [{ human: 'approve', note: 'steps done' }] }],
    ['resume at external', req('resume'), parked('external'), { steps: [{ set: { state: 'running' } }] }],
    ['resume at conflicts', req('resume'), parked('conflicts'), { steps: [{ set: { stage: 'decide', state: 'running', note: 'conflicts with base deferred' } }] }],
    ['resume on a failed job', req('resume'), job({ state: 'failed' }), { steps: [{ set: { state: 'running' } }] }],
    ['resume on a running job', req('resume'), job({ state: 'running' }), { none: true }],
    ['resume at the spec gate', req('resume'), parked('spec-approval'), { none: true }],
    // The issue link (requestLink through the approve rows).
    ['the spec gate unlinked: args.link', req('approve', { text: 'ok', args: { link: '#12' } }), parked('spec-approval', 'spec ready, issue unlinked'), { steps: [{ human: 'approve-spec', note: 'ok', link: '#12' }] }],
    ['the spec gate unlinked: new', req('approve', { text: 'new build it' }), parked('spec-approval', 'spec ready, issue unlinked'), { steps: [{ human: 'approve-spec', note: 'build it', link: 'new' }] }],
    ['the spec gate unlinked: none with a reason', req('approve', { text: 'none a test job' }), parked('spec-approval', 'spec ready, issue unlinked'), { steps: [{ human: 'approve-spec', note: null, link: 'none', reason: 'a test job' }] }],
    ['the spec gate unlinked: 12', req('approve', { text: '12' }), parked('spec-approval', 'spec ready, issue unlinked'), { steps: [{ human: 'approve-spec', note: null, link: '12' }] }],
    ['the spec gate unlinked: #12', req('approve', { text: '#12 looks good' }), parked('spec-approval', 'spec ready, issue unlinked'), { steps: [{ human: 'approve-spec', note: 'looks good', link: '#12' }] }],
    ['the spec gate unlinked: owner/repo#12', req('approve', { text: 'owner/repo#12' }), parked('spec-approval', 'spec ready, issue unlinked'), { steps: [{ human: 'approve-spec', note: null, link: 'owner/repo#12' }] }],
    ['the spec gate unlinked: no ref keeps the note', req('approve', { text: 'looks good to me' }), parked('spec-approval', 'spec ready, issue unlinked'), { steps: [{ human: 'approve-spec', note: 'looks good to me' }] }],
    ['the spec gate linked: args.link is ignored', req('approve', { text: 'ok', args: { link: '#12' } }), parked('spec-approval', 'spec ready'), { steps: [{ human: 'approve-spec', note: 'ok' }] }],
    ['issue-link: args.link', req('approve', { args: { link: 'new' } }), parked('issue-link'), { steps: [{ human: 'approve', note: null, link: 'new' }] }],
    ['issue-link: an unsafe args.link goes on to forge job human', req('approve', { args: { link: '--force' } }), parked('issue-link'), { steps: [{ human: 'approve', note: null, link: '--force' }] }],
    ['issue-link: none', req('approve', { text: 'none' }), parked('issue-link'), { steps: [{ human: 'approve', note: null, link: 'none' }] }],
    [
      'issue-link: no ref is refused',
      req('approve', { text: 'looks good to me' }),
      parked('issue-link'),
      { refuse: 'an approve on an issue-link park needs args.link or a first word new, none or an issue ref' },
    ],
    ['issue-link: no text is refused', req('approve'), parked('issue-link'), { refuse: 'an approve on an issue-link park needs args.link or a first word new, none or an issue ref' }],
    ['issue-link: a non-string args.link is refused', req('approve', { args: { link: 12 } }), parked('issue-link'), { refuse: 'args.link must be an issue ref, new or none' }],
  ];
  for (const [name, r, j, want, stillExceeded] of rows) assert.deepEqual(requestPlan(r, j, { stillExceeded: stillExceeded ?? null, now: NOW }), want, name);

  // requestLink on its own: null at the spec gate when the first word is no ref, an error at an issue-link park.
  assert.equal(requestLink({ text: 'ship it', args: {} }, { waitingOn: 'spec-approval' }), null);
  assert.deepEqual(requestLink({ text: 'ship it', args: {} }, { waitingOn: 'issue-link' }), { error: 'an approve on an issue-link park needs args.link or a first word new, none or an issue ref' });
  assert.deepEqual(requestLink({ text: 'x;y', args: { link: 'x;y' } }, { waitingOn: 'issue-link' }), { link: 'x;y', note: 'x;y' });
});
