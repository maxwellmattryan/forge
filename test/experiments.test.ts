import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeSync, repoTemplate } from './helpers.ts';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { bootstrap, checkNotes, evaluateExperiments, mulberry32, newcombe, seedFor, validMetricPath, validWrittenStatus, wilson } from '../lib/experiments.ts';
import { createJob, loadJob, setJob } from '../lib/jobs.ts';
import { parseExperiments } from '../lib/learnings.ts';
import { createWorktree, verify } from '../lib/worktree.ts';
import type { Config } from '../lib/types.ts';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, verify: ['test'], worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
  const init = forgeSync(dir, ['init', 'write', '--answers', answers]);
  if (init.status !== 0) throw new Error(init.stderr);
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

const HEADER = ['# Forge experiments', '', '<!--', 'An example kept out of the ledger:', '- 2026-10-01 · id in-comment · x · metric quality.avgRounds (down) · baseline 1 · status open', '-->', ''];
const TODAY = '2026-10-21';

function scratch() {
  const r = template();
  const config = loadConfig(r.dir).config;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  return { ...r, config, git: (...args: string[]) => git(r.dir, ...args), gitIn: git, cleanup: () => (r.cleanup(), fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true })) };
}

const ledgerOf = (dir: string) => path.join(dir, '.forge', 'notes', 'experiments.md');
const writeLedger = (dir: string, lines: string[]) => fs.writeFileSync(ledgerOf(dir), [...HEADER, ...lines, ''].join('\n'));

/** A finished job: done (or cancelled), with job.json fields that set its per-job metric values. */
function finished(dir: string, config: Config, fields: Record<string, unknown> = {}, state: 'done' | 'cancelled' = 'done'): string {
  const { id } = createJob(dir, config, { title: `Job ${crypto.randomUUID().slice(0, 8)}` });
  setJob(dir, id, { state, ...(Object.keys(fields).length ? { fields } : {}) });
  return id;
}

/** The ledger text with the `status open` of entry `id` replaced: what an edit of that one segment gives. */
function replaced(text: string, id: string, status: string): string {
  const at = text.indexOf('status open', text.indexOf(`· id ${id} ·`));
  return text.slice(0, at) + status + text.slice(at + 'status open'.length);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

test('evaluate keeps an entry whose interval is wholly on the improving side', () => {
  const s = scratch();
  try {
    writeLedger(s.dir, [
      '- 2026-10-01 · id fewer-fails · a rate change · metric quality.verifyFirstPassRate (down) · baseline 0.5 (10/20) · evidence x · status open',
      '- 2026-10-01 · id history · x · metric quality.avgRounds (down) · baseline 1 · status kept (2026-10-05, n 5, bootstrap, diff -0.5..-0.1)',
    ]);
    for (let i = 0; i < 8; i++) finished(s.dir, s.config, { 'verify.1': 'FAIL' });
    const before = fs.readFileSync(ledgerOf(s.dir), 'utf8');
    const r = evaluateExperiments(s.dir, s.config, { today: TODAY });
    const [lo, hi] = newcombe(0, 8, 0.5, 20).map(round3);
    assert.ok(hi < 0, 'the interval is wholly below 0');
    const status = `status kept (${TODAY}, n 8, two-proportion, diff ${lo}..${hi})`;
    assert.deepEqual(r.entries[0], {
      id: 'fewer-fails', metric: 'quality.verifyFirstPassRate', direction: 'down', baseline: 0.5, baselineN: 20,
      jobsAfter: 8, n: 8, value: 0, method: 'two-proportion', interval: [lo, hi], verdict: 'kept', status, reason: null,
    });
    assert.equal(r.entries[1].verdict, 'settled');
    assert.equal(r.entries.length, 2, 'the commented example is no entry');
    assert.deepEqual([r.written, r.dryRun], [1, false]);
    assert.equal(fs.readFileSync(ledgerOf(s.dir), 'utf8'), replaced(before, 'fewer-fails', status), 'every other byte, the comment included, is unchanged');
    assert.ok(validWrittenStatus(parseExperiments(before)[0], status, s.config), 'the checker accepts what the writer wrote');
    // A second run has nothing left to settle.
    assert.equal(evaluateExperiments(s.dir, s.config, { today: TODAY }).written, 0);
  } finally {
    s.cleanup();
  }
});

test('evaluate reverts a worse mean, deterministically', () => {
  const s = scratch();
  try {
    writeLedger(s.dir, ['- 2026-10-01 · id fewer-rounds · x · metric quality.avgRounds (down) · baseline 1.59 · status open']);
    const two = { 'verdicts.1': { code: 'CHANGES' }, 'verdicts.2': { code: 'PASS' } };
    for (let i = 0; i < 3; i++) finished(s.dir, s.config, two);
    for (let i = 0; i < 3; i++) finished(s.dir, s.config, { ...two, 'verdicts.3': { code: 'PASS' } });
    const a = evaluateExperiments(s.dir, s.config, { dryRun: true, today: TODAY }).entries[0];
    const b = evaluateExperiments(s.dir, s.config, { dryRun: true, today: TODAY }).entries[0];
    assert.deepEqual(a, b, 'the bootstrap is seeded by the entry id');
    assert.deepEqual([a.method, a.n, a.value, a.verdict], ['bootstrap', 6, 2.5, 'reverted']);
    assert.ok(a.interval![0] > 0, 'wholly above the baseline');
    const real = evaluateExperiments(s.dir, s.config, { today: TODAY });
    assert.equal(real.entries[0].status, a.status);
    assert.match(fs.readFileSync(ledgerOf(s.dir), 'utf8'), new RegExp(`· status reverted \\(${TODAY}, n 6, bootstrap, diff ${a.interval![0]}\\.\\.${a.interval![1]}\\)\\n`));
    // The PRNG itself: the same seed resamples the same way, another seed does not.
    const xs = [1, 2, 3, 4, 10];
    assert.deepEqual(bootstrap(xs, seedFor('x')), bootstrap(xs, seedFor('x')));
    const draws = (seed: number) => Array.from({ length: 5 }, mulberry32(seed));
    assert.notDeepEqual(draws(seedFor('x')), draws(seedFor('y')));
  } finally {
    s.cleanup();
  }
});

test('evaluate closes an inconclusive entry only after maxJobs', () => {
  const s = scratch();
  try {
    writeLedger(s.dir, ['- 2026-10-01 · id coin · x · metric quality.verifyFirstPassRate (up) · baseline 0.5 · status open']);
    for (const v of ['PASS', 'FAIL', 'PASS', 'FAIL', 'PASS', 'FAIL']) finished(s.dir, s.config, { 'verify.1': v });
    const before = fs.readFileSync(ledgerOf(s.dir), 'utf8');
    const open = evaluateExperiments(s.dir, s.config, { today: TODAY });
    const [l, u] = wilson(0.5, 6);
    const interval = [round3(l - 0.5), round3(u - 0.5)];
    assert.deepEqual([open.entries[0].method, open.entries[0].interval, open.entries[0].verdict, open.entries[0].status, open.written], ['wilson', interval, 'inconclusive', 'status open', 0]);
    assert.equal(fs.readFileSync(ledgerOf(s.dir), 'utf8'), before, 'still open below maxJobs');
    // Four more finished jobs with no verify: they count toward the cap but give no sample.
    for (let i = 0; i < 4; i++) finished(s.dir, s.config, {}, 'cancelled');
    const closed = evaluateExperiments(s.dir, s.config, { today: TODAY });
    const status = `status inconclusive (${TODAY}, n 6, wilson, diff ${interval[0]}..${interval[1]})`;
    assert.deepEqual([closed.entries[0].jobsAfter, closed.entries[0].n, closed.entries[0].status, closed.written], [10, 6, status, 1]);
    assert.equal(fs.readFileSync(ledgerOf(s.dir), 'utf8'), replaced(before, 'coin', status));
    assert.ok(validWrittenStatus(parseExperiments(before)[0], status, s.config));
  } finally {
    s.cleanup();
  }
});

test('evaluate below the minimum n', () => {
  const s = scratch();
  try {
    writeLedger(s.dir, ['- 2026-10-01 · id few · x · metric quality.verifyFirstPassRate (up) · baseline 0.5 (5/10) · status open']);
    for (let i = 0; i < 3; i++) finished(s.dir, s.config, { 'verify.1': 'PASS' });
    const before = fs.readFileSync(ledgerOf(s.dir), 'utf8');
    const pending = evaluateExperiments(s.dir, s.config, { today: TODAY }).entries[0];
    assert.deepEqual([pending.verdict, pending.n, pending.interval, pending.status], ['pending', 3, null, 'status open'], 'nothing is computed');
    assert.equal(fs.readFileSync(ledgerOf(s.dir), 'utf8'), before);
    for (let i = 0; i < 7; i++) finished(s.dir, s.config, {}, 'cancelled');
    const closed = evaluateExperiments(s.dir, s.config, { today: TODAY });
    const status = `status inconclusive (${TODAY}, n 3 below minJobs 5 after 10 jobs)`;
    assert.deepEqual([closed.entries[0].verdict, closed.entries[0].status, closed.written], ['pending', status, 1]);
    assert.equal(fs.readFileSync(ledgerOf(s.dir), 'utf8'), replaced(before, 'few', status));
    assert.ok(validWrittenStatus(parseExperiments(before)[0], status, s.config));
  } finally {
    s.cleanup();
  }
});

/** A job with a worktree on a branch from `main`, whose ledger the test edits and commits. */
function jobWorktree(s: ReturnType<typeof scratch>) {
  const { id } = createJob(s.dir, s.config, { title: `Branch ${crypto.randomUUID().slice(0, 8)}` });
  const created = createWorktree(s.dir, s.config, id);
  assert.ok(created.ok, JSON.stringify(created));
  setJob(s.dir, id, { fields: { round: 1 } });
  const job = loadJob(s.dir, id);
  const wt = job.worktree!;
  const commit = (rel: string, text: string, msg = 'edit') => {
    fs.writeFileSync(path.join(wt, rel), text);
    s.gitIn(wt, 'add', '-A');
    s.gitIn(wt, 'commit', '-qm', msg);
    return s.gitIn(wt, 'rev-parse', 'HEAD');
  };
  return { id, job, wt, commit };
}

const commitMain = (s: ReturnType<typeof scratch>) => {
  s.git('add', '-A');
  s.git('commit', '-qm', 'notes');
};

test('an invalid metric is closed, reported and refused at verify', async () => {
  const s = scratch();
  try {
    // Existing entries without the new fields, committed before the branch: history, never failed.
    fs.writeFileSync(path.join(s.dir, '.forge', 'notes', 'learnings.md'), '# Forge learnings\n\n- **Old rule** — why. (added 2026-10-01)\n');
    writeLedger(s.dir, ['- 2026-10-01 · id prose · x · metric docs reviews per code review (down) · baseline 1 · status open']);
    commitMain(s);
    const audit = forgeSync(s.dir, ['experiment', 'check']);
    assert.equal(audit.status, 1);
    const problems = JSON.parse(audit.stdout).problems.map((p: any) => p.problem);
    assert.ok(problems.includes('metric docs reviews per code review is not a stats path'), problems.join('\n'));
    assert.ok(problems.includes('missing experiment:') && problems.includes('missing review-by:'), 'a full audit reports old learnings too');

    // A branch that only touches code has no notes step; one that adds unmeasurable entries fails it.
    const clean = jobWorktree(s);
    clean.commit('code.txt', 'x\n');
    const plain = await verify(s.dir, s.config, clean.id);
    assert.ok(plain.ok && !plain.steps.some((st) => st.name === 'notes'), JSON.stringify(plain.steps));

    const bad = jobWorktree(s);
    const ledger = fs.readFileSync(ledgerOf(bad.wt), 'utf8');
    bad.commit('.forge/notes/experiments.md', ledger + '- 2026-10-20 · id vague · x · metric fewer surprises (down) · baseline 1 · status open\n');
    bad.commit('.forge/notes/learnings.md', fs.readFileSync(path.join(bad.wt, '.forge', 'notes', 'learnings.md'), 'utf8') + '- **New rule** — no fields. (added 2026-10-20)\n');
    // Left in the working tree, never committed: verify reads committed content only.
    const v = await verify(s.dir, s.config, bad.id);
    const notes = v.steps.find((st) => st.name === 'notes');
    assert.equal(notes?.ok, false, JSON.stringify(v.steps));
    assert.ok(v.steps.some((st) => st.name === 'test' && st.ok), 'not a gate: the configured steps still ran');
    const report = fs.readFileSync(path.join(s.dir, v.file), 'utf8');
    assert.match(report, /## notes: FAILED/);
    assert.match(report, /metric fewer surprises is not a stats path/);
    assert.match(report, /learnings\.md: missing experiment:/);
    assert.doesNotMatch(report, /Old rule|id prose/, 'unchanged entries are history');

    // Without a merge base, notes that differ from the main checkout's HEAD fail the step; matching ones need none.
    setJob(s.dir, bad.id, { fields: { base: 'no-such-branch' } });
    const unresolved = await verify(s.dir, s.config, bad.id);
    assert.equal(unresolved.steps.find((st) => st.name === 'notes')?.ok, false, JSON.stringify(unresolved.steps));
    const tail = fs.readFileSync(path.join(s.dir, unresolved.file), 'utf8');
    assert.match(tail, /could not resolve the base \(base no-such-branch not found\), and \.forge\/notes\/learnings\.md, \.forge\/notes\/experiments\.md differ from the main checkout's HEAD/);
    setJob(s.dir, clean.id, { fields: { base: 'no-such-branch' } });
    const matching = await verify(s.dir, s.config, clean.id);
    assert.ok(!matching.steps.some((st) => st.name === 'notes'), JSON.stringify(matching.steps));

    // evaluate closes the prose entry at once, and the checker accepts that status.
    const r = evaluateExperiments(s.dir, s.config, { today: TODAY });
    assert.equal(r.entries[0].status, `status inconclusive (${TODAY}, metric is not a stats path)`);
    assert.ok(validWrittenStatus(parseExperiments(fs.readFileSync(ledgerOf(s.dir), 'utf8'))[0], r.entries[0].status!, s.config));

    // Hostile text stays linear: a 10k-character entry and status.
    const started = Date.now();
    const long = `status kept (${TODAY}, n ${'9'.repeat(10_000)}, bootstrap, diff ${'1'.repeat(10_000)}..1`;
    assert.equal(validWrittenStatus(parseExperiments('- 2026-10-01 · id x · metric quality.avgRounds (down) · baseline 1')[0], long, s.config), false);
    validMetricPath('a.'.repeat(5_000) + 'b');
    writeLedger(s.dir, [`- 2026-10-01 · id long · ${'· '.repeat(5_000)}metric ${'a.'.repeat(5_000)} (down) · baseline 1 · status open ${'('.repeat(5_000)}`]);
    checkNotes(s.dir, s.config, null);
    assert.ok(Date.now() - started < 2000, 'linear on hostile input');

    // Past 1 MiB a notes file is reported, never parsed: committed on a branch, or on disk in an audit.
    const over = { ok: false, problems: [{ file: '.forge/notes/experiments.md', entry: '', problem: 'over 1 MiB; not checked' }] };
    const big = jobWorktree(s);
    big.commit('.forge/notes/experiments.md', ledger + `- 2026-10-20 · id big · x · metric quality.avgRounds (down) · baseline 1 · evidence ${'x'.repeat(1024 * 1024)} · status open\n`);
    assert.deepEqual(checkNotes(s.dir, s.config, big.job), over);
    fs.copyFileSync(ledgerOf(big.wt), ledgerOf(s.dir));
    assert.deepEqual(checkNotes(s.dir, s.config, null), over);
  } finally {
    s.cleanup();
  }
});

test("check matches ledger entries by id: evaluate's settlement passes, hand edits fail", async () => {
  const s = scratch();
  try {
    const base = [
      '- 2026-10-01 · id a · x · metric counts.done (up) · baseline 0.5 · status open',
      '- 2026-10-01 · id b · x · metric docs per code (down) · baseline 1 · status open',
      '- 2026-10-01 · id c · x · metric quality.verifyFirstPassRate (up) · baseline 0.5 · status open',
      '- 2026-10-01 · id d · x · metric quality.avgRounds (down) · baseline 1.5 · status kept (2026-10-05, n 5, bootstrap, diff -0.5..-0.1)',
    ];
    writeLedger(s.dir, base);
    commitMain(s);
    // Ten done jobs: counts.done is 1 for each (a is kept); only three have a verify (c closes below minJobs).
    for (let i = 0; i < 10; i++) finished(s.dir, s.config, i < 3 ? { 'verify.1': 'PASS' } : {});
    const j = jobWorktree(s);
    const r = evaluateExperiments(s.dir, s.config, { job: j.job });
    assert.equal(r.written, 3);
    const settled = fs.readFileSync(ledgerOf(j.wt), 'utf8');
    assert.match(settled, /id a .* · status kept \(\d{4}-\d{2}-\d{2}, n 10, bootstrap, diff 0\.5\.\.0\.5\)\n/);
    assert.match(settled, /id b .* · status inconclusive \(\d{4}-\d{2}-\d{2}, metric is not a stats path\)\n/);
    assert.match(settled, /id c .* · status inconclusive \(\d{4}-\d{2}-\d{2}, n 3 below minJobs 5 after 10 jobs\)\n/);
    const sha = j.commit('.forge/notes/experiments.md', settled, 'settle');
    assert.deepEqual(checkNotes(s.dir, s.config, j.job), { ok: true, problems: [] }, 'all three written forms pass');
    const cli = forgeSync(s.dir, ['experiment', 'check', j.id]);
    assert.equal(cli.status, 0, cli.stdout);
    const v = await verify(s.dir, s.config, j.id);
    assert.deepEqual(v.steps.find((st) => st.name === 'notes')?.ok, true, JSON.stringify(v.steps));

    const lines = settled.split('\n');
    const at = (id: string) => lines.findIndex((l) => l.includes(`· id ${id} ·`));
    const edit = (fn: (ls: string[]) => void) => {
      const ls = [...lines];
      fn(ls);
      return ls.join('\n');
    };
    const cases: [string, string, string][] = [
      ['hand-written kept', edit((ls) => (ls[at('a')] = base[0].replace('status open', 'status kept'))), 'only forge experiment evaluate writes a status'],
      ['a word that contradicts its interval', edit((ls) => (ls[at('a')] = base[0].replace('status open', `status kept (${TODAY}, n 10, bootstrap, diff -0.2..0.1)`))), 'only forge experiment evaluate writes a status'],
      ['an edited baseline', edit((ls) => (ls[at('a')] = base[0].replace('baseline 0.5', 'baseline 0.6'))), 'an existing entry may only change its status'],
      ['a changed settled entry', edit((ls) => (ls[at('d')] = base[3].replace('baseline 1.5', 'baseline 1.4'))), 'a settled entry is history and may not change'],
      ['a removed entry', edit((ls) => ls.splice(at('c'), 1)), 'entry c was removed'],
      ['a new entry that is not open', edit((ls) => ls.splice(at('d') + 1, 0, '- 2026-10-20 · id e · x · metric counts.done (up) · baseline 0.5 · status kept (2026-10-21, n 10, bootstrap, diff 0.5..0.5)')), 'status must be open'],
      ['two entries with one id', edit((ls) => ls.splice(at('d') + 1, 0, '- 2026-10-20 · id a · x · metric counts.done (up) · baseline 0.5 · status open')), 'duplicate id a'],
    ];
    for (const [label, text, want] of cases) {
      j.commit('.forge/notes/experiments.md', text, label);
      const c = checkNotes(s.dir, s.config, j.job);
      assert.equal(c.ok, false, label);
      assert.ok(c.problems.some((p) => p.problem === want), `${label}: ${JSON.stringify(c.problems)}`);
      assert.ok(c.problems.every((p) => p.file === '.forge/notes/experiments.md' && p.entry.length <= 80), label);
      s.gitIn(j.wt, 'reset', '-q', '--hard', sha);
    }
    // Through verify too: a hand edit fails its notes step.
    j.commit('.forge/notes/experiments.md', cases[0][1], 'hand edit');
    const failed = await verify(s.dir, s.config, j.id);
    assert.equal(failed.steps.find((st) => st.name === 'notes')?.ok, false);
  } finally {
    s.cleanup();
  }
});

/** A hash of every file and directory under `dir`, so any write there shows. */
function treeHash(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      h.update(`${path.relative(dir, p)}\0`);
      if (e.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

test('evaluate targets the job worktree, the repo, or nothing', () => {
  const s = scratch();
  try {
    writeLedger(s.dir, ['- 2026-10-01 · id a · x · metric counts.done (up) · baseline 0.5 · status open', '- 2026-10-01 · id b · x · metric docs per code (down) · baseline 1 · status open']);
    commitMain(s);
    for (let i = 0; i < 5; i++) finished(s.dir, s.config);
    const j = jobWorktree(s);
    const rootLedger = fs.readFileSync(ledgerOf(s.dir), 'utf8');
    const wtLedger = fs.readFileSync(ledgerOf(j.wt), 'utf8');
    const forge = path.join(s.dir, '.forge');
    const before = treeHash(forge);

    const dry = forgeSync(s.dir, ['experiment', 'evaluate', j.id, '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    const planned = JSON.parse(dry.stdout);
    assert.deepEqual([planned.dryRun, planned.written, planned.file], [true, 0, ledgerOf(fs.realpathSync(j.wt))]);
    assert.equal(fs.readFileSync(ledgerOf(j.wt), 'utf8'), wtLedger, 'a dry run writes nothing');

    const real = forgeSync(s.dir, ['experiment', 'evaluate', j.id]);
    assert.equal(real.status, 0, real.stderr);
    assert.equal(JSON.parse(real.stdout).written, 2);
    const written = fs.readFileSync(ledgerOf(j.wt), 'utf8');
    for (const e of planned.entries) assert.ok(written.includes(`· ${e.status}\n`), `the dry run's status is what the run wrote: ${e.status}`);
    assert.equal(treeHash(forge), before, "nothing under the root's .forge/ changed: jobs, events, locks, runtime, requests, notes");
    assert.equal(fs.readFileSync(ledgerOf(s.dir), 'utf8'), rootLedger);

    // Without a job: the repo's ledger, and nothing else.
    const withoutNotes = () => treeHash(path.join(forge, 'jobs'));
    const jobsBefore = withoutNotes();
    const repo = forgeSync(s.dir, ['experiment', 'evaluate']);
    assert.equal(repo.status, 0, repo.stderr);
    assert.equal(JSON.parse(repo.stdout).file, ledgerOf(fs.realpathSync(s.dir)));
    assert.notEqual(fs.readFileSync(ledgerOf(s.dir), 'utf8'), rootLedger);
    assert.equal(withoutNotes(), jobsBefore);

    // A job with no worktree, and a ledger reached through a link, are refused.
    const none = createJob(s.dir, s.config, { title: 'No worktree' }).id;
    assert.equal(forgeSync(s.dir, ['experiment', 'evaluate', none]).status, 1);
    const notes = path.join(j.wt, '.forge', 'notes');
    fs.rmSync(notes, { recursive: true });
    fs.symlinkSync(path.join(s.dir, '.forge', 'notes'), notes);
    const linked = forgeSync(s.dir, ['experiment', 'evaluate', j.id, '--json']);
    assert.equal(linked.status, 1);
    assert.match(JSON.parse(linked.stdout).error.message, /symlink/);
  } finally {
    s.cleanup();
  }
});

test('experiment and recall config is validated', () => {
  const problems = (edit: (c: any) => void) => {
    const c: any = defaults();
    edit(c);
    return validateConfig(c, process.cwd()).filter((p) => p.startsWith('improve.') || p.startsWith('evals.'));
  };
  const d = defaults();
  assert.deepEqual([d.improve.experiments, d.evals.recall], [{ minJobs: 5, maxJobs: 10 }, { paths: ['agents/', 'reviewers/', 'lib/brief.ts'] }]);
  assert.deepEqual(problems(() => {}), []);
  assert.deepEqual(problems((c) => (c.improve.experiments = { minJobs: 3, maxJobs: 3 })), []);
  for (const [label, edit] of [
    ['non-integer', (c: any) => (c.improve.experiments.minJobs = 2.5)],
    ['zero', (c: any) => (c.improve.experiments.maxJobs = 0)],
    ['a string', (c: any) => (c.improve.experiments.minJobs = '5')],
    ['max below min', (c: any) => (c.improve.experiments = { minJobs: 8, maxJobs: 4 })],
    ['not a map', (c: any) => (c.improve.experiments = [5, 10])],
    ['an empty path', (c: any) => (c.evals.recall.paths = ['agents/', ' '])],
    ['a non-string path', (c: any) => (c.evals.recall.paths = [3])],
    ['not a list', (c: any) => (c.evals.recall.paths = 'agents/')],
  ] as const)
    assert.equal(problems(edit).length, 1, label);
  // Metric paths: fixed ones, the keyed maps, and nothing else.
  for (const ok of ['quality.avgRounds', 'counts.done', 'quality.humanDeltaCoverage.merged', 'reviewers.security.missRate', 'reviewers.code.changeRate', 'verifiers.no-todo.hitRate', 'cost.byRole.builder.tokens', 'quality.scoreByBuilderModel.opus.medianScore'])
    assert.equal(validMetricPath(ok), true, ok);
  for (const bad of ['docs reviews per code review', 'quality', 'quality.missing', 'generatedAt.x', 'reviewers.code.severityTrend', 'reviewers.Bad_Lens.missRate', 'quality.__proto__', 'constructor.name', 'cost.byRole.builder.input', ''])
    assert.equal(validMetricPath(bad), false, bad);
});
