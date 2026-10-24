// The recorded decision bound to a head: old events never count, and a head follows the decided one
// only through clean merges of the base.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { loadJob, readEvents, updateJob } from '#core/job/store.ts';
import { jobFiles } from '#core/paths.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { EVENT_STEPS } from '#core/versions/event.ts';
import type { ForgeRequest, Job, JobEvent, VerifyRun } from '#core/types.ts';
import { FOREMAN_ACTOR } from '#integrations/github/actor.ts';
import { decisionCurrent, decisionEligible, decisionSuperseded, headFollows, lastDecision, reviewCurrent } from './eligible.ts';

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
    for (const f of jobFiles(repo.dir, id, 'events.jsonl')) fs.appendFileSync(f, `${JSON.stringify({ v, ts: new Date().toISOString(), type: 'decision', decision: 'APPROVE', reason: null })}\n`);
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
/** The job moves from stage `from` to `to` (review by default) at minute `n`; `state` is the state it lands in. */
const move = (n: number, from: string, to = 'review', state = 'running'): JobEvent => event('transition', n, { from: { stage: from, state: 'running', waitingOn: null }, to: { stage: to, state, waitingOn: null } });
const start = (n: number, role = 'reviewer:code'): JobEvent => event('agent-start', n, { role });

/** A round-1 verify run at minute `n`, on `sha`. */
const verifyRun = (sha: string | null, n: number, ok = true): VerifyRun => ({ round: 1, attempt: 1, sha, ok, at: ts(n), file: 'verify/round-1.md', failure: ok ? null : 'test' });

/** A round-1 job whose worktree is history()'s repo, on base main, with a passing verify run on `verified` before the scope event. */
function reviewedJob(dir: string, verified: string, more: (j: Job) => void = () => {}): Job {
  const id = jobAt(dir, 'decide').id;
  updateJob(dir, id, (j) => {
    j.worktree = dir;
    j.base = 'main';
    j.round = 1;
    j.verifyRuns = [verifyRun(verified, 0)];
    more(j);
  });
  return loadJob(dir, id);
}

test('decisionSuperseded: a rework, a later round or a stage change replaces the decision', () => {
  const person = { login: 'al', source: 'env' };
  const decided = (n: number) => event('decision', n, { decision: 'APPROVE', reason: null, autoMerge: true, head: 'a'.repeat(40) });
  const round = (n: number, r: unknown) => event('round', n, { round: r });
  const human = (n: number, action: string, actor: unknown = person, more: Record<string, unknown> = {}) => event('human', n, { action, actor, ...more });
  const atPr = { id: 'j1', stage: 'pr', state: 'waiting' } as const;
  const roundText = (n: string) => new RegExp(`^round ${n} started after the approver's decision; the approver decides again`);
  const reworkText = (action: string) => new RegExp(`^a ${action} was recorded after the approver's decision; the approver decides again`);
  const queuedText = (type: string) => new RegExp(`^a ${type} request for this job is waiting in the request inbox; once it is handled the approver decides again`);
  const endedText = (state: string) => new RegExp(`^the job was ${state} after the approver's decision: a human decides whether its PR merges$`);
  const asked = (type: string, status: string, job: string | null = 'j1'): Pick<ForgeRequest, 'job' | 'type' | 'status'> => ({ job, type, status }) as Pick<ForgeRequest, 'job' | 'type' | 'status'>;
  const gateText = /^a gate request for this job is waiting for the Foreman: it decides that gate first, or a human merges the PR$/;
  const changesText = /^a review on GitHub requests changes on this PR: a human merges it, or dismisses that review on GitHub once it is addressed$/;
  // job.pr as the caller's sync recorded it at the live head.
  const reviewed = (changesRequested: unknown) => ({ ...atPr, pr: { number: 7, changesRequested } as Job['pr'] });
  const rows: [string, Pick<Job, 'id' | 'stage' | 'state'> & Partial<Pick<Job, 'pr'>>, JobEvent[], RegExp | null, Pick<ForgeRequest, 'job' | 'type' | 'status'>[]?][] = [
    ['a decision while waiting', atPr, [decided(1)], null],
    ['a round, then a decision, while running', { ...atPr, state: 'running' }, [round(0, 1), decided(1)], null],
    ['a round after the decision', atPr, [decided(1), round(2, 2)], roundText('2')],
    ['a round with no usable number after the decision', atPr, [decided(1), round(2, 'two')], roundText('\\?')],
    ["a person's rework after the decision", atPr, [decided(1), human(2, 'rework')], reworkText('rework')],
    ["the foreman's CI rework after the decision", atPr, [decided(1), human(2, 'rework', FOREMAN_ACTOR, { ciHead: 'b'.repeat(40) })], reworkText('rework')],
    ['a revise-spec after the decision', atPr, [decided(1), human(2, 'revise-spec')], reworkText('revise-spec')],
    ['an approve after the decision', atPr, [decided(1), human(2, 'approve')], null],
    ['an answer after the decision', atPr, [decided(1), human(2, 'answer')], null],
    ['a rework before the decision', atPr, [human(0, 'rework'), decided(1)], null],
    ['the approver decided again after the rework and the new round', atPr, [round(0, 1), decided(1), human(2, 'rework'), round(3, 2), decided(4)], null],
    // Positions, not timestamps: a round logged after the decision with an earlier ts still supersedes it.
    ['a later round whose ts is older than the decision', atPr, [decided(5), round(1, 2)], roundText('2')],
    ['the job is at build', { ...atPr, stage: 'build', state: 'running' }, [decided(1)], /^the job is at stage build, not pr: a rework or another stage change replaced the approver's decision/],
    ['the job is cancelled at pr', { ...atPr, state: 'cancelled' }, [decided(1)], /^the job is cancelled: a human decides whether its PR merges$/],
    ['the job failed at pr', { ...atPr, state: 'failed' }, [decided(1)], /^the job is failed: a human decides whether its PR merges$/],
    ['no decision at all', atPr, [], null],
    // A cancel is a transition in the log: setting the job back to waiting does not undo it.
    ['cancelled after the decision, then set back to waiting at pr', atPr, [decided(1), move(2, 'pr', 'pr', 'cancelled'), move(3, 'pr', 'pr', 'waiting')], endedText('cancelled')],
    ['failed after the decision, then set back to waiting at pr', atPr, [decided(1), move(2, 'pr', 'pr', 'failed'), move(3, 'pr', 'pr', 'waiting')], endedText('failed')],
    ['cancelled before the decision', atPr, [move(0, 'pr', 'pr', 'cancelled'), move(1, 'pr', 'pr', 'waiting'), decided(2)], null],
    ['parked after the decision', atPr, [decided(1), move(2, 'pr', 'pr', 'waiting')], null],
    ['a cancel whose ts is older than the decision, logged after it', atPr, [decided(5), move(1, 'pr', 'pr', 'cancelled'), move(2, 'pr', 'pr', 'waiting')], endedText('cancelled')],
    // The request inbox: a rework a person queued from the dashboard has recorded nothing in the log yet.
    ['a rework request waiting', atPr, [decided(1)], queuedText('rework'), [asked('rework', 'pending')]],
    ['a rework request a session claimed and has not acked', atPr, [decided(1)], queuedText('rework'), [asked('rework', 'in-progress')]],
    ['a revise-spec request waiting', atPr, [decided(1)], queuedText('revise-spec'), [asked('revise-spec', 'pending')]],
    ['a cancel request waiting', atPr, [decided(1)], /^a cancel request for this job is waiting in the request inbox: a human decides whether its PR merges$/, [asked('cancel', 'pending')]],
    ['a rework request waiting and no decision yet', atPr, [], queuedText('rework'), [asked('rework', 'pending')]],
    ['a rework request already handled', atPr, [decided(1)], null, [asked('rework', 'done'), asked('rework', 'rejected')]],
    ["another job's rework request", atPr, [decided(1)], null, [asked('rework', 'pending', 'j2'), asked('rework', 'pending', null)]],
    ['a request that asks for no change of the work', atPr, [decided(1)], null, [asked('approve', 'pending'), asked('answer', 'pending'), asked('resume', 'pending')]],
    ['a handled request beside a waiting one', atPr, [decided(1)], queuedText('rework'), [asked('rework', 'done'), asked('rework', 'pending')]],
    // GitHub feedback that asks for changes: the Foreman's gate request, or a change request on the PR.
    ['a gate request waiting for the Foreman', atPr, [decided(1)], gateText, [asked('gate', 'pending')]],
    ['a gate request the office claimed and has not acked', atPr, [decided(1)], gateText, [asked('gate', 'in-progress')]],
    ['a gate request and no decision yet', atPr, [], gateText, [asked('gate', 'pending')]],
    ['a gate request already handled', atPr, [decided(1)], null, [asked('gate', 'done'), asked('gate', 'rejected')]],
    ["another job's gate request", atPr, [decided(1)], null, [asked('gate', 'pending', 'j2')]],
    ['a review requesting changes on the PR', reviewed(1), [decided(1)], changesText],
    ['two reviews requesting changes and no decision yet', reviewed(2), [], changesText],
    ['no review requesting changes', reviewed(0), [decided(1)], null],
    ['a PR record with no count', reviewed(undefined), [decided(1)], null],
  ];
  for (const [name, job, events, want, requests] of rows) {
    const got = decisionSuperseded(job, events, requests);
    if (want === null) assert.equal(got, null, name);
    else assert.match(got ?? '', want, name);
  }
  // A stage value from a hand-edited job.json is escaped and cut before it reaches the text.
  const odd = decisionSuperseded({ id: 'j1', stage: `x\n${'y'.repeat(100)}` as Job['stage'], state: 'running' }, []);
  assert.match(odd ?? '', /^the job is at stage x\\x0ay{35}, not pr/);
});

test("reviewCurrent binds HEAD to the head the round's review was given", () => {
  const h = history();
  try {
    const job = reviewedJob(h.repo.dir, h.D);
    const at = (ref: string) => h.repo.git('checkout', '-q', ref);
    // The verify run on D (minute 0), RV2's scope event on it (minute 1), then the round's verdicts once the panel ended.
    const recorded = (scopeHead: unknown, verdictsSha: unknown = scopeHead): JobEvent[] => [event('scope', 1, { round: 1, head: scopeHead }), event('verdicts', 5, { round: 1, outcome: 'PASS', sha: verdictsSha })];
    const outside = path.join(h.repo.dir, '..', `${path.basename(h.repo.dir)}-out`);
    const rows: [string, string, JobEvent[], boolean | null, VerifyRun[]?][] = [
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
      ['the first scope event after the verify anchors, not a later one', h.P, [event('scope', 1, { round: 1, head: h.D }), event('scope', 3, { round: 1, head: h.P }), event('verdicts', 5, { round: 1, sha: h.P })], false],
      ['no verdicts event this round', h.P, [event('scope', 1, { round: 1, head: h.D })], null],
      // A scope logged during build (before the verify) is not RV2's: the commit it names was never verified or reviewed.
      ['a scope logged before the round verify does not anchor', h.P, [event('scope', 1, { round: 1, head: h.P }), event('scope', 3, { round: 1, head: h.D }), event('verdicts', 5, { round: 1, sha: h.D })], false, [verifyRun(h.D, 2)]],
      ['a scope head that is not the verified head', h.D, recorded(h.D), false, [verifyRun(h.P, 0)]],
      ['the round has no verify run before the verdicts', h.D, recorded(h.D), false, []],
      ["the round's last verify before the verdicts failed", h.D, recorded(h.D), false, [verifyRun(h.D, 0, false)]],
      ['a verify run after the scope event with no scope after it', h.D, recorded(h.D), false, [verifyRun(h.D, 3)]],
      ["an earlier round's verify run does not answer", h.D, recorded(h.D), false, [{ ...verifyRun(h.D, 0), round: 0 }]],
    ];
    // The panel's first reviewer start since the round's `round` event bounds the anchor. A commit, a verify and RV2's fresh scope after it (RV2 fires again after any verify) are not what the reviewers were given.
    const scoped = (n: number, head: string) => event('scope', n, { round: 1, head });
    const verdicts = (sha: string) => event('verdicts', 5, { round: 1, outcome: 'PASS', sha });
    const opened = (n: number) => event('round', n, { round: 1 });
    rows.push(
      ['a commit, a verify and RV2\'s fresh scope after a reviewer started', h.P, [move(0, 'verify'), scoped(1, h.D), start(2), scoped(4, h.P), verdicts(h.P)], false, [verifyRun(h.D, 0), verifyRun(h.P, 3)]],
      ['the same with no entry into review in the log', h.P, [scoped(1, h.D), start(2), scoped(4, h.P), verdicts(h.P)], false, [verifyRun(h.D, 0), verifyRun(h.P, 3)]],
      ['reviewers started and one retried after the scope event', h.D, [move(0, 'verify'), scoped(1, h.D), start(2), start(2, 'reviewer:security'), start(3), verdicts(h.D)], true],
      ['clean base merges on the head the reviewers started on', h.M2, [move(0, 'verify'), scoped(1, h.D), start(2), start(3), verdicts(h.D)], true],
      ['a reviewer start from before review was entered', h.D, [start(0), opened(0), move(0, 'verify'), scoped(1, h.D), verdicts(h.D)], true],
      ['a park inside review is not the entry', h.P, [move(0, 'verify'), scoped(1, h.D), start(2), move(3, 'review', 'review', 'waiting'), scoped(4, h.P), verdicts(h.P)], false, [verifyRun(h.D, 0), verifyRun(h.P, 3)]],
      // `forge job set --stage verify` mid-panel, verify on P, back to review: no reviewer starts again, so the first panel's start still bounds the anchor.
      ['review left and entered again within the round', h.P, [opened(0), move(0, 'verify'), scoped(1, h.D), start(2), move(3, 'review', 'verify'), move(3, 'verify'), scoped(4, h.P), verdicts(h.P)], false, [verifyRun(h.D, 0), verifyRun(h.P, 3)]],
    );
    for (const [name, head, events, want, runs] of rows) {
      at(head);
      assert.equal(reviewCurrent(h.repo.dir, config, runs ? { ...job, verifyRuns: runs } : job, events), want, name);
    }
    assert.equal(fs.existsSync(outside), false, 'the option never reached git');

    at(h.P);
    const round2 = { ...job, round: 2 };
    assert.equal(reviewCurrent(h.repo.dir, config, round2, recorded(h.D)), null, "an earlier round's verdicts bind nothing");

    at(h.D);
    const withMember = reviewedJob(h.repo.dir, h.D, (j) => {
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
    // The round's own verify on D comes first (reviewedJob); the episode's runs come after the verdicts.
    const base = reviewedJob(h.repo.dir, h.D);
    const job = (runs: VerifyRun[]) => ({ ...base, verifyRuns: [...base.verifyRuns, ...runs] });
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
