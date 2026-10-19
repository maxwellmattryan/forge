// The rework panel (review.onRework: narrow): on round N >= 2 `forge job panel` re-runs only the
// always lenses, the ones that asked for changes and the ones whose paths the fix touched, and
// falls back to the full panel whenever the comparison point can't be trusted. The attacker is the
// builder, who wants a round-2 change to escape a lens that passed round 1.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { jobDir, loadJob, logEvent, readEvents, updateJob } from '../lib/jobs.ts';
import { jobPanel } from '../lib/panel.ts';
import { reworkPanel } from '../lib/step.ts';
import type { Config } from '../lib/types.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const PANEL = [
  { name: 'code', always: true },
  // Opts out of security's always-on-rework name default, so these tests can watch a passed lens
  // narrow; the shipped default is held by "the shipped default panel re-runs security".
  { name: 'security', paths: ['lib/server.ts', 'lib/trackers/**'], alwaysOnRework: false },
  { name: 'docs', paths: ['docs/**'] },
  { name: 'design', paths: ['*.svelte'] },
];
const LENSES = ['code', 'security', 'docs'];

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, review: { panel: PANEL } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge init'], { cwd: dir, stdio: 'pipe' });
});

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = (cwd: string, files: Record<string, string>, msg: string) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), text);
  }
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, 'commit', '-qm', msg);
};

/**
 * A job reviewed in round 1 with `verdicts` (the round-1 `verdicts` event's sha is round 1's HEAD,
 * or `sha` when given), then moved to round 2. `config` edits the loaded config before the panel.
 */
async function round2(verdicts: Record<string, string> | null, o: { sha?: (head: string) => unknown; lenses?: string[] } = {}) {
  const repo = template();
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
    config.review.panel = PANEL;
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
      const pure = reworkPanel({ job: { round: 2, verdicts: { 1: { code: 'PASS', security: 'CHANGES', tests: 'PASS' } }, pr: null, kind: 'feature' } as any, config: (() => { const c = defaults(); c.review.panel = [...PANEL, { name: 'tests' }]; return c; })(), lenses: ['code', 'security', 'docs', 'tests'], changedSince: ['src/a.ts'], members: 0 });
      assert.deepEqual(pure, { rerun: ['code', 'security', 'docs'], reasons: { code: ['always'], security: ['changes requested in round 1'], docs: ['new this round'] }, skipped: ['tests'] });
      const r = s.panel();
      // All three re-run, so nothing narrows; the decision is the same as the pure one's.
      assert.equal(r.rerun, undefined);
    } finally {
      s.cleanup();
    }
  });

  test('the shipped default panel re-runs security on every rework round', async () => {
    // defaults()'s security entry has no paths, so only its name default brings it back.
    const config = defaults();
    config.review.panel = [...defaults().review.panel, { name: 'docs' }];
    assert.equal(config.review.panel.find((p) => p.name === 'security')?.paths, undefined, 'the shipped security lens has no paths');
    const lenses = ['code', 'tests', 'security', 'docs'];
    const job = { round: 2, verdicts: { 1: { code: 'PASS', tests: 'CHANGES', security: 'PASS', docs: 'PASS' } }, pr: null, kind: 'feature' as const } as any;
    // A fix for a tests finding that also adds a process call in the server.
    const r = reworkPanel({ job, config, lenses, changedSince: ['test/a.test.ts', 'lib/server.ts'], members: 0 });
    assert.deepEqual(r, { rerun: ['code', 'tests', 'security'], reasons: { code: ['always'], tests: ['always', 'changes requested in round 1'], security: ['always on rework'] }, skipped: ['docs'] });
    // Round 3 too: a pass in round 2 never lets it drop.
    const r3 = reworkPanel({ job: { ...job, round: 3, verdicts: { ...job.verdicts, 2: { code: 'PASS', tests: 'CHANGES', security: 'PASS' } } }, config, lenses, changedSince: ['README.md'], members: 0 });
    assert.deepEqual(r3?.rerun, ['code', 'tests', 'security']);
    // An explicit opt-out narrows it like any other passed lens.
    config.review.panel = config.review.panel.map((p) => (p.name === 'security' ? { ...p, alwaysOnRework: false } : p));
    assert.deepEqual(reworkPanel({ job, config, lenses, changedSince: ['lib/server.ts'], members: 0 })?.skipped, ['security', 'docs']);
    // A repo panel written before v21 (security with prose `when` only) keeps the name default too.
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

  test('review.panel alwaysOnRework validation', () => {
    const config = defaults();
    const problems = (v: unknown) => {
      config.review.panel = [{ name: 'code', always: true }, { name: 'security', alwaysOnRework: v } as any];
      return validateConfig(config, path.resolve(import.meta.dirname, '..')).filter((p) => p.includes('alwaysOnRework'));
    };
    assert.deepEqual(problems(true), []);
    assert.deepEqual(problems(false), []);
    assert.deepEqual(problems('yes'), ['review.panel "security".alwaysOnRework must be true or false (got "yes")']);
  });

  test('a lens carried from an earlier round keeps its pass', () => {
    const config = defaults();
    config.review.panel = PANEL;
    // Round 2 re-ran only code and docs; round 3 must not treat security as new.
    const job = { round: 3, verdicts: { 1: MIXED, 2: { code: 'PASS', docs: 'CHANGES' } }, pr: null, kind: 'feature' as const } as any;
    const r = reworkPanel({ job, config, lenses: LENSES, changedSince: ['README.md'], members: 0 });
    assert.deepEqual(r, { rerun: ['code', 'docs'], reasons: { code: ['always'], docs: ['changes requested in round 2'] }, skipped: ['security'] });
  });
});
