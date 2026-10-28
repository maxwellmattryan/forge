// `forge pr open` over a linked job (root `app`, member `lib`): the held push reads every repo's
// commit scan, so a secret the member's scan only reported under `verifySecrets: warn` stops the push
// in both repos until a person approves it. In-process, over the memory GitHub and scratch repos.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { memoryGitHub } from '../../helpers.ts';
import { twoRepo } from '../../job-repos-fixture.ts';
import { loadConfig } from '#core/config/load.ts';
import { logEvent, readEvents } from '#core/job/store.ts';
import { openPr } from '#engine/pr/open.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

test("a member repo's reported secret holds the push in every repo", async () => {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  const job = await p.f('job', 'new', '--title', 'two repos');
  const id = job.id as string;
  await p.f('job', 'repo', 'add', id, 'lib');
  await p.f('worktree', 'create', id);
  // Built at run time, so no literal token sits in the repo.
  const token = `gh${'p'}_${randomBytes(18).toString('hex')}`;
  p.commit(path.join(p.parent, 'app.worktrees', id), { 'app.txt': 'app\n' }, 'feat: app');
  p.commit(path.join(p.parent, 'lib.worktrees', id), { 'lib.txt': `token = ${token}\n` }, 'feat: lib');
  const { config } = loadConfig(p.root);
  config.verifySecrets = 'warn';
  const github = memoryGitHub({ slug: 'o/app' });
  const open = () => openPr(p.root, config, github, id, { force: true });
  const heads = (bare: string) => p.git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').trim();
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return undefined;
  };

  assert.equal(code(open), 'push_held');
  assert.deepEqual([heads(p.rootBare), heads(p.libBare)], ['main', 'main'], 'no branch reached either remote');
  assert.equal(github.calls.filter((c) => c.op === 'create').length, 0, 'no create call');
  const held = readEvents(p.root, id).filter((e) => e.type === 'push-held').at(-1)!;
  assert.equal(held.kind, 'secrets');
  assert.match(String(held.reason), /^push held: the secret scan reported 1 possible secrets \[fp [0-9a-f]{16}\]$/);

  // A person's approve at exactly that reason pushes both repos.
  logEvent(p.root, id, 'transition', { from: { stage: 'pr', state: 'running', waitingOn: null }, to: { stage: 'pr', state: 'waiting', waitingOn: 'human' }, reason: held.reason });
  logEvent(p.root, id, 'human', { action: 'approve', actor: { login: 'al', source: 'env' } });
  const r = open();
  assert.ok(r.created && r.repos?.length === 1, JSON.stringify(r));
  assert.deepEqual([heads(p.rootBare).includes(`forge/${id}`), heads(p.libBare).includes(`forge/${id}`)], [true, true]);
});
