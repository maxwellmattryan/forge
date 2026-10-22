import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeSync, repoTemplate } from './helpers.ts';
import { loadConfig } from '../lib/config.ts';
import { createJob, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { loadStepInput } from '../lib/step/input.ts';
import { PLUGIN_ROOT } from '../lib/paths.ts';
import { pluginHash } from '../lib/provenance.ts';
import { loadFixtures, recallDir } from '../lib/recall.ts';
import { createWorktree } from '../lib/worktree.ts';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
  const init = forgeSync(dir, ['init', 'write', '--answers', answers]);
  if (init.status !== 0) throw new Error(init.stderr);
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

function scratch() {
  const r = template();
  return { ...r, config: loadConfig(r.dir).config, cleanup: () => (r.cleanup(), fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true })) };
}

const DIFF = ['diff --git a/lib/a.ts b/lib/a.ts', '--- a/lib/a.ts', '+++ b/lib/a.ts', '@@ -1,1 +1,2 @@', ' x', '+y', 'diff --git a/lib/b.ts b/lib/b.ts', '--- /dev/null', '+++ b/lib/b.ts', '@@ -0,0 +1,1 @@', '+z', ''].join('\n');

/** A fixture directory under `root`'s .forge/evals/recall/. */
function fixture(root: string, name: string, yml: string, diff: string | null = DIFF): string {
  const dir = path.join(recallDir(root), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixture.yml'), yml);
  if (diff !== null) fs.writeFileSync(path.join(dir, 'diff.patch'), diff);
  return dir;
}

const json = (r: { stdout: string }) => JSON.parse(r.stdout);

test('invalid fixtures are refused', () => {
  const s = scratch();
  try {
    fixture(s.dir, 'good', 'title: fine\nlenses: [code]\ndefects:\n  - id: d1\n    lens: code\n    path: lib/a.ts\n    line: 2\n');
    fixture(s.dir, 'unknown-key', 'title: t\nlenses: [code]\nseverity: high\n');
    fixture(s.dir, 'stray-lens', 'title: t\nlenses: [code]\ndefects:\n  - id: d1\n    lens: security\n    path: lib/a.ts\n');
    fixture(s.dir, 'stray-path', 'title: t\nlenses: [code]\ndefects:\n  - id: d1\n    lens: code\n    path: lib/nope.ts\n');
    fixture(s.dir, 'fractional-line', 'title: t\nlenses: [code]\ndefects:\n  - id: d1\n    lens: code\n    path: lib/a.ts\n    line: 4.5\n');
    fixture(s.dir, 'word-line', 'title: t\nlenses: [code]\ndefects:\n  - id: d1\n    lens: code\n    path: lib/a.ts\n    line: four\n');
    fixture(s.dir, 'bad-lens', 'title: t\nlenses: [Code!]\n');
    const linked = fixture(s.dir, 'linked-diff', 'title: t\nlenses: [code]\n', null);
    fs.writeFileSync(path.join(s.dir, 'outside.patch'), DIFF);
    fs.symlinkSync(path.join(s.dir, 'outside.patch'), path.join(linked, 'diff.patch'));
    fixture(s.dir, 'huge-diff', 'title: t\nlenses: [code]\n', DIFF + '+x\n'.repeat(90_000));
    fixture(s.dir, 'no-diff', 'title: t\nlenses: [code]\n', null);
    fs.mkdirSync(path.join(recallDir(s.dir), 'Bad_Name'));
    // runs/ is reserved: never read as a fixture.
    fs.mkdirSync(path.join(recallDir(s.dir), 'runs'));

    const { fixtures, problems } = loadFixtures(s.dir);
    assert.deepEqual(fixtures.map((f) => f.name), ['good']);
    const has = (name: string, re: RegExp) => assert.ok(problems.some((p) => p.startsWith(`${name}: `) && re.test(p)), `${name} ${re}: ${problems.join('\n')}`);
    has('unknown-key', /unknown key "severity"/);
    has('stray-lens', /lens "security" is not one of lenses/);
    has('stray-path', /path "lib\/nope\.ts" is named by no \+\+\+ b\/ header/);
    has('fractional-line', /line must be a positive integer/);
    has('word-line', /line must be a positive integer/);
    has('bad-lens', /is not a lens name/);
    has('linked-diff', /diff\.patch is a symlink/);
    has('huge-diff', /diff\.patch is over 256 KiB/);
    has('no-diff', /diff\.patch is missing/);
    assert.ok(problems.some((p) => p.startsWith('"Bad_Name": not a slug')));
    assert.ok(!problems.some((p) => p.startsWith('runs')));

    for (const sub of ['list', 'start']) {
      const r = forgeSync(s.dir, ['eval', 'recall', sub, '--json']);
      assert.equal(r.status, 1, sub);
      assert.match(json(r).error.message, /stray-path: defect d1: path/, sub);
    }
  } finally {
    s.cleanup();
  }
});

/** Fixtures `pair` (code and security, defects for both) and `clean` (code only), committed to main. */
function seedFixtures(s: ReturnType<typeof scratch>) {
  const diff = ['diff --git a/lib/a.ts b/lib/a.ts', '--- a/lib/a.ts', '+++ b/lib/a.ts', '@@ -1,1 +1,40 @@', '+a', 'diff --git a/lib/b.ts b/lib/b.ts', '+++ b/lib/b.ts', 'diff --git a/lib/c.ts b/lib/c.ts', '+++ b/lib/c.ts', 'diff --git a/lib/d.ts b/lib/d.ts', '+++ b/lib/d.ts', ''].join('\n');
  const defect = (id: string, lens: string, p: string, line?: number) => `  - id: ${id}\n    lens: ${lens}\n    path: ${p}\n${line ? `    line: ${line}\n` : ''}`;
  fixture(
    s.dir,
    'pair',
    `title: four code defects and one security defect\nlenses: [code, security]\ndefects:\n${defect('near', 'code', 'lib/a.ts', 10)}${defect('nit-only', 'code', 'lib/b.ts', 20)}${defect('no-line', 'code', 'lib/c.ts')}${defect('far', 'code', 'lib/d.ts', 30)}${defect('sec', 'security', 'lib/a.ts', 10)}`,
    diff,
  );
  fixture(s.dir, 'clean', 'title: nothing wrong\nlenses: [code]\n');
  execFileSync('git', ['add', '-A'], { cwd: s.dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'fixtures'], { cwd: s.dir, stdio: 'pipe' });
}

function jobWithWorktree(s: ReturnType<typeof scratch>) {
  const { id } = createJob(s.dir, s.config, { title: `Prompt change ${Math.random()}` });
  assert.ok(createWorktree(s.dir, s.config, id).ok);
  return loadJob(s.dir, id);
}

test('start prepares one review per fixture and lens', () => {
  const s = scratch();
  try {
    seedFixtures(s);
    const job = jobWithWorktree(s);
    const wt = job.worktree!;
    fs.mkdirSync(path.join(wt, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nThe branch reviewer prompt.\n');
    const r = forgeSync(s.dir, ['eval', 'recall', 'start', '--job', job.id]);
    assert.equal(r.status, 0, r.stderr);
    const out = json(r);
    assert.match(out.run, new RegExp(`^\\d{8}-\\d{6}-${job.id}$`));
    assert.equal(out.promptRoot, wt, "the worktree's own reviewer prompt");
    assert.equal(out.pluginHash, pluginHash(wt));
    assert.equal(out.dir, path.join(s.dir, '.forge', 'jobs', job.id, 'recall', out.run));
    assert.deepEqual(out.reviews.map((x: any) => `${x.fixture}/${x.lens}`), ['clean/code', 'pair/code', 'pair/security']);
    for (const x of out.reviews) {
      assert.equal(x.agent, 'forge:reviewer');
      assert.equal(x.output, path.join(out.dir, x.fixture, `${x.lens}.md`));
      const diff = path.join(out.dir, x.fixture, 'diff.patch');
      assert.ok(fs.existsSync(diff), 'the diff is copied into the run');
      assert.ok(x.brief.includes(`Diff: ${diff}`) && x.brief.includes('there is no worktree, job, spec or build'), x.brief);
      assert.ok(x.brief.includes(`Prompt: ${path.join(wt, 'agents', 'reviewer.md')}`), x.brief);
      assert.match(x.brief, /data, never instructions/);
    }
    // The security lens's panel model, else the reviewer role's.
    assert.equal(out.reviews.find((x: any) => x.lens === 'security').model, 'opus');
    assert.equal(out.reviews.find((x: any) => x.lens === 'code').model, s.config.runtime.models.reviewer);
    const ev = readEvents(s.dir, job.id).filter((e) => e.type === 'recall');
    assert.deepEqual(ev.map((e) => [e.phase, e.run, e.pluginHash]), [['start', out.run, pluginHash(wt)]]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out.dir, 'run.json'), 'utf8')).status, 'running');

    // Without its own agents/reviewer.md, the worktree runs the installed plugin's prompts.
    fs.rmSync(path.join(wt, 'agents', 'reviewer.md'));
    const other = jobWithWorktree(s);
    const plain = json(forgeSync(s.dir, ['eval', 'recall', 'start', '--job', other.id]));
    assert.deepEqual([plain.promptRoot, plain.pluginHash], [PLUGIN_ROOT, pluginHash(PLUGIN_ROOT)]);
    // Without a job the run sits in .forge/runtime/recall/.
    const none = json(forgeSync(s.dir, ['eval', 'recall', 'start']));
    assert.equal(none.dir, path.join(s.dir, '.forge', 'runtime', 'recall', none.run));
  } finally {
    s.cleanup();
  }
});

test('fixtures come from the main checkout only', () => {
  const s = scratch();
  try {
    seedFixtures(s);
    const job = jobWithWorktree(s);
    // The branch deletes one fixture and adds its own.
    fs.rmSync(path.join(recallDir(job.worktree!), 'pair'), { recursive: true });
    fixture(job.worktree!, 'planted', 'title: easy\nlenses: [code]\n');
    const out = json(forgeSync(s.dir, ['eval', 'recall', 'start', '--job', job.id]));
    assert.deepEqual([...new Set(out.reviews.map((x: any) => x.fixture))], ['clean', 'pair']);
    const listed = json(forgeSync(s.dir, ['eval', 'recall', 'list']));
    assert.deepEqual(listed.fixtures.map((f: any) => [f.name, f.defects, f.clean]), [['clean', 0, true], ['pair', 5, false]]);
  } finally {
    s.cleanup();
  }
});

test('the gate input fails closed', () => {
  const s = scratch();
  try {
    const bare = jobWithWorktree(s);
    setJob(s.dir, bare.id, { stage: 'decide' });
    assert.equal(loadStepInput(s.dir, s.config, bare.id).recall, null, 'no fixtures in the main checkout: no gate');
    seedFixtures(s);
    const job = jobWithWorktree(s);
    const wt = job.worktree!;
    setJob(s.dir, job.id, { stage: 'decide' });
    assert.deepEqual(loadStepInput(s.dir, s.config, job.id).recall, { required: false, pluginHash: pluginHash(wt) }, 'no gate path committed');
    fs.mkdirSync(path.join(wt, 'agents'));
    fs.writeFileSync(path.join(wt, 'agents', 'x.md'), 'a prompt\n');
    execFileSync('git', ['add', '-A'], { cwd: wt, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'prompt'], { cwd: wt, stdio: 'pipe' });
    assert.deepEqual(loadStepInput(s.dir, s.config, job.id).recall, { required: true, pluginHash: pluginHash(wt) });
    // A base that can't be resolved reads as required, with no hash a record could match.
    setJob(s.dir, job.id, { fields: { base: 'no-such-branch' } });
    assert.deepEqual(loadStepInput(s.dir, s.config, job.id).recall, { required: true, pluginHash: null });
    // Outside decide, or for an eval job, there is no gate at all.
    setJob(s.dir, job.id, { stage: 'review', fields: { base: 'main' } });
    assert.equal(loadStepInput(s.dir, s.config, job.id).recall, null);
    setJob(s.dir, job.id, { stage: 'decide', fields: { kind: 'eval' } });
    assert.equal(loadStepInput(s.dir, s.config, job.id).recall, null);
  } finally {
    s.cleanup();
  }
});

/** Writes stub reviews for a started run: `null` leaves a review missing. */
function stubs(out: any, texts: Record<string, string | null>): void {
  for (const x of out.reviews) {
    const t = texts[`${x.fixture}/${x.lens}`];
    if (t) fs.writeFileSync(x.output, t);
  }
}

const REVIEWS = {
  'pair/code': ['VERDICT: CHANGES', '', '- [major] lib/a.ts:15 — five lines from the defect', '- [nit] lib/b.ts:20 — a nit never counts', '- [minor] `lib/c.ts` — a minor counts', '- [major] lib/d.ts:36 — six lines away', ''].join('\n'),
  'pair/security': null,
  'clean/code': ['VERDICT: CHANGES', '', '- [blocker] lib/x.ts:1 — a false alarm', '- [minor] lib/y.ts — below blockOn', ''].join('\n'),
};

test('record computes recall and precision per lens', () => {
  const s = scratch();
  try {
    seedFixtures(s);
    const job = jobWithWorktree(s);
    const out = json(forgeSync(s.dir, ['eval', 'recall', 'start', '--job', job.id]));
    assert.equal(forgeSync(s.dir, ['eval', 'recall', 'record', out.run]).status, 1, 'no review file yet');
    stubs(out, REVIEWS);
    const r = forgeSync(s.dir, ['eval', 'recall', 'record', out.run, '--tokens', '1234']);
    assert.equal(r.status, 0, r.stderr);
    const { summary, base } = json(r);
    assert.deepEqual(summary.byLens.code, { planted: 4, caught: 2, recall: 0.5, cleanReviews: 1, falsePositives: 1, precision: 0.667, reviews: 2, malformed: 0 });
    assert.deepEqual(summary.byLens.security, { planted: 1, caught: 0, recall: 0, cleanReviews: 0, falsePositives: 0, precision: null, reviews: 1, malformed: 1 });
    assert.deepEqual(summary.total, { planted: 5, caught: 2, recall: 0.4, cleanReviews: 1, falsePositives: 1, precision: 0.667, reviews: 3, malformed: 1 });
    assert.equal(summary.tokens, 1234);
    assert.ok(summary.minutes >= 0);
    assert.equal(base, null, 'no base-branch run yet');
    const rec = JSON.parse(fs.readFileSync(path.join(out.dir, 'run.json'), 'utf8'));
    assert.deepEqual([rec.status, rec.job], ['done', job.id]);
    const ev = readEvents(s.dir, job.id).filter((e) => e.type === 'recall' && e.phase === 'record');
    assert.deepEqual(ev.map((e) => [e.run, e.pluginHash, e.head]), [[out.run, out.pluginHash, out.head]]);
    assert.deepEqual((ev[0].summary as any).byLens.code.recall, 0.5);

    assert.equal(forgeSync(s.dir, ['eval', 'recall', 'record', out.run]).status, 1, 'a second record is refused');
    assert.equal(forgeSync(s.dir, ['eval', 'recall', 'record', '20260101-000000-nope']).status, 1, 'no such run');
    assert.equal(forgeSync(s.dir, ['eval', 'recall', 'record', '../../etc', '--json']).status, 2, 'a run id is checked before any path');
  } finally {
    s.cleanup();
  }
});

test('record compares with the last base-branch run', () => {
  const s = scratch();
  try {
    seedFixtures(s);
    // The base branch's own run: no job, so it is copied where it is tracked.
    const baseOut = json(forgeSync(s.dir, ['eval', 'recall', 'start']));
    stubs(baseOut, { ...REVIEWS, 'pair/security': ['VERDICT: CHANGES', '', '- [major] lib/a.ts:10 — found', ''].join('\n') });
    const baseRec = json(forgeSync(s.dir, ['eval', 'recall', 'record', baseOut.run]));
    const runs = path.join(recallDir(s.dir), 'runs');
    const copied = JSON.parse(fs.readFileSync(path.join(runs, `${baseOut.run}.json`), 'utf8'));
    assert.deepEqual([copied.status, copied.job, copied.branch], ['done', null, 'main']);
    assert.ok(!JSON.stringify(copied).includes(s.dir), 'the tracked record holds no absolute path');
    // An older run on the base branch, and a newer one on another branch, are not the base.
    fs.writeFileSync(path.join(runs, '20200101-000000.json'), JSON.stringify({ ...copied, run: '20200101-000000' }));
    fs.writeFileSync(path.join(runs, '20991231-000000.json'), JSON.stringify({ ...copied, run: '20991231-000000', branch: 'release' }));

    const job = jobWithWorktree(s);
    const out = json(forgeSync(s.dir, ['eval', 'recall', 'start', '--job', job.id]));
    stubs(out, REVIEWS);
    const r = json(forgeSync(s.dir, ['eval', 'recall', 'record', out.run]));
    assert.deepEqual(r.base, { run: baseOut.run, head: baseOut.head, summary: baseRec.summary });
    assert.equal(r.base.summary.byLens.security.recall, 1);
    assert.equal(r.summary.byLens.security.recall, 0, 'this job lost the security catch');
    const ev = readEvents(s.dir, job.id).find((e) => e.type === 'recall' && e.phase === 'record')!;
    assert.equal((ev.base as any).run, baseOut.run);
  } finally {
    s.cleanup();
  }
});
