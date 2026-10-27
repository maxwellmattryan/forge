// `forge verify` recomputes a job's components from its committed diff (docs/CONFIG.md "Components" ›
// Recompute at verify) before it picks the commands to run: the top-level ones for zero or several
// components, a single one's own otherwise. Each command appends a marker to $MARK_OUT, so a test reads
// which ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeAsync, repoTemplate } from '../../helpers.ts';
import { loadJob, readEvents } from '#core/job/store.ts';

const mark = (name: string) => `${JSON.stringify(process.execPath)} -e 'require("fs").appendFileSync(process.env.MARK_OUT, "${name}\\n")'`;

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '..', `answers-${path.basename(dir)}.json`);
  fs.writeFileSync(
    answers,
    JSON.stringify({
      commands: { test: mark('top') },
      commandEnv: { inherit: ['MARK_OUT'] },
      verify: ['test'],
      worktrees: { root: '../{repo}.wt' },
      components: [
        { name: 'cli', path: '.', kind: 'library', paths: ['lib/cli/**'], commands: { test: mark('cli') } },
        { name: 'dashboard', path: '.', kind: 'library', paths: ['dashboard/**'], commands: { test: mark('dashboard') } },
      ],
    }),
  );
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

/** A copy of the template with one job declared on `components`, its worktree created, in round 1. */
async function scratch(components: string) {
  const r = template();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-components-'));
  const marks = path.join(out, 'marks.txt');
  const forge = async (args: string[]) => {
    const res = await forgeAsync(r.dir, args, { MARK_OUT: marks });
    assert.equal(res.status, 0, `forge ${args.join(' ')} exited ${res.status}: ${res.stderr}${res.stdout}`);
    return JSON.parse(res.stdout);
  };
  const job = await forge(['job', 'new', '--title', 'components', '--components', components]);
  await forge(['worktree', 'create', job.id]);
  await forge(['job', 'round', job.id]);
  const id = job.id as string;
  const worktree = loadJob(r.dir, id).worktree!;
  /** Commits `files` in the job's worktree. */
  const commit = (files: string[]) => {
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(worktree, f)), { recursive: true });
      fs.writeFileSync(path.join(worktree, f), 'export {};\n');
    }
    execFileSync('git', ['add', '-A'], { cwd: worktree, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'build'], { cwd: worktree, stdio: 'pipe' });
  };
  /** Runs forge verify and returns the commands it ran, the job and its components events. */
  const verify = async () => {
    fs.rmSync(marks, { force: true });
    await forge(['verify', id]);
    const ran = fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8').split('\n').filter(Boolean) : [];
    return { ran, job: loadJob(r.dir, id), events: readEvents(r.dir, id).filter((e) => e.type === 'components') };
  };
  const cleanup = () => {
    r.cleanup();
    fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  };
  return { commit, verify, cleanup };
}

test('verify recomputes components from the diff and runs the top-level commands', async () => {
  const s = await scratch('dashboard');
  try {
    s.commit(['lib/cli/a.ts', 'dashboard/src/b.ts']);
    const { ran, job, events } = await s.verify();
    assert.deepEqual(
      { components: job.components, componentsDeclared: job.componentsDeclared, componentsFromDiff: job.componentsFromDiff, componentsUnmatched: job.componentsUnmatched },
      { components: ['cli', 'dashboard'], componentsDeclared: ['dashboard'], componentsFromDiff: ['cli', 'dashboard'], componentsUnmatched: false },
    );
    assert.equal(events.length, 1);
    const { ts: _ts, v: _v, actor: _actor, sha, ...event } = events[0];
    assert.deepEqual(event, { type: 'components', declared: ['dashboard'], components: ['cli', 'dashboard'], added: ['cli'], dropped: [], unmatched: 0 });
    assert.match(String(sha), /^[0-9a-f]{40}$/);
    assert.deepEqual(ran, ['top']);
  } finally {
    s.cleanup();
  }
});

test('a declared component the diff never touches is dropped', async () => {
  const s = await scratch('cli,dashboard');
  try {
    s.commit(['lib/cli/x.ts']);
    const { ran, job, events } = await s.verify();
    assert.deepEqual([job.components, job.componentsFromDiff], [['cli'], ['cli']]);
    assert.deepEqual(events.map((e) => [e.added, e.dropped]), [[[], ['dashboard']]]);
    assert.deepEqual(ran, ['cli']);
    // The next verify over the same diff changes nothing, so it logs nothing.
    const again = await s.verify();
    assert.equal(again.events.length, 1);
    assert.deepEqual(again.ran, ['cli']);
  } finally {
    s.cleanup();
  }
});

test('a changed file outside every component runs the top-level commands', async () => {
  const s = await scratch('cli');
  try {
    // One component's files plus root files no component covers: the diff names only `cli`, but the
    // component's own `test` would never see the stray files, so the top-level suite runs.
    s.commit(['lib/cli/x.ts', 'Makefile', 'tools/check.sh']);
    const { ran, job, events } = await s.verify();
    assert.deepEqual([job.components, job.componentsFromDiff, job.componentsUnmatched], [['cli'], ['cli'], true]);
    assert.deepEqual(events.map((e) => [e.components, e.added, e.dropped, e.unmatched]), [[['cli'], [], [], 2]]);
    assert.deepEqual(ran, ['top']);
    // Another file outside the components changes nothing about the finding, so nothing more is logged.
    s.commit(['notes/more.txt']);
    const again = await s.verify();
    assert.equal(again.events.length, 1);
    assert.deepEqual(again.ran, ['top']);
  } finally {
    s.cleanup();
  }
});

test('no diff keeps the declared list', async () => {
  const s = await scratch('dashboard');
  try {
    const { ran, job, events } = await s.verify();
    assert.deepEqual([job.components, job.componentsDeclared, job.componentsFromDiff], [['dashboard'], ['dashboard'], null]);
    assert.deepEqual(events, []);
    assert.deepEqual(ran, ['dashboard']);
  } finally {
    s.cleanup();
  }
});
