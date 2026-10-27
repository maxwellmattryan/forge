// The issue panel's model: which jobs name an Issues item (per tracker kind, never another repo's #N or another
// tracker's ref), newest first; which of them holds it; and when Start is offered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canStart, issueJobs, issuePanel, refLabel } from './issue-view.ts';
import type { JobIssue, StateJob } from './types.ts';

const job = (id: string, createdAt: string, issues: Partial<JobIssue>[], state = 'running'): StateJob =>
  ({ id, createdAt, state, issues: issues.map((i) => ({ tracker: 'github', ref: null, url: null, ...i })) }) as unknown as StateJob;

const ids = (jobs: StateJob[]): string[] => jobs.map((j) => j.id);

test('refLabel marks issue numbers', () => {
  assert.equal(refLabel('568'), '#568');
  assert.equal(refLabel('add-the-export-command'), 'add-the-export-command');
  assert.equal(refLabel('o/r#5'), 'o/r#5');
});

test('issueJobs matches a GitHub issue by number, URL or this repo\'s owner/repo#N, newest first', () => {
  const item = { ref: '12', url: 'https://github.com/Acme/Web/issues/12' };
  const jobs = [
    job('qualified', '2026-10-02', [{ ref: 'acme/web#12' }]),
    job('legacy', '2026-10-01', [{ ref: '12' }]),
    job('by-url', '2026-10-04', [{ ref: null, url: 'https://github.com/Acme/Web/issues/12' }]),
    job('hash', '2026-10-03', [{ ref: '#12' }]),
    job('second-issue', '2026-10-05', [{ ref: 'acme/web#1' }, { ref: 'acme/web#12' }]),
    job('other-repo', '2026-10-06', [{ ref: 'other/victim#12' }]),
    job('other-number', '2026-10-07', [{ ref: 'acme/web#120' }, { ref: '1' }]),
    job('other-tracker', '2026-10-08', [{ tracker: 'local', ref: '12' }]),
    job('no-issues', '2026-10-09', []),
  ];
  assert.deepEqual(ids(issueJobs(jobs, 'github', item)), ['second-issue', 'by-url', 'hash', 'qualified', 'legacy']);
  assert.deepEqual(ids(issueJobs(jobs, 'github', { ref: '12', url: null })), ['hash', 'legacy'], 'no URL: only bare numbers match');
});

test('issueJobs matches local and custom refs exactly, in their own tracker only', () => {
  const item = { ref: 'add-the-export-command', url: null };
  const jobs = [
    job('a', '2026-10-01', [{ tracker: 'local', ref: 'add-the-export-command' }]),
    job('b', '2026-10-03', [{ tracker: 'local', ref: 'add-the-export' }]),
    job('c', '2026-10-02', [{ tracker: 'jira', ref: 'add-the-export-command' }]),
    job('d', '2026-10-04', [{ tracker: 'local', ref: 'add-the-export-command' }]),
  ];
  assert.deepEqual(ids(issueJobs(jobs, 'local', item)), ['d', 'a']);
  assert.deepEqual(ids(issueJobs(jobs, 'jira', item)), ['c']);
});

test('issuePanel picks the holding job, a label claim and the earlier jobs', () => {
  const open = job('open', '2026-10-03', [], 'running');
  const done = job('done', '2026-10-02', [], 'done');
  const cancelled = job('cancelled', '2026-10-01', [], 'cancelled');
  const related = [open, done, cancelled];

  assert.deepEqual(issuePanel({ claimedBy: 'done' }, related), { held: done, elsewhere: null, earlier: [open, cancelled] }, 'the claimedBy job wins');
  assert.deepEqual(issuePanel({ claimedBy: null }, related), { held: open, elsewhere: null, earlier: [done, cancelled] }, 'else the first open one');
  assert.deepEqual(issuePanel({ claimedBy: null }, [done, cancelled]), { held: null, elsewhere: null, earlier: [done, cancelled] });
  assert.deepEqual(issuePanel({ claimedBy: 'forge (label)' }, [done]), { held: null, elsewhere: 'forge (label)', earlier: [done] }, 'a label claim with no local job');
  assert.deepEqual(issuePanel({ claimedBy: null }, []), { held: null, elsewhere: null, earlier: [] });
});

test('canStart only when nothing holds the item and it is still open', () => {
  assert.equal(canStart({ claimedBy: null, status: 'ready' }, null), true);
  assert.equal(canStart({ claimedBy: null, status: 'needs-info' }, null), true, 'Start overrides triage');
  assert.equal(canStart({ claimedBy: null, status: null }, null), true);
  assert.equal(canStart({ claimedBy: null, status: 'ready' }, job('x', '', [])), false, 'a job holds it');
  assert.equal(canStart({ claimedBy: 'forge (label)', status: 'ready' }, null), false);
  assert.equal(canStart({ claimedBy: null, status: 'done' }, null), false);
  assert.equal(canStart({ claimedBy: null, status: 'dropped' }, null), false);
});
