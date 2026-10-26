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
import { jobDir, loadJob, readEvents } from '#core/job/store.ts';
import { checkForemanDecision, gateOwner } from './foreman.ts';

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
  { name: 'the mandate is closed', mandate: 'closed', then: (root) => cli(root, ['mandate', 'close', 'closed']), refused: notIn('closed') },
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
  await cli(r.dir, ['mandate', 'new', 'wide', '--title', 'wide', '--milestones', 'M1', '--decides', 'spec-approval,split-approval,release']);
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
