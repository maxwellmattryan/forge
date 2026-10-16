import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, panelPathsProblems, validateConfig } from '../lib/config.ts';
import { choosePanel } from '../lib/step.ts';
import type { Config } from '../lib/types.ts';

const ROOT = process.cwd();

function config(panel: Config['review']['panel']): Config {
  const c = defaults();
  c.review.panel = panel;
  return c;
}

const PANEL = config([
  { name: 'design', when: 'user-visible UI changes', paths: ['dashboard/src/**', '*.svelte'] },
  { name: 'code', always: true },
  { name: 'security', when: 'lib/server.ts, anything that runs commands', paths: ['lib/trackers/**', 'package.json'] },
  { name: 'docs', paths: ['docs/**', '*.md'] },
  { name: 'tests', always: true },
]);

test('choosePanel: order, reasons, carry, retro', () => {
  const r = choosePanel({
    kind: 'feature',
    config: PANEL,
    suggested: ['tests', 'docs', 'nope', 'Evil;rm'],
    approachPaths: ['lib/server.ts', 'lib/a.ts'],
    changed: ['README.md', 'docs/a.md', 'docs/b.md', 'lib/server.ts', 'ui/deep/x/Card.svelte'],
    carried: ['security', 'extra', 'tests', 'a;b', '../x', 'UI'],
  });
  // Panel position first, then carried names that aren't in the panel, in job.reviewers order.
  assert.deepEqual(r.lenses, ['design', 'code', 'security', 'docs', 'tests', 'extra']);
  assert.deepEqual(r.reasons, {
    design: ['paths *.svelte: ui/deep/x/Card.svelte'],
    code: ['always'],
    security: ['approach lib/server.ts', 'carried'],
    docs: ['suggested', 'paths docs/**: docs/a.md (+1 more)', 'paths *.md: README.md (+2 more)'],
    tests: ['always', 'suggested', 'carried'],
    extra: ['carried'],
  });

  // Without a diff (spec time) and without carried names, only rules 1 to 3 apply.
  const spec = choosePanel({ kind: 'feature', config: PANEL, suggested: [], approachPaths: ['dashboard/src/App.svelte'], changed: null, carried: [] });
  assert.deepEqual(spec.lenses, ['design', 'code', 'tests']);
  assert.deepEqual(spec.reasons.design, ['approach dashboard/src/App.svelte']);

  // An empty diff touches no paths; always lenses stay.
  const empty = choosePanel({ kind: 'feature', config: PANEL, suggested: [], approachPaths: [], changed: [], carried: [] });
  assert.deepEqual(empty.lenses, ['code', 'tests']);
  assert.deepEqual(empty.reasons, { code: ['always'], tests: ['always'] });

  // A malformed panel name never becomes a lens, even when its paths match.
  const bad = choosePanel({ kind: 'feature', config: config([{ name: 'code', always: true }, { name: 'x y', paths: ['*'] }]), suggested: ['x y'], approachPaths: [], changed: ['a'], carried: ['x y'] });
  assert.deepEqual(bad.lenses, ['code']);

  // A digits-only lens keeps its panel position.
  const digits = choosePanel({ kind: 'feature', config: config([{ name: 'code', always: true }, { name: '2fa', always: true }, { name: '42', always: true }]), suggested: [], approachPaths: [], changed: [], carried: [] });
  assert.deepEqual(digits.lenses, ['code', '2fa', '42']);

  const retro = choosePanel({ kind: 'retro', config: PANEL, suggested: ['security'], approachPaths: ['lib/server.ts'], changed: ['lib/trackers/x.ts'], carried: ['design'] });
  assert.deepEqual(retro, { lenses: ['code', 'docs'], reasons: { code: ['retro'], docs: ['retro'] } });
});

test('review.panel paths validation', () => {
  const problems = (paths: unknown) => validateConfig(config([{ name: 'code', always: true }, { name: 'security', paths } as any]), ROOT);
  assert.deepEqual(problems(['lib/server.ts', 'lib/trackers/**', '*.svelte', 'docs/', 'a?.md']), []);
  assert.deepEqual(problems([]), []);
  const cases: [unknown, RegExp][] = [
    ['lib/**', /review\.panel "security"\.paths must be a list of paths or globs \(got "lib\/\*\*"\)/],
    [{ a: 1 }, /review\.panel "security"\.paths must be a list/],
    [[''], /review\.panel "security"\.paths entries must be non-empty strings \(got ""\)/],
    [['  '], /review\.panel "security"\.paths entries must be non-empty strings/],
    [[3], /review\.panel "security"\.paths entries must be non-empty strings \(got 3\)/],
    [['/etc/passwd'], /review\.panel "security"\.paths entry "\/etc\/passwd" must be relative to the repo/],
    [['-x'], /review\.panel "security"\.paths entry "-x" must not start with -, ! or :/],
    [['!lib/**'], /review\.panel "security"\.paths entry "!lib\/\*\*" must not start with -, ! or :/],
    [[':(glob)lib'], /review\.panel "security"\.paths entry ":\(glob\)lib" must not start with -, ! or :/],
    [['lib/../x'], /review\.panel "security"\.paths entry "lib\/\.\.\/x" must not contain a \.\. segment/],
    [['..'], /must not contain a \.\. segment/],
  ];
  for (const [paths, re] of cases) {
    const p = problems(paths);
    assert.equal(p.length, 1, `${JSON.stringify(paths)}: ${JSON.stringify(p)}`);
    assert.match(p[0], re);
  }
  // The shared helper reports every bad entry, each naming the lens.
  assert.deepEqual(panelPathsProblems('docs', ['ok/**', '', '../x']).length, 2);
  assert.ok(panelPathsProblems('docs', ['', '../x']).every((m) => m.startsWith('review.panel "docs".paths')));
});
