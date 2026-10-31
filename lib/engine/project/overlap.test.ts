// The overlap check over real git branches and the in-memory GitHub: no gh, PATH or env change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ghPr, jobAt, memoryGitHub, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { jobDir, listJobs } from '#core/job/store.ts';
import { overlap, overlapTiming } from './overlap.ts';
import type { TimingInput } from './overlap.ts';
import type { Config, OverlapCounterpart } from '#core/types.ts';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const now = () => NOW;
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const sha = (c: string) => c.repeat(40);

function makeConfig(over: (c: Config) => void = () => {}): Config {
  const c = defaults();
  c.tracker.github.repo = 'o/r';
  over(c);
  return c;
}
const config = makeConfig();

/** A repo whose main has lib/a.ts and lib/b.ts, 30 numbered lines each. */
function scenario() {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo.dir, 'lib'));
  const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  for (const f of ['lib/a.ts', 'lib/b.ts']) fs.writeFileSync(path.join(repo.dir, f), body);
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'base');
  /** A commit on `branch` (from main) changing `line` of `file`. */
  const edit = (branch: string, file: string, line: number) => {
    repo.git('checkout', '-q', '-b', branch, 'main');
    const f = path.join(repo.dir, file);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines[line - 1] = `changed on ${branch}`;
    fs.writeFileSync(f, lines.join('\n'));
    repo.git('commit', '-qam', `edit ${file}:${line}`);
    repo.git('checkout', '-q', 'main');
  };
  const job = (stage: Parameters<typeof jobAt>[1], title: string, opts: Parameters<typeof jobAt>[2] = {}) => jobAt(repo.dir, stage, { config, title, ...opts });
  const spec = (id: string, p: string) => fs.writeFileSync(path.join(jobDir(repo.dir, id), 'spec.md'), `# t\n\n## Approach\n\nFiles:\n| Path | Change |\n|---|---|\n| \`${p}\` | edit |\n`);
  return { root: repo.dir, git: repo.git, edit, job, spec, cleanup: repo.cleanup };
}

/** A one-hunk unified diff changing `line` of `file`, as gh prints it. */
const udiff = (file: string, line: number) => `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n@@ -${line} +${line} @@\n-old\n+new\n`;
const byRef = (cps: OverlapCounterpart[], ref: string) => cps.find((c) => c.ref === ref);

test('two jobs editing lib/a.ts report each other', () => {
  const s = scenario();
  try {
    const a = s.job('build', 'job a');
    const b = s.job('build', 'job b');
    const c = s.job('build', 'job c');
    s.edit(a.branch!, 'lib/a.ts', 5);
    s.edit(b.branch!, 'lib/a.ts', 5);
    s.edit(c.branch!, 'lib/a.ts', 25);
    const fromA = overlap(s.root, config, memoryGitHub(), { job: a.id }, { now }).report;
    const ab = byRef(fromA.counterparts, b.id);
    assert.deepEqual({ ...ab, sharedHunks: undefined }, { kind: 'job', ref: b.id, source: 'diff', human: false, stage: 'build', url: null, files: ['lib/a.ts'], sharedHunks: undefined });
    assert.deepEqual(ab?.sharedHunks, [{ path: 'lib/a.ts', start: 5, end: 5 }]);
    assert.deepEqual(byRef(fromA.counterparts, c.id)?.sharedHunks, []);
    assert.deepEqual(byRef(fromA.counterparts, c.id)?.files, ['lib/a.ts']);
    const fromB = overlap(s.root, config, memoryGitHub(), { job: b.id }, { now }).report;
    assert.deepEqual(byRef(fromB.counterparts, a.id)?.files, ['lib/a.ts']);
    assert.equal(fromB.subject.source, 'diff');
    assert.equal(fromB.timing.kind, 'merge-first');
  } finally {
    s.cleanup();
  }
});

test('a job at spec reports through its file map', () => {
  const s = scenario();
  try {
    const a = s.job('build', 'job a');
    s.edit(a.branch!, 'lib/a.ts', 5);
    const exact = s.job('spec', 'exact map');
    s.spec(exact.id, 'lib/a.ts');
    const dir = s.job('spec', 'dir map');
    s.spec(dir.id, 'lib/');
    const other = s.job('spec', 'other map');
    s.spec(other.id, 'docs/x.md');
    const bare = s.job('spec', 'nothing yet');
    const r = overlap(s.root, config, memoryGitHub(), { job: a.id }, { now }).report;
    for (const id of [exact.id, dir.id]) assert.deepEqual(byRef(r.counterparts, id), { kind: 'job', ref: id, source: 'file-map', human: false, stage: 'spec', url: null, files: ['lib/a.ts'], sharedHunks: [] }, id);
    assert.equal(byRef(r.counterparts, other.id), undefined);
    assert.equal(byRef(r.counterparts, bare.id), undefined);
    assert.deepEqual(r.gaps, [{ code: 'job-unread', ref: bare.id }]);
    assert.equal(r.timing.kind, 'merge-first');
    assert.deepEqual(r.reasons, ['job-early']);
    // The spec job as the subject: its file map against the branch's diff.
    const fromMap = overlap(s.root, config, memoryGitHub(), { job: dir.id }, { now }).report;
    assert.equal(fromMap.subject.source, 'file-map');
    assert.deepEqual(byRef(fromMap.counterparts, a.id)?.sharedHunks, []);
    assert.throws(() => overlap(s.root, config, memoryGitHub(), { job: bare.id }, { now }), (e: any) => e.code === 'failed' && /has no diff and no file map yet/.test(e.message));
  } finally {
    s.cleanup();
  }
});

test('merge-now and idle', () => {
  const docsPr = ghPr({
    number: 12,
    url: 'https://github.com/o/r/pull/12',
    headRefName: 'feature/docs',
    files: [{ path: 'docs/x.md' }],
    changedFiles: 1,
    createdAt: hoursAgo(30),
    commits: [{ oid: sha('c'), committedDate: hoursAgo(2), authors: [{ login: 'dev' }] }],
  });
  const rows: { name: string; setup: (s: ReturnType<typeof scenario>, gh: ReturnType<typeof memoryGitHub>) => { job: string } | { pr: number }; timing: string; idle: boolean }[] = [
    { name: 'nothing else in flight', setup: () => ({ pr: 12 }), timing: 'merge-now', idle: true },
    {
      name: 'another job in flight',
      setup: (s) => {
        const a = s.job('build', 'job a');
        s.edit(a.branch!, 'lib/a.ts', 5);
        return { pr: 12 };
      },
      timing: 'merge-now',
      idle: false,
    },
    {
      name: "a person's base commit in the window",
      setup: (_s, gh) => {
        gh.setHistory('main', [{ oid: sha('d'), committedDate: hoursAgo(1), author: { user: { login: 'dev' } }, associatedPullRequests: { nodes: [] } }]);
        gh.setCommitDiff(sha('d'), udiff('lib/b.ts', 3));
        return { pr: 12 };
      },
      timing: 'merge-now',
      idle: false,
    },
    {
      name: 'GitHub unread',
      setup: (s, gh) => {
        const a = s.job('build', 'job a');
        s.edit(a.branch!, 'lib/a.ts', 5);
        gh.fail('openPrs', 'gh: connection refused');
        return { job: a.id };
      },
      timing: 'needs-human',
      idle: false,
    },
  ];
  for (const row of rows) {
    const s = scenario();
    try {
      const gh = memoryGitHub();
      gh.put(docsPr);
      gh.setDiff(12, udiff('docs/x.md', 1));
      const r = overlap(s.root, config, gh, row.setup(s, gh), { now }).report;
      assert.equal(r.timing.kind, row.timing, row.name);
      assert.equal(r.idle, row.idle, row.name);
      assert.deepEqual(r.counterparts, [], row.name);
      assert.deepEqual(r.reasons, row.timing === 'merge-now' ? ['no-overlap'] : ['github-unread'], row.name);
    } finally {
      s.cleanup();
    }
  }
});

test('overlapTiming rows', () => {
  const old = '2026-10-01T00:00:00Z';
  const young = '2026-10-20T00:00:00Z';
  const subject = (ready: boolean, createdAt = young, ref = '#9') => ({ ref, ready, createdAt });
  const job = (ref: string, stage: any, ready: boolean, createdAt = old) => ({ kind: 'job' as const, ref, human: false, stage, ready, createdAt });
  const human = (kind: 'pr' | 'push', ref: string) => ({ kind, ref, human: true, stage: null, ready: true, createdAt: null });
  const rows: [string, TimingInput, string, string[], string[]][] = [
    ['a PR against a job in review', { githubUnread: false, subject: subject(true), counterparts: [job('j-review', 'review', true)] }, 'wait-for', ['j-review'], ['job-ahead']],
    ['a PR against a job at spec', { githubUnread: false, subject: subject(true), counterparts: [job('j-spec', 'spec', false)] }, 'merge-first', ['j-spec'], ['job-early']],
    ['a PR against a job at build', { githubUnread: false, subject: subject(true), counterparts: [job('j-build', 'build', false)] }, 'merge-first', ['j-build'], ['job-building']],
    ['an outside PR', { githubUnread: false, subject: subject(true), counterparts: [human('pr', '#4')] }, 'needs-human', ['#4'], ['outside-pr']],
    ["a person's base push", { githubUnread: false, subject: subject(true), counterparts: [human('push', 'main@abcdefabcdef')] }, 'needs-human', ['main@abcdefabcdef'], ['human-push']],
    ['GitHub unread', { githubUnread: true, subject: subject(true), counterparts: [] }, 'needs-human', [], ['github-unread']],
    ['GitHub unread with a job', { githubUnread: true, subject: subject(true), counterparts: [job('j-build', 'build', false)] }, 'needs-human', [], ['github-unread', 'job-building']],
    ['two ready jobs, from the younger', { githubUnread: false, subject: subject(true, young, 'j-young'), counterparts: [job('j-old', 'decide', true, old)] }, 'wait-for', ['j-old'], ['job-ahead']],
    ['two ready jobs, from the older', { githubUnread: false, subject: subject(true, old, 'j-old'), counterparts: [job('j-young', 'review', true, young)] }, 'merge-first', ['j-young'], ['job-behind']],
    ['equal ages break on ref', { githubUnread: false, subject: subject(true, old, 'j-b'), counterparts: [job('j-a', 'review', true, old)] }, 'wait-for', ['j-a'], ['job-ahead']],
    ['a ready job against a subject at spec', { githubUnread: false, subject: subject(false, old), counterparts: [job('j-pr', 'review', true, young)] }, 'wait-for', ['j-pr'], ['job-ahead']],
    [
      'every category present is named',
      { githubUnread: false, subject: subject(true), counterparts: [human('pr', '#4'), job('j-review', 'review', true), job('j-spec', 'plan', false)] },
      'needs-human',
      ['#4'],
      ['outside-pr', 'job-ahead', 'job-early'],
    ],
    ['nothing', { githubUnread: false, subject: subject(true), counterparts: [] }, 'merge-now', [], ['no-overlap']],
  ];
  for (const [name, input, kind, refs, reasons] of rows) assert.deepEqual(overlapTiming(input), { timing: { kind, refs }, reasons }, name);
});

test('a fork PR is read and reported, never checked out or adopted', () => {
  const s = scenario();
  try {
    const a = s.job('build', 'job a');
    const b = s.job('build', 'job b');
    s.edit(a.branch!, 'lib/a.ts', 5);
    s.edit(b.branch!, 'lib/b.ts', 5);
    const gh = memoryGitHub();
    // A fork whose head is named like job b's branch.
    gh.put(ghPr({ number: 30, url: 'https://github.com/fork/r/pull/30', isCrossRepository: true, headRefName: b.branch, files: [{ path: 'lib/a.ts' }], changedFiles: 1, createdAt: hoursAgo(5) }));
    gh.setDiff(30, udiff('lib/a.ts', 5));
    const refs = () => [s.git('for-each-ref').toString(), s.git('worktree', 'list', '--porcelain').toString().replaceAll(s.root, '<root>')];
    const before = refs();
    const prs = () => listJobs(s.root).map((j) => [j.id, j.pr]);
    const prsBefore = prs();
    const r = overlap(s.root, config, gh, { job: a.id }, { now }).report;
    assert.deepEqual(byRef(r.counterparts, '#30'), { kind: 'pr', ref: '#30', source: 'diff', human: true, stage: null, url: 'https://github.com/fork/r/pull/30', files: ['lib/a.ts'], sharedHunks: [{ path: 'lib/a.ts', start: 5, end: 5 }] });
    assert.equal(byRef(r.counterparts, b.id), undefined);
    assert.equal(r.timing.kind, 'needs-human');
    assert.deepEqual(r.timing.refs, ['#30']);
    const ops = new Set(gh.calls.map((c) => c.op));
    for (const op of ops) assert.ok(['require', 'repoSlug', 'openPrs', 'prDiff', 'branchHistory', 'commitDiff'].includes(op), op);
    assert.ok(ops.has('prDiff'));
    assert.deepEqual(refs(), before);
    assert.deepEqual(prs(), prsBefore);
  } finally {
    s.cleanup();
  }
});

test("Forge's commits are not human pushes", () => {
  const touchA = (gh: ReturnType<typeof memoryGitHub>, oid: string) => gh.setCommitDiff(oid, udiff('lib/a.ts', 5));
  const node = (oid: string, hours: number, pr: unknown = null) => ({ oid, committedDate: hoursAgo(hours), author: { user: { login: 'dev' } }, associatedPullRequests: { nodes: pr ? [pr] : [] } });
  const rows: { name: string; hours?: number; setup: (s: ReturnType<typeof scenario>, gh: ReturnType<typeof memoryGitHub>) => void; pushes: (s: ReturnType<typeof scenario>) => string[]; jobPr?: boolean }[] = [
    {
      name: "a base commit from a job's same-repo PR",
      setup: (s, gh) => {
        const done = s.job('done', 'merged job');
        gh.setHistory('main', [node(sha('1'), 1, { number: 3, headRefName: done.branch, isCrossRepository: false })]);
        touchA(gh, sha('1'));
      },
      pushes: () => [],
    },
    {
      name: "a base commit from a fork named like a job's branch",
      setup: (s, gh) => {
        const done = s.job('done', 'merged job');
        gh.setHistory('main', [node(sha('2'), 1, { number: 3, headRefName: done.branch, isCrossRepository: true })]);
        touchA(gh, sha('2'));
      },
      pushes: () => [`main@${sha('2').slice(0, 12)}`],
    },
    {
      name: 'a base commit already in the subject branch',
      setup: (s, gh) => {
        const head = s.git('rev-parse', 'main').toString().trim();
        gh.setHistory('main', [node(head, 1)]);
        touchA(gh, head);
      },
      pushes: () => [],
    },
    {
      name: 'a base commit 25 h old, 24 h window',
      setup: (_s, gh) => {
        gh.setHistory('main', [node(sha('3'), 25)]);
        touchA(gh, sha('3'));
      },
      pushes: () => [],
    },
    {
      name: 'a base commit 25 h old, 48 h window',
      hours: 48,
      setup: (_s, gh) => {
        gh.setHistory('main', [node(sha('3'), 25)]);
        touchA(gh, sha('3'));
      },
      pushes: () => [`main@${sha('3').slice(0, 12)}`],
    },
    {
      name: "a job's open PR is the job, and commits after its push are a person's",
      jobPr: true,
      setup: () => {},
      pushes: (s) => [`${listJobs(s.root).find((j) => j.title === 'job with pr')!.branch}@${sha('5').slice(0, 12)}`],
    },
  ];
  for (const row of rows) {
    const s = scenario();
    try {
      const a = s.job('build', 'job a');
      s.edit(a.branch!, 'lib/a.ts', 5);
      const gh = memoryGitHub();
      row.setup(s, gh);
      let withPr: string | null = null;
      if (row.jobPr) {
        const j = s.job('pr', 'job with pr', { pr: { number: 40, url: 'https://github.com/o/r/pull/40', state: 'OPEN', isDraft: false, lastSyncedAt: hoursAgo(3), pushedSha: sha('4') } });
        withPr = j.id;
        gh.put(
          ghPr({
            number: 40,
            headRefName: j.branch,
            files: [{ path: 'lib/a.ts' }],
            changedFiles: 1,
            createdAt: hoursAgo(10),
            commits: [
              { oid: sha('4'), committedDate: hoursAgo(3), authors: [{ login: 'forge' }] },
              { oid: sha('5'), committedDate: hoursAgo(1), authors: [{ login: 'dev' }] },
            ],
          }),
        );
        gh.setDiff(40, udiff('lib/a.ts', 9));
        touchA(gh, sha('5'));
      }
      const cfg = makeConfig((c) => (c.overlap.recentHours = row.hours ?? 24));
      const r = overlap(s.root, cfg, gh, { job: a.id }, { now }).report;
      const pushes = r.counterparts.filter((c) => c.kind === 'push');
      assert.deepEqual(pushes.map((c) => c.ref), row.pushes(s), row.name);
      for (const p of pushes) assert.ok(p.human && p.files.includes('lib/a.ts'), row.name);
      assert.equal(r.counterparts.filter((c) => c.kind === 'pr').length, 0, row.name);
      if (withPr) {
        assert.deepEqual(byRef(r.counterparts, withPr)?.source, 'diff', row.name);
        assert.equal(r.timing.kind, 'needs-human', row.name);
      }
      assert.equal(r.idle, !pushes.length && !withPr, row.name);
    } finally {
      s.cleanup();
    }
  }
});
