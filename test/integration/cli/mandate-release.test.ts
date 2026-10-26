// An `until: released` mandate through the CLI, in a scratch repo whose root releases with a tag command
// pushed to a local origin: once its job is done the Office pass plans the release since the root's last
// tag and waits; an assistant foreman approves it; a run without a terminal publishes on that approval and
// the next pass closes the mandate. A merge after the approval makes the plan stale, so the approval stops
// counting. With `gate:release` reserved the plan stays a person's, and `forge
// release plan --mandate` re-plans only what the pass planned first. Serial: the daemon rows set
// process.env through forgeInProcess.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeInProcess, jobAt, repoTemplate } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import * as yaml from '#core/format/yaml.ts';
import { claimRequest, listRequests } from '#core/job/requests.ts';
import { releaseFiles } from '#engine/release/files.ts';
import { runRelease } from '#engine/release/run.ts';
import { mandateReleaseRefusal, releaseMandateRefusal } from '#office/foreman.ts';
import { readSummary, runOfficePass } from '#office/mandates/pass.ts';
import type { QueueNotify } from '#office/notify.ts';
import type { Config, Job } from '#core/types.ts';

const ASSISTANT: NodeJS.ProcessEnv = { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_assistant-1' };
const COMMAND = 'git tag v0.2.0 && git push -q origin HEAD:refs/heads/main refs/tags/v0.2.0';

/** Edits .forge/config.yml as a person would. */
function editConfig(dir: string, edit: (c: any) => void): void {
  const file = path.join(dir, '.forge', 'config.yml');
  const c = yaml.parse(fs.readFileSync(file, 'utf8'));
  edit(c);
  fs.writeFileSync(file, yaml.stringify(c));
}

/**
 * The foreman on with ship release and `release` decided (nothing reserved), the root releasing with
 * COMMAND, `.forge/` committed, v0.1.0 tagged and pushed, then one more commit pushed.
 */
const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['spec-approval', 'release'], reserved: [], assistants: { enabled: true } } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  editConfig(dir, (c) => {
    c.foreman.ship = 'release';
    c.release = { ...c.release, mechanism: 'tag', command: COMMAND };
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('add', '-A');
  git('commit', '-qm', 'forge');
  git('tag', 'v0.1.0');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'work');
});

/** A copy of the template with its own bare origin (a copied remote URL would point at the template's). */
function scratch(t: test.TestContext) {
  const r = template();
  t.after(r.cleanup);
  const bare = path.join(r.dir, '.git', 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
  r.git('remote', 'add', 'origin', bare);
  r.git('push', '-q', 'origin', 'main', 'refs/tags/v0.1.0');
  return { ...r, bare };
}

/** Commits and pushes a config edit, so the clone stays clean and level with origin for preflight. */
function commitConfig(r: ReturnType<typeof scratch>, edit: (c: any) => void): void {
  editConfig(r.dir, edit);
  r.git('commit', '-qam', 'config');
  r.git('push', '-q', 'origin', 'main');
}

async function ok(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<any> {
  const res = await forgeInProcess(root, args, env ? { env } : {});
  assert.equal(res.status, 0, `${args.join(' ')}: ${JSON.stringify(res.error)}`);
  return res.data;
}

const audit = (root: string): Record<string, any>[] => {
  const file = path.join(root, '.forge', 'runtime', 'audit.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const events = (root: string, type: string) => audit(root).filter((e) => e.type === type);
const releaseGates = (root: string) => listRequests(root).filter((r) => r.type === 'gate' && r.args?.gate === 'release');

function notifier() {
  const calls: [string[], Record<string, unknown>][] = [];
  const fn: QueueNotify = (_root, evs, opts) => {
    calls.push([[...evs], { ...opts }]);
    return true;
  };
  return { calls, fn };
}

/** Mandate m1 until released, with one done job carrying its one scope item. */
async function mandateWithDoneJob(root: string, flags: string[] = ['--decides', 'release']): Promise<string> {
  await ok(root, ['mandate', 'new', 'm1', '--title', 'Ship it', '--issues', 'ship-it', '--order', 'listed', '--until', 'released', ...flags]);
  return jobAt(root, 'done', { title: 'Ship it', create: { mandate: 'm1', issues: [{ tracker: 'local', ref: 'ship-it', url: null }] } }).id;
}

const pass = (root: string, config: Config, notify: QueueNotify = notifier().fn) => runOfficePass(root, config, { tracker: null, notify });

const run = (root: string, config: Config) =>
  runRelease(root, config, {
    interactive: false,
    confirm: async () => false,
    narrow: (j: Job) => releaseMandateRefusal(root, config, j),
    mandateNarrow: (id: string) => mandateReleaseRefusal(root, config, id),
    echo: () => {},
  });

test('a mandate until released plans its release, waits for approval and closes', async (t) => {
  const r = scratch(t);
  const job = await mandateWithDoneJob(r.dir);
  const config = loadConfig(r.dir).config;
  const shown = await ok(r.dir, ['mandate', 'show', 'm1']);
  assert.deepEqual([shown.contract.until, shown.effective.until, shown.capped], ['released', 'released', []], 'until released round-trips');
  assert.equal(shown.release.status, 'unplanned');

  // The pass plans and waits: one event, one directive, one gate notification, one job-less request.
  const n = notifier();
  const out = await pass(r.dir, config, n.fn);
  const line = out.mandates.find((m) => m.id === 'm1')!;
  assert.equal(line.state, 'active', 'not closed');
  const [planned] = events(r.dir, 'mandate-release-planned');
  assert.deepEqual([planned.mandate, planned.tag, planned.actor], ['m1', 'v0.1.0', { login: null, source: 'foreman' }]);
  const hash: string = planned.planHash;
  const h12 = hash.slice(0, 12);
  assert.deepEqual(
    events(r.dir, 'directive').map((e) => [e.mandate, e.action, e.reason]),
    [['m1', 'release', `planned ${h12} since v0.1.0`]],
  );
  assert.deepEqual(n.calls, [[['gate'], { reason: 'mandate-release', mandate: 'm1' }]]);
  const gates = releaseGates(r.dir);
  assert.deepEqual(gates.map((g) => [g.job, g.status, g.args]), [[null, 'pending', { gate: 'release', mandate: 'm1', key: hash, reserved: null }]]);
  assert.deepEqual([line.blocked, line.release?.status, line.release?.owner, line.release?.plan], [`release: plan ${h12} waits for release approval (foreman)`, 'pending', 'foreman', h12]);
  const files = releaseFiles(r.dir);
  assert.ok(!fs.existsSync(files.state), 'the pass writes no state.json');
  assert.match(fs.readFileSync(files.md, 'utf8'), /^Selection: since v0\.1\.0 for mandate m1 /m);
  await pass(r.dir, config, n.fn);
  assert.equal(events(r.dir, 'mandate-release-planned').length, 1, 'a second pass adds no event');
  assert.equal(releaseGates(r.dir).length, 1, 'nor a request');
  const show = await ok(r.dir, ['mandate', 'show', 'm1']);
  assert.deepEqual([show.release.status, show.release.plan, show.release.tag, show.release.owner], ['pending', h12, 'v0.1.0', 'foreman']);

  // An assistant foreman takes the request: the brief, then the approval, which starts nothing.
  claimRequest(r.dir, gates[0].id, 'sess-a');
  const assist = await ok(r.dir, ['mandate', 'release', 'assist', 'm1', '--request', gates[0].id], ASSISTANT);
  assert.deepEqual([assist.stale, assist.reserved, assist.gate, assist.subagent], [false, null, 'release', 'forge:assistant']);
  const brief = (assist.brief as string).split('\n');
  assert.ok(brief.includes('Gate: release'), assist.brief);
  assert.ok(brief.some((l) => l.startsWith('Release plan: ') && l.endsWith(`(plan ${h12})`)), assist.brief);
  assert.ok(brief.includes(`Mandate jobs (JSON): ${JSON.stringify([{ job, pr: null, repos: ['(root)'] }])}`), assist.brief);
  const approved = await ok(r.dir, ['mandate', 'release', 'approve', 'm1', '--actor', 'foreman', '--note', 'the plan releases what m1 merged'], ASSISTANT);
  assert.deepEqual(approved, { ok: true, mandate: 'm1', release: { plan: h12, actor: 'foreman' } });
  assert.ok(!fs.existsSync(files.state), 'the approval writes no state.json');
  const status = await ok(r.dir, ['release', 'status']);
  assert.deepEqual([status.approval.owner, status.approval.status, status.approval.actor], ['foreman', 'approved', 'foreman']);
  assert.equal((await ok(r.dir, ['mandate', 'show', 'm1'])).release.status, 'approved');

  // A run without a terminal publishes on that approval, and logs the mandate's release as finished.
  const ran = await run(r.dir, config);
  assert.equal(ran.exitCode, 0, JSON.stringify(ran.data));
  assert.equal(ran.data.approvedBy, 'foreman');
  assert.match(execFileSync('git', ['ls-remote', '--tags', r.bare, 'refs/tags/v0.2.0'], { encoding: 'utf8' }), /refs\/tags\/v0\.2\.0/);
  assert.deepEqual(events(r.dir, 'mandate-release-finished').map((e) => [e.mandate, e.planHash]), [['m1', hash]]);

  // The next pass closes the mandate.
  const closing = notifier();
  await pass(r.dir, config, closing.fn);
  const after = await ok(r.dir, ['mandate', 'show', 'm1']);
  assert.equal(after.status, 'closed');
  assert.match(String(after.reason), /^done: 1 jobs reached released, 0 parked, \$0$/);
  const summary = readSummary(r.dir, 'm1');
  assert.ok(summary && !('problem' in summary) && summary.until === 'released', JSON.stringify(summary));
  assert.deepEqual(closing.calls, [[['mandate-closed'], { reason: 'mandate-closed', mandate: 'm1' }]]);
});

test('a merge after the approval makes the plan stale, and the approval stops counting', async (t) => {
  const r = scratch(t);
  await mandateWithDoneJob(r.dir);
  const config = loadConfig(r.dir).config;
  await pass(r.dir, config);
  const [gate] = releaseGates(r.dir);
  claimRequest(r.dir, gate.id, 'sess-a');
  await ok(r.dir, ['mandate', 'release', 'approve', 'm1', '--actor', 'foreman', '--note', 'the plan releases what m1 merged'], ASSISTANT);
  assert.equal((await ok(r.dir, ['release', 'status'])).approval.status, 'approved');

  // Another commit merges into main after the approval: the planned HEAD moved, so the plan is stale.
  fs.writeFileSync(path.join(r.dir, 'b.txt'), 'b\n');
  r.git('add', '-A');
  r.git('commit', '-qm', 'merged after the approval');
  r.git('push', '-q', 'origin', 'main');
  assert.equal((await ok(r.dir, ['mandate', 'show', 'm1'])).release.status, 'stale');
  assert.equal((await ok(r.dir, ['release', 'status'])).stale, true);
  await assert.rejects(run(r.dir, config), /the release plan no longer matches config and the repos/);

  // The pass plans again; the approval was for the old plan, so a run without a terminal stops at the publish step.
  await pass(r.dir, config);
  const planned = events(r.dir, 'mandate-release-planned');
  assert.equal(planned.length, 2);
  assert.notEqual(planned[1].planHash, planned[0].planHash);
  assert.deepEqual((await ok(r.dir, ['release', 'status'])).approval, { owner: 'foreman', status: 'pending' });
  const ran = await run(r.dir, config);
  assert.equal(ran.exitCode, 1);
  assert.deepEqual([ran.data.stopped?.step, ran.data.stopped?.reason, ran.data.approvedBy], ['(root)/release', 'needs_confirmation', undefined]);
  assert.equal(execFileSync('git', ['ls-remote', '--tags', r.bare, 'refs/tags/v0.2.0'], { encoding: 'utf8' }), '', 'nothing published');
  assert.equal((await ok(r.dir, ['mandate', 'show', 'm1'])).status, 'active');
});

test("the Foreman's reserved release leaves the plan with a human", async (t) => {
  const r = scratch(t);
  commitConfig(r, (c) => (c.foreman.reserved = ['gate:release']));
  await mandateWithDoneJob(r.dir, []);
  const config = loadConfig(r.dir).config;
  const out = await pass(r.dir, config);
  assert.equal(events(r.dir, 'mandate-release-planned').length, 1, 'planned');
  assert.deepEqual(releaseGates(r.dir), [], 'no gate request');
  assert.equal(out.mandates[0].release?.owner, 'human');
  const status = await ok(r.dir, ['release', 'status']);
  assert.deepEqual(status.approval, { owner: 'human', status: 'pending' });
  const ran = await run(r.dir, config);
  assert.equal(ran.exitCode, 1);
  assert.deepEqual([ran.data.stopped?.step, ran.data.stopped?.reason], ['(root)/release', 'needs_confirmation']);
  assert.equal((await ok(r.dir, ['mandate', 'show', 'm1'])).status, 'active');
});

test('forge release plan --mandate', async (t) => {
  const r = scratch(t);
  await mandateWithDoneJob(r.dir);
  await ok(r.dir, ['mandate', 'new', 'm2', '--title', 'M2', '--issues', 'other', '--order', 'listed', '--until', 'merged']);
  await ok(r.dir, ['mandate', 'new', 'm3', '--title', 'M3', '--issues', 'third', '--order', 'listed', '--until', 'released']);
  await ok(r.dir, ['mandate', 'pause', 'm3']);
  await ok(r.dir, ['mandate', 'new', 'm4', '--title', 'M4', '--issues', 'fourth', '--order', 'listed', '--until', 'released']);
  await ok(r.dir, ['mandate', 'close', 'm4']);
  const refusals: [string, string[], number, RegExp][] = [
    ['with --since', ['release', 'plan', '--mandate', 'm1', '--since', 'v0.1.0'], 2, /takes one of --job, --since or --mandate/],
    ['with --job', ['release', 'plan', '--mandate', 'm1', '--job', 'j-1'], 2, /takes one of --job, --since or --mandate/],
    ['an unknown mandate', ['release', 'plan', '--mandate', 'nope'], 1, /^no mandate "nope"/],
    ['before the pass planned it', ['release', 'plan', '--mandate', 'm1'], 1, /^mandate m1's release isn't planned yet/],
    ['a mandate that is not active', ['release', 'plan', '--mandate', 'm3'], 1, /^mandate m3 is paused; resume it first$/],
    ['a closed mandate', ['release', 'plan', '--mandate', 'm4'], 1, /^mandate m4 is closed; plan a release of its work with forge release plan --since <tag>$/],
    ["a mandate whose until isn't released", ['release', 'plan', '--mandate', 'm2'], 1, /^mandate m2's until is merged, not released/],
  ];
  for (const [name, args, status, want] of refusals) {
    const res = await forgeInProcess(r.dir, args);
    assert.equal(res.status, status, `${name}: ${JSON.stringify(res)}`);
    assert.match(res.error?.message ?? '', want, name);
  }
  assert.deepEqual(events(r.dir, 'mandate-release-planned'), [], 'nothing planned');
  const config = loadConfig(r.dir).config;
  await pass(r.dir, config);
  const first = events(r.dir, 'mandate-release-planned')[0].planHash;
  // Once the pass has planned, a person re-plans: a changed strategy gives a new hash and a new request.
  editConfig(r.dir, (c) => (c.release.command = `${COMMAND} # again`));
  const out = await ok(r.dir, ['release', 'plan', '--mandate', 'm1']);
  const planned = events(r.dir, 'mandate-release-planned');
  assert.equal(planned.length, 2);
  const second = planned[1].planHash;
  assert.notEqual(second, first);
  assert.deepEqual([out.hash, out.tag, out.approval.owner], [second.slice(0, 12), 'v0.1.0', 'foreman']);
  assert.deepEqual(releaseGates(r.dir).map((g) => g.args?.key), [first, second]);
});
