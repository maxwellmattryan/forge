import test from 'node:test';
import assert from 'node:assert/strict';
import { firstVerifyRun, headVerified, lastRun, lateFailure, nextAttempt, panelRun, recordRun, reportRun, restPending, roundRuns, runsSince, verifiedSha } from './record.ts';

const ROOT = 'a'.repeat(40);
const LIB = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

/** One verify run; `n` orders the `at` timestamps. */
const vr = (round: unknown, attempt: number, ok: unknown, n: number, extra: Record<string, unknown> = {}): any => ({
  round,
  attempt,
  sha: ROOT,
  ok,
  at: `2026-10-0${n}T00:00:00.000Z`,
  file: `verify/round-${round}.md`,
  failure: ok === true ? null : 'test',
  ...extra,
});
const job = (round: number, verifyRuns: unknown, extra: Record<string, unknown> = {}): any => ({ round, verifyRuns, verify: {}, verifyRetries: {}, repos: [{ repo: null }], ...extra });
const withLib = (round: number, verifyRuns: unknown): any => job(round, verifyRuns, { repos: [{ repo: null }, { repo: 'lib' }] });
const names = (runs: { round: unknown; attempt: number }[] | undefined) => runs?.map((r) => `${r.round}.${r.attempt}`);

test('verify record questions', () => {
  const mixed = [vr(1, 1, false, 1), vr(1, 2, true, 2), vr(2, 1, false, 3), null, 'junk', vr(2, 2, true, 4)];
  const vf3 = [vr(1, 1, true, 1), vr(1, 2, false, 2, { failure: 'verifiers', file: 'verify/round-1-verifiers.md' })];
  const member = [vr(1, 1, true, 1, { repos: [{ repo: 'lib', sha: LIB, ok: true, failure: null }] })];
  const rows: { name: string; got: () => unknown; want: unknown }[] = [
    { name: 'roundRuns: this round only, in order, skipping non-objects', got: () => names(roundRuns(job(2, mixed))), want: ['2.1', '2.2'] },
    { name: 'roundRuns: an explicit round', got: () => names(roundRuns(job(2, mixed), 1)), want: ['1.1', '1.2'] },
    { name: 'roundRuns: a round with no runs', got: () => roundRuns(job(3, mixed)), want: [] },
    { name: 'roundRuns: a non-array record reads as no runs', got: () => roundRuns(job(1, { 0: vr(1, 1, true, 1), length: 1 })), want: [] },
    { name: 'lastRun: this round\'s last run', got: () => names([lastRun(job(1, mixed))!]), want: ['1.2'] },
    { name: 'lastRun: a round with no runs', got: () => lastRun(job(3, mixed)), want: undefined },
    { name: 'lastRun: a VF3 verifiers run after a pass is the last run', got: () => lastRun(job(1, vf3))?.failure, want: 'verifiers' },
    { name: 'reportRun: skips a VF3 verifiers run after a pass', got: () => names([reportRun(job(1, vf3))!]), want: ['1.1'] },
    { name: 'reportRun: a round with no runs', got: () => reportRun(job(2, vf3)), want: undefined },
    { name: 'nextAttempt: this round\'s count plus one', got: () => nextAttempt(job(2, mixed)), want: 3 },
    { name: 'nextAttempt: a round with no runs', got: () => nextAttempt(job(3, mixed)), want: 1 },
    { name: 'nextAttempt: a non-array record', got: () => nextAttempt(job(1, 'runs')), want: 1 },
    { name: 'firstVerifyRun: round 1 attempt 1 failed', got: () => firstVerifyRun(job(2, mixed)), want: false },
    { name: 'firstVerifyRun: round 1 attempt 1 passed', got: () => firstVerifyRun(job(1, vf3)), want: true },
    { name: 'firstVerifyRun: no run, the legacy verify[1]', got: () => firstVerifyRun(job(1, [], { verify: { 1: 'PASS' } })), want: true },
    { name: 'firstVerifyRun: a non-array record, the legacy verify[1]', got: () => firstVerifyRun(job(1, {}, { verify: { 1: 'FAIL' } })), want: false },
    { name: 'firstVerifyRun: never verified', got: () => firstVerifyRun(job(1, [])), want: null },
    { name: 'runsSince: runs later than ts, any round', got: () => names(runsSince(job(1, mixed), '2026-10-02T00:00:00.000Z')), want: ['2.1', '2.2'] },
    { name: 'runsSince: null ts gives every run with an at', got: () => names(runsSince(job(1, [vr(1, 1, true, 1, { at: null }), vr(1, 2, true, 2)]), null)), want: ['1.2'] },
    { name: 'runsSince: undefined ts gives every run with an at', got: () => names(runsSince(job(1, [vr(1, 1, true, 1, { at: 7 }), vr(1, 2, true, 2)]), undefined)), want: ['1.2'] },
    { name: 'runsSince: a non-array record', got: () => runsSince(job(1, null), null), want: [] },
    { name: 'verifiedSha: the root sha of this round\'s passing last run', got: () => verifiedSha(job(2, mixed), null), want: ROOT },
    { name: 'verifiedSha: a member sha', got: () => verifiedSha(withLib(1, member), 'lib'), want: LIB },
    { name: 'verifiedSha: a member the run did not record', got: () => verifiedSha(withLib(1, member), 'app'), want: null },
    { name: 'verifiedSha: a failing last run', got: () => verifiedSha(job(1, [vr(1, 1, false, 1)]), null), want: null },
    { name: 'verifiedSha: a VF3 verifiers run after a pass', got: () => verifiedSha(job(1, vf3), null), want: null },
    { name: 'verifiedSha: a round with no runs', got: () => verifiedSha(job(3, mixed), null), want: null },
    {
      name: 'recordRun: a pass sets PASS and leaves the retries',
      got: () => {
        const j = job(1, [vr(1, 1, false, 1)], { verify: { 1: 'FAIL' }, verifyRetries: { 1: 1 } });
        recordRun(j, vr(1, 2, true, 2));
        return { verify: j.verify, retries: j.verifyRetries, runs: names(j.verifyRuns) };
      },
      want: { verify: { 1: 'PASS' }, retries: { 1: 1 }, runs: ['1.1', '1.2'] },
    },
    {
      name: 'recordRun: a failure sets FAIL and adds one retry',
      got: () => {
        const j = job(2, [vr(1, 1, true, 1)], { verify: { 1: 'PASS' }, verifyRetries: { 2: 1 } });
        recordRun(j, vr(2, 1, false, 2));
        return { verify: j.verify, retries: j.verifyRetries, runs: names(j.verifyRuns) };
      },
      want: { verify: { 1: 'PASS', 2: 'FAIL' }, retries: { 2: 2 }, runs: ['1.1', '2.1'] },
    },
    {
      name: 'recordRun: a partial pass leaves the legacy result alone',
      got: () => {
        const j = job(1, [], { verify: {} });
        recordRun(j, vr(1, 1, true, 1, { partial: true }));
        return { verify: j.verify, retries: j.verifyRetries, runs: names(j.verifyRuns) };
      },
      want: { verify: {}, retries: {}, runs: ['1.1'] },
    },
    {
      name: 'recordRun: a partial failure sets FAIL and adds one retry',
      got: () => {
        const j = job(1, []);
        recordRun(j, vr(1, 1, false, 1, { partial: true }));
        return { verify: j.verify, retries: j.verifyRetries };
      },
      want: { verify: { 1: 'FAIL' }, retries: { 1: 1 } },
    },
    {
      name: 'recordRun: a non-array record starts a new one',
      got: () => {
        const j = job(1, 'runs', { verify: null, verifyRetries: 3 });
        recordRun(j, vr(1, 1, false, 1));
        return { verify: j.verify, retries: j.verifyRetries, runs: names(j.verifyRuns) };
      },
      want: { verify: { 1: 'FAIL' }, retries: { 1: 1 }, runs: ['1.1'] },
    },
  ];
  for (const row of rows) assert.deepEqual(row.got(), row.want, row.name);
});

test('a partial run verifies nothing, and the full run after it answers', () => {
  const part = (round: number, attempt: number, ok: unknown, n: number, extra: Record<string, unknown> = {}) => vr(round, attempt, ok, n, { partial: true, ...extra });
  const late = [part(1, 1, true, 1), vr(1, 2, false, 2)];
  const finished = [part(1, 1, true, 1), vr(1, 2, true, 2)];
  const rows: { name: string; got: () => unknown; want: unknown }[] = [
    { name: 'verifiedSha: a partial pass', got: () => verifiedSha(job(1, [part(1, 1, true, 1)]), null), want: null },
    { name: 'verifiedSha: a partial pass with a member', got: () => verifiedSha(withLib(1, [part(1, 1, true, 1, { repos: [{ repo: 'lib', sha: LIB, ok: true, failure: null }] })]), 'lib'), want: null },
    { name: 'headVerified: a partial pass on the HEAD', got: () => headVerified(job(1, [part(1, 1, true, 1)]), { root: ROOT }).verified, want: false },
    { name: 'headVerified: the full pass after it', got: () => headVerified(job(1, finished), { root: ROOT }).verified, want: true },
    { name: "firstVerifyRun: round 1's partial pass, then a full failure", got: () => firstVerifyRun(job(1, late)), want: false },
    { name: "firstVerifyRun: round 1's partial pass, then a full pass", got: () => firstVerifyRun(job(1, finished)), want: true },
    { name: "firstVerifyRun: round 1's partial pass alone", got: () => firstVerifyRun(job(1, [part(1, 1, true, 1)])), want: null },
    { name: 'firstVerifyRun: a partial failure is a first failure', got: () => firstVerifyRun(job(1, [part(1, 1, false, 1)])), want: false },
    { name: 'restPending: a partial pass is last', got: () => restPending(job(1, [part(1, 1, true, 1)])), want: true },
    { name: 'restPending: a partial failure', got: () => restPending(job(1, [part(1, 1, false, 1)])), want: false },
    { name: 'restPending: the full run after it', got: () => restPending(job(1, finished)), want: false },
    { name: "restPending: an earlier round's partial pass", got: () => restPending(job(2, [part(1, 1, true, 1)])), want: false },
    { name: "restPending: partial: 'true'", got: () => restPending(job(1, [vr(1, 1, true, 1, { partial: 'true' })])), want: false },
    { name: 'lateFailure: a full failure right after a partial pass', got: () => lateFailure(job(1, late)), want: true },
    { name: 'lateFailure: a full pass', got: () => lateFailure(job(1, finished)), want: false },
    { name: 'lateFailure: a verifiers failure', got: () => lateFailure(job(1, [part(1, 1, true, 1), vr(1, 2, false, 2, { failure: 'verifiers' })])), want: false },
    { name: 'lateFailure: a failure after a full pass', got: () => lateFailure(job(1, [vr(1, 1, true, 1), vr(1, 2, false, 2)])), want: false },
    { name: 'lateFailure: a partial failure after a partial pass', got: () => lateFailure(job(1, [part(1, 1, true, 1), part(1, 2, false, 2)])), want: false },
    { name: "lateFailure: the partial pass was an earlier round's", got: () => lateFailure(job(2, [part(1, 1, true, 1), vr(2, 1, false, 2)])), want: false },
    { name: 'panelRun: the partial pass while the full run after it is last', got: () => names([panelRun(job(1, finished))!]), want: ['1.1'] },
    { name: 'panelRun: the partial pass after a late failure', got: () => names([panelRun(job(1, late))!]), want: ['1.1'] },
    { name: 'panelRun: the partial pass itself', got: () => names([panelRun(job(1, [part(1, 1, true, 1)]))!]), want: ['1.1'] },
    { name: 'panelRun: no partial run, the last run', got: () => names([panelRun(job(1, [vr(1, 1, false, 1), vr(1, 2, true, 2)]))!]), want: ['1.2'] },
    { name: 'panelRun: a round with no runs', got: () => panelRun(job(2, finished)), want: undefined },
  ];
  for (const row of rows) assert.deepEqual(row.got(), row.want, row.name);
});

test("a HEAD is verified only by this round's last passing run", () => {
  const pass = (extra: Record<string, unknown> = {}) => vr(2, 1, true, 2, extra);
  const both = { repos: [{ repo: 'lib', sha: LIB, ok: true, failure: null }] };
  const heads = { root: ROOT, repos: { lib: LIB } };
  const rows: { name: string; job: any; heads: { root: string; repos?: Record<string, string | null> }; want: boolean }[] = [
    { name: 'passes: root only', job: job(2, [vr(1, 1, false, 1), pass()]), heads: { root: ROOT }, want: true },
    { name: 'passes: root and member', job: withLib(2, [pass(both)]), heads, want: true },
    { name: "an earlier round's pass on the same HEAD", job: job(2, [vr(1, 1, true, 1)]), heads: { root: ROOT }, want: false },
    { name: 'a later failing run on the same sha', job: job(2, [pass(), vr(2, 2, false, 3, { failure: 'verifiers' })]), heads: { root: ROOT }, want: false },
    { name: "ok: 'yes'", job: job(2, [pass({ ok: 'yes' })]), heads: { root: ROOT }, want: false },
    { name: 'ok: 1', job: job(2, [pass({ ok: 1 })]), heads: { root: ROOT }, want: false },
    { name: 'a sha that is not a string', job: job(2, [pass({ sha: [ROOT] })]), heads: { root: ROOT }, want: false },
    { name: 'a null sha', job: job(2, [pass({ sha: null })]), heads: { root: 'null' }, want: false },
    { name: 'a sha that differs', job: job(2, [pass({ sha: OTHER })]), heads: { root: ROOT }, want: false },
    { name: 'a member with no repos[] entry', job: withLib(2, [pass()]), heads, want: false },
    { name: 'a run whose repos is not an array', job: withLib(2, [pass({ repos: { lib: { repo: 'lib', sha: LIB } } })]), heads, want: false },
    { name: 'a member with a different sha', job: withLib(2, [pass({ repos: [{ repo: 'lib', sha: OTHER, ok: true, failure: null }] })]), heads, want: false },
    { name: 'a member with a non-string sha', job: withLib(2, [pass({ repos: [{ repo: 'lib', sha: 7, ok: true, failure: null }] })]), heads: { root: ROOT, repos: { lib: '7' } }, want: false },
    { name: 'a member head of null (no trusted worktree)', job: withLib(2, [pass(both)]), heads: { root: ROOT, repos: { lib: null } }, want: false },
    { name: 'a member repo missing from heads.repos', job: withLib(2, [pass(both)]), heads: { root: ROOT, repos: {} }, want: false },
    { name: 'a member repo and no heads.repos at all', job: withLib(2, [pass(both)]), heads: { root: ROOT }, want: false },
    { name: 'a round stored as the string "2"', job: job(2, [vr('2', 1, true, 2)]), heads: { root: ROOT }, want: false },
    { name: 'a non-array record', job: job(2, { 0: pass() }), heads: { root: ROOT }, want: false },
    { name: 'a round with no runs', job: job(3, [pass()]), heads: { root: ROOT }, want: false },
  ];
  for (const row of rows) {
    let got: ReturnType<typeof headVerified> | undefined;
    assert.doesNotThrow(() => (got = headVerified(row.job, row.heads)), row.name);
    assert.equal(got!.verified, row.want, row.name);
    assert.equal(got!.last, lastRun(row.job) ?? null, `${row.name}: last is this round's last run`);
  }
});
