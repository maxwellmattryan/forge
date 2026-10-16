// policy.protectedPaths: the policy's shape and matching, and its gates end to end on scratch repos
// (forge git add|commit, forge verify, forge pr open, forge job set).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { matchPolicy, policyProblems, policyRules } from '../lib/protected.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import { tempRepo } from './helpers.ts';

const DEFAULT_RULES = [
  { paths: ['.github/workflows/**', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci/**'], action: 'escalate', reason: 'CI/CD configuration' },
  { paths: ['Dockerfile*', '**/*.tf'], action: 'escalate', reason: 'infrastructure' },
  { paths: ['**/migrations/**'], action: 'escalate', reason: 'database migrations' },
  { paths: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock'], action: 'escalate', reason: 'dependency lockfile' },
  { paths: ['**/.env*'], action: 'escalate', reason: 'environment files can hold credentials' },
  { paths: ['**/*.pem'], action: 'refuse', reason: 'private keys and certificates are never committed by Forge' },
  { paths: ['.forge/config.yml', '.forge/secrets-allow.txt', '.forge/trackers/**'], action: 'refuse', reason: "Forge's own policy changes only by a human on the base branch" },
];

describe('the policy', () => {
  test('policy defaults and an explicit empty list', () => {
    assert.deepEqual(defaults().policy.protectedPaths, DEFAULT_RULES);
    const repo = tempRepo();
    try {
      const file = path.join(repo.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `schemaVersion: ${CONFIG_SCHEMA_VERSION}\n`);
      assert.deepEqual(loadConfig(repo.dir).config.policy.protectedPaths, DEFAULT_RULES, 'no policy key: the defaults');
      fs.writeFileSync(file, `schemaVersion: ${CONFIG_SCHEMA_VERSION}\npolicy:\n  protectedPaths: []\n`);
      const { config } = loadConfig(repo.dir);
      assert.deepEqual(config.policy.protectedPaths, [], 'an explicit empty list turns it off');
      assert.deepEqual(policyRules(config), []);
      assert.deepEqual(validateConfig(config, repo.dir).filter((p) => p.startsWith('policy')), []);
    } finally {
      repo.cleanup();
    }
  });

  test('config v5 migrates to v6 unchanged', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 6);
    const v5 = { schemaVersion: 5, git: { base: 'trunk' }, approver: { alwaysEscalate: ['x'] } };
    const { config, from } = migrateConfig(structuredClone(v5));
    assert.equal(from, 5);
    assert.deepEqual(config, { ...v5, schemaVersion: 6 }, 'nothing but schemaVersion changes');
  });

  test('invalid policy shapes are reported', () => {
    const problems = (policy: unknown) => policyProblems({ policy });
    const one = (policy: unknown, re: RegExp) => {
      const p = problems(policy);
      assert.equal(p.length, 1, `${JSON.stringify(policy)}: ${JSON.stringify(p)}`);
      assert.match(p[0], re);
    };
    const rule = (r: Record<string, unknown>) => ({ protectedPaths: [{ paths: ['a/**'], action: 'escalate', reason: 'r', ...r }] });
    assert.deepEqual(problems({ protectedPaths: DEFAULT_RULES }), []);
    one('x', /^policy must be a map/);
    one(['x'], /^policy must be a map/);
    one({ protectedPaths: 'x' }, /^policy\.protectedPaths must be a list of rules/);
    one({ protectedPaths: ['x'] }, /^policy\.protectedPaths rule 1 must be a map/);
    one(rule({ paths: [] }), /rule 1: paths must be a non-empty list/);
    one(rule({ paths: 'a/**' }), /rule 1: paths must be a non-empty list/);
    one(rule({ paths: [''] }), /rule 1: paths entries must be non-empty strings/);
    one(rule({ paths: ['/etc/x'] }), /must be relative to the repo/);
    one(rule({ paths: ['a/../b'] }), /must not contain a \.\. segment/);
    for (const g of ['-x', '!x', ':x']) one(rule({ paths: [g] }), /must not start with -, ! or :/);
    one(rule({ action: 'block' }), /rule 1: action must be one of escalate \| refuse/);
    one(rule({ reason: '' }), /rule 1: reason must be a string of 1 to 200 characters/);
    one(rule({ reason: 'x'.repeat(201) }), /reason must be a string/);
    one(rule({ reason: 'a\nb' }), /reason must be a string/);
    one(rule({ reason: 3 }), /reason must be a string/);
    // validateConfig carries them, and policyRules fails closed.
    const c = defaults() as any;
    c.policy = rule({ action: 'block' });
    assert.ok(validateConfig(c, process.cwd()).some((p) => p.startsWith('policy.protectedPaths rule 1: action')));
    assert.throws(() => policyRules(c), (e: any) => e.code === 'config_invalid' && e.exitCode === 2);
    // The generalised glob check keeps worktrees.generated's own wording.
    const g = defaults() as any;
    g.worktrees.generated = ['../x'];
    assert.ok(validateConfig(g, process.cwd()).includes('worktrees.generated entry "../x" must not contain a .. segment'));
  });

  test('policy matching table', () => {
    const rules = defaults().policy.protectedPaths;
    const cases: [string, number | null, string | null, string | null][] = [
      ['.GitHub/Workflows/ci.yml', 1, '.github/workflows/**', 'escalate'],
      ['.github/workflows/ci.yml', 1, '.github/workflows/**', 'escalate'],
      ['Jenkinsfile', 1, 'Jenkinsfile', 'escalate'],
      ['web/package-lock.json', 4, 'package-lock.json', 'escalate'],
      ['infra/main.tf', 2, '**/*.tf', 'escalate'],
      ['Dockerfile.dev', 2, 'Dockerfile*', 'escalate'],
      ['db/migrations/001.sql', 3, '**/migrations/**', 'escalate'],
      ['config/.env.local', 5, '**/.env*', 'escalate'],
      ['certs/key.pem', 6, '**/*.pem', 'refuse'],
      ['.forge/config.yml', 7, '.forge/config.yml', 'refuse'],
      ['.forge/trackers/x.ts', 7, '.forge/trackers/**', 'refuse'],
      ['src/app.ts', null, null, null],
      ['.forge/backlog.md', null, null, null],
      ['docs/migrations.md', null, null, null],
    ];
    for (const [p, rule, glob, action] of cases) {
      const m = matchPolicy(p, rules);
      assert.deepEqual(m && [m.rule, m.glob, m.action], rule === null ? null : [rule, glob, action], p);
    }
    // A path matching both actions reports refuse, even from a later rule.
    const m = matchPolicy('.github/workflows/deploy.pem', rules);
    assert.deepEqual([m?.rule, m?.action, m?.reason], [6, 'refuse', 'private keys and certificates are never committed by Forge']);
    // Within one action the first rule is named.
    const twice = [
      { paths: ['a/**'], action: 'escalate' as const, reason: 'first' },
      { paths: ['a/b'], action: 'escalate' as const, reason: 'second' },
    ];
    assert.equal(matchPolicy('a/b', twice)?.reason, 'first');
  });
});
