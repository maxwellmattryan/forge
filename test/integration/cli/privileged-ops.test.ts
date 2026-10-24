// The human-only operations against the session's own children: branch code a daemon session's
// `forge verify` runs can't merge past the checks or lift a spend cap, with or without the daemon's
// markers; `forge budget ack` refuses a period it could not grant before it asks for a person; and a
// daemon session whose scope is empty is refused by every scope-gated command.
// Spawned, one test per path; fakeGh goes in the child's env only. POSIX only, like pr.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BIN, fakeGh, forgeAsync, ghPr, tempRepo } from '../../helpers.ts';
import { TRUST_ENV, loadConfig, trustDigest } from '#core/config/load.ts';
import { createJob, jobDir, repoAuditFile, setJob } from '#core/job/store.ts';

const POSIX = { skip: process.platform === 'win32' };
const PRIVILEGED = ['pr-merge-bypass', 'pr-merged', 'budget-set', 'budget-ack'];

/**
 * A Forge-initialised scratch repo (tracker o/r, commands.test the branch's nested.sh) with one job at
 * PR #7. Its month cap is 0, so this month is always exceeded and `budget ack --period <month>` gets
 * as far as asking for a person; today stays within its $1000 day cap.
 */
async function scratch(name: string) {
  const repo = tempRepo();
  const base = path.basename(repo.dir);
  const answers = path.join(repo.dir, '..', `answers-${base}.json`);
  const budget = { usdPerMonth: 0, usdPerDay: 1000 };
  fs.writeFileSync(answers, JSON.stringify({ tracker: { github: { repo: 'o/r' } }, commands: { test: 'sh nested.sh' }, verify: ['test'], worktrees: { root: `../${base}.wt` }, budget }));
  const init = await forgeAsync(repo.dir, ['init', 'write', '--answers', answers]);
  fs.rmSync(answers, { force: true });
  assert.equal(init.status, 0, init.stderr);
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'forge init');
  const id = createJob(repo.dir, loadConfig(repo.dir).config, { title: name }).id;
  setJob(repo.dir, id, { owned: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } });
  const gh = fakeGh({ 'pr view': JSON.stringify(ghPr({ statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] })), 'api graphql': '{"data":{}}', 'pr merge': '' });
  const daemon = (scope: string) => ({ ...gh.env, FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(repo.dir), FORGE_DAEMON_SCOPE: scope });
  const file = (rel: string) => {
    const p = path.join(jobDir(repo.dir, id), rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  const cleanup = () => {
    fs.rmSync(gh.dir, { recursive: true, force: true });
    fs.rmSync(path.join(repo.dir, '..', `${base}.wt`), { recursive: true, force: true });
    repo.cleanup();
  };
  return { repo, id, gh, daemon, file, cleanup };
}

test("branch code run by forge verify can't merge --now or lift a budget", POSIX, async () => {
  const s = await scratch('privileged from branch code');
  try {
    const wt = JSON.parse((await forgeAsync(s.repo.dir, ['worktree', 'create', s.id], s.gh.env)).stdout).path as string;
    const month = new Date().toISOString().slice(0, 7);
    // The branch's test script: each nested call's exit and output, on the step's captured output.
    const call = (args: string) => `out=$("${process.execPath}" "${BIN}" ${args} --json 2>&1); echo "NESTED $? ${args} :: $out"`;
    const script = [call('pr merge "$FORGE_JOB" --now'), call('job budget "$FORGE_JOB" --set usd=1000000'), call('job budget "$FORGE_JOB" --ack'), call(`budget ack --period ${month}`)].join('\n');
    fs.writeFileSync(path.join(wt, 'nested.sh'), `${script}\n`);
    execFileSync('git', ['add', '-A'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'branch code'], { cwd: wt });
    assert.equal((await forgeAsync(s.repo.dir, ['job', 'round', s.id])).status, 0);
    // Verify's own checkpoint rewrites lastCheck; the limits and acks are what a person controls.
    const budget = () => {
      const { limits, ack } = JSON.parse(s.file('job.json')).budget;
      return { limits, ack };
    };
    const before = budget();
    for (const [name, env] of [
      ['daemon', s.daemon(s.id)],
      ['plain', s.gh.env],
    ] as const) {
      const r = await forgeAsync(s.repo.dir, ['verify', s.id], env);
      const steps = JSON.parse(r.stdout).steps as { name: string; log?: string }[];
      const log = steps.find((x) => x.name === 'test')?.log;
      assert.ok(log, `${name}: the test step ran (${r.stdout.slice(0, 400)})`);
      const text = fs.readFileSync(path.isAbsolute(log) ? log : path.join(jobDir(s.repo.dir, s.id), log), 'utf8');
      const nested = text.split('\n').filter((l) => l.startsWith('NESTED '));
      assert.equal(nested.length, 4, `${name}: ${text}`);
      for (const line of nested) assert.match(line, /^NESTED 1 .*human_only/, `${name}: ${line}`);
      assert.deepEqual(budget(), before, `${name}: budget.limits and budget.ack unchanged`);
    }
    assert.deepEqual(s.gh.calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge'), []);
    const types = s.file('events.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
    assert.deepEqual(types.filter((t) => PRIVILEGED.includes(t)), []);
    const audit = fs.existsSync(repoAuditFile(s.repo.dir)) ? fs.readFileSync(repoAuditFile(s.repo.dir), 'utf8') : '';
    assert.ok(!audit.includes('repo-budget-ack'), audit);
  } finally {
    s.cleanup();
  }
});

test('forge budget ack refuses a period it could not grant before asking for a person', POSIX, async () => {
  const s = await scratch('budget ack order');
  try {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const day = now.toISOString().slice(0, 10);
    const past = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const rows: [string, string, string, RegExp][] = [
      ['a past month', past, 'failed', /must be the current UTC month/],
      ['today, within its day cap', day, 'failed', /nothing to acknowledge/],
      ['this month, over its cap: the person is asked for, and there is none', month, 'human_only', /human-only operation/],
    ];
    for (const [name, period, code, message] of rows) {
      const r = await forgeAsync(s.repo.dir, ['budget', 'ack', '--period', period, '--json'], s.gh.env);
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      const { error } = JSON.parse(r.stdout);
      assert.equal(error.code, code, `${name}: ${error.message}`);
      assert.match(error.message, message, name);
    }
    const audit = fs.existsSync(repoAuditFile(s.repo.dir)) ? fs.readFileSync(repoAuditFile(s.repo.dir), 'utf8') : '';
    assert.ok(!audit.includes('repo-budget-ack'), audit);
  } finally {
    s.cleanup();
  }
});

test('an empty daemon scope is refused by every scope-gated command', POSIX, async () => {
  const s = await scratch('empty scope');
  try {
    const before = [s.file('job.json'), s.file('events.jsonl')];
    const env = s.daemon('');
    for (const args of [['pr', 'merge', s.id], ['job', 'set', s.id, '--state', 'queued'], ['job', 'human', s.id, 'approve', '--note', 'x'], ['requests', 'list']]) {
      const r = await forgeAsync(s.repo.dir, args, env);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}${r.stdout}`);
      assert.match(r.stderr + r.stdout, /FORGE_DAEMON_SCOPE is missing or invalid/, args.join(' '));
    }
    assert.deepEqual([s.file('job.json'), s.file('events.jsonl')], before);
    assert.deepEqual(s.gh.calls(), []);
  } finally {
    s.cleanup();
  }
});
