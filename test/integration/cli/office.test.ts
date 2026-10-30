// The director loop's CLI: `forge office survey|board|start|resume|note` run only in the office session or
// a person's own terminal, `forge office pass` in no daemon session, and `start` re-checks every limit of
// the mandate before it creates a job. Each choice is a directive in the audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeInProcess, jobAt, repoTemplate } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { TRUST_ENV, trustDigest } from '#core/config/trust.ts';
import { listRequests } from '#core/job/requests.ts';
import { createJob, listJobs, loadJob, logEvent, readEvents, repoAuditFile, setJob } from '#core/job/store.ts';
import { isFencedImport } from '#core/text.ts';
import { FOREMAN_ACTOR, currentActor } from '#integrations/github/actor.ts';
import { readDirectives } from '#office/mandates/directives.ts';
import { officeCmd } from '../../../lib/cli/commands/office.ts';
import { toCliError } from '../../../lib/cli/commands/help.ts';
import type { Config } from '#core/types.ts';

// Items come from fake-items.json on every call, so each test sets its own; claims are logged to a file.
const FAKE_TRACKER = `import fs from 'node:fs';
import path from 'node:path';
const data = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.root, 'fake-items.json'), 'utf8'));
export default {
  name: 'fake',
  list: () => [],
  scope: (ctx, q) => data(ctx).scope[q.milestone ?? ''] ?? [],
  get: (ctx, ref) => data(ctx).items[ref] ?? null,
  claim: (ctx, ref, job) => {
    fs.appendFileSync(path.join(ctx.root, 'fake-claims.log'), ref + ' ' + job.id + '\\n');
    return { ok: true };
  },
  update() {},
  comment() {},
  create: () => ({ ref: 'F-999', url: null }),
  close() {},
};
`;

const scratch = repoTemplate((dir) => {
  fs.mkdirSync(path.join(dir, '.forge', 'trackers'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'trackers', 'fake.mjs'), FAKE_TRACKER);
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'fake' }, foreman: { enabled: true, reserved: [] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

/** A person's own terminal, whatever the test runner's environment. */
const TERMINAL: NodeJS.ProcessEnv = { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined };
/** The office session, trusting the config a human started it with (a custom tracker loads only then). */
const officeEnv = (root: string): NodeJS.ProcessEnv => ({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_office', [TRUST_ENV]: trustDigest(root) });

/** fake-items.json: each milestone's open items, and every item by ref (`closed` lists those the tracker reports closed). */
function items(root: string, scope: Record<string, (string | { ref: string; title: string })[]>, closed: string[] = []): void {
  const all: Record<string, unknown> = {};
  const lists: Record<string, unknown[]> = {};
  for (const [m, list] of Object.entries(scope)) {
    lists[m] = list.map((x) => {
      const it = typeof x === 'string' ? { ref: x, title: `Issue ${x}` } : x;
      all[it.ref] = { ...it, body: 'Do it.', url: null, status: closed.includes(it.ref) ? 'Closed' : 'Open' };
      return { ...it, labels: [], needsInfo: false };
    });
  }
  fs.writeFileSync(path.join(root, 'fake-items.json'), JSON.stringify({ scope: lists, items: all }));
}

const cli = (root: string, args: string[], env: NodeJS.ProcessEnv = TERMINAL) => forgeInProcess(root, args, { env });

async function must(root: string, args: string[], env: NodeJS.ProcessEnv = TERMINAL): Promise<any> {
  const r = await cli(root, args, env);
  assert.equal(r.status, 0, `${args.join(' ')}: ${JSON.stringify(r.error)}`);
  return r.data;
}

/** `forge office …` against a config the test patches (forgeInProcess reads the one on disk). */
async function office(root: string, config: Config, args: string[], env: NodeJS.ProcessEnv = {}) {
  const [sub, ...rest] = args.filter((a) => !a.startsWith('--'));
  const flags: Record<string, unknown> = {};
  const i = args.indexOf('--reason');
  if (i >= 0) flags.reason = args[i + 1];
  const positional = rest.filter((a) => a !== flags.reason);
  try {
    const r = await officeCmd({ root, config, initialized: true }, sub, positional, flags, env);
    return { status: r.exitCode ?? 0, data: r.data as any, error: null };
  } catch (e) {
    const error = toCliError(e, ['office', ...args]);
    return { status: error.exit, data: null, error };
  }
}

const patched = (root: string, patch: (c: Config) => void): Config => {
  const c = structuredClone(loadConfig(root).config);
  patch(c);
  return c;
};

const fakeIssue = (ref: string) => [{ tracker: 'fake', ref }] as Parameters<typeof createJob>[2]['issues'];
const auditText = (root: string) => (fs.existsSync(repoAuditFile(root)) ? fs.readFileSync(repoAuditFile(root), 'utf8') : '');

/** Everything a refused office command must leave as it was: the mandate files, the requests and the audit log. */
function snapshot(root: string): string {
  const dir = path.join(root, '.forge', 'runtime', 'mandates');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
  return JSON.stringify({ files, requests: listRequests(root), audit: auditText(root) });
}

test('office commands run only where they may', async () => {
  const r = scratch();
  try {
    items(r.dir, { M1: ['F-1', 'F-2'] });
    await must(r.dir, ['mandate', 'new', 'm1', '--title', 'm1', '--milestones', 'M1']);
    const job = createJob(r.dir, loadConfig(r.dir).config, { title: 'queued', mandate: 'm1', issues: fakeIssue('F-2') }).id;
    const before = snapshot(r.dir);

    const direct = await cli(r.dir, ['requests', 'add', 'direct']);
    assert.equal(direct.status, 1);
    assert.match(direct.error?.message ?? '', /direct requests are written only by the Office pass, never queued by hand/);

    const subs: string[][] = [
      ['office', 'survey'],
      ['office', 'board', 'm1'],
      ['office', 'start', 'm1', 'F-1', '--reason', 'next'],
      ['office', 'resume', 'm1', job, '--reason', 'resume it'],
      ['office', 'note', 'm1', '--reason', 'holding'],
    ];
    for (const scope of ['_inbox', job, 'not a scope', '_assistant-1', '_gates']) {
      for (const args of subs) {
        const res = await cli(r.dir, args, { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: scope });
        assert.equal(res.status, 1, `${args.join(' ')} in ${scope}: ${JSON.stringify(res.error)}`);
        // A broken scope (a legacy assistant's or a gate run's too) is refused before the command's own check.
        if (scope === '_inbox' || scope === job) assert.match(res.error?.message ?? '', new RegExp(`forge office ${args[1]} runs in an office run or a person's own terminal, not the ${scope} session`));
      }
    }
    for (const scope of ['_office', '_inbox', job]) {
      const res = await cli(r.dir, ['office', 'pass'], { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: scope });
      assert.equal(res.status, 1, scope);
      assert.match(res.error?.message ?? '', /forge office pass runs outside daemon sessions \(forge dash runs it\)/);
    }
    assert.equal(snapshot(r.dir), before, 'no mandate file, request or audit line changed');
  } finally {
    r.cleanup();
  }
});

test('forge office start starts only what the mandate allows', async () => {
  const r = scratch();
  try {
    items(r.dir, { M1: ['F-1', 'F-2', 'F-4'], M2: ['F-10'], M3: ['F-20', 'F-21'], M4: ['F-40', 'F-41'], M5: ['F-50', 'F-51'], M6: ['F-3', 'F-5'], '': ['F-30', 'F-31'] }, ['F-3']);
    const mk = (id: string, ...terms: string[]) => must(r.dir, ['mandate', 'new', id, '--title', id, ...terms]);
    await mk('m1', '--milestones', 'M1', '--max-jobs', '2');
    await mk('ml', '--issues', 'F-30,F-31', '--order', 'listed', '--max-jobs', '2');
    await mk('mp', '--milestones', 'M2');
    await must(r.dir, ['mandate', 'pause', 'mp']);
    await mk('mx', '--milestones', 'M3');
    await mk('mw', '--milestones', 'M3', '--after', 'mx');
    await mk('mc', '--milestones', 'M2');
    await must(r.dir, ['mandate', 'close', 'mc']);
    await mk('mb', '--milestones', 'M4', '--budget-usd', '1');
    await mk('mj', '--milestones', 'M5', '--budget-jobs', '1');
    await mk('ms', '--milestones', 'M6');
    const config = loadConfig(r.dir).config;
    const spender = createJob(r.dir, config, { title: 'spent', mandate: 'mb', issues: fakeIssue('F-40') }).id;
    logEvent(r.dir, spender, 'agent-end', { role: 'builder', model: 'usd-model', usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } });
    const done = createJob(r.dir, config, { title: 'done', mandate: 'mj', issues: fakeIssue('F-50') }).id;
    setJob(r.dir, done, { stage: 'done', state: 'done' });

    // Success, from a person's terminal and then from the office session.
    const first = await must(r.dir, ['office', 'start', 'm1', 'F-1', '--reason', 'oldest first']);
    assert.deepEqual([first.ok, first.mandate, first.issue], [true, 'm1', 'F-1']);
    assert.equal(loadJob(r.dir, first.job).mandate, 'm1', "the CLI's record carries the mandate");
    assert.match(fs.readFileSync(path.join(r.dir, 'fake-claims.log'), 'utf8'), new RegExp(`^F-1 ${first.job}$`, 'm'));
    const resume = listRequests(r.dir).find((q) => q.id === first.request);
    assert.deepEqual([resume?.type, resume?.job, resume?.status, resume?.args?.intake], ['resume', first.job, 'pending', 'run']);
    const started = () => readDirectives(r.dir).filter((d) => d.action === 'start');
    assert.deepEqual(started().map((d) => [d.mandate, d.issue, d.job, d.reason]), [['m1', 'F-1', first.job, 'oldest first']]);
    assert.deepEqual(started()[0].actor, currentActor(r.dir));
    assert.ok(readEvents(r.dir, first.job).some((e) => e.type === 'directive' && e.action === 'start'), 'on the job too');
    const second = await must(r.dir, ['office', 'start', 'm1', 'F-2', '--reason', 'next'], officeEnv(r.dir));
    assert.deepEqual(started().at(-1)?.actor, FOREMAN_ACTOR);
    assert.equal(started().at(-1)?.job, second.job);

    const refused: { name: string; args: string[]; config?: (c: Config) => void; error: RegExp | string; status?: number }[] = [
      { name: 'free 0 at maxJobs', args: ['start', 'm1', 'F-4', '--reason', 'r'], error: /F-4 is not among mandate m1's next issues \(none\)/ },
      { name: 'a ref outside the window', args: ['start', 'mx', 'F-99', '--reason', 'r'], error: /F-99 is not among mandate mx's next issues \(F-20, F-21\)/ },
      { name: 'the second listed issue before the first', args: ['start', 'ml', 'F-31', '--reason', 'r'], error: /F-31 is not mandate ml's next listed issue \(F-30\)/ },
      { name: 'a paused mandate', args: ['start', 'mp', 'F-10', '--reason', 'r'], error: /mandate mp is paused/ },
      { name: 'a waiting mandate', args: ['start', 'mw', 'F-20', '--reason', 'r'], error: /mandate mw is waiting/ },
      { name: 'a closed mandate', args: ['start', 'mc', 'F-10', '--reason', 'r'], error: /mandate mc is closed/ },
      {
        name: 'spend at budget.usd',
        args: ['start', 'mb', 'F-41', '--reason', 'r'],
        config: (c) => void (c.usage.pricing = { models: { 'usd-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } }),
        error: /^budget: \$5 of \$1 spent$/,
      },
      { name: 'started at budget.jobs', args: ['start', 'mj', 'F-51', '--reason', 'r'], error: /^budget: 1 of 1 jobs started$/ },
      { name: 'foreman.enabled false', args: ['start', 'mx', 'F-20', '--reason', 'r'], config: (c) => void (c.foreman.enabled = false), error: /^foreman\.enabled is false$/ },
      { name: 'no --reason', args: ['start', 'mx', 'F-20'], error: 'usage', status: 2 },
      { name: 'a held repo budget', args: ['start', 'mx', 'F-20', '--reason', 'r'], config: (c) => void (c.budget = { ...c.budget, usdPerDay: 0 }), error: 'blocked', status: 4 },
    ];
    for (const row of refused) {
      const jobs = listJobs(r.dir).length;
      const directives = readDirectives(r.dir).length;
      const res = await office(r.dir, patched(r.dir, row.config ?? (() => {})), row.args);
      assert.equal(res.status, row.status ?? 1, `${row.name}: ${JSON.stringify(res.error)}`);
      if (typeof row.error === 'string') assert.equal(res.error?.code, row.error, row.name);
      else assert.match(res.error?.message ?? '', row.error, row.name);
      assert.equal(listJobs(r.dir).length, jobs, `${row.name}: no job`);
      assert.equal(readDirectives(r.dir).length, directives, `${row.name}: no directive`);
    }

    // An issue the tracker reports closed is skipped, and leaves the candidates.
    const skipped = await must(r.dir, ['office', 'start', 'ms', 'F-3', '--reason', 'r']);
    assert.deepEqual(skipped, { ok: true, skipped: true, issue: 'F-3', reason: 'closed upstream' });
    assert.deepEqual(readDirectives(r.dir).filter((d) => d.action === 'skip').map((d) => [d.mandate, d.issue, d.reason]), [['ms', 'F-3', 'closed upstream']]);
    const survey = await must(r.dir, ['office', 'survey']);
    assert.deepEqual(survey.mandates.find((m: any) => m.id === 'ms').candidates.map((c: any) => c.ref), ['F-5']);
  } finally {
    r.cleanup();
  }
});

test('resume and note', async () => {
  const r = scratch();
  try {
    items(r.dir, { M7: ['F-70', 'F-71', 'F-72'] });
    await must(r.dir, ['mandate', 'new', 'mr', '--title', 'mr', '--milestones', 'M7', '--max-jobs', '3']);
    await must(r.dir, ['mandate', 'new', 'mz', '--title', 'mz', '--milestones', 'M7']);
    await must(r.dir, ['mandate', 'close', 'mz']);
    const config = loadConfig(r.dir).config;
    const queued = createJob(r.dir, config, { title: 'queued', mandate: 'mr', issues: fakeIssue('F-70') }).id;
    const outside = createJob(r.dir, config, { title: 'outside', issues: fakeIssue('F-90') }).id;
    const running = jobAt(r.dir, 'build', { create: { mandate: 'mr', issues: fakeIssue('F-71') } }).id;

    const out = await must(r.dir, ['office', 'resume', 'mr', queued, '--reason', 'its session ended'], officeEnv(r.dir));
    const req = listRequests(r.dir).find((q) => q.id === out.request);
    assert.deepEqual([req?.type, req?.job, req?.status], ['resume', queued, 'pending']);
    assert.deepEqual(readDirectives(r.dir).map((d) => [d.action, d.job, d.issue]), [['resume', queued, 'F-70']]);
    for (const [name, job] of [['a job with a pending request', queued], ['a job outside the mandate', outside], ['a running job', running]]) {
      const res = await cli(r.dir, ['office', 'resume', 'mr', job, '--reason', 'r'], officeEnv(r.dir));
      assert.equal(res.status, 1, name);
      assert.match(res.error?.message ?? '', /is not one of mandate mr's resumable jobs/, name);
    }
    assert.equal(readDirectives(r.dir).length, 1);

    assert.deepEqual(await must(r.dir, ['office', 'note', 'mr', '--reason', 'waiting on F-70 before F-72'], officeEnv(r.dir)), { ok: true, mandate: 'mr' });
    assert.deepEqual(readDirectives(r.dir).at(-1)?.action, 'note');
    const closed = await cli(r.dir, ['office', 'note', 'mz', '--reason', 'r'], officeEnv(r.dir));
    assert.equal(closed.status, 1);
    assert.match(closed.error?.message ?? '', /mandate mz is closed/);
  } finally {
    r.cleanup();
  }
});

test('survey and board', async () => {
  const r = scratch();
  try {
    const refs = Array.from({ length: 12 }, (_, i) => `F-${i + 1}`);
    items(r.dir, { M1: [{ ref: 'F-0', title: 'Line one\nline two' }, ...refs] });
    await must(r.dir, ['mandate', 'new', 'ma', '--title', 'ma', '--milestones', 'M1', '--max-jobs', '2', '--body', 'Prefer small issues.']);
    await must(r.dir, ['mandate', 'new', 'mq', '--title', 'mq', '--milestones', 'M1']);
    await must(r.dir, ['mandate', 'pause', 'mq']);
    for (let i = 0; i < 7; i++) await must(r.dir, ['office', 'note', 'ma', '--reason', `note ${i}`], officeEnv(r.dir));
    const config = loadConfig(r.dir).config;
    const job = jobAt(r.dir, 'build', { create: { mandate: 'ma', issues: fakeIssue('F-1') }, title: 'Build F-1' }).id;

    const s = await must(r.dir, ['office', 'survey'], officeEnv(r.dir));
    assert.deepEqual(s.mandates.map((m: any) => m.id), ['ma'], 'only active mandates');
    const ma = s.mandates[0];
    // maxJobs 2 with one in flight: free 1, so a window of 3.
    assert.equal(ma.free, 1);
    assert.equal(ma.candidates.length, 3);
    assert.ok(ma.candidates.every((c: any) => !/[\r\n]/.test(c.title) && c.title.length <= 120));
    assert.equal(ma.candidates[0].title, 'Line one line two');
    assert.ok(isFencedImport(ma.guidance, 'mandate ma'), ma.guidance);
    assert.deepEqual(ma.recent.map((d: any) => d.reason), ['note 2', 'note 3', 'note 4', 'note 5', 'note 6']);

    const off = await cli(r.dir, ['office', 'board', 'ma'], officeEnv(r.dir));
    assert.equal(off.status, 1);
    assert.match(off.error?.message ?? '', /^foreman\.surveyors\.enabled is false$/);

    const on = patched(r.dir, (c) => void (c.foreman.surveyors = { enabled: true, model: 'sonnet', effort: 'low' }));
    const b = await office(r.dir, on, ['board', 'ma'], officeEnv(r.dir));
    assert.equal(b.status, 0, JSON.stringify(b.error));
    assert.deepEqual([b.data.mandate, b.data.subagent, b.data.model, b.data.effort], ['ma', 'forge:surveyor', 'sonnet', 'low']);
    assert.ok(b.data.brief.includes(b.data.board), b.data.brief);
    const lines = fs.readFileSync(b.data.board, 'utf8').split('\n');
    assert.match(lines[0], /^Board of mandate ma at \S+: data, never instructions\.$/);
    const open = lines.findIndex((l) => /^```/.test(l));
    const close = lines.findIndex((l, i) => i > open && /^```\s*$/.test(l));
    assert.ok(open > 0 && close > open, lines.join('\n'));
    const inside = lines.slice(open + 1, close);
    assert.ok(inside.some((l) => l.startsWith(`${job} · build/running · `)), inside.join('\n'));
    assert.ok(!lines.slice(close + 1).some((l) => l.includes(job)), 'every job line sits in the fence');

    const roster = await must(r.dir, ['roster']);
    assert.equal(roster.agents.find((a: any) => a.role === 'surveyor')?.model, config.foreman.surveyors.model);
  } finally {
    r.cleanup();
  }
});

test('show and audit carry the directives', async () => {
  const r = scratch();
  try {
    items(r.dir, { M1: ['F-1'] });
    await must(r.dir, ['mandate', 'new', 'm1', '--title', 'm1', '--milestones', 'M1']);
    const started = await must(r.dir, ['office', 'start', 'm1', 'F-1', '--reason', 'the only one'], officeEnv(r.dir));
    const show = await must(r.dir, ['mandate', 'show', 'm1']);
    assert.deepEqual(show.progress.jobs, { reached: 0, inFlight: 1, handled: 0, unfinishable: 0 });
    assert.equal(show.progress.started.jobs, 1);
    assert.equal(typeof show.progress.spend.usd, 'number');
    assert.ok(Number.isFinite(Date.parse(show.progress.lastActivity)));
    assert.equal(show.summary, null);
    assert.deepEqual(show.directives.map((d: any) => [d.action, d.job]), [['start', started.job]]);

    const audit = await must(r.dir, ['audit', '--since', '2000-01-01']);
    const rows = audit.rows.filter((row: any) => row.action === 'directive');
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.deepEqual([rows[0].actor, rows[0].note, rows[0].detail], [FOREMAN_ACTOR, 'the only one', `m1 start F-1 ${started.job}`]);
    const jobAudit = await must(r.dir, ['job', 'audit', started.job]);
    assert.ok(jobAudit.rows.some((row: any) => row.action === 'directive' && row.actor?.source === 'foreman'), JSON.stringify(jobAudit.rows));

    // Once the pass closes it, show carries the closing summary.
    setJob(r.dir, started.job, { stage: 'done', state: 'done' });
    const pass = await must(r.dir, ['office', 'pass']);
    assert.deepEqual(pass.mandates.map((m: any) => [m.id, m.state]), [['m1', 'closed']]);
    const closed = await must(r.dir, ['mandate', 'show', 'm1']);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.summary?.mandate, 'm1');
    assert.deepEqual(closed.summary?.jobs.map((j: any) => [j.id, j.outcome]), [[started.job, 'reached']]);
  } finally {
    r.cleanup();
  }
});
