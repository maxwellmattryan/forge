// A mandate only ever narrows what the Foreman decides: checkForemanDecision, `forge job human approve-release`
// and gateOwner read the job's mandate from the CLI's record of the job, and a mandate file that is gone or
// can't be read delegates nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeInProcess, parkedAt, repoTemplate } from '../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { jobDir, loadJob, logHumanEvent, readEvents, setJob } from '#core/job/store.ts';
import { FOREMAN_ACTOR } from '#integrations/github/actor.ts';
import { foremanReleaseApproval, releaseApprovalStatus } from '#engine/release/approval.ts';
import { checkForemanDecision, gateOwner, releaseMandateRefusal } from './foreman.ts';
import type { Job } from '#core/types.ts';

const OFFICE: NodeJS.ProcessEnv = { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_assistant-1' };

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
      const decide = () => checkForemanDecision(r.dir, r.config, job, 'approve-spec', 'the spec is ready', {}, OFFICE);
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
      const res = await forgeInProcess(r.dir, ['job', 'human', r.jobs[i], 'approve-release', '--actor', 'foreman', '--note', 'the plan is fine'], { env: OFFICE });
      assert.equal(res.status, 1, row.name);
      assert.match(res.error?.message ?? '', row.refused ? row.refused('release') : /--actor foreman refused: no release plan; a human runs forge release plan --job first/, row.name);
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
    const res = await forgeInProcess(r.dir, ['job', 'human', job, 'approve-release', '--actor', 'foreman', '--note', 'ok'], { env: OFFICE });
    assert.equal(res.status, 1);
    assert.match(res.error?.message ?? '', /--actor foreman refused: mandate resting is paused: release left for a human/);
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
    const decide = () => checkForemanDecision(r.dir, config, loadJob(r.dir, id), 'approve', 'the decision is sound', {}, OFFICE);
    const assist = () => forgeInProcess(r.dir, ['job', 'assist', id, '--gate', 'escalation'], { env: OFFICE });
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
