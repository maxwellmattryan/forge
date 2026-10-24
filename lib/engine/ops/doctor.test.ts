// forge doctor's config checks that need no machine state, in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { doctor, envCopyCheck, instructionsPolicyCheck } from './doctor.ts';
import { defaults } from '#core/config/load.ts';
import type { Config, ProtectedRule } from '#core/types.ts';
import { fakeBin, tempRepo } from '../../../test/helpers.ts';

const CI_RULE: ProtectedRule = { paths: ['.github/workflows/**'], action: 'escalate', reason: 'CI/CD configuration' };

/** defaults() with `rules` as the configured policy, and no tracker or PRs, so doctor never asks gh. */
function withPolicy(rules: ProtectedRule[] | null): Config {
  const c = defaults();
  c.tracker.kind = 'none';
  c.pr.enabled = false;
  if (rules) c.policy.protectedPaths = rules;
  return c;
}

test('doctor hints at an existing policy that leaves instruction files out', async (t) => {
  assert.equal(instructionsPolicyCheck(withPolicy(null)), null, 'the default list covers every probe');
  assert.equal(instructionsPolicyCheck(withPolicy([])), null, 'an empty policy was turned off deliberately');

  const ci = instructionsPolicyCheck(withPolicy([CI_RULE]));
  assert.deepEqual(ci, {
    name: 'protected instruction files',
    ok: true,
    warn: true,
    detail:
      'policy.protectedPaths does not cover AGENTS.md, lib/AGENTS.md, CLAUDE.md, CLAUDE.local.md, .claude/settings.json, lib/.claude/skills/x/SKILL.md, .mcp.json: add an escalate rule for **/AGENTS.md, **/CLAUDE.md, **/CLAUDE.local.md, .claude, **/.claude/** and .mcp.json by hand (docs/CONFIG.md "Protected paths")',
  });
  const md = instructionsPolicyCheck(withPolicy([{ paths: ['**/*.md'], action: 'refuse', reason: 'docs' }]));
  assert.ok(md?.detail.startsWith('policy.protectedPaths does not cover .claude/settings.json, .mcp.json: '), md?.detail);

  // doctor() itself, with a gh that answers nothing, so the release row never reaches the network.
  if (process.platform === 'win32') return;
  const repo = tempRepo();
  const gh = fakeBin('gh', 'exit 1');
  const PATH = process.env.PATH;
  process.env.PATH = `${gh.dir}${path.delimiter}${PATH}`;
  t.after(() => {
    process.env.PATH = PATH;
    repo.cleanup();
  });
  const row = (c: Config) => doctor(repo.dir, c, true).then((r) => r.checks.find((x) => x.name === 'protected instruction files'));
  assert.deepEqual(await row(withPolicy([CI_RULE])), ci);
  assert.equal(await row(withPolicy(null)), undefined);
});

test('worktrees.copy that can copy .env files is a warning', () => {
  const cfg = (copy: string[]) => ({ worktrees: { copy } }) as unknown as Pick<Config, 'worktrees'>;
  const warns = [['.env'], ['apps/web/.env.local'], ['.envrc'], ['**/.env*'], ['.*'], ['config/.env/'], ['CLAUDE.md', '.env?production']];
  for (const copy of warns) {
    const check = envCopyCheck(cfg(copy));
    assert.ok(check, `${JSON.stringify(copy)} warns`);
    assert.equal(check.name, 'worktrees.copy');
    assert.equal(check.ok, true);
    assert.equal(check.warn, true);
    const hits = copy.filter((e) => e !== 'CLAUDE.md');
    for (const e of hits) assert.ok(check.detail.includes(e), `the detail names ${e}`);
    assert.ok(!check.detail.includes('CLAUDE.md'), 'an entry that cannot copy .env is not named');
    assert.match(check.detail, /secrets/);
  }
  for (const copy of [[], ['CLAUDE.md', 'packages/*/CLAUDE.md'], ['env'], ['*.md'], ['docs/*.txt'], ['.github/']]) assert.equal(envCopyCheck(cfg(copy)), null, `${JSON.stringify(copy)} is no warning`);
});
