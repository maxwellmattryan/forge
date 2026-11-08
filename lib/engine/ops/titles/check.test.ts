import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTitle, detectConvention } from './check.ts';

const cfg = (titles: Partial<{ style: 'conventional' | 'plain'; pattern: string | null }> = {}) => ({
  aiAttribution: 'forbid' as const,
  titles: { style: 'conventional' as const, pattern: null, guide: null, examples: 10, job: 'pr' as const, ...titles },
});

test('checkTitle accepts conventional subjects and refuses everything else', () => {
  const rows: [string, boolean][] = [
    ['feat: add x', true],
    ['fix(cli): handle an empty title', true],
    ['feat(dashboard)!: drop the old switcher', true],
    ['revert: feat(cli): add x', true],
    ['docs(architecture/foreman): split the topic', true],
    ['Feat: add x', false],
    ['feat:add x', false],
    ['feature: add x', false],
    ['feat(Cli): add x', false],
    ['Split the runtime topics', false],
    [`feat: ${'x'.repeat(67)}`, false],
    [`feat: ${'x'.repeat(66)}`, true],
    ['feat: add x\nsecond line', false],
    ['', false],
    ['🤖 Generated with [Claude Code](https://claude.com/claude-code)', false],
  ];
  for (const [title, ok] of rows) assert.equal(checkTitle(cfg(), title).ok, ok, JSON.stringify(title));
});

test('checkTitle folds control characters and whitespace', () => {
  assert.deepEqual(checkTitle(cfg(), 'feat:  add\u0007  x '), { ok: true, title: 'feat: add x' });
});

test('checkTitle under plain takes any one line up to 120 characters', () => {
  assert.deepEqual(checkTitle(cfg({ style: 'plain' }), 'Split the runtime topics'), { ok: true, title: 'Split the runtime topics' });
  assert.equal(checkTitle(cfg({ style: 'plain' }), 'x'.repeat(121)).ok, false);
});

test('checkTitle under a pattern uses only the pattern', () => {
  const c = cfg({ pattern: '^\\[[A-Z]+-\\d+\\] ' });
  assert.equal(checkTitle(c, '[ABC-12] Add x').ok, true);
  assert.equal(checkTitle(c, 'feat: add x').ok, false);
  assert.equal(checkTitle(cfg({ pattern: '(' }), 'feat: add x').ok, false);
});

test('detectConvention proposes the convention most titles follow', () => {
  const conventional = ['feat(cli): a', 'fix(cli): b', 'feat(dash): c', 'docs: d', 'chore(dash): e', 'Merge stuff'];
  const c = detectConvention(conventional)!;
  assert.equal(c.style, 'conventional');
  assert.deepEqual(c.scopes, ['cli', 'dash']);
  assert.equal(c.count, 6);

  const jira = ['ABC-1: a', 'ABC-2: b', 'ABC-3 c', 'XY-9: d', 'ABC-4: e'];
  const j = detectConvention(jira)!;
  assert.equal(j.style, 'plain');
  assert.ok(j.pattern && new RegExp(j.pattern, 'u').test('ABC-77: z'));

  const mixed = ['feat: a', 'fix: b', 'Add c', 'Remove d', 'Tidy e', 'Bump f'];
  assert.deepEqual({ ...detectConvention(mixed)!, sample: [] }, { style: 'plain', pattern: null, scopes: [], share: 1 - 2 / 6, count: 6, sample: [] });

  assert.equal(detectConvention(['feat: a', 'fix: b']), null);
});
