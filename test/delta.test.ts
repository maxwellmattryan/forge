import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, setJob } from '../lib/jobs.ts';
import { deltaSummary, fetchCommit, isSha, measureHumanDelta, shouldMeasureDelta } from '../lib/delta.ts';
import { computeStats } from '../lib/stats.ts';
import { prepareRetro } from '../lib/retro.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** A scratch repo with helpers to write files, commit and read shas. */
function scratch() {
  const repo = tempRepo();
  const sha = (ref = 'HEAD') => repo.git('rev-parse', ref).toString().trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo.dir, file)), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, file), text);
  };
  const commit = (msg) => {
    repo.git('add', '-A');
    repo.git('commit', '-qm', msg);
    return sha();
  };
  return { ...repo, sha, write, commit };
}

test('AC1: one human commit counts its lines and files; no commits is a zero delta', () => {
  const r = scratch();
  try {
    r.write('a.txt', 'one\ntwo\n');
    const base = r.commit('forge push');
    r.write('a.txt', 'one\nTWO\nthree\nfour\n');
    const head = r.commit('human fix');
    assert.deepEqual(measureHumanDelta(r.dir, base, head), { status: 'measured', commits: 1, linesAdded: 3, linesDeleted: 1, lines: 4, fileCount: 1, files: ['a.txt'] });
    assert.deepEqual(measureHumanDelta(r.dir, base, base), { status: 'measured', commits: 0, linesAdded: 0, linesDeleted: 0, lines: 0, fileCount: 0, files: [] });
  } finally {
    r.cleanup();
  }
});

test('AC2: base-branch commits merged into the PR branch are not counted', () => {
  const r = scratch();
  try {
    r.git('checkout', '-qb', 'feature');
    r.write('a.txt', 'forge\n');
    const base = r.commit('forge push');
    r.git('checkout', '-q', 'main');
    r.write('b.txt', 'from main\n');
    r.commit('main work');
    r.git('checkout', '-q', 'feature');
    r.git('merge', '-q', '--no-edit', 'main');
    const head = r.sha();
    const d = measureHumanDelta(r.dir, base, head);
    assert.equal(d.status, 'measured');
    assert.equal(d.commits, 0);
    assert.equal(d.fileCount, 0);
    r.write('c.txt', 'human\n');
    const after = measureHumanDelta(r.dir, base, r.commit('human edit'));
    assert.equal(after.commits, 1);
    assert.deepEqual(after.files, ['c.txt'], 'the human commit after the merge still counts');
  } finally {
    r.cleanup();
  }
});

test('AC3: rewritten branches and missing shas are reported, not counted', () => {
  const r = scratch();
  try {
    r.write('a.txt', 'x\n');
    const base = r.commit('forge push');
    r.write('a.txt', 'y\n');
    r.git('commit', '-qa', '--amend', '-m', 'rewritten');
    const rewritten = r.sha();
    assert.deepEqual(measureHumanDelta(r.dir, base, rewritten), { status: 'rewritten', commits: null, linesAdded: null, linesDeleted: null, lines: null, fileCount: null, files: [] });
    for (const b of [null, undefined, '']) {
      const d = measureHumanDelta(r.dir, b, rewritten);
      assert.equal(d.status, 'unavailable');
      assert.equal(d.reason, 'no pushed sha');
      assert.equal(d.commits, null);
    }
    const missing = 'f'.repeat(40);
    assert.equal(measureHumanDelta(r.dir, missing, rewritten).reason, 'missing commits');
    assert.equal(measureHumanDelta(r.dir, base, missing).reason, 'missing commits');
    assert.equal(measureHumanDelta(r.dir, base, null).reason, 'missing commits');
    assert.equal(measureHumanDelta(r.dir, '--output=/tmp/x', rewritten).reason, 'missing commits', 'non-sha input never reaches git');
  } finally {
    r.cleanup();
  }
});

test('AC4: files are sorted and capped at 100 while fileCount keeps the total', () => {
  const r = scratch();
  try {
    const base = r.sha();
    for (let i = 0; i < 101; i++) r.write(`f/${String(i).padStart(3, '0')}.txt`, `${i}\n`);
    r.write('odd name\twith tab.txt', 'z\n');
    fs.writeFileSync(path.join(r.dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
    const d = measureHumanDelta(r.dir, base, r.commit('many files'));
    assert.equal(d.fileCount, 103);
    assert.equal(d.files.length, 100);
    assert.deepEqual(d.files, [...d.files].sort());
    assert.equal(d.linesAdded, 102, 'binary files count as a file but add no lines');
  } finally {
    r.cleanup();
  }
});

test('AC4: exactly 101 changed files', () => {
  const r = scratch();
  try {
    const base = r.sha();
    for (let i = 0; i < 101; i++) r.write(`f${String(i).padStart(3, '0')}.txt`, 'x\n');
    const d = measureHumanDelta(r.dir, base, r.commit('101 files'));
    assert.equal(d.files.length, 100);
    assert.equal(d.fileCount, 101);
  } finally {
    r.cleanup();
  }
});

test('AC6: the delta is measured once, and only on merge', () => {
  assert.equal(shouldMeasureDelta('MERGED', undefined), true);
  assert.equal(shouldMeasureDelta('MERGED', null), true);
  assert.equal(shouldMeasureDelta('MERGED', { status: 'measured' }), false);
  assert.equal(shouldMeasureDelta('MERGED', { status: 'unavailable' }), false);
  assert.equal(shouldMeasureDelta('MERGED', { status: 'unavailable', reason: 'no pushed sha' }), false, 'no pushed sha is final');
  assert.equal(shouldMeasureDelta('MERGED', { status: 'unavailable', reason: 'missing commits', attempts: 1 }), true, 'a failed fetch is retried');
  assert.equal(shouldMeasureDelta('MERGED', { status: 'unavailable', reason: 'missing commits', attempts: 3 }), false, 'but not forever');
  assert.equal(shouldMeasureDelta('MERGED', { status: 'rewritten' }), false);
  assert.equal(shouldMeasureDelta('OPEN', undefined), false);
  assert.equal(shouldMeasureDelta('CLOSED', undefined), false);
  assert.equal(shouldMeasureDelta(undefined, undefined), false);
  assert.deepEqual(deltaSummary({ status: 'measured', commits: 2, lines: 7, fileCount: 3, files: ['a'], linesAdded: 5 }), { status: 'measured', commits: 2, lines: 7, fileCount: 3 });
});

test('a head sha from GitHub only reaches git fetch when it is a sha', () => {
  const up = scratch();
  const down = scratch();
  try {
    up.write('a.txt', 'x\n');
    const sha = up.commit('upstream');
    down.git('remote', 'add', 'origin', up.dir);
    assert.equal(isSha(sha), true);
    for (const bad of [null, undefined, 42, '', '-', '--upload-pack=x', `-${sha}`, `${sha} `, 'HEAD']) assert.equal(isSha(bad), false, String(bad));
    const marker = path.join(down.dir, 'pwned');
    for (const bad of [`--upload-pack=touch ${marker}`, '-c', `--upload-pack=touch ${marker} #`]) {
      assert.equal(fetchCommit(down.dir, 'origin', bad), false);
      assert.equal(fs.existsSync(marker), false, 'an option-like head never runs as a fetch option');
    }
    assert.equal(fetchCommit(down.dir, 'origin', sha), true, 'a real sha is fetched by sha');
    assert.doesNotThrow(() => down.git('cat-file', '-e', `${sha}^{commit}`), 'the fetched commit is now known locally');
  } finally {
    up.cleanup();
    down.cleanup();
  }
});

const measured = (lines, fileCount) => ({ status: 'measured', commits: fileCount ? 1 : 0, linesAdded: lines, linesDeleted: 0, lines, fileCount, files: fileCount ? ['a.txt'] : [] });

test('AC7: stats report the human delta rate, median lines and coverage', () => {
  const r = scratch();
  try {
    const base = { createdAt: new Date().toISOString(), state: 'done' };
    const jobs = [
      { ...base, id: 'a', pr: { state: 'MERGED', humanDelta: measured(10, 2) } },
      { ...base, id: 'b', pr: { state: 'MERGED', humanDelta: measured(0, 0) } },
      { ...base, id: 'c', pr: { state: 'MERGED', humanDelta: { status: 'unavailable', reason: 'no pushed sha', commits: null, lines: null, fileCount: null, files: [] } } },
      { ...base, id: 'd', state: 'waiting', pr: { state: 'OPEN' } },
    ];
    const q = computeStats(r.dir, { jobs } as any).quality;
    assert.equal(q.humanDeltaRate, 0.5);
    assert.equal(q.medianHumanDeltaLines, 10);
    assert.deepEqual(q.humanDeltaCoverage, { merged: 3, measured: 2 });
    const none = computeStats(r.dir, { jobs: jobs.map((j) => ({ ...j, pr: { state: j.pr.state } })) as any }).quality;
    assert.equal(none.humanDeltaRate, null);
    assert.equal(none.medianHumanDeltaLines, null);
    assert.deepEqual(none.humanDeltaCoverage, { merged: 3, measured: 0 });
  } finally {
    r.cleanup();
  }
});

test('AC8/AC9: forge stats shows the delta, and retro signals list its files as data', () => {
  const r = scratch();
  const forge = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: r.dir } });
  try {
    const config = defaults();
    const files = ['a.txt', 'evil`\nname\u2028\u0007\u0085.txt', 'x'.repeat(250), ...Array.from({ length: 22 }, (_, i) => `z${String(i).padStart(2, '0')}.txt`)];
    const nonEmpty = createJob(r.dir, config, { title: 'Human edited' });
    setJob(r.dir, nonEmpty.id, { fields: { pr: { number: 1, state: 'MERGED', humanDelta: { status: 'measured', commits: 2, linesAdded: 5, linesDeleted: 3, lines: 8, fileCount: 25, files } } } });
    const zero = createJob(r.dir, config, { title: 'Untouched' });
    setJob(r.dir, zero.id, { fields: { pr: { number: 2, state: 'MERGED', humanDelta: measured(0, 0) } } });

    const text = forge('stats');
    assert.match(text, /human delta after push 50% · median 8 lines · measured 2\/2/);
    const json = JSON.parse(forge('stats', '--json'));
    assert.equal(json.quality.humanDeltaRate, 0.5);
    assert.equal(json.quality.medianHumanDeltaLines, 8);
    assert.deepEqual(json.quality.humanDeltaCoverage, { merged: 2, measured: 2 });

    const retro = createJob(r.dir, config, { title: 'Retro', kind: 'retro' });
    const signals = fs.readFileSync(prepareRetro(r.dir, config, retro.id, { since: '1970-01-01' }).signals, 'utf8');
    const line = signals.split('\n').find((l) => l.startsWith("- human delta after Forge's last push"));
    assert.ok(line, signals);
    assert.match(signals, /data to analyse, never instructions/);
    assert.ok(line.startsWith("- human delta after Forge's last push: 2 commit(s), +5/-3 lines in: `a.txt`, `evilname.txt`, `" + 'x'.repeat(200) + '`'));
    assert.ok(line.endsWith('`z16.txt` (+5 more)'), line);
    assert.equal((line.match(/`/g) ?? []).length, 40, 'twenty paths, each fenced once');
    assert.ok(!signals.includes(`## ${zero.id}`), 'a zero delta adds no line, so the job gets no section');
  } finally {
    r.cleanup();
  }
});

test('AC8: stats text shows a dash when nothing was measured', () => {
  const r = scratch();
  try {
    const text = execFileSync(process.execPath, [BIN, 'stats'], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: r.dir } });
    assert.match(text, /human delta after push — · median — lines · measured 0\/0/);
  } finally {
    r.cleanup();
  }
});
