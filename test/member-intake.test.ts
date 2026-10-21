// Member repo trackers: issues in a config `repos` entry's GitHub tracker start, label and comment
// on jobs in the root project. Scratch repos and a fake `gh` that answers per `-R` slug; no real
// GitHub repo is touched, and every gh call goes through the fake (env on every forge call).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prProject } from './job-repos-fixture.ts';
import type { PrProject } from './job-repos-fixture.ts';
import { loadJob, logEvent, readEvents, setJob, updateJob } from '../lib/jobs.ts';
import { TRUST_ENV, trustDigest } from '../lib/config.ts';

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

const jobDirs = (p: Project) => {
  const dir = path.join(p.root, '.forge', 'jobs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => !d.startsWith('.')) : [];
};
const issueCalls = (p: Project) => p.calls().filter((c) => c.startsWith('issue '));
/** The error message without the CLI's `forge: ` prefix. */
const message = (r: { stderr: string; stdout: string }) => (r.stderr || r.stdout).trim().replace(/^forge: /, '');

describe('member repo trackers: next', { concurrency: 4 }, () => {
  test("next lists a member repo's ready issues with qualified refs", async () => {
    const p = await project();
    p.fake('lib.issues', JSON.stringify([issue(5, 'Fix parser')]));
    const out = await p.fj('next');
    assert.equal(out.item.ref, 'o/lib#5');
    assert.equal(out.item.repo, 'lib');
    assert.equal(out.item.title, 'Fix parser');
    assert.equal(out.more, 0);
    assert.ok(!('skippedRepos' in out));
    assert.ok(p.calls().includes('issue list -R o/lib --state open --json number,title,url,labels,assignees --limit 20 --label ready'), p.calls().join('\n'));
  });

  test('root items come first and keep their shape', async () => {
    const p = await project();
    p.fake('app.issues', JSON.stringify([issue(3, 'Root work', 'o/app')]));
    p.fake('lib.issues', JSON.stringify([issue(5), issue(6)]));
    const out = await p.fj('next');
    assert.equal(out.item.ref, '3');
    assert.ok(!('repo' in out.item), 'a root item has no repo key');
    assert.equal(out.more, 2, 'more counts the member items');
    // The same root item with no member tracker: byte-identical.
    p.config((c) => {
      c.repos[0].tracker = { kind: 'none' };
    });
    const rootOnly = await p.fj('next');
    assert.deepEqual(rootOnly.item, out.item);
  });

  test('a member without a tracker is never read', async () => {
    const p = await project();
    p.fake('app.issues', JSON.stringify([issue(3, 'Root work', 'o/app')]));
    p.fake('lib.issues', JSON.stringify([issue(5)]));
    p.config((c) => {
      c.repos[0].tracker = { kind: 'none' };
    });
    const none = await p.fj('next');
    // No tracker.repo, and the remote is a local path: no slug, so no tracker.
    p.config((c) => {
      delete c.repos[0].tracker;
    });
    const noSlug = await p.fj('next');
    assert.deepEqual(none, { item: none.item, more: 0 });
    assert.deepEqual(noSlug, none);
    assert.ok(!p.calls().some((c) => c.includes('-R o/lib')), p.calls().join('\n'));
  });

  test('a failing member tracker or clone is reported, not fatal', async () => {
    const p = await project();
    p.fake('app.issues', JSON.stringify([issue(3, 'Root work', 'o/app')]));
    p.fake('lib.issues', JSON.stringify([issue(5)]));
    p.fake('lib.issuefail', '');
    const failed = await p.fj('next');
    assert.equal(failed.item.ref, '3');
    assert.equal(failed.more, 0);
    assert.equal(failed.skippedRepos.length, 1);
    assert.equal(failed.skippedRepos[0].repo, 'lib');
    assert.match(failed.skippedRepos[0].reason, /issue list failed for o\/lib/);
    assert.ok(failed.skippedRepos[0].reason.length <= 300);
    p.fake('lib.issuefail', null);
    fs.writeFileSync(path.join(p.root, '.forge', 'local.yml'), 'repos: {}\n');
    const libLists = () => p.calls().filter((c) => c.startsWith('issue list -R o/lib')).length;
    const listed = libLists();
    const noClone = await p.fj('next');
    assert.equal(noClone.item.ref, '3');
    assert.equal(noClone.skippedRepos.length, 1);
    assert.equal(noClone.skippedRepos[0].repo, 'lib');
    assert.match(noClone.skippedRepos[0].reason, /no path in \.forge\/local\.yml/);
    assert.equal(libLists(), listed, 'a member whose clone fails is not read');
  });

  test('next --claim starts a job with the member as a job repo', async () => {
    const p = await project();
    p.fake('lib.issues', JSON.stringify([issue(5, 'Fix parser')]));
    const out = await p.fj('next', '--claim', '--session', 'S');
    assert.equal(out.repo, 'lib');
    assert.equal(out.ref, 'o/lib#5');
    assert.equal(out.resumed, false);
    assert.match(out.id, /^lib-5-/);
    const job = loadJob(p.root, out.id);
    assert.deepEqual(job.issues[0], { tracker: 'github', ref: 'o/lib#5', url: 'https://github.com/o/lib/issues/5' });
    // The entry `forge job repo add` writes; loading names the member's branch after the job's.
    assert.deepEqual(job.repos[1], { repo: 'lib', worktree: null, branch: `forge/${out.id}`, base: 'main', pr: null, verifyOnly: false, interim: null });
    assert.equal(job.lease.driver, 'S');
    const added = p.events(out.id).filter((e) => e.type === 'job-repo-added');
    assert.deepEqual(added.map((e) => [e.repo, e.verifyOnly]), [['lib', false]]);
    assert.ok(p.calls().includes('issue edit 5 -R o/lib --add-assignee @me'), p.calls().join('\n'));
    await p.fj('worktree', 'create', out.id);
    assert.ok(fs.existsSync(path.join(p.parent, 'lib.worktrees', out.id)), 'the lib worktree');
  });

  test("a member issue's labels track the job through set and sync", async () => {
    const p = await project();
    p.fake('lib.issues', JSON.stringify([issue(5, 'Fix parser')]));
    const out = await p.fj('next', '--claim', '--session', 'S');
    const edits = () => issueCalls(p).filter((c) => c.startsWith('issue edit'));
    const claimed = edits().find((c) => c.includes('--add-label'));
    assert.match(claimed ?? '', /^issue edit 5 -R o\/lib --add-label forge:(queued|in-progress)$/);
    const claimLabel = claimed!.split(' ').pop()!;
    await p.fj('job', 'set', out.id, '--state', 'waiting', '--waiting-on', 'human', '--reason', 'x');
    assert.equal(edits().at(-1), `issue edit 5 -R o/lib --add-label forge:blocked --remove-label ${claimLabel}`);
    approvedAndMerged(p, out.id);
    // The member's PR merged too, so the linked job is done.
    updateJob(p.root, out.id, (j) => {
      j.repos[1].pr = { number: 7, url: 'https://github.com/o/lib/pull/7', state: 'OPEN' } as any;
    });
    p.fake('lib.pr', `forge/${out.id}`);
    p.fake('lib.state', 'MERGED');
    await p.fj('sync');
    assert.equal(loadJob(p.root, out.id).state, 'done');
    assert.equal(edits().at(-1), 'issue edit 5 -R o/lib --add-label forge:done --remove-label forge:blocked');
    assert.ok(!edits().some((c) => c.includes('-R o/app')), edits().join('\n'));
  });
});

describe('member repo trackers: from-ref', { concurrency: 4 }, () => {
  test('from-ref takes a member issue under any root tracker and finds existing jobs', async () => {
    const p = await project({ kind: 'local' });
    const out = await p.fj('job', 'from-ref', 'o/lib#5');
    assert.equal(out.repo, 'lib');
    assert.equal(out.ref, 'o/lib#5');
    const before = loadJob(p.root, out.id);
    assert.equal(before.repos[1].repo, 'lib');
    const events = p.events(out.id).length;
    const edits = issueCalls(p).filter((c) => c.startsWith('issue edit')).length;
    const again = await p.fj('job', 'from-ref', 'O/LIB#5');
    assert.deepEqual(again, { id: out.id, existing: true, stage: before.stage, state: before.state });
    assert.deepEqual(loadJob(p.root, out.id).repos, before.repos);
    assert.equal(p.events(out.id).length, events);
    assert.equal(issueCalls(p).filter((c) => c.startsWith('issue edit')).length, edits);
    assert.deepEqual(jobDirs(p), [out.id]);
  });

  test('a ref no configured repo owns is still refused', async () => {
    const p = await project();
    const r = await p.run(['job', 'from-ref', 'x/y#3']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(message(r), /^from-ref takes an issue in o\/app or a member repo's tracker \(o\/lib\)/);
    assert.deepEqual(jobDirs(p), []);
    p.config((c) => {
      c.repos[0].tracker = { kind: 'none' };
    });
    const plain = await p.run(['job', 'from-ref', 'o/lib#3']);
    assert.equal(plain.status, 1);
    assert.equal(message(plain), 'from-ref takes an issue in o/app', 'no member tracker: the message is unchanged');
    assert.deepEqual(issueCalls(p), []);
  });

  test('a member clone failure refuses before creating or claiming', async () => {
    const p = await project();
    fs.writeFileSync(path.join(p.root, '.forge', 'local.yml'), 'repos: {}\n');
    const r = await p.run(['job', 'from-ref', 'o/lib#5']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(message(r), /repo lib: no path in \.forge\/local\.yml; clone it/);
    assert.deepEqual(jobDirs(p), []);
    assert.deepEqual(issueCalls(p), [], 'neither read nor claimed');
  });

  test('daemon intake adds only a configured member, and only to the job it creates', async () => {
    const p = await project();
    p.fake('lib.issues', JSON.stringify([issue(5, 'Fix parser')]));
    const daemon = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(p.root) };
    const r = await p.run(['next', '--claim', '--session', 'S'], daemon);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.repo, 'lib', r.stdout);
    assert.equal(loadJob(p.root, out.id).repos[1].repo, 'lib');
    const other = await p.fj('job', 'new', '--title', 'Other work', '--issue', 'o/lib#6');
    const add = await p.run(['job', 'repo', 'add', other.id, 'lib'], daemon);
    assert.equal(add.status, 1);
    assert.match(message(add), /daemon session may not change/);
    const found = await p.run(['job', 'from-ref', 'o/lib#6'], daemon);
    assert.equal(found.status, 0, found.stderr);
    assert.equal(JSON.parse(found.stdout).existing, true);
    assert.equal(loadJob(p.root, other.id).repos.length, 1, 'an existing job is never widened');
    assert.ok(!p.events(other.id).some((e) => e.type === 'job-repo-added'));
  });

  test('member refs pass the ref grammar before reaching gh', async () => {
    const p = await project();
    const hostile = `${'a/'.repeat(5000)}lib#1`;
    for (const ref of ['-R/x#1', 'o/../lib#1', '../lib#1', 'o/lib#05', 'o/lib#12345678901', 'o/other#1', 'o/lib/x#1', 'o/lib#5\n', hostile]) {
      const started = Date.now();
      const r = await p.run(['job', 'from-ref', '--', ref]);
      assert.equal(r.status, 1, `${ref.slice(0, 40)} was accepted: ${r.stdout}`);
      assert.match(message(r), /^(invalid ref |from-ref takes an issue in o\/app or a member repo's tracker)/);
      assert.ok(Date.now() - started < 5000, 'refused promptly');
    }
    assert.deepEqual(jobDirs(p), []);
    assert.deepEqual(issueCalls(p), []);
    // Accepted refs still put only the digits in the issue argument.
    await p.fj('job', 'from-ref', 'o/lib#5');
    const args = issueCalls(p).map((c) => c.split(' ')[2]);
    assert.ok(args.length && args.every((a) => /^[0-9]+$/.test(a)), issueCalls(p).join('\n'));
  });
});
