import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { hasAttribution, stripAttribution, scrubBranch } from '../lib/attribution.ts';
import { CONFIG_SCHEMA_VERSION } from '../lib/schema.ts';

const HOOK = path.resolve(import.meta.dirname, '..', 'hooks', 'no-ai-attribution.ts');

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
    env: { ...process.env, FORGE_AI_ATTRIBUTION: '', ...env },
  });
}

test('hook blocks publishing commands that carry attribution', () => {
  const repo = tempRepo();
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
    fs.mkdirSync(path.join(repo.dir, '.forge'));
    fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), `schemaVersion: ${CONFIG_SCHEMA_VERSION}\naiAttribution: allow\n`);
    assert.equal(hook(`gh pr create --body-file ${body}`, repo.dir).status, 0, 'a repo can opt out');
  } finally {
    repo.cleanup();
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
