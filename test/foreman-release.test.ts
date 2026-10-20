// The Foreman's `release` gate class (issue #192): `gate:<class>` entries in foreman.reserved, the
// v17 -> v18 config migration that reserves `gate:release`, `forge release plan --job` queueing the
// gate, `forge job human … approve-release --actor foreman` and its authority checks, and
// `forge release run` honouring the approval only for its plan and policy. Scratch repos only: the
// two-repo fixture with local bare origins, and sh stubs for npm that log their argv.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TRUST_ENV, defaults, foremanProblems, loadConfig, trustDigest } from '../lib/config.ts';
import { ACTIONS_BY_GATE, INVALID_RESERVED, classReservation, decides, reservedMatch } from '../lib/foreman.ts';
import { OFFICE_SCOPE, INBOX_SCOPE, ackRequest, listRequests } from '../lib/requests.ts';
import { CONFIG_SCHEMA_VERSION, OFFICE_GATES, migrateConfig } from '../lib/schema.ts';
import { type TwoRepo, dependsOn, twoRepo } from './job-repos-fixture.ts';

const posix = process.platform === 'win32' ? 'the stubs are sh scripts and forge release run refuses native Windows' : false;

// Publishes by touching published-<dir>, which `view` then reports.
const NPM = `#!/bin/sh
d="$STUB_DIR"
name=$(basename "$PWD")
echo "npm $* @$name" >> "$d/argv.log"
case "$1" in
  publish) : > "$d/published-$name"; echo "published $name" ;;
  view) spec="$2"; n="\${spec%@*}"; v="\${spec##*@}"; if [ -f "$d/published-$n" ]; then echo "$v"; else echo "404" >&2; exit 1; fi ;;
esac
`;
const TAG = 'echo "tag $(basename "$PWD")" >> "$STUB_DIR/argv.log" && git tag v1.0.0 && git push -q origin v1.0.0';
const HASH = /^[0-9a-f]{64}$/;

interface Project extends TwoRepo {
  job: string;
  argv: () => string[];
  cli: (scope: string | undefined, ...args: string[]) => Promise<{ status: number | null; out: string; json: any }>;
  plan: () => any;
  gates: () => any[];
  eventsFile: string;
  jobFile: string;
}

const json = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Foreman on, release delegated: `release` in decides and `gate:release` out of reserved. */
const delegate = (c: any) => {
  c.foreman.enabled = true;
  c.foreman.decides = [...OFFICE_GATES];
  c.foreman.reserved = c.foreman.reserved.filter((p: string) => p !== 'gate:release');
};

/** The fixture with lib on tag + npm (its publish steps ask), the root unreleased, and a job whose PRs merged. */
async function project(cleanups: (() => void)[], edit: (c: any) => void = () => {}): Promise<Project> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  const stubs = path.join(p.parent, 'stubs');
  fs.mkdirSync(path.join(stubs, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stubs, 'bin', 'npm'), NPM, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'argv.log'), '');
  dependsOn(p, 'app-on-lib');
  p.commit(p.lib, { 'package.json': JSON.stringify({ name: 'lib', version: '1.0.0' }) }, 'lib package');
  p.git(p.lib, 'push', '-q', 'origin', 'main');
  p.config((c) => {
    c.repos[0].release = { mechanism: 'tag', command: TAG, registry: 'npm' };
    edit(c);
  });
  const stubEnv = { PATH: `${path.join(stubs, 'bin')}${path.delimiter}${process.env.PATH}`, STUB_DIR: stubs };
  const j = await p.f('job', 'new', '--title', 'Release me');
  await p.f('job', 'repo', 'add', j.id, 'lib');
  const jobFile = path.join(p.root, '.forge', 'jobs', j.id, 'job.json');
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  job.pr = { number: 11, url: null, state: 'MERGED', isDraft: false };
  job.repos.find((r: any) => r.repo === 'lib').pr = { number: 7, url: null, state: 'MERGED', isDraft: false };
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
  const scopeEnv = (scope?: string): NodeJS.ProcessEnv => (scope ? { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: scope, [TRUST_ENV]: trustDigest(p.root) } : {});
  const cli = async (scope: string | undefined, ...args: string[]) => {
    const r = await p.raw(args, { ...stubEnv, ...scopeEnv(scope) });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, json: json(r.stdout) };
  };
  return {
    ...p,
    job: j.id,
    jobFile,
    eventsFile: path.join(p.root, '.forge', 'jobs', j.id, 'events.jsonl'),
    cli,
    argv: () => fs.readFileSync(path.join(stubs, 'argv.log'), 'utf8').split('\n').filter(Boolean),
    plan: () => JSON.parse(fs.readFileSync(path.join(p.root, '.forge', 'runtime', 'release', 'release.json'), 'utf8')),
    gates: () => listRequests(p.root).filter((r) => r.type === 'gate' && r.job === j.id),
  };
}

const planned = (p: Project) => p.events(p.job).filter((e) => e.type === 'release-planned');
const approvals = (p: Project) => p.events(p.job).filter((e) => e.type === 'release-approval');

/** Plans the job and records the Foreman's approval from the office; returns the plan hash. */
async function approve(p: Project): Promise<string> {
  const plan = await p.cli(undefined, 'release', 'plan', '--job', p.job);
  assert.equal(plan.status, 0, plan.out);
  const ok = await p.cli(OFFICE_SCOPE, 'job', 'human', p.job, 'approve-release', '--actor', 'foreman', '--note', 'ok');
  assert.equal(ok.status, 0, ok.out);
  return p.plan().hash;
}

describe('gate: entries and the v18 config', () => {
  test('gate: entries reserve a whole class and are never text', () => {
    const cfg = (reserved: unknown, list: string[] = [...OFFICE_GATES]): any => ({ foreman: { enabled: true, decides: list, reserved } });
    assert.equal(reservedMatch(cfg(['gate:release']), ['gate:release', 'cut the release', 'release']), null, 'a gate: entry never matches text');
    assert.equal(reservedMatch(cfg(['gate:release', 'secret']), ['a secret']), 'secret', 'text patterns still match');
    assert.equal(reservedMatch(cfg([' gate:release ']), ['release']), null, 'whitespace trimmed');
    assert.deepEqual(decides(cfg(['gate:release'])), OFFICE_GATES.filter((g) => g !== 'release'));
    assert.equal(classReservation(cfg(['gate:release']), 'release'), 'gate:release');
    assert.equal(classReservation(cfg(['secret']), 'release'), null);
    // An unknown class fails closed and is reported.
    assert.equal(reservedMatch(cfg(['gate:relase']), ['anything']), INVALID_RESERVED);
    assert.equal(reservedMatch(cfg(['gate:relase']), []), INVALID_RESERVED);
    const problems = foremanProblems({ foreman: { enabled: true, decides: [], reserved: ['gate:relase'], ship: 'propose' } });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /foreman\.reserved entry "gate:relase" names no gate class .*every gate stays with a human/);
    assert.deepEqual(foremanProblems({ foreman: { ...defaults().foreman } }), [], 'the defaults are valid');
    // gate:repo-proposal keeps repo proposals with a human even in decides.
    const rp = cfg(['gate:repo-proposal']);
    assert.ok(!decides(rp).includes('repo-proposal'));
    assert.ok(decides(rp).includes('release'));
    assert.equal(classReservation(rp, 'repo-proposal'), 'gate:repo-proposal');
  });

  test('a mis-written gate: entry is reported and fails closed', () => {
    const cfg = (reserved: unknown): any => ({ foreman: { enabled: true, decides: [...OFFICE_GATES], reserved } });
    for (const entry of ['Gate:release', 'GATE:release', 'gate: release', 'gate:Release', 'gate :release']) {
      const problems = foremanProblems({ foreman: { enabled: true, decides: [...OFFICE_GATES], reserved: ['secret', entry], ship: 'propose' } });
      assert.equal(problems.length, 1, `${entry}: ${problems.join('; ')}`);
      assert.ok(problems[0].includes(JSON.stringify(entry)), `${entry}: names the entry`);
      assert.match(problems[0], /write exactly gate:<class>, lowercase with no spaces.*every gate stays with a human/, entry);
      assert.equal(reservedMatch(cfg(['secret', entry]), []), INVALID_RESERVED, `${entry}: fails closed with no text`);
      assert.equal(reservedMatch(cfg([entry]), ['nothing reserved here']), INVALID_RESERVED, entry);
      assert.equal(classReservation(cfg([entry]), 'release'), null, `${entry}: not read as a reservation`);
    }
    // Text patterns that merely mention a gate are still text.
    assert.equal(reservedMatch(cfg(['gated release', 'gateway']), ['a gateway change']), 'gateway');
  });

  test('config v17 migrates to v18, reserving the release gate', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 22);
    const d = defaults();
    assert.equal(d.foreman.reserved.at(-1), 'gate:release');
    assert.ok(!d.foreman.decides.includes('release'));
    assert.ok(OFFICE_GATES.includes('release'));
    assert.deepEqual(ACTIONS_BY_GATE.release, ['approve-release']);
    const explicit = migrateConfig({ schemaVersion: 17, foreman: { enabled: true, reserved: ['secret'] } });
    assert.equal(explicit.from, 17);
    assert.deepEqual(explicit.config.foreman, { enabled: true, reserved: ['secret', 'gate:release'] });
    assert.deepEqual(migrateConfig({ schemaVersion: 17, foreman: { reserved: ['secret', 'gate:release'] } }).config.foreman.reserved, ['secret', 'gate:release'], 'never twice');
    assert.deepEqual(migrateConfig({ schemaVersion: 17, git: { base: 'trunk' } }).config, { schemaVersion: 22, git: { base: 'trunk' } }, 'nothing else changes');
    assert.deepEqual(migrateConfig({ schemaVersion: 18, foreman: { reserved: ['secret'] } }).config.foreman.reserved, ['secret'], 'a v18 config is left as written');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v17-')));
    try {
      fs.mkdirSync(path.join(dir, '.forge'));
      fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), 'schemaVersion: 17\n');
      assert.deepEqual(loadConfig(dir).config.foreman.reserved, d.foreman.reserved, 'no foreman block: the defaults');
      fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), 'schemaVersion: 17\nforeman:\n  reserved:\n    - secret\n');
      assert.deepEqual(loadConfig(dir).config.foreman.reserved, ['secret', 'gate:release']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('forge release with the foreman', { concurrency: 4 }, () => {
  const cleanups: (() => void)[] = [];
  process.on('exit', () => cleanups.forEach((c) => c()));

  test('with defaults the release gate stays pending for a human', async (t) => {
    // foreman.enabled only proves the default decides/reserved keep it human.
    const p = await project(cleanups, (c) => (c.foreman.enabled = true));
    const plan = await p.cli(undefined, 'release', 'plan', '--job', p.job);
    assert.equal(plan.status, 0, plan.out);
    assert.deepEqual(plan.json.approval, { owner: 'human', request: null });
    assert.equal(planned(p).length, 1);
    assert.match(planned(p)[0].planHash, HASH);
    assert.deepEqual(p.gates(), []);
    const again = await p.cli(undefined, 'release', 'plan', '--job', p.job);
    assert.equal(again.status, 0, again.out);
    assert.equal(planned(p).length, 1, 'the same hash is logged once');
    const status = await p.cli(undefined, 'release', 'status');
    assert.deepEqual(status.json.approval, { owner: 'human', status: 'pending' });
    // --since and plain plans log nothing.
    const all = await p.cli(undefined, 'release', 'plan');
    assert.equal(all.status, 0, all.out);
    assert.deepEqual(all.json.approval, { owner: 'human', request: null });
    assert.equal(planned(p).length, 1);
    if (posix) return t.diagnostic(`run assertions skipped: ${posix}`);
    assert.equal((await p.cli(undefined, 'release', 'plan', '--job', p.job)).status, 0);
    const run = await p.cli(undefined, 'release', 'run');
    assert.equal(run.status, 1, run.out);
    assert.equal(run.json.stopped.reason, 'needs_confirmation');
    assert.equal(run.json.stopped.step, 'lib/release');
    assert.equal(run.json.approvedBy, undefined);
    assert.deepEqual(p.argv(), [], 'nothing runs');
  });

  test('the foreman approves a delegated release and records actor foreman', async () => {
    const p = await project(cleanups, delegate);
    const plan = await p.cli(undefined, 'release', 'plan', '--job', p.job);
    assert.equal(plan.status, 0, plan.out);
    const hash = p.plan().hash;
    assert.match(hash, HASH);
    const gates = p.gates();
    assert.equal(gates.length, 1);
    assert.deepEqual(gates[0].args, { gate: 'release', key: hash, reserved: null });
    assert.equal(gates[0].status, 'pending');
    assert.deepEqual(plan.json.approval, { owner: 'foreman', request: gates[0].id });
    const again = await p.cli(undefined, 'release', 'plan', '--job', p.job);
    assert.equal(again.status, 0, again.out);
    assert.equal(p.gates().length, 1, 'the same hash queues no second request');
    assert.equal(again.json.approval.request, gates[0].id);
    const a = await p.cli(OFFICE_SCOPE, 'job', 'assist', p.job, '--gate', 'release');
    assert.equal(a.status, 0, a.out);
    assert.equal(a.json.stale, false);
    assert.equal(a.json.reserved, null);
    const md = path.join(p.root, '.forge', 'runtime', 'release', 'release.md');
    assert.ok(a.json.brief.includes(md));
    assert.ok(a.json.brief.includes(path.join(p.root, '.forge', 'config.yml')));
    assert.match(a.json.brief, /^Gate: release$/m);
    assert.ok(a.json.brief.includes(`Release plan: ${md} (plan ${hash.slice(0, 12)})`));
    assert.ok(!a.json.brief.includes('# Release plan'), 'no file text');
    assert.ok(!a.json.brief.includes(TAG), 'no config text');
    const ok = await p.cli(OFFICE_SCOPE, 'job', 'human', p.job, 'approve-release', '--actor', 'foreman', '--note', 'ok');
    assert.equal(ok.status, 0, ok.out);
    assert.deepEqual(ok.json, { ok: true, release: { plan: hash.slice(0, 12), actor: 'foreman' } });
    const ev = approvals(p);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].planHash, hash);
    assert.equal(ev[0].note, 'ok');
    assert.deepEqual(ev[0].actor, { login: null, source: 'foreman' });
    assert.equal(p.events(p.job).filter((e) => e.type === 'human').length, 0, 'no human event');
    const status = await p.cli(undefined, 'release', 'status');
    assert.equal(status.json.approval.owner, 'foreman');
    assert.equal(status.json.approval.status, 'approved');
    assert.equal(status.json.approval.actor, 'foreman');
    assert.equal(typeof status.json.approval.at, 'string');
  });

  test('a foreman approval stands in for the publish prompt only for its plan', { skip: posix }, async () => {
    const p = await project(cleanups, delegate);
    const hash = await approve(p);
    const stopsForAHuman = async (why: string) => {
      const r = await p.cli(undefined, 'release', 'run');
      assert.equal(r.status, 1, `${why}: ${r.out}`);
      assert.equal(r.json?.stopped?.reason, 'needs_confirmation', `${why}: ${r.out}`);
      assert.equal(r.json.approvedBy, undefined, why);
      assert.deepEqual(p.argv(), [], `${why}: nothing published`);
    };
    // (b) gate:release back in reserved; (c) release out of decides; (d) the foreman off.
    p.config((c) => c.foreman.reserved.push('gate:release'));
    await stopsForAHuman('gate:release reserved');
    const status = await p.cli(undefined, 'release', 'status');
    assert.deepEqual(status.json.approval, { owner: 'human', status: 'pending' });
    p.config((c) => (c.foreman.reserved = c.foreman.reserved.filter((x: string) => x !== 'gate:release')));
    p.config((c) => (c.foreman.decides = c.foreman.decides.filter((g: string) => g !== 'release')));
    await stopsForAHuman('release not in decides');
    p.config((c) => (c.foreman.decides = [...OFFICE_GATES]));
    p.config((c) => (c.foreman.enabled = false));
    await stopsForAHuman('foreman off');
    p.config((c) => (c.foreman.enabled = true));
    // (e) a hand-written approval for another plan, or by someone other than the foreman.
    const original = fs.readFileSync(p.eventsFile, 'utf8');
    fs.writeFileSync(p.eventsFile, original.replaceAll(hash, 'f'.repeat(64)));
    await stopsForAHuman('another plan');
    fs.writeFileSync(p.eventsFile, original.replace('"source":"foreman"', '"source":"gh"').replace('"login":null', '"login":"mallory"'));
    await stopsForAHuman('not the foreman');
    fs.writeFileSync(p.eventsFile, original);
    // (a) a change that alters the hash: the old plan is stale, and a re-plan isn't approved.
    p.config((c) => (c.repos[0].release.command = `${TAG} && true`));
    const stale = await p.cli(undefined, 'release', 'run');
    assert.equal(stale.status, 1);
    assert.match(stale.out, /no longer matches config and the repos/);
    assert.equal((await p.cli(undefined, 'release', 'plan', '--job', p.job, '--force')).status, 0);
    assert.notEqual(p.plan().hash, hash);
    await stopsForAHuman('a re-plan with another hash');
    // Back to the approved plan: only that exact hash runs without a terminal.
    p.config((c) => (c.repos[0].release.command = TAG));
    assert.equal((await p.cli(undefined, 'release', 'plan', '--job', p.job, '--force')).status, 0);
    assert.equal(p.plan().hash, hash);
    const run = await p.cli(undefined, 'release', 'run');
    assert.equal(run.status, 0, run.out);
    assert.equal(run.json.approvedBy, 'foreman');
    assert.deepEqual(run.json.ran, ['lib/preflight', 'lib/release', 'lib/publish']);
    const argv = p.argv();
    assert.ok(argv.includes('tag lib'), argv.join('\n'));
    assert.ok(argv.some((l) => l.startsWith('npm publish')), argv.join('\n'));
    assert.match(p.git(p.libBare, 'tag', '--list'), /v1\.0\.0/);
  });

  test('reserved gate:release wins over decides', async () => {
    const p = await project(cleanups, (c) => {
      c.foreman.enabled = true;
      c.foreman.decides = [...OFFICE_GATES];
    });
    assert.ok(loadConfig(p.root).config.foreman.reserved.includes('gate:release'));
    const plan = await p.cli(undefined, 'release', 'plan', '--job', p.job);
    assert.equal(plan.status, 0, plan.out);
    assert.deepEqual(plan.json.approval, { owner: 'human', request: null });
    assert.deepEqual(p.gates(), []);
    const before = fs.readFileSync(p.eventsFile, 'utf8');
    const r = await p.cli(OFFICE_SCOPE, 'job', 'human', p.job, 'approve-release', '--actor', 'foreman', '--note', 'ok');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--actor foreman refused: release is reserved \(gate:release\)/);
    const a = await p.cli(OFFICE_SCOPE, 'job', 'assist', p.job, '--gate', 'release');
    assert.equal(a.json.reserved, 'gate:release', 'assist reports the class reservation');
    assert.equal(fs.readFileSync(p.eventsFile, 'utf8'), before);
  });

  test('a mis-written gate:release keeps the release gate with a human even in decides', async () => {
    const p = await project(cleanups, delegate);
    // A plan made while the class was delegated is pending; the mis-written entry must still win.
    assert.equal((await p.cli(undefined, 'release', 'plan', '--job', p.job)).status, 0);
    for (const entry of ['Gate:release', 'GATE:release', 'gate: release', 'gate:Release']) {
      p.config((c) => (c.foreman.reserved = ['secret', entry]));
      const v = await p.cli(undefined, 'config', 'validate');
      assert.notEqual(v.status, 0, `${entry}: ${v.out}`);
      assert.ok(v.out.includes('write exactly gate:<class>'), `${entry}: ${v.out}`);
      // config problems block planning outright, so nothing reaches the foreman.
      const plan = await p.cli(undefined, 'release', 'plan', '--job', p.job, '--force');
      assert.equal(plan.status, 1, `${entry}: ${plan.out}`);
      assert.match(plan.out, /no release can be planned/, entry);
      const before = fs.readFileSync(p.eventsFile, 'utf8');
      const r = await p.cli(OFFICE_SCOPE, 'job', 'human', p.job, 'approve-release', '--actor', 'foreman', '--note', 'ok');
      assert.equal(r.status, 1, `${entry}: ${r.out}`);
      assert.match(r.out, /--actor foreman refused|config\.yml has 1 problem/, entry);
      assert.equal(fs.readFileSync(p.eventsFile, 'utf8'), before, `${entry}: nothing recorded`);
      assert.equal(approvals(p).length, 0, entry);
    }
  });

  test('approve-release authority is enforced by the CLI', async () => {
    const p = await project(cleanups, delegate);
    assert.equal((await p.cli(undefined, 'release', 'plan', '--job', p.job)).status, 0);
    const other = await p.f('job', 'new', '--title', 'Not planned');
    const otherEvents = path.join(p.root, '.forge', 'jobs', other.id, 'events.jsonl');
    const refused = async (why: string, re: RegExp, scope: string | undefined, args: string[], file = p.eventsFile, id = p.job) => {
      const before = fs.readFileSync(file, 'utf8');
      const r = await p.cli(scope, 'job', 'human', id, 'approve-release', ...args);
      assert.equal(r.status, 1, `${why}: ${r.out}`);
      assert.match(r.out, re, why);
      assert.equal(fs.readFileSync(file, 'utf8'), before, `${why}: events.jsonl unchanged`);
    };
    const foreman = ['--actor', 'foreman', '--note', 'ok'];
    await refused('no daemon', /only the office daemon session/, undefined, foreman);
    await refused('a job scope', /refuse|office/, p.job, foreman);
    await refused('the inbox', /only the office daemon session/, INBOX_SCOPE, foreman);
    await refused('no note', /needs --note/, OFFICE_SCOPE, ['--actor', 'foreman']);
    await refused('--link', /only --note/, OFFICE_SCOPE, [...foreman, '--link', 'none']);
    await refused('--reason', /only --note/, OFFICE_SCOPE, [...foreman, '--reason', 'r']);
    await refused('--repo', /only --note/, OFFICE_SCOPE, [...foreman, '--repo', 'lib']);
    await refused('no --actor', /approve-release is the foreman's/, undefined, ['--note', 'ok']);
    await refused('a reserved note', /reserved \(token\)/, OFFICE_SCOPE, ['--actor', 'foreman', '--note', 'rotates the token']);
    // The job's latest security review asked for changes.
    const job = fs.readFileSync(p.jobFile, 'utf8');
    fs.writeFileSync(p.jobFile, JSON.stringify({ ...JSON.parse(job), verdicts: { 1: { security: 'CHANGES' } } }, null, 2));
    await refused('security CHANGES', /security review: CHANGES/, OFFICE_SCOPE, foreman);
    fs.writeFileSync(p.jobFile, job);
    // Config edited after planning: the plan is stale.
    const cfgFile = path.join(p.root, '.forge', 'config.yml');
    const cfg = fs.readFileSync(cfgFile, 'utf8');
    p.config((c) => (c.repos[0].release.command = `${TAG} && true`));
    await refused('a stale plan', /stale or edited/, OFFICE_SCOPE, foreman);
    fs.writeFileSync(cfgFile, cfg);
    await refused("not release.json's job", new RegExp(`the release plan is not ${other.id}'s`), OFFICE_SCOPE, foreman, otherEvents, other.id);
    // Approved once; a second time for the same hash is refused.
    const ok = await p.cli(OFFICE_SCOPE, 'job', 'human', p.job, 'approve-release', ...foreman);
    assert.equal(ok.status, 0, ok.out);
    await refused('a second approval', /already approved/, OFFICE_SCOPE, foreman);
    // The gate request answered: nothing queued for this hash.
    ackRequest(p.root, p.gates()[0].id, { status: 'done', result: 'approve: ok' });
    await refused('no queued request', /no queued release gate request/, OFFICE_SCOPE, foreman);
  });

  test('assist reports a stale release gate; approve-release moves no job', async () => {
    const p = await project(cleanups, delegate);
    const stale = async () => {
      const a = await p.cli(OFFICE_SCOPE, 'job', 'assist', p.job, '--gate', 'release');
      assert.equal(a.status, 0, a.out);
      return a.json.stale;
    };
    assert.equal(await stale(), true, 'no plan');
    p.git(p.root, 'tag', 'v0');
    p.commit(p.root, { 'more.txt': 'x\n' });
    p.config((c) => (c.release = { ...c.release, mechanism: 'tag', command: TAG }));
    assert.equal((await p.cli(undefined, 'release', 'plan', '--since', 'v0')).status, 0);
    assert.equal(await stale(), true, 'a --since plan');
    p.config((c) => {
      delete c.release.mechanism;
      delete c.release.command;
    });
    assert.equal((await p.cli(undefined, 'release', 'plan', '--job', p.job)).status, 0);
    assert.equal(await stale(), false, 'a pending job plan');
    const ok = await p.cli(OFFICE_SCOPE, 'job', 'human', p.job, 'approve-release', '--actor', 'foreman', '--note', 'ok');
    assert.equal(ok.status, 0, ok.out);
    assert.equal(await stale(), true, 'already approved');
    const before = fs.readFileSync(p.jobFile, 'utf8');
    const set = await p.cli(OFFICE_SCOPE, 'job', 'set', p.job, '--state', 'running');
    assert.equal(set.status, 1, set.out);
    assert.match(set.out, /the office session may only carry out a recorded foreman decision/);
    assert.equal(fs.readFileSync(p.jobFile, 'utf8'), before, 'the job did not move');
  });
});
