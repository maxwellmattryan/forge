// The script release mechanism through the engine: the plan drafts the notes and records the bump, a recompute
// takes the bump back from release.json and never drafts again, and a run asks before each publish step and
// waits on the release PR's merge. A fake release script (test/support/release-script.ts) logs every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initScriptProject, readyGit, recordingSpawn, repoTemplate, scriptCalls } from '../../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';
import { readPlanFile, releaseFiles, writeReleasePlan } from './files.ts';
import { freshPlan, planHash, planRelease, type ReleasePlan } from './plan.ts';
import { releaseStatus, runRelease, type RunOptions } from './run.ts';
import { dryRunRelease } from './dry-run.ts';
import { fileBumps, notesPath } from './script.ts';

const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const project = repoTemplate(initScriptProject);
const narrow = () => null;
const quiet = { log: () => {} };
const drafts = (dir: string) => scriptCalls(dir).filter((c) => c.argv[0] === '--draft-notes');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const snapshot = (paths: string[]) => paths.map((p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null));

test('a script plan drafts the notes and records the bump', POSIX, () => {
  const r = project();
  try {
    const config = loadConfig(r.dir).config;
    const files = releaseFiles(r.dir);
    const notes = notesPath(r.dir, null);
    assert.equal(notes, path.join(r.dir, '.forge', 'runtime', 'release', 'notes-root.md'));
    const mode = (m: string | null) => (m === null ? fs.rmSync(path.join(r.dir, 'scripts', 'mode'), { force: true }) : fs.writeFileSync(path.join(r.dir, 'scripts', 'mode'), m));
    const written = [files.json, files.md, notes];

    // Refusals before anything was planned: nothing is written.
    const refusals: [string, RegExp][] = [
      ['fail', /\(root\): scripts\/release\.mjs --draft-notes exited 1: release: nothing to release: no commits since v1\.0\.0; nothing was written/],
      ['text', /\(root\): .*did not print one JSON object/],
      ['bad-next', /\(root\): .*wrong shape \(next is not X\.Y\.Z\)/],
      ['bad-bump', /\(root\): .*wrong shape \(bump is not patch, minor or major\)/],
      ['bad-draft', /\(root\): .*wrong shape \(draft does not start with "## 1\.1\.0"\)/],
      ['many-reasons', /\(root\): .*wrong shape \(reasons is not a list of at most 5/],
    ];
    for (const [m, error] of refusals) {
      mode(m);
      assert.throws(() => writeReleasePlan(r.dir, config, { kind: 'all' }, quiet), (e: unknown) => e instanceof ForgeError && error.test(e.message), m);
      assert.deepEqual(snapshot(written), [null, null, null], `${m}: nothing written`);
    }
    mode(null);
    fs.rmSync(path.join(r.dir, 'scripts', 'calls.log'), { force: true });

    // The draft runs once, in the repo, under the Node running Forge and the command environment.
    process.env.FORGE_FAKE_RELEASE_TOKEN = 'not for the script';
    let out;
    try {
      out = writeReleasePlan(r.dir, config, { kind: 'all' }, quiet);
    } finally {
      delete process.env.FORGE_FAKE_RELEASE_TOKEN;
    }
    assert.deepEqual(drafts(r.dir), [{ argv: ['--draft-notes'], cwd: r.dir, execPath: process.execPath, token: false }]);
    const bump = { from: '1.0.0', to: '1.1.0', bump: 'minor', inferred: 'minor', reasons: ['1 of 1 commits are not fixes, such as "feat: x"'], notes };
    assert.deepEqual(out.bumps, [{ repo: '(root)', ...bump, notesKept: false }]);
    assert.deepEqual(readJson(files.json).repos[0].bump, bump);
    const draft = '## 1.1.0\n\n<!-- Drafted from the commits since v1.0.0. -->\n- feat: x\n';
    assert.equal(fs.readFileSync(notes, 'utf8'), draft);
    const md = fs.readFileSync(files.md, 'utf8');
    assert.ok(md.includes('1.0.0 → 1.1.0'), 'release.md names the bump');
    assert.ok(md.includes(notes), 'release.md names the notes file');
    assert.ok(md.includes('forge release run --dry-run'));
    // The merged check names the repo's base, whichever it is: develop here.
    const onDevelop = { ...config, git: { ...config.git, base: 'develop' } };
    writeReleasePlan(r.dir, onDevelop, { kind: 'all' }, quiet);
    const developMd = fs.readFileSync(files.md, 'utf8');
    assert.ok(developMd.includes('finds the release PR from release/v1.1.0 into develop merged'), developMd);
    assert.ok(!/into main\b/.test(developMd), 'never a fixed main');
    writeReleasePlan(r.dir, config, { kind: 'all' }, quiet);

    // A re-plan after an edit that keeps the heading keeps the file byte for byte.
    const edited = '## 1.1.0\n\n- The owner rewrote these notes.\n';
    fs.writeFileSync(notes, edited);
    const again = writeReleasePlan(r.dir, config, { kind: 'all' }, quiet);
    assert.equal(again.bumps[0].notesKept, true);
    assert.equal(fs.readFileSync(notes, 'utf8'), edited);

    // --bump major drafts another version, so the file is replaced.
    const major = writeReleasePlan(r.dir, config, { kind: 'all' }, { ...quiet, versionBump: 'major' });
    assert.deepEqual(drafts(r.dir).at(-1)!.argv, ['--draft-notes', '--bump', 'major']);
    assert.deepEqual({ to: major.bumps[0].to, bump: major.bumps[0].bump, kept: major.bumps[0].notesKept }, { to: '2.0.0', bump: 'major', kept: false });
    assert.equal(fs.readFileSync(notes, 'utf8').split('\n', 1)[0], '## 2.0.0');

    // A failing draft after a plan changes nothing; nor does a symlinked notes file.
    const before = snapshot(written);
    mode('fail');
    assert.throws(() => writeReleasePlan(r.dir, config, { kind: 'all' }, quiet), /\(root\)/);
    assert.deepEqual(snapshot(written), before, 'a failed draft changes nothing');
    mode(null);
    const elsewhere = path.join(r.dir, 'elsewhere.md');
    fs.writeFileSync(elsewhere, 'keep me\n');
    fs.rmSync(notes);
    fs.symlinkSync(elsewhere, notes);
    const linked = snapshot([files.json, files.md]);
    assert.throws(() => writeReleasePlan(r.dir, config, { kind: 'all' }, quiet), (e: unknown) => e instanceof ForgeError && /notes-root\.md is a symlink/.test(e.message));
    assert.deepEqual(snapshot([files.json, files.md]), linked);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'keep me\n');
    assert.ok(fs.lstatSync(notes).isSymbolicLink());

    // --bump on a plan with no script repo.
    const tag: Config = { ...config, release: { ...config.release, mechanism: 'tag', command: 'git tag v1', script: null } };
    assert.throws(() => writeReleasePlan(r.dir, tag, { kind: 'all' }, { ...quiet, versionBump: 'minor' }), /--bump applies only to repos with release\.mechanism: script; this plan has none/);
  } finally {
    r.cleanup();
  }
});

test('recompute takes the bump from the plan and never runs the draft', POSIX, () => {
  const r = project();
  try {
    const config = loadConfig(r.dir).config;
    const files = releaseFiles(r.dir);
    writeReleasePlan(r.dir, config, { kind: 'all' }, quiet);
    const file = readPlanFile(files)!;
    const plan = freshPlan(r.dir, config, file, null);
    releaseStatus(r.dir, config, { narrow });
    dryRunRelease(r.dir, config);
    assert.equal(drafts(r.dir).length, 1, "only the plan's draft ran");
    assert.equal(plan.hash, file.hash);

    // The bump is not the manifest's: a new package.json version leaves the plan as it was.
    fs.writeFileSync(path.join(r.dir, 'package.json'), '{\n  "name": "app",\n  "version": "5.0.0"\n}\n');
    assert.equal(freshPlan(r.dir, config, file, null).hash, file.hash);

    const edit = (change: (p: any) => void): ReleasePlan => {
      const p = structuredClone(file) as any;
      change(p);
      return p;
    };
    const rerun = (e: unknown) => e instanceof ForgeError && /release\.json: \(root\) has no valid release bump; re-run forge release plan/.test(e.message);
    assert.throws(() => freshPlan(r.dir, config, edit((p) => delete p.repos[0].bump), null), rerun, 'no bump');
    assert.throws(() => freshPlan(r.dir, config, edit((p) => (p.repos[0].bump = null)), null), rerun, 'a null bump');
    assert.throws(() => freshPlan(r.dir, config, edit((p) => (p.repos[0].bump.to = '--x')), null), rerun, 'a to of --x');
    assert.throws(() => freshPlan(r.dir, config, edit((p) => (p.repos[0].bump.bump = 'huge')), null), rerun, 'a bad bump');

    // A self-consistent edit of `to` still differs from the hash state.json binds to.
    const tampered = edit((p) => (p.repos[0].bump.to = '9.9.9'));
    const replanned = planRelease(r.dir, config, tampered.selection, { bump: fileBumps(r.dir, tampered) });
    assert.ok(replanned.repos[0].steps[1].argv!.includes('9.9.9'));
    const consistent = { ...replanned, hash: planHash(replanned) };
    assert.notEqual(consistent.hash, file.hash);
    const state = { version: 1 as const, planHash: file.hash, startedAt: 'x', updatedAt: 'x', finishedAt: null, steps: {} };
    assert.throws(() => freshPlan(r.dir, config, consistent, state), /no longer matches/);

    // A planted notes path is never read back: the argv names Forge's own.
    const planted = freshPlan(r.dir, config, edit((p) => (p.repos[0].bump.notes = '/etc/passwd')), null);
    assert.deepEqual(planted.repos[0].steps[1].argv, ['node', 'scripts/release.mjs', '--phase', 'start', '1.1.0', '--notes-file', notesPath(r.dir, null)]);
    assert.equal(planted.repos[0].bump!.notes, notesPath(r.dir, null));
    assert.equal(drafts(r.dir).length, 1, 'no recompute drafted');
  } finally {
    r.cleanup();
  }
});

test('a script run asks before each publish step and waits on the merge', POSIX, async () => {
  const r = project();
  try {
    const config = loadConfig(r.dir).config;
    writeReleasePlan(r.dir, config, { kind: 'all' }, quiet);
    const node = path.dirname(process.execPath);
    const env = { ...process.env, PATH: `${node}${path.delimiter}${process.env.PATH ?? ''}` };
    const prompts: string[] = [];
    const run = (interactive: boolean, spawn: ReturnType<typeof recordingSpawn>['spawn']) => {
      const opts: RunOptions = { interactive, confirm: async (p) => (prompts.push(p), true), narrow, spawn, git: readyGit(config.git.base), env, echo: () => {} };
      return runRelease(r.dir, config, opts);
    };
    const phases = (calls: string[][]) => calls.map((c) => c.slice(1).join(' '));
    const checks = () => scriptCalls(r.dir).filter((c) => c.argv[0] === '--check').map((c) => c.argv.join(' '));

    // Without a terminal: stopped before start, nothing spawned.
    const quietRun = recordingSpawn();
    const first = await run(false, quietRun.spawn);
    assert.equal(first.exitCode, 1);
    assert.deepEqual({ step: first.data.stopped?.step, reason: first.data.stopped?.reason }, { step: '(root)/start', reason: 'needs_confirmation' });
    assert.deepEqual(quietRun.calls, []);
    assert.deepEqual(prompts, []);

    // On a terminal: asks before start only; the merge asks Done? and then checks.
    const live = recordingSpawn();
    const second = await run(true, live.spawn);
    assert.deepEqual(phases(live.calls), ['scripts/release.mjs --phase start 1.1.0 --notes-file ' + notesPath(r.dir, null)]);
    assert.ok(live.calls.every((c) => path.basename(c[0]) === 'node' || path.basename(c[0]) === 'node.exe'));
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /^Publish step \(root\)\/start in .*\n.*--phase start 1\.1\.0 --notes-file .*\nRun it\? \[y\/N\] $/);
    assert.match(prompts[1], /release\/v1\.1\.0.*\nDone\? \[y\/N\] $/s);
    assert.deepEqual({ step: second.data.stopped?.step, reason: second.data.stopped?.reason }, { step: '(root)/merge', reason: 'check' });
    assert.match(second.data.stopped!.detail, /check pr-merged failed: there is no release PR from release\/v1\.1\.0 into develop/);
    assert.deepEqual(checks(), ['--check merged 1.1.0', '--check merged 1.1.0'], 'checked before asking and after Done?');

    // Without a terminal the merge waits for a human.
    const waiting = await run(false, recordingSpawn().spawn);
    assert.deepEqual({ step: waiting.data.stopped?.step, reason: waiting.data.stopped?.reason }, { step: '(root)/merge', reason: 'manual' });

    // Once merged, the merge step is skipped and tag runs unasked: nothing publishes after the merge.
    fs.writeFileSync(path.join(r.dir, 'scripts', 'merged'), '');
    prompts.length = 0;
    const last = recordingSpawn();
    const third = await run(true, last.spawn);
    assert.equal(third.exitCode, 0);
    assert.deepEqual(third.data.skipped, ['(root)/merge']);
    assert.deepEqual(phases(last.calls), ['scripts/release.mjs --phase wait-tag 1.1.0']);
    assert.deepEqual(prompts, []);
    assert.equal(third.data.done, third.data.total);
  } finally {
    r.cleanup();
  }
});
