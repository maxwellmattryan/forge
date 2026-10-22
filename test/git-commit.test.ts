import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { TRUST_ENV, loadConfig, trustDigest } from '../lib/core/config/load.ts';
import { gitWrite, parseGitWriteArgs, resolveWorktreePaths } from '../lib/cli/commands/git.ts';
import { jobDir, setJob } from '../lib/core/job/store.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const HUMAN = { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined, FORGE_AI_ATTRIBUTION: undefined };

/**
 * A scratch repo with Forge initialised and committed, one job and its worktree (in a sibling
 * dir, removed on cleanup). `cli` runs bin/forge from the main checkout.
 */
function setup() {
  const repo = tempRepo();
  const root = repo.dir;
  const wtRoot = `${root}.wt`;
  const answers = path.join(os.tmpdir(), `answers-git-${path.basename(root)}.json`);
  const cli = (env, ...args) => {
    const full = { ...process.env, FORGE_ROOT: root, GIT_EDITOR: 'true', ...HUMAN, ...env };
    for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
    try {
      const out = execFileSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: full });
      return { ok: true, code: 0, out: out.trim(), json: () => JSON.parse(out) };
    } catch (e) {
      return { ok: false, code: e.status, out: `${e.stdout}${e.stderr}`, json: () => (e.stdout ? JSON.parse(e.stdout) : null) };
    }
  };
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: `../${path.basename(root)}.wt` } }));
  assert.equal(cli({}, 'init', 'write', '--answers', answers).ok, true);
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'forge');
  const newJob = (title) => {
    const id = cli({}, 'job', 'new', '--title', title).json().id;
    const wt = cli({}, 'worktree', 'create', id).json().path;
    return { id, wt, git: (...a) => execFileSync('git', a, { cwd: wt, encoding: 'utf8', stdio: 'pipe' }).trim() };
  };
  const mainState = () => ({ head: repo.git('rev-parse', 'HEAD').toString().trim(), staged: repo.git('diff', '--cached', '--name-only').toString().trim() });
  return {
    root,
    cli,
    newJob,
    mainState,
    git: repo.git,
    config: () => loadConfig(root).config,
    cleanup: () => {
      repo.cleanup();
      fs.rmSync(wtRoot, { recursive: true, force: true });
      fs.rmSync(answers, { force: true });
    },
  };
}

test('commits land in the job worktree, not main', () => {
  const s = setup();
  try {
    const job = s.newJob('Commit here');
    const before = s.mainState();
    fs.writeFileSync(path.join(job.wt, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(job.wt, 'b.txt'), 'b\n');
    const r = s.cli({}, 'git', 'commit', job.id, '--message', 'feat: x', '--', 'a.txt');
    assert.equal(r.ok, true, r.out);
    const out = r.json();
    assert.deepEqual(Object.keys(out).sort(), ['branch', 'files', 'id', 'sha']);
    assert.match(out.sha, /^[0-9a-f]{40}$/);
    assert.equal(out.branch, job.git('symbolic-ref', '--short', 'HEAD'));
    assert.deepEqual(out.files, ['a.txt'], 'only the named path is committed');
    assert.equal(job.git('rev-parse', 'HEAD'), out.sha);
    assert.equal(job.git('log', '-1', '--format=%s'), 'feat: x');
    assert.equal(job.git('status', '--porcelain'), '?? b.txt');
    assert.deepEqual(s.mainState(), before, "main's HEAD and index are unchanged");

    // With no paths, every change is committed, deletions included.
    fs.rmSync(path.join(job.wt, 'README.md'));
    const all = s.cli({}, 'git', 'commit', job.id, '--message=fix: rest\n\nwith a body').json();
    assert.deepEqual(all.files.sort(), ['README.md', 'b.txt']);
    assert.equal(job.git('log', '-1', '--format=%B'), 'fix: rest\n\nwith a body');
    assert.equal(job.git('status', '--porcelain'), '');
    assert.deepEqual(s.mainState(), before);
    assert.deepEqual(fs.readdirSync(jobDir(s.root, job.id)).filter((f) => f.startsWith('.commit-msg')), [], 'the temp message file is removed');

    const empty = s.cli({}, 'git', 'commit', job.id, '--message', 'chore: nothing');
    assert.equal(empty.code, 1);
    assert.match(empty.out, /nothing to commit in /);
  } finally {
    s.cleanup();
  }
});

test('refuses unsafe options and message sources', () => {
  const s = setup();
  try {
    const job = s.newJob('Refusals');
    fs.writeFileSync(path.join(job.wt, 'a.txt'), 'a\n');
    const head = job.git('rev-parse', 'HEAD');
    const outside = path.join(os.tmpdir(), `msg-${path.basename(s.root)}.txt`);
    fs.writeFileSync(outside, 'feat: outside\n');
    try {
      const refused = [
        [['--message-file', outside], /must be inside the job dir/],
        [['--message', 'a', '--message-file', path.join(jobDir(s.root, job.id), 'request.md')], /exactly one of --message or --message-file/],
        [['--message', 'a', '--message', 'b'], /exactly one of/],
        [[], /exactly one of/],
        [['--message', '  \n'], /message is empty/],
        [['-c', 'core.hooksPath=/tmp', '--message', 'x'], /refuses "-c"/],
        [['--message', 'x', '--no-verify'], /refuses "--no-verify"/],
        [['--amend', '--message', 'x'], /refuses "--amend"/],
        [['-C', '/tmp', '--message', 'x'], /refuses "-C"/],
        [['--git-dir=/tmp/x', '--message', 'x'], /refuses "--git-dir=\/tmp\/x"/],
        [['--work-tree', '/tmp', '--message', 'x'], /refuses "--work-tree"/],
        [['-m', 'x'], /refuses "-m"/],
        [['--author', 'x <x@y>', '--message', 'x'], /refuses "--author"/],
        [['--message', 'x', 'a.txt'], /paths go after --/],
      ];
      for (const [args, re] of refused) {
        const r = s.cli({}, 'git', 'commit', job.id, ...(args as string[]));
        assert.equal(r.code, 1, `${(args as string[]).join(' ')}: ${r.out}`);
        assert.match(r.out, re as RegExp, (args as string[]).join(' '));
        assert.equal(job.git('rev-parse', 'HEAD'), head, 'nothing committed');
        assert.equal(job.git('diff', '--cached', '--name-only'), '', 'nothing staged');
      }
    } finally {
      fs.rmSync(outside, { force: true });
    }
    // A message file in the job dir works, as an absolute path or relative to the cwd.
    const msg = path.join(jobDir(s.root, job.id), 'commit-msg.txt');
    fs.writeFileSync(msg, 'feat: from file\n\nbody line\n');
    const ok = s.cli({}, 'git', 'commit', job.id, '--message-file', path.relative(s.root, msg));
    assert.equal(ok.ok, true, ok.out);
    assert.equal(job.git('log', '-1', '--format=%B'), 'feat: from file\n\nbody line');
  } finally {
    s.cleanup();
  }
});

test('refuses wrong targets', () => {
  const s = setup();
  try {
    const job = s.newJob('Targets');
    const bare = s.cli({}, 'job', 'new', '--title', 'No worktree').json().id;
    fs.writeFileSync(path.join(job.wt, 'a.txt'), 'a\n');
    const head = job.git('rev-parse', 'HEAD');
    const commit = (id, ...extra) => s.cli({}, 'git', 'commit', id, '--message', 'feat: x', ...extra);
    const expectRefused = (r, re) => {
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, re);
      assert.equal(job.git('rev-parse', 'HEAD'), head);
      assert.equal(job.git('diff', '--cached', '--name-only'), '');
    };

    expectRefused(commit(bare), /has no worktree/);
    expectRefused(s.cli({}, 'git', 'add', bare, '--', 'a.txt'), /has no worktree/);
    for (const p of ['../outside.txt', path.join(os.tmpdir(), 'x.txt'), '.git/config', '.GIT/hooks/pre-commit', 'sub/../../x']) expectRefused(commit(job.id, '--', p), /outside the job's worktree|inside \.git/);
    // A directory symlink inside the worktree can't lead outside it.
    fs.symlinkSync(os.tmpdir(), path.join(job.wt, 'tmp-link'));
    expectRefused(commit(job.id, '--', 'tmp-link/x.txt'), /outside the job's worktree/);
    fs.rmSync(path.join(job.wt, 'tmp-link'));

    const branch = job.git('symbolic-ref', '--short', 'HEAD');
    job.git('checkout', '-q', '-b', 'other');
    expectRefused(commit(job.id), /on other, not the job's branch/);
    job.git('checkout', '-q', '--detach');
    expectRefused(commit(job.id), /a detached HEAD/);
    job.git('checkout', '-q', branch);

    const before = s.mainState();
    setJob(s.root, job.id, { owned: { worktree: s.root } });
    expectRefused(commit(job.id), /refuses to commit in the main checkout/);
    fs.mkdirSync(path.join(s.root, 'nested'));
    setJob(s.root, job.id, { owned: { worktree: path.join(s.root, 'nested') } });
    expectRefused(commit(job.id), /refuses to commit in the main checkout/);
    assert.deepEqual(s.mainState(), before);
    setJob(s.root, job.id, { owned: { worktree: job.wt } });

    // A merge in progress points at forge integrate --continue.
    job.git('checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(job.wt, 'README.md'), '# side\n');
    job.git('commit', '-qam', 'side');
    job.git('checkout', '-q', branch);
    fs.writeFileSync(path.join(job.wt, 'README.md'), '# ours\n');
    job.git('commit', '-qam', 'ours');
    assert.throws(() => job.git('merge', '-q', 'side'));
    const merging = commit(job.id);
    assert.equal(merging.code, 1);
    assert.match(merging.out, new RegExp(`merge or rebase is in progress.*forge integrate ${job.id} --continue`, 's'));
  } finally {
    s.cleanup();
  }
});

test('attribution is refused', () => {
  const s = setup();
  try {
    const job = s.newJob('Attribution');
    fs.writeFileSync(path.join(job.wt, 'a.txt'), 'a\n');
    const head = job.git('rev-parse', 'HEAD');
    const message = 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
    const r = s.cli({}, 'git', 'commit', job.id, '--message', message);
    assert.equal(r.code, 1);
    assert.match(r.out, /AI attribution is not allowed/);
    assert.match(r.out, / {2}- Co-Authored-By: Claude <noreply@anthropic\.com>/);
    assert.equal(job.git('rev-parse', 'HEAD'), head);
    assert.equal(job.git('diff', '--cached', '--name-only'), '');

    const allowed = gitWrite(s.root, { ...s.config(), aiAttribution: 'allow' }, ['commit', job.id, '--message', message], { ...process.env, FORGE_AI_ATTRIBUTION: undefined, FORGE_DAEMON: undefined });
    assert.ok('sha' in allowed);
    assert.match(job.git('log', '-1', '--format=%B'), /Co-Authored-By: Claude/);
  } finally {
    s.cleanup();
  }
});

test('hooks are pinned off only in the daemon', () => {
  const s = setup();
  try {
    const job = s.newJob('Hooks');
    const marker = path.join(os.tmpdir(), `hook-ran-${path.basename(s.root)}`);
    const hooks = path.resolve(job.wt, job.git('rev-parse', '--git-path', 'hooks'));
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    try {
      const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(s.root), FORGE_DAEMON_SCOPE: job.id };
      fs.writeFileSync(path.join(job.wt, 'a.txt'), 'a\n');
      const daemon = s.cli(trust, 'git', 'commit', job.id, '--message', 'feat: daemon');
      assert.equal(daemon.ok, true, daemon.out);
      assert.equal(fs.existsSync(marker), false, 'the daemon pins core.hooksPath off');

      fs.writeFileSync(path.join(job.wt, 'b.txt'), 'b\n');
      assert.equal(s.cli({}, 'git', 'commit', job.id, '--message', 'feat: human').ok, true);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'ran\n', "a human's hooks run as for a plain git commit");
    } finally {
      fs.rmSync(marker, { force: true });
    }
  } finally {
    s.cleanup();
  }
});

test('integrator stages through forge git add', () => {
  const s = setup();
  try {
    const job = s.newJob('Integrate');
    fs.writeFileSync(path.join(job.wt, 'README.md'), '# ours\n');
    assert.equal(s.cli({}, 'git', 'commit', job.id, '--message', 'ours').ok, true);
    fs.writeFileSync(path.join(s.root, 'README.md'), '# theirs\n');
    s.git('commit', '-qam', 'theirs');

    const conflicted = s.cli({}, 'integrate', job.id, '--strategy', 'merge', '--keep-conflicts');
    assert.equal(conflicted.code, 1);
    assert.deepEqual(conflicted.json().conflicts, ['README.md']);
    fs.writeFileSync(path.join(job.wt, 'README.md'), '# both\n');
    const staged = s.cli({}, 'git', 'add', job.id, '--', 'README.md');
    assert.equal(staged.ok, true, staged.out);
    assert.deepEqual(staged.json(), { id: job.id, staged: ['README.md'] });
    const done = s.cli({}, 'integrate', job.id, '--continue');
    assert.equal(done.ok, true, done.out);
    assert.equal(done.json().ok, true);
    assert.equal(fs.readFileSync(path.join(job.wt, 'README.md'), 'utf8'), '# both\n');

    for (const [args, re] of [
      [[], /needs at least one path/],
      [['--message', 'x', '--', 'a'], /takes only -- and paths/],
      [['-f', '--', 'a'], /refuses "-f"/],
      [['--', '../x'], /outside the job's worktree/],
    ]) {
      const r = s.cli({}, 'git', 'add', job.id, ...(args as string[]));
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, re as RegExp);
    }
  } finally {
    s.cleanup();
  }
});

test('argument and path helpers', () => {
  assert.deepEqual(parseGitWriteArgs(['--message', 'a b', '--', '-x', 'y']), { message: 'a b', messageFile: null, paths: ['-x', 'y'] });
  assert.deepEqual(parseGitWriteArgs(['--message-file=m.txt']), { message: null, messageFile: 'm.txt', paths: [] });
  assert.throws(() => parseGitWriteArgs(['--message']), /needs a value/);
  assert.throws(() => parseGitWriteArgs(['--messages', 'x']), /refuses/);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-paths-')));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    assert.deepEqual(resolveWorktreePaths(dir, ['src/a.ts', path.join(dir, 'b'), '.', 'new/dir/c']), ['src/a.ts', 'b', '.', 'new/dir/c']);
    // A link as the entry itself is staged as a link, so its target doesn't matter.
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link'));
    assert.deepEqual(resolveWorktreePaths(dir, ['link']), ['link']);
    assert.throws(() => resolveWorktreePaths(dir, ['src/.git/x']), /inside \.git/);
    assert.throws(() => resolveWorktreePaths(dir, ['..']), /outside/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
