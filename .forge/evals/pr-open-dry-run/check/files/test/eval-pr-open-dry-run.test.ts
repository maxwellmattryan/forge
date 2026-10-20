// Hidden check for the `pr-open-dry-run` eval task: `forge pr open <id> --dry-run` runs the open's
// checks, prints the plan, and pushes nothing, calls no gh and leaves the job as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scratch, json } from './eval-check-harness.ts';
import type { Scratch } from './eval-check-harness.ts';

interface Setup {
  s: Scratch;
  id: string;
  wt: string;
  bare: string;
  marker: string;
  env: NodeJS.ProcessEnv;
  jobDir: string;
  cleanup: () => void;
}

async function setup(): Promise<Setup> {
  const s = scratch({ verify: ['test'] });
  const bare = `${s.dir}.remote.git`;
  const bin = `${s.dir}.bin`;
  const marker = path.join(`${s.dir}.marker`, 'gh-called');
  const cleanup = () => {
    s.cleanup();
    for (const p of [bare, bin, path.dirname(marker)]) fs.rmSync(p, { recursive: true, force: true });
  };
  try {
    fs.mkdirSync(bin);
    fs.mkdirSync(path.dirname(marker));
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['init', '-q', '--bare', bare]);
    s.git('remote', 'add', 'origin', bare);
    s.git('push', '-q', 'origin', 'main');
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const job = json(await s.forge(['job', 'new', '--title', 'Add a greeting'], env));
    const id: string = job.id;
    const created = await s.forge(['worktree', 'create', id], env);
    assert.equal(created.status, 0, created.stderr + created.stdout);
    const wt: string = json(created).path;
    fs.writeFileSync(path.join(wt, 'greet.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=eval@example.com', '-c', 'user.name=Eval', 'commit', '-qm', 'Add greeting'], { cwd: wt });
    const jobDir = path.join(s.dir, '.forge', 'jobs', id);
    return { s, id, wt, bare, marker, env, jobDir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

const snapshot = (jobDir: string) => ({
  job: fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'),
  events: fs.existsSync(path.join(jobDir, 'events.jsonl')) ? fs.readFileSync(path.join(jobDir, 'events.jsonl'), 'utf8') : '',
});

const remoteHeads = (bare: string) => execFileSync('git', ['ls-remote', '--heads', bare], { encoding: 'utf8' });

test('pr open --dry-run on a verified head prints the plan and changes nothing', async () => {
  const t = await setup();
  try {
    const verified = await t.s.forge(['verify', t.id], t.env);
    assert.equal(verified.status, 0, verified.stderr + verified.stdout);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: t.wt, encoding: 'utf8' }).trim();
    const job = JSON.parse(fs.readFileSync(path.join(t.jobDir, 'job.json'), 'utf8'));
    const before = snapshot(t.jobDir);

    const r = await t.s.forge(['pr', 'open', t.id, '--dry-run', '--draft', '--title', 'Greeting: say hello'], t.env);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = json(r);
    assert.equal(out.dryRun, true);
    assert.equal(out.title, 'Greeting: say hello');
    assert.equal(typeof out.body, 'string');
    assert.ok(out.body.length > 0, 'the body is the text the PR would get');
    assert.equal(out.base, 'main');
    assert.equal(out.head, job.branch);
    assert.equal(out.draft, true);
    assert.equal(out.commit, head);

    // Without --title and --draft: the job title, and not a draft (pr.draft defaults to false).
    const plain = json(await t.s.forge(['pr', 'open', t.id, '--dry-run'], t.env));
    assert.equal(plain.title, 'Add a greeting');
    assert.equal(plain.draft, false);
    assert.equal(plain.commit, head);

    assert.ok(!fs.existsSync(t.marker), `gh was called: ${fs.existsSync(t.marker) ? fs.readFileSync(t.marker, 'utf8') : ''}`);
    assert.ok(!remoteHeads(t.bare).includes(job.branch), 'the job branch was pushed');
    const after = snapshot(t.jobDir);
    assert.equal(after.job, before.job, 'job.json changed');
    assert.equal(after.events, before.events, 'events.jsonl changed');
  } finally {
    t.cleanup();
  }
});

test('pr open --dry-run refuses an unverified head as pr open does', async () => {
  const t = await setup();
  try {
    const job = JSON.parse(fs.readFileSync(path.join(t.jobDir, 'job.json'), 'utf8'));
    const real = await t.s.forge(['pr', 'open', t.id, '--json'], t.env);
    assert.equal(real.status, 1, real.stderr + real.stdout);
    const before = snapshot(t.jobDir);

    const r = await t.s.forge(['pr', 'open', t.id, '--dry-run', '--json'], t.env);
    assert.equal(r.status, real.status, r.stderr + r.stdout);
    const err = json(r).error;
    assert.ok(err, 'an error reply');
    assert.equal(err.code, json(real).error.code);
    assert.match(err.message, /not verified/);

    assert.ok(!fs.existsSync(t.marker), 'gh was called');
    assert.ok(!remoteHeads(t.bare).includes(job.branch), 'the job branch was pushed');
    const after = snapshot(t.jobDir);
    assert.equal(after.job, before.job, 'job.json changed');
    assert.equal(after.events, before.events, 'events.jsonl changed');
  } finally {
    t.cleanup();
  }
});
