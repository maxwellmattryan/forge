// Retention (job archive and prune): the archive record, eligibility, link and traversal guards,
// readers over archives (stats, audit, retro, deps, /api), the retention config and its policy runs.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { forgeAsync, waitFor } from './helpers.ts';
import { ago, repo, seedJob, tree } from './retention-fixture.ts';
import { rootLabel } from '../lib/backing.ts';
import { TRUST_ENV, defaults, trustDigest, validateConfig } from '../lib/config.ts';
import { CONFIG_DISCLOSURE, FIELDS, disclosureOf } from '../lib/config-fields.ts';
import { unmetDependencies } from '../lib/deps.ts';
import { storageCheck } from '../lib/doctor.ts';
import { createJob, jobDir, loadJob, readEvents, updateJob } from '../lib/jobs.ts';
import { retroDue } from '../lib/retro.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import { computeStats } from '../lib/stats.ts';
import type { Job, LoadedJob } from '../lib/types.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const DOCKER_BIN = path.resolve(import.meta.dirname, 'fixtures', 'docker-bin');
const ACTOR = { FORGE_ACTOR: 'tester' };

const json = (s: string) => JSON.parse(s);
/** Sets retention.jobsDays in the repo's config.yml, which init writes with every key null. */
const setJobsDays = (root: string, days: number) => {
  const file = path.join(root, '.forge', 'config.yml');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^ {2}jobsDays: null$/m);
  fs.writeFileSync(file, text.replace(/^ {2}jobsDays: null$/m, `  jobsDays: ${days}`));
};
const archiveFile = (root: string, id: string) => path.join(root, '.forge', 'archive', `${id}.json`);
const retentionLog = (root: string) => path.join(root, '.forge', 'runtime', 'retention.log');
const retentionLines = (root: string) =>
  fs.existsSync(retentionLog(root))
    ? fs
        .readFileSync(retentionLog(root), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** A done job with review rounds, findings, build.md answers, PR, human and verifier events, and usage. */
function richJob(root: string, title: string, days: number, n: number): string {
  const id = seedJob(root, title, {
    days,
    patch: (j) => {
      j.round = 2;
      j.reviewers = ['code', 'tests'];
      j.verdicts = { 1: { code: 'CHANGES', tests: 'PASS' }, 2: { code: 'PASS', tests: 'PASS' } };
      j.verifyRuns = [{ round: 1, attempt: 1, sha: null, ok: n % 2 === 0, at: ago(days + 1), file: 'verify/round-1.md' }];
      j.decision = n % 3 === 0 ? 'ESCALATE' : 'APPROVE';
      j.pr = { number: 10 + n, url: `https://example.test/pr/${10 + n}`, state: 'MERGED', isDraft: false, lastSyncedAt: ago(days) };
      j.usage = {
        totalTokens: 1000 * n + 7,
        estCostUsd: 0.1234 * n,
        exact: true,
        byRole: { builder: { tokens: 600 * n, input: 1, output: 2, cacheRead: 0, cacheWrite: 0, toolUses: 3, durationMs: 4, runs: 1, estCostUsd: 0.0617 * n }, 'reviewer:code': { tokens: 400 * n + 7, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, toolUses: 1, durationMs: 1, runs: 2, estCostUsd: 0.0617 * n } },
        byModel: { 'claude-opus-5-5': { tokens: 1000 * n + 7, input: 2, output: 3, cacheRead: 0, cacheWrite: 0, toolUses: 4, durationMs: 5, runs: 3, estCostUsd: 0.1234 * n } },
      } as any;
    },
  });
  const dir = jobDir(root, id);
  fs.mkdirSync(path.join(dir, 'review', 'round-1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'review', 'round-2'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'review', 'round-1', 'code.md'), 'VERDICT: CHANGES\n- [major] lib/a.ts:3 broken\n- [nit] lib/b.ts:1 style\n');
  fs.writeFileSync(path.join(dir, 'review', 'round-1', 'tests.md'), 'VERDICT: PASS\n');
  fs.writeFileSync(path.join(dir, 'review', 'round-2', 'code.md'), 'VERDICT: PASS\n- [minor] lib/a.ts:9 again\n');
  fs.writeFileSync(path.join(dir, 'build.md'), '## Round 2\n- code major lib/a.ts:3 → fixed\n- code nit lib/b.ts:1 → disagree: fine as is\n');
  fs.mkdirSync(path.join(dir, 'screenshots'));
  fs.writeFileSync(path.join(dir, 'screenshots', 'ac1.png'), Buffer.alloc(2048));
  const t0 = Date.parse(ago(days + 2));
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const events = [
    { v: 2, ts: at(0), type: 'created', title },
    { v: 2, ts: at(5), type: 'human', action: 'approve-spec', actor: { login: 'alice', source: 'gh' } },
    { v: 2, ts: at(9), type: 'human', action: n % 2 ? 'revise-spec' : 'rework', actor: { login: 'alice', source: 'gh' } },
    { v: 2, ts: at(10), type: 'human', action: 'approve', actor: { login: null, source: 'foreman' } },
    { v: 2, ts: at(12), type: 'agent-end', role: 'builder', usage: { totalTokens: 5, exact: true } },
    { v: 2, ts: at(14), type: 'verifiers', phase: 'record', results: [{ name: 'no-todo', mode: 'block', answer: n % 2 ? 'no' : 'yes' }] },
    { v: 2, ts: at(20 + n), type: 'pr-opened', number: 10 + n, url: 'u' },
    { v: 2, ts: at(30), type: 'pr-synced', newFeedback: n % 2 === 1 },
    { v: 2, ts: at(40), type: 'transition', from: { stage: 'decide', state: 'running', waitingOn: null }, to: { stage: 'decide', state: 'waiting', waitingOn: 'escalation' }, reason: 'r' },
    { v: 2, ts: at(41), type: 'pr-merged', number: 10 + n, method: 'squash' },
  ];
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
  return id;
}

describe('archive', { concurrency: 4 }, () => {
  test('archive writes the record and removes the job dir', async () => {
    const r = repo();
    try {
      const id = richJob(r.dir, 'Rich job', 3, 1);
      const raw = json(fs.readFileSync(path.join(jobDir(r.dir, id), 'job.json'), 'utf8'));
      const eventsBefore = readEvents(r.dir, id);
      const res = await forgeAsync(r.dir, ['job', 'archive', id], ACTOR);
      assert.equal(res.status, 0, res.stderr);
      const out = json(res.stdout);
      assert.equal(out.refused.length, 0);
      assert.equal(out.archived.length, 1);
      assert.equal(out.archived[0].id, id);
      assert.equal(out.archived[0].file, path.join('.forge', 'archive', `${id}.json`));
      assert.ok(out.archived[0].bytes > 2048, 'the screenshots count');
      assert.equal(fs.existsSync(jobDir(r.dir, id)), false, 'the job dir is gone');
      const rec = json(fs.readFileSync(archiveFile(r.dir, id), 'utf8'));
      assert.equal(rec.archiveVersion, 1);
      assert.equal(rec.id, id);
      assert.ok(!Number.isNaN(Date.parse(rec.archivedAt)));
      assert.equal(rec.trigger, 'cli');
      assert.deepEqual(rec.job, raw, 'job.json as stored');
      assert.equal(rec.events.length, eventsBefore.length + 1);
      const last = rec.events.at(-1);
      assert.equal(last.type, 'archived');
      assert.equal(last.trigger, 'cli');
      assert.deepEqual(last.actor, { login: 'tester', source: 'env' });
      assert.deepEqual(Object.keys(rec.summary).sort(), ['bytesFreed', 'createdAt', 'findings', 'finishedAt', 'kind', 'pr', 'rounds', 'state', 'title', 'usage', 'verdicts'].sort());
      assert.equal(rec.summary.title, 'Rich job');
      assert.equal(rec.summary.state, 'done');
      assert.equal(rec.summary.rounds, 2);
      assert.deepEqual(rec.summary.pr, { number: 11, state: 'MERGED', url: 'https://example.test/pr/11' });
      assert.deepEqual(rec.summary.verdicts, raw.verdicts);
      assert.deepEqual(rec.summary.usage, { totalTokens: raw.usage.totalTokens, estCostUsd: raw.usage.estCostUsd });
      assert.equal(rec.summary.findings.totals.raised, 3);
      assert.equal(rec.summary.findings.totals.fixed, 1);
      assert.equal(rec.summary.findings.totals.disputed, 1);
      assert.equal(rec.summary.bytesFreed, out.archived[0].bytes);
      assert.equal(fs.readFileSync(path.join(r.dir, '.forge', 'archive', '.gitignore'), 'utf8'), '*\n');
      assert.deepEqual(
        retentionLines(r.dir).map((l) => [l.type, l.kind, l.id, l.trigger, l.bytes]),
        [['pruned', 'job', id, 'cli', out.archived[0].bytes]],
      );
      const usage = await forgeAsync(r.dir, ['job', 'archive'], ACTOR);
      assert.equal(usage.status, 2, 'no id and no --done is a usage error');
      assert.equal((await forgeAsync(r.dir, ['job', 'archive', id, '--done', '--older-than', '1'], ACTOR)).status, 2, 'an id with --done is a usage error');
      assert.equal((await forgeAsync(r.dir, ['job', 'archive', '--done', '--older-than', '1.5'], ACTOR)).status, 2, 'days must be an integer');
      assert.equal((await forgeAsync(r.dir, ['job', 'archive', '--older-than', '1'], ACTOR)).status, 2, '--older-than needs --done');
    } finally {
      r.cleanup();
    }
  });

  test('archive eligibility refusals', async (t) => {
    const r = repo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wt-')));
    try {
      const refuse = async (id: string, reason: string) => {
        const before = tree(r.dir);
        const res = await forgeAsync(r.dir, ['job', 'archive', id], ACTOR);
        assert.equal(res.status, 1, res.stdout);
        assert.ok(res.stderr.includes(reason), `${reason} in ${res.stderr}`);
        assert.deepEqual(tree(r.dir), before, 'nothing written');
        assert.equal(fs.existsSync(path.join(r.dir, '.forge', 'archive')), false);
      };
      await t.test('a running job', async () => {
        await refuse(seedJob(r.dir, 'Running', { state: 'running', stage: 'build' }), 'active (build/running)');
      });
      await t.test('an eval job', async () => {
        await refuse(seedJob(r.dir, 'Eval', { kind: 'eval' }), 'eval jobs stay with their run');
      });
      await t.test('a live owner', async () => {
        const id = seedJob(r.dir, 'Owned', { patch: (j) => void (j.owner = { session: 'sess-1', host: 'h', since: new Date().toISOString(), heartbeat: new Date().toISOString() }) });
        await refuse(id, 'owned by live session sess-1');
      });
      await t.test('a running daemon session', async () => {
        const id = seedJob(r.dir, 'Daemon');
        const dir = path.join(r.dir, '.forge', 'runtime', 'daemons');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ pid: process.pid }));
        await refuse(id, 'daemon session running');
      });
      await t.test('an open PR', async () => {
        const id = seedJob(r.dir, 'Open PR', { patch: (j) => void (j.pr = { number: 7, url: 'u', state: 'OPEN', isDraft: false, lastSyncedAt: null } as any) });
        await refuse(id, 'PR #7 still open');
      });
      await t.test('an existing worktree', async () => {
        const id = seedJob(r.dir, 'Worktree', { patch: (j) => void (j.worktree = outside) });
        await refuse(id, `worktree still at ${outside}; run forge worktree remove ${id}`);
      });
      await t.test("an unfinished job's dependsOn, until it is done", async () => {
        const id = seedJob(r.dir, 'Dep');
        const other = seedJob(r.dir, 'Needs dep', { state: 'queued', stage: 'backlog', patch: (j) => void (j.dependsOn = [id]) });
        await refuse(id, `needed by ${other} (backlog/queued)`);
        updateJob(r.dir, other, (j) => void (j.state = 'done'));
        const ok = await forgeAsync(r.dir, ['job', 'archive', id], ACTOR);
        assert.equal(ok.status, 0, ok.stderr);
        fs.rmSync(path.join(r.dir, '.forge', 'archive'), { recursive: true });
      });
      await t.test("an unfinished job's children, until it is done", async () => {
        const id = seedJob(r.dir, 'Child');
        const parent = seedJob(r.dir, 'Parent', { state: 'running', stage: 'build', patch: (j) => void (j.children = [id]) });
        await refuse(id, `needed by ${parent} (build/running)`);
        updateJob(r.dir, parent, (j) => void (j.state = 'cancelled'));
        const ok = await forgeAsync(r.dir, ['job', 'archive', id], ACTOR);
        assert.equal(ok.status, 0, ok.stderr);
      });
    } finally {
      r.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('archive tears down first and refuses on teardown failure', async () => {
    const r = repo();
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docker-')));
    try {
      const file = path.join(r.dir, '.forge', 'config.yml');
      const pg = { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432] };
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify([pg])}`));
      const id = seedJob(r.dir, 'Left running');
      fs.writeFileSync(path.join(jobDir(r.dir, id), 'backing.json'), JSON.stringify({ v: 1, ports: {} }));
      const stateFile = path.join(tmp, 'state.json');
      const env = { ...ACTOR, PATH: `${DOCKER_BIN}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: stateFile };
      const name = `forge-${id}-postgres`;
      const labels = { 'forge.root': rootLabel(r.dir), 'forge.backing': 'postgres', 'forge.isolation': 'per-job', 'forge.job': id };
      fs.writeFileSync(stateFile, JSON.stringify({ daemon: 'down', containers: { [name]: { running: true, labels } } }));

      const refused = await forgeAsync(r.dir, ['job', 'archive', id], env);
      assert.equal(refused.status, 0, refused.stderr);
      const out = json(refused.stdout);
      assert.deepEqual(out.archived, []);
      assert.equal(out.refused.length, 1);
      assert.equal(out.refused[0].id, id);
      assert.match(out.refused[0].reason, /^environment teardown failed: docker is installed but its daemon is not reachable/);
      assert.ok(fs.existsSync(jobDir(r.dir, id)), 'the job dir stays');
      assert.ok(fs.existsSync(path.join(jobDir(r.dir, id), 'backing.json')), 'its record stays');
      assert.equal(fs.existsSync(archiveFile(r.dir, id)), false);

      fs.writeFileSync(stateFile, JSON.stringify({ ...json(fs.readFileSync(stateFile, 'utf8')), daemon: 'up' }));
      const ok = await forgeAsync(r.dir, ['job', 'archive', id], env);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(json(ok.stdout).archived[0].id, id);
      assert.deepEqual(json(fs.readFileSync(stateFile, 'utf8')).containers, {}, 'the container went first');
      const rec = json(fs.readFileSync(archiveFile(r.dir, id), 'utf8'));
      const downs = rec.events.filter((e: any) => e.type === 'environment-down');
      assert.deepEqual(downs.map((e: any) => [e.trigger, e.ok]), [['archive', false], ['archive', true]]);
      assert.ok(rec.events.findIndex((e: any) => e.type === 'environment-down' && e.ok) < rec.events.findIndex((e: any) => e.type === 'archived'));
    } finally {
      r.cleanup();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('archive refuses links and traversal', async () => {
    const r = repo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
    try {
      const snapshot = () => tree(outside);
      for (const bad of ['../x', 'a/b', '..', '.forge']) {
        const res = await forgeAsync(r.dir, ['job', 'archive', bad], ACTOR);
        assert.equal(res.status, 1, bad);
      }
      // A symlinked job dir: its target is never touched.
      const real = path.join(outside, 'linked');
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, 'job.json'), JSON.stringify({ schemaVersion: 10, id: 'linked', state: 'done', stage: 'done', finishedAt: ago(5) }));
      fs.mkdirSync(path.join(r.dir, '.forge', 'jobs'), { recursive: true });
      fs.symlinkSync(real, path.join(r.dir, '.forge', 'jobs', 'linked'));
      let before = snapshot();
      let res = await forgeAsync(r.dir, ['job', 'archive', 'linked'], ACTOR);
      assert.equal(res.status, 1);
      assert.ok(res.stderr.includes('not a readable job'), res.stderr);
      assert.deepEqual(snapshot(), before);
      assert.ok(fs.lstatSync(path.join(r.dir, '.forge', 'jobs', 'linked')).isSymbolicLink());
      fs.rmSync(path.join(r.dir, '.forge', 'jobs', 'linked'));
      // A symlinked .forge/archive: nothing lands in its target and the job stays.
      const id = seedJob(r.dir, 'Victim');
      const target = path.join(outside, 'archive');
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(r.dir, '.forge', 'archive'));
      before = snapshot();
      const jobBefore = tree(jobDir(r.dir, id));
      res = await forgeAsync(r.dir, ['job', 'archive', id], ACTOR);
      assert.equal(res.status, 1);
      assert.deepEqual(snapshot(), before, 'nothing written through the link');
      assert.deepEqual(tree(jobDir(r.dir, id)), jobBefore, 'the job is untouched');
      fs.rmSync(path.join(r.dir, '.forge', 'archive'));
      // A link planted at the record's path is replaced, not followed.
      fs.mkdirSync(path.join(r.dir, '.forge', 'archive'));
      const secret = path.join(outside, 'secret.json');
      fs.writeFileSync(secret, 'keep');
      fs.symlinkSync(secret, archiveFile(r.dir, id));
      res = await forgeAsync(r.dir, ['job', 'archive', id], ACTOR);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.readFileSync(secret, 'utf8'), 'keep');
      assert.ok(fs.lstatSync(archiveFile(r.dir, id)).isFile());
      assert.equal(json(fs.readFileSync(archiveFile(r.dir, id), 'utf8')).id, id);
    } finally {
      r.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('audit reads archived jobs', async () => {
    const r = repo();
    try {
      const ids = [richJob(r.dir, 'One', 4, 1), richJob(r.dir, 'Two', 5, 2)];
      const range = ['--since', '2000-01-01', '--until', '2100-01-01'];
      const beforeJson = json((await forgeAsync(r.dir, ['audit', ...range, '--json'])).stdout);
      const beforeCsv = (await forgeAsync(r.dir, ['audit', ...range, '--csv'])).stdout;
      const res = await forgeAsync(r.dir, ['job', 'archive', '--done', '--older-than', '1'], ACTOR);
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(json(res.stdout).archived.map((a: any) => a.id).sort(), [...ids].sort());
      const after = json((await forgeAsync(r.dir, ['audit', ...range, '--json'])).stdout);
      const archivedRows = after.rows.filter((x: any) => x.action === 'archived');
      assert.deepEqual(archivedRows.map((x: any) => x.job).sort(), [...ids].sort(), 'one archived row per job');
      assert.ok(archivedRows.every((x: any) => x.actor.login === 'tester' && x.detail === 'cli'));
      assert.deepEqual(after.rows.filter((x: any) => x.action !== 'archived'), beforeJson.rows, 'the same rows as before');
      assert.deepEqual(after.prs, beforeJson.prs);
      const afterCsv = (await forgeAsync(r.dir, ['audit', ...range, '--csv'])).stdout.split('\r\n');
      assert.deepEqual(afterCsv.filter((l) => !l.includes(',archived,')), beforeCsv.split('\r\n'));
      assert.equal(afterCsv.filter((l) => l.includes(',archived,')).length, 2);
      const one = await forgeAsync(r.dir, ['job', 'audit', ids[0]]);
      assert.equal(one.status, 0, one.stderr);
      assert.equal(json(one.stdout).title, 'One');
      assert.equal(json(one.stdout).pr.number, 11);
    } finally {
      r.cleanup();
    }
  });
});

test('stats do not change after archiving', async () => {
  const r = repo();
  try {
    const ids = [richJob(r.dir, 'A', 3, 1), richJob(r.dir, 'B', 4, 2), richJob(r.dir, 'C', 6, 3)];
    seedJob(r.dir, 'Still going', { state: 'waiting', stage: 'decide', patch: (j) => void (j.waitingOn = 'escalation') });
    seedJob(r.dir, 'Cancelled', { state: 'cancelled', stage: 'build', days: 2 });
    const since = ago(5);
    const strip = (s: any) => {
      const { generatedAt: _g, counts, ...rest } = s;
      const { archived: _a, ...c } = counts;
      return { ...rest, counts: c };
    };
    const before = computeStats(r.dir);
    const beforeSince = computeStats(r.dir, { since });
    assert.equal(before.counts.archived, 0);
    const res = await forgeAsync(r.dir, ['job', 'archive', '--done', '--older-than', '1'], ACTOR);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(json(res.stdout).archived.length, 4);
    for (const id of ids) assert.equal(fs.existsSync(jobDir(r.dir, id)), false);
    const after = computeStats(r.dir);
    assert.equal(after.counts.archived, 4);
    assert.deepEqual(strip(after), strip(before));
    const afterSince = computeStats(r.dir, { since });
    assert.deepEqual(strip(afterSince), strip(beforeSince));
    assert.equal(afterSince.counts.archived, beforeSince.counts.total - 1, 'the waiting job is the only live one in the window');
    assert.ok(before.quality.recurringFindings > 0 && Object.keys(before.verifiers).length && before.cost.byModel['claude-opus-5-5'], 'the fixture exercises findings, verifiers and usage');
    const text = await forgeAsync(r.dir, ['stats']);
    assert.match(text.stdout, /jobs 5 \(4 archived\)/);
  } finally {
    r.cleanup();
  }
});

test('retro and dependencies read archives', async () => {
  const r = repo();
  try {
    seedJob(r.dir, 'Old one', { days: 20 });
    seedJob(r.dir, 'Old two', { days: 18 });
    const retro = createJob(r.dir, defaults(), { title: 'Retro', kind: 'retro' }).id;
    updateJob(r.dir, retro, (j) => {
      j.createdAt = ago(15);
      j.state = 'done';
      j.stage = 'done';
      j.finishedAt = ago(14);
    });
    seedJob(r.dir, 'New one', { days: 10 });
    seedJob(r.dir, 'New two', { days: 9 });
    const cfg = defaults();
    const before = retroDue(r.dir, cfg);
    assert.equal(before.lastRetro, retro);
    assert.equal(before.finishedSinceLast, 2);
    const res = await forgeAsync(r.dir, ['job', 'archive', '--done', '--older-than', '1'], ACTOR);
    assert.equal(json(res.stdout).archived.length, 5, res.stdout);
    assert.deepEqual(retroDue(r.dir, cfg), before);
    const dep = json(res.stdout).archived[0].id;
    const waiting = seedJob(r.dir, 'Waits', { state: 'queued', stage: 'backlog', patch: (j) => void (j.dependsOn = [dep]) });
    assert.deepEqual(unmetDependencies(r.dir, loadJob(r.dir, waiting)), [], 'an archived done dependency is met');
  } finally {
    r.cleanup();
  }
});

/** GET one path from the dashboard server with a loopback Host. */
function get(port: number, p: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

test('archived jobs only in stats', async () => {
  const r = repo();
  const { startServer } = await import('../lib/server.ts');
  try {
    const gone = seedJob(r.dir, 'Gone');
    const kept = seedJob(r.dir, 'Kept', { state: 'running', stage: 'build' });
    assert.equal((await forgeAsync(r.dir, ['job', 'archive', gone], ACTOR)).status, 0);
    const list = json((await forgeAsync(r.dir, ['job', 'list', '--all'])).stdout);
    assert.deepEqual(list.map((j: any) => j.id), [kept]);
    const srv = await startServer(r.dir, { port: 0 });
    try {
      const port = Number(new URL(srv.url).port);
      const state = await get(port, '/api/state');
      assert.deepEqual(state.jobs.map((j: any) => j.id), [kept]);
      const stats = await get(port, '/api/stats');
      assert.equal(stats.counts.total, 2);
      assert.equal(stats.counts.archived, 1);
      assert.equal(stats.counts.done, 1);
    } finally {
      await srv.close();
    }
  } finally {
    r.cleanup();
  }
});

describe('retention config and policy', { concurrency: 4 }, () => {
  test('retention config v7', () => {
    assert.deepEqual(defaults().retention, { jobsDays: null, logsDays: null, logMaxBytes: null });
    assert.equal(CONFIG_SCHEMA_VERSION, 24);
    const v6 = { schemaVersion: 6, git: { base: 'trunk' }, daemon: { maxConcurrent: 2 } };
    const { config, from } = migrateConfig(structuredClone(v6));
    assert.equal(from, 6);
    assert.deepEqual(config, { ...v6, schemaVersion: 24, repos: [], downstream: { enabled: true, max: 5, skip: [] } }, 'only schemaVersion, the empty repos list and the downstream default change');
    const problems = (retention: Record<string, unknown>) => validateConfig({ ...defaults(), retention: { ...defaults().retention, ...retention } }, process.cwd()).filter((p) => p.startsWith('retention'));
    assert.deepEqual(problems({}), []);
    assert.deepEqual(problems({ jobsDays: 30, logsDays: 3650, logMaxBytes: 1048576 }), []);
    assert.equal(problems({ jobsDays: 0 }).length, 1);
    assert.equal(problems({ logsDays: '7' }).length, 1);
    assert.equal(problems({ logMaxBytes: 1000 }).length, 1);
    assert.equal(problems({ logMaxBytes: 2 ** 31 }).length, 1);
    assert.equal(problems({ jobsDays: 1.5 }).length, 1);
  });

  test('retention settings', async () => {
    const field = (k: string) => FIELDS.find((f) => f.key === k);
    assert.deepEqual(
      ['retention.jobsDays', 'retention.logsDays', 'retention.logMaxBytes'].map((k) => {
        const f = field(k)!;
        return [f.section, f.type, f.nullable, f.editable, f.lockedReason, f.min];
      }),
      [
        ['pipeline', 'integer', true, false, 'deletes job files', 1],
        ['daemon', 'integer', true, false, 'deletes session logs', 1],
        ['daemon', 'integer', true, true, null, 1048576],
      ],
    );
    assert.equal(CONFIG_DISCLOSURE.retention, 'plain');
    assert.equal(disclosureOf('retention.jobsDays'), 'plain');
    const r = repo();
    try {
      const ok = await forgeAsync(r.dir, ['config', 'set', 'retention.logMaxBytes', '2097152'], ACTOR);
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(fs.readFileSync(path.join(r.dir, '.forge', 'config.yml'), 'utf8'), /logMaxBytes: 2097152/);
      const locked = await forgeAsync(r.dir, ['config', 'set', 'retention.jobsDays', '30'], ACTOR);
      assert.equal(locked.status, 1);
      assert.match(locked.stderr, /deletes job files/);
      assert.equal((await forgeAsync(r.dir, ['config', 'set', 'retention.logMaxBytes', '1000'], ACTOR)).status, 1, 'under 1 MiB');
    } finally {
      r.cleanup();
    }
  });

  test('sync applies the policy', async () => {
    const r = repo();
    try {
      const old = seedJob(r.dir, 'Two days', { days: 2 });
      const fresh = seedJob(r.dir, 'Fresh', { days: 0 });
      let res = await forgeAsync(r.dir, ['sync'], ACTOR);
      assert.equal(res.status, 0, res.stderr);
      assert.equal('retention' in json(res.stdout), false, 'no policy key, no retention output');
      assert.equal(fs.existsSync(path.join(r.dir, '.forge', 'archive')), false);
      setJobsDays(r.dir, 1);
      res = await forgeAsync(r.dir, ['sync'], ACTOR);
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(json(res.stdout).retention, { archived: [old], logs: [] });
      assert.equal(json(fs.readFileSync(archiveFile(r.dir, old), 'utf8')).trigger, 'policy');
      assert.ok(fs.existsSync(jobDir(r.dir, fresh)));
      assert.deepEqual(retentionLines(r.dir).map((l) => [l.kind, l.id, l.trigger]), [['job', old, 'policy']]);
    } finally {
      r.cleanup();
    }
  });

  test('dash applies the policy at startup', async () => {
    const r = repo();
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const start = (args: string[]) => {
      const child = spawn(process.execPath, [BIN, 'dash', '--foreground', '--port', String(port), ...args], { cwd: r.dir, env: { ...process.env, FORGE_ROOT: r.dir, ...ACTOR }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      return { child, out: () => out };
    };
    const stop = (child: ReturnType<typeof spawn>) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      });
    try {
      const old = seedJob(r.dir, 'Old', { days: 3 });
      setJobsDays(r.dir, 1);
      const dev = start(['--dev']);
      try {
        await waitFor(() => dev.out().includes('dashboard'), { timeoutMs: 15_000, what: 'the dev dashboard URL' }).catch((e) => assert.fail(`${e.message}: ${dev.out()}`));
        assert.equal(fs.existsSync(retentionLog(r.dir)), false, 'a dev dashboard applies no policy');
        assert.ok(fs.existsSync(jobDir(r.dir, old)));
      } finally {
        await stop(dev.child);
      }
      const live = start([]);
      try {
        await waitFor(() => fs.existsSync(retentionLog(r.dir)), { timeoutMs: 15_000, what: 'retention.log' });
        await waitFor(() => live.out().includes('dashboard'), { timeoutMs: 15_000, what: 'the dashboard URL' });
        assert.ok(fs.existsSync(archiveFile(r.dir, old)));
        assert.equal(fs.existsSync(jobDir(r.dir, old)), false);
        assert.equal(retentionLines(r.dir)[0].trigger, 'policy');
      } finally {
        await stop(live.child);
      }
    } finally {
      r.cleanup();
    }
  });

  test('doctor reports storage', async () => {
    const r = repo();
    try {
      richJob(r.dir, 'Sized', 2, 1);
      const res = await forgeAsync(r.dir, ['doctor', '--json']);
      const check = json(res.stdout).checks.find((c: any) => c.name === 'storage');
      assert.ok(check, res.stdout);
      assert.equal(check.ok, true);
      assert.match(check.detail, /^jobs \d+(\.\d)? (B|KB|MB) · archive 0 B · runtime \d+(\.\d)? (B|KB|MB)$/);
      assert.equal(check.warn, undefined);
      const big = storageCheck(r.dir, 1024);
      assert.equal(big.ok, true);
      assert.equal(big.warn, true);
      assert.match(big.detail, /; run forge job prune --older-than 30 --dry-run$/);
      // A symlink is measured as itself, never followed.
      fs.symlinkSync('/', path.join(r.dir, '.forge', 'archive'));
      assert.match(storageCheck(r.dir).detail, /archive \d B/);
    } finally {
      r.cleanup();
    }
  });

  test('refused in daemon sessions', async () => {
    const r = repo();
    try {
      const id = seedJob(r.dir, 'Target');
      for (const scope of ['_inbox', id]) {
        const env = { ...ACTOR, FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: scope, [TRUST_ENV]: trustDigest(r.dir) };
        for (const args of [['job', 'archive', id], ['job', 'archive', '--done', '--older-than', '0'], ['job', 'prune', '--older-than', '0']]) {
          const res = await forgeAsync(r.dir, args, env);
          assert.equal(res.status, 1, `${scope}: ${args.join(' ')}`);
          assert.match(res.stderr, /run it from your own terminal/);
        }
      }
      assert.ok(fs.existsSync(jobDir(r.dir, id)), 'nothing archived');
    } finally {
      r.cleanup();
    }
  });
});
