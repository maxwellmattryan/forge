// Role outputs the CLI writes for the next role: verify's `Failing:` list for a rework builder, and
// the round diff `forge job scope` writes for reviewers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, tempRepo } from '../../helpers.ts';

const commitAll = (cwd: string, msg: string) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};

test('verify names failing tests and scope writes the round diff', async () => {
  const repo = tempRepo();
  const name = path.basename(repo.dir);
  const answers = path.join(repo.dir, '..', `answers-${name}.json`);
  const outside = path.join(repo.dir, '..', `outside-${name}`);
  const raw = (...args: string[]) => forgeAsync(repo.dir, args);
  const f = async (...args: string[]) => {
    const r = await raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  try {
    // The suite exports NODE_TEST_CONTEXT; an inner `node --test` that inherits it prints the child protocol.
    fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'env -u NODE_TEST_CONTEXT node --test t.test.mjs' }, verify: ['test'], worktrees: { root: `../${name}.wt` } }));
    await f('init', 'write', '--answers', answers, '--force');
    commitAll(repo.dir, 'forge init');
    const job = await f('job', 'new', '--title', 'round diff');
    const wt: string = (await f('worktree', 'create', job.id)).path;
    fs.writeFileSync(path.join(wt, 't.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds up', () => {\n  assert.strictEqual(1 + 1, 3);\n});\n");
    // Neither attributes nor worktree config may reshape the round diff.
    fs.writeFileSync(path.join(wt, '.gitattributes'), '* -diff\n');
    commitAll(wt, 'a failing test');
    execFileSync('git', ['config', 'diff.noprefix', 'true'], { cwd: wt });
    await f('job', 'round', job.id);
    const dir = path.join(repo.dir, '.forge', 'jobs', job.id);
    fs.writeFileSync(path.join(dir, 'spec.md'), '# Round diff\n\n## Approach\nAdd `t.test.mjs`.\n');
    fs.writeFileSync(path.join(dir, 'scope.diff'), 'stale\n');

    const v = await raw('verify', job.id);
    assert.equal(v.status, 1, v.stderr);
    const report = fs.readFileSync(path.join(dir, 'verify', 'round-1.md'), 'utf8').split('\n');
    const after = report.slice(report.findIndex((l) => l.startsWith('Round 1 · ')) + 1).filter((l) => l.trim());
    assert.equal(after[0], 'Failing:', report.join('\n'));
    assert.match(after[1], /^- test · t\.test\.mjs:4 · adds up · .*Expected values to be strictly equal:$/);
    const section = report.findIndex((l) => l.startsWith('## test: FAILED'));
    assert.ok(section > report.indexOf('Failing:'), report.join('\n'));
    assert.ok(report.slice(section).includes('```'), 'the log tail still follows');

    const scope = await f('job', 'scope', job.id);
    assert.equal(scope.patch, path.join('review', 'round-1', 'diff.patch'));
    assert.ok(!fs.existsSync(path.join(dir, 'scope.diff')));
    const patch = fs.readFileSync(path.join(dir, scope.patch), 'utf8');
    const firstDiff = patch.indexOf('diff --git ');
    assert.ok(patch.startsWith('# repo root base '), patch);
    assert.match(patch.slice(0, firstDiff), /\n t\.test\.mjs +\| 5 \+{5}\n/);
    assert.ok(patch.includes('diff --git a/t.test.mjs b/t.test.mjs\n'), patch);
    assert.ok(patch.includes("+test('adds up', () => {\n"), patch);
    assert.ok(!patch.includes('Binary files'), patch);

    // A link planted at verify/ (a junction on Windows) fails verify and writes nothing through it.
    fs.mkdirSync(outside);
    fs.rmSync(path.join(dir, 'verify'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(dir, 'verify'), 'junction');
    const linked = await raw('verify', job.id);
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr + linked.stdout, /not a real directory/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing is written in the link target');
  } finally {
    repo.cleanup();
    fs.rmSync(path.join(repo.dir, '..', `${name}.wt`), { recursive: true, force: true });
    fs.rmSync(answers, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
