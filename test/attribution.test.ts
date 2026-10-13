import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { hasAttribution, stripAttribution, scrubBranch } from '../lib/attribution.ts';

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
    fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), 'schemaVersion: 1\naiAttribution: allow\n');
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
    assert.equal(scrubBranch(repo.dir, base).rewritten, 0);
  } finally {
    repo.cleanup();
  }
});
