// Member repo trackers: issues in a config `repos` entry's GitHub tracker start, label and comment
// on jobs in the root project. Scratch repos and a fake `gh` that answers per `-R` slug; no real
// GitHub repo is touched, and every gh call goes through the fake (env on every forge call).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prProject } from './job-repos-fixture.ts';
import type { PrProject } from './job-repos-fixture.ts';
import { loadJob, logEvent, readEvents, setJob } from '../lib/jobs.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

interface Project extends PrProject {
  run: (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  fj: (...args: string[]) => Promise<any>;
}

/** The two-repo project with the root on `kind` (default github) and `statusSync` (default labels). */
async function project(opts: { kind?: string; sync?: string } = {}): Promise<Project> {
  const p = await prProject(cleanups);
  p.config((c) => {
    c.tracker.kind = opts.kind ?? 'github';
    c.tracker.github.statusSync = opts.sync ?? 'labels';
    c.tracker.github.ready = { ...(c.tracker.github.ready ?? {}), labels: ['ready'] };
  });
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => p.raw(args, { ...p.env, ...env });
  const fj = async (...args: string[]) => {
    const r = await run(args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  return { ...p, run, fj };
}

const issue = (n: number, title = `Issue ${n}`, slug = 'o/lib') => ({ number: n, title, url: `https://github.com/${slug}/issues/${n}`, labels: [{ name: 'ready' }], assignees: [] });

/** Escalated, approved by alice, with an open PR #11 the fake gh then reports merged. */
function approvedAndMerged(p: Project, id: string): void {
  setJob(p.root, id, { stage: 'pr', state: 'running', fields: { pr: { number: 11, url: 'https://github.com/o/app/pull/11', state: 'OPEN' } } });
  logEvent(p.root, id, 'transition', { from: { stage: 'decide', state: 'running', waitingOn: null }, to: { stage: 'decide', state: 'waiting', waitingOn: 'escalation' }, reason: 'auth change' });
  logEvent(p.root, id, 'human', { action: 'approve', note: 'ok', actor: { login: 'alice', source: 'env' } });
  p.fake('app.pr', `forge/${id}`);
  p.fake('app.state', 'MERGED');
}

describe('member repo trackers: mirroring and comments', { concurrency: 4 }, () => {
  test('a member issue linked at creation follows the job through set', async () => {
    const p = await project();
    const j = await p.fj('job', 'new', '--title', 'Fix parser', '--issue', 'o/lib#5');
    p.fake('lib.labels-5', '[{"name":"forge:in-progress"}]');
    await p.fj('job', 'set', j.id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'x');
    const edits = p.calls().filter((c) => c.startsWith('issue edit'));
    assert.deepEqual(edits, ['issue edit 5 -R o/lib --add-label forge:blocked --remove-label forge:in-progress']);
    assert.ok(!p.calls().some((c) => c.includes('-R o/app')), p.calls().join('\n'));
  });

  test('member status sync is labels unless the root\'s is none', async () => {
    const none = await project({ sync: 'none' });
    const a = await none.fj('job', 'new', '--title', 'Quiet', '--issue', 'o/lib#5');
    await none.fj('job', 'set', a.id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'x');
    assert.deepEqual(none.calls().filter((c) => c.includes('-R o/lib')), [], 'no label calls with statusSync none');

    const proj = await project({ sync: 'project' });
    proj.config((c) => {
      c.tracker.github.project = { ...c.tracker.github.project, owner: 'o', number: 1 };
    });
    const b = await proj.fj('job', 'new', '--title', 'Loud', '--issue', 'o/lib#5');
    await proj.fj('job', 'set', b.id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'x');
    assert.ok(proj.calls().includes('issue edit 5 -R o/lib --add-label forge:blocked'), proj.calls().join('\n'));
    assert.deepEqual(proj.calls().filter((c) => c.startsWith('project')), [], 'the root project is never applied to a member issue');
    assert.deepEqual(readEvents(proj.root, b.id).filter((e) => e.type === 'tracker-error'), []);
  });

  test('approval comment cites the root PR on member issues', async () => {
    const p = await project({ sync: 'none' });
    const j = await p.fj('job', 'new', '--title', 'Both repos', '--issue', 'o/app#3,o/lib#5');
    approvedAndMerged(p, j.id);
    await p.fj('sync');
    const comments = p.calls().filter((c) => c.startsWith('issue comment'));
    assert.deepEqual(comments, ['issue comment 3 -R o/app --body-file -', 'issue comment 5 -R o/lib --body-file -']);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const body = (f: string) => fs.readFileSync(path.join(p.gh, f), 'utf8');
    assert.match(body('app.comment-3'), /^Merged in #11 \(/);
    assert.match(body('lib.comment-5'), /^Merged in o\/app#11 \(/);
    const ev = readEvents(p.root, j.id).filter((e) => e.type === 'tracker-approval-comment');
    assert.deepEqual(ev.map((e) => [e.refs, e.pr]), [[['3', 'o/lib#5'], 11]]);

    // One repo's failure never stops another's post; the event waits for a retry that succeeds.
    const q = await project({ sync: 'none' });
    const k = await q.fj('job', 'new', '--title', 'Lib fails', '--issue', 'o/app#3,o/lib#5');
    approvedAndMerged(q, k.id);
    q.fake('lib.commentfail', '');
    await q.fj('sync');
    assert.deepEqual(q.calls().filter((c) => c.startsWith('issue comment')), ['issue comment 3 -R o/app --body-file -', 'issue comment 5 -R o/lib --body-file -']);
    const evs = readEvents(q.root, k.id);
    assert.equal(evs.filter((e) => e.type === 'tracker-error').length, 1);
    assert.match(String(evs.find((e) => e.type === 'tracker-error')?.error), /comment failed for o\/lib/);
    assert.equal(evs.filter((e) => e.type === 'tracker-approval-comment').length, 0);
    assert.equal(loadJob(q.root, k.id).state, 'done');
  });
});
