// `forge job panel` end to end: the lenses come from the committed diff as git stores it, and a
// lens the rules select can't be hidden by anything the builder controls (its commits, the
// worktree's git config, replace objects, or job.reviewers).
// The rework panel (review.onRework: narrow): on round N >= 2 `forge job panel` re-runs only the
// always lenses, the ones that asked for changes and the ones whose paths the fix touched, and
// falls back to the full panel whenever the comparison point can't be trusted. The attacker is the
// builder, who wants a round-2 change to escape a lens that passed round 1. The pure decisions
// (choosePanel, reworkPanel) are in test/panel.test.ts.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { evalTaskYml, forgeAsync, forgeSync, repoTemplate, scratchGitConfig } from '../../helpers.ts';
import { defaults, loadConfig } from '../../../lib/core/config/load.ts';
import { jobDir, loadJob, logEvent, readEvents, updateJob } from '../../../lib/core/job/store.ts';
import { jobPanel } from '../../../lib/panel.ts';
import { reworkPanel } from '../../../lib/step.ts';
import type { Config } from '../../../lib/core/types.ts';

const write = (dir: string, rel: string, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const commitAll = (cwd: string, msg: string) => {
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, 'commit', '-qm', msg);
};

/** `forge init write` with `answers` in `dir`, committed. */
function initWith(dir: string, answers: unknown) {
  const file = path.join(dir, '.answers.json');
  fs.writeFileSync(file, JSON.stringify(answers));
  const r = forgeSync(dir, ['init', 'write', '--answers', file]);
  assert.equal(r.status, 0, r.stderr);
  fs.rmSync(file);
  commitAll(dir, 'forge init');
}

const PANEL = [
  { name: 'code', always: true },
  { name: 'security', when: 'anything that ingests tracker text', paths: ['lib/trackers/**', 'package.json'] },
  { name: 'docs', paths: ['docs/**', '*.md'] },
  { name: 'design', paths: ['*.svelte'] },
];

const template = repoTemplate((dir) => initWith(dir, { commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, review: { panel: PANEL } }));

const SPEC = '# Spec\n\nSize: S\nSuggested reviewers: -\n\n## Approach\n- `src/a.ts`\n';

/** A scratch repo with one job, its worktree and spec.md; `base` files are committed to main first. */
async function setup(o: { spec?: string; base?: Record<string, string> } = {}) {
  const repo = template();
  const raw = (...args: string[]) => forgeAsync(repo.dir, args);
  const f = async (...args: string[]) => {
    const r = await raw(...args);
    assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  for (const [rel, text] of Object.entries(o.base ?? {})) write(repo.dir, rel, text);
  if (o.base) commitAll(repo.dir, 'base files');
  const { id } = await f('job', 'new', '--title', 'Panel check');
  const wt: string = (await f('worktree', 'create', id)).path;
  await f('job', 'round', id);
  fs.writeFileSync(path.join(jobDir(repo.dir, id), 'spec.md'), o.spec ?? SPEC);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  };
  return { root: repo.dir, id, wt, f, raw, cleanup };
}

const events = (root: string, id: string, type: string) => readEvents(root, id).filter((e) => e.type === type);

/**
 * evalScratch's repo (Forge initialised, eval task `t` committed), built in place rather than
 * copied from a shared template: every commit starts a detached `git maintenance run --auto`, which
 * can add and remove files under .git/objects while a copy walks it (ENOENT on a CI runner). Auto
 * maintenance is off before the first commit, so nothing writes to the repo behind the test.
 */
function evalRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'maintenance.auto', 'false');
  scratchGitConfig(git);
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { build: 'true', test: 'true', lint: 'true' }, worktrees: { root: '../{repo}.wt' } }));
  const init = forgeSync(dir, ['init', 'write', '--answers', answers]);
  assert.equal(init.status, 0, init.stderr);
  fs.rmSync(answers);
  write(dir, '.forge/evals/t/check/files/t.txt', 't\n');
  write(dir, '.forge/evals/t/task.yml', evalTaskYml('t'));
  commitAll(dir, 'forge and eval task');
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.wt`, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

describe('forge job panel', { concurrency: 4 }, () => {
  test('forge job panel writes the lenses the diff selects to job.reviewers, and help lists it', async () => {
    const s = await setup();
    try {
      write(s.wt, 'lib/trackers/github.ts');
      commitAll(s.wt, 'wanders into trackers');
      const r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.lenses, ['code', 'security']);
      assert.deepEqual(loadJob(s.root, s.id).reviewers, ['code', 'security']);

      // The usage line and help list the command.
      const usage = await s.raw('job');
      assert.match(usage.stderr, /\|panel\|/);
      assert.match((await s.raw('help', 'job')).stdout, /forge job panel <id>/);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel records reviewers, a panel event and added', async () => {
    const s = await setup({ spec: SPEC.replace('Suggested reviewers: -', 'Suggested reviewers: docs, nope') });
    try {
      await s.f('job', 'set', s.id, '--field', 'reviewers=["code","extra"]');
      write(s.wt, 'ui/Card.svelte');
      commitAll(s.wt, 'a component');
      const fieldsBefore = events(s.root, s.id, 'fields').length;
      const r = await s.f('job', 'panel', s.id);
      assert.deepEqual(Object.keys(r), ['id', 'round', 'base', 'mergeBase', 'head', 'dirty', 'changed', 'lenses', 'reasons', 'added']);
      assert.equal(r.id, s.id);
      assert.equal(r.round, 1);
      assert.equal(r.base, 'main');
      assert.match(r.mergeBase, /^[0-9a-f]{40}$/);
      assert.equal(r.head, gitIn(s.wt, 'rev-parse', 'HEAD'));
      assert.equal(r.dirty, false);
      assert.deepEqual(r.lenses, ['code', 'docs', 'design', 'extra']);
      assert.deepEqual(r.reasons, { code: ['always', 'carried'], docs: ['suggested'], design: ['paths *.svelte: ui/Card.svelte'], extra: ['carried'] });
      assert.deepEqual(r.added, ['docs', 'design']);
      assert.deepEqual(loadJob(s.root, s.id).reviewers, r.lenses);
      assert.equal(events(s.root, s.id, 'fields').length, fieldsBefore + 1);
      const ev = events(s.root, s.id, 'panel');
      assert.equal(ev.length, 1);
      assert.deepEqual(
        { round: ev[0].round, head: ev[0].head, mergeBase: ev[0].mergeBase, lenses: ev[0].lenses, reasons: ev[0].reasons, added: ev[0].added },
        { round: r.round, head: r.head, mergeBase: r.mergeBase, lenses: r.lenses, reasons: r.reasons, added: r.added },
      );

      // Unchanged: one more panel event, no fields event.
      const again = await s.f('job', 'panel', s.id);
      assert.deepEqual(again.lenses, r.lenses);
      assert.deepEqual(again.added, []);
      assert.equal(events(s.root, s.id, 'fields').length, fieldsBefore + 1);
      assert.equal(events(s.root, s.id, 'panel').length, 2);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel reads the committed diff as git stores it', async () => {
    const s = await setup({ base: { 'lib/trackers/old.ts': 'export const tracker = 1;\n'.repeat(20) } });
    try {
      // An uncommitted change alone adds nothing, and is reported.
      write(s.wt, 'lib/trackers/dirty.ts');
      let r = await s.f('job', 'panel', s.id);
      assert.equal(r.dirty, true);
      assert.equal(r.changed, 0);
      assert.deepEqual(r.lenses, ['code']);
      fs.rmSync(path.join(s.wt, 'lib/trackers/dirty.ts'));

      // A rename keeps the old path, which is the one the glob matches.
      gitIn(s.wt, 'config', 'diff.renames', 'true');
      fs.mkdirSync(path.join(s.wt, 'src'), { recursive: true });
      gitIn(s.wt, 'mv', 'lib/trackers/old.ts', 'src/moved.ts');
      commitAll(s.wt, 'move out of trackers');
      r = await s.f('job', 'panel', s.id);
      assert.equal(r.dirty, false);
      assert.deepEqual(r.reasons.security, ['paths lib/trackers/**: lib/trackers/old.ts']);

      // A non-ASCII path stays raw under core.quotePath=true.
      gitIn(s.wt, 'config', 'core.quotePath', 'true');
      write(s.wt, 'docs/naïve-über.txt');
      commitAll(s.wt, 'non-ascii doc');
      r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.reasons.docs, ['paths docs/**: docs/naïve-über.txt']);

      // diff.relative in the repo config doesn't narrow the diff.
      gitIn(s.wt, 'config', 'diff.relative', 'true');
      write(s.wt, 'web/deep/Card.svelte');
      commitAll(s.wt, 'component');
      r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.reasons.design, ['paths *.svelte: web/deep/Card.svelte']);
      assert.deepEqual(r.lenses, ['code', 'security', 'docs', 'design']);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel ignores replace objects', async () => {
    const s = await setup();
    try {
      write(s.wt, 'lib/trackers/evil.ts');
      commitAll(s.wt, 'tracker change');
      const parent = gitIn(s.wt, 'rev-parse', 'HEAD~1');
      // A commit with the parent's tree, put in place of HEAD: plain git now sees no change.
      const fake = gitIn(s.wt, 'commit-tree', `${parent}^{tree}`, '-p', parent, '-m', 'nothing to see');
      gitIn(s.wt, 'replace', 'HEAD', fake);
      assert.equal(gitIn(s.wt, 'diff', '--name-only', parent, 'HEAD'), '', 'the replace hides the change from plain git');
      const r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.lenses, ['code', 'security']);
      assert.deepEqual(r.reasons.security, ['paths lib/trackers/**: lib/trackers/evil.ts']);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel never drops a computed lens', async () => {
    const s = await setup({ spec: SPEC.replace('Suggested reviewers: -', 'Suggested reviewers: docs') });
    try {
      write(s.wt, 'lib/trackers/a.ts');
      commitAll(s.wt, 'tracker change');
      await s.f('job', 'set', s.id, '--field', 'reviewers=[]');
      const r = await s.f('job', 'panel', s.id);
      assert.deepEqual(r.lenses, ['code', 'security', 'docs']);
      assert.deepEqual(loadJob(s.root, s.id).reviewers, ['code', 'security', 'docs']);
      // A retro job's panel is fixed at code and docs, so turning this job into one would drop security.
      for (const kind of ['retro', 'eval']) {
        const refused = await s.raw('job', 'set', s.id, '--field', `kind=${kind}`);
        assert.equal(refused.status, 1, refused.stdout);
        assert.match(refused.stderr, new RegExp(`--field kind=${kind} is not settable; use `));
      }
      assert.equal(loadJob(s.root, s.id).kind, 'feature');
      const again = await s.f('job', 'panel', s.id);
      assert.deepEqual(again.lenses, ['code', 'security', 'docs']);
      assert.deepEqual(loadJob(s.root, s.id).reviewers, ['code', 'security', 'docs']);
    } finally {
      s.cleanup();
    }
  });

  test('forge job panel fails on a missing job, worktree or spec', async () => {
    const s = await setup();
    try {
      let r = await s.raw('job', 'panel', 'no-such-job');
      assert.equal(r.status, 1, r.stderr);
      const { id } = await s.f('job', 'new', '--title', 'No worktree');
      r = await s.raw('job', 'panel', id);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`job ${id} has no worktree yet`));
      fs.rmSync(path.join(jobDir(s.root, s.id), 'spec.md'));
      r = await s.raw('job', 'panel', s.id);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`job ${s.id} has no spec.md`));
      assert.equal(events(s.root, s.id, 'panel').length, 0);
    } finally {
      s.cleanup();
    }
  });

  test("forge job panel applies an eval job's overlay", async () => {
    const s = evalRepo();
    try {
      const overlay = 'review.panel=[{name: code, always: true}, {name: security, paths: ["t.txt"]}, {name: docs, paths: ["*.md"]}]';
      const started = await forgeAsync(s.dir, ['eval', 'start', '--tasks', 't', '--set', overlay]);
      assert.equal(started.status, 0, started.stderr);
      const id = JSON.parse(started.stdout).tasks[0].job;
      const created = await forgeAsync(s.dir, ['worktree', 'create', id]);
      assert.equal(created.status, 0, created.stderr);
      const wt = loadJob(s.dir, id).worktree!;
      fs.writeFileSync(path.join(jobDir(s.dir, id), 'spec.md'), SPEC);
      write(wt, 't.txt');
      commitAll(wt, 'task work');
      const r = await forgeAsync(s.dir, ['job', 'panel', id]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      // The base config's panel (code and tests, always) is not the one used.
      assert.deepEqual(out.lenses, ['code', 'security']);
      assert.deepEqual(out.reasons.security, ['paths t.txt: t.txt']);
    } finally {
      s.cleanup();
    }
  });
});

const REWORK_PANEL = [
  { name: 'code', always: true },
  // Opts out of security's always-on-rework name default, so these tests can watch a passed lens
  // narrow; the shipped default is held by "a repo panel written before v21 keeps security's name default".
  { name: 'security', paths: ['lib/server.ts', 'lib/trackers/**'], alwaysOnRework: false },
  { name: 'docs', paths: ['docs/**'] },
  { name: 'design', paths: ['*.svelte'] },
];
const LENSES = ['code', 'security', 'docs'];

const reworkTemplate = repoTemplate((dir) => initWith(dir, { commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, review: { panel: REWORK_PANEL } }));

const commit = (cwd: string, files: Record<string, string>, msg: string) => {
  for (const [rel, text] of Object.entries(files)) write(cwd, rel, text);
  commitAll(cwd, msg);
};

/**
 * A job reviewed in round 1 with `verdicts` (the round-1 `verdicts` event's sha is round 1's HEAD,
 * or `sha` when given), then moved to round 2. `config` edits the loaded config before the panel.
 */
async function round2(verdicts: Record<string, string> | null, o: { sha?: (head: string) => unknown; lenses?: string[] } = {}) {
  const repo = reworkTemplate();
  const f = async (...args: string[]) => {
    const r = await forgeAsync(repo.dir, args);
    assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const { id } = await f('job', 'new', '--title', 'Rework panel');
  const wt: string = (await f('worktree', 'create', id)).path;
  await f('job', 'round', id);
  fs.writeFileSync(path.join(jobDir(repo.dir, id), 'spec.md'), '# Spec\n\nSize: S\nSuggested reviewers: security, docs\n\n## Approach\n- `src/a.ts`\n');
  commit(wt, { 'src/a.ts': 'one\n' }, 'round 1');
  const head1 = gitIn(wt, 'rev-parse', 'HEAD');
  updateJob(repo.dir, id, (j) => {
    j.reviewers = [...(o.lenses ?? LENSES)];
    if (verdicts) j.verdicts = { 1: verdicts as any };
  });
  if (verdicts) logEvent(repo.dir, id, 'verdicts', { round: 1, outcome: 'CHANGES', ...(o.sha ? { sha: o.sha(head1) } : { sha: head1 }) });
  await f('job', 'round', id);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  };
  const panel = (edit: (c: Config) => void = () => {}) => {
    const { config } = loadConfig(repo.dir);
    edit(config);
    return jobPanel(repo.dir, config, id);
  };
  const lastPanelEvent = () => readEvents(repo.dir, id).filter((e) => e.type === 'panel').at(-1)!;
  return { root: repo.dir, id, wt, head1, panel, lastPanelEvent, cleanup };
}

const MIXED: Record<string, any> = { code: 'PASS', security: 'PASS', docs: 'CHANGES' };

describe('rework panel', { concurrency: 4 }, () => {
  test('rework panel keeps always and changes-requested lenses', async () => {
    const s = await round2(MIXED);
    try {
      commit(s.wt, { 'README.md': 'fixed\n' }, 'fix docs finding');
      const r = s.panel();
      assert.deepEqual(r.lenses, LENSES);
      assert.deepEqual(r.rerun, ['code', 'docs']);
      assert.deepEqual(r.skipped, ['security']);
      assert.deepEqual(loadJob(s.root, s.id).reviewers, LENSES, 'job.reviewers is unchanged: lenses never drop');
      const ev = s.lastPanelEvent();
      assert.deepEqual(ev.rerun, ['code', 'docs']);
      assert.deepEqual(ev.rerunReasons, { code: ['always'], docs: ['changes requested in round 1'] });
    } finally {
      s.cleanup();
    }
  });

  test('a passed lens re-runs when the fix touches its paths', async () => {
    // A fourth lens that passed and whose paths the fix leaves alone, so the round still narrows.
    const s = await round2({ ...MIXED, design: 'PASS' }, { lenses: [...LENSES, 'design'] });
    try {
      commit(s.wt, { 'README.md': 'fixed\n', 'lib/server.ts': 'sneaky\n' }, 'fix docs finding and more');
      const r = s.panel();
      assert.deepEqual(r.rerun, ['code', 'security', 'docs']);
      assert.deepEqual(r.skipped, ['design']);
      assert.deepEqual((s.lastPanelEvent().rerunReasons as any).security, ['paths lib/server.ts: lib/server.ts']);
    } finally {
      s.cleanup();
    }
  });

  test('rework panel falls back to the full panel on an unusable sha', async () => {
    const marker = path.join(fs.realpathSync(os.tmpdir()), `forge-rework-${process.pid}-${Date.now()}`);
    const shas: [string, ((head: string) => unknown) | undefined, boolean][] = [
      ['missing', () => undefined, false],
      ['option', () => `--output=${marker}`, false],
      ['revision', () => 'HEAD~1', false],
      ['all', () => '--all', false],
      ['short', (h) => h.slice(0, 12), false],
      ['upper', (h) => h.toUpperCase(), false],
      ['rewritten', undefined, true],
    ];
    await Promise.all(
      shas.map(async ([label, sha, rewrite]) => {
        const s = await round2(MIXED, sha ? { sha } : {});
        try {
          if (rewrite) {
            // Reset away round 1's commit and recommit: the reviewed sha is no longer an ancestor.
            gitIn(s.wt, 'reset', '-q', '--hard', 'HEAD~1');
            commit(s.wt, { 'src/a.ts': 'other\n', 'README.md': 'fixed\n' }, 'rewritten');
          } else commit(s.wt, { 'README.md': 'fixed\n' }, 'fix');
          const r = s.panel();
          assert.equal(r.rerun, undefined, `${label}: no rerun`);
          assert.equal(r.skipped, undefined, `${label}: no skipped`);
          assert.equal('rerun' in s.lastPanelEvent(), false, `${label}: the event records no rerun`);
        } finally {
          s.cleanup();
        }
      }),
    );
    assert.equal(fs.existsSync(marker), false, 'no git command ran with the malformed sha');
  });

  test('rework panel applies only to a narrowable round', async () => {
    const cases: [string, Record<string, string> | null, (c: Config) => void, ((root: string, id: string) => void) | null][] = [
      ['onRework full', MIXED, (c) => (c.review.onRework = 'full'), null],
      ['onRework unknown', MIXED, (c) => ((c.review as any).onRework = 'some'), null],
      ['round 1 all PASS', { code: 'PASS', security: 'PASS', docs: 'PASS' }, () => {}, null],
      ['round 1 no verdicts', null, () => {}, null],
      ['PR open', MIXED, () => {}, (root, id) => updateJob(root, id, (j) => void (j.pr = { number: 3, url: 'https://github.com/o/r/pull/3', state: 'OPEN', isDraft: false, lastSyncedAt: null } as any))],
    ];
    await Promise.all(
      cases.map(async ([label, verdicts, edit, mutate]) => {
        const s = await round2(verdicts);
        try {
          mutate?.(s.root, s.id);
          commit(s.wt, { 'README.md': 'fixed\n' }, 'fix');
          const r = s.panel(edit);
          assert.equal(r.rerun, undefined, label);
          assert.equal('rerun' in s.lastPanelEvent(), false, label);
        } finally {
          s.cleanup();
        }
      }),
    );
    // A reviewed member repo and a retro job: the pure decision.
    const config = defaults();
    config.review.panel = REWORK_PANEL;
    const job = { round: 2, verdicts: { 1: MIXED }, pr: null, kind: 'feature' as const } as any;
    assert.ok(reworkPanel({ job, config, lenses: LENSES, changedSince: ['README.md'], members: 0 }));
    assert.equal(reworkPanel({ job, config, lenses: LENSES, changedSince: ['README.md'], members: 1 }), null, 'a reviewed member repo');
    assert.equal(reworkPanel({ job: { ...job, kind: 'retro' }, config, lenses: LENSES, changedSince: ['README.md'], members: 0 }), null, 'a retro job');
    assert.equal(reworkPanel({ job, config, lenses: LENSES, changedSince: null, members: 0 }), null, 'an unusable sha');
    assert.equal(reworkPanel({ job: { ...job, round: 1 }, config, lenses: LENSES, changedSince: [], members: 0 }), null, 'round 1');
    // Nothing to skip: every lens re-runs, so no rerun is recorded.
    assert.equal(reworkPanel({ job, config, lenses: LENSES, changedSince: ['lib/server.ts'], members: 0 }), null, 'rerun equal to the panel');
  });

  test('a lens new this round re-runs', async () => {
    const s = await round2({ code: 'PASS', security: 'CHANGES' });
    try {
      commit(s.wt, { 'src/a.ts': 'two\n' }, 'fix');
      // docs had no round-1 verdict; security asked for changes; code is always.
      const pure = reworkPanel({ job: { round: 2, verdicts: { 1: { code: 'PASS', security: 'CHANGES', tests: 'PASS' } }, pr: null, kind: 'feature' } as any, config: (() => { const c = defaults(); c.review.panel = [...REWORK_PANEL, { name: 'tests' }]; return c; })(), lenses: ['code', 'security', 'docs', 'tests'], changedSince: ['src/a.ts'], members: 0 });
      assert.deepEqual(pure, { rerun: ['code', 'security', 'docs'], reasons: { code: ['always'], security: ['changes requested in round 1'], docs: ['new this round'] }, skipped: ['tests'] });
      const r = s.panel();
      // All three re-run, so nothing narrows; the decision is the same as the pure one's.
      assert.equal(r.rerun, undefined);
    } finally {
      s.cleanup();
    }
  });

  // The pure half (the shipped default panel) is test/panel.test.ts › "the shipped default panel
  // re-runs security on every rework round".
  test("a repo panel written before v21 keeps security's name default", async () => {
    // Security with prose `when` only, as panels were before v21.
    const old = await round2({ code: 'PASS', security: 'PASS', docs: 'CHANGES', design: 'PASS' }, { lenses: [...LENSES, 'design'] });
    try {
      commit(old.wt, { 'README.md': 'fixed\n', 'lib/new-exec.ts': 'run("sh")\n' }, 'fix docs finding and more');
      const p = old.panel((c) => (c.review.panel = c.review.panel.map((e) => (e.name === 'security' ? { name: 'security', when: 'input handling, process access' } : e))));
      assert.deepEqual(p.rerun, ['code', 'security', 'docs']);
      assert.deepEqual((old.lastPanelEvent().rerunReasons as any).security, ['always on rework']);
    } finally {
      old.cleanup();
    }
  });
});
