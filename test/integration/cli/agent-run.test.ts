// `forge job agent run` against the stub claude (test/fixtures/bin/claude): the role child's command
// line, env, cwd and brief, its start and end records, the refusals that leave everything as it was,
// the race for one spawn, every failure class, unattended permission denies, resume and interrupts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { BIN, cliEnv, forgeAsync, forgeInProcess, jobAt, repoTemplate, waitFor, withLease } from '../../helpers.ts';
import { loadConfig, trustDigest } from '#core/config/load.ts';
import { jobFiles } from '#core/paths.ts';
import { loadJob, logEvent, readEvents, recordAgent } from '#core/job/store.ts';
import { writeRoots } from '#office/session/confine.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { UNATTENDED_DENIED } from '#integrations/claude/stream.ts';

const CLAUDE = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'bin', 'claude');
const S = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USAGE = { 'claude-haiku-4-5': { costUSD: 0.3, inputTokens: 150, outputTokens: 30, cacheReadInputTokens: 2500, cacheCreationInputTokens: 80 } };
const USAGE_TOKENS = 150 + 30 + 2500 + 80;

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: cliEnv(dir), stdio: 'pipe' });
  fs.rmSync(answers);
  const config = path.join(dir, '.forge', 'config.yml');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('  command: claude -p ', `  command: ${CLAUDE} -p `));
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

/** A scratch repo whose daemon.command runs the stub, with an empty transcripts dir and a log for the stub. */
function scratch(t: { after: (fn: () => void) => void }) {
  const repo = template();
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-'));
  t.after(() => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });
  const root = repo.dir;
  const fakeLog = path.join(root, '.git', 'fake-claude.log');
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ FAKE_CLAUDE_LOG: fakeLog, CLAUDE_CONFIG_DIR: claudeDir, ...extra });
  const records = (): any[] => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  /** A job at `stage` (default plan, where step spawns the planner), with a worktree and S's lease unless told otherwise. */
  const job = async (o: { stage?: Parameters<typeof jobAt>[1]; worktree?: boolean; lease?: string | null } = {}) => {
    const j = jobAt(root, o.stage ?? 'plan');
    if (o.worktree !== false) {
      const wt = await forgeInProcess(root, ['worktree', 'create', j.id]);
      assert.equal(wt.status, 0, JSON.stringify(wt.error));
    }
    if (o.lease !== null) withLease(root, j.id, o.lease ?? S);
    return { id: j.id, dir: path.join(root, '.forge', 'jobs', j.id) };
  };
  const stepOf = async (id: string) => (await forgeInProcess(root, ['job', 'step', id])).data as any;
  return { root, fakeLog, env, records, job, stepOf };
}

const stdinLines = (records: any[]) => records.filter((r) => typeof r.stdin === 'string').map((r) => JSON.parse(r.stdin));
const starts = (records: any[]) => records.filter((r) => Array.isArray(r.argv));

test('agent run runs a scripted role end to end', async (t) => {
  const s = scratch(t);
  const { id, dir } = await s.job();
  const step = await s.stepOf(id);
  assert.deepEqual([step.action, step.role], ['spawn', 'planner'], JSON.stringify(step));
  const config = loadConfig(s.root).config;
  const r = await forgeAsync(
    s.root,
    ['job', 'agent', 'run', id, '--session', S],
    s.env({
      FAKE_CLAUDE_WRITE: `${path.join(dir, 'plan.md')}=PLAN: SINGLE\n`,
      FAKE_CLAUDE_RESULT_TEXT: '\nPLAN: SINGLE · one job\nThe rest of the reply.',
      FAKE_CLAUDE_MODEL_USAGE: JSON.stringify(USAGE),
      // Built here, so no literal key-shaped value sits in the file.
      ANTHROPIC_API_KEY: ['not', 'a', 'key'].join('-'),
    }),
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  const [started] = starts(s.records());
  const sid = started.argv[started.argv.indexOf('--session-id') + 1];
  assert.deepEqual(
    { status: out.status, role: out.role, rule: out.rule, agentId: out.agentId, summary: out.summary, failure: out.failure, denied: out.denied, usage: out.usage, resumed: out.resumed },
    { status: 'done', role: 'planner', rule: 'P1', agentId: sid, summary: 'PLAN: SINGLE · one job', failure: null, denied: 0, usage: { tokens: USAGE_TOKENS, exact: true }, resumed: false },
  );
  assert.equal(out.log, path.join(s.root, '.forge', 'runtime', 'agents', id, `${sid}.log`));
  assert.ok(fs.readFileSync(out.log, 'utf8').includes('"type":"result"'), 'the run log has the result line');

  const j = loadJob(s.root, id);
  assert.deepEqual([j.agents.planner.status, j.agents.planner.agentId, j.agents.planner.summary], ['done', sid, 'PLAN: SINGLE · one job']);
  assert.deepEqual([j.usage.totalTokens, j.usage.exact], [USAGE_TOKENS, true]);
  const events = readEvents(s.root, id);
  const start = events.find((e) => e.type === 'agent-start');
  const end = events.find((e) => e.type === 'agent-end');
  assert.deepEqual([start?.role, start?.model, start?.output], ['planner', step.model, path.relative(dir, step.output)]);
  assert.deepEqual([end?.role, end?.status, end?.agentId], ['planner', 'done', sid]);

  // The child: cwd, argv and env as a job session's subagent is confined, and the brief as its one user line.
  const real = fs.realpathSync(s.root);
  assert.equal(fs.realpathSync(started.cwd), fs.realpathSync(loadJob(s.root, id).worktree!));
  const argv: string[] = started.argv;
  assert.deepEqual(argv.slice(0, 10), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--plugin-dir', PLUGIN_ROOT, '--agent', 'forge:planner']);
  assert.deepEqual(argv.slice(-4, -2)[0], '--disallowedTools');
  assert.deepEqual(argv.slice(-2), ['--permission-prompt-tool', 'stdio']);
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!argv.includes('--resume') && UUID_RE.test(sid));
  const deny = argv[argv.indexOf('--disallowedTools') + 1].split(',');
  assert.ok(deny.includes(`Edit(/${real}/.forge/config.yml)`), deny.join('\n'));
  assert.ok(!deny.includes('Edit(.forge/config.yml)') && deny.every((d) => d.startsWith('Edit(//')), 'absolute rules only');
  const roots = writeRoots(s.root, config);
  assert.ok(argv[argv.indexOf('--allowedTools') + 1].split(',').includes(`Edit(/${roots.worktrees[0]}/**)`), 'file tools scoped to the write roots');
  assert.deepEqual(started.env, {
    FORGE_DAEMON: '1',
    FORGE_MODE: 'agent',
    FORGE_DAEMON_SCOPE: id,
    FORGE_DAEMON_TRUST: trustDigest(s.root),
    FORGE_DAEMON_WRITE_ROOTS: JSON.stringify(roots),
    ANTHROPIC_API_KEY: false,
    ANTHROPIC_AUTH_TOKEN: false,
  });
  const lines = stdinLines(s.records());
  assert.equal(lines.length, 1, 'exactly one stdin line');
  assert.deepEqual([lines[0].type, lines[0].message.content[0].text], ['user', step.brief]);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('agent run refuses before anything is written', async (t) => {
  const s = scratch(t);
  const agentsDir = path.join(s.root, '.forge', 'runtime', 'agents');
  const snapshot = (id: string) => [...jobFiles(s.root, id, 'job.json'), ...jobFiles(s.root, id, 'events.jsonl')].map((f) => fs.readFileSync(f, 'utf8'));
  type Row = { name: string; setup?: () => Promise<{ id: string }>; args?: (id: string) => string[]; env?: (id: string) => NodeJS.ProcessEnv; status: number; code?: string; message?: RegExp };
  const plain = () => s.job();
  const config = path.join(s.root, '.forge', 'config.yml');
  const rows: Row[] = [
    { name: 'no --session', args: (id) => ['job', 'agent', 'run', id], status: 2, code: 'usage' },
    { name: 'a bad --spawn-index', args: (id) => ['job', 'agent', 'run', id, '--session', S, '--spawn-index', '-1'], status: 2, code: 'usage' },
    { name: 'a foreign live driver', setup: () => s.job({ lease: OTHER }), status: 3, code: 'owned', message: /being driven by session 2222/ },
    { name: 'unclaimed', setup: () => s.job({ lease: null }), status: 3, code: 'owned', message: /not claimed by session 1111.*forge job claim/ },
    { name: 'a stale --epoch', args: (id) => ['job', 'agent', 'run', id, '--session', S, '--epoch', '7'], status: 3, code: 'stale_epoch' },
    { name: 'an index past the list', args: (id) => ['job', 'agent', 'run', id, '--session', S, '--spawn-index', '1'], status: 1, code: 'stale_step', message: /returns spawn \(P1\) for planner with 1 spawn/ },
    {
      name: 'a wait action',
      setup: async () => {
        const j = await s.job();
        recordAgent(s.root, j.id, { role: 'planner', phase: 'start' }, loadConfig(s.root).config);
        return j;
      },
      status: 1,
      code: 'stale_step',
      message: /returns wait/,
    },
    { name: 'a run action', setup: () => s.job({ stage: 'backlog', worktree: false }), status: 1, code: 'stale_step', message: /returns run/ },
    { name: 'a done action', setup: () => s.job({ stage: 'done', worktree: false }), status: 1, code: 'stale_step', message: /returns done/ },
    { name: 'a missing worktree', setup: () => s.job({ worktree: false }), status: 1, message: /has no worktree/ },
    {
      name: 'a mismatched trust digest under FORGE_DAEMON=1',
      env: (id) => ({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: id, FORGE_DAEMON_TRUST: '0'.repeat(64) }),
      status: 1,
      message: /FORGE_DAEMON_TRUST is not the digest/,
    },
    {
      name: 'a daemon.command problem',
      setup: async () => {
        const j = await s.job();
        fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(`  command: ${CLAUDE} -p `, '  command: bash -p '));
        return j;
      },
      status: 1,
      message: /daemon\.command must run claude/,
    },
  ];
  for (const row of rows) {
    const { id } = row.setup ? await row.setup() : await plain();
    const before = snapshot(id);
    const r = await forgeInProcess(s.root, row.args?.(id) ?? ['job', 'agent', 'run', id, '--session', S], { env: s.env(row.env?.(id)) });
    assert.equal(r.status, row.status, `${row.name}: ${JSON.stringify(r.error)}`);
    if (row.code) assert.equal(r.error?.code, row.code, row.name);
    if (row.message) assert.match(r.error?.message ?? '', row.message, row.name);
    assert.deepEqual(snapshot(id), before, `${row.name}: job.json and events.jsonl unchanged`);
    assert.equal(fs.existsSync(agentsDir), false, `${row.name}: no run log`);
    assert.equal(fs.existsSync(s.fakeLog), false, `${row.name}: no child started`);
  }
});

test('agent run starts a spawn once', async (t) => {
  const s = scratch(t);
  const { id, dir } = await s.job();
  const env = s.env({ FAKE_CLAUDE_WRITE: `${path.join(dir, 'plan.md')}=PLAN: SINGLE\n`, FAKE_CLAUDE_DELAY_MS: '300' });
  const [a, b] = await Promise.all([forgeAsync(s.root, ['job', 'agent', 'run', id, '--session', S], env), forgeAsync(s.root, ['job', 'agent', 'run', id, '--session', S], env)]);
  const results = [a, b].sort((x, y) => (x.status ?? 9) - (y.status ?? 9));
  assert.deepEqual(
    results.map((r) => r.status),
    [0, 1],
    results.map((r) => r.stderr + r.stdout).join('\n'),
  );
  assert.match(results[1].stderr, /forge job step returns .*nothing was started/, 'the loser: stale_step');
  assert.equal(starts(s.records()).length, 1, 'one child');
  assert.equal(readEvents(s.root, id).filter((e) => e.type === 'agent-start').length, 1, 'one agent-start');
});

test('agent run classifies every failure', async (t) => {
  const s = scratch(t);
  const config = path.join(s.root, '.forge', 'config.yml');
  type Row = { name: string; env?: (dir: string) => NodeJS.ProcessEnv; before?: () => void; status: number; class: string | null; check?: (out: any, dir: string, id: string) => void };
  const write = (dir: string) => ({ FAKE_CLAUDE_WRITE: `${path.join(dir, 'plan.md')}=PLAN: SINGLE\n` });
  const rows: Row[] = [
    {
      name: 'limit',
      env: () => ({ FAKE_CLAUDE_RATE_LIMIT: '2000000000', FAKE_CLAUDE_RESULT_ERROR: 'boom' }),
      status: 1,
      class: 'limit',
      check: (out) => assert.equal(out.failure.resetsAt, new Date(2_000_000_000_000).toISOString()),
    },
    { name: 'auth', env: () => ({ FAKE_CLAUDE_RESULT_ERROR: 'OAuth token has expired · Please run /login' }), status: 1, class: 'auth' },
    { name: 'error', env: () => ({ FAKE_CLAUDE_RESULT_ERROR: 'the tool crashed' }), status: 1, class: 'error' },
    { name: 'exit', env: () => ({ FAKE_CLAUDE_EXIT: '1' }), status: 5, class: 'exit' },
    {
      name: 'an unattended prompt is denied, and the role still ends done',
      env: (dir) => ({ ...write(dir), FAKE_CLAUDE_ASK: 'cp a b' }),
      status: 0,
      class: null,
      check: (out) => {
        assert.equal(out.denied, 1);
        const answer = stdinLines(s.records()).find((l) => l.type === 'control_response');
        assert.deepEqual(answer?.response?.response, { behavior: 'deny', message: UNATTENDED_DENIED });
        const logged = fs.readFileSync(out.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        assert.ok(logged.some((l) => l.type === 'forge-permission' && l.decision === 'deny' && l.why === 'unattended'), 'the run log has the deny');
      },
    },
    {
      name: 'untrusted',
      env: (dir) => ({ ...write(dir), FAKE_CLAUDE_WRITE: `${config}=${fs.readFileSync(config, 'utf8')}\n# changed by the role\n` }),
      status: 1,
      class: 'untrusted',
      check: () => execFileSync('git', ['checkout', '--', '.forge/config.yml'], { cwd: s.root }),
    },
    {
      name: 'spawn',
      before: () => fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace(`  command: ${CLAUDE} -p `, `  command: ${path.join(os.tmpdir(), `forge-missing-${crypto.randomUUID()}`, 'claude')} -p `)),
      status: 5,
      class: 'spawn',
    },
  ];
  for (const row of rows) {
    if (fs.existsSync(s.fakeLog)) fs.rmSync(s.fakeLog);
    const { id, dir } = await s.job();
    row.before?.();
    const r = await forgeInProcess(s.root, ['job', 'agent', 'run', id, '--session', S], { env: s.env(row.env?.(dir)) });
    assert.equal(r.status, row.status, `${row.name}: ${JSON.stringify(r.error ?? r.data)}`);
    const out = r.data as any;
    const planner = loadJob(s.root, id).agents.planner;
    if (row.class === null) {
      assert.deepEqual([out.status, out.failure, planner.status], ['done', null, 'done'], row.name);
    } else {
      assert.deepEqual([out.status, out.failure.class, planner.status], ['failed', row.class, 'failed'], row.name);
      assert.ok(out.summary.startsWith(`${row.class}: `) && planner.summary?.startsWith(`${row.class}: `), `${row.name}: ${out.summary}`);
      const next = await s.stepOf(id);
      assert.deepEqual([next.action, next.rule, next.role], ['spawn', 'L1', 'planner'], `${row.name}: the L1 respawn`);
    }
    row.check?.(out, dir, id);
  }
});

/** A job at spec whose spec-writer asked and was answered, so step resumes it (N2) with `agentId`. */
async function answered(s: ReturnType<typeof scratch>, agentId: string) {
  const j = await s.job({ stage: 'spec' });
  const config = loadConfig(s.root).config;
  recordAgent(s.root, j.id, { role: 'spec-writer', phase: 'start', agentId }, config);
  recordAgent(s.root, j.id, { role: 'spec-writer', phase: 'end', agentId, summary: 'SPEC: NEEDS-INPUT · 1 question' }, config);
  fs.writeFileSync(path.join(j.dir, 'questions.md'), '1. Which way?\n');
  // The answer must come strictly after the end, to the millisecond.
  await new Promise((r) => setTimeout(r, 5));
  logEvent(s.root, j.id, 'human', { action: 'answer', note: 'this way' });
  const step = await s.stepOf(j.id);
  assert.deepEqual([step.action, step.rule, step.role, step.resume], ['spawn', 'N2', 'spec-writer', agentId], JSON.stringify(step));
  return j;
}

test('agent run resumes, and falls back to a fresh session', async (t) => {
  const s = scratch(t);
  const old = crypto.randomUUID();
  const j = await answered(s, old);
  // The cumulative its last run left: this run counts only what came after it.
  const sidecar = path.join(s.root, '.forge', 'runtime', 'agents', j.id, `${old}.json`);
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, JSON.stringify({ v: 1, cum: { usd: 0.1, models: { 'claude-haiku-4-5': { usd: 0.1, input: 100, output: 10, cacheRead: 1000, cacheWrite: 50 } } }, at: new Date().toISOString() }));
  const env = (dir: string, extra: NodeJS.ProcessEnv = {}) => s.env({ FAKE_CLAUDE_WRITE: `${path.join(dir, 'spec.md')}=# Spec\n`, FAKE_CLAUDE_MODEL_USAGE: JSON.stringify(USAGE), ...extra });
  const r = await forgeInProcess(s.root, ['job', 'agent', 'run', j.id, '--session', S], { env: env(j.dir) });
  assert.equal(r.status, 0, JSON.stringify(r.error ?? r.data));
  const out = r.data as any;
  const [argv] = starts(s.records()).map((x) => x.argv as string[]);
  assert.equal(argv[argv.indexOf('--resume') + 1], old);
  assert.ok(!argv.includes('--session-id'), 'no --session-id on a resume');
  assert.deepEqual([out.resumed, out.resumeFailed, out.agentId, out.usage], [true, undefined, old, { tokens: 50 + 20 + 1500 + 30, exact: true }]);
  assert.equal(loadJob(s.root, j.id).usage.totalTokens, 1600, 'the new cumulative less the baseline');
  assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).cum.models['claude-haiku-4-5'].input, 150, 'the sidecar holds the new cumulative');

  fs.rmSync(s.fakeLog);
  const gone = crypto.randomUUID();
  const k = await answered(s, gone);
  const r2 = await forgeInProcess(s.root, ['job', 'agent', 'run', k.id, '--session', S], { env: env(k.dir, { FAKE_CLAUDE_MISSING: '1' }) });
  assert.equal(r2.status, 0, JSON.stringify(r2.error ?? r2.data));
  const out2 = r2.data as any;
  const launches = starts(s.records()).map((x) => x.argv as string[]);
  assert.equal(launches.length, 2, 'the resume, then once more');
  assert.equal(launches[0][launches[0].indexOf('--resume') + 1], gone);
  const fresh = launches[1][launches[1].indexOf('--session-id') + 1];
  assert.ok(UUID_RE.test(fresh) && fresh !== gone && !launches[1].includes('--resume'));
  assert.deepEqual([out2.resumeFailed, out2.resumed, out2.agentId, out2.usage], [true, false, fresh, { tokens: USAGE_TOKENS, exact: true }]);
  assert.equal(loadJob(s.root, k.id).agents['spec-writer'].agentId, fresh);
});

test('agent run stops its child when interrupted', async (t) => {
  const s = scratch(t);
  const { id } = await s.job();
  const proc = spawn(process.execPath, [BIN, 'job', 'agent', 'run', id, '--session', S], { cwd: s.root, env: cliEnv(s.root, s.env({ FAKE_CLAUDE_NO_RESULT: '1' })), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  proc.stdout.on('data', (d) => (stdout += d));
  const exited = new Promise<number | null>((resolve) => proc.on('close', (code) => resolve(code)));
  const started = await waitFor(() => starts(s.records())[0], { what: 'the child to start' });
  await waitFor(() => stdinLines(s.records()).length === 1, { what: 'the brief to arrive' });
  proc.kill('SIGTERM');
  assert.equal(await exited, 1, stdout);
  await waitFor(
    () => {
      try {
        process.kill(started.pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    { timeoutMs: 5000, what: "the child's pid to be gone" },
  );
  const out = JSON.parse(stdout);
  assert.equal(out.failure.class, 'interrupted');
  const planner = loadJob(s.root, id).agents.planner;
  assert.equal(planner.status, 'failed');
  assert.match(planner.summary ?? '', /^interrupted: /);
});
