// The dashboard's repo proposal helpers (issue #180): the inbox kind of step RP1's park, the defensive parse of
// repo-proposals.json (agent-written job state), and the POST that decides every pending proposal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRepoProposal, parseRepoProposals, pendingRepos, postRepoDecision, proposalTone } from '../dashboard/src/lib/repo-proposals.ts';
import { inboxActions, inboxDoc, inboxKind, showsNote } from '../dashboard/src/lib/view.ts';

const parked = { id: 'j', state: 'waiting', waitingOn: 'human', reason: 'repo proposal: lib, tools', round: 0 } as any;

test('a repo proposal park is its own inbox kind', () => {
  assert.equal(isRepoProposal(parked), true);
  assert.equal(inboxKind(parked), 'repo-proposal');
  for (const other of [{ ...parked, reason: 'protected paths: x' }, { ...parked, waitingOn: 'escalation' }, { ...parked, state: 'running' }, { ...parked, reason: null }]) {
    assert.equal(isRepoProposal(other), false);
    assert.notEqual(inboxKind(other), 'repo-proposal');
  }
  assert.equal(isRepoProposal(null), false);
  assert.equal(inboxDoc('repo-proposal', parked), 'repo-proposals.md');
  assert.equal(showsNote('repo-proposal'), true);
  // Approve and Reject come from RepoProposalActions; a plain Approve would only re-park the job.
  assert.deepEqual(inboxActions('repo-proposal').map((a) => [a.label, a.type]), [['Cancel job', 'cancel']]);
  assert.equal(inboxKind({ ...parked, state: 'failed' }), 'failed');
});

test('parseRepoProposals keeps well-formed rows and drops the rest', () => {
  const rows = parseRepoProposals(
    JSON.stringify({
      proposals: [
        { repo: 'lib', reason: '<script>alert(1)</script><img src=x onerror=alert(2)>', proposedAt: 't1', status: 'pending', decidedAt: null, actor: { login: 'mallory', source: 'gh' }, note: null },
        { repo: '../evil', reason: 'x', status: 'pending' },
        { repo: 'tools', reason: 7, status: 'rejected', decidedAt: 't2', note: 'n'.repeat(3000) },
        { repo: 'docs', reason: 'x', status: 'merged' },
        null,
        'junk',
      ],
    }),
  );
  assert.deepEqual(
    rows.map((r) => [r.repo, r.status, r.reason, r.actor, r.note?.length ?? null]),
    [
      ['lib', 'pending', '<script>alert(1)</script><img src=x onerror=alert(2)>', null, null],
      ['tools', 'rejected', '', null, 2000],
    ],
  );
  assert.equal(parseRepoProposals(JSON.stringify({ proposals: [{ repo: 'lib', reason: 'r'.repeat(500), status: 'pending' }] }))[0].reason.length, 200);
  for (const bad of ['', 'not json', 'null', '[]', '{"proposals": 3}']) assert.deepEqual(parseRepoProposals(bad), [], bad);
  assert.deepEqual(['pending', 'approved', 'rejected'].map((s) => proposalTone(s as any)), ['you', 'ok', 'muted']);
});

test('pendingRepos lists only the pending rows the drawer shows', () => {
  const rows = parseRepoProposals(JSON.stringify({ proposals: [
    { repo: 'lib', status: 'pending', reason: '' },
    { repo: 'tools', status: 'rejected', reason: '' },
    { repo: '../evil', status: 'pending', reason: '' },
    { repo: 'docs', status: 'pending', reason: '' },
  ] }));
  assert.deepEqual(pendingRepos(rows), ['lib', 'docs']);
  assert.deepEqual(pendingRepos([]), []);
});

test('postRepoDecision posts the decision, the shown repos and the note, and throws the server error', async () => {
  const calls: any[] = [];
  const reply = (status: number, body: unknown) => async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  const ok = { id: 'a b', decision: 'approve', repos: ['lib'], added: ['lib'], pending: [], resumed: true };
  assert.deepEqual(await postRepoDecision('a b', 'approve', ['lib'], '  ship it ', 'tok', reply(200, ok) as any), ok);
  await postRepoDecision('a', 'reject', ['lib', 'tools'], '   ', 'tok', reply(200, { ...ok, decision: 'reject' }) as any);
  assert.deepEqual(
    calls.map((c) => [c.url, c.init.method, c.init.headers['x-forge-token'], c.init.headers['content-type'], c.init.body]),
    [
      ['/api/jobs/a%20b/repos', 'POST', 'tok', 'application/json', '{"decision":"approve","repos":["lib"],"note":"ship it"}'],
      ['/api/jobs/a/repos', 'POST', 'tok', 'application/json', '{"decision":"reject","repos":["lib","tools"],"note":null}'],
    ],
  );
  await assert.rejects(postRepoDecision('a', 'approve', ['lib'], '', 'tok', reply(409, { error: 'repo tools: no path' }) as any), /repo tools: no path/);
  await assert.rejects(postRepoDecision('a', 'approve', ['lib'], '', 'tok', reply(500, 'boom') as any), /boom/);
});
