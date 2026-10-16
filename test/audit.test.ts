// `forge job audit` and `forge audit`: which events become rows, CSV escaping, and the period filter.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { csvCell, parseAuditDate } from '../lib/audit.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, repoAuditFile, updateJob } from '../lib/jobs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

const repo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

const ALICE = { login: 'alice', source: 'gh' };
const FOREMAN = { login: null, source: 'foreman' };
const at = (day: number, sec = 0) => `2026-03-${String(day).padStart(2, '0')}T10:00:${String(sec).padStart(2, '0')}.000Z`;
const run = (stage: string) => ({ stage, state: 'running', waitingOn: null });
const wait = (stage: string, waitingOn: string) => ({ stage, state: 'waiting', waitingOn });

/** A job whose events.jsonl is exactly `events`, plus an optional PR record. */
function seed(root: string, title: string, events: Record<string, unknown>[], pr?: number): string {
  const id = createJob(root, defaults(), { title }).id;
  fs.writeFileSync(path.join(jobDir(root, id), 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
  if (pr) updateJob(root, id, (j) => void (j.pr = { number: pr, url: `https://example.test/pr/${pr}`, state: 'MERGED', isDraft: false, lastSyncedAt: at(9) }));
  return id;
}

const ESCALATED = [
  { v: 2, ts: at(1, 0), type: 'created', title: 'x' },
  { v: 2, ts: at(1, 1), type: 'claimed', session: 's1' },
  { v: 2, ts: at(1, 2), type: 'agent-end', role: 'approver' },
  { v: 2, ts: at(1, 3), type: 'transition', from: run('decide'), to: wait('decide', 'escalation'), reason: 'auth code touched' },
  { v: 2, ts: at(1, 4), type: 'human', action: 'approve', note: 'reviewed the auth change', actor: ALICE },
  { v: 2, ts: at(1, 5), type: 'transition', from: wait('decide', 'escalation'), to: run('integrate') },
  { v: 2, ts: at(1, 6), type: 'budget-ack', keys: ['usd', 'tokens'], used: {}, actor: ALICE },
  { v: 1, ts: at(1, 7), type: 'human', action: 'rework', note: 'old foreman decision', actor: 'foreman' },
  { v: 2, ts: at(1, 8), type: 'pr-opened', number: 12, url: 'u' },
  { v: 2, ts: at(1, 9), type: 'pr-merged', number: 12, method: 'squash', checks: 'passing', bypass: false },
];

describe('audit', { concurrency: 4 }, () => {
  test('job audit json', async () => {
    const r = repo();
    try {
      const id = seed(r.dir, 'Escalated', ESCALATED, 12);
      const res = await forgeAsync(r.dir, ['job', 'audit', id]);
      assert.equal(res.status, 0, res.stderr);
      const a = JSON.parse(res.stdout);
      assert.deepEqual(await forgeAsync(r.dir, ['job', 'audit', id, '--json']).then((x) => JSON.parse(x.stdout)), a, '--json is the default');
      assert.equal(a.id, id);
      assert.equal(a.title, 'Escalated');
      assert.deepEqual(a.pr, { number: 12, mergeMethod: 'squash', merged: true });
      assert.deepEqual(
        a.rows.map((x: any) => [x.ts, x.job, x.actor, x.action, x.note, x.detail]),
        [
          [at(1, 3), id, null, 'gate:escalation', 'auth code touched', null],
          [at(1, 4), id, ALICE, 'approve', 'reviewed the auth change', null],
          [at(1, 5), id, null, 'gate-cleared:escalation', null, null],
          [at(1, 6), id, ALICE, 'budget-ack', null, 'usd,tokens'],
          [at(1, 7), id, FOREMAN, 'rework', 'old foreman decision', null],
          [at(1, 8), id, null, 'pr-opened', null, '#12'],
          [at(1, 9), id, null, 'pr-merged', null, '#12 squash'],
        ],
        'actor rows, gate transitions and the PR, in order; agent and plain claim events are left out',
      );
      const missing = await forgeAsync(r.dir, ['job', 'audit', 'no-such-job']);
      assert.equal(missing.status, 1);
    } finally {
      r.cleanup();
    }
  });

  test('csv escaping and formula guard', async () => {
    const r = repo();
    try {
      const notes = ['a, b', 'say "hi"', 'line one\nline two', '=HYPERLINK("x")', '+1', '-1', '@SUM(A1)'];
      const id = seed(r.dir, 'Csv', notes.map((note, i) => ({ v: 2, ts: at(2, i), type: 'human', action: 'answer', note, actor: { login: 'bob', source: 'env' } })));
      const res = await forgeAsync(r.dir, ['job', 'audit', id, '--csv']);
      assert.equal(res.status, 0, res.stderr);
      const out = res.stdout;
      assert.ok(out.startsWith('ts,job,actor,source,action,note,detail,pr,merge_method\r\n'), 'the exact header, CRLF');
      assert.ok(out.endsWith('\r\n'));
      const lines = out.split('\r\n').slice(1, -1);
      assert.equal(lines.length, notes.length, 'a newline inside a quoted field does not split the record');
      const cells = lines.map((l) => l.slice(`${at(2, 0)},${id},bob,env,answer,`.length).replace(/,,,$/, ''));
      assert.deepEqual(cells, ['"a, b"', '"say ""hi"""', '"line one\nline two"', `"'=HYPERLINK(""x"")"`, "'+1", "'-1", "'@SUM(A1)"]);
      for (const [v, want] of [['\tx', "'\tx"], ['\rx', `"'\rx"`], [null, ''], [12, '12'], ['plain', 'plain']] as const) assert.equal(csvCell(v), want, JSON.stringify(v));

      const both = await forgeAsync(r.dir, ['job', 'audit', id, '--json', '--csv']);
      assert.equal(both.status, 2, 'both formats is a usage error');
      assert.equal((await forgeAsync(r.dir, ['audit', '--since', '2026-01-01', '--csv', '--json'])).status, 2);
    } finally {
      r.cleanup();
    }
  });

  test('audit across jobs with date filter', async () => {
    const r = repo();
    try {
      const a = seed(r.dir, 'Alpha', ESCALATED, 12);
      const b = seed(r.dir, 'Beta', [
        { v: 2, ts: at(1, 4), type: 'budget-set', key: 'usd', value: 5, actor: { login: 'bob', source: 'env' } },
        { v: 2, ts: at(5), type: 'human', action: 'approve-spec', note: 'late', actor: ALICE },
      ]);
      fs.mkdirSync(path.dirname(repoAuditFile(r.dir)), { recursive: true });
      fs.writeFileSync(
        repoAuditFile(r.dir),
        [
          { v: 2, ts: at(1, 2), type: 'config-set', key: 'runtime.effort', previous: null, value: 'high', changed: true, actor: { login: 'carol', source: 'dashboard' } },
          { v: 2, ts: '2025-12-31T23:59:59.000Z', type: 'config-set', key: 'merge.auto', previous: false, value: true, changed: true, actor: ALICE },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n{broken\n',
      );
      const res = await forgeAsync(r.dir, ['audit', '--since', '2026-01-01', '--until', '2026-03-02']);
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.since, '2026-01-01T00:00:00.000Z');
      assert.equal(out.until, '2026-03-02T00:00:00.000Z');
      const [first, second] = [a, b].sort();
      assert.deepEqual(
        out.rows.map((x: any) => [x.ts, x.job, x.action]),
        [
          [at(1, 2), null, 'config-set'],
          [at(1, 3), a, 'gate:escalation'],
          [at(1, 4), first, first === a ? 'approve' : 'budget-set'],
          [at(1, 4), second, second === a ? 'approve' : 'budget-set'],
          [at(1, 5), a, 'gate-cleared:escalation'],
          [at(1, 6), a, 'budget-ack'],
          [at(1, 7), a, 'rework'],
          [at(1, 8), a, 'pr-opened'],
          [at(1, 9), a, 'pr-merged'],
        ],
        'every job and the repo log, in [since, until), by time then job id',
      );
      assert.equal(out.rows[0].detail, 'runtime.effort: null -> "high"');
      // until is exclusive and defaults to now.
      const open = JSON.parse((await forgeAsync(r.dir, ['audit', '--since', at(5)])).stdout);
      assert.deepEqual(open.rows.map((x: any) => x.note), ['late']);
      assert.equal((await forgeAsync(r.dir, ['audit', '--since', at(1, 2), '--until', at(5)])).stdout.includes('late'), false);

      const csv = await forgeAsync(r.dir, ['audit', '--since', '2026-01-01', '--until', '2026-03-02', '--csv']);
      assert.equal(csv.status, 0, csv.stderr);
      const lines = csv.stdout.split('\r\n');
      assert.equal(lines[1], `${at(1, 2)},,carol,dashboard,config-set,,"runtime.effort: null -> ""high""",,`, 'a repo row has no job and no PR');
      assert.ok(lines.some((l) => l.startsWith(`${at(1, 9)},${a},`) && l.endsWith(',12,squash')), "a job row carries its job's PR and merge method");

      for (const bad of [[], ['--since'], ['--since', 'yesterday'], ['--since', '2026-13-45'], ['--since', '2026-03-01T10:00'], ['--since', '2026-03-02', '--until', '2026-03-01'], ['--since', '2026-03-02', '--until', '2026-03-02'], ['--since', '2026-01-01', 'extra']])
        assert.equal((await forgeAsync(r.dir, ['audit', ...bad])).status, 2, bad.join(' '));
    } finally {
      r.cleanup();
    }
  });
});

test('parseAuditDate accepts a day or a full ISO timestamp', () => {
  assert.equal(parseAuditDate('2026-01-01', '--since'), '2026-01-01T00:00:00.000Z');
  assert.equal(parseAuditDate('2026-01-01T05:30:00+02:00', '--since'), '2026-01-01T03:30:00.000Z');
  assert.equal(parseAuditDate('2026-01-01T05:30:00.123Z', '--since'), '2026-01-01T05:30:00.123Z');
  for (const bad of ['', 'now', '2026-1-1', '2026-01-01 05:30', '2026-01-01T05:30:00', 'x'.repeat(10_000), true, undefined]) assert.throws(() => parseAuditDate(bad, '--since'), (e: any) => e.code === 'usage', String(bad));
});
