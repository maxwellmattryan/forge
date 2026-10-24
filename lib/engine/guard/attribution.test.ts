import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { tempRepo } from '../../../test/helpers.ts';
import { commandAttribution, hasAttribution, repoAllowsAttribution, stripAttribution, scrubBranch } from './attribution.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';

const HOOK = path.resolve(import.meta.dirname, '..', '..', '..', 'hooks', 'no-ai-attribution.ts');

test('finds and strips AI signatures but not mere mentions', () => {
  const msg = 'feat: add toggle\n\nParses Claude Code transcripts for usage.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n';
  assert.equal(hasAttribution(msg), true);
  assert.equal(stripAttribution(msg), 'feat: add toggle\n\nParses Claude Code transcripts for usage.\n');
  assert.equal(hasAttribution('🤖 Generated with [Claude Code](https://claude.com/claude-code)'), true);
  assert.equal(hasAttribution('Co-authored-by: GitHub Copilot <copilot@github.com>'), true);
  assert.equal(hasAttribution('Claude-Session: https://claude.ai/code/session_123'), true);
  assert.equal(hasAttribution('fix(usage): read Claude Code subagent transcripts'), false);
  assert.equal(hasAttribution('Co-Authored-By: Jane Doe <jane@example.com>'), false);
  assert.equal(hasAttribution('docs: compare OpenAI and Anthropic pricing'), false);
});

/** @param {string} command @param {string} cwd @param {Record<string,string>} [env] */
function hook(command, cwd, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
    // Both set explicitly, so the developer's own Claude Code session never leaks in.
    env: { ...process.env, FORGE_AI_ATTRIBUTION: '', CLAUDE_PROJECT_DIR: '', ...env },
  });
}

const ATTR = 'Co-Authored-By: Claude <noreply@anthropic.com>';
const optOut = (dir: string) => {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), `schemaVersion: ${CONFIG_SCHEMA_VERSION}\naiAttribution: allow\n`);
};

test('hook blocks publishing commands that carry attribution', () => {
  const repo = tempRepo();
  const other = tempRepo();
  try {
    const blocked = hook(`git commit -m "$(cat <<'EOF'\nfeat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nEOF\n)"`, repo.dir);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /Co-Authored-By: Claude/);
    const body = path.join(repo.dir, 'body.md');
    fs.writeFileSync(body, 'Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n');
    assert.equal(hook(`gh pr create --title x --body-file ${body}`, repo.dir).status, 2);
    assert.equal(hook('git commit -m "feat: read Claude Code transcripts"', repo.dir).status, 0);
    assert.equal(hook('echo "Co-Authored-By: Claude"', repo.dir).status, 0, 'non-publishing commands are untouched');
    assert.equal(hook(`gh pr create --body-file ${body}`, repo.dir, { FORGE_AI_ATTRIBUTION: 'allow' }).status, 0);
    assert.equal(hook(`git -c x=y commit -m "${ATTR}"`, repo.dir).status, 2, 'a global option hides nothing');
    const msg = path.join(repo.dir, 'msg.txt');
    fs.writeFileSync(msg, `feat: x\n\n${ATTR}\n`);
    assert.equal(hook(`git commit --file=${msg}`, repo.dir).status, 2, 'a --file= message is read');
    optOut(other.dir);
    assert.equal(hook(`git commit -m "${ATTR}"`, other.dir, { CLAUDE_PROJECT_DIR: repo.dir }).status, 2, "the cwd's own opt-out is ignored");
    optOut(repo.dir);
    assert.equal(hook(`gh pr create --body-file ${body}`, repo.dir, { CLAUDE_PROJECT_DIR: repo.dir }).status, 0, 'a repo can opt out');
  } finally {
    repo.cleanup();
    other.cleanup();
  }
});

test('commandAttribution finds attribution in any git, gh or glab command', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-attr-')));
  try {
    const msg = path.join(dir, 'msg');
    fs.writeFileSync(msg, `feat: x\n\n${ATTR}\n`);
    fs.writeFileSync(path.join(dir, 'b.md'), `Summary\n\n${ATTR}\n`);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'msg.txt'), `${ATTR}\n`);
    const json = path.join(dir, 'body.json');
    fs.writeFileSync(json, JSON.stringify({ body: `x\n\n${ATTR}` }));
    const api = 'gh api repos/o/r/issues/1/comments';
    const found = [
      `gh release create v1 --notes-file ${msg}`,
      `gh release create v1 --notes-file=${msg}`,
      `${api} -F body=@${msg}`,
      `${api} -Fbody=@${msg}`,
      `${api} -f body=@${msg}`,
      `${api} --field=body=@${msg}`,
      `${api} --raw-field body=@${msg}`,
      `${api} -F 'body=@${msg}'`,
      `git commit --fil=${msg}`,
      `git commit --fil ${msg}`,
      `git tag -a v1 --fi=${msg}`,
      `git commit --te=${msg}`,
      `git commit --templ ${msg}`,
      'git -C sub commit --fil=msg.txt',
      `${api} --input ${json}`,
      `${api} --input=${json}`,
      `git -c x=y commit -m "${ATTR}"`,
      `git -C sub commit -m "${ATTR}"`,
      `git --no-pager commit -m "${ATTR}"`,
      `/usr/bin/git commit -m "${ATTR}"`,
      `gh -R o/r pr comment 1 -b "${ATTR}"`,
      `glab mr note 1 -m "${ATTR}"`,
      `git commit --file=${msg}`,
      `git commit -F${msg}`,
      `git commit -aF ${msg}`,
      `gh pr create --body-file=${path.join(dir, 'b.md')}`,
      `git commit --template=${msg}`,
      `git commit -F "${msg}"`,
      'git -C sub commit -F msg.txt',
    ];
    for (const cmd of found) assert.deepEqual(commandAttribution(cmd, dir), [ATTR], cmd);
    const fifo = path.join(dir, 'fifo');
    const none = [
      `echo "${ATTR}"`,
      'git commit -m "feat: read Claude Code transcripts"',
      `git commit -F ${path.join(dir, 'sub')}`,
      'git commit -F -',
      'git commit -F msg.txt',
      `git commit --fixup=${msg}`,
      `git log --text ${msg}`,
      'gh api x -F body=@-',
      'gh api x --input -',
    ];
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [fifo]);
      none.push(`git commit -F ${fifo}`);
    }
    for (const cmd of none) assert.deepEqual(commandAttribution(cmd, dir), [], cmd);
    const started = Date.now();
    const hostile = `git commit -${'a'.repeat(10_000)} -t${' '.repeat(10_000)}; -C${' '.repeat(10_000)}|`;
    assert.deepEqual(commandAttribution(hostile, dir), []);
    assert.ok(Date.now() - started < 1000, 'a 10k-character hostile line is parsed in linear time');
    // Thousands of missing `-C` dirs and `-F` files: only the first 8 and 32 are tried.
    const many = (flag: string, prefix: string) => Array.from({ length: 2000 }, (_, i) => ` ${flag} ${prefix}${i}`).join('');
    const flood = `git${many('-C', 'd')} commit${many('-F', 'm')} -m "${ATTR}"`;
    const floodStarted = Date.now();
    assert.deepEqual(commandAttribution(flood, dir), [ATTR]);
    assert.ok(Date.now() - floodStarted < 1000, 'a command with 2000 -C and 2000 -F flags is checked in under a second');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the opt-out is read from the project's main checkout only", () => {
  const main = tempRepo();
  const plain = tempRepo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-attr-wt-')));
  try {
    optOut(main.dir);
    main.git('worktree', 'add', '-q', path.join(tmp, 'main-wt'), '-b', 'x');
    assert.equal(repoAllowsAttribution(main.dir), true);
    assert.equal(repoAllowsAttribution(path.join(tmp, 'main-wt')), true, "a worktree reads its main checkout's opt-out");

    plain.git('worktree', 'add', '-q', path.join(tmp, 'plain-wt'), '-b', 'x');
    optOut(path.join(tmp, 'plain-wt'));
    assert.equal(repoAllowsAttribution(path.join(tmp, 'plain-wt')), false, "a worktree's own config is ignored");
    assert.equal(repoAllowsAttribution(plain.dir), false);

    fs.mkdirSync(path.join(tmp, 'not-git'));
    for (const dir of [undefined, '', path.join(tmp, 'not-git')]) assert.equal(repoAllowsAttribution(dir), false, String(dir));
  } finally {
    main.cleanup();
    plain.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scrubBranch rewrites only offending commit messages', () => {
  const repo = tempRepo();
  try {
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'a');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'feat: a\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
    fs.writeFileSync(path.join(repo.dir, 'b.txt'), 'b');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'fix: b mentions Claude Code by name');
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo.dir, encoding: 'utf8' }).trim();
    const res = scrubBranch(repo.dir, base);
    assert.equal(res.rewritten, 1);
    const log = execFileSync('git', ['log', '--format=%B%x1e', `${base}..HEAD`], { cwd: repo.dir, encoding: 'utf8' });
    assert.doesNotMatch(log, /Co-Authored-By/i);
    assert.match(log, /fix: b mentions Claude Code by name/);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo.dir, encoding: 'utf8' }).trim(), tree, 'content unchanged');
    assert.equal(res.sha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim(), 'the branch moved to the sha it returns');
    assert.equal(scrubBranch(repo.dir, base).rewritten, 0);
  } finally {
    repo.cleanup();
  }
});

test('scrubBranch rewrites from the commit it is given and never folds in a later one', () => {
  const repo = tempRepo();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo.dir, encoding: 'utf8' }).trim();
  try {
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'a');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'feat: a\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
    fs.writeFileSync(path.join(repo.dir, 'b.txt'), 'b');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'fix: b');
    const checked = git('rev-parse', 'HEAD');
    const trees = [git('rev-parse', 'HEAD~1^{tree}'), git('rev-parse', 'HEAD^{tree}')];
    const people = git('log', '--format=%an %ae %ad|%cn %ce %cd', `${base}..HEAD`);

    // A commit lands after the check: the branch is not moved and nothing is returned to push.
    fs.writeFileSync(path.join(repo.dir, 'late.txt'), 'late');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'late');
    const late = git('rev-parse', 'HEAD');
    assert.throws(() => scrubBranch(repo.dir, base, checked), /moved off .* nothing was pushed/);
    assert.equal(git('rev-parse', 'HEAD'), late, 'the branch is left alone');

    // Back on the checked commit: every tree, author and committer is the checked one.
    repo.git('reset', '-q', '--hard', checked);
    const res = scrubBranch(repo.dir, base, checked);
    assert.equal(res.rewritten, 1);
    assert.equal(git('rev-parse', 'HEAD'), res.sha);
    assert.deepEqual([git('rev-parse', `${res.sha}~1^{tree}`), git('rev-parse', `${res.sha}^{tree}`)], trees);
    assert.equal(git('log', '--format=%an %ae %ad|%cn %ce %cd', `${base}..HEAD`), people);
    assert.equal(git('rev-list', '--count', `${base}..HEAD`), '2');
    assert.doesNotMatch(git('log', '--format=%B', `${base}..HEAD`), /Co-Authored-By/i);
    assert.equal(git('status', '--porcelain'), '', 'the worktree is untouched');
  } finally {
    repo.cleanup();
  }
});
