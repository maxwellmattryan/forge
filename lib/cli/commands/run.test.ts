// `forge run <job> <command> --changed` in-process against a scratch repo: what the command receives in
// each mode (files, full, none), and the refusals that leave no log, no `command` event and nothing run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, cliEnv, forgeInProcess, jobAt, repoTemplate } from '../../../test/helpers.ts';
import { jobDir, loadJob, readEvents } from '#core/job/store.ts';

// Records its arguments in the main checkout's .git, outside the worktree, so the record is never a change.
const RECORD = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))" "{root}/.git/args.json" {args}`;

const template = repoTemplate((dir) => {
  for (const p of ['lib/mod.ts', 'lib/mod.test.ts', 'lib/other.test.ts', 'test/helpers.ts', 'docs/x.md']) {
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), `${p}\n`);
  }
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: RECORD, plain: 'true' }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: cliEnv(dir), stdio: 'pipe' });
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

/** A copy of the template with one job and its worktree, removed after the test. */
async function scratch(t: { after: (fn: () => void) => void }) {
  const repo = template();
  t.after(() => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  });
  const root = repo.dir;
  const { id } = jobAt(root, 'build');
  const wt = await forgeInProcess(root, ['worktree', 'create', id]);
  assert.equal(wt.status, 0, JSON.stringify(wt.error));
  const worktree = loadJob(root, id).worktree!;
  const logs = () => (fs.existsSync(path.join(jobDir(root, id), 'logs')) ? fs.readdirSync(path.join(jobDir(root, id), 'logs')) : []);
  const commands = () => readEvents(root, id).filter((e) => e.type === 'command');
  const recorded = (): string[] | null => {
    const f = path.join(root, '.git', 'args.json');
    if (!fs.existsSync(f)) return null;
    const args = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.rmSync(f);
    return args;
  };
  const edit = (p: string) => {
    fs.mkdirSync(path.dirname(path.join(worktree, p)), { recursive: true });
    fs.appendFileSync(path.join(worktree, p), 'edited\n');
  };
  return { root, id, worktree, logs, commands, recorded, edit };
}

test('forge run --changed runs only the related tests', async (t) => {
  const s = await scratch(t);

  // none: nothing related, so nothing runs and nothing is recorded.
  s.edit('docs/x.md');
  const none = await forgeInProcess(s.root, ['run', s.id, 'test', '--changed']);
  assert.equal(none.status, 0, JSON.stringify(none.error));
  assert.deepEqual(none.data, { name: 'test', ok: true, ran: false, related: { mode: 'none', files: [], changed: 1 } });
  assert.equal(s.recorded(), null);
  assert.deepEqual(s.logs(), []);
  assert.deepEqual(s.commands(), []);

  // files: the command gets exactly the related tests, shell metacharacters kept literal.
  s.edit('lib/mod.ts');
  const odd = 'lib/a b;$(touch pwned)`x`.test.ts';
  s.edit(odd);
  const files = await forgeInProcess(s.root, ['run', s.id, 'test', '--changed']);
  assert.equal(files.status, 0, JSON.stringify(files.error));
  const fd = files.data as any;
  assert.deepEqual(fd.related, { mode: 'files', files: [odd, 'lib/mod.test.ts'], changed: 3 });
  assert.deepEqual(s.recorded(), [odd, 'lib/mod.test.ts']);
  assert.equal(fs.existsSync(path.join(s.worktree, 'lib', 'pwned')) || fs.existsSync(path.join(s.worktree, 'pwned')), false);
  assert.equal(fd.ok, true);
  assert.equal(fd.exit, 0);
  assert.equal(typeof fd.log, 'string');
  assert.equal(s.commands().length, 1);

  // full: a shared helper under test/ changed, so the command runs with no arguments.
  s.edit('test/helpers.ts');
  const full = await forgeInProcess(s.root, ['run', s.id, 'test', '--changed']);
  assert.equal(full.status, 0, JSON.stringify(full.error));
  assert.deepEqual((full.data as any).related, { mode: 'full', files: [], changed: 4, trigger: 'test/helpers.ts' });
  assert.deepEqual(s.recorded(), []);
  assert.equal(s.commands().length, 2);
});

test('forge run --changed refusals', async (t) => {
  const s = await scratch(t);
  s.edit('lib/mod.ts');
  const rows: [string, string[], RegExp][] = [
    ['with -- args', ['test', '--changed', '--', 'x'], /--changed takes no -- <args…>/],
    ['with --background', ['test', '--changed', '--background'], /--changed takes no --background/],
    ['with --repo', ['test', '--changed', '--repo', 'm'], /--changed takes no --repo/],
    ['with a value', ['test', '--changed=1'], /--changed takes no value/],
    ['with a word after it', ['test', '--changed', 'extra'], /takes extra arguments only after --/],
    ['on a template without {args}', ['plain', '--changed'], /commands\.plain takes no arguments; put \{args\} in the template/],
  ];
  for (const [name, args, want] of rows) {
    const r = await forgeInProcess(s.root, ['run', s.id, ...args]);
    assert.equal(r.status, 1, name);
    assert.match(r.error?.message ?? '', want, name);
  }
  assert.equal(s.recorded(), null);
  assert.deepEqual(s.logs(), []);
  assert.deepEqual(s.commands(), []);
});
