// `forge mandate cancel` and `forge mandate delete` end to end: cancel closes a mandate and queues one cancel
// request per unfinished job, leaving merged and cancelled jobs byte-identical; delete removes only a closed
// mandate's file and runtime dir, never through a link, refuses an open mandate and one another follows, and
// the deleted id can't be taken again while a job names it. Each logs one audit event `forge audit` lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeInProcess, jobAt, parkedAt, repoTemplate } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { loadJob } from '#core/job/store.ts';

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['spec-approval'], reserved: [] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

async function ok(root: string, args: string[]): Promise<any> {
  const r = await forgeInProcess(root, args);
  assert.equal(r.status, 0, `${args.join(' ')}: ${JSON.stringify(r.error)}`);
  return r.data;
}

const forgeDir = (root: string, ...p: string[]) => path.join(root, '.forge', ...p);
const mandatesDir = (root: string) => forgeDir(root, 'runtime', 'mandates');
const requestsDir = (root: string) => forgeDir(root, 'runtime', 'requests');
const auditFile = (root: string) => forgeDir(root, 'runtime', 'audit.jsonl');
const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const auditEvents = (root: string, type: string) =>
  read(auditFile(root))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === type);

/** Every entry under `dir` with its bytes (a link as its target, a dir as `dir`): what a write must leave alone. */
function tree(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const f of (fs.readdirSync(dir, { recursive: true }) as string[]).sort()) {
    const p = path.join(dir, f);
    const st = fs.lstatSync(p);
    out[f] = st.isSymbolicLink() ? `link ${fs.readlinkSync(p)}` : st.isDirectory() ? 'dir' : fs.readFileSync(p, 'utf8');
  }
  return out;
}

/** `forge audit` over every row so far: an explicit --until, since the default (now) can fall in the last event's millisecond. */
const AUDIT = ['audit', '--since', '2000-01-01', '--until', '2999-01-01'];

/** A job's folder and its CLI record, bytes. */
const jobBytes = (root: string, id: string) => ({ folder: tree(forgeDir(root, 'jobs', id)), record: tree(forgeDir(root, 'runtime', 'job-records', id)) });

test('forge mandate cancel closes the mandate and queues a cancel for each unfinished job', async () => {
  const r = scratch();
  try {
    const root = r.dir;
    const config = loadConfig(root).config;
    await ok(root, ['mandate', 'new', 'm1', '--title', 'M1', '--milestones', 'M1']);
    await ok(root, ['mandate', 'new', 'm2', '--title', 'M2', '--milestones', 'M2']);
    const m1 = { create: { mandate: 'm1' } };
    const queued = (await ok(root, ['job', 'new', '--title', 'queued', '--mandate', 'm1'])).id as string;
    const running = jobAt(root, 'build', { ...m1, title: 'running' }).id;
    const waiting = parkedAt(root, 'spec-approval', { ...m1, title: 'waiting' }).id;
    const shelved = jobAt(root, 'decide', { ...m1, title: 'shelved', state: 'waiting', waitingOn: 'shelved' }).id;
    const failed = jobAt(root, 'build', { ...m1, title: 'failed', state: 'failed' }).id;
    const done = jobAt(root, 'done', { ...m1, title: 'merged' }).id;
    const cancelled = jobAt(root, 'build', { ...m1, title: 'cancelled', state: 'cancelled' }).id;
    const pending = jobAt(root, 'build', { ...m1, title: 'already cancelling' }).id;
    const earlier = enqueue(root, config, { type: 'cancel', job: pending, text: 'by hand', from: 'dashboard' });
    const other = jobAt(root, 'build', { create: { mandate: 'm2' }, title: 'other mandate' }).id;
    const untouched = { done: jobBytes(root, done), cancelled: jobBytes(root, cancelled) };

    // AC1: the close, and one cancel request per unfinished m1 job, in job id order.
    const out = await ok(root, ['mandate', 'cancel', 'm1', '--reason', 'R']);
    assert.deepEqual([out.ok, out.changed, out.mandate.id, out.mandate.status, out.mandate.reason], [true, true, 'm1', 'closed', 'cancelled: R']);
    assert.ok(out.mandate.closedAt, 'cancel sets closedAt');
    const want = [queued, running, waiting, shelved, failed].sort();
    assert.deepEqual(
      out.cancelled.map((c: { job: string }) => c.job),
      want,
    );
    const requests = listRequests(root).filter((x) => x.type === 'cancel' && x.id !== earlier.id);
    assert.deepEqual(
      requests.map((x) => ({ id: x.id, job: x.job, from: x.from, text: x.text, status: x.status })).sort((a, b) => a.job!.localeCompare(b.job!)),
      out.cancelled.map((c: { job: string; request: string }) => ({ id: c.request, job: c.job, from: 'cli', text: 'mandate m1 cancelled: R', status: 'pending' })),
    );
    for (const id of [done, cancelled, pending, other]) assert.ok(!requests.some((x) => x.job === id), `no cancel queued for ${id}`);
    assert.deepEqual({ done: jobBytes(root, done), cancelled: jobBytes(root, cancelled) }, untouched, 'merged and cancelled jobs byte-identical');
    assert.equal(loadJob(root, other).state, 'running');

    // AC2: applying one moves the job to cancelled with the mandate's reason.
    const rid = out.cancelled.find((c: { job: string }) => c.job === running).request as string;
    const applied = await ok(root, ['job', 'apply', running, '--request', rid, '--session', 'me']);
    assert.equal(applied.status, 'done', JSON.stringify(applied));
    const after = loadJob(root, running);
    assert.deepEqual([after.state, after.reason], ['cancelled', 'mandate m1 cancelled: R']);

    // Again: nothing new, and no second event.
    const again = await ok(root, ['mandate', 'cancel', 'm1']);
    assert.deepEqual([again.changed, again.cancelled, again.mandate.reason], [false, [], 'cancelled: R']);
    assert.equal(listRequests(root).filter((x) => x.type === 'cancel').length, want.length + 1);
    const retros = listRequests(root).filter((x) => x.type === 'retro');
    assert.deepEqual(
      retros.map((x) => x.args?.mandate),
      ['m1'],
      'one retro over m1',
    );

    // AC3: one mandate-cancel event, listed by forge audit with the mandate as its detail.
    const events = auditEvents(root, 'mandate-cancel');
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].mandate, events[0].reason, events[0].jobs], ['m1', 'cancelled: R', want]);
    assert.equal(typeof events[0].actor?.source, 'string');
    assert.equal(auditEvents(root, 'mandate-close').length, 0, 'the close is the cancel event');
    const audit = await ok(root, AUDIT);
    assert.deepEqual(
      (audit.rows as { action: string; detail: string | null }[]).filter((x) => x.action === 'mandate-cancel').map((x) => x.detail),
      ['m1'],
    );

    // No reason: `cancelled`; an unknown mandate is not_found and writes nothing.
    await ok(root, ['mandate', 'new', 'm3', '--title', 'M3', '--milestones', 'M3']);
    assert.equal((await ok(root, ['mandate', 'cancel', 'm3'])).mandate.reason, 'cancelled');
    const nope = await forgeInProcess(root, ['mandate', 'cancel', 'nope']);
    assert.deepEqual([nope.status, nope.error?.code], [1, 'not_found'], JSON.stringify(nope.error));
  } finally {
    r.cleanup();
  }
});

test('forge mandate delete removes only a closed mandate\'s file and runtime folder', async () => {
  const r = scratch();
  try {
    const root = r.dir;
    const dir = mandatesDir(root);
    for (const id of ['live', 'held', 'gone', 'keep', 'lead', 'linked']) await ok(root, ['mandate', 'new', id, '--title', id, '--milestones', 'M1']);
    await ok(root, ['mandate', 'new', 'next', '--title', 'next', '--milestones', 'M1', '--after', 'lead']);
    await ok(root, ['mandate', 'pause', 'held']);
    const job = jobAt(root, 'build', { create: { mandate: 'gone' }, title: 'in gone' }).id;
    for (const id of ['gone', 'keep', 'lead', 'linked']) await ok(root, ['mandate', 'close', id]);
    // Runtime dirs: one with a file and a link to a file outside the mandates dir, one beside it, and one that is a link itself.
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'keep me\n');
    fs.mkdirSync(path.join(dir, 'gone'));
    fs.writeFileSync(path.join(dir, 'gone', 'summary.json'), '{}\n');
    fs.symlinkSync(outside, path.join(dir, 'gone', 'planted'));
    fs.mkdirSync(path.join(dir, 'keep'));
    fs.writeFileSync(path.join(dir, 'keep', 'summary.json'), '{"keep":true}\n');
    const target = path.join(root, 'elsewhere');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'file.txt'), 'still here\n');
    fs.symlinkSync(target, path.join(dir, 'linked'));

    const state = () => ({ mandates: tree(dir), audit: read(auditFile(root)), requests: tree(requestsDir(root)), jobs: tree(forgeDir(root, 'jobs')), records: tree(forgeDir(root, 'runtime', 'job-records')) });

    // AC4 and AC6: an active, a paused and a followed mandate are refused, and nothing is written.
    const refusals: [string, string][] = [
      ['live', 'mandate live is active: only a closed mandate can be deleted (forge mandate close or cancel first)'],
      ['held', 'mandate held is paused: only a closed mandate can be deleted (forge mandate close or cancel first)'],
      ['lead', 'mandate next follows lead (after) and is not closed; change its --after first'],
    ];
    for (const [id, message] of refusals) {
      const before = state();
      const res = await forgeInProcess(root, ['mandate', 'delete', id]);
      assert.deepEqual([res.status, res.error?.message], [1, message], id);
      assert.deepEqual(state(), before, `${id}: nothing written`);
    }

    // AC5: the closed mandate's file and runtime dir go; nothing else does.
    const before = state();
    const out = await ok(root, ['mandate', 'delete', 'gone']);
    assert.deepEqual(out, { ok: true, deleted: 'gone', jobs: [job] });
    const after = state();
    const kept = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'gone.md' && k !== 'gone' && !k.startsWith(`gone${path.sep}`)));
    assert.deepEqual(after.mandates, kept(before.mandates), 'only gone.md and gone/ are removed');
    assert.ok(!('gone.md' in after.mandates) && !('gone' in after.mandates));
    assert.equal(read(outside), 'keep me\n', 'the link inside was removed, its target was not');
    assert.deepEqual([after.requests, after.jobs, after.records], [before.requests, before.jobs, before.records], 'requests, job folders and records unchanged');
    const shown = await forgeInProcess(root, ['mandate', 'show', 'gone']);
    assert.deepEqual([shown.status, shown.error?.code], [1, 'not_found']);
    assert.equal(loadJob(root, job).mandate, 'gone', 'the job keeps its mandate');

    // A link at the runtime dir's path is removed, its target is not.
    await ok(root, ['mandate', 'delete', 'linked']);
    assert.ok(!fs.existsSync(path.join(dir, 'linked')) && !fs.existsSync(path.join(dir, 'linked.md')));
    assert.equal(read(path.join(target, 'file.txt')), 'still here\n');

    // AC3: one mandate-delete event per delete, listed by forge audit.
    const events = auditEvents(root, 'mandate-delete');
    assert.deepEqual(
      events.map((e) => [e.mandate, e.jobs]),
      [
        ['gone', 1],
        ['linked', 0],
      ],
    );
    for (const e of events) assert.equal(typeof e.actor?.source, 'string');
    const audit = await ok(root, AUDIT);
    assert.deepEqual(
      (audit.rows as { action: string; detail: string | null }[]).filter((x) => x.action === 'mandate-delete').map((x) => x.detail),
      ['gone', 'linked'],
    );

    // AC9: the deleted id is not taken again while a job names it; an id no job names is.
    const reuse = await forgeInProcess(root, ['mandate', 'new', 'gone', '--title', 'again', '--milestones', 'M1', '--decides', 'spec-approval']);
    assert.deepEqual([reuse.status, reuse.error?.message], [1, "mandate id gone is still named by 1 jobs (a deleted mandate's); pick another id"]);
    assert.ok(!fs.existsSync(path.join(dir, 'gone.md')), 'no file written');
    assert.equal((await ok(root, ['mandate', 'new', 'linked', '--title', 'again', '--milestones', 'M1'])).mandate.id, 'linked');

    // An unknown id is not_found.
    const nope = await forgeInProcess(root, ['mandate', 'delete', 'nope']);
    assert.deepEqual([nope.status, nope.error?.code], [1, 'not_found']);
  } finally {
    r.cleanup();
  }
});
