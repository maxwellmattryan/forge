// The builder's model by complexity and on a review-only rework: resolveModel's precedence, the
// validation that reports bad values, and the v20 → v21 config migration that adds them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults, loadConfig, modelProblems, resolveModel, validateConfig } from '../lib/config.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import { setIn } from '../lib/yaml.ts';
import type { Config } from '../lib/types.ts';

const cfg = (f: (c: Config) => void = () => {}) => {
  const c = defaults();
  f(c);
  return c;
};

test('builder model precedence and fall-through', () => {
  const all = cfg((c) => {
    c.runtime.models.builder = 'opus';
    c.runtime.modelByComplexity = { low: 'sonnet', medium: null, high: 'claude-opus-5-5' };
    c.runtime.reworkModel = 'haiku';
  });
  const low2 = { complexity: 'low', round: 2 };
  // 1. reworkModel on a review-only rework.
  assert.equal(resolveModel(all, low2, 'builder', ['review']), 'haiku');
  // Not with any other rework input, nor on round 1.
  for (const rework of [['review', 'verify'], ['verify'], ['review', 'feedback'], ['answer'], ['pr-feedback'], ['verifiers'], []])
    assert.equal(resolveModel(all, low2, 'builder', rework), 'sonnet', `rework ${rework.join(',') || 'none'}`);
  assert.equal(resolveModel(all, { complexity: 'low', round: 1 }, 'builder', ['review']), 'sonnet', 'round 1 never takes reworkModel');
  // 2. modelByComplexity[complexity].
  assert.equal(resolveModel(all, { complexity: 'high', round: 1 }, 'builder'), 'claude-opus-5-5');
  // 3. models.builder: unset complexity value, unknown or missing complexity, no job.
  assert.equal(resolveModel(all, { complexity: 'medium', round: 1 }, 'builder'), 'opus');
  assert.equal(resolveModel(all, { complexity: 'extreme', round: 1 }, 'builder'), 'opus');
  assert.equal(resolveModel(all, null, 'builder'), 'opus');
  // 4. inherit.
  const bare = cfg((c) => delete (c.runtime.models as any).builder);
  assert.equal(resolveModel(bare, null, 'builder'), 'inherit');
  // An invalid value at any layer falls through.
  const bad = cfg((c) => {
    c.runtime.models.builder = 'sonnet';
    c.runtime.modelByComplexity = { low: 'opus; rm -rf /', medium: 3 as any, high: '' };
    c.runtime.reworkModel = '--add-dir=/';
  });
  for (const complexity of ['low', 'medium', 'high']) assert.equal(resolveModel(bad, { complexity, round: 2 }, 'builder', ['review']), 'sonnet', complexity);
  (bad.runtime.models as any).builder = 'x y';
  assert.equal(resolveModel(bad, null, 'builder'), 'inherit', 'an invalid models.builder falls through to inherit');
  (bad.runtime as any).modelByComplexity = 'opus';
  assert.equal(resolveModel(bad, { complexity: 'low' }, 'builder'), 'inherit', 'a non-map is unset');
  // Non-builder roles are unaffected by the overrides.
  for (const role of ['planner', 'approver', 'integrator', 'spec-writer', 'verifier']) assert.equal(resolveModel(all, low2, role, ['review']), defaults().runtime.models[role], role);
  const lens = cfg((c) => {
    c.runtime.reworkModel = 'haiku';
    c.runtime.modelByComplexity.low = 'haiku';
    c.review.panel = [{ name: 'code' }, { name: 'security', model: 'opus' }];
  });
  assert.equal(resolveModel(lens, low2, 'reviewer:code', ['review']), 'sonnet', 'runtime.models.reviewer');
  assert.equal(resolveModel(lens, low2, 'reviewer:security'), 'opus', "the lens's own model");
});

test('invalid builder model overrides are reported by validate', () => {
  const repo = tempRepo();
  try {
    const c = defaults();
    assert.deepEqual(modelProblems(c), [], 'defaults are valid');
    c.runtime.modelByComplexity = { low: 'sonnet', medium: null, high: null };
    c.runtime.reworkModel = 'haiku';
    assert.deepEqual(modelProblems(c), [], 'set values are valid');
    (c.runtime.modelByComplexity as any) = { low: 'opus; rm -rf /', extreme: 'opus' };
    c.runtime.reworkModel = '--add-dir=/';
    const problems = validateConfig(c, repo.dir);
    for (const want of [
      'runtime.modelByComplexity.low must be a model alias or id (letters, digits and . _ : - [ ]) or null (got "opus; rm -rf /")',
      'runtime.modelByComplexity.extreme must be low, medium or high',
      'runtime.reworkModel must be a model alias or id (letters, digits and . _ : - [ ]) or null (got "--add-dir=/")',
    ])
      assert.ok(problems.includes(want), `${want}\n${problems.join('\n')}`);
    (c.runtime as any).modelByComplexity = ['sonnet'];
    assert.ok(validateConfig(c, repo.dir).includes('runtime.modelByComplexity must be a map (got ["sonnet"])'));
    (c.runtime as any).modelByComplexity = { low: 7 };
    assert.ok(modelProblems(c).some((p) => p.startsWith('runtime.modelByComplexity.low must be a model alias')));
    // On disk too, through forge config validate's loader.
    const file = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = `schemaVersion: ${CONFIG_SCHEMA_VERSION}\ntracker:\n  kind: none\nruntime:\n  reworkModel: sonnet\n`;
    text = setIn(text, ['runtime', 'modelByComplexity', 'low'], 'sonnet');
    fs.writeFileSync(file, text);
    const loaded = loadConfig(repo.dir).config;
    assert.deepEqual(modelProblems(loaded), []);
    assert.equal(validateConfig(loaded, repo.dir).some((p) => p.includes('reworkModel') || p.includes('modelByComplexity')), false);
  } finally {
    repo.cleanup();
  }
});

test('v20 config migrates to v21', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 25);
  const v20 = { schemaVersion: 20, tracker: { kind: 'none' }, runtime: { models: { builder: 'opus' } }, review: { onPrFeedback: 'full' } };
  const m = migrateConfig(structuredClone(v20));
  assert.equal(m.from, 20);
  assert.deepEqual(m.config, { ...v20, schemaVersion: 25 }, 'nothing but schemaVersion changes');
  const repo = tempRepo();
  try {
    const file = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'schemaVersion: 20\ntracker:\n  kind: none\n');
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.migratedFrom, 20);
    assert.equal(loaded.config.schemaVersion, 25);
    assert.deepEqual(loaded.config.runtime.modelByComplexity, { low: null, medium: null, high: null });
    assert.equal(loaded.config.runtime.reworkModel, null);
    assert.equal(loaded.config.review.onRework, 'narrow');
  } finally {
    repo.cleanup();
  }
});
