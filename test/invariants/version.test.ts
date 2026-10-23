// The deprecated-config-key registry and docs/CONFIG.md "Deprecated keys" agree, and doctor warns on a
// deprecated key. Kept through the test rewrite (docs/test-rewrite/README.md): docs stay in sync with
// code (docs/TESTING.md › Allowed source-text tests, entry 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEPRECATED_CONFIG_KEYS, deprecationChecks } from '#core/config/validators/deprecations.ts';
import type { DeprecatedKey } from '#core/config/validators/deprecations.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');

/** What the registry promises: semver releases, a minor's notice, and a docs entry. */
function registryProblems(registry: readonly DeprecatedKey[], docs: string): string[] {
  const problems: string[] = [];
  const section = /^## Deprecated keys\n([\s\S]*?)(?=^## )/m.exec(docs)?.[1];
  if (section === undefined) return ['docs/CONFIG.md has no "## Deprecated keys" section'];
  const ver = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  for (const d of registry) {
    const since = ver(d.since);
    const removeIn = ver(d.removeIn);
    if (!since) problems.push(`${d.key}: since ${d.since} is not X.Y.Z`);
    if (!removeIn) problems.push(`${d.key}: removeIn ${d.removeIn} is not X.Y.Z`);
    if (since && removeIn && !(removeIn[0] > since[0] || (removeIn[0] === since[0] && removeIn[1] > since[1]))) problems.push(`${d.key}: removeIn ${d.removeIn} is not at least one minor after ${d.since}`);
    if (!section.includes(`\`${d.key}\``)) problems.push(`${d.key}: not listed in docs/CONFIG.md "Deprecated keys"`);
  }
  if (!registry.length && !section.includes('None today.')) problems.push('an empty registry reads "None today."');
  return problems;
}

test('deprecated config keys', () => {
  assert.deepEqual(DEPRECATED_CONFIG_KEYS, [], 'empty today');
  const docs = fs.readFileSync(path.join(REPO, 'docs', 'CONFIG.md'), 'utf8');
  assert.deepEqual(registryProblems(DEPRECATED_CONFIG_KEYS, docs), []);

  const old: DeprecatedKey = { key: 'pipeline.oldKnob', since: '0.18.0', removeIn: '0.19.0', replacement: 'pipeline.newKnob', note: '' };
  const gone: DeprecatedKey = { key: 'daemon.legacy', since: '0.18.0', removeIn: '1.0.0', replacement: null, note: 'delete it; the daemon always does this now' };
  const yaml = 'pipeline:\n  oldKnob: true\ndaemon:\n  legacy: false\nreview:\n  blockOn: [blocker]\n';
  assert.deepEqual(deprecationChecks(yaml, [old, gone]), [
    { name: 'deprecated config key pipeline.oldKnob', ok: true, warn: true, detail: 'deprecated in 0.18.0, removed in 0.19.0; use pipeline.newKnob' },
    { name: 'deprecated config key daemon.legacy', ok: true, warn: true, detail: 'deprecated in 0.18.0, removed in 1.0.0; delete it; the daemon always does this now' },
  ]);
  assert.deepEqual(deprecationChecks('pipeline:\n  plan: auto\n', [old, gone]), [], 'absent keys');
  assert.deepEqual(deprecationChecks(yaml, []), [], 'an empty registry');
  assert.deepEqual(deprecationChecks(yaml), [], 'the real registry');
  assert.deepEqual(deprecationChecks('pipeline: [unclosed\n  : :\n\t- x', [old]), [], 'unparsable YAML');
  assert.deepEqual(deprecationChecks('', [old]), [], 'an empty file');

  // The shape check catches each broken entry.
  const listed = '## Deprecated keys\n\n`pipeline.oldKnob`\n\n## Next\n';
  assert.deepEqual(registryProblems([old], listed), []);
  assert.equal(registryProblems([{ ...old, since: '0.18' }], listed).length, 1);
  assert.equal(registryProblems([{ ...old, removeIn: '0.18.5' }], listed).length, 1);
  assert.equal(registryProblems([old], '## Deprecated keys\n\nNone today.\n\n## Next\n').length, 1);
  assert.equal(registryProblems([], '# nothing\n').length, 1);
});
