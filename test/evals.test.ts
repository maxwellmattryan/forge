import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scratchGitConfig, tempRepo } from './helpers.ts';
import { defaults, loadConfig } from '../lib/core/config/load.ts';
import { loadJob, setJob } from '../lib/core/job/store.ts';
import { configHash, gradeJob, startRun, summarize } from '../lib/engine/evals/run.ts';
import { evalCmd } from '../lib/commands/eval.ts';
import * as yaml from '../lib/core/format/yaml.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const sh = (cwd, ...args) => git(cwd, ...args).trim();
const commitAll = (cwd, msg) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg);
  return sh(cwd, 'rev-parse', 'HEAD');
};
/** A null value deletes the path. */
const write = (dir: string, files: Record<string, string | null>) => {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (text === null) {
      fs.rmSync(p, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
};

/** A scratch repo with Forge initialised and `base` committed on main. */
function scratch(base = {}) {
  const repo = tempRepo();
  const wtRoot = `${repo.dir}.wt`;
  const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
  fs.writeFileSync(answers, JSON.stringify({ commands: { build: 'true', test: 'true', lint: 'true' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: repo.dir, stdio: 'pipe', env: { ...process.env, FORGE_ROOT: repo.dir } });
  write(repo.dir, base);
  const sha = commitAll(repo.dir, 'base');
  return {
    dir: repo.dir,
    base: sha,
    config: () => loadConfig(repo.dir).config,
    cleanup: () => {
      repo.cleanup();
      fs.rmSync(wtRoot, { recursive: true, force: true });
      fs.rmSync(answers, { force: true });
    },
  };
}

/** The diff main → (main + changes), made on a throwaway branch the eval clone never sees. */
function hiddenPatch(dir, changes, ...diffArgs) {
  git(dir, 'checkout', '-qb', 'hidden');
  if (typeof changes === 'function') changes();
  else write(dir, changes);
  commitAll(dir, 'hidden');
  const patch = git(dir, 'diff', ...diffArgs, 'main', 'hidden');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', '-qD', 'hidden');
  return patch;
}

function addTask(dir, name, { base, patch, command }) {
  const tdir = path.join(dir, '.forge', 'evals', name);
  fs.mkdirSync(path.join(tdir, 'check'), { recursive: true });
  fs.writeFileSync(path.join(tdir, 'check', 'tests.patch'), patch);
  fs.writeFileSync(path.join(tdir, 'task.yml'), yaml.stringify({ title: name, request: `Do ${name}`, base, check: { patch: 'check/tests.patch', command } }));
}

/** Starts a run over `tasks` and returns each task's job id and clone. */
function start(s, tasks) {
  commitAll(s.dir, 'eval tasks');
  const rec = startRun(s.dir, s.config(), { tasks });
  const out: Record<string, { job: string; wt: string; run: string }> = {};
  for (const t of rec.tasks) {
    const wt = loadJob(s.dir, t.job).worktree;
    scratchGitConfig((...args) => git(wt, ...args));
    out[t.task] = { job: t.job, wt, run: rec.id };
  }
  return out;
}

/** Commits the candidate's files in its clone and returns the commit. */
function candidate(wt, files) {
  if (typeof files === 'function') files();
  else write(wt, files);
  return commitAll(wt, 'candidate');
}

function sameNamedScenario() {
  const s = scratch();
  try {
    const patch = hiddenPatch(s.dir, { 'test/feature.test.txt': 'hidden\n' });
    addTask(s.dir, 'same', { base: s.base, patch, command: 'grep -qx hidden test/feature.test.txt && test -f test/other.test.txt' });
    const { same } = start(s, ['same']);
    candidate(same.wt, { 'test/feature.test.txt': 'mine\n', 'test/other.test.txt': 'other\n' });
    return { s, same, result: gradeJob(s.dir, s.config(), same.job) };
  } catch (e) {
    s.cleanup();
    throw e;
  }
}

test('a same-named candidate test file is replaced by the hidden version', () => {
  const { s, same, result } = sameNamedScenario();
  try {
    assert.equal(result.check.ran, true);
    assert.equal(result.check.pass, true, result.check.tail);
    assert.deepEqual(result.check.replaced, ['test/feature.test.txt']);
    assert.equal(sh(same.wt, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(same.wt, 'test', 'feature.test.txt'), 'utf8'), 'mine\n', "the candidate's commit is untouched after grading");
  } finally {
    s.cleanup();
  }
});

test('grade fills {args} in the check command with nothing', () => {
  const s = scratch();
  try {
    const patch = hiddenPatch(s.dir, { 'test/args.test.txt': 'hidden\n' });
    // No command of its own: grading falls back to commands.test, which only `forge run -- <args>` may fill.
    addTask(s.dir, 'args', { base: s.base, patch, command: undefined });
    const { args } = start(s, ['args']);
    candidate(args.wt, { 'feature.txt': 'x\n' });
    const config = s.config();
    config.commands.test = 'test -z "{args}" && echo "args=[{args}]"';
    const r = gradeJob(s.dir, config, args.job);
    assert.equal(r.check.ran, true);
    assert.equal(r.check.pass, true, r.check.tail);
    assert.match(r.check.tail, /^args=\[\]$/m);
  } finally {
    s.cleanup();
  }
});

test('grade records whether the job ran out of rounds', () => {
  const s = scratch();
  try {
    const patch = hiddenPatch(s.dir, { 'test/r.test.txt': 'hidden\n' });
    addTask(s.dir, 'over', { base: s.base, patch, command: 'true' });
    addTask(s.dir, 'within', { base: s.base, patch, command: 'true' });
    const tasks = start(s, ['over', 'within']);
    for (const t of Object.values(tasks)) candidate(t.wt, { 'feature.txt': 'x\n' });
    setJob(s.dir, tasks.over.job, { fields: { round: 4, maxRounds: 3 } });
    setJob(s.dir, tasks.within.job, { fields: { round: 3, maxRounds: 3 } });
    const over = gradeJob(s.dir, s.config(), tasks.over.job);
    const within = gradeJob(s.dir, s.config(), tasks.within.job);
    assert.equal(over.roundsExhausted, true);
    assert.equal(within.roundsExhausted, false);
    const rec = JSON.parse(fs.readFileSync(path.join(s.dir, '.forge', 'evals', 'runs', `${tasks.over.run}.json`), 'utf8'));
    assert.equal(rec.summary.roundsExhaustedRate, 0.5);
  } finally {
    s.cleanup();
  }
});

test('an edited golden is graded on the hidden golden', () => {
  const s = scratch({ 'test/golden/out.txt': 'v1\n', 'test/golden/other.txt': 'o1\n' });
  try {
    const patch = hiddenPatch(s.dir, { 'test/golden/out.txt': 'hidden-v2\n', 'test/golden/other.txt': 'o2\n' });
    addTask(s.dir, 'golden', { base: s.base, patch, command: 'grep -qx hidden-v2 test/golden/out.txt && grep -qx o2 test/golden/other.txt' });
    const { golden } = start(s, ['golden']);
    candidate(golden.wt, { 'test/golden/out.txt': 'candidate\n' });
    const r = gradeJob(s.dir, s.config(), golden.job);
    assert.equal(r.check.pass, true, r.check.tail);
    assert.deepEqual(r.check.replaced, ['test/golden/out.txt'], 'a touched path the candidate left alone is not replaced');
  } finally {
    s.cleanup();
  }
});

test('a path the base never had is deleted first, across renames and quoted paths', () => {
  const body = 'a\nb\nc\nd\ne\nf\n';
  const s = scratch({ 'test/old.test.txt': `${body}old\n`, 'test/sp ace.txt': 's1\n' });
  try {
    const patch = hiddenPatch(
      s.dir,
      () => {
        git(s.dir, 'mv', 'test/old.test.txt', 'test/new.test.txt');
        write(s.dir, { 'test/new.test.txt': `${body}hidden\n`, 'test/sp ace.txt': 's2\n' });
      },
      '-M',
    );
    assert.match(patch, /^rename from test\/old\.test\.txt$/m, 'the fixture is a real rename patch');
    addTask(s.dir, 'rename', { base: s.base, patch, command: 'grep -qx hidden test/new.test.txt && test ! -e test/old.test.txt && grep -qx s2 "test/sp ace.txt"' });
    const { rename } = start(s, ['rename']);
    candidate(rename.wt, { 'test/new.test.txt': 'mine\n', 'test/old.test.txt': 'candidate\n', 'test/sp ace.txt': 'candidate\n' });
    const r = gradeJob(s.dir, s.config(), rename.job);
    assert.equal(r.check.pass, true, r.check.tail);
    assert.deepEqual(r.check.replaced, ['test/new.test.txt', 'test/old.test.txt', 'test/sp ace.txt']);
  } finally {
    s.cleanup();
  }
});

test('a patch that does not apply still reports the reason', () => {
  const s = scratch({ 'test/golden/out.txt': 'v1\n' });
  try {
    const patch = [
      'diff --git a/test/golden/out.txt b/test/golden/out.txt',
      '--- a/test/golden/out.txt',
      '+++ b/test/golden/out.txt',
      '@@ -1 +1 @@',
      '-nope',
      '+hidden',
      '',
    ].join('\n');
    addTask(s.dir, 'stale', { base: s.base, patch, command: 'true' });
    const { stale } = start(s, ['stale']);
    const head = candidate(stale.wt, { 'test/golden/out.txt': 'candidate\n' });
    const r = gradeJob(s.dir, s.config(), stale.job);
    assert.equal(r.check.ran, true);
    assert.equal(r.check.pass, false);
    assert.match(r.check.reason, /^hidden check did not apply cleanly: \S/);
    assert.notEqual(r.check.tail, null);
    assert.equal('replaced' in r.check, false);
    assert.equal(sh(stale.wt, 'status', '--porcelain'), '');
    assert.equal(sh(stale.wt, 'rev-parse', 'HEAD'), head);
  } finally {
    s.cleanup();
  }
});

test('patch paths are literal, never globs', () => {
  const s = scratch({ 'test/a.txt': 'base\n' });
  try {
    const patch = hiddenPatch(s.dir, { 'test/[ab].txt': 'hidden\n' });
    addTask(s.dir, 'glob', { base: s.base, patch, command: "grep -qx candidate test/a.txt && grep -qx hidden 'test/[ab].txt'" });
    const { glob } = start(s, ['glob']);
    candidate(glob.wt, { 'test/a.txt': 'candidate\n' });
    const r = gradeJob(s.dir, s.config(), glob.job);
    assert.equal(r.check.pass, true, r.check.tail);
    assert.deepEqual(r.check.replaced, []);
  } finally {
    s.cleanup();
  }
});

test('grading never touches paths outside the clone', () => {
  const s = scratch();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep\n');
  const created = (p) => ['diff --git a/' + p + ' b/' + p, 'new file mode 100644', '--- /dev/null', '+++ b/' + p, '@@ -0,0 +1 @@', '+pwned', ''].join('\n');
  try {
    addTask(s.dir, 'dotdot', { base: s.base, patch: created('../outside.txt'), command: 'true' });
    addTask(s.dir, 'symlink', { base: s.base, patch: created('test/x.txt'), command: 'true' });
    const tasks = start(s, ['dotdot', 'symlink']);
    candidate(tasks.dotdot.wt, { 'note.txt': 'x\n' });
    candidate(tasks.symlink.wt, () => fs.symlinkSync(outside, path.join(tasks.symlink.wt, 'test')));
    for (const name of ['dotdot', 'symlink']) {
      const r = gradeJob(s.dir, s.config(), tasks[name].job);
      assert.equal(r.check.ran, true, name);
      assert.equal(r.check.pass, false, name);
      assert.match(r.check.reason, /^hidden check did not apply cleanly: \S/, name);
      assert.notEqual(r.check.tail, null, name);
      assert.equal('replaced' in r.check, false, name);
    }
    assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep\n');
    assert.equal(fs.existsSync(path.join(tasks.dotdot.wt, '..', 'outside.txt')), false);
  } finally {
    s.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("base falls back to the job's base branch and an unknown base fails closed", () => {
  const s = scratch({ 'test/golden/out.txt': 'v1\n' });
  try {
    const patch = hiddenPatch(s.dir, { 'test/golden/out.txt': 'hidden-v2\n' });
    addTask(s.dir, 'nobase', { base: null, patch, command: 'grep -qx hidden-v2 test/golden/out.txt' });
    addTask(s.dir, 'unknown', { base: s.base, patch, command: 'true' });
    const tasks = start(s, ['nobase', 'unknown']);
    assert.equal(loadJob(s.dir, tasks.nobase.job).base, 'main');
    candidate(tasks.nobase.wt, { 'test/golden/out.txt': 'candidate\n' });
    const r = gradeJob(s.dir, s.config(), tasks.nobase.job);
    assert.equal(r.check.pass, true, r.check.tail);
    assert.deepEqual(r.check.replaced, ['test/golden/out.txt']);

    // startRun refuses an unknown base, so point the task at a commit the clone never fetched.
    write(s.dir, { 'later.txt': 'later\n' });
    const later = commitAll(s.dir, 'after the clone');
    addTask(s.dir, 'unknown', { base: later, patch, command: 'true' });
    candidate(tasks.unknown.wt, { 'test/golden/out.txt': 'candidate\n' });
    const u = gradeJob(s.dir, s.config(), tasks.unknown.job);
    assert.equal(u.check.ran, true);
    assert.equal(u.check.pass, false);
    assert.equal(u.check.reason, `eval base ${later} not found in the eval checkout`);
    assert.equal('replaced' in u.check, false);
  } finally {
    s.cleanup();
  }
});

test('eval report carries replaced and old results still summarise', async () => {
  const { s, same } = sameNamedScenario();
  try {
    const report: any = await evalCmd(s.dir, s.config(), 'report', [same.run], {});
    assert.deepEqual(report.tasks[0].result.check.replaced, ['test/feature.test.txt']);
    // Timing: the job never left its first stage and ran no agent.
    const graded = report.tasks[0].result;
    assert.deepEqual(Object.keys(graded.stages), ['backlog']);
    assert.equal(typeof graded.stages.backlog, 'number');
    assert.equal(graded.agentMinutes, 0);
    assert.equal(typeof graded.orchestratorMinutes, 'number');
    assert.equal(graded.reviewerRuns, 0);
    assert.deepEqual(report.perTask.map((p) => [p.task, p.runs, p.graded]), [['same', 1, 1]]);
    assert.equal(report.summary.avgReviewerRuns, 0);

    const result = (check) => ({ check, judge: null, decision: null, rounds: 0, firstPass: null, verifyFirstPass: null, tokens: 0, estCostUsd: 0, minutes: null, gradedAt: 'x' });
    const old = {
      tasks: [
        { task: 'a', job: 'a', worktreeOk: true, result: result({ ran: true, pass: true, tail: null }) },
        { task: 'b', job: 'b', worktreeOk: true, result: result({ ran: true, pass: false, tail: 'x', reason: 'hidden check did not apply cleanly' }) },
      ],
    };
    assert.equal(summarize(old).checkPassRate, 0.5);
  } finally {
    s.cleanup();
  }
});

test('configHash covers verifiers', () => {
  const repo = tempRepo();
  try {
    const cfg = defaults();
    const before = configHash(repo.dir, cfg);
    const dir = path.join(repo.dir, '.forge', 'verifiers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'help-rows.md'), '---\npaths: [lib/**]\n---\nIs it fine?\n');
    const added = configHash(repo.dir, cfg);
    assert.notEqual(added, before);
    fs.writeFileSync(path.join(dir, 'help-rows.md'), '---\npaths: [lib/**]\nmode: block\n---\nIs it fine?\n');
    assert.notEqual(configHash(repo.dir, cfg), added);
  } finally {
    repo.cleanup();
  }
});
