import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults, validateConfig } from '../lib/config.ts';
import { initWrite } from '../lib/commands/init.ts';
import { modelFamily, modelOverlap, roster } from '../lib/roster.ts';

const warning = (role, model, builder) => `${role} runs on ${model}, the same model family as the builder (${builder}); runtime.diversity asks for a different one`;

test('overlap is reported always and warns only with diversity on', () => {
  const repo = tempRepo();
  try {
    const cfg = defaults();
    let r = roster(repo.dir, cfg);
    assert.equal(r.diversity.enabled, false);
    assert.equal(r.diversity.builder, 'opus');
    assert.deepEqual(r.diversity.overlap, [
      { role: 'approver', model: 'opus' },
      { role: 'reviewer:security', model: 'opus' },
    ]);
    assert.deepEqual(r.warnings, []);
    // The existing keys are untouched.
    assert.ok(Array.isArray(r.agents) && r.agents.length);
    assert.ok(Array.isArray(r.reviewers) && r.reviewers.length);
    assert.ok('learnings' in r);

    cfg.runtime.diversity = true;
    r = roster(repo.dir, cfg);
    assert.equal(r.diversity.enabled, true);
    assert.deepEqual(r.warnings, [warning('approver', 'opus', 'opus'), warning('reviewer:security', 'opus', 'opus')]);
  } finally {
    repo.cleanup();
  }
});

test('family matching, per-lens overrides and inherit', () => {
  const cfg = defaults();
  assert.equal(modelFamily(cfg, 'claude-opus-5-5'), 'opus');
  assert.equal(modelFamily(cfg, 'Claude-Sonnet-4'), 'sonnet');
  assert.equal(modelFamily(cfg, 'gpt-x'), 'gpt-x');

  // A full model id and an alias share a family.
  cfg.runtime.models.builder = 'claude-opus-5-5';
  assert.deepEqual(modelOverlap(cfg).overlap.map((o) => o.role), ['approver', 'reviewer:security']);

  // A lens's own model wins; without one it falls back to runtime.models.reviewer.
  cfg.runtime.models.builder = 'opus';
  cfg.runtime.models.approver = 'sonnet';
  cfg.runtime.models.reviewer = 'opus';
  cfg.review.panel = [{ name: 'ui', model: 'haiku' }, { name: 'code' }];
  assert.deepEqual(modelOverlap(cfg).overlap, [{ role: 'reviewer:code', model: 'opus' }]);

  // inherit resolves through the orchestrator; two unresolved inherits are the same.
  cfg.review.panel = [{ name: 'code', model: 'haiku' }];
  cfg.runtime.models.orchestrator = 'inherit';
  cfg.runtime.models.builder = 'inherit';
  cfg.runtime.models.approver = 'inherit';
  assert.deepEqual(modelOverlap(cfg).overlap, [{ role: 'approver', model: 'inherit' }]);
  cfg.runtime.models.approver = 'opus';
  assert.deepEqual(modelOverlap(cfg).overlap, []);
  cfg.runtime.models.orchestrator = 'opus';
  assert.deepEqual(modelOverlap(cfg).overlap, [{ role: 'approver', model: 'opus' }]);
  assert.equal(modelOverlap(cfg).builder, 'inherit', 'builder is reported raw');
});

test('init write warns; validate rejects non-boolean diversity', () => {
  const repo = tempRepo();
  try {
    const on = initWrite(repo.dir, { runtime: { diversity: true, models: { builder: 'opus', approver: 'opus' } }, review: { panel: [{ name: 'code', always: true }] } }, true);
    assert.equal(on.ok, true);
    assert.deepEqual(on.warnings, [warning('approver', 'opus', 'opus')]);

    const off = initWrite(repo.dir, { runtime: { diversity: false } }, true);
    assert.deepEqual(off.warnings, []);

    const cfg = defaults();
    assert.deepEqual(validateConfig(cfg, repo.dir), []);
    cfg.runtime.diversity = 'yes' as any;
    assert.ok(validateConfig(cfg, repo.dir).includes('runtime.diversity must be true or false (got "yes")'));
    assert.throws(() => initWrite(repo.dir, { runtime: { diversity: 1 } }, true), /runtime\.diversity must be true or false/);

    // The CLI path: `forge config validate` exits 1 and names the key.
    fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), 'schemaVersion: 1\nruntime:\n  diversity: "yes"\n');
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
    const r = spawnSync(process.execPath, [bin, 'config', 'validate'], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: repo.dir } });
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout).problems, ['runtime.diversity must be true or false (got "yes")']);
  } finally {
    repo.cleanup();
  }
});

test("roster reports each role's and lens's effort and source", () => {
  const repo = tempRepo();
  try {
    const cfg = defaults();
    let r = roster(repo.dir, cfg);
    for (const a of r.agents) assert.deepEqual([a.effort, a.effortSource], [null, 'none'], a.role);
    for (const l of r.reviewers) assert.deepEqual([l.effort, l.effortSource], [null, 'none'], l.name);
    cfg.runtime.effort = 'medium';
    cfg.runtime.efforts.builder = 'high';
    cfg.runtime.effortByComplexity.high = 'max';
    (cfg.review.panel.find((p) => p.name === 'security') as any).effort = 'xhigh';
    r = roster(repo.dir, cfg);
    const agent = (role: string) => r.agents.find((a) => a.role === role)!;
    const lens = (name: string) => r.reviewers.find((l) => l.name === name)!;
    assert.deepEqual([agent('builder').effort, agent('builder').effortSource], ['high', 'role']);
    assert.deepEqual([agent('planner').effort, agent('planner').effortSource], ['medium', 'config'], 'no job, so no complexity');
    assert.deepEqual([lens('security').effort, lens('security').effortSource], ['xhigh', 'panel']);
    assert.deepEqual([lens('code').effort, lens('code').effortSource], ['medium', 'config']);
    cfg.runtime.efforts.reviewer = 'low';
    r = roster(repo.dir, cfg);
    assert.deepEqual([lens('code').effort, lens('code').effortSource], ['low', 'role']);
    assert.deepEqual([lens('security').effort, lens('security').effortSource], ['xhigh', 'panel']);
  } finally {
    repo.cleanup();
  }
});

test('triage agent runs on haiku without a config key', () => {
  const repo = tempRepo();
  try {
    const cfg = defaults();
    assert.equal(cfg.runtime.models.triage, undefined, 'no config key');
    const row = roster(repo.dir, cfg).agents.find((a) => a.role === 'triage');
    assert.ok(row);
    assert.equal(row.model, 'haiku');
    const text = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'agents', 'triage.md'), 'utf8');
    const front = text.match(/^---\n([\s\S]*?)\n---\n/)![1];
    assert.match(front, /^name: triage$/m);
    assert.match(front, /^model: haiku$/m);
    assert.match(front, /^disallowedTools: Bash, Edit, NotebookEdit$/m);
  } finally {
    repo.cleanup();
  }
});
