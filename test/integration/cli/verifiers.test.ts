// `forge verifiers list|run|record` through the real CLI, in scratch repos with a job, a worktree
// and a passing verify: selection by glob, the main-checkout rule, a diff git config can't reshape,
// the failing verify a block verifier records, stale answers, and attempt-numbered files.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, forgeSync, repoTemplate } from '../../helpers.ts';
import { loadJob, readEvents } from '#core/job/store.ts';

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const commitAll = (cwd: string, msg: string) => {
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, '-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg);
};
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const verifier = (paths: string, more = '', question = 'Is the change fine?') => `---\npaths: ${paths}\n${more}---\n${question}\n`;

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, commands: { test: 'true' }, verify: ['test'], worktrees: { root: '../{repo}.wt' } }));
  const init = forgeSync(dir, ['init', 'write', '--answers', answers]);
  assert.equal(init.status, 0, init.stderr);
  fs.rmSync(answers);
  commitAll(dir, 'forge init');
});

async function scratch(mainFiles: Record<string, string> = {}) {
  const repo = template();
  const root = repo.dir;
  const raw = (...args: string[]) => forgeAsync(root, args);
  const f = async (...args: string[]) => {
    const r = await raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  for (const [rel, text] of Object.entries(mainFiles)) write(root, rel, text);
  if (Object.keys(mainFiles).length) commitAll(root, 'base');
  /** Verifiers in the main checkout's .forge/verifiers/, uncommitted like a maintainer's local edit. */
  const verifiers = (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) write(root, path.join('.forge', 'verifiers', name), text);
  };
  /** A job whose branch makes `work`'s changes in one commit, in round 1, verified. */
  const job = async (work: (wt: string) => void) => {
    const j = await f('job', 'new', '--title', 'verifiers');
    const wt = (await f('worktree', 'create', j.id)).path as string;
    work(wt);
    commitAll(wt, 'job work');
    await f('job', 'round', j.id);
    const v = await raw('verify', j.id);
    assert.equal(v.status, 0, v.stderr + v.stdout);
    return { id: j.id as string, wt, dir: path.join(root, '.forge', 'jobs', j.id) };
  };
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${root}.wt`, { recursive: true, force: true });
  };
  return { root, f, raw, verifiers, job, cleanup };
}

const BASE = { 'lib/a.ts': 'export const a = 1;\n', 'old/b.ts': 'export const b = 2;\n' };
const WORK = (wt: string) => {
  write(wt, 'lib/a.ts', 'export const a = 1;\nexport const a2 = "LIB-A-MARKER";\n');
  write(wt, 'docs/x.md', '# DOCS-X-MARKER\n');
  write(wt, 'src/c.go', 'package c // UNMATCHED-MARKER\n');
  gitIn(wt, 'mv', 'old/b.ts', 'lib/b.ts');
};

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
const verifierEvents = (root: string, id: string) => readEvents(root, id).filter((e) => e.type === 'verifiers');

describe('forge verifiers', { concurrency: 4 }, () => {
  test('run selects verifiers by glob and sends only matching hunks', async () => {
    const s = await scratch(BASE);
    try {
      s.verifiers({ 'lib.md': verifier('[lib/**]'), 'old.md': verifier('[old/**]'), 'md.md': verifier("['*.md']"), 'py.md': verifier("['*.py']"), 'both.md': verifier('[lib/a.ts]') });
      const j = await s.job(WORK);
      const r = await s.f('verifiers', 'run', j.id);
      assert.deepEqual(r.selected, ['both', 'lib', 'md', 'old']);
      assert.equal(r.outcome, null);
      assert.equal(r.problems, 0);
      assert.equal(r.file, path.join('.forge', 'jobs', j.id, 'verify', 'round-1-verifiers-input.md'));
      const snap = JSON.parse(read(j.dir, 'verify/round-1-verifiers-run.json'));
      const files = Object.fromEntries(snap.selected.map((x: any) => [x.name, x.files]));
      assert.deepEqual(files, { both: ['lib/a.ts'], lib: ['lib/a.ts', 'lib/b.ts'], md: ['docs/x.md'], old: ['old/b.ts'] });
      assert.equal(snap.model, 'haiku');
      assert.equal(snap.attempt, 1);
      const input = read(j.dir, 'verify/round-1-verifiers-input.md');
      assert.ok(input.includes('LIB-A-MARKER') && input.includes('DOCS-X-MARKER'));
      assert.ok(!input.includes('UNMATCHED-MARKER'), 'no text from an unmatched file');
      assert.ok(!input.includes('src/c.go'));
      assert.equal(input.split('File (JSON): "lib/a.ts"').length, 2, 'a file two verifiers match appears once');
      const ev = verifierEvents(s.root, j.id);
      assert.equal(ev.length, 1);
      assert.deepEqual({ ...ev[0], ts: undefined, v: undefined }, { ts: undefined, v: undefined, type: 'verifiers', phase: 'run', round: 1, sha: snap.sha, attempt: 1, selected: ['both', 'lib', 'md', 'old'], problems: 0, truncated: false });
    } finally {
      s.cleanup();
    }
  });

  test('verifiers come from the main checkout only', async () => {
    const s = await scratch(BASE);
    try {
      s.verifiers({ 'main-only.md': verifier("['**']") });
      const j = await s.job((wt) => {
        write(wt, 'lib/a.ts', 'changed\n');
        write(wt, '.forge/verifiers/branch-only.md', verifier("['**']", 'mode: block\n'));
      });
      const r = await s.f('verifiers', 'run', j.id);
      assert.deepEqual(r.selected, ['main-only']);
      const list = await s.f('verifiers', 'list');
      assert.deepEqual(list.verifiers.map((v: any) => v.name), ['main-only']);
      // The branch's file is just another file in the diff.
      const snap = JSON.parse(read(j.dir, 'verify/round-1-verifiers-run.json'));
      assert.ok(snap.selected[0].files.includes('.forge/verifiers/branch-only.md'));
    } finally {
      s.cleanup();
    }
  });

  test("run reads the verified commit's diff as git stores it", async () => {
    const s = await scratch(BASE);
    try {
      s.verifiers({ 'lib.md': verifier('[lib/**]'), 'md.md': verifier("['*.md']") });
      const j = await s.job((wt) => {
        WORK(wt);
        write(wt, 'lib/é.ts', 'export const accent = "ACCENT-MARKER";\n');
      });
      const verified = loadJob(s.root, j.id).verifyRuns.at(-1)!.sha!;
      // HEAD moves past the verified commit.
      write(j.wt, 'lib/a.ts', 'LATER-MARKER\n');
      commitAll(j.wt, 'later');
      const first = await s.f('verifiers', 'run', j.id);
      const snap = () => JSON.parse(read(j.dir, 'verify/round-1-verifiers-run.json'));
      const baseline = { input: read(j.dir, 'verify/round-1-verifiers-input.md'), selected: snap().selected };
      assert.equal(first.sha, verified);
      assert.ok(!baseline.input.includes('LATER-MARKER'), 'hunks come from the verified commit');
      assert.ok(baseline.input.includes('ACCENT-MARKER'));
      assert.ok(baseline.selected.find((x: any) => x.name === 'lib').files.includes('lib/é.ts'));
      // Hostile repo state the job's worktree can write.
      write(j.wt, '.gitattributes', '*.ts diff=x\n*.md diff=x\n');
      gitIn(j.wt, 'config', 'diff.x.textconv', 'echo TEXTCONV-MARKER');
      gitIn(j.wt, 'config', 'diff.external', 'echo EXTERNAL-MARKER');
      gitIn(j.wt, 'config', 'core.quotePath', 'true');
      gitIn(j.wt, 'config', 'diff.relative', 'true');
      gitIn(j.wt, 'config', 'diff.noprefix', 'true');
      const other = gitIn(j.wt, 'commit-tree', `${gitIn(s.root, 'rev-parse', 'HEAD^{tree}').trim()}`, '-m', 'decoy').trim();
      gitIn(j.wt, 'replace', verified, other);
      const second = await s.f('verifiers', 'run', j.id);
      assert.deepEqual(second.selected, first.selected);
      assert.deepEqual(snap().selected, baseline.selected);
      assert.equal(read(j.dir, 'verify/round-1-verifiers-input.md'), baseline.input);
      gitIn(j.wt, 'replace', '-d', verified);
    } finally {
      s.cleanup();
    }
  });

  test('no match records a pass', async () => {
    const s = await scratch(BASE);
    try {
      s.verifiers({ 'py.md': verifier("['*.py']"), 'broken.md': 'no frontmatter\n' });
      const j = await s.job(WORK);
      const r = await s.f('verifiers', 'run', j.id);
      assert.deepEqual(r, { id: j.id, round: 1, sha: r.sha, selected: [], problems: 1, truncated: false, outcome: 'PASS', file: path.join('.forge', 'jobs', j.id, 'verify', 'round-1-verifiers.md') });
      const report = read(j.dir, 'verify/round-1-verifiers.md');
      assert.match(report, /^VERDICT: PASS\n/);
      assert.match(report, /No verifier matched the diff/);
      assert.match(report, /^- problem "broken\.md": no frontmatter/m);
      const ev = verifierEvents(s.root, j.id);
      assert.equal(ev.length, 1);
      assert.equal(ev[0].phase, 'record');
      assert.equal(ev[0].outcome, 'PASS');
      assert.deepEqual(ev[0].results, []);
      await s.f('job', 'set', j.id, '--stage', 'verify', '--state', 'running');
      const step = await s.f('job', 'step', j.id);
      assert.equal(step.rule, 'V2b', JSON.stringify(step));
      assert.deepEqual(step.command, ['job', 'set', j.id, '--stage', 'review', '--state', 'running']);
    } finally {
      s.cleanup();
    }
  });

  test('a failing block verifier sends the job back to build; warn only annotates', async () => {
    for (const mode of ['block', 'warn']) {
      const s = await scratch(BASE);
      try {
        s.verifiers({ 'help-rows.md': verifier('[lib/**]', `severity: major\nmode: ${mode}\n`, 'Does every new command have a HELP row?') });
        const j = await s.job(WORK);
        await s.f('job', 'set', j.id, '--stage', 'verify', '--state', 'running');
        assert.deepEqual((await s.f('job', 'step', j.id)).command, ['verifiers', 'run', j.id]);
        await s.f('verifiers', 'run', j.id);
        const vf2 = await s.f('job', 'step', j.id);
        assert.equal(vf2.rule, 'VF2');
        assert.equal(vf2.role, 'verifier');
        write(j.dir, 'verify/round-1-verifier-answers.md', '- help-rows: NO — lib/a.ts:2 adds a2 without a HELP row\n');
        const rec = await s.f('verifiers', 'record', j.id);
        const report = read(j.dir, 'verify/round-1-verifiers.md');
        const job = loadJob(s.root, j.id);
        if (mode === 'block') {
          assert.equal(rec.outcome, 'CHANGES');
          assert.deepEqual(rec.failed, ['help-rows']);
          assert.match(report, /^VERDICT: CHANGES\n/);
          assert.equal(report.split('\n').filter((l) => l.startsWith('- [major] ')).length, 1);
          assert.match(report, /^- \[major\] lib\/a\.ts:2 — help-rows: Does every new command have a HELP row\? · answer: NO, lib\/a\.ts:2 adds a2 without a HELP row$/m);
          const last = job.verifyRuns.at(-1)!;
          assert.deepEqual({ ...last, at: null }, { round: 1, attempt: 2, sha: job.verifyRuns[0].sha, ok: false, at: null, file: 'verify/round-1-verifiers.md', failure: 'verifiers' });
          assert.equal(job.verify[1], 'FAIL');
          assert.equal(job.verifyRetries['1'], 1);
          const v3 = await s.f('job', 'step', j.id);
          assert.equal(v3.rule, 'V3b');
          await s.f(...(v3.command as string[]));
          const b4 = await s.f('job', 'step', j.id);
          assert.equal(b4.rule, 'B4');
          assert.equal(b4.role, 'builder');
          const lines = b4.brief.split('\n');
          assert.ok(lines.includes('Rework: verifiers'), b4.brief);
          assert.ok(lines.find((l: string) => l.startsWith('Inputs: '))!.includes(path.join(j.dir, 'verify', 'round-1-verifiers.md')));
          assert.ok(!Object.keys(job.agents).some((r) => r.startsWith('reviewer:')), 'no reviewer is spawned');
        } else {
          assert.equal(rec.outcome, 'PASS');
          assert.match(report, /^VERDICT: PASS\n/);
          assert.match(report, /^- warn major lib\/a\.ts:2 — help-rows: /m);
          assert.equal(job.verifyRuns.length, 1, 'no verify run appended');
          assert.equal(job.verify[1], 'PASS');
          const v2 = await s.f('job', 'step', j.id);
          assert.equal(v2.rule, 'V2b');
          assert.deepEqual(v2.command, ['job', 'set', j.id, '--stage', 'review', '--state', 'running']);
        }
        const recEv = verifierEvents(s.root, j.id).at(-1)!;
        assert.equal(recEv.phase, 'record');
        assert.deepEqual(recEv.results, [{ name: 'help-rows', mode, severity: 'major', answer: 'no' }]);
        assert.equal(recEv.warned, mode === 'warn' ? 1 : 0);
        assert.equal(recEv.blocking, mode === 'block' ? 1 : 0);
        // A second record has nothing pending.
        const again = await s.raw('verifiers', 'record', j.id);
        assert.equal(again.status, 1);
        assert.match(again.stderr + again.stdout, new RegExp(`job ${j.id} has no pending verifiers run in round 1`));
      } finally {
        s.cleanup();
      }
    }
  });

  test('a CHANGES record logs the failing verify run first, so a crash between the writes fails closed', async () => {
    const s = await scratch(BASE);
    try {
      s.verifiers({ 'help-rows.md': verifier('[lib/**]', 'mode: block\n') });
      const j = await s.job(WORK);
      await s.f('job', 'set', j.id, '--stage', 'verify', '--state', 'running');
      await s.f('verifiers', 'run', j.id);
      write(j.dir, 'verify/round-1-verifier-answers.md', '- help-rows: NO — lib/a.ts:2 bad\n');
      assert.equal((await s.f('verifiers', 'record', j.id)).outcome, 'CHANGES');
      const events = readEvents(s.root, j.id);
      const failRun = events.findIndex((e) => e.type === 'verify' && e.failure === 'verifiers');
      const record = events.findIndex((e) => e.type === 'verifiers' && e.phase === 'record');
      assert.ok(failRun >= 0 && failRun < record, 'the verify event precedes the record event');
      // Simulate a crash right after the failing run was appended: drop the record event.
      const file = path.join(j.dir, 'events.jsonl');
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.filter((l) => !(JSON.parse(l).type === 'verifiers' && JSON.parse(l).phase === 'record')).join('\n') + '\n');
      assert.equal((await s.f('job', 'step', j.id)).rule, 'V3b', 'the job goes back to build, never to review');
    } finally {
      s.cleanup();
    }
  });

  test('input and report writes replace a planted symlink instead of following it', async () => {
    const s = await scratch(BASE);
    const outside = path.join(s.root, '..', `outside-${path.basename(s.root)}`);
    try {
      s.verifiers({ 'help-rows.md': verifier('[lib/**]', 'mode: block\n') });
      const j = await s.job(WORK);
      fs.mkdirSync(outside);
      fs.mkdirSync(path.join(j.dir, 'verify'), { recursive: true });
      for (const name of ['round-1-verifiers-input.md', 'round-1-verifiers.md']) {
        fs.writeFileSync(path.join(outside, name), 'UNTOUCHED');
        fs.symlinkSync(path.join(outside, name), path.join(j.dir, 'verify', name));
      }
      // run renames an existing report aside first; plant the report link again after it.
      await s.f('verifiers', 'run', j.id);
      fs.symlinkSync(path.join(outside, 'round-1-verifiers.md'), path.join(j.dir, 'verify', 'round-1-verifiers.md'));
      write(j.dir, 'verify/round-1-verifier-answers.md', '- help-rows: YES\n');
      await s.f('verifiers', 'record', j.id);
      for (const name of ['round-1-verifiers-input.md', 'round-1-verifiers.md']) {
        assert.equal(fs.readFileSync(path.join(outside, name), 'utf8'), 'UNTOUCHED', `${name} was not written through the link`);
        assert.ok(!fs.lstatSync(path.join(j.dir, 'verify', name)).isSymbolicLink(), `${name} is a regular file now`);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      s.cleanup();
    }
  });

  test('stale answers never count', async () => {
    const s = await scratch(BASE);
    try {
      s.verifiers({ 'help-rows.md': verifier('[lib/**]', 'mode: block\n') });
      const j = await s.job(WORK);
      write(j.dir, 'verify/round-1-verifier-answers.md', '- help-rows: YES\n');
      await s.f('verifiers', 'run', j.id);
      assert.ok(!fs.existsSync(path.join(j.dir, 'verify', 'round-1-verifier-answers.md')), 'run deletes the stale answers');
      const rec = await s.f('verifiers', 'record', j.id);
      assert.equal(rec.outcome, 'CHANGES');
      assert.match(read(j.dir, 'verify/round-1-verifiers.md'), /^- \[major\] - — help-rows: Is the change fine\? · answer: no valid answer from the verifier model$/m);
      assert.equal(verifierEvents(s.root, j.id).at(-1)!.results[0].answer, 'none');
    } finally {
      s.cleanup();
    }
  });

  test('attempt files keep their own attempt numbers', async () => {
    const s = await scratch(BASE);
    try {
      s.verifiers({ 'help-rows.md': verifier('[lib/**]', 'mode: block\n') });
      const j = await s.job(WORK);
      await s.f('verifiers', 'run', j.id);
      write(j.dir, 'verify/round-1-verifier-answers.md', '- help-rows: NO — lib/a.ts:2 bad\n');
      assert.equal((await s.f('verifiers', 'record', j.id)).outcome, 'CHANGES');
      const firstReport = read(j.dir, 'verify/round-1-verifiers.md');
      // The builder's rework: verify again (attempt 3), then the verifiers again.
      const v = await s.f('verify', j.id);
      assert.equal(v.attempt, 3);
      assert.ok(fs.existsSync(path.join(j.dir, 'verify', 'round-1-attempt-1.md')), 'round-1.md was attempt 1');
      assert.ok(!fs.existsSync(path.join(j.dir, 'verify', 'round-1-attempt-2.md')), 'attempt 2 was the verifiers report');
      assert.match(read(j.dir, 'verify/round-1.md'), /attempt 3/);
      await s.f('verifiers', 'run', j.id);
      assert.equal(read(j.dir, 'verify/round-1-verifiers-attempt-1.md'), firstReport, 'the report checked attempt 1');
      assert.ok(!fs.existsSync(path.join(j.dir, 'verify', 'round-1-verifiers.md')));
    } finally {
      s.cleanup();
    }
  });

  // What list parses and which files are problems: test/verifiers.test.ts › "loadVerifiers: defaults and problems".
  test('list reports verifiers and problems', async () => {
    const s = await scratch();
    try {
      const empty = await s.f('verifiers', 'list');
      assert.deepEqual(empty, { dir: path.join('.forge', 'verifiers'), verifiers: [], problems: [] });
      s.verifiers({ 'help-rows.md': verifier('[lib/commands/**]', 'mode: block\n') });
      const list = await s.f('verifiers', 'list');
      assert.deepEqual(list.verifiers, [{ name: 'help-rows', paths: ['lib/commands/**'], severity: 'major', mode: 'block', question: 'Is the change fine?' }]);
      const { id } = await s.f('job', 'new', '--title', 'no verify');
      const run = await s.raw('verifiers', 'run', id);
      assert.equal(run.status, 1);
      assert.match(run.stderr + run.stdout, new RegExp(`job ${id} has no worktree yet`));
      await s.f('worktree', 'create', id);
      await s.f('job', 'round', id);
      const unverified = await s.raw('verifiers', 'run', id);
      assert.equal(unverified.status, 1);
      assert.match(unverified.stderr + unverified.stdout, new RegExp(`job ${id} has no passing verify in round 1; run: forge verify ${id}`));
      const help = await s.f('help', 'verifiers');
      for (const sub of ['list', 'run', 'record']) assert.match(help, new RegExp(`forge verifiers ${sub}`));
    } finally {
      s.cleanup();
    }
  });
});
