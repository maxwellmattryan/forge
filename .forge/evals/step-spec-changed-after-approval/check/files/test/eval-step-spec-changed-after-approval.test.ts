// Hidden check for .forge/evals/step-spec-changed-after-approval: a spec edited after a human
// approved it goes back to the spec gate until it is approved again. Black-box: drives bin/forge.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { json, scratch } from './eval-check-harness.ts';
import type { Scratch } from './eval-check-harness.ts';

const SPEC = '# Hello script\n\nSize: S\n\n## Goal\nAdd hello.sh that prints hi.\n\n## Acceptance criteria\n- AC1: hello.sh prints hi\n';
const CHANGED = 'spec changed since approval';

interface Job {
  s: Scratch;
  id: string;
  spec: string;
  step: () => Promise<any>;
  f: (...args: string[]) => Promise<any>;
}

async function newJob(specApproval: string): Promise<Job> {
  const s = scratch({ tracker: { kind: 'none' }, pr: { enabled: false }, pipeline: { specApproval } });
  const f = async (...args: string[]) => {
    const r = await s.forge(args);
    assert.equal(r.status, 0, `forge ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
    return json(r);
  };
  const created = await f('job', 'new', '--title', 'Add a hello script', '--body', 'Add hello.sh that prints hi.');
  const spec = path.join(s.dir, '.forge', 'jobs', created.id, 'spec.md');
  return { s, id: created.id, spec, f, step: () => f('job', 'step', created.id) };
}

const isBuild = (a: any) => a.action === 'run' && a.command[1] === 'set' && a.command.includes('--stage') && a.command[a.command.indexOf('--stage') + 1] === 'build';
const flag = (a: any, name: string) => (Array.isArray(a.command) && a.command.includes(name) ? a.command[a.command.indexOf(name) + 1] : undefined);

/**
 * Runs step's `run` actions and plays the spec-writer until the job waits at the spec gate (or, with
 * no gate, until step would move it to build). Returns that last action without running it.
 */
async function toSpecGate(j: Job): Promise<any> {
  for (let n = 0; n < 20; n++) {
    const a = await j.step();
    if (a.action === 'wait' || isBuild(a)) return a;
    if (a.action === 'run') {
      await j.f(...a.command);
      continue;
    }
    assert.equal(a.action, 'spawn', JSON.stringify(a));
    assert.equal(a.role, 'spec-writer', JSON.stringify(a));
    await j.f('job', 'agent', j.id, 'start', '--role', 'spec-writer');
    fs.writeFileSync(j.spec, SPEC);
    await j.f('job', 'agent', j.id, 'end', '--role', 'spec-writer');
  }
  throw new Error('never reached the spec gate');
}

/** reference/commands.md's spec-approval answer: approve, then resume the job. */
async function approve(j: Job): Promise<void> {
  await j.f('job', 'human', j.id, 'approve-spec', '--note', 'ok');
  await j.f('job', 'set', j.id, '--state', 'running');
}

describe('a spec edited after its approval', { concurrency: 3 }, () => {
  test('an unchanged approved spec moves on to build, even with a newer mtime', async () => {
    const j = await newJob('always');
    try {
      const gate = await toSpecGate(j);
      assert.equal(gate.waitingOn, 'spec-approval', JSON.stringify(gate));
      await approve(j);
      let a = await j.step();
      assert.ok(isBuild(a), `expected a move to build, got ${JSON.stringify(a)}`);
      // Content, not mtime: the same bytes written again are not a change.
      fs.writeFileSync(j.spec, SPEC);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(j.spec, later, later);
      a = await j.step();
      assert.ok(isBuild(a), `an identical rewrite still moves to build, got ${JSON.stringify(a)}`);
    } finally {
      j.s.cleanup();
    }
  });

  test('an edited approved spec parks for spec approval, and a fresh approval moves it on', async () => {
    const j = await newJob('always');
    try {
      assert.equal((await toSpecGate(j)).waitingOn, 'spec-approval');
      await approve(j);
      // A content change that keeps the header, so nothing but the content differs.
      fs.appendFileSync(j.spec, '- AC2: hello.sh also prints bye\n');
      let a = await j.step();
      assert.equal(a.action, 'run', JSON.stringify(a));
      assert.ok(!isBuild(a), `must not move to build: ${JSON.stringify(a)}`);
      assert.equal(flag(a, '--state'), 'waiting', JSON.stringify(a));
      assert.equal(flag(a, '--waiting-on'), 'spec-approval', JSON.stringify(a));
      assert.equal(flag(a, '--reason'), CHANGED, JSON.stringify(a));
      await j.f(...a.command);
      a = await j.step();
      assert.equal(a.action, 'wait', JSON.stringify(a));
      assert.equal(a.waitingOn, 'spec-approval');
      const shown = await j.f('job', 'show', j.id);
      assert.equal((shown.job ?? shown).reason, CHANGED, 'the job says why it waits');
      await approve(j);
      a = await j.step();
      assert.ok(isBuild(a), `a fresh approval moves it on, got ${JSON.stringify(a)}`);
      // With spec approval off, the rule does not apply: another edit is not re-gated.
      await j.f('config', 'set', 'pipeline.specApproval', 'never');
      fs.appendFileSync(j.spec, '- AC3: hello.sh exits 0\n');
      a = await j.step();
      assert.ok(isBuild(a), `with specApproval never, expected a move to build, got ${JSON.stringify(a)}`);
    } finally {
      j.s.cleanup();
    }
  });

  test('a spec the spec-writer rewrote after revise-spec goes through the usual gate', async () => {
    const j = await newJob('always');
    try {
      await toSpecGate(j);
      await approve(j);
      await j.f('job', 'human', j.id, 'revise-spec', '--note', 'also bye');
      await j.f('job', 'set', j.id, '--stage', 'spec', '--state', 'running');
      let a = await j.step();
      assert.equal(a.action, 'spawn', JSON.stringify(a));
      assert.equal(a.role, 'spec-writer');
      await j.f('job', 'agent', j.id, 'start', '--role', 'spec-writer');
      fs.writeFileSync(j.spec, `${SPEC}- AC2: hello.sh also prints bye\n`);
      await j.f('job', 'agent', j.id, 'end', '--role', 'spec-writer');
      a = await toSpecGate(j);
      assert.equal(a.waitingOn, 'spec-approval', JSON.stringify(a));
      const shown = await j.f('job', 'show', j.id);
      assert.equal((shown.job ?? shown).reason, 'spec ready');
    } finally {
      j.s.cleanup();
    }
  });
});
