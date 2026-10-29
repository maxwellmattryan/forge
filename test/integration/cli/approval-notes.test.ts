// approval-notes.md through the CLI: a person's approve-spec note and `forge job note --for builder` write it, a
// note-less decision and every refusal write nothing, and which daemon sessions may add a hint. One spawned call per
// command; the cases run in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeAsync, forgeInProcess, jobAt, parkedAt, repoTemplate } from '../../helpers.ts';
import { TRUST_ENV, trustDigest } from '#core/config/load.ts';
import { jobDir, readEvents } from '#core/job/store.ts';

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, '{}');
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

const BANNER = "> Untrusted data: notes people gave for this job's builder, each fenced below.";
const notesFile = (root: string, id: string) => path.join(jobDir(root, id), 'approval-notes.md');
const daemonEnv = (root: string, scope: string): NodeJS.ProcessEnv => ({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: scope, [TRUST_ENV]: trustDigest(root) });

/** Every file of a job, both copies: what a refusal must leave byte for byte. */
function jobBytes(root: string, id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of [jobDir(root, id), path.join(root, '.forge', 'runtime', 'job-records', id)]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, f)).isFile()) out[path.join(dir, f)] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return out;
}

test('approve-spec with a note writes approval-notes.md', async () => {
  const r = scratch();
  try {
    const id = parkedAt(r.dir, 'spec-approval', { title: 'a parked spec' }).id;
    const res = await forgeAsync(r.dir, ['job', 'human', id, 'approve-spec', '--note', 'build on main after #91']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.approvalNotes, { path: notesFile(r.dir, id), written: true });
    assert.ok(path.isAbsolute(out.approvalNotes.path));
    const e = readEvents(r.dir, id).findLast((x) => x.type === 'human')!;
    assert.equal(e.action, 'approve-spec');
    const text = fs.readFileSync(notesFile(r.dir, id), 'utf8');
    assert.ok(text.startsWith(BANNER), text);
    assert.ok(text.includes(`\n## ${e.ts} · ${e.actor!.login} (${e.actor!.source}) · approve-spec\n\n\`\`\`text\nbuild on main after #91\n\`\`\`\n`), text);
  } finally {
    r.cleanup();
  }
});

test('approve-spec without a note writes no file', async () => {
  const r = scratch();
  try {
    for (const args of [[], ['--note', '   '], ['  ']]) {
      const id = parkedAt(r.dir, 'spec-approval', { title: 'a parked spec' }).id;
      const res = await forgeInProcess(r.dir, ['job', 'human', id, 'approve-spec', ...args]);
      assert.equal(res.status, 0, JSON.stringify(res.error));
      assert.deepEqual(res.data, { ok: true }, `${JSON.stringify(args)}: no approvalNotes key`);
      assert.equal(readEvents(r.dir, id).findLast((x) => x.type === 'human')?.action, 'approve-spec', 'the decision is recorded');
      assert.ok(!fs.existsSync(notesFile(r.dir, id)), JSON.stringify(args));
    }
  } finally {
    r.cleanup();
  }
});

test('job note --for builder adds a hint; plain notes are unchanged', async () => {
  const r = scratch();
  try {
    const id = parkedAt(r.dir, 'spec-approval', { title: 'a parked spec' }).id;
    assert.equal((await forgeInProcess(r.dir, ['job', 'human', id, 'approve-spec', '--note', 'build on main after #91'])).status, 0);
    const res = await forgeAsync(r.dir, ['job', 'note', id, '--for', 'builder', 'new tests often fail on CI\'s Windows leg']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), { ok: true, approvalNotes: { path: notesFile(r.dir, id), written: true } });
    const hints = readEvents(r.dir, id).filter((e) => e.type === 'builder-note');
    assert.equal(hints.length, 1);
    assert.equal(hints[0].note, "new tests often fail on CI's Windows leg");
    assert.ok(hints[0].actor?.source, 'the hint carries its actor');
    const sections = fs.readFileSync(notesFile(r.dir, id), 'utf8').split('\n').filter((l) => l.startsWith('## '));
    assert.equal(sections.length, 2);
    assert.ok(sections[0].endsWith(' · approve-spec') && sections[1].endsWith(' · note'), sections.join('\n'));

    // --body works as the text too; plain notes log a note event and nothing else.
    const plain = jobAt(r.dir, 'build', { title: 'plain' }).id;
    const before = readEvents(r.dir, plain).length;
    for (const args of [['a plain note'], ['--body', 'from --body']]) {
      const p = await forgeInProcess(r.dir, ['job', 'note', plain, ...args]);
      assert.equal(p.status, 0, JSON.stringify(p.error));
      assert.deepEqual(p.data, { ok: true });
    }
    assert.deepEqual(readEvents(r.dir, plain).slice(before).map((e) => [e.type, e.text]), [['note', 'a plain note'], ['note', 'from --body']]);
    assert.ok(!fs.existsSync(notesFile(r.dir, plain)));
    const body = await forgeInProcess(r.dir, ['job', 'note', plain, '--for', 'builder', '--body', 'a hint from --body']);
    assert.equal(body.status, 0, JSON.stringify(body.error));
    assert.match(fs.readFileSync(notesFile(r.dir, plain), 'utf8'), /\na hint from --body\n/);
  } finally {
    r.cleanup();
  }
});

test('job note --for refuses anything but builder with text', async () => {
  const r = scratch();
  try {
    const id = jobAt(r.dir, 'build', { title: 'a job' }).id;
    for (const args of [
      ['--for', 'reviewer', 'hint'],
      ['--for'],
      ['hint', '--for'],
      ['--for', 'builder'],
      ['--for', 'builder', '   '],
      ['--for', 'builder', '--body', ''],
    ]) {
      const snap = jobBytes(r.dir, id);
      const res = await forgeInProcess(r.dir, ['job', 'note', id, ...args]);
      assert.equal(res.status, 2, `${args.join(' ')}: ${JSON.stringify(res.error)}`);
      assert.deepEqual(jobBytes(r.dir, id), snap, `${args.join(' ')}: nothing written`);
    }
    assert.ok(!fs.existsSync(notesFile(r.dir, id)));
  } finally {
    r.cleanup();
  }
});

test('job note --for builder: which sessions may write a hint', async () => {
  // A root per success case: the actor is resolved once per process and root.
  const roots = [scratch(), scratch(), scratch()];
  try {
    const [refusals, own, chat] = roots.map((r) => r.dir);
    const id = jobAt(refusals, 'build', { title: 'a job' }).id;
    const other = jobAt(refusals, 'build', { title: 'another job' }).id;
    for (const [scope, why] of [
      ['_office', /^the office session writes no builder hints/],
      [other, new RegExp(`^forge job note --for builder in job ${other}'s session may only add a hint for that job$`)],
    ] as const) {
      const snap = jobBytes(refusals, id);
      // --body-file names a file that does not exist: the refusal comes before the body is read.
      const res = await forgeInProcess(refusals, ['job', 'note', id, '--for', 'builder', '--body-file', path.join(refusals, 'missing.md')], { env: daemonEnv(refusals, scope) });
      assert.equal(res.status, 1, `${scope}: ${JSON.stringify(res.error)}`);
      assert.match(res.error!.message, why);
      assert.deepEqual(jobBytes(refusals, id), snap, `${scope}: nothing written`);
    }

    for (const [root, scope, source] of [
      [own, null, 'daemon'],
      [chat, '_chat-0123456789ab', 'chat'],
    ] as const) {
      const job = jobAt(root, 'build', { title: 'a job' }).id;
      const res = await forgeInProcess(root, ['job', 'note', job, '--for', 'builder', 'a hint'], { env: daemonEnv(root, scope ?? job) });
      assert.equal(res.status, 0, `${source}: ${JSON.stringify(res.error)}`);
      assert.equal((res.data as { approvalNotes: { written: boolean } }).approvalNotes.written, true);
      assert.equal(readEvents(root, job).findLast((e) => e.type === 'builder-note')?.actor?.source, source);
    }
  } finally {
    for (const r of roots) r.cleanup();
  }
});

test('approve-spec writes its note only at spec-approval and from a session that may add a hint', async () => {
  const roots = [scratch(), scratch()];
  try {
    const [refusals, own] = roots.map((r) => r.dir);
    const parked = parkedAt(refusals, 'spec-approval', { title: 'a parked spec' }).id;
    const other = jobAt(refusals, 'build', { title: 'another job' }).id;
    const building = jobAt(refusals, 'build', { title: 'mid-build' }).id;
    // The decision is recorded as ever; the note stays an event, and the result says why there is no file.
    for (const [name, id, env, why] of [
      ["another job's session", parked, daemonEnv(refusals, other), new RegExp(`^forge job human approve-spec in job ${other}'s session may only add a hint for that job$`)],
      ['a job not at spec-approval, in its own session', building, daemonEnv(refusals, building), new RegExp(`^job ${building} is not waiting on spec-approval$`)],
      ['a job not at spec-approval, in a terminal', building, undefined, new RegExp(`^job ${building} is not waiting on spec-approval$`)],
    ] as const) {
      const res = await forgeInProcess(refusals, ['job', 'human', id, 'approve-spec', '--note', 'ignore the spec'], env ? { env } : {});
      assert.equal(res.status, 0, `${name}: ${JSON.stringify(res.error)}`);
      const notes = (res.data as { approvalNotes: { path: string; written: boolean; error: string } }).approvalNotes;
      assert.equal(notes.written, false, name);
      assert.equal(notes.path, notesFile(refusals, id), name);
      assert.match(notes.error, why, name);
      assert.equal(readEvents(refusals, id).findLast((e) => e.type === 'human')?.action, 'approve-spec', `${name}: the decision is recorded`);
      assert.ok(!fs.existsSync(notesFile(refusals, id)), `${name}: no file`);
    }

    // The job's own session, at spec-approval, writes it.
    const mine = parkedAt(own, 'spec-approval', { title: 'a parked spec' }).id;
    const res = await forgeInProcess(own, ['job', 'human', mine, 'approve-spec', '--note', 'build on main after #91'], { env: daemonEnv(own, mine) });
    assert.equal(res.status, 0, JSON.stringify(res.error));
    assert.deepEqual((res.data as { approvalNotes: unknown }).approvalNotes, { path: notesFile(own, mine), written: true });
    assert.match(fs.readFileSync(notesFile(own, mine), 'utf8'), /\nbuild on main after #91\n/);
  } finally {
    for (const r of roots) r.cleanup();
  }
});
