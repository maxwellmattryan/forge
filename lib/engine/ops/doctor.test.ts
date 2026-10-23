// forge doctor's config checks that need no machine state, in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { envCopyCheck } from './doctor.ts';
import type { Config } from '#core/types.ts';

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
