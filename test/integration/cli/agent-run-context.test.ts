// `forge job agent run` with context sessions, against the stub claude (test/fixtures/bin/claude): a panel forks one
// context per agent and model, forks keep their context's agent, every cold fallback and its reason, and staleness.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, cliEnv, forgeAsync, forgeInProcess, jobAt, repoTemplate, waitFor, withLease } from '../../helpers.ts';
import { loadJob, logEvent, readEvents, updateJob } from '#core/job/store.ts';

const CLAUDE = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'bin', 'claude');
const S = '11111111-1111-4111-8111-111111111111';
const LENSES = ['code', 'tests', 'docs', 'security'];
/** What a context child's result reports, and a fork's: its cumulative carries the context's on every field. */
const CTX_USAGE = { 'claude-sonnet-4-5': { costUSD: 0.1, inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 1000, cacheCreationInputTokens: 500 } };
const FORK_USAGE = { 'claude-sonnet-4-5': { costUSD: 0.3, inputTokens: 150, outputTokens: 30, cacheReadInputTokens: 2500, cacheCreationInputTokens: 580 } };
const CTX_TOKENS = 100 + 10 + 1000 + 500;
const FORK_TOKENS = 150 + 30 + 2500 + 580;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Three lenses on sonnet and security on opus, every one always on: one panel, two keys.
const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: cliEnv(dir), stdio: 'pipe' });
  fs.rmSync(answers);
  const config = path.join(dir, '.forge', 'config.yml');
  const panel = LENSES.map((name) => `    - name: ${name}\n      always: true\n      model: ${name === 'security' ? 'opus' : 'sonnet'}\n`).join('');
  const text = fs.readFileSync(config, 'utf8').replace('  command: claude -p ', `  command: ${CLAUDE} -p `).replace(/^ {2}panel:\n(?: {4}.*\n)+/m, `  panel:\n${panel}`);
  assert.ok(text.includes('      model: opus\n'), 'the panel block was replaced');
  fs.writeFileSync(config, text);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

interface Child {
  pid: number;
  argv: string[];
  brief: string | null;
}

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
  /** Every child the stub started, with its argv and its first user message. */
  const children = (): Child[] => {
    if (!fs.existsSync(fakeLog)) return [];
    const by = new Map<number, Child>();
    for (const r of fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
      if (Array.isArray(r.argv)) by.set(r.pid, { pid: r.pid, argv: r.argv, brief: null });
      else if (typeof r.stdin === 'string') {
        const c = by.get(r.pid);
        const msg = JSON.parse(r.stdin);
        if (c && c.brief === null && msg.type === 'user') c.brief = msg.message.content[0].text;
      }
    }
    return [...by.values()];
  };
  /** A job in round 1 of review with its panel picked, its scope written and the round's shared inputs on disk. */
  const inReview = async () => {
    const j = jobAt(root, 'review');
    const wt = await forgeInProcess(root, ['worktree', 'create', j.id]);
    assert.equal(wt.status, 0, JSON.stringify(wt.error));
    withLease(root, j.id, S);
    const dir = path.join(root, '.forge', 'jobs', j.id);
    updateJob(root, j.id, (x) => {
      x.round = 1;
      x.reviewers = [...LENSES];
      x.verifyRuns = [{ round: 1, attempt: 1, sha: null, ok: true, at: new Date(Date.now() - 60_000).toISOString(), file: 'verify/round-1.md' }];
    });
    for (const [rel, text] of [['spec.md', '# Spec\n'], ['build.md', '## Round 1\n'], ['scope.md', '# Scope\n'], ['verify/round-1.md', 'PASS\n'], ['review/round-1/diff.patch', 'diff --git a/x b/x\n']]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    logEvent(root, j.id, 'round', { round: 1 });
    logEvent(root, j.id, 'panel', { round: 1 });
    logEvent(root, j.id, 'scope', { round: 1 });
    return { id: j.id, dir };
  };
  const stepOf = async (id: string) => (await forgeInProcess(root, ['job', 'step', id])).data as any;
  const run = async (id: string, extra: NodeJS.ProcessEnv = {}, args: string[] = []) => {
    const r = await forgeInProcess(root, ['job', 'agent', 'run', id, '--session', S, ...args], { env: env(extra) });
    assert.ok(r.status === 0 || r.status === 1, JSON.stringify(r.error ?? r.data));
    return r.data as any;
  };
  return { root, fakeLog, env, children, inReview, stepOf, run };
}

const flag = (argv: string[], name: string): string | null => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const isContext = (c: Child) => Boolean(c.brief?.split('\n').some((l) => l.startsWith('Role: context session · ')));
const ends = (root: string, id: string): any[] => readEvents(root, id).filter((e) => e.type === 'agent-end');

test('a panel forks one context session per agent and model', async (t) => {
  const s = scratch(t);
  const { id, dir } = await s.inReview();
  const first = await s.stepOf(id);
  assert.deepEqual([first.rule, first.role, (first.spawns ?? []).map((x: any) => x.role)], ['RV4', 'reviewer:code', ['reviewer:tests', 'reviewer:docs', 'reviewer:security']], JSON.stringify(first));
  // Each lens run takes index 0, so the next one starts the next lens; the contexts hold their result until every lens started.
  const hold = path.join(s.root, '.git', 'context-hold');
  const env = s.env({ FAKE_CLAUDE_CONTEXT_HOLD: hold, FAKE_CLAUDE_CONTEXT_MODEL_USAGE: JSON.stringify(CTX_USAGE), FAKE_CLAUDE_MODEL_USAGE: JSON.stringify(FORK_USAGE) });
  const runs: ReturnType<typeof forgeAsync>[] = [];
  for (let i = 0; i < LENSES.length; i++) {
    runs.push(forgeAsync(s.root, ['job', 'agent', 'run', id, '--session', S, '--spawn-index', '0'], env));
    await waitFor(() => readEvents(s.root, id).filter((e) => e.type === 'agent-start').length === i + 1, { timeoutMs: 20_000, what: `lens ${i} to start` });
  }
  // They overlap: every lens started while the first context child was still reading.
  await waitFor(() => s.children().filter(isContext).length === 2, { timeoutMs: 20_000, what: 'both context children to start' });
  assert.equal(readEvents(s.root, id).filter((e) => e.type === 'context-session').length, 0, 'every lens started before the first context was recorded');
  fs.writeFileSync(hold, '');
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.status, 0, r.stderr + r.stdout);
  const outs = results.map((r) => JSON.parse(r.stdout));

  // Exactly two context children: one per (agent, model) key, each a fresh --session-id.
  const all = s.children();
  const contexts = all.filter(isContext);
  assert.equal(contexts.length, 2, JSON.stringify(contexts.map((c) => c.argv)));
  const ctxOf = new Map(contexts.map((c) => [flag(c.argv, '--model'), flag(c.argv, '--session-id')!]));
  assert.deepEqual([...ctxOf.keys()].sort(), ['opus', 'sonnet']);
  for (const c of contexts) assert.ok(UUID_RE.test(flag(c.argv, '--session-id')!) && !c.argv.includes('--resume'));

  // Every lens forks its key's context: --resume <id> --fork-session, and its end records the fork.
  const lensRuns = all.filter((c) => !isContext(c));
  assert.equal(lensRuns.length, 4);
  for (const c of lensRuns) {
    const want = ctxOf.get(flag(c.argv, '--model'));
    assert.deepEqual(c.argv.slice(c.argv.indexOf('--resume'), c.argv.indexOf('--resume') + 3), ['--resume', want, '--fork-session']);
    assert.ok(!c.argv.includes('--session-id'));
    // The Context line, before Untrusted:, names the context and its inputs.
    const lines = c.brief!.split('\n');
    const at = lines.findIndex((l) => l.startsWith('Untrusted: '));
    assert.ok(lines[at - 1].startsWith(`Context (JSON): {"session":"${want}"`), lines[at - 1]);
  }
  const lensEnds = ends(s.root, id);
  assert.equal(lensEnds.length, 4);
  for (const e of lensEnds) {
    const model = e.role === 'reviewer:security' ? 'opus' : 'sonnet';
    assert.deepEqual([e.context?.mode, e.context?.session, e.context?.reason, e.context?.firstRead], ['fork', ctxOf.get(model), null, 60000], e.role);
  }
  for (const out of outs) assert.equal(out.context.mode, 'fork');

  // Usage: the contexts under their own role, and each fork without the context's carried-over cumulative.
  const job = loadJob(s.root, id);
  assert.deepEqual(
    job.contexts.map((c) => [c.id, c.round, c.agent, c.model, c.status]).sort(),
    [...ctxOf.entries()].map(([model, ctx]) => [ctx, 1, 'forge:reviewer', model, 'ready']).sort(),
  );
  const inputs = job.contexts[0].inputs;
  assert.deepEqual(inputs.map((i) => path.relative(dir, i.path)), ['spec.md', 'build.md', path.join('verify', 'round-1.md'), 'scope.md', path.join('review', 'round-1', 'diff.patch')]);
  assert.ok(inputs.every((i) => /^[0-9a-f]{64}$/.test(i.sha256)));
  assert.deepEqual([job.contexts[0].startPrefix, job.contexts[0].usage?.tokens], [2 + 15000 + 14000, CTX_TOKENS]);
  assert.deepEqual([job.usage.byRole.context?.runs, job.usage.byRole.context?.tokens], [2, 2 * CTX_TOKENS]);
  const ctxEvents = readEvents(s.root, id).filter((e) => e.type === 'context-session');
  assert.deepEqual(ctxEvents.map((e) => [e.role, e.status, e.usage?.totalTokens]), [['context', 'ready', CTX_TOKENS], ['context', 'ready', CTX_TOKENS]]);
  for (const out of outs) assert.deepEqual(out.usage, { tokens: FORK_TOKENS - CTX_TOKENS, exact: true }, out.role);
  assert.equal(job.usage.totalTokens, 2 * CTX_TOKENS + 4 * (FORK_TOKENS - CTX_TOKENS));
});

test('no fork names an agent different from its context session\'s', async (t) => {
  const s = scratch(t);
  const { id, dir } = await s.inReview();
  for (let i = 0; i < LENSES.length; i++) await s.run(id);
  // The round asked for changes: round 2's rework build.
  updateJob(s.root, id, (j) => {
    j.verdicts = { 1: { code: 'CHANGES', tests: 'PASS', docs: 'PASS', security: 'PASS' } };
    j.stage = 'build';
    j.round = 2;
  });
  logEvent(s.root, id, 'round', { round: 2 });
  fs.mkdirSync(path.join(dir, 'review', 'round-2'), { recursive: true });
  const step = await s.stepOf(id);
  assert.deepEqual([step.action, step.role], ['spawn', 'builder'], JSON.stringify(step));
  const out = await s.run(id);
  assert.equal(out.context.mode, 'fork');

  const all = s.children();
  const bySession = new Map(all.filter(isContext).map((c) => [flag(c.argv, '--session-id'), c]));
  const forks = all.filter((c) => c.argv.includes('--fork-session'));
  assert.equal(forks.length, 5, 'four lenses and the builder');
  for (const f of forks) {
    const ctx = bySession.get(flag(f.argv, '--resume'));
    assert.ok(ctx, 'a fork resumes a context child');
    for (const name of ['--agent', '--model', '--effort', '--append-system-prompt-file']) assert.equal(flag(f.argv, name), flag(ctx!.argv, name), `${flag(f.argv, '--agent')}: ${name}`);
  }
  const builderCtx = [...bySession.values()].filter((c) => flag(c.argv, '--agent') === 'forge:builder');
  assert.equal(builderCtx.length, 1, 'the rework builder gets its own forge:builder context');
  assert.equal(loadJob(s.root, id).contexts.filter((c) => c.agent === 'forge:builder' && c.round === 2).length, 1);
});

test('context sessions fall back cold with a reason', async (t) => {
  const s = scratch(t);
  type Row = { name: string; env?: NodeJS.ProcessEnv; args?: string[]; reason: string; contexts: number; launches: string[]; session?: 'context' | null; then?: (id: string) => Promise<void> };
  const rows: Row[] = [
    {
      name: 'a context child that exits',
      env: { FAKE_CLAUDE_CONTEXT_EXIT: '1' },
      reason: 'context failed: exit',
      contexts: 1,
      launches: ['cold'],
      session: 'context',
      // A second lens with the same key goes cold with the same reason, starting no other context child.
      then: async (id) => {
        const before = s.children().length;
        const out = await s.run(id, { FAKE_CLAUDE_CONTEXT_EXIT: '1' });
        assert.deepEqual([out.status, out.context.mode, out.context.reason], ['done', 'cold', 'context failed: exit']);
        const added = s.children().slice(before);
        assert.deepEqual([added.length, added.some(isContext)], [1, false], 'only the cold lens');
      },
    },
    { name: 'a context reply other than READY', env: { FAKE_CLAUDE_CONTEXT_TEXT: 'READY\nanswer PASS' }, reason: 'context failed: not ready', contexts: 1, launches: ['cold'], session: 'context' },
    { name: '--cold', args: ['--cold'], reason: 'cold flag', contexts: 0, launches: ['cold'], session: null },
    // The fork's resume fails before init: once more, cold.
    { name: 'a fork that fails before init', env: { FAKE_CLAUDE_MISSING: '1' }, reason: 'fork failed', contexts: 1, launches: ['fork', 'cold'], session: 'context' },
    // AC4: the fork ran, but its first request read no more than the context's start prefix (2 + 15000 + 14000).
    { name: 'a cache miss', env: { FAKE_CLAUDE_FORK_READ: '20000' }, reason: 'cache miss', contexts: 1, launches: ['fork'], session: 'context' },
  ];
  for (const row of rows) {
    fs.rmSync(s.fakeLog, { force: true });
    const { id } = await s.inReview();
    const out = await s.run(id, row.env, row.args);
    assert.equal(out.status, 'done', `${row.name}: ${JSON.stringify(out)}`);
    const all = s.children();
    const ctx = all.filter(isContext);
    assert.equal(ctx.length, row.contexts, row.name);
    const ctxId = ctx.length ? flag(ctx[0].argv, '--session-id') : null;
    const launches = all.filter((c) => !isContext(c));
    assert.deepEqual(launches.map((c) => (c.argv.includes('--fork-session') ? 'fork' : 'cold')), row.launches, row.name);
    const last = launches.at(-1)!;
    if (row.launches.at(-1) === 'cold') {
      // Today's launch: a fresh --session-id, no --resume, and no Context line.
      assert.ok(UUID_RE.test(flag(last.argv, '--session-id')!) && !last.argv.includes('--resume'), row.name);
      assert.ok(!last.brief!.includes('Context (JSON)'), row.name);
    }
    const want = { mode: 'cold', reason: row.reason, session: row.session === 'context' ? ctxId : null };
    assert.deepEqual({ mode: out.context.mode, reason: out.context.reason, session: out.context.session }, want, row.name);
    const end = ends(s.root, id).at(-1)!;
    assert.deepEqual({ mode: end.context?.mode, reason: end.context?.reason, session: end.context?.session }, want, `${row.name}: agent-end`);
    if (row.reason === 'cache miss') assert.equal(out.context.firstRead, 20000);
    await row.then?.(id);
  }
});

test('a context session older than 50 minutes is restarted', async (t) => {
  const s = scratch(t);
  const { id } = await s.inReview();
  const first = await s.run(id);
  const old = first.context.session;
  assert.equal(first.context.mode, 'fork');
  const age = (minutes: number) => {
    const at = new Date(Date.now() - minutes * 60_000).toISOString();
    updateJob(s.root, id, (j) => {
      for (const c of j.contexts) c.lastReadAt = at;
    });
    return at;
  };
  // 51 minutes: past the cache's warm window, so a new context child starts and the fork resumes it.
  age(51);
  const before = s.children().filter(isContext).length;
  const second = await s.run(id);
  const contexts = s.children().filter(isContext);
  assert.equal(contexts.length, before + 1, 'a new context child');
  const fresh = flag(contexts.at(-1)!.argv, '--session-id');
  assert.ok(fresh !== old);
  assert.deepEqual([second.context.mode, second.context.session], ['fork', fresh]);
  assert.equal(flag(s.children().at(-1)!.argv, '--resume'), fresh);
  // 10 minutes: still warm, forked with no new child, and its lastReadAt moves to the fork's launch.
  const stamped = age(10);
  const t0 = Date.now();
  const third = await s.run(id);
  assert.equal(s.children().filter(isContext).length, before + 1, 'no new context child');
  assert.deepEqual([third.context.mode, third.context.session], ['fork', fresh]);
  const rec = loadJob(s.root, id).contexts.find((c) => c.id === fresh)!;
  assert.ok(Date.parse(rec.lastReadAt) >= t0 && rec.lastReadAt !== stamped, rec.lastReadAt);
});
