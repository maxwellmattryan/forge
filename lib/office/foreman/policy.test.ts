// A mandate only ever narrows what the Foreman decides: checkForemanDecision, `forge job human approve-release`
// and gateOwner read the job's mandate from the CLI's record of the job, and a mandate file that is gone or
// can't be read delegates nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, MILESTONE_DRAFT, forgeInProcess, initMilestoneRepo, parkedAt, readyGoal, repoTemplate, withRound } from '../../../test/helpers.ts';
import { defaults, loadConfig } from '#core/config/load.ts';
import { validateConfig } from '#core/config/validate.ts';
import * as yaml from '#core/format/yaml.ts';
import { deepMerge } from '#core/shape.ts';
import { ackRequest, enqueue, listRequests } from '#core/job/requests.ts';
import { jobDir, loadJob, logHumanEvent, logRepoEvent, readEvents, setJob } from '#core/job/store.ts';
import { FOREMAN_ACTOR } from '#integrations/github/actor.ts';
import { ACTIONS_BY_GATE } from '#engine/pipeline/moves/foreman-gates.ts';
import { foremanReleaseApproval, releaseApprovalStatus } from '#engine/release/approval.ts';
import { releaseFiles } from '#engine/release/files.ts';
import { approveMandateRelease, planMandateRelease } from '#engine/release/mandate.ts';
import { planHash } from '#engine/release/plan.ts';
import { draftReservedTexts } from '../mandates/gate.ts';
import { OFFICE_GATES, checkForemanDecision, checkMandateGateDecision, gateOwner, mandateReleaseRefusal, releaseMandateRefusal } from './policy.ts';
import { gateAssist, recordForemanDecision } from './decide.ts';
import { checkReleaseDecision } from '#engine/release/approval.ts';
import { issueForemanAuthority } from '#core/job/requests.ts';
import type { DraftUnderDecision } from './policy.ts';
import type { ForgeRequest, Job } from '#core/types.ts';

/** The gate runner's authority: every decision here is judged as one of its runs would be. */
const BY = issueForemanAuthority();
const OFFICE: NodeJS.ProcessEnv = { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_office' };

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['spec-approval', 'split-approval', 'conflicts', 'release'], reserved: [] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

interface Row {
  name: string;
  /** The job's mandate, or null for none. */
  mandate: string | null;
  /** Run after the job parks: what the row does to the mandate or the job. */
  then?: (root: string, job: string) => Promise<void> | void;
  /** The refusal for a gate class, or null when the gate is the foreman's. */
  refused: ((gate: string) => RegExp) | null;
}

const mandates = (root: string) => path.join(root, '.forge', 'runtime', 'mandates');
const notIn = (id: string) => (gate: string) => new RegExp(`--actor foreman refused: ${gate} is not in mandate ${id}'s decides: left for a human`);
const unreadable = (id: string, why: string) => () => new RegExp(`--actor foreman refused: mandate ${id} can't be read \\(${why}\\): left for a human`);
const isClosed = (id: string) => () => new RegExp(`--actor foreman refused: mandate ${id} is closed: left for a human`);

const ROWS: Row[] = [
  { name: "the mandate's decides leaves the gate out", mandate: 'narrow', refused: notIn('narrow') },
  {
    name: 'the mandate file was deleted',
    mandate: 'deleted',
    then: (root) => fs.rmSync(path.join(mandates(root), 'deleted.md')),
    refused: unreadable('deleted', 'no such mandate'),
  },
  {
    name: 'the mandate file is a symlink',
    mandate: 'linked',
    then: (root) => {
      fs.rmSync(path.join(mandates(root), 'linked.md'));
      fs.symlinkSync(path.join(mandates(root), 'wide.md'), path.join(mandates(root), 'linked.md'));
    },
    refused: unreadable('linked', 'a symlink, not a regular file'),
  },
  { name: 'the mandate is paused', mandate: 'paused', then: (root) => cli(root, ['mandate', 'pause', 'paused']), refused: notIn('paused') },
  { name: 'the mandate is closed', mandate: 'closed', then: (root) => cli(root, ['mandate', 'close', 'closed']), refused: isClosed('closed') },
  { name: 'the mandate delegates the gate but is closed', mandate: 'shut', then: (root) => cli(root, ['mandate', 'close', 'shut']), refused: isClosed('shut') },
  {
    name: "the session-writable job.json says no mandate, the CLI's record still does",
    mandate: 'narrow',
    then: (root, job) => {
      const file = path.join(jobDir(root, job), 'job.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), mandate: null }));
    },
    refused: notIn('narrow'),
  },
  { name: 'the mandate delegates the gate', mandate: 'wide', refused: null },
  { name: 'a job in no mandate', mandate: null, refused: null },
];

async function cli(root: string, args: string[]): Promise<void> {
  const r = await forgeInProcess(root, args);
  assert.equal(r.status, 0, `${args.join(' ')}: ${JSON.stringify(r.error)}`);
}

/** A repo with one mandate per row (only `wide` delegates spec-approval) and one job per row parked on it. */
async function arrange() {
  const r = scratch();
  for (const id of ['narrow', 'deleted', 'linked', 'paused', 'closed']) await cli(r.dir, ['mandate', 'new', id, '--title', id, '--milestones', 'M1', '--decides', 'split-approval']);
  for (const id of ['wide', 'shut']) await cli(r.dir, ['mandate', 'new', id, '--title', id, '--milestones', 'M1', '--decides', 'spec-approval,split-approval,release']);
  const jobs: string[] = [];
  for (const row of ROWS) {
    const job = parkedAt(r.dir, 'spec-approval', { title: row.name, create: { mandate: row.mandate } }).id;
    await row.then?.(r.dir, job);
    jobs.push(job);
  }
  return { ...r, config: loadConfig(r.dir).config, jobs };
}

test('a mandate narrows foreman.decides', async () => {
  const r = await arrange();
  try {
    ROWS.forEach((row, i) => {
      const job = loadJob(r.dir, r.jobs[i]);
      const decide = () => checkForemanDecision(r.dir, r.config, job, 'approve-spec', 'the spec is ready', {}, BY);
      if (row.refused) assert.throws(decide, row.refused('spec-approval'), row.name);
      else assert.equal(decide(), 'spec-approval', row.name);
    });
  } finally {
    r.cleanup();
  }
});

// `release` is decided from a plan, not a park, so it has its own checks (checkReleaseDecision); the job's
// mandate narrows it the same way. A delegated release goes on to the plan checks, where it stops: none is planned.
test('a mandate narrows approve-release too', async () => {
  const r = await arrange();
  try {
    for (const [i, row] of ROWS.entries()) {
      const job = loadJob(r.dir, r.jobs[i]);
      assert.throws(
        () => recordForemanDecision(r.dir, r.config, job, 'approve-release', 'the plan is fine', {}, BY),
        row.refused ? row.refused('release') : /--actor foreman refused: no release plan; a human runs forge release plan --job first/,
        row.name,
      );
      assert.ok(!readEvents(r.dir, r.jobs[i]).some((e) => e.type === 'release-approval'), `${row.name}: nothing recorded`);
    }
  } finally {
    r.cleanup();
  }
});

test('a foreman release approval stops counting once its mandate narrows', async () => {
  const r = scratch();
  try {
    const config = loadConfig(r.dir).config;
    const hash = 'a'.repeat(64);
    const rows: { name: string; mandate: string | null; then?: (id: string) => Promise<void> | void; counts: boolean }[] = [
      { name: 'the mandate still delegates release', mandate: 'kept', counts: true },
      { name: 'the mandate is narrowed', mandate: 'edited', then: (id) => cli(r.dir, ['mandate', 'edit', id, '--decides', 'split-approval']), counts: false },
      { name: 'the mandate is paused', mandate: 'halted', then: (id) => cli(r.dir, ['mandate', 'pause', id]), counts: false },
      { name: 'the mandate is closed', mandate: 'ended', then: (id) => cli(r.dir, ['mandate', 'close', id]), counts: false },
      { name: 'the mandate file was deleted', mandate: 'gone', then: (id) => fs.rmSync(path.join(mandates(r.dir), `${id}.md`)), counts: false },
      {
        name: 'the mandate file is a symlink',
        mandate: 'swapped',
        then: (id) => {
          fs.rmSync(path.join(mandates(r.dir), `${id}.md`));
          fs.symlinkSync(path.join(mandates(r.dir), 'kept.md'), path.join(mandates(r.dir), `${id}.md`));
        },
        counts: false,
      },
      { name: 'a job in no mandate', mandate: null, counts: true },
    ];
    for (const row of rows) if (row.mandate) await cli(r.dir, ['mandate', 'new', row.mandate, '--title', row.mandate, '--milestones', 'M1', '--decides', 'split-approval,release']);
    const narrow = (j: Job) => releaseMandateRefusal(r.dir, config, j);
    for (const row of rows) {
      const job = parkedAt(r.dir, 'spec-approval', { title: row.name, create: { mandate: row.mandate } }).id;
      logHumanEvent(r.dir, job, 'release-approval', { planHash: hash, note: 'the plan is fine' }, FOREMAN_ACTOR);
      const plan = { selection: { kind: 'job' as const, job }, hash };
      assert.ok(foremanReleaseApproval(r.dir, config, plan, narrow), `${row.name}: counts before`);
      assert.equal(releaseApprovalStatus(r.dir, config, plan, narrow).status, 'approved', `${row.name}: approved before`);
      if (row.mandate) await row.then?.(row.mandate);
      if (row.counts) {
        assert.ok(foremanReleaseApproval(r.dir, config, plan, narrow), `${row.name}: still counts`);
        assert.equal(releaseApprovalStatus(r.dir, config, plan, narrow).status, 'approved', `${row.name}: still approved`);
      } else {
        assert.equal(foremanReleaseApproval(r.dir, config, plan, narrow), null, `${row.name}: stops counting`);
        assert.deepEqual(releaseApprovalStatus(r.dir, config, plan, narrow), { owner: 'human', status: 'pending' }, row.name);
      }
    }
    // A paused mandate that still lists release delegates no release: the approval is refused before it is recorded.
    await cli(r.dir, ['mandate', 'new', 'resting', '--title', 'resting', '--milestones', 'M1', '--decides', 'release']);
    await cli(r.dir, ['mandate', 'pause', 'resting']);
    const job = parkedAt(r.dir, 'spec-approval', { title: 'paused release', create: { mandate: 'resting' } }).id;
    assert.throws(() => recordForemanDecision(r.dir, config, loadJob(r.dir, job), 'approve-release', 'ok', {}, BY), /--actor foreman refused: mandate resting is paused: release left for a human/);
    assert.ok(!readEvents(r.dir, job).some((e) => e.type === 'release-approval'), 'nothing recorded');
  } finally {
    r.cleanup();
  }
});

const escalations = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['escalation'], reserved: [] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

test('a job back at its gate stall.bounces times is left for a human', async () => {
  const r = escalations();
  try {
    await cli(r.dir, ['mandate', 'new', 'b1', '--title', 'b1', '--milestones', 'M1', '--decides', 'escalation', '--stall-bounces', '3']);
    const config = loadConfig(r.dir).config;
    const id = parkedAt(r.dir, 'escalation', { create: { mandate: 'b1' } }).id;
    const repark = () => {
      setJob(r.dir, id, { state: 'running' });
      setJob(r.dir, id, { state: 'waiting', waitingOn: 'escalation' });
    };
    const decide = () => checkForemanDecision(r.dir, config, loadJob(r.dir, id), 'approve', 'the decision is sound', {}, BY);
    const assist = async () => ({ data: gateAssist(r.dir, config, loadJob(r.dir, id), 'escalation') });
    repark();
    assert.equal(decide(), 'escalation', 'the second park is still the foreman’s');
    // A reason change while waiting is no new entry.
    setJob(r.dir, id, { reason: 'still waiting' });
    repark();
    const held = 'mandate b1: back at escalation 3 times (stall.bounces 3): left for a human';
    assert.throws(decide, new RegExp(`--actor foreman refused: ${held.replace(/[()]/g, '\\$&')}`));
    assert.equal((await assist()).data?.reserved, held);
    assert.equal(gateOwner(r.dir, config, loadJob(r.dir, id), []), 'human');
    // A person's decision resets the count; a foreman one never does.
    logHumanEvent(r.dir, id, 'human', { action: 'approve', note: 'go on' }, FOREMAN_ACTOR);
    assert.throws(decide, /back at escalation 3 times/);
    logHumanEvent(r.dir, id, 'human', { action: 'approve', note: 'go on' }, { login: 'alice', source: 'gh' });
    assert.equal(decide(), 'escalation');
    assert.equal((await assist()).data?.reserved, null);
    assert.equal(gateOwner(r.dir, config, loadJob(r.dir, id), []), 'foreman');
  } finally {
    r.cleanup();
  }
});

test('the milestone-approval gate class and its defaults', () => {
  assert.equal(OFFICE_GATES.at(-1), 'milestone-approval');
  assert.deepEqual(ACTIONS_BY_GATE['milestone-approval'], ['approve', 'revise']);
  assert.ok(!(defaults().foreman.decides as string[]).includes('milestone-approval'), 'opt-in: the default leaves it out');
  const c = defaults();
  c.foreman.decides = ['milestone-approval'];
  c.foreman.reserved = ['gate:milestone-approval'];
  assert.deepEqual(validateConfig(c, os.tmpdir()).filter((p) => p.startsWith('foreman.')), []);
});

const draftScratch = repoTemplate((dir) => initMilestoneRepo(dir, { reserved: ['payments'] }));

/**
 * A foreman decision on goal mandate g1's pending draft. g2's decides leaves milestone-approval out, g3's
 * file is a symlink. Each row changes one thing from the passing case.
 */
test('a foreman decision on a milestone draft', async () => {
  const r = draftScratch();
  try {
    const { request, digest } = await readyGoal(r.dir, 'g1', ['--decides', 'milestone-approval']);
    await readyGoal(r.dir, 'g2', ['--decides', 'spec-approval']);
    await readyGoal(r.dir, 'g3', ['--decides', 'milestone-approval']);
    const m3 = path.join(mandates(r.dir), 'g3.md');
    fs.renameSync(m3, path.join(r.dir, 'g3.md'));
    fs.symlinkSync(path.join(r.dir, 'g3.md'), m3);
    const config = loadConfig(r.dir).config;
    const goal = { goal: 'Halve review rounds' };
    const texts = draftReservedTexts(goal, MILESTONE_DRAFT);
    const draft: DraftUnderDecision = { request, digest, gate: 'pending', texts };
    const gate = (over: Record<string, unknown> = {}): ForgeRequest => ({
      id: '1-gate',
      type: 'gate',
      job: null,
      text: null,
      args: { gate: 'milestone-approval', mandate: 'g1', key: request, digest, reserved: null, ...over },
      from: 'forge',
      status: 'in-progress',
      createdAt: '2026-10-26T00:00:00.000Z',
    });
    const revision = (n: number): ForgeRequest => ({ ...gate(), id: `${n}-rev`, type: 'draft', args: { mandate: 'g1', note: 'x', revises: request, foreman: true }, status: 'done' });
    const off = (patch: (c: any) => void) => {
      const c = structuredClone(config);
      patch(c);
      return c;
    };
    interface DecisionRow {
      name: string;
      action?: string;
      note?: string | null;
      by?: unknown;
      config?: typeof config;
      mandate?: string;
      draft?: Partial<DraftUnderDecision>;
      requests?: ForgeRequest[];
      refused: RegExp | null;
    }
    const refused = (why: string) => new RegExp(`--actor foreman refused: ${why}$`);
    const SCOPE = refused("only the Foreman's gate runner in forge dash records foreman decisions");
    const rows: DecisionRow[] = [
      { name: 'no authority', by: null, refused: SCOPE },
      { name: 'a lookalike object', by: {}, refused: SCOPE },
      { name: "a legacy assistant foreman's env", by: { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_assistant-1' }, refused: SCOPE },
      { name: 'the office env', by: { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_office' }, refused: SCOPE },
      { name: 'no note', note: '  ', refused: refused('a foreman decision needs --note with its reason') },
      { name: 'foreman.enabled false', config: off((c) => (c.foreman.enabled = false)), refused: refused('foreman\\.enabled is false') },
      { name: 'the class not in foreman.decides', config: off((c) => (c.foreman.decides = ['spec-approval'])), refused: refused('milestone-approval is not in foreman\\.decides') },
      { name: 'gate:milestone-approval reserved', config: off((c) => (c.foreman.reserved = ['gate:milestone-approval'])), refused: refused('milestone-approval is reserved \\(gate:milestone-approval\\): left for a human') },
      { name: "the mandate's decides leaves it out", mandate: 'g2', refused: refused("milestone-approval is not in mandate g2's decides: left for a human") },
      { name: 'the mandate file is a symlink', mandate: 'g3', refused: refused("mandate g3 can't be read \\(a symlink, not a regular file\\): left for a human") },
      { name: 'reject', action: 'reject', refused: refused('reject is not a milestone-approval action \\(approve, revise\\)') },
      { name: 'a stopped filing', draft: { gate: 'filing' }, refused: refused("retrying a stopped filing is a person's call") },
      { name: 'no in-progress gate request for the key', requests: [gate({ key: '2-other' }), { ...gate(), id: '3-gate', status: 'pending' }], refused: refused('no queued milestone-approval gate request for this draft') },
      { name: 'a gate request for another digest', requests: [gate({ digest: 'b'.repeat(64) })], refused: refused('no queued milestone-approval gate request for this draft') },
      { name: 'revise after two foreman revisions', action: 'revise', requests: [revision(1), revision(2), gate()], refused: refused('the foreman has revised this draft 2 times: left for a human') },
      { name: 'a reserved pattern in an issue title', draft: { texts: draftReservedTexts(goal, { ...MILESTONE_DRAFT, issues: [{ ...MILESTONE_DRAFT.issues[0], title: 'Payments retry' }] }) }, refused: refused('reserved \\(payments\\): left for a human') },
      { name: 'a reserved pattern in the goal', draft: { texts: draftReservedTexts({ goal: 'Ship payments faster' }, MILESTONE_DRAFT) }, refused: refused('reserved \\(payments\\): left for a human') },
      { name: 'approve', refused: null },
      { name: 'revise', action: 'revise', requests: [revision(1), gate()], refused: null },
    ];
    for (const row of rows) {
      const decide = () =>
        checkMandateGateDecision(
          r.dir,
          row.config ?? config,
          { id: row.mandate ?? 'g1' },
          { ...draft, ...row.draft },
          row.action ?? 'approve',
          row.note === undefined ? 'covers the goal' : row.note,
          'by' in row ? row.by : BY,
          row.requests ?? [gate()],
        );
      if (row.refused) assert.throws(decide, row.refused, row.name);
      else assert.equal(decide().id, '1-gate', row.name);
    }
  } finally {
    r.cleanup();
  }
});

/**
 * A repo whose root releases with a tag command, the foreman deciding `release` under ship release
 * (`payments` reserved), `v0.1.0` tagged and one commit after it.
 */
const releaseScratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['spec-approval', 'split-approval', 'release'], reserved: ['payments'] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  const cfg = path.join(dir, '.forge', 'config.yml');
  // Over the defaults: init write leaves keys at their default out of the file.
  const parsed = deepMerge(defaults(), yaml.parse(fs.readFileSync(cfg, 'utf8')));
  parsed.foreman.ship = 'release';
  parsed.release = { ...parsed.release, mechanism: 'tag', command: 'git tag v0.2.0' };
  fs.writeFileSync(cfg, yaml.stringify(parsed));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('add', '-A');
  git('commit', '-qm', 'forge');
  git('tag', 'v0.1.0');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'work');
});

const audit = (root: string): Record<string, any>[] => {
  const file = path.join(root, '.forge', 'runtime', 'audit.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const RELEASED = ['--milestones', 'M1', '--until', 'released', '--decides', 'release'];

/**
 * A foreman decision on mandate m1's release plan: every refusal records nothing, and no daemon session
 * starts, plans or arms a release. Each row changes one thing from the passing case.
 */
test("a foreman decision on a mandate's release", async () => {
  const r = releaseScratch();
  try {
    await cli(r.dir, ['mandate', 'new', 'm1', '--title', 'Ship it', ...RELEASED]);
    await cli(r.dir, ['mandate', 'new', 'narrow', '--title', 'narrow', '--milestones', 'M1', '--until', 'released', '--decides', 'split-approval']);
    for (const id of ['paused', 'closed', 'linked', 'jobs']) await cli(r.dir, ['mandate', 'new', id, '--title', id, ...RELEASED]);
    await cli(r.dir, ['mandate', 'new', 'pay', '--title', 'Payments release', ...RELEASED]);
    await cli(r.dir, ['mandate', 'pause', 'paused']);
    await cli(r.dir, ['mandate', 'close', 'closed']);
    fs.rmSync(path.join(mandates(r.dir), 'linked.md'));
    fs.symlinkSync(path.join(mandates(r.dir), 'm1.md'), path.join(mandates(r.dir), 'linked.md'));
    parkedAt(r.dir, 'spec-approval', { title: 'Payments retry', create: { mandate: 'jobs' } });
    const config = loadConfig(r.dir).config;
    const narrowFor = (c: typeof config) => (id: string) => mandateReleaseRefusal(r.dir, c, id);
    const planned = planMandateRelease(r.dir, config, 'm1', { narrow: narrowFor(config), actor: FOREMAN_ACTOR });
    assert.equal(planned.approval.owner, 'foreman');
    const hash = String(listRequests(r.dir).find((x) => x.id === planned.approval.request)?.args?.key);
    const files = releaseFiles(r.dir);
    const json = fs.readFileSync(files.json, 'utf8');
    const off = (patch: (c: any) => void) => {
      const c = structuredClone(config);
      patch(c);
      return c;
    };
    // assert.throws matches a RegExp against `${name}: ${message}`, so these anchor only at the end.
    const refused = (why: string) => new RegExp(`--actor foreman refused: ${why}$`);
    const SCOPE = refused("only the Foreman's gate runner in forge dash records foreman decisions");
    interface Row {
      name: string;
      id?: string;
      note?: string | null;
      by?: unknown;
      config?: typeof config;
      /** Changes the repo for this row; the returned function puts it back. */
      arrange?: () => () => void;
      refused: RegExp | null;
    }
    const plant = (edit: (p: any) => void) => () => {
      const p = JSON.parse(json);
      edit(p);
      fs.writeFileSync(files.json, JSON.stringify(p));
      return () => fs.writeFileSync(files.json, json);
    };
    const rows: Row[] = [
      { name: 'no authority', by: null, refused: SCOPE },
      { name: 'a lookalike object', by: {}, refused: SCOPE },
      { name: "a legacy assistant foreman's env", by: { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_assistant-1' }, refused: SCOPE },
      { name: 'the office env', by: { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_office' }, refused: SCOPE },
      { name: 'no note', note: '  ', refused: refused('a foreman decision needs --note with its reason') },
      { name: 'foreman.enabled false', config: off((c) => (c.foreman.enabled = false)), refused: refused('foreman\\.enabled is false') },
      { name: 'release not in foreman.decides', config: off((c) => (c.foreman.decides = ['spec-approval'])), refused: refused('release is not in foreman\\.decides') },
      { name: 'gate:release reserved', config: off((c) => (c.foreman.reserved = ['gate:release'])), refused: refused('release is reserved \\(gate:release\\): left for a human') },
      { name: "the mandate's decides leaves release out", id: 'narrow', refused: refused("release is not in mandate narrow's decides: left for a human") },
      { name: 'the mandate is paused', id: 'paused', refused: refused('mandate paused is paused: release left for a human') },
      { name: 'the mandate is closed', id: 'closed', refused: refused('mandate closed is closed: left for a human') },
      { name: 'the mandate file is a symlink', id: 'linked', refused: refused("mandate linked can't be read \\(a symlink, not a regular file\\): left for a human") },
      {
        name: 'ship merge caps until',
        config: off((c) => (c.foreman.ship = 'merge')),
        refused: refused('mandate m1: until released does not apply \\(until: released needs foreman\\.ship: release; merged applies\\): release left for a human'),
      },
      { name: "a reserved pattern in the mandate's title", id: 'pay', refused: refused('reserved \\(payments\\): left for a human') },
      { name: "a reserved pattern in a mandate job's title", id: 'jobs', refused: refused('reserved \\(payments\\): left for a human') },
      {
        name: 'no release.json',
        arrange: () => {
          fs.rmSync(files.json);
          return () => fs.writeFileSync(files.json, json);
        },
        refused: refused("no release plan; the Office pass plans mandate m1's release"),
      },
      { name: 'a release.json for a plain --since plan', arrange: plant((p) => delete p.selection.mandate), refused: refused("the release plan is not mandate m1's") },
      { name: "a release.json for another mandate's plan", arrange: plant((p) => (p.selection.mandate = 'other')), refused: refused("the release plan is not mandate m1's") },
      { name: 'a stale plan', config: off((c) => (c.release.command = 'git tag v0.3.0')), refused: /--actor foreman refused: the release plan is stale or edited: the release plan no longer matches/ },
      {
        name: "a hash that isn't the mandate's latest planned one",
        arrange: () => {
          logRepoEvent(r.dir, 'mandate-release-planned', { mandate: 'm1', planHash: 'b'.repeat(64), tag: 'v0.1.0', actor: FOREMAN_ACTOR });
          return () => logRepoEvent(r.dir, 'mandate-release-planned', { mandate: 'm1', planHash: hash, tag: 'v0.1.0', actor: FOREMAN_ACTOR });
        },
        refused: refused(`mandate m1's latest planned release is not plan ${hash.slice(0, 12)}`),
      },
      {
        name: 'no pending or in-progress gate request for the hash',
        arrange: () => {
          ackRequest(r.dir, planned.approval.request!, { status: 'done' });
          return () => enqueue(r.dir, config, { type: 'gate', job: null, args: { gate: 'release', mandate: 'm1', key: hash, reserved: null }, from: 'forge' });
        },
        refused: refused(`no queued release gate request for plan ${hash.slice(0, 12)}`),
      },
      { name: 'a reserved pattern in the note', note: 'fine, no payments change', refused: refused('reserved \\(payments\\): left for a human') },
      { name: 'approve', refused: null },
      { name: 'an already-approved plan', refused: refused(`plan ${hash.slice(0, 12)} is already approved`) },
    ];
    const approvals = () => audit(r.dir).filter((e) => e.type === 'mandate-release-approved');
    for (const row of rows) {
      const before = approvals().length;
      const undo = row.arrange?.();
      const c = row.config ?? config;
      const decide = () => approveMandateRelease(r.dir, c, row.id ?? 'm1', row.note === undefined ? 'the plan is fine' : row.note, narrowFor(c), row.by === undefined ? BY : row.by);
      try {
        if (row.refused) {
          assert.throws(decide, row.refused, row.name);
          assert.equal(approvals().length, before, `${row.name}: nothing recorded`);
        } else {
          assert.equal(decide(), hash, row.name);
          assert.deepEqual(approvals().map((e) => [e.mandate, e.planHash, e.note, e.actor]), [['m1', hash, 'the plan is fine', FOREMAN_ACTOR]]);
        }
      } finally {
        undo?.();
      }
    }
    // The approval starts nothing, and no daemon session arms or runs a release.
    assert.ok(!fs.existsSync(files.state), 'no state.json');
    const cliRows: [string, string[], NodeJS.ProcessEnv, RegExp][] = [
      ['approve without --actor foreman', ['mandate', 'release', 'approve', 'm1', '--note', 'ok'], OFFICE, /^approve is the foreman's \(--actor foreman\)/],
      ['approve without --actor foreman, outside the daemon', ['mandate', 'release', 'approve', 'm1', '--note', 'ok'], {}, /^approve is the foreman's \(--actor foreman\)/],
      ['approve from the office', ['mandate', 'release', 'approve', 'm1', '--actor', 'foreman', '--note', 'ok'], { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_office' }, SCOPE],
      ['approve outside the daemon', ['mandate', 'release', 'approve', 'm1', '--actor', 'foreman', '--note', 'ok'], {}, SCOPE],
      ['assist in a daemon session', ['mandate', 'release', 'assist', 'm1', '--request', planned.approval.request!], OFFICE, /^forge mandate release assist is for a person's own terminal/],
      ['release plan --mandate in a daemon session', ['release', 'plan', '--mandate', 'm1'], OFFICE, /^forge release plan --mandate re-plans a mandate's release/],
      ['release plan --mandate in a job session', ['release', 'plan', '--mandate', 'm1'], { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: 'some-job' }, /^forge release plan --mandate re-plans/],
      ['release run in a daemon session', ['release', 'run'], OFFICE, /^forge release run runs release and publish commands, which a daemon session may not do/],
    ];
    for (const [name, args, env, want] of cliRows) {
      const res = await forgeInProcess(r.dir, args, { env });
      assert.equal(res.status, 1, `${name}: ${JSON.stringify(res)}`);
      assert.match(res.error?.message ?? '', want, name);
    }
    assert.equal(approvals().length, 1, 'still one approval');
    assert.ok(!fs.existsSync(files.state), 'still no state.json');
  } finally {
    r.cleanup();
  }
});

test('a foreman mandate release approval stops counting once its mandate narrows', async () => {
  const r = releaseScratch();
  try {
    const config = loadConfig(r.dir).config;
    const hash = 'a'.repeat(64);
    const jobNarrow = (j: Job) => releaseMandateRefusal(r.dir, config, j);
    const rows: { name: string; id: string; then?: (id: string) => Promise<void> | void; config?: typeof config; counts: boolean }[] = [
      { name: 'the mandate still delegates release', id: 'kept', counts: true },
      { name: 'the mandate is narrowed', id: 'edited', then: (id) => cli(r.dir, ['mandate', 'edit', id, '--decides', 'split-approval']), counts: false },
      { name: 'the mandate is paused', id: 'halted', then: (id) => cli(r.dir, ['mandate', 'pause', id]), counts: false },
      { name: 'the mandate is closed', id: 'ended', then: (id) => cli(r.dir, ['mandate', 'close', id]), counts: false },
      { name: 'the mandate file was deleted', id: 'gone', then: (id) => fs.rmSync(path.join(mandates(r.dir), `${id}.md`)), counts: false },
      {
        name: 'the mandate file is a symlink',
        id: 'swapped',
        then: (id) => {
          fs.rmSync(path.join(mandates(r.dir), `${id}.md`));
          fs.symlinkSync(path.join(mandates(r.dir), 'kept.md'), path.join(mandates(r.dir), `${id}.md`));
        },
        counts: false,
      },
      { name: 'ship drops to merge', id: 'lowered', config: (() => {
        const c = structuredClone(config);
        c.foreman.ship = 'merge';
        return c;
      })(), counts: false },
    ];
    for (const row of rows) await cli(r.dir, ['mandate', 'new', row.id, '--title', row.id, '--milestones', 'M1', '--until', 'released', '--decides', 'split-approval,release']);
    for (const row of rows) {
      const plan = { selection: { kind: 'since' as const, tag: 'v0.1.0', mandate: row.id }, hash };
      logRepoEvent(r.dir, 'mandate-release-approved', { mandate: row.id, planHash: hash, note: 'the plan is fine', actor: FOREMAN_ACTOR });
      const narrow = (id: string) => mandateReleaseRefusal(r.dir, config, id);
      assert.ok(foremanReleaseApproval(r.dir, config, plan, jobNarrow, narrow), `${row.name}: counts before`);
      assert.equal(releaseApprovalStatus(r.dir, config, plan, jobNarrow, narrow).status, 'approved', `${row.name}: approved before`);
      assert.equal(foremanReleaseApproval(r.dir, config, plan, jobNarrow), null, `${row.name}: never without the mandate check (fail closed)`);
      await row.then?.(row.id);
      const c = row.config ?? config;
      const after = (id: string) => mandateReleaseRefusal(r.dir, c, id);
      if (row.counts) {
        assert.ok(foremanReleaseApproval(r.dir, c, plan, jobNarrow, after), `${row.name}: still counts`);
        assert.equal(releaseApprovalStatus(r.dir, c, plan, jobNarrow, after).status, 'approved', `${row.name}: still approved`);
      } else {
        assert.equal(foremanReleaseApproval(r.dir, c, plan, jobNarrow, after), null, `${row.name}: stops counting`);
        assert.deepEqual(releaseApprovalStatus(r.dir, c, plan, jobNarrow, after), { owner: 'human', status: 'pending' }, row.name);
      }
    }
    // An approval for mandate kept never stands for another mandate's plan or a plain --since plan of the
    // same tag: the hash covers selection.mandate, and the approval is matched by mandate and hash.
    const narrow = (id: string) => mandateReleaseRefusal(r.dir, config, id);
    await cli(r.dir, ['mandate', 'new', 'other', '--title', 'other', ...RELEASED]);
    assert.equal(foremanReleaseApproval(r.dir, config, { selection: { kind: 'since', tag: 'v0.1.0', mandate: 'other' }, hash }, jobNarrow, narrow), null, "another mandate's plan");
    assert.equal(foremanReleaseApproval(r.dir, config, { selection: { kind: 'since', tag: 'v0.1.0' }, hash }, jobNarrow, narrow), null, 'a plain --since plan');
    const body = { order: [], repos: [], skipped: [] };
    const hashes = [{ kind: 'since' as const, tag: 'v0.1.0', mandate: 'kept' }, { kind: 'since' as const, tag: 'v0.1.0', mandate: 'other' }, { kind: 'since' as const, tag: 'v0.1.0' }].map((selection) => planHash({ ...body, selection }));
    assert.equal(new Set(hashes).size, 3, 'each selection hashes differently');
  } finally {
    r.cleanup();
  }
});

test("gateOwner follows the job's mandate", async () => {
  const r = await arrange();
  try {
    ROWS.forEach((row, i) => {
      assert.equal(gateOwner(r.dir, r.config, loadJob(r.dir, r.jobs[i]), []), row.refused ? 'human' : 'foreman', row.name);
    });
  } finally {
    r.cleanup();
  }
});

const policy = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['spec-approval', 'escalation', 'rounds-exhausted', 'pr-feedback', 'release'], reserved: ['payments'] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

// The gate runner's authority passes only the authority check: every policy check still refuses with its own message.
test("with the runner's authority, the policy checks still refuse", () => {
  const r = policy();
  try {
    const config = loadConfig(r.dir).config;
    // assert.throws matches a RegExp against String(error), its name first, so these are unanchored.
    const refused = (why: string) => new RegExp(`--actor foreman refused: ${why.replace(/[()]/g, '\\$&')}`);
    const spec = parkedAt(r.dir, 'spec-approval').id;
    const insecure = withRound(r.dir, parkedAt(r.dir, 'escalation').id, 1, { code: 'PASS', security: 'CHANGES' }).id;
    const ceiling = parkedAt(r.dir, 'rounds-exhausted', { fields: { round: 50 } }).id;
    const head = 'a'.repeat(40);
    const pr = parkedAt(r.dir, 'pr-review', { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', headOid: head } }).id;
    enqueue(r.dir, config, { type: 'gate', job: pr, args: { gate: 'pr-feedback', key: 'b'.repeat(40), reserved: null }, from: 'forge' });
    // The moved escalation: parked in stage pr after the PR opened, the same gate class as in decide.
    const openPr = { number: 8, url: 'https://github.com/o/r/pull/8', state: 'OPEN' };
    const merging = parkedAt(r.dir, 'escalation', { stage: 'pr', reason: 'approver escalated: see decision.md', pr: openPr }).id;
    const insecureMerge = withRound(r.dir, parkedAt(r.dir, 'escalation', { stage: 'pr', reason: 'approver escalated: see decision.md', pr: openPr }).id, 1, { code: 'PASS', security: 'CHANGES' }).id;
    const rows: [string, string, string, string, RegExp | null][] = [
      ['a stage-pr escalation approved with a plain note', merging, 'approve', 'the change is sound', null],
      ['a stage-pr escalation approved with a note naming a reserved pattern', merging, 'approve', 'the payments change is sound', refused('reserved (payments): left for a human')],
      ['a stage-pr escalation approved past a security review of CHANGES', insecureMerge, 'approve', 'ship it', refused('reserved ((security review: CHANGES)): left for a human')],
      ['a reserved pattern in the note', spec, 'approve-spec', 'the payments flow is fine', refused('reserved (payments): left for a human')],
      ['an approve past a security review of CHANGES', insecure, 'approve', 'ship it', refused('reserved ((security review: CHANGES)): left for a human')],
      ['a rework past it', insecure, 'rework', 'fix the finding', null],
      ['a park past the total-round ceiling', ceiling, 'rework', 'one more round', refused('reserved ((total-round ceiling: only a human clears it)): left for a human')],
      ['pr-feedback with no gate request for the current head', pr, 'rework', 'address the threads', refused(`no queued pr-feedback gate request for ${pr}'s current PR head`)],
      ['an action not of the gate', spec, 'rework', 'fix it', refused('rework is not a spec-approval action (approve-spec, revise-spec)')],
    ];
    for (const [name, job, action, note, want] of rows) {
      const decide = () => checkForemanDecision(r.dir, config, loadJob(r.dir, job), action, note, {}, BY);
      if (want) assert.throws(decide, want, name);
      else assert.doesNotThrow(decide, name);
    }
    // Without the authority, every check refuses first, whatever else holds.
    const AUTHORITY = /--actor foreman refused: only the Foreman's gate runner in forge dash records foreman decisions$/;
    for (const by of [null, {}, { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_assistant-1' }]) {
      assert.throws(() => checkForemanDecision(r.dir, config, loadJob(r.dir, spec), 'approve-spec', 'fine', {}, by), AUTHORITY, `job: ${JSON.stringify(by)}`);
      assert.throws(() => checkReleaseDecision(r.dir, config, spec, 'fine', {}, () => null, by), AUTHORITY, `release: ${JSON.stringify(by)}`);
      assert.throws(() => checkMandateGateDecision(r.dir, config, { id: 'g1' }, { request: '1-a', digest: 'd'.repeat(64), gate: 'pending', texts: [] }, 'approve', 'fine', by, []), AUTHORITY, `mandate: ${JSON.stringify(by)}`);
    }
  } finally {
    r.cleanup();
  }
});
