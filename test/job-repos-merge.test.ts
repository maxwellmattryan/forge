// Linked PRs: sibling links in every PR body, a job done only when every PR merged, and merges in
// the components' dependency order. Scratch repos with bare remotes and the fake gh in
// job-repos-fixture.ts; no real GitHub repo is touched.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dependsOn, prProject, ready } from './job-repos-fixture.ts';
import type { PrProject } from './job-repos-fixture.ts';
import { loadJob } from '../lib/jobs.ts';
import { SIBLINGS_END, SIBLINGS_START, spliceSiblings } from '../lib/pr.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

// The fake gh is a sh script.
const skip = process.platform === 'win32';

/** A two-repo job, verified, with both PRs open: lib #7 and app #11. */
async function opened(p: PrProject) {
  const j = await ready(p);
  await p.f('verify', j.id);
  const r = await p.pr(['open', j.id]);
  assert.equal(r.status, 0, r.stderr);
  return j;
}

const section = (line: string) => `${SIBLINGS_START}\n${line}\n${SIBLINGS_END}`;
const edits = (p: PrProject, slug?: string) => p.calls().filter((c) => c.startsWith('pr edit') && (!slug || c.includes(`-R ${slug} `)));

describe('linked PRs: sibling links', { concurrency: 4, skip }, () => {
  test('pr open links sibling PRs in graph order', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    const line = `Part of job ${j.id}: o/lib#7 then o/app#11`;
    const dir = path.join(p.root, '.forge', 'jobs', j.id);
    for (const [name, file] of [['app', 'pr-body.md'], ['lib', 'pr-body-lib.md']]) {
      const created = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.ok(created.includes(`${SIBLINGS_START}\n${SIBLINGS_END}`), `${name}: the PR is created with an empty section`);
      assert.equal(p.body(name), created.replace(`${SIBLINGS_START}\n${SIBLINGS_END}`, section(line)), `${name}: only the section changed`);
    }
    assert.equal(edits(p).length, 2);
    assert.deepEqual(
      p.events(j.id).filter((e) => e.type === 'pr-links-updated').map((e) => [e.repo ?? null, e.number, e.line]),
      [['lib', 7, line], [null, 11, line]],
    );
    const again = await p.pr(['open', j.id]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(edits(p).length, 2, 'a second pr open makes no pr edit call');
  });

  test('sync rewrites sibling links only when they change', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    const sync = async () => {
      const r = await p.pr(['sync', j.id]);
      assert.equal(r.status, 0, r.stderr);
    };
    const kinds = (type: string) => p.events(j.id).filter((e) => e.type === type).map((e) => [e.repo ?? null, e.number]);
    await sync();
    assert.equal(edits(p).length, 2, 'an unchanged line is not written again');

    // The member PR's number changes: both bodies get the new line.
    p.fake('lib.num', '8');
    await sync();
    const line8 = `Part of job ${j.id}: o/lib#8 then o/app#11`;
    assert.equal(edits(p).length, 4);
    assert.ok(p.body('lib').includes(section(line8)) && p.body('app').includes(section(line8)));

    // A human removed the markers from the root body: it is left alone, and skipped once per line.
    const human = 'Rewritten by a person.\n';
    p.fake('app.body', human);
    p.fake('lib.num', '9');
    await sync();
    await sync();
    assert.equal(p.body('app'), human);
    assert.deepEqual(kinds('pr-links-skipped'), [[null, 11]]);
    assert.equal(p.events(j.id).find((e) => e.type === 'pr-links-skipped').reason, 'markers');
    assert.equal(edits(p, 'o/app').length, 2, 'no edit of the root body without markers');

    // A failing edit is logged and never fails sync.
    p.fake('lib.editfail', '');
    p.fake('lib.num', '10');
    await sync();
    assert.deepEqual(kinds('pr-links-failed'), [['lib', 10]]);
    p.fake('lib.editfail', null);

    // A MERGED PR is never edited, and the open one still is.
    p.fake('app.body', `x\n${SIBLINGS_START}\n${SIBLINGS_END}\n`);
    p.fake('app.state', 'MERGED');
    p.fake('lib.num', '12');
    const before = edits(p, 'o/app').length;
    await sync();
    assert.equal(edits(p, 'o/app').length, before, 'no edit of a merged PR');
    assert.ok(p.body('lib').includes(section(`Part of job ${j.id}: o/lib#12 then o/app#11`)));
  });

  test('a PR off the job branch, or edited between reads, is never overwritten', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    const sync = async () => {
      const r = await p.pr(['sync', j.id]);
      assert.equal(r.status, 0, r.stderr);
    };
    const kinds = (type: string) => p.events(j.id).filter((e) => e.type === type).map((e) => [e.repo ?? null, e.number, e.reason]);

    // job.json's lib number now names an unrelated PR on another branch: its body is left alone.
    const foreign = `foreign\n${SIBLINGS_START}\nkeep\n${SIBLINGS_END}\n`;
    p.fake('lib.headref', 'someone-else');
    p.fake('lib.body', foreign);
    p.fake('app.num', '12');
    const before = edits(p, 'o/lib').length;
    await sync();
    assert.equal(edits(p, 'o/lib').length, before, 'no edit of a PR on another branch');
    assert.equal(p.body('lib'), foreign);
    assert.deepEqual(kinds('pr-links-failed'), [['lib', 7, undefined]]);
    p.fake('lib.headref', null);

    // A human edits the root body between Forge's read and its write: the edit wins, and the next
    // sync writes the line into the edited body.
    const human = `edited by a person\n${SIBLINGS_START}\n${SIBLINGS_END}\n`;
    p.fake('app.racebody', human);
    p.fake('app.num', '13');
    const rootEdits = edits(p, 'o/app').length;
    await sync();
    assert.equal(edits(p, 'o/app').length, rootEdits, 'no write over a body that changed since the read');
    assert.equal(p.body('app'), human);
    assert.deepEqual(kinds('pr-links-skipped'), [[null, 13, 'changed']]);
    await sync();
    const line = `Part of job ${j.id}: o/lib#7 then o/app#13`;
    assert.equal(p.body('app'), human.replace(`${SIBLINGS_START}\n${SIBLINGS_END}`, section(line)));
  });

  test('no sibling section without a PR member', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const v = await ready(p, { verifyOnly: true });
    await p.f('verify', v.id);
    assert.equal((await p.pr(['open', v.id])).status, 0);
    await p.f('job', 'set', v.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    assert.equal((await p.pr(['sync', v.id])).status, 0);
    const title = loadJob(p.root, v.id).title;
    assert.equal(p.body('app'), `## Summary\n\n${title}\n\n<!-- forge -->\n`, 'a verify-only member keeps the single-repo body');

    const s = await p.f('job', 'new', '--title', 'Single repo change');
    await p.f('worktree', 'create', s.id);
    p.commit(path.join(p.parent, 'app.worktrees', s.id), { 'one.txt': 'one\n' }, 'feat: one');
    await p.f('job', 'round', s.id);
    await p.f('verify', s.id);
    p.fake('app.pr', null);
    assert.equal((await p.pr(['open', s.id])).status, 0);
    await p.f('job', 'set', s.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    assert.equal((await p.pr(['sync', s.id])).status, 0);
    assert.equal(p.body('app'), `## Summary\n\nSingle repo change\n\n<!-- forge -->\n`);
    assert.deepEqual(p.calls().filter((c) => c.startsWith('pr edit') || c.includes('--json body')), [], 'no edit or body read');
  });
});

/** Syncs `id` (exit 0) and returns the job after. */
async function synced(p: PrProject, id: string) {
  const r = await p.pr(['sync', id]);
  assert.equal(r.status, 0, r.stderr);
  return loadJob(p.root, id);
}

describe('linked PRs: sync across repos', { concurrency: 4, skip }, () => {
  test('the job is done only when every PR merged', async () => {
    const p = await prProject(cleanups);
    const j = await opened(p);
    await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    p.fake('app.state', 'MERGED');
    let job = await synced(p, j.id);
    assert.deepEqual([job.stage, job.state, job.waitingOn, job.reason], ['pr', 'waiting', 'pr-review', 'PR merged; waiting on repo lib PR #7']);
    // The member merged, but this sync could not read it: not done.
    p.fake('lib.state', 'MERGED');
    p.fake('lib.viewfail', '');
    job = await synced(p, j.id);
    assert.deepEqual([job.stage, job.state, job.reason], ['pr', 'waiting', 'PR merged; waiting on repo lib (state unknown)']);
    p.fake('lib.viewfail', null);
    job = await synced(p, j.id);
    assert.deepEqual([job.stage, job.state, job.reason], ['done', 'done', 'all PRs merged']);
  });

  test('a closed member PR is surfaced, not ignored', async () => {
    const p = await prProject(cleanups);
    const j = await opened(p);
    await p.f('job', 'set', j.id, '--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review');
    p.fake('lib.state', 'CLOSED');
    await synced(p, j.id);
    let job = await synced(p, j.id);
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'repo-pr-closed').map((e) => [e.repo, e.number]), [['lib', 7]], 'logged once over two syncs');
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'note').map((e) => e.text), ['repo lib PR #7 was closed without merging']);
    assert.deepEqual([job.stage, job.state], ['pr', 'waiting'], 'a member never cancels the job');
    p.fake('app.state', 'MERGED');
    job = await synced(p, j.id);
    assert.deepEqual([job.stage, job.state, job.reason], ['pr', 'waiting', 'PR merged; waiting on repo lib PR #7 (closed without merging)'], 'and it is never done while closed');
    p.fake('app.state', 'CLOSED');
    job = await synced(p, j.id);
    assert.deepEqual([job.state, job.reason], ['cancelled', 'PR closed without merging'], 'a closed root still cancels');
  });
});

/**
 * Makes the fake gh report each PR's head as the commit forge pr open pushed, with `checks`, and
 * records both repos' releases: these edges are the default `local`, whose release gate would
 * otherwise hold every consumer (test/interim-pr.test.ts covers that gate).
 */
function pin(p: PrProject, id: string, checks: 'passing' | 'pending' | 'failing' | null = 'passing') {
  const events = path.join(p.root, '.forge', 'jobs', id, 'events.jsonl');
  for (const repo of ['lib', null]) fs.appendFileSync(events, JSON.stringify({ v: 2, ts: new Date().toISOString(), type: 'interim-released', repo, version: '1.0.0' }) + '\n');
  const job = loadJob(p.root, id);
  p.fake('app.head', job.pr!.pushedSha!);
  p.fake('lib.head', job.repos[1].pr!.pushedSha!);
  p.fake('app.checks', checks);
  p.fake('lib.checks', checks);
  return { app: job.pr!.pushedSha!, lib: job.repos[1].pr!.pushedSha! };
}

const merges = (p: PrProject) => p.calls().filter((c) => c.startsWith('pr merge'));
const json = (r: { stdout: string }) => JSON.parse(r.stdout);

describe('linked PRs: graph-ordered merges', { concurrency: 4, skip }, () => {
  test('pr merge merges in graph order', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    const heads = pin(p, j.id);
    const r = await p.pr(['merge', j.id]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(merges(p), [`pr merge 7 -R o/lib --squash --match-head-commit ${heads.lib}`, `pr merge 11 -R o/app --squash --match-head-commit ${heads.app}`]);
    const out = json(r);
    assert.deepEqual([out.merged, out.action, out.repo], [true, 'merged', null]);
    assert.deepEqual(out.parts.map((x: any) => [x.repo, x.number, x.action]), [['lib', 7, 'merged'], [null, 11, 'merged']]);
    const merged = p.events(j.id).filter((e) => e.type === 'pr-merged');
    assert.deepEqual(merged.map((e) => [e.repo, e.number, e.target]), [['lib', 7, undefined], [undefined, 11, undefined]]);
    assert.ok(!('repo' in merged[1]), 'root events carry no repo');
  });

  test('a consumer before its dependency is refused, --now included', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    pin(p, j.id);
    for (const flags of [['--root'], ['--root', '--now'], ['--now', '--root']]) {
      const r = await p.pr(['merge', j.id, ...flags]);
      assert.equal(r.status, 1, `${flags}: ${r.stderr}`);
      const out = json(r);
      assert.deepEqual([out.merged, out.action, out.reason, out.repo], [false, 'refused', 'order', null], String(flags));
      assert.match(out.error, /depends on repo lib PR #7, which is not merged yet/);
    }
    assert.deepEqual(merges(p), [], 'no gh pr merge call');
    const refused = p.events(j.id).filter((e) => e.type === 'pr-merge-refused');
    assert.deepEqual(refused.map((e) => [e.reason, e.number, e.target, e.waitingFor]), Array(3).fill(['order', 11, true, 'repo lib PR #7']));
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'pr-merge-bypass'), [], '--now never bypasses order');

    // The reverse edge: lib depends on the root, so --repo lib waits for the open root PR.
    dependsOn(p, 'lib-on-app');
    const r = await p.pr(['merge', j.id, '--repo', 'lib', '--now']);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual([json(r).reason, json(r).repo], ['order', 'lib']);
    assert.match(json(r).error, /^repo lib PR #7 depends on the root PR #11, which is not merged yet/);
    assert.deepEqual(merges(p), []);
  });

  test('auto-merge is never queued on a consumer', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    // No protected paths, so a pending PR on a repo GitHub enforces is queued rather than held.
    p.config((c) => (c.policy = { ...(c.policy ?? {}), protectedPaths: [] }));
    const j = await opened(p);
    const heads = pin(p, j.id);
    p.fake('lib.checks', 'pending');
    p.fake('lib.mergestate', 'BLOCKED');
    let r = await p.pr(['merge', j.id]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual([json(r).action, json(r).repo, json(r).merged], ['auto', 'lib', false]);
    assert.deepEqual(merges(p), [`pr merge 7 -R o/lib --squash --auto --match-head-commit ${heads.lib}`], 'nothing for app');
    const row = async (id: string) => {
      const s = await p.raw(['sync'], p.env);
      assert.equal(s.status, 0, s.stderr);
      return json(s).results.find((x: any) => x.id === id);
    };
    assert.equal((await row(j.id)).mergeDeferred, false, 'lib has not merged yet');
    p.fake('lib.state', 'MERGED');
    assert.equal((await row(j.id)).mergeDeferred, true, 'GitHub merged lib: the walk continues');
    r = await p.pr(['merge', j.id]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual([json(r).merged, json(r).action, json(r).repo], [true, 'merged', null]);
    assert.equal(merges(p).length, 2);
    assert.match(merges(p)[1], /^pr merge 11 -R o\/app --squash --match-head-commit /);

    // A human's targeted merge never starts a continuation.
    const q = await prProject(cleanups);
    dependsOn(q, 'app-on-lib');
    const k = await opened(q);
    pin(q, k.id);
    assert.equal((await q.pr(['merge', k.id, '--repo', 'lib'])).status, 0);
    assert.deepEqual(merges(q).map((c) => c.split(' ').slice(2, 4).join(' ')), ['7 -R']);
    assert.equal(q.events(k.id).find((e) => e.type === 'pr-merged').target, true);
    const s = await q.raw(['sync'], q.env);
    assert.equal(json(s).results.find((x: any) => x.id === k.id).mergeDeferred, false);
  });

  test('merge order fails closed', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    pin(p, j.id);
    // lib's sync fails in this call, while job.json was hand-edited to say it merged.
    p.fake('lib.viewfail', '');
    const file = path.join(p.root, '.forge', 'jobs', j.id, 'job.json');
    const edit = (f: (job: any) => void) => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      f(raw);
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    };
    edit((x) => (x.repos[1].pr.state = 'MERGED'));
    let r = await p.pr(['merge', j.id]);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual([json(r).action, json(r).reason, json(r).repo], ['refused', 'order', null]);
    assert.match(json(r).error, /repo lib PR #7 \(state unknown\)/);
    p.fake('lib.viewfail', null);

    // A dependency member with no PR refuses its consumer.
    edit((x) => (x.repos[1].pr = null));
    p.fake('lib.pr', null);
    r = await p.pr(['merge', j.id, '--now']);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual([json(r).reason, json(r).error], ['order', 'the root PR #11 depends on repo lib (no PR), which is not merged yet; merge it first']);

    // A build cycle refuses every merge of the job.
    dependsOn(p, 'cycle');
    r = await p.pr(['merge', j.id, '--now']);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual([json(r).action, json(r).reason], ['refused', 'cycle']);
    assert.match(json(r).error, /dependsOn form a cycle between the root repo, repo lib/);
    assert.deepEqual(merges(p), [], 'no gh pr merge call');
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'pr-merge-refused').map((e) => e.reason), ['order', 'order', 'cycle']);
  });

  test('a member PR number off the job branch fails closed', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    pin(p, j.id);
    const failed = () => p.events(j.id).filter((e) => e.type === 'repo-pr-sync-failed').length;

    // job.json's lib number names a PR merged elsewhere, from another branch: it is not lib's PR.
    p.fake('lib.headref', 'someone-else');
    p.fake('lib.state', 'MERGED');
    let r = await p.pr(['merge', j.id, '--now']);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual([json(r).action, json(r).reason, json(r).repo], ['refused', 'order', null]);
    assert.match(json(r).error, /repo lib PR #7 \(state unknown\)/);
    assert.equal(failed(), 1);
    assert.notEqual(loadJob(p.root, j.id).repos[1].pr!.state, 'MERGED', 'the foreign state is not recorded');

    // An unrelated open PR on the job's branch name but another base is neither merged nor targeted.
    p.fake('lib.headref', null);
    p.fake('lib.state', null);
    p.fake('lib.baseref', 'release');
    r = await p.pr(['merge', j.id, '--repo', 'lib', '--now']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(failed(), 2);
    r = await p.pr(['merge', j.id, '--now']);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual([json(r).reason, json(r).repo], ['order', null]);
    assert.deepEqual(merges(p), [], 'no gh pr merge call');
  });

  test('member PRs get the same merge policy', async () => {
    const p = await prProject(cleanups);
    dependsOn(p, 'app-on-lib');
    const j = await opened(p);
    pin(p, j.id);
    p.fake('lib.state', 'CLOSED');
    let r = await p.pr(['merge', j.id]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /repo lib PR #7 is closed; reopen it before merging/);
    p.fake('lib.state', null);

    p.fake('lib.checks', 'failing');
    r = await p.pr(['merge', j.id]);
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual([json(r).action, json(r).repo, json(r).checks], ['refused', 'lib', 'failing']);
    p.fake('lib.checks', 'passing');

    // A member head forge pr open did not push: refused under protected paths, merged with --now.
    p.fake('lib.head', 'b'.repeat(40));
    r = await p.raw(['pr', 'merge', j.id, '--json'], p.env);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(json(r).error.code, 'protected_path');
    assert.match(json(r).error.message, /^repo lib PR #7's head bbbbbbbbbbbb is not the commit forge pr open checked/);
    assert.deepEqual(merges(p), []);
    r = await p.pr(['merge', j.id, '--now']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(json(r).merged, true);
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'pr-merge-bypass').map((e) => e.repo ?? null), ['lib', null]);
    assert.match(merges(p)[0], new RegExp(`^pr merge 7 -R o/lib --squash --match-head-commit ${'b'.repeat(40)}$`));
  });

  test('pr merge target flags are strict', async () => {
    const p = await prProject(cleanups);
    const j = await opened(p);
    const v = await ready(p, { verifyOnly: true });
    pin(p, j.id);
    const cases: [string[], RegExp][] = [
      [['merge', j.id, '--repo', 'nope'], new RegExp(`job ${j.id} has no member repo nope`)],
      [['merge', j.id, '--repo', '../lib'], /--repo needs one member repo name/],
      [['merge', j.id, '--repo', '--root'], /--repo needs one member repo name/],
      [['merge', j.id, '--repo', 'lib', '--root'], /pass --repo or --root, not both/],
      [['merge', '--root', j.id], /--root takes no value/],
      [['merge', v.id, '--repo', 'lib'], /repo lib is verify-only/],
    ];
    for (const [args, want] of cases) {
      const r = await p.pr(args);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, want, args.join(' '));
    }
    assert.deepEqual(merges(p), []);
  });
});

test('spliceSiblings replaces only the first marked section', () => {
  const S = SIBLINGS_START;
  const E = SIBLINGS_END;
  assert.equal(spliceSiblings(`a\n${S}\nold\n${E}\nb ${S}x${E}`, 'L'), `a\n${S}\nL\n${E}\nb ${S}x${E}`);
  assert.equal(spliceSiblings(`${E} then ${S}`, 'L'), null, 'an end before the start is no section');
  assert.equal(spliceSiblings('no markers', 'L'), null);
  assert.equal(spliceSiblings(`${S} only`, 'L'), null);
  // A long hostile body is spliced in one pass, the rest kept byte for byte.
  const junk = '<!-- forge:siblings'.repeat(5000) + '\u202e<script>x</script>';
  assert.equal(spliceSiblings(`${junk}${S}${E}${junk}`, 'L'), `${junk}${S}\nL\n${E}${junk}`);
});
