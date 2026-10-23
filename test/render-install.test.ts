// lib/commands/render/{version,update}.ts: `forge version` and `forge update` in human mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../lib/cli/commands/render/update.ts';
import { version } from '../lib/cli/commands/render/version.ts';
import { HOSTILE, assertSafe, hasLines, plain } from './render-helpers.ts';
import type { UpdateCheck, UpdateResult } from '#engine/ops/types.ts';

const result = (o: Partial<UpdateResult> = {}): UpdateResult => ({ kind: 'plugin', root: '/p/forge', from: '0.17.0', to: '0.18.0', updated: true, commands: [], next: [], ...o });
const check = (o: Partial<UpdateCheck> = {}): UpdateCheck => ({ kind: 'git', root: '/src/forge', version: '0.18.0', commands: ['git pull --ff-only'], ...o });

test('version: forge <version>', () => {
  assert.equal(plain(version, { version: '0.18.0' }), 'forge 0.18.0');
  assert.equal(plain(version, { version: '0.18.0', commit: null }), null, 'any other shape is generic');
});

test('update: up to date', () => {
  assert.equal(plain(update, result({ from: '0.18.0', updated: false })), 'forge is up to date (0.18.0)');
});

test('update: updated plugin with ran, dashboard, warnings and next (golden)', () => {
  const out = plain(update, result({ commands: ['claude plugin update forge@forge'], dashboard: { restarted: true, url: 'http://127.0.0.1:4100' }, warnings: ['the old dashboard took 5s to stop'], next: ['restart Claude Code to load the new prompts'] }));
  assert.equal(
    out,
    [
      'forge updated 0.17.0 → 0.18.0',
      '',
      'Ran',
      '  claude plugin update forge@forge',
      '',
      'Dashboard',
      '  restarted http://127.0.0.1:4100',
      '',
      'Warnings',
      '  ! the old dashboard took 5s to stop',
      '',
      'Next',
      '  - restart Claude Code to load the new prompts',
    ].join('\n'),
  );
});

test('update: updated git install shows the shas and a stale dashboard', () => {
  const out = plain(update, result({ kind: 'git', head: { from: 'abc1234', to: 'def5678' }, commands: ['git pull --ff-only'], dashboard: { running: true, stale: true, url: 'http://127.0.0.1:4100' } }));
  assert.equal(out!.split('\n')[0], 'forge updated 0.17.0 → 0.18.0 (abc1234 → def5678)');
  hasLines(out, '  git pull --ff-only', '  still serves the old version: http://127.0.0.1:4100');
});

test('update --check: not blocked', () => {
  const out = plain(update, check({ branch: 'main', upstream: 'origin/main', dashboard: { running: true, url: 'http://127.0.0.1:4100' } }));
  assert.deepEqual(out!.split('\n').slice(0, 2), ['forge 0.18.0 (git install at /src/forge)', 'branch main tracking origin/main']);
  hasLines(out, 'Would run', '  git pull --ff-only', '  running http://127.0.0.1:4100');
});

test('update --check: blocked, with warnings', () => {
  const out = plain(update, check({ kind: 'git', commands: [], blocked: 'the clone has local changes', warnings: ['no upstream fetch in 30 days'] }));
  hasLines(out, 'Blocked', '  ✗ the clone has local changes', '  ! no upstream fetch in 30 days');
  assert.ok(!out!.includes('Would run'), 'no commands: no Would run section');
  const plugin = plain(update, check({ kind: 'plugin', commands: ['claude plugin update forge@forge'] }));
  assert.equal(plugin!.split('\n')[0], 'forge 0.18.0 (plugin install at /src/forge)');
  hasLines(plugin, '  claude plugin update forge@forge');
});

test('version and update: sanitizes untrusted text', () => {
  assertSafe(plain(version, { version: HOSTILE }));
  assertSafe(plain(update, result({ from: HOSTILE, to: HOSTILE, head: { from: HOSTILE, to: HOSTILE }, commands: [HOSTILE], dashboard: { restarted: true, url: HOSTILE }, warnings: [HOSTILE], next: [HOSTILE] })));
  assertSafe(plain(update, check({ version: HOSTILE, root: HOSTILE, branch: HOSTILE, upstream: HOSTILE, commands: [HOSTILE], blocked: HOSTILE, dashboard: { running: true, url: HOSTILE }, warnings: [HOSTILE] })));
});
