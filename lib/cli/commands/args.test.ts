// --body-file under the daemon: a job session's agents may publish only files from the session job's
// folder or its computed worktree, read capped, so a local secret never reaches a tracker comment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgeSync, tempRepo } from '../../../test/helpers.ts';
import { defaults, worktreeRoot } from '#core/config/load.ts';
import { trustDigest } from '#core/config/trust.ts';
import { createJob, readEvents } from '#core/job/store.ts';
import { jobDir } from '#core/paths.ts';
import { bodyFrom } from './args.ts';

function scratch(t: any) {
  const repo = tempRepo();
  const config = defaults();
  const wtRoot = worktreeRoot(repo.dir, config);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
  t.after(() => {
    repo.cleanup();
    fs.rmSync(wtRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'a local secret\n');
  return { root: repo.dir, config, wtRoot, outside, secret };
}

test('--body-file under the daemon reads only the session job\'s folder or worktree', (t) => {
  const { root, config, wtRoot, outside, secret } = scratch(t);
  const id = createJob(root, config, { title: 'session job' }).id;
  const other = createJob(root, config, { title: 'other job' }).id;
  const env = { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: id };
  const body = (file: string, e: NodeJS.ProcessEnv = env) => bodyFrom({ 'body-file': file }, root, config, e);

  const folder = jobDir(root, id);
  fs.writeFileSync(path.join(folder, 'comment.md'), 'from the job folder\n');
  const wt = path.join(wtRoot, id);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'comment.md'), 'from the worktree\n');
  assert.equal(body(path.join(folder, 'comment.md')), 'from the job folder\n');
  assert.equal(body(path.join(wt, 'comment.md')), 'from the worktree\n');

  fs.writeFileSync(path.join(jobDir(root, other), 'request.md'), 'the other job\n');
  const sibling = jobDir(root, `${id}x`);
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'comment.md'), 'a planted sibling\n');
  const refused: [string, string, NodeJS.ProcessEnv?][] = [
    ['a file outside both', secret],
    ["another job's folder through ..", `${folder}${path.sep}..${path.sep}${other}${path.sep}request.md`],
    ['a sibling that shares the prefix', path.join(sibling, 'comment.md')],
    ['a job-folder file in the inbox session', path.join(folder, 'comment.md'), { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_inbox' }],
    ['a job-folder file in an office run', path.join(folder, 'comment.md'), { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_office' }],
    ['no session scope', path.join(folder, 'comment.md'), { FORGE_DAEMON: '1' }],
    ['a missing file', path.join(folder, 'nope.md')],
  ];
  try {
    fs.symlinkSync(secret, path.join(folder, 'linked.md'));
    refused.push(['a link in the job folder to an outside file', path.join(folder, 'linked.md')]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
  }
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [path.join(folder, 'fifo.md')]);
    refused.push(['a FIFO in the job folder', path.join(folder, 'fifo.md')]);
  }
  for (const [name, file, e] of refused) assert.throws(() => body(file, e), (err: any) => err.exitCode === 1, name);
  assert.throws(() => body(secret), /must name a file inside job .*\(got ".*secret\.txt"\)/);
  assert.throws(() => body(path.join(folder, 'comment.md'), { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_inbox' }), /in the _inbox daemon session reads only stdin/);

  assert.equal(body(secret, {}), 'a local secret\n', 'outside the daemon nothing changes');
  assert.equal(fs.readdirSync(outside).length, 1);
});

test('--body-file - still reads stdin under the daemon; an outside file exits 1', (t) => {
  const { root, config, outside, secret } = scratch(t);
  const answers = path.join(outside, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' } }));
  assert.equal(forgeSync(root, ['init', 'write', '--answers', answers]).status, 0);
  const id = createJob(root, config, { title: 'noted' }).id;
  const env = { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: id, FORGE_DAEMON_TRUST: trustDigest(root) };
  const notes = () => readEvents(root, id).filter((e) => e.type === 'note').map((e) => (e as { text?: string }).text);

  const ok = forgeSync(root, ['job', 'note', id, '--body-file', '-'], env, { input: 'from stdin' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(notes(), ['from stdin']);

  const bad = forgeSync(root, ['job', 'note', id, '--body-file', secret], env);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr + bad.stdout, /must name a file inside job/);
  assert.deepEqual(notes(), ['from stdin'], 'no note was logged');
});
