import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoTemplate } from './helpers.ts';
import { defaults } from '../lib/core/config/load.ts';
import { findRevertCommit, matchFollowUps, matchRevertPr, measureChurn, measureOutcome, outcomeDue } from '../lib/engine/evals/outcome.ts';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(T0 + days * DAY).toISOString();
const NO_FORGE = { shas: new Set<string>(), prNumbers: new Set<number>() };

const template = repoTemplate((dir) => {
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: at(-5), GIT_COMMITTER_DATE: at(-5) } });
});

/** A scratch repo whose commits carry the dates the test names. */
function scratch() {
  const r = template();
  const git = (env: Record<string, string>, ...args: string[]) => execFileSync('git', args, { cwd: r.dir, stdio: 'pipe', env: { ...process.env, ...env } }).toString().trim();
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(r.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(r.dir, file), body);
  };
  const dated = (days: number) => ({ GIT_AUTHOR_DATE: at(days), GIT_COMMITTER_DATE: at(days) });
  const commit = (msg: string, days: number) => {
    git({}, 'add', '-A');
    git(dated(days), 'commit', '-qm', msg);
    return git({}, 'rev-parse', 'HEAD');
  };
  const revert = (sha: string, days: number) => {
    git(dated(days), 'revert', '--no-edit', sha);
    return git({}, 'rev-parse', 'HEAD');
  };
  return { ...r, write, commit, revert };
}

/** A fake gh: one answer per `<cmd> <sub>`, null for a failing call; every call is recorded. */
function fakeGh(answers: Record<string, unknown>) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const a = answers[`${args[0]} ${args[1]}`];
    return a === null ? { ok: false, stdout: '' } : { ok: true, stdout: JSON.stringify(a ?? []) };
  };
  return { gh, calls };
}

function setup(kind: 'local' | 'github' = 'local') {
  const config = defaults();
  config.tracker.kind = kind;
  config.tracker.github.repo = 'o/r';
  config.pr.enabled = true;
  return config;
}

const job = (extra: Record<string, unknown> = {}) =>
  ({ id: 'j', kind: 'feature', base: 'main', issues: [], outcome: null, finishedAt: null, updatedAt: null, pr: { number: 7, state: 'MERGED', mergedAt: at(0) }, ...extra }) as any;

const view = (oid: string, title = 'Add a') => ({ 'pr view': { title, mergeCommit: { oid }, mergedAt: at(0) } });

describe('outcome: reverts', { concurrency: 4 }, () => {
  test('git revert trailer inside the window', () => {
    const r = scratch();
    try {
      r.write('a.txt', 'one\ntwo\n');
      const merge = r.commit('Add a (#7)', 0);
      const rev = r.revert(merge, 2);
      assert.equal(findRevertCommit(r.dir, 'refs/heads/main', merge, at(0), at(14)), rev);
      const { gh, calls } = fakeGh(view(merge));
      const o = measureOutcome(r.dir, setup(), job(), { gh, now: () => new Date(T0 + 20 * DAY), forge: NO_FORGE });
      assert.equal(o.reverted, true);
      assert.deepEqual(o.revertedBy, { kind: 'commit', sha: rev });
      assert.equal(o.mergeSha, merge);
      assert.equal(o.followUps, 'unsupported', 'a local tracker records unsupported, never 0');
      assert.equal(o.status, 'final');
      assert.equal(o.closesAt, at(14));
      assert.ok(!calls.some((c) => c[0] === 'pr' && c[1] === 'list'), 'the commit form wins: no revert PR lookup');
    } finally {
      r.cleanup();
    }
  });

  test('revert after the window is ignored', () => {
    const r = scratch();
    try {
      r.write('a.txt', 'one\ntwo\n');
      const merge = r.commit('Add a (#7)', 0);
      r.revert(merge, 20);
      assert.equal(findRevertCommit(r.dir, 'refs/heads/main', merge, at(0), at(14)), null);
      const { gh } = fakeGh(view(merge));
      const o = measureOutcome(r.dir, setup(), job(), { gh, now: () => new Date(T0 + 30 * DAY), forge: NO_FORGE });
      assert.equal(o.reverted, false);
      assert.equal(o.revertedBy, null);
    } finally {
      r.cleanup();
    }
  });

  test('GitHub revert PR by title', () => {
    const r = scratch();
    try {
      r.write('a.txt', 'one\ntwo\n');
      const merge = r.commit('Add a (#7)', 0);
      const { gh } = fakeGh({ ...view(merge), 'pr list': [{ number: 9, title: 'Revert "Add a"', body: '', mergedAt: at(1) }] });
      const o = measureOutcome(r.dir, setup(), job(), { gh, now: () => new Date(T0 + 20 * DAY), forge: NO_FORGE });
      assert.equal(o.reverted, true);
      assert.deepEqual(o.revertedBy, { kind: 'pr', number: 9 });
    } finally {
      r.cleanup();
    }
  });

  test('by body', () => {
    const q = { title: 'Add a', number: 7, slug: 'o/r', from: T0, to: T0 + 14 * DAY };
    assert.equal(matchRevertPr([{ number: 9, title: 'Undo it', body: 'Some text\r\nReverts O/R#7\n', mergedAt: at(1) }], q), 9);
    assert.equal(matchRevertPr([{ number: 9, title: 'Undo it', body: 'Reverts o/r#70', mergedAt: at(1) }], q), null);
    assert.equal(matchRevertPr([{ number: 9, title: 'Undo it', body: 'Reverts x/r#7', mergedAt: at(1) }], q), null);
    assert.equal(matchRevertPr([{ number: 9, title: 'Undo it', body: 'This Reverts o/r#7 too', mergedAt: at(1) }], q), null, 'a line of its own');
  });

  test('unmerged or other title ignored', () => {
    const q = { title: 'Add a', number: 7, slug: 'o/r', from: T0, to: T0 + 14 * DAY };
    const title = 'Revert "Add a"';
    assert.equal(matchRevertPr([{ number: 9, title, body: '', mergedAt: null }], q), null, 'open');
    assert.equal(matchRevertPr([{ number: 9, title, body: '', mergedAt: at(20) }], q), null, 'after the window');
    assert.equal(matchRevertPr([{ number: 9, title, body: '', mergedAt: at(-1) }], q), null, 'before the merge');
    assert.equal(matchRevertPr([{ number: 9, title: 'Revert "Add a extra"', body: '', mergedAt: at(1) }], q), null);
    assert.equal(matchRevertPr([{ number: 9, title: 'revert "Add a"', body: '', mergedAt: at(1) }], q), null);
    assert.equal(matchRevertPr([{ number: 7, title, body: '', mergedAt: at(1) }], q), null, 'the PR itself');
    assert.equal(matchRevertPr('nope', q), null);
    assert.equal(matchRevertPr([null, 3, { number: '9', title, mergedAt: at(1) }], q), null);
    assert.equal(matchRevertPr([{ number: 11, title, mergedAt: at(3) }, { number: 10, title, mergedAt: at(2) }], q), 10, 'the earliest revert');
  });
});

describe('outcome: follow-ups', { concurrency: 4 }, () => {
  const q = { slug: 'o/r', prNumber: 7, issues: ['o/r#5'], from: T0, to: T0 + 14 * DAY };
  const issue = (number: number, body: string, days = 1, title = 'Bug') => ({ number, url: `https://github.com/o/r/issues/${number}`, title, body, createdAt: at(days) });

  test('follow-up bug issue', () => {
    const r = scratch();
    try {
      r.write('a.txt', 'one\ntwo\n');
      const merge = r.commit('Add a (#7)', 0);
      const { gh, calls } = fakeGh({ ...view(merge), 'issue list': [issue(20, 'broke since #7.'), issue(21, 'see https://github.com/o/r/pull/7'), issue(22, 'nothing to see')] });
      const o = measureOutcome(r.dir, setup('github'), job(), { gh, now: () => new Date(T0 + 20 * DAY), forge: NO_FORGE });
      assert.equal(o.followUps, 2);
      assert.deepEqual(o.followUpRefs, ['o/r#20', 'o/r#21']);
      const list = calls.find((c) => c[0] === 'issue');
      assert.deepEqual(list, ['issue', 'list', '-R', 'o/r', '--state', 'all', '--label', 'bug', '--search', 'created:>=2026-10-01', '--json', 'number,url,title,body,createdAt', '--limit', '100']);
    } finally {
      r.cleanup();
    }
  });

  test('follow-up matching is word-bounded', () => {
    assert.deepEqual(matchFollowUps([issue(20, 'see #70'), issue(21, 'x#7 and a/#7'), issue(22, '#7', -1), issue(5, 'own issue cites #7')], q), []);
    assert.deepEqual(matchFollowUps([issue(23, 'O/R#7 broke'), issue(24, '', 1, '#7 regressed'), issue(25, '(#7)')], q), ['o/r#23', 'o/r#24', 'o/r#25']);
    assert.deepEqual(matchFollowUps([issue(26, 'from o/r#5'), issue(27, 'https://github.com/o/r/issues/5'), issue(28, 'bare #5'), issue(29, 'https://github.com/o/r/issues/50')], q), ['o/r#26', 'o/r#27', 'o/r#28']);
    const foreign = { ...q, issues: ['x/y#5'] };
    assert.deepEqual(matchFollowUps([issue(30, 'bare #5'), issue(31, 'x/y#5')], foreign), ['o/r#31'], 'a bare #m only for an issue in the same repo');
    assert.deepEqual(matchFollowUps([issue(32, 'a/o/r#7')], q), [], 'a slug inside a longer path is not a reference');
    const hostile = '#'.repeat(10_000) + 'o/r#'.repeat(2_500) + '/o/r/pull/'.repeat(1_000);
    const t = Date.now();
    assert.deepEqual(matchFollowUps([issue(33, hostile, 1, hostile)], q), []);
    assert.ok(Date.now() - t < 1000, 'a 10k-character hostile body is matched in linear time');
  });

  test('local tracker is unsupported', () => {
    const r = scratch();
    try {
      r.write('a.txt', 'one\ntwo\n');
      const merge = r.commit('Add a (#7)', 0);
      const local = fakeGh(view(merge));
      assert.equal(measureOutcome(r.dir, setup('local'), job(), { gh: local.gh, now: () => new Date(T0 + 20 * DAY), forge: NO_FORGE }).followUps, 'unsupported');
      assert.ok(!local.calls.some((c) => c[0] === 'issue'), 'no issue search off GitHub');
      const failing = fakeGh({ ...view(merge), 'issue list': null });
      const o = measureOutcome(r.dir, setup('github'), job(), { gh: failing.gh, now: () => new Date(T0 + 20 * DAY), forge: NO_FORGE });
      assert.equal(o.followUps, null, 'a failing gh records null');
      assert.equal(o.status, 'open', 'a null check keeps the outcome open for another attempt');
      assert.equal(o.attempts, 1);
    } finally {
      r.cleanup();
    }
  });
});

describe('outcome: churn and status', { concurrency: 4 }, () => {
  test('churn counts non-Forge commits on job files', () => {
    const r = scratch();
    try {
      r.write('a.txt', 'one\ntwo\n');
      r.write('b.txt', 'b\n');
      const merge = r.commit('Add a (#7)', 0);
      r.write('a.txt', 'one\ntwo\nthree\n');
      r.commit('human tweak', 1);
      r.write('a.txt', 'one\ntwo\nthree\nfour\n');
      r.commit('Another job (#9)', 2);
      r.write('a.txt', 'one\ntwo\nthree\nfour\nfive\n');
      r.commit('Merge pull request #9 from o/forge/x', 3);
      r.write('c.txt', 'c\n');
      r.commit('unrelated file', 4);
      r.write('b.txt', 'b\nb2\n');
      r.commit('too late', 20);
      const forge = { shas: new Set<string>(), prNumbers: new Set([9]) };
      assert.deepEqual(measureChurn(r.dir, 'refs/heads/main', merge, at(14), forge), { commits: 1, lines: 1, files: 1 });
      assert.deepEqual(measureChurn(r.dir, 'refs/heads/main', merge, at(14), NO_FORGE), { commits: 3, lines: 3, files: 1 }, 'without the Forge sets every commit counts');
      assert.equal(measureChurn(r.dir, 'refs/heads/main', 'f'.repeat(40), at(14), NO_FORGE), null);
    } finally {
      r.cleanup();
    }
  });

  test('open window then final', () => {
    const r = scratch();
    try {
      r.write('a.txt', 'one\ntwo\n');
      const merge = r.commit('Add a (#7)', 0);
      const { gh } = fakeGh(view(merge));
      const open = measureOutcome(r.dir, setup(), job(), { gh, now: () => new Date(T0 + DAY), forge: NO_FORGE });
      assert.equal(open.status, 'open');
      assert.equal(open.attempts, 0);
      assert.equal(outcomeDue(job({ outcome: open }), new Date(T0 + DAY + 3_600_000)), false, 'not again within a day');
      assert.equal(outcomeDue(job({ outcome: open }), new Date(T0 + 2 * DAY + 60_000)), true, 'again after a day');
      assert.equal(outcomeDue(job({ outcome: open }), new Date(T0 + 14 * DAY)), true, 'and once the window closes');
      const final = measureOutcome(r.dir, setup(), job({ outcome: open }), { gh, now: () => new Date(T0 + 15 * DAY), forge: NO_FORGE });
      assert.equal(final.status, 'final');
      assert.equal(outcomeDue(job({ outcome: final }), new Date(T0 + 100 * DAY)), false, 'a final outcome is never measured again');
      assert.equal(outcomeDue(job({ pr: { number: 7, state: 'OPEN' } }), new Date()), false);
      assert.equal(outcomeDue(job({ kind: 'eval' }), new Date()), false);
      assert.equal(outcomeDue(job(), new Date()), true, 'a merged job without an outcome is due');
    } finally {
      r.cleanup();
    }
  });

  test('missing merge commit retries then finalises', () => {
    const r = scratch();
    try {
      const { gh } = fakeGh(view('f'.repeat(40)));
      const config = setup();
      let j = job();
      const seen: [string, number][] = [];
      for (let i = 0; i < 3; i++) {
        const o = measureOutcome(r.dir, config, j, { gh, now: () => new Date(T0 + 20 * DAY), forge: NO_FORGE });
        seen.push([o.status, o.attempts]);
        assert.equal(o.reason, 'merge commit not found');
        assert.equal(o.reverted, null);
        assert.equal(o.churn, null);
        j = job({ outcome: o });
      }
      assert.deepEqual(seen, [['open', 1], ['open', 2], ['final', 3]]);
      const noTime = measureOutcome(r.dir, config, job({ pr: { number: 7, state: 'MERGED' }, finishedAt: at(0) }), { gh: fakeGh({ 'pr view': { title: 't', mergeCommit: null, mergedAt: null } }).gh, now: () => new Date(T0 + DAY), forge: NO_FORGE });
      assert.equal(noTime.reason, 'no merge time, no merge commit');
      assert.equal(noTime.mergedAt, at(0), 'the job finishing stands in for the merge time');
    } finally {
      r.cleanup();
    }
  });

  test('hostile title and paths are inert', () => {
    const r = scratch();
    try {
      const marker = path.join(r.dir, 'pwned');
      r.write(':(glob)**', 'magic\n');
      r.write('-n', 'dash\n');
      r.write('a.txt', 'one\ntwo\n');
      const merge = r.commit('Add hostile (#7)', 0);
      r.write('z.txt', 'z\n');
      r.commit('touches only z', 1);
      const hostile = `--upload-pack=touch ${marker}\n"Revert "x"`;
      const { gh, calls } = fakeGh({ 'pr view': { title: hostile, mergeCommit: { oid: merge }, mergedAt: at(0) }, 'pr list': [{ number: 9, title: `Revert "${hostile}"`, body: '', mergedAt: at(1) }] });
      const o = measureOutcome(r.dir, setup(), job(), { gh, now: () => new Date(T0 + 20 * DAY), forge: NO_FORGE });
      assert.deepEqual(o.revertedBy, { kind: 'pr', number: 9 }, 'a title with dashes, newlines and quotes still matches exactly');
      assert.deepEqual(o.churn, { commits: 0, lines: 0, files: 0 }, 'a :(glob) path is literal, so z.txt is not churn');
      assert.ok(!JSON.stringify(o).includes('upload-pack'), 'no GitHub text is stored');
      assert.ok(calls.every((c) => !c.some((a) => a.includes('upload-pack'))), 'no GitHub text reaches gh');
      for (const oid of ['--output=/tmp/x', `-${merge}`, 'HEAD']) {
        const bad = measureOutcome(r.dir, setup(), job(), { gh: fakeGh(view(oid)).gh, now: () => new Date(T0 + 20 * DAY), forge: NO_FORGE });
        assert.equal(bad.mergeSha, null, oid);
        assert.equal(bad.reason, 'no merge commit', oid);
      }
      const unsafe = measureOutcome(r.dir, setup(), job({ base: '-main' }), { gh, now: () => new Date(T0 + 20 * DAY), forge: NO_FORGE });
      assert.equal(unsafe.reason, 'unsafe base branch');
      assert.equal(unsafe.reverted, null);
      assert.equal(fs.existsSync(marker), false);
    } finally {
      r.cleanup();
    }
  });
});
