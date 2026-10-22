// Cross-repo review: the combined scope and diff, member panels with qualified lenses, briefs and
// verdict heads for a job with a reviewed member repo. Scratch repos only (job-repos-fixture.ts);
// no gh and no real GitHub repo.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { twoRepo } from './job-repos-fixture.ts';
import type { TwoRepo } from './job-repos-fixture.ts';
import * as yaml from '../lib/yaml.ts';
import { updateJob } from '../lib/jobs.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
async function project(): Promise<TwoRepo> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  return p;
}

const SPEC = ['# Two repos', '', 'Suggested reviewers: code', '', '## Approach', '- `lib/lib.txt` and `app.txt`', ''].join('\n');

/** A job with member lib (verify-only when asked), its worktrees, root and lib commits, and a spec. */
async function setup(p: TwoRepo, opts: { verifyOnly?: boolean; noMember?: boolean; libFiles?: Record<string, string>; spec?: string } = {}) {
  const j = await p.f('job', 'new', '--title', `review job ${Math.random().toString(36).slice(2, 8)}`);
  if (!opts.noMember) await p.f('job', 'repo', 'add', ...(opts.verifyOnly ? ['--verify-only'] : []), j.id, 'lib');
  await p.f('worktree', 'create', j.id);
  const rootWt = path.join(p.parent, 'app.worktrees', j.id);
  const libWt = path.join(p.parent, 'lib.worktrees', j.id);
  p.commit(rootWt, { 'app.txt': 'app\n', 'zz.txt': 'z\n' }, 'feat: app');
  if (!opts.noMember && !opts.verifyOnly) p.commit(libWt, opts.libFiles ?? { 'lib.txt': 'lib\n', 'other.txt': 'other\n' }, 'feat: lib');
  const dir = path.join(p.root, '.forge', 'jobs', j.id);
  fs.writeFileSync(path.join(dir, 'spec.md'), opts.spec ?? SPEC);
  await p.f('job', 'round', j.id);
  return { id: j.id as string, rootWt, libWt, dir };
}

const head = (p: TwoRepo, cwd: string) => p.git(cwd, 'rev-parse', 'HEAD').trim();

describe('cross-repo review: scope', { concurrency: 4 }, () => {
  test('scope combines every reviewed repo with prefixed paths and heads', async () => {
    const p = await project();
    const j = await setup(p);
    const s = await p.f('job', 'scope', j.id);
    assert.equal(s.changed, 4);
    assert.equal(s.inSpec, 2);
    assert.deepEqual(s.outOfSpec, ['zz.txt', 'lib/other.txt']);
    assert.equal(s.repos.length, 1);
    const libHead = head(p, j.libWt);
    const libBase = p.git(j.libWt, 'merge-base', 'origin/main', 'HEAD').trim();
    assert.deepEqual(s.repos[0], { repo: 'lib', base: 'origin/main', mergeBase: libBase, head: libHead, dirty: false, changed: 2 });
    assert.deepEqual(s.heads, { lib: libHead });
    assert.equal(s.head, head(p, j.rootWt));
    assert.equal(s.diff, 'scope.diff');
    const md = fs.readFileSync(path.join(j.dir, 'scope.md'), 'utf8');
    assert.match(md, /^SCOPE: 2 of 4 changed files outside spec Approach/);
    assert.ok(md.includes(`\nRepo lib: base origin/main @ ${libBase.slice(0, 12)} · HEAD ${libHead.slice(0, 12)}\n`), md);
    assert.ok(md.indexOf('Repo lib:') > md.indexOf('Base '), 'the Repo line follows the root Base line');
    assert.ok(md.includes('## Out of spec (2)\n- `zz.txt`\n- `lib/other.txt`\n'), md);
    assert.ok(md.includes('## In spec (2)\n- `app.txt`\n- `lib/lib.txt`\n'), md);
    assert.doesNotMatch(md, /has uncommitted changes/);
    const ev = p.events(j.id).filter((e) => e.type === 'scope').at(-1);
    assert.deepEqual(ev.heads, { lib: libHead });
    // Uncommitted member changes are named, not included.
    fs.writeFileSync(path.join(j.libWt, 'wip.txt'), 'wip\n');
    const dirty = await p.f('job', 'scope', j.id);
    assert.equal(dirty.repos[0].dirty, true);
    assert.equal(dirty.changed, 4);
    assert.match(fs.readFileSync(path.join(j.dir, 'scope.md'), 'utf8'), /\n> Repo lib has uncommitted changes; they are not included\.\n/);
  });

  test('scope.diff pins prefixes and ignores worktree diff config', async () => {
    const p = await project();
    const j = await setup(p);
    const plain = async () => {
      await p.f('job', 'scope', j.id);
      return fs.readFileSync(path.join(j.dir, 'scope.diff'), 'utf8');
    };
    const before = await plain();
    const rootSection = before.indexOf('# repo root base origin/main @ ');
    const libSection = before.indexOf('# repo lib base origin/main @ ');
    assert.equal(rootSection, 0, before);
    assert.ok(libSection > rootSection, before);
    const root = before.slice(0, libSection);
    const lib = before.slice(libSection);
    assert.match(root, /^diff --git a\/app\.txt b\/app\.txt$/m);
    assert.match(lib, /^diff --git a\/lib\/lib\.txt b\/lib\/lib\.txt$/m);
    assert.match(lib, /^\+\+\+ b\/lib\/lib\.txt$/m);
    assert.ok(lib.includes(`· HEAD ${head(p, j.libWt)}\n`), lib);
    // The builder can write the member worktree's git config; none of it reshapes the diff.
    for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['diff.external', 'echo EXTERNAL-DIFF'], ['color.diff', 'always']]) p.git(j.libWt, 'config', k, v);
    p.git(j.rootWt, 'config', 'diff.noprefix', 'true');
    const after = await plain();
    assert.equal(after, before);
    assert.doesNotMatch(after, /EXTERNAL-DIFF/);
  });

  test('scope.diff shows member hunks that attributes would mark binary', async () => {
    const p = await project();
    // A committed `.gitattributes` and a worktree core.attributesFile both try to hide the hunks.
    const j = await setup(p, { libFiles: { 'lib.txt': 'lib\n', 'other.txt': 'other\n', '.gitattributes': '*.txt -diff\n' } });
    const attrs = path.join(p.parent, 'hide-attrs');
    fs.writeFileSync(attrs, '* binary\n');
    p.git(j.libWt, 'config', 'core.attributesFile', attrs);
    p.git(j.rootWt, 'config', 'core.attributesFile', attrs);
    p.git(j.libWt, 'config', 'diff.ignoreSubmodules', 'all');
    await p.f('job', 'scope', j.id);
    const diff = fs.readFileSync(path.join(j.dir, 'scope.diff'), 'utf8');
    assert.doesNotMatch(diff, /Binary files/);
    const lib = diff.slice(diff.indexOf('# repo lib base '));
    assert.match(lib, /^\+\+\+ b\/lib\/lib\.txt\n@@ [^\n]+\n\+lib$/m);
    assert.match(lib, /^\+other$/m);
    assert.match(diff, /^\+app$/m);
  });

  test('scope and panel never run a worktree core.fsmonitor program', { skip: process.platform === 'win32' }, async () => {
    const p = await project();
    const j = await setup(p);
    const marker = path.join(p.parent, 'fsmonitor-ran');
    const hook = path.join(p.parent, 'fsmonitor-hook');
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    for (const wt of [j.libWt, j.rootWt]) p.git(wt, 'config', 'core.fsmonitor', hook);
    // Unpinned, git status runs it, so the assertions below are meaningful.
    p.git(j.libWt, 'status', '--porcelain');
    assert.ok(fs.existsSync(marker), 'plain git status runs the fsmonitor hook');
    fs.rmSync(marker);
    await p.f('job', 'scope', j.id);
    await p.f('job', 'panel', j.id);
    assert.ok(!fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
  });

  test('verify-only members are not reviewed', async () => {
    const p = await project();
    const j = await setup(p, { verifyOnly: true });
    // A stale combined diff from an earlier multi-repo run is removed.
    fs.writeFileSync(path.join(j.dir, 'scope.diff'), 'stale\n');
    const s = await p.f('job', 'scope', j.id);
    for (const k of ['repos', 'heads', 'diff']) assert.ok(!(k in s), `no ${k} key`);
    assert.equal(s.changed, 2);
    assert.ok(!fs.existsSync(path.join(j.dir, 'scope.diff')));
    const md = fs.readFileSync(path.join(j.dir, 'scope.md'), 'utf8');
    assert.doesNotMatch(md, /Repo lib/);
    assert.ok(md.includes('## In spec (1)\n- `app.txt`\n## Paths'), md);
    assert.ok(!('heads' in p.events(j.id).filter((e) => e.type === 'scope').at(-1)));
  });

  test('a member worktree that is not Forge\'s fails the scope', async () => {
    const p = await project();
    const j = await setup(p);
    fs.rmSync(j.libWt, { recursive: true, force: true });
    const r = await p.raw(['job', 'scope', j.id]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr + r.stdout, /has no worktree for repo lib/);
  });
});

/** Writes the member clone's own panel and checklists and commits them there, as its owner would. */
function libPanel(p: TwoRepo, panel: unknown[], reviewers: Record<string, string> = {}): void {
  const files: Record<string, string> = { '.forge/config.yml': yaml.stringify({ review: { panel } }) };
  for (const [name, text] of Object.entries(reviewers)) files[path.join('.forge', 'reviewers', `${name}.md`)] = text;
  p.commit(p.lib, files, 'chore: lib panel');
}

/** Every spawn `forge job step` returns in the review stage, by role. */
async function reviewSpawns(p: TwoRepo, id: string): Promise<Record<string, any>> {
  await p.f('job', 'set', id, '--stage', 'review', '--state', 'running');
  const a = await p.f('job', 'step', id);
  assert.equal(a.action, 'spawn', JSON.stringify(a));
  return Object.fromEntries([a, ...(a.spawns ?? [])].map((s: any) => [s.role, s]));
}

/** Writes every spawn's review file: PASS unless `changes` names its role. */
function writeReviews(spawns: Record<string, any>, changes: Record<string, string> = {}): void {
  for (const [role, s] of Object.entries(spawns)) {
    fs.mkdirSync(path.dirname(s.output), { recursive: true });
    fs.writeFileSync(s.output, changes[role] ?? '# Review\n\nVERDICT: PASS\n');
  }
}

const lines = (brief: string, prefix: string) => brief.split('\n').filter((l) => l.startsWith(prefix));
const DSP = { 'src/dsp.rs': 'fn process() {}\n' };
// forge job step refuses the job's backslash paths as unsafe arguments on Windows (as in test/step.test.ts).
const noStep = process.platform === 'win32';

describe('cross-repo review: member panels', { concurrency: 4 }, () => {
  test('a lens only the member defines reviews it and its findings cite member paths', { skip: noStep }, async () => {
    const p = await project();
    const j = await setup(p, { libFiles: DSP });
    libPanel(p, [{ name: 'realtime', paths: ['src/**'] }], { realtime: '# Realtime\n' });
    const panel = await p.f('job', 'panel', j.id);
    assert.ok(panel.lenses.includes('lib:realtime'), JSON.stringify(panel));
    assert.ok(!panel.lenses.includes('realtime'));
    assert.deepEqual(panel.reasons['lib:realtime'], ['paths src/**: lib/src/dsp.rs']);
    assert.deepEqual(panel.heads, { lib: head(p, j.libWt) });
    assert.equal(panel.repos[0].repo, 'lib');
    assert.equal(panel.changed, 3);
    assert.ok(!('problems' in panel));
    const job = JSON.parse(fs.readFileSync(path.join(j.dir, 'job.json'), 'utf8'));
    assert.ok(job.reviewers.includes('lib:realtime'));
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'panel').at(-1).heads, { lib: head(p, j.libWt) });
    await p.f('job', 'scope', j.id);
    const spawns = await reviewSpawns(p, j.id);
    const s = spawns['reviewer:lib:realtime'];
    assert.ok(s, Object.keys(spawns).join(','));
    const out = path.join(j.dir, 'review', 'round-1', 'lib.realtime.md');
    assert.equal(s.output, out);
    assert.match(s.startShell, / --role reviewer:lib:realtime /);
    assert.deepEqual(lines(s.brief, 'Checklist: '), [`Checklist: ${path.join(p.lib, '.forge', 'reviewers', 'realtime.md')}`]);
    assert.deepEqual(lines(s.brief, 'Lens repo: '), [`Lens repo: lib · worktree ${j.libWt} · base main`]);
    assert.deepEqual(lines(s.brief, 'Diff: '), [`Diff: ${path.join(j.dir, 'scope.diff')} (every job repo; member paths are prefixed <repo>/)`]);
    assert.deepEqual(lines(s.brief, 'Output: '), [`Output: ${out}`]);
    const paths = JSON.parse(lines(s.brief, 'Job paths (JSON): ')[0].slice('Job paths (JSON): '.length));
    assert.equal(paths.scopeDiff, path.join(j.dir, 'scope.diff'));
    assert.equal(paths.checklists['lib:realtime'], path.join(p.lib, '.forge', 'reviewers', 'realtime.md'));
    // Root lenses read the combined diff too, with no Lens repo line.
    const code = spawns['reviewer:code'];
    assert.equal(lines(code.brief, 'Diff: ').length, 1);
    assert.equal(lines(code.brief, 'Lens repo: ').length, 0);

    writeReviews(spawns, { 'reviewer:lib:realtime': '# Review\n\nVERDICT: CHANGES\n\n- [major] lib/src/dsp.rs:3 — allocates on the audio thread\n' });
    const v = await p.f('job', 'verdicts', j.id);
    assert.equal(v.reviewers['lib:realtime'].verdict, 'CHANGES');
    assert.equal(v.reviewers['lib:realtime'].file, path.join('review', 'round-1', 'lib.realtime.md'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(j.dir, 'job.json'), 'utf8')).verdicts['1']['lib:realtime'], 'CHANGES');
    fs.writeFileSync(path.join(j.dir, 'build.md'), '## Round 2\nFindings addressed:\n- lib:realtime [major] lib/src/dsp.rs:3 → disagree: the buffer is preallocated\n');
    const findings = await p.f('job', 'findings', j.id);
    assert.deepEqual(findings.byLens['lib:realtime'], { raised: 1, fixed: 0, disputed: 1, recurring: 0, severity: { blocker: 0, major: 1, minor: 0, nit: 0 } });
    assert.deepEqual(findings.disputed, [{ round: 1, lens: 'lib:realtime', severity: 'major', path: 'lib/src/dsp.rs' }]);
  });

  test("a member's built-in lens is subsumed unless it has its own checklist", async () => {
    const p = await project();
    const j = await setup(p, { libFiles: DSP });
    libPanel(p, [{ name: 'code', paths: ['src/**'] }]);
    const subsumed = await p.f('job', 'panel', j.id);
    assert.ok(!subsumed.lenses.includes('lib:code'), JSON.stringify(subsumed));
    assert.ok(subsumed.reasons.code.includes('paths src/**: lib/src/dsp.rs'), JSON.stringify(subsumed.reasons.code));
    libPanel(p, [{ name: 'code', paths: ['src/**'] }], { code: '# Our code lens\n' });
    const own = await p.f('job', 'panel', j.id);
    assert.ok(own.lenses.includes('lib:code'), JSON.stringify(own));
    assert.deepEqual(own.reasons['lib:code'], ['paths src/**: lib/src/dsp.rs']);
    assert.ok(!own.reasons.code.includes('paths src/**: lib/src/dsp.rs'));
  });

  test('member lenses come from the clone, not the worktree, and only for job repos', { skip: noStep }, async () => {
    const p = await project();
    const j = await setup(p, { libFiles: DSP });
    libPanel(p, [{ name: 'realtime', paths: ['src/**'] }], { realtime: '# Realtime\n' });
    // The builder rewrites the member worktree's own panel and checklist.
    p.commit(j.libWt, { '.forge/config.yml': 'review:\n  panel:\n    - name: other\n', '.forge/reviewers/realtime.md': '# anything goes\n' }, 'chore: weaken');
    await p.f('job', 'set', j.id, '--field', 'reviewers=["code","nope:code"]');
    const panel = await p.f('job', 'panel', j.id);
    assert.ok(panel.lenses.includes('lib:realtime'), JSON.stringify(panel));
    assert.ok(!panel.lenses.includes('nope:code'));
    assert.ok(!panel.lenses.includes('lib:other'));
    await p.f('job', 'scope', j.id);
    // A hand-written name after the panel is never spawned either.
    const job = JSON.parse(fs.readFileSync(path.join(j.dir, 'job.json'), 'utf8'));
    await p.f('job', 'set', j.id, '--field', `reviewers=${JSON.stringify([...job.reviewers, 'nope:code'])}`);
    const spawns = await reviewSpawns(p, j.id);
    assert.ok(!('reviewer:nope:code' in spawns), Object.keys(spawns).join(','));
    assert.deepEqual(lines(spawns['reviewer:lib:realtime'].brief, 'Checklist: '), [`Checklist: ${path.join(p.lib, '.forge', 'reviewers', 'realtime.md')}`]);
    // Verdicts never read it without --reviewers: every other lens's review completes the round.
    writeReviews(spawns);
    const v = await p.f('job', 'verdicts', j.id, '--compact');
    assert.equal(v.complete, true, JSON.stringify(v));
    assert.ok(!('nope:code' in v.reviewers));
    assert.ok(!fs.existsSync(path.join(j.dir, 'review', 'round-1', 'nope.code.md')));
  });

  test('the Lens repo line names the computed worktree, never a stored decoy', { skip: noStep }, async () => {
    const p = await project();
    const j = await setup(p, { libFiles: DSP });
    libPanel(p, [{ name: 'realtime', paths: ['src/**'] }], { realtime: '# Realtime\n' });
    await p.f('job', 'panel', j.id);
    await p.f('job', 'scope', j.id);
    // job.json is session-writable: point the stored member worktree at the clone itself.
    updateJob(p.root, j.id, (job) => {
      job.repos[1].worktree = p.lib;
    });
    const spawns = await reviewSpawns(p, j.id);
    const s = spawns['reviewer:lib:realtime'];
    assert.ok(s, Object.keys(spawns).join(','));
    assert.deepEqual(lines(s.brief, 'Lens repo: '), ['Lens repo: lib · worktree none · base main']);
  });

  test('member panel config is size-capped, regular-file-only and confined to the clone', async () => {
    const p = await project();
    const j = await setup(p, { libFiles: DSP });
    const cfg = path.join(p.lib, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const fails = async (what: string, re: RegExp) => {
      const before = p.events(j.id).filter((e) => e.type === 'panel').length;
      const r = await p.raw(['job', 'panel', j.id]);
      assert.equal(r.status, 1, `${what}: ${r.stdout}`);
      assert.match(r.stderr + r.stdout, re, what);
      assert.equal(p.events(j.id).filter((e) => e.type === 'panel').length, before, `${what}: no panel event`);
    };
    fs.writeFileSync(cfg, `review:\n  panel: []\n# ${'x'.repeat(300 * 1024)}\n`);
    await fails('too big', /repo lib: \.forge\/config\.yml is larger than 262144 bytes/);
    fs.writeFileSync(cfg, 'review: [unclosed\n');
    await fails('bad yaml', /repo lib: \.forge\/config\.yml is not valid YAML/);
    fs.writeFileSync(cfg, 'review:\n  panel: realtime\n');
    await fails('not a list', /repo lib: review\.panel in \.forge\/config\.yml must be a list/);
    if (process.platform !== 'win32') {
      fs.rmSync(cfg);
      const { execFileSync } = await import('node:child_process');
      execFileSync('mkfifo', [cfg]);
      await fails('fifo', /repo lib: \.forge\/config\.yml is not a regular file/);
      fs.rmSync(cfg);
    }
    // Bad entries are dropped with a problem; the good one stays.
    fs.writeFileSync(path.join(p.parent, 'outside.md'), '# outside\n');
    const reviewers = path.join(p.lib, '.forge', 'reviewers');
    fs.mkdirSync(reviewers, { recursive: true });
    fs.writeFileSync(path.join(reviewers, 'realtime.md'), '# Realtime\n');
    const entries: any[] = [
      { name: 'realtime', paths: ['src/**'] },
      { name: 'up', paths: ['src/**'], checklist: '../outside.md' },
      { name: 'abs', paths: ['src/**'], checklist: path.join(p.parent, 'outside.md') },
      { name: 'Bad_Name', paths: ['src/**'] },
      { name: 'escape', paths: ['../x'] },
    ];
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(p.parent, 'outside.md'), path.join(reviewers, 'linked.md'));
      entries.push({ name: 'linked', paths: ['src/**'] });
    }
    fs.writeFileSync(cfg, yaml.stringify({ review: { panel: entries } }));
    const panel = await p.f('job', 'panel', j.id);
    assert.deepEqual(panel.lenses.filter((l: string) => l.startsWith('lib:')), ['lib:realtime']);
    const problems: string[] = panel.problems;
    assert.ok(problems.every((x) => x.startsWith('repo lib: ')), JSON.stringify(problems));
    for (const re of [/"up"\.checklist "\.\.\/outside\.md" is not a file inside the clone/, /"abs"\.checklist .* is not a file inside the clone/, /review\.panel\[3\]\.name must be a lens name/, /"escape"\.paths entry "\.\.\/x" must not contain a \.\. segment/])
      assert.ok(problems.some((x) => re.test(x)), `${re}: ${JSON.stringify(problems)}`);
    if (process.platform !== 'win32') assert.ok(problems.some((x) => /"linked": \.forge\/reviewers\/linked\.md is not a file inside the clone/.test(x)), JSON.stringify(problems));
  });
});

describe('cross-repo review: verdicts', { concurrency: 4 }, () => {
  test("verdicts record each repo's HEAD", async () => {
    const p = await project();
    const j = await setup(p);
    await p.f('job', 'set', j.id, '--field', 'reviewers=["code"]');
    const review = (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'code.md'), '# Review\n\nVERDICT: PASS\n');
    };
    review(path.join(j.dir, 'review', 'round-1'));
    review(path.join(j.dir, 'review', 'integration'));
    const libHead = head(p, j.libWt);
    const round = await p.f('job', 'verdicts', j.id, '--compact');
    assert.deepEqual(round.heads, { lib: libHead });
    assert.equal(round.sha, head(p, j.rootWt));
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'verdicts').at(-1).heads, { lib: libHead });
    const full = await p.f('job', 'verdicts', j.id);
    assert.deepEqual(full.heads, { lib: libHead });
    const integration = await p.f('job', 'verdicts', j.id, '--round', 'integration', '--compact');
    assert.deepEqual(integration.heads, { lib: libHead });
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'integration-review').at(-1).heads, { lib: libHead });
    // A stored worktree that is not Forge's computed path is never read.
    updateJob(p.root, j.id, (job) => {
      job.repos[1].worktree = p.lib;
    });
    const untrusted = await p.f('job', 'verdicts', j.id, '--compact');
    assert.deepEqual(untrusted.heads, { lib: null });
    assert.deepEqual(p.events(j.id).filter((e) => e.type === 'verdicts').at(-1).heads, { lib: null });
  });
});

describe('cross-repo review: single-repo jobs', { concurrency: 4 }, () => {
  test('single-repo and verify-only jobs review exactly as before', { skip: noStep }, async () => {
    for (const kind of ['single-repo', 'verify-only'] as const) {
      const p = await project();
      const j = await setup(p, kind === 'single-repo' ? { noMember: true } : { verifyOnly: true });
      const panel = await p.f('job', 'panel', j.id);
      for (const k of ['repos', 'heads', 'problems']) assert.ok(!(k in panel), `panel: no ${k}`);
      assert.ok(!('heads' in p.events(j.id).filter((e) => e.type === 'panel').at(-1)));
      await p.f('job', 'scope', j.id);
      const spawns = await reviewSpawns(p, j.id);
      for (const s of Object.values(spawns)) {
        assert.equal(lines(s.brief, 'Diff: ').length, 0);
        assert.equal(lines(s.brief, 'Lens repo: ').length, 0);
        assert.doesNotMatch(s.brief, /scopeDiff/);
      }
      writeReviews(spawns);
      const v = await p.f('job', 'verdicts', j.id, '--compact');
      assert.equal(v.complete, true);
      assert.ok(!('heads' in v));
      assert.ok(!('heads' in p.events(j.id).filter((e) => e.type === 'verdicts').at(-1)));
      const s = await p.f('job', 'scope', j.id);
      for (const k of ['repos', 'heads', 'diff']) assert.ok(!(k in s), `scope: no ${k}`);
      assert.ok(!fs.existsSync(path.join(j.dir, 'scope.diff')));
      assert.ok(!('heads' in p.events(j.id).filter((e) => e.type === 'scope').at(-1)));
    }
  });
});
