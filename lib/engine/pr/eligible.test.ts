// The recorded decision bound to a head: old events never count, and a head follows the decided one
// only through clean merges of the base.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { jobDir, loadJob, readEvents, updateJob } from '#core/job/store.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { EVENT_STEPS } from '#core/versions/event.ts';
import type { Job, JobEvent, VerifyRun } from '#core/types.ts';
import { decisionCurrent, decisionEligible, headFollows, lastDecision, reviewCurrent } from './eligible.ts';

const config = defaults();

/** A repo whose branches hold each shape of head on top of the decided commit D (base: main). */
function history() {
  const repo = tempRepo();
  const rev = (r: string) => repo.git('rev-parse', r).toString().trim();
  const write = (f: string, text = `${f}\n`) => fs.writeFileSync(path.join(repo.dir, f), text);
  const commit = (f: string, msg = f) => {
    write(f);
    repo.git('add', '-A');
    repo.git('commit', '-qm', msg);
    return rev('HEAD');
  };
  const on = (branch: string, from: string) => repo.git('checkout', '-q', '-b', branch, from);
  const mergeMain = () => {
    repo.git('merge', '-q', '--no-ff', '--no-edit', 'main');
    return rev('HEAD');
  };
  on('feat', 'main');
  const D = commit('feature.txt');
  repo.git('checkout', '-q', 'main');
  commit('base1.txt');
  on('clean', D);
  const M1 = mergeMain();
  repo.git('checkout', '-q', 'main');
  commit('base2.txt');
  repo.git('checkout', '-q', 'clean');
  const M2 = mergeMain();
  on('plain', D);
  const P = commit('after.txt');
  on('evil', D);
  repo.git('merge', '-q', '--no-ff', '--no-commit', 'main');
  write('extra.txt', 'rides in the merge\n');
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'merge main');
  const E = rev('HEAD');
  on('side', D);
  const S = commit('side.txt');
  on('sidemerge', D);
  repo.git('merge', '-q', '--no-ff', '--no-edit', 'side');
  const SM = rev('HEAD');
  void S;
  on('rebased', D);
  repo.git('rebase', '-q', 'main');
  const R = rev('HEAD');
  repo.git('checkout', '-q', 'main');
  return { repo, D, M1, M2, P, E, SM, R, tree: rev(`${D}^{tree}`) };
}

test('headFollows: only the decided head or clean base merges on it', () => {
  const h = history();
  try {
    const base = { base: 'main' };
    const rows: [string, string, boolean][] = [
      ['the decided head itself', h.D, true],
      ['one clean base merge', h.M1, true],
      ['a chain of two clean base merges', h.M2, true],
      ['a plain commit after the decision', h.P, false],
      ["a merge whose tree differs from git's own (an evil merge)", h.E, false],
      ['a merge whose second parent is not on the base', h.SM, false],
      ['a rewritten (rebased) head', h.R, false],
      ['a head that is not a commit (a tree)', h.tree, false],
      ['a non-hex value', '--output=/tmp/x', false],
      ['a ref name', 'main', false],
    ];
    for (const [name, head, want] of rows) assert.equal(headFollows(h.repo.dir, config, base, h.D, head), want, name);
    assert.equal(headFollows(h.repo.dir, config, base, null, h.D), false, 'no decided head');
  } finally {
    h.repo.cleanup();
  }
});

test("headFollows: a merge whose tree is git's own conflict-marker output is not a clean merge", () => {
  const repo = tempRepo();
  try {
    const rev = (r: string) => repo.git('rev-parse', r).toString().trim();
    const edit = (text: string) => {
      fs.writeFileSync(path.join(repo.dir, 'c.txt'), text);
      repo.git('add', '-A');
      repo.git('commit', '-qm', text);
    };
    edit('base\n');
    repo.git('checkout', '-q', '-b', 'feat');
    edit('feat\n');
    const decided = rev('HEAD');
    repo.git('checkout', '-q', 'main');
    edit('main\n');
    let out = '';
    try {
      repo.git('merge-tree', '--write-tree', '--no-messages', decided, 'main');
    } catch (e) {
      // Exit 1: the merge conflicts, and the tree with its markers is still written.
      out = String((e as { stdout: Buffer }).stdout);
    }
    const tree = out.split('\n')[0].trim();
    assert.match(tree, /^[0-9a-f]{40}$/);
    const merge = repo.git('commit-tree', tree, '-p', decided, '-p', rev('main'), '-m', 'merge').toString().trim();
    assert.equal(headFollows(repo.dir, config, { base: 'main' }, decided, merge), false);
  } finally {
    repo.cleanup();
  }
});

test("a v3 events file's APPROVE is not eligible", () => {
  const repo = tempRepo();
  try {
    const id = jobAt(repo.dir, 'pr').id;
    // The version before decision-head bound decisions to a head.
    const v = EVENT_STEPS.findIndex((s) => s.id === 'decision-head') + 1;
    fs.appendFileSync(path.join(jobDir(repo.dir, id), 'events.jsonl'), `${JSON.stringify({ v, ts: new Date().toISOString(), type: 'decision', decision: 'APPROVE', reason: null })}\n`);
    const events = readEvents(repo.dir, id);
    const d = events.findLast((e) => e.type === 'decision')!;
    assert.equal(d.v, EVENT_SCHEMA_VERSION);
    assert.equal(decisionEligible(lastDecision(events)), false);
    assert.deepEqual(lastDecision(events), { decision: 'APPROVE', autoMerge: false, head: null, heads: {} });
  } finally {
    repo.cleanup();
  }
});

test("decisionCurrent reads every job repo's HEAD", () => {
  const h = history();
  try {
    const id = jobAt(h.repo.dir, 'pr').id;
    updateJob(h.repo.dir, id, (j) => {
      j.worktree = h.repo.dir;
      j.base = 'main';
    });
    const job = () => loadJob(h.repo.dir, id);
    const decision = (fields: Record<string, unknown>): JobEvent[] => [{ v: EVENT_SCHEMA_VERSION, ts: new Date().toISOString(), type: 'decision', decision: 'APPROVE', reason: null, autoMerge: true, head: h.D, ...fields }];
    const at = (branch: string) => h.repo.git('checkout', '-q', branch);
    at('feat');
    assert.equal(decisionCurrent(h.repo.dir, config, job(), decision({})), true, 'HEAD is the decided head');
    at('clean');
    assert.equal(decisionCurrent(h.repo.dir, config, job(), decision({})), true, 'HEAD follows it by clean base merges');
    at('plain');
    assert.equal(decisionCurrent(h.repo.dir, config, job(), decision({})), false, 'a further commit');
    at('feat');
    assert.equal(decisionCurrent(h.repo.dir, config, job(), decision({ autoMerge: false })), false, 'the decision is not eligible');
  } finally {
    h.repo.cleanup();
  }
});

/** Minute n on a fixed day, so events and verify runs order as the log would. */
const ts = (n: number) => `2026-10-01T10:${String(n).padStart(2, '0')}:00.000Z`;
const event = (type: string, n: number, fields: Record<string, unknown> = {}): JobEvent => ({ v: EVENT_SCHEMA_VERSION, ts: ts(n), type, ...fields });
const leave = (n: number, to: string): JobEvent => event('transition', n, { from: { stage: 'integrate', state: 'running', waitingOn: null }, to: { stage: to, state: 'running', waitingOn: null } });

/** A round-1 job whose worktree is history()'s repo, on base main. */
function reviewedJob(dir: string, more: (j: Job) => void = () => {}): Job {
  const id = jobAt(dir, 'decide').id;
  updateJob(dir, id, (j) => {
    j.worktree = dir;
    j.base = 'main';
    j.round = 1;
    more(j);
  });
  return loadJob(dir, id);
}

test("reviewCurrent binds HEAD to the head the round's review was given", () => {
  const h = history();
  try {
    const job = reviewedJob(h.repo.dir);
    const at = (ref: string) => h.repo.git('checkout', '-q', ref);
    // RV2's scope event on the reviewed head, then the round's verdicts once the panel ended.
    const recorded = (scopeHead: unknown, verdictsSha: unknown = scopeHead): JobEvent[] => [event('scope', 1, { round: 1, head: scopeHead }), event('verdicts', 5, { round: 1, outcome: 'PASS', sha: verdictsSha })];
    const outside = path.join(h.repo.dir, '..', `${path.basename(h.repo.dir)}-out`);
    const rows: [string, string, JobEvent[], boolean | null][] = [
      ['HEAD is the scope head', h.D, recorded(h.D), true],
      ['one clean base merge on it', h.M1, recorded(h.D), true],
      ['two clean base merges on it', h.M2, recorded(h.D), true],
      ['a plain commit after review', h.P, recorded(h.D), false],
      ['a commit during the panel (inside the verdicts sha)', h.P, recorded(h.D, h.P), false],
      ['an evil merge', h.E, recorded(h.D), false],
      ['a merge of a non-base branch', h.SM, recorded(h.D), false],
      ['a rebased head', h.R, recorded(h.D), false],
      ['a scope head that is an option', h.D, recorded(`--output=${outside}`, h.D), false],
      ['a scope head that is a ref expression', h.M1, recorded('HEAD~1', h.D), false],
      ['a verdicts event with no scope event before it', h.D, [event('verdicts', 5, { round: 1, sha: h.D }), event('scope', 6, { round: 1, head: h.D })], false],
      ['the first scope event anchors, not a later one', h.P, [event('scope', 1, { round: 1, head: h.D }), event('scope', 3, { round: 1, head: h.P }), event('verdicts', 5, { round: 1, sha: h.P })], false],
      ['no verdicts event this round', h.P, [event('scope', 1, { round: 1, head: h.D })], null],
    ];
    for (const [name, head, events, want] of rows) {
      at(head);
      assert.equal(reviewCurrent(h.repo.dir, config, job, events), want, name);
    }
    assert.equal(fs.existsSync(outside), false, 'the option never reached git');

    at(h.P);
    const round2 = { ...job, round: 2 };
    assert.equal(reviewCurrent(h.repo.dir, config, round2, recorded(h.D)), null, "an earlier round's verdicts bind nothing");

    at(h.D);
    const withMember = reviewedJob(h.repo.dir, (j) => {
      j.repos = [j.repos[0], { repo: 'lib', worktree: null, branch: 'forge/x', base: 'main', pr: null, verifyOnly: false, interim: null }] as Job['repos'];
    });
    assert.equal(reviewCurrent(h.repo.dir, config, withMember, [event('scope', 1, { round: 1, head: h.D, heads: { lib: h.D } }), event('verdicts', 5, { round: 1, sha: h.D })]), false, 'a reviewed member with no trusted worktree');
  } finally {
    h.repo.cleanup();
  }
});

test('reviewCurrent: an integrate episode moves the anchor only from a reviewed start', () => {
  const h = history();
  try {
    const rev = (r: string) => h.repo.git('rev-parse', r).toString().trim();
    // A conflict-style resolution: a merge of main into D whose tree is not git's own merge.
    h.repo.git('checkout', '-q', '-b', 'episode', h.D);
    h.repo.git('merge', '-q', '--no-ff', '--no-commit', 'main');
    fs.writeFileSync(path.join(h.repo.dir, 'resolved.txt'), 'resolved\n');
    h.repo.git('add', '-A');
    h.repo.git('commit', '-qm', 'merge main, conflicts resolved');
    const M = rev('HEAD');
    fs.writeFileSync(path.join(h.repo.dir, 'late.txt'), 'late\n');
    h.repo.git('add', '-A');
    h.repo.git('commit', '-qm', 'a commit after the episode');
    const L = rev('HEAD');
    const upstream = rev('main');
    const run = (ok: boolean, sha = M): VerifyRun => ({ round: 1, attempt: 2, sha, ok, at: ts(12), file: 'verify/round-1.md', failure: ok ? null : 'test' });
    const base = reviewedJob(h.repo.dir);
    const job = (runs: VerifyRun[]) => ({ ...base, verifyRuns: runs });
    const episode = (start: string, to = 'decide'): JobEvent[] => [
      event('scope', 1, { round: 1, head: h.D }),
      event('verdicts', 5, { round: 1, outcome: 'PASS', sha: h.D }),
      event('integrate-conflicts', 10, { strategy: 'merge', conflicts: ['a.ts'], behind: 1, head: start, upstream }),
      leave(15, to),
    ];
    const rows: [string, string, VerifyRun[], JobEvent[], boolean][] = [
      ['the episode starts on the reviewed head and HEAD is what its verify checked', M, [run(true)], episode(h.D), true],
      ['a commit on top of the episode head', L, [run(true)], episode(h.D), false],
      ['the episode started on a commit after review', M, [run(true)], episode(h.P), false],
      ["the episode's last verify failed", M, [run(true), { ...run(false), at: ts(13) }], episode(h.D), false],
      ['the episode left integrate for build', M, [run(true)], episode(h.D, 'build'), false],
    ];
    for (const [name, head, runs, events, want] of rows) {
      h.repo.git('checkout', '-q', head);
      assert.equal(reviewCurrent(h.repo.dir, config, job(runs), events), want, name);
    }
  } finally {
    h.repo.cleanup();
  }
});
