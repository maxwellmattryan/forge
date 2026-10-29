// `forge daemon prompts`, spawned: the report on a seeded prompt history, its refusals, and that it writes
// neither the config it suggests rules for nor the history it reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { forgeAsync, tempRepo } from '../../helpers.ts';

test('daemon prompts reports, suggests and writes nothing', async (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  const config = paths(root).config;
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, 'daemon:\n  enabled: true\n');

  // No history yet: an empty report.
  const empty = await forgeAsync(root, ['daemon', 'prompts', '--json']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), { since: null, min: 3, entries: 0, groups: [], omitted: 0, suggest: [] });

  const inRepo = `Read(/${root}/src/**)`;
  let n = 0;
  const line = (rules: string[], decision = 'allow', reason: string | null = null) =>
    JSON.stringify({ v: 1, at: new Date(Date.UTC(2026, 9, 2, 10, 0, n++)).toISOString(), scope: '42-add-login', tool: rules[0]?.split('(')[0] ?? 'WebSearch', rules, decision, reason });
  const seeded = [
    line(['Bash(npm test:*)']),
    line(['Bash(npm test:*)'], 'session'),
    line([inRepo]),
    line([inRepo]),
    line(['Bash(git log:*)']),
    line(['Bash(git log:*)']),
    line(['Bash(forge:*)']),
    line(['Bash(forge:*)']),
    line(['Bash(make:*)']),
    line(['Bash(rm -r build:*)']),
    line(['Bash(rm -r build:*)'], 'deny', 'timeout'),
    line(['Bash(cat /etc/hosts:*)']),
    line(['Bash(cat /etc/hosts:*)']),
    line([]),
    'not json',
  ].join('\n') + '\n';
  fs.mkdirSync(paths(root).runtime, { recursive: true });
  fs.writeFileSync(paths(root).permissionPrompts, seeded);
  const before = { config: fs.readFileSync(config), history: fs.readFileSync(paths(root).permissionPrompts) };

  const [report, badSince, badMin, extra] = await Promise.all([
    forgeAsync(root, ['daemon', 'prompts', '--json', '--min', '2']),
    forgeAsync(root, ['daemon', 'prompts', '--json', '--since', 'nope']),
    forgeAsync(root, ['daemon', 'prompts', '--json', '--min', '0']),
    forgeAsync(root, ['daemon', 'prompts', 'extra', '--json']),
  ]);
  assert.equal(report.status, 0, report.stderr);
  const out = JSON.parse(report.stdout);
  assert.deepEqual(out.suggest, ['Bash(npm test:*)', inRepo]);
  assert.equal(out.entries, 14);
  assert.deepEqual(Object.fromEntries(out.groups.map((g: any) => [g.rule ?? `null:${g.tool}`, g.skip])), {
    'Bash(npm test:*)': null,
    [inRepo]: null,
    'Bash(git log:*)': 'invalid',
    'Bash(forge:*)': 'listed',
    'Bash(make:*)': 'below-min',
    'Bash(rm -r build:*)': 'denied',
    'Bash(cat /etc/hosts:*)': 'outside-repo',
    'null:WebSearch': 'no-rule',
  });
  for (const [name, r] of Object.entries({ badSince, badMin, extra })) assert.equal(r.status, 2, `${name}: ${r.stderr}`);
  assert.deepEqual(fs.readFileSync(config), before.config, 'the config is untouched');
  assert.deepEqual(fs.readFileSync(paths(root).permissionPrompts), before.history, 'the history is untouched');
});
