// `forge job new --base` in-process against a scratch repo: a feature base that is a branch on the
// remote is stamped and followed by the worktree, git.base needs no remote, and every base Forge
// can't trust is refused before a job dir exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, addOrigin, cliEnv, editConfigFile, forgeInProcess, repoTemplate } from '../../../../test/helpers.ts';
import { loadJob } from '#core/job/store.ts';
import { INBOX_SCOPE, SCOPE_ENV } from '#core/job/requests.ts';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: cliEnv(dir), stdio: 'pipe' });
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

/** A template copy, removed with its worktrees after the test. */
function scratch(t: { after: (fn: () => void) => void }) {
  const repo = template();
  t.after(() => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  });
  return repo;
}

/** origin with `feature/x` one commit past main, tag `v1`, and the unpushed branch `local-only`. */
function withFeatureBranch(repo: ReturnType<typeof template>): string {
  addOrigin(repo);
  repo.git('checkout', '-q', '-b', 'tmp');
  repo.git('commit', '-q', '--allow-empty', '-m', 'feature work');
  repo.git('push', '-q', 'origin', 'tmp:feature/x');
  const sha = repo.git('rev-parse', 'HEAD').toString().trim();
  repo.git('checkout', '-q', 'main');
  repo.git('branch', '-q', '-D', 'tmp');
  repo.git('tag', 'v1');
  repo.git('push', '-q', 'origin', 'v1');
  repo.git('branch', 'local-only');
  return sha;
}

type Created = { id: string; base: string };

const jobDirs = (root: string) => (fs.existsSync(path.join(root, '.forge', 'jobs')) ? fs.readdirSync(path.join(root, '.forge', 'jobs')).sort() : []);

test('job new --base stamps a base that exists on the remote', async (t) => {
  const repo = scratch(t);
  const root = repo.dir;
  const featureSha = withFeatureBranch(repo);

  const r = await forgeInProcess(root, ['job', 'new', '--title', 'T', '--base', 'feature/x']);
  assert.equal(r.status, 0, JSON.stringify(r.error));
  const { id, base } = r.data as Created;
  assert.equal(base, 'feature/x');
  const job = loadJob(root, id);
  assert.equal(job.base, 'feature/x');
  assert.equal(job.repos[0].base, 'feature/x');

  // AC2: the worktree starts at origin/feature/x, not main.
  const w = await forgeInProcess(root, ['worktree', 'create', id]);
  assert.equal(w.status, 0, JSON.stringify(w.error));
  const wt = loadJob(root, id).worktree!;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(root, wt), encoding: 'utf8' }).trim();
  assert.equal(head, featureSha);
  assert.notEqual(head, repo.git('rev-parse', 'main').toString().trim());

  // AC3: the base stays locked, and the refusal names job new --base.
  const s = await forgeInProcess(root, ['job', 'set', id, '--field', 'base=main']);
  assert.equal(s.status, 1);
  assert.match(s.error!.message, /forge job new --base/);
  assert.equal(loadJob(root, id).base, 'feature/x');
});

test('job new without a feature base needs no remote', async (t) => {
  const root = scratch(t).dir;
  for (const args of [[], ['--base', 'main']]) {
    const r = await forgeInProcess(root, ['job', 'new', '--title', 'T', ...args]);
    assert.equal(r.status, 0, `${args.join(' ')}: ${JSON.stringify(r.error)}`);
    const { id, base } = r.data as Created;
    assert.equal(base, 'main');
    assert.equal(loadJob(root, id).base, 'main');
  }
});

test("job new refuses a --base it can't trust", async (t) => {
  const repo = scratch(t);
  const root = repo.dir;
  withFeatureBranch(repo);
  repo.git('remote', 'add', 'gone', path.join(root, 'no-such-remote.git'));
  const daemon = { FORGE_DAEMON: '1', [SCOPE_ENV]: INBOX_SCOPE };
  const rows: { name: string; args: string[]; exit: number; code?: string; match?: RegExp; notMatch?: RegExp; remote?: string; env?: NodeJS.ProcessEnv }[] = [
    { name: 'leading dash', args: ['--base=-x'], exit: 1, match: /not a safe branch name/ },
    { name: 'option smuggled', args: ['--base=--upload-pack=x'], exit: 1, match: /not a safe branch name/ },
    { name: 'space', args: ['--base', 'a b'], exit: 1, match: /not a safe branch name/ },
    { name: 'bare flag', args: ['--base'], exit: 2, code: 'usage' },
    { name: 'not on origin', args: ['--base', 'feature/missing'], exit: 1, match: /not a branch on origin; push it first \(git push origin feature\/missing\)/ },
    { name: 'local only', args: ['--base', 'local-only'], exit: 1, match: /not a branch on origin/ },
    { name: 'tag only', args: ['--base', 'v1'], exit: 1, match: /not a branch on origin/ },
    { name: 'equal to --branch', args: ['--base', 'feature/x', '--branch', 'feature/x'], exit: 1, match: /can't target its own branch/ },
    { name: 'unsafe git.remote', args: ['--base', 'feature/x'], remote: '-x', exit: 1, match: /git\.remote "-x" is not a safe branch name/ },
    { name: 'unreachable remote', args: ['--base', 'feature/x'], remote: 'gone', exit: 5, code: 'external', match: /can't read branches on gone/, notMatch: /fatal|no-such-remote/ },
    { name: 'daemon, feature base', args: ['--base', 'feature/x'], env: daemon, exit: 1, match: /a human runs it in their own session/ },
    { name: 'daemon, git.base', args: ['--base', 'main'], env: daemon, exit: 1, match: /a human runs it in their own session/ },
  ];
  for (const row of rows) {
    editConfigFile(root, (c) => {
      c.git.remote = row.remote ?? 'origin';
    });
    const before = jobDirs(root);
    const r = await forgeInProcess(root, ['job', 'new', '--title', 'T', ...row.args], { env: row.env });
    assert.equal(r.status, row.exit, `${row.name}: ${JSON.stringify(r.error ?? r.data)}`);
    if (row.code) assert.equal(r.error!.code, row.code, row.name);
    if (row.match) assert.match(r.error!.message, row.match, row.name);
    if (row.notMatch) assert.doesNotMatch(r.error!.message, row.notMatch, row.name);
    assert.deepEqual(jobDirs(root), before, `${row.name}: no job dir`);
  }
});
