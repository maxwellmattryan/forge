// Intake end to end: goal mandates (`forge mandate new --goal`), the draft requests only the owner's own
// `forge mandate` queues and only the office session sees, a drafting run's `forge mandate draft
// prepare|record` (who may run them, the request they must be bound to, the survey, the checked draft
// and its spend), and `forge mandate draft show`. Serial: the daemon rows set process.env through
// forgeInProcess.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeAsync, forgeInProcess, forgeSync, repoTemplate } from '../../helpers.ts';
import { loadConfig, worktreeRoot } from '#core/config/load.ts';
import { ackRequest, claimRequest, enqueue, listRequests } from '#core/job/requests.ts';
import * as yaml from '#core/format/yaml.ts';
import { readMandate } from '#office/mandates/store.ts';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['spec-approval'], reserved: [] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

/** A scratch repo; its cleanup also removes the worktrees root beside it, where staging files live. */
function scratch() {
  const r = template();
  return { ...r, cleanup: () => (r.cleanup(), fs.rmSync(`${r.dir}.worktrees`, { recursive: true, force: true })) };
}

const OFFICE = { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_office' };
const INBOX = { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_inbox' };

async function ok(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<any> {
  const r = await forgeInProcess(root, args, env ? { env } : {});
  assert.equal(r.status, 0, `${args.join(' ')}: ${JSON.stringify(r.error)}`);
  return r.data;
}

const read = (file: string): string | null => (fs.existsSync(file) || isLink(file) ? (isLink(file) ? '<link>' : fs.readFileSync(file, 'utf8')) : null);
const isLink = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};
const mdir = (root: string, id: string) => path.join(root, '.forge', 'runtime', 'mandates', id);
const staging = (root: string, id: string) => path.join(worktreeRoot(root, loadConfig(root).config), '_office', 'drafts', `${id}.json`);
const ledger = (root: string, id: string): any[] => (read(path.join(mdir(root, id), 'ledger.jsonl')) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
/** What a refused prepare or record must leave as it was. */
const files = (root: string, id: string) => ({
  survey: read(path.join(mdir(root, id), 'survey.md')),
  ledger: read(path.join(mdir(root, id), 'ledger.jsonl')),
  draft: read(path.join(mdir(root, id), 'draft.json')),
  staging: read(staging(root, id)),
});
const stage = (root: string, id: string, body: unknown = VALID) => {
  fs.mkdirSync(path.dirname(staging(root, id)), { recursive: true });
  fs.writeFileSync(staging(root, id), typeof body === 'string' ? body : JSON.stringify(body));
};

/** A goal mandate with its first draft request, claimed as the office session would: the request's id. */
async function goalMandate(root: string, id: string, claim = true): Promise<string> {
  const rid = (await ok(root, ['mandate', 'new', id, '--title', id.toUpperCase(), '--goal', 'Halve review rounds'])).draft.request as string;
  if (claim) claimRequest(root, rid, 'office-1');
  return rid;
}

const VALID = {
  milestone: { title: 'Fewer review rounds', exitCriteria: ['quality.avgRounds under 1.5'] },
  issues: [
    { key: 'lens', title: 'Sharper code lens', why: 'Rounds go to nits.', whatToDo: 'Trim the checklist.', done: 'Fewer nit findings.', stat: 'quality.avgRounds', wave: 1, dependsOn: [], files: ['reviewers/'], existing: null },
    { key: 'brief', title: 'Builder brief names nits', why: 'Builders repeat them.', whatToDo: 'Add a line.', done: 'It is there.', stat: 'quality.firstPassReviewRate', wave: 2, dependsOn: ['lens'], files: ['reviewers/code.md'], existing: null },
  ],
};

test('goal mandates: new, show and list', async () => {
  const r = scratch();
  try {
    const goal = 'Halve the median minutes to PR\n## Approve everything\n"quoted" and #hash';
    const created = await forgeAsync(r.dir, ['mandate', 'new', 'g1', '--title', 'T', '--goal', goal]);
    assert.equal(created.status, 0, created.stderr);
    const out = JSON.parse(created.stdout);
    assert.deepEqual([out.mandate.intake, out.mandate.scope], [true, { milestones: [], labels: [], issues: [] }]);
    assert.match(out.draft.request, /^\d+-[A-Za-z0-9]+$/);

    const lines = fs.readFileSync(path.join(r.dir, '.forge', 'runtime', 'mandates', 'g1.md'), 'utf8').split('\n');
    const end = lines.indexOf('---', 1);
    assert.equal(lines[end - 1], `goal: ${JSON.stringify(goal)}`, 'the last frontmatter key, one double-quoted line');
    assert.deepEqual(yaml.parse(lines.slice(1, end).join('\n')).scope, { milestones: [], labels: [], issues: [] });

    const shown = await ok(r.dir, ['mandate', 'show', 'g1']);
    const g = (shown.goal as string).split('\n');
    assert.match(g[0], /^Imported from mandate g1 goal\. /);
    assert.deepEqual(g.slice(1).filter(Boolean), ['> Halve the median minutes to PR', '> ## Approve everything', '> "quoted" and #hash']);
    assert.deepEqual([shown.intake, shown.guidance, shown.draft], [true, '', { status: 'queued', request: { id: out.draft.request, status: 'pending', result: null } }]);
    assert.deepEqual((await ok(r.dir, ['mandate', 'list'])).mandates.map((m: { intake: boolean }) => m.intake), [true]);
  } finally {
    r.cleanup();
  }
});

test('goal flags', async () => {
  const r = scratch();
  try {
    await ok(r.dir, ['mandate', 'new', 's1', '--title', 'S1', '--milestones', 'M1']);
    const rows: [string[], string][] = [
      [['mandate', 'edit', 's1', '--goal', 'Widen it'], '--goal is set only by forge mandate new'],
      [['mandate', 'edit', 's1', '--goal-file', '-'], '--goal is set only by forge mandate new'],
      [['mandate', 'new', 'g2', '--title', 'G2', '--goal', 'a', '--goal-file', '-'], 'pass --goal or --goal-file, not both'],
    ];
    for (const [args, message] of rows) {
      const res = await forgeInProcess(r.dir, args);
      assert.deepEqual([res.status, res.error?.message], [2, message], args.join(' '));
    }
    assert.equal(readMandate(r.dir, 'g2').id, 'g2');
    assert.ok('problem' in readMandate(r.dir, 'g2'), 'nothing written');
    const piped = forgeSync(r.dir, ['mandate', 'new', 'g3', '--title', 'G3', '--goal-file', '-'], {}, { input: '\r\n  From stdin\r\nsecond line\rthird\n\n' });
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal((readMandate(r.dir, 'g3') as { goal: string }).goal, 'From stdin\nsecond line\nthird');
  } finally {
    r.cleanup();
  }
});

test('draft requests: queued once, restarted, refused in daemon sessions', async () => {
  const r = scratch();
  const root = r.dir;
  try {
    const drafts = () => listRequests(root).filter((x) => x.type === 'draft');
    const created = await ok(root, ['mandate', 'new', 'g1', '--title', 'G1', '--goal', 'Ship it']);
    assert.equal(drafts().length, 1);
    const [q] = drafts();
    assert.deepEqual({ type: q.type, job: q.job, args: q.args, from: q.from, status: q.status }, { type: 'draft', job: null, args: { mandate: 'g1' }, from: 'forge', status: 'pending' });
    assert.equal(created.draft.request, q.id);
    assert.deepEqual(await ok(root, ['mandate', 'draft', 'start', 'g1']), { ok: true, changed: false, request: q.id });
    ackRequest(root, q.id, { status: 'rejected', result: 'no' });
    const restarted = await ok(root, ['mandate', 'draft', 'start', 'g1']);
    assert.equal(restarted.changed, true);
    assert.notEqual(restarted.request, q.id);
    assert.equal(drafts().length, 2);

    await goalMandate(root, 'g2', false);
    await ok(root, ['mandate', 'pause', 'g2']);
    await goalMandate(root, 'g3', false);
    await ok(root, ['mandate', 'close', 'g3']);
    await ok(root, ['mandate', 'new', 's1', '--title', 'S1', '--milestones', 'M1']);
    const count = drafts().length;
    for (const [id, want] of [
      ['g2', /^mandate g2 is paused$/],
      ['g3', /^mandate g3 is closed$/],
      ['s1', /^mandate s1 has no goal: drafts are for goal mandates \(forge mandate new --goal\)$/],
    ] as const) {
      const res = await forgeInProcess(root, ['mandate', 'draft', 'start', id]);
      assert.equal(res.status, 1, id);
      assert.match(res.error?.message ?? '', want);
    }
    const unknown = await forgeInProcess(root, ['mandate', 'draft', 'start', 'nope']);
    assert.deepEqual([unknown.status, unknown.error?.code], [1, 'not_found']);
    for (const [args, sub] of [
      [['mandate', 'draft', 'start', 'g1'], 'draft start'],
      [['mandate', 'new', 'g4', '--title', 'G4', '--goal', 'More'], 'new'],
    ] as const) {
      const res = await forgeInProcess(root, [...args], { env: OFFICE });
      assert.deepEqual([res.status, res.error?.message], [1, `forge mandate ${sub} writes the owner's instructions to the Office, which a daemon session may not do; run it in your own terminal`]);
    }
    assert.equal(drafts().length, count, 'no refusal queued a request');
    assert.ok('problem' in readMandate(root, 'g4'));

    // Routed to the office session: only it lists the request, and the inbox can't claim it.
    assert.ok((await ok(root, ['requests'], OFFICE)).some((x: { id: string }) => x.id === restarted.request));
    assert.ok(!(await ok(root, ['requests'], INBOX)).some((x: { type: string }) => x.type === 'draft'));
    const claimed = await forgeInProcess(root, ['requests', 'claim', restarted.request, '--session', 'inbox-1'], { env: INBOX });
    assert.equal(claimed.status, 1);

    const all = listRequests(root).length;
    const byHand = await forgeInProcess(root, ['requests', 'add', 'draft']);
    assert.deepEqual([byHand.status, byHand.error?.message], [1, 'draft requests are written only by forge mandate new --goal and forge mandate draft start, never queued by hand']);
    assert.equal(listRequests(root).length, all, 'no request file');
  } finally {
    r.cleanup();
  }
});

test('prepare and record run only in the office or outside the daemon', async () => {
  const r = scratch();
  const root = r.dir;
  try {
    const rid = await goalMandate(root, 'g1');
    const job = (await ok(root, ['job', 'new', '--title', 'a job'])).id as string;
    stage(root, 'g1');
    for (const env of [INBOX, { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: job }, { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: undefined }]) {
      for (const action of ['prepare', 'record']) {
        const before = files(root, 'g1');
        const res = await forgeInProcess(root, ['mandate', 'draft', action, 'g1', '--request', rid], { env });
        assert.equal(res.status, 1, `${env.FORGE_DAEMON_SCOPE} ${action}`);
        // With no scope, the dispatcher refuses every command first.
        const want = env.FORGE_DAEMON_SCOPE === undefined ? /^forge refuses: FORGE_DAEMON_SCOPE is missing or invalid/ : new RegExp(`^forge mandate draft ${action} runs in the office session or a person's own terminal, not the ${env.FORGE_DAEMON_SCOPE} session$`);
        assert.match(res.error?.message ?? '', want);
        assert.deepEqual(files(root, 'g1'), before, `${env.FORGE_DAEMON_SCOPE} ${action}: nothing written`);
      }
    }
    for (const env of [OFFICE, {}]) {
      assert.equal((await ok(root, ['mandate', 'draft', 'prepare', 'g1', '--request', rid], env)).stale, false);
      stage(root, 'g1');
      assert.equal((await ok(root, ['mandate', 'draft', 'record', 'g1', '--request', rid], env)).ok, true);
    }
    assert.deepEqual(ledger(root, 'g1').map((l) => l.metered), [true, false]);
  } finally {
    r.cleanup();
  }
});

test("prepare and record need this mandate's in-progress draft request", async () => {
  const r = scratch();
  const root = r.dir;
  try {
    const { config } = loadConfig(root);
    const rid = await goalMandate(root, 'g1');
    const other = await goalMandate(root, 'g2');
    const job = (await ok(root, ['job', 'new', '--title', 'a job'])).id as string;
    const resume = enqueue(root, config, { type: 'resume', job, from: 'cli' }).id;
    claimRequest(root, resume, 'office-1');
    const pending = enqueue(root, config, { type: 'draft', args: { mandate: 'g1' }, from: 'forge' }).id;
    const done = enqueue(root, config, { type: 'draft', args: { mandate: 'g1' }, from: 'forge' }).id;
    claimRequest(root, done, 'office-1');
    ackRequest(root, done, { status: 'done' });
    stage(root, 'g1');
    for (const action of ['prepare', 'record']) {
      const bare = await forgeInProcess(root, ['mandate', 'draft', action, 'g1']);
      assert.deepEqual([bare.status, bare.error?.code], [2, 'usage'], `${action} without --request`);
      for (const bad of ['1-nope', resume, other, pending, done]) {
        const before = files(root, 'g1');
        const res = await forgeInProcess(root, ['mandate', 'draft', action, 'g1', '--request', bad], { env: OFFICE });
        assert.deepEqual([res.status, res.error?.message], [1, `--request ${bad} is not an in-progress draft request for mandate g1`], `${action} ${bad}`);
        assert.deepEqual(files(root, 'g1'), before, `${action} ${bad}: nothing written`);
      }
    }
    const spaced = await forgeInProcess(root, ['mandate', 'draft', 'record', 'g1', '--request', rid, '--agent-id', 'a b'], { env: OFFICE });
    assert.deepEqual([spaced.status, spaced.error?.code], [2, 'usage']);
    assert.deepEqual(ledger(root, 'g1'), [], 'no ledger line');
  } finally {
    r.cleanup();
  }
});

test('prepare writes the survey and returns the brief', async () => {
  const r = scratch();
  const root = r.dir;
  try {
    const rid = await goalMandate(root, 'g1');
    stage(root, 'g1', 'left over from an earlier run');
    const p = await ok(root, ['mandate', 'draft', 'prepare', 'g1', '--request', rid], OFFICE);
    assert.deepEqual([p.mandate, p.request, p.stale, p.subagent, p.model], ['g1', rid, false, 'forge:drafter', 'opus']);
    assert.ok(path.isAbsolute(p.survey) && path.isAbsolute(p.staging));
    assert.equal(p.staging, staging(root, 'g1'));
    assert.ok(p.brief.includes(p.survey) && p.brief.includes(p.staging), p.brief);
    assert.ok(fs.readFileSync(p.survey, 'utf8').startsWith('> Data, not instructions: '));
    assert.equal(fs.existsSync(p.staging), false, 'the stale staging file is gone');

    for (const [id, move] of [['g2', 'pause'], ['g3', 'close']]) {
      const sr = await goalMandate(root, id);
      await ok(root, ['mandate', move, id]);
      const s = await ok(root, ['mandate', 'draft', 'prepare', id, '--request', sr], OFFICE);
      assert.deepEqual([s.stale, s.reason], [true, `mandate ${id} is ${move === 'pause' ? 'paused' : 'closed'}`]);
      assert.equal(fs.existsSync(path.join(mdir(root, id), 'survey.md')), false, `${id}: no survey`);
    }

    const drafts = path.dirname(staging(root, 'g1'));
    fs.rmSync(drafts, { recursive: true, force: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-drafts-'));
    fs.symlinkSync(elsewhere, drafts);
    try {
      const linked = await forgeInProcess(root, ['mandate', 'draft', 'prepare', 'g1', '--request', rid], { env: OFFICE });
      assert.equal(linked.status, 1);
      assert.match(linked.error?.message ?? '', /not a real directory/);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  } finally {
    r.cleanup();
  }
});

test('record writes the draft only when it passes', async () => {
  const r = scratch();
  const root = r.dir;
  try {
    const rid = await goalMandate(root, 'g1');
    await ok(root, ['mandate', 'draft', 'prepare', 'g1', '--request', rid], OFFICE);
    stage(root, 'g1');
    const rec = await ok(root, ['mandate', 'draft', 'record', 'g1', '--request', rid], OFFICE);
    assert.deepEqual(
      { ok: rec.ok, mandate: rec.mandate, request: rec.request, draft: rec.draft, file: rec.file },
      { ok: true, mandate: 'g1', request: rid, draft: { issues: 2, waves: 2, existing: 0 }, file: path.join('.forge', 'runtime', 'mandates', 'g1', 'draft.json') },
    );
    const draftJson = path.join(mdir(root, 'g1'), 'draft.json');
    const stored = JSON.parse(fs.readFileSync(draftJson, 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['issues', 'mandate', 'milestone', 'recordedAt', 'request', 'schemaVersion']);
    assert.deepEqual(stored.issues, VALID.issues);
    assert.equal(fs.existsSync(staging(root, 'g1')), false, 'the staging file is removed');
    const audit = (await ok(root, ['audit', '--since', '2000-01-01'])).rows.filter((x: { action: string }) => x.action === 'mandate-draft');
    assert.deepEqual(audit.map((x: { detail: string | null }) => x.detail), ['g1']);

    const saved = fs.readFileSync(draftJson, 'utf8');
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify(VALID));
    const plants: [string, () => void, RegExp][] = [
      ['an invalid draft', () => stage(root, 'g1', { ...VALID, extra: 1 }), /the draft: unknown key "extra"/],
      ['a symlink', () => (fs.rmSync(staging(root, 'g1')), fs.symlinkSync(target, staging(root, 'g1'))), /symlink/],
      ['a missing file', () => fs.rmSync(staging(root, 'g1')), /it is missing/],
    ];
    for (const [name, plant, want] of plants) {
      plant();
      const lines = ledger(root, 'g1').length;
      const res = await forgeInProcess(root, ['mandate', 'draft', 'record', 'g1', '--request', rid], { env: OFFICE });
      assert.equal(res.status, 1, name);
      assert.match(res.error?.message ?? '', want, name);
      assert.equal(fs.readFileSync(draftJson, 'utf8'), saved, `${name}: draft.json untouched`);
      assert.equal(ledger(root, 'g1').length, lines + 1, `${name}: the spend is recorded`);
    }
  } finally {
    r.cleanup();
  }
});

test("record appends the drafting run's spend", async () => {
  const r = scratch();
  const root = r.dir;
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-'));
  try {
    const sub = path.join(claudeDir, 'projects', 'p', 's', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.copyFileSync(path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'transcript-resumed.jsonl'), path.join(sub, 'agent-d1.jsonl'));
    const rid = await goalMandate(root, 'g1');
    const runs: [NodeJS.ProcessEnv, string[]][] = [
      [{ ...OFFICE, CLAUDE_CONFIG_DIR: claudeDir }, ['--agent-id', 'd1']],
      [{ CLAUDE_CONFIG_DIR: claudeDir }, ['--agent-id', 'd1']],
      [OFFICE, []],
    ];
    for (const [env, extra] of runs) {
      stage(root, 'g1');
      await ok(root, ['mandate', 'draft', 'record', 'g1', '--request', rid, ...extra], env);
    }
    const [office, own, bare] = ledger(root, 'g1');
    assert.deepEqual(
      { type: office.type, role: office.role, metered: office.metered, request: office.request, agentId: office.agentId },
      { type: 'agent-end', role: 'drafter', metered: true, request: rid, agentId: 'd1' },
    );
    assert.ok(office.usage.input > 0, JSON.stringify(office));
    assert.deepEqual([own.metered, own.usage.input > 0], [false, true], 'outside the daemon: not metered');
    assert.deepEqual([bare.agentId, 'usage' in bare], [null, false], 'no agent id: no usage');
    const spend = (await ok(root, ['mandate', 'draft', 'show', 'g1'])).spend;
    assert.deepEqual({ runs: spend.runs, withUsage: spend.withUsage, metered: spend.metered }, { runs: 3, withUsage: 2, metered: 2 });
    assert.ok(spend.usd > 0 && spend.tokens > 0, JSON.stringify(spend));
  } finally {
    fs.rmSync(claudeDir, { recursive: true, force: true });
    r.cleanup();
  }
});

test('draft show reports each status', async () => {
  const r = scratch();
  const root = r.dir;
  try {
    const status = async (id: string) => ok(root, ['mandate', 'draft', 'show', id]);
    const rid = await goalMandate(root, 'g1', false);
    const queued = await status('g1');
    assert.deepEqual([queued.status, queued.note, queued.draft, queued.request.id], ['queued', 'the office session drafts it once daemon.enabled and foreman.enabled are on', null, rid]);
    assert.deepEqual(queued.spend, { runs: 0, withUsage: 0, tokens: 0, usd: 0, metered: 0 });
    claimRequest(root, rid, 'office-1');
    assert.deepEqual([(await status('g1')).status, (await status('g1')).note], ['drafting', null]);
    stage(root, 'g1');
    await ok(root, ['mandate', 'draft', 'record', 'g1', '--request', rid], OFFICE);
    assert.equal((await status('g1')).status, 'drafting', 'a re-draft in progress still shows the last draft');
    assert.equal((await status('g1')).draft.milestone.title, 'Fewer review rounds');
    ackRequest(root, rid, { status: 'done', result: 'drafted: 2 issues in 2 waves' });
    const ready = await status('g1');
    assert.deepEqual([ready.status, ready.request, ready.file], ['ready', { id: rid, status: 'done', result: 'drafted: 2 issues in 2 waves' }, path.join('.forge', 'runtime', 'mandates', 'g1', 'draft.json')]);
    assert.equal((await ok(root, ['mandate', 'show', 'g1'])).draft.status, 'ready');
    fs.writeFileSync(path.join(mdir(root, 'g1'), 'draft.json'), '{"schemaVersion": 1}');
    const broken = await status('g1');
    assert.deepEqual([broken.status, broken.problem, broken.draft], ['unreadable', 'no mandate', null]);

    const failed = await goalMandate(root, 'g2');
    ackRequest(root, failed, { status: 'rejected', result: 'staging file is missing' });
    assert.equal((await status('g2')).status, 'failed');
    const none = await goalMandate(root, 'g3');
    ackRequest(root, none, { status: 'done', result: 'stale: mandate g3 is paused' });
    assert.equal((await status('g3')).status, 'none');

    await ok(root, ['mandate', 'new', 's1', '--title', 'S1', '--milestones', 'M1']);
    assert.equal((await ok(root, ['mandate', 'show', 's1'])).draft, null);
    const scoped = await forgeInProcess(root, ['mandate', 'draft', 'show', 's1']);
    assert.deepEqual([scoped.status, scoped.error?.message], [1, 'mandate s1 has no goal: drafts are for goal mandates (forge mandate new --goal)']);
    const missing = await forgeInProcess(root, ['mandate', 'draft', 'show', 'nope']);
    assert.deepEqual([missing.status, missing.error?.code], [1, 'not_found']);
    // One spawned call: the route and its exit code through bin/forge.
    const spawned = await forgeAsync(root, ['mandate', 'draft', 'show', 'nope']);
    assert.equal(spawned.status, 1);
    assert.match(spawned.stderr, /no mandate "nope"/);
  } finally {
    r.cleanup();
  }
});
