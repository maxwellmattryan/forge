// `forge verify`'s pure decisions: the verify list's shape and the verifyE2e config, and whether
// e2e runs (e2ePlan). test/integration/cli/verify.test.ts runs verify itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoTemplate } from './helpers.ts';
import { defaults, validateConfig } from '#core/config/load.ts';
import { e2ePlan } from '#engine/pipeline/e2e.ts';
import type { Config, Job } from '#core/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('validateConfig accepts groups and names each bad verify entry', () => {
  const problems = (verify: unknown) => {
    const c: any = defaults();
    c.verify = verify;
    return validateConfig(c, ROOT).filter((p) => p.startsWith('verify '));
  };
  assert.deepEqual(problems(defaults().verify), []);
  assert.deepEqual(problems(['build', 'lint', 'test']), []);
  assert.deepEqual(problems(['build', ['lint', 'test']]), []);
  assert.deepEqual(problems('build'), ['verify must be a list of step names or lists of step names (got "build")']);
  assert.deepEqual(problems([[]]), ['verify entry 1 must be a step name or a non-empty list of step names (got [])']);
  assert.deepEqual(problems([3]), ['verify entry 1 must be a step name or a non-empty list of step names (got 3)']);
  assert.deepEqual(problems([['lint', ['test']]]), ['verify entry 1 must be a step name or a non-empty list of step names (got ["lint",["test"]])']);
  assert.deepEqual(problems(['lint', ['lint', 'test']]), ['verify step "lint" is listed more than once']);
  assert.deepEqual(problems([['lint', 'nope']]), ['verify step "nope" is not a key in commands']);
});

test('verifyE2e config validation', () => {
  const cfg = defaults();
  assert.deepEqual(validateConfig(cfg, ROOT), []);
  for (const bad of [['*.css', ''], ['*.css', 3], null]) {
    cfg.verifyE2e.paths = bad as any;
    assert.ok(validateConfig(cfg, ROOT).some((p) => p.startsWith('verifyE2e.paths must be a list of non-empty strings')), JSON.stringify(bad));
  }
});

// A plain repo whose `job` branch commits files on top of main: e2ePlan diffs it against the job's base.
const plainRepo = repoTemplate(() => {});

test('e2ePlan: when always/never, no command, listed in verify, custom paths', () => {
  const repos: (() => void)[] = [];
  /** A worktree whose HEAD adds `files` on top of main. */
  const worktree = (files: string[]) => {
    const repo = plainRepo();
    repos.push(repo.cleanup);
    repo.git('checkout', '-qb', 'job');
    for (const rel of files) {
      fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, rel), 'x\n');
    }
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'job work');
    return repo.dir;
  };
  const lib = worktree(['lib/x.mjs']);
  const ui = worktree(['web/app.css']);
  const dash = worktree(['dashboard/app.js']);
  const job = (wt: string) => ({ base: 'main', worktree: wt }) as unknown as Job;
  const config = (edit: (c: Config) => void = () => {}) => {
    const c = defaults();
    c.verify = ['test'];
    edit(c);
    return c;
  };
  const CMD = 'echo E2E-RAN';
  try {
    const rows: [string, Config, string, string | null, ReturnType<typeof e2ePlan>][] = [
      ['ui, no UI paths', config(), lib, CMD, { run: false, reason: 'no UI paths changed' }],
      ['ui, UI paths', config(), ui, CMD, { run: true, reason: 'UI paths changed: web/app.css' }],
      ['always', config((c) => (c.verifyE2e.when = 'always')), lib, CMD, { run: true, reason: 'verifyE2e.when: always' }],
      ['never', config((c) => (c.verifyE2e.when = 'never')), ui, CMD, null],
      ['no command', config(), ui, null, null],
      ['listed in verify', config((c) => (c.verify = ['test', 'e2e'])), ui, CMD, null],
      ['listed in a group', config((c) => (c.verify = [['test', 'e2e']])), ui, CMD, null],
      ['custom paths, a hit', config((c) => (c.verifyE2e.paths = ['dashboard/'])), dash, CMD, { run: true, reason: 'UI paths changed: dashboard/app.js' }],
      // A user list replaces the defaults.
      ['custom paths, a default glob', config((c) => (c.verifyE2e.paths = ['dashboard/'])), ui, CMD, { run: false, reason: 'no UI paths changed' }],
    ];
    for (const [label, c, wt, template, want] of rows) assert.deepEqual(e2ePlan(c, job(wt), template), want, label);
  } finally {
    for (const cleanup of repos) cleanup();
  }
});
