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

test('choosePanel: member lenses, subsumed entries, order and carry', () => {
  const ml = (repo: string, name: string, entry: Record<string, unknown>, subsumed = false) => ({
    lens: subsumed ? name : `${repo}:${name}`,
    subsumed,
    entry: { name, ...entry },
    checklist: null,
  });
  const members = [
    {
      repo: 'lib',
      changed: ['src/dsp.rs', 'src/fft.rs', 'README.md'],
      lenses: [
        ml('lib', 'realtime', { paths: ['src/**'] }),
        // Named like a root lens with no checklist of its own: subsumed by the root `docs`.
        ml('lib', 'docs', { paths: ['*.md'], always: true }, true),
        ml('lib', 'code', { when: 'src/api.rs' }),
        ml('lib', 'perf', { always: true }),
        ml('lib', 'idle', { paths: ['bench/**'] }),
      ],
    },
    { repo: 'ui', changed: [], lenses: [ml('ui', 'a11y', {})] },
  ];
  const r = choosePanel({
    kind: 'feature',
    config: PANEL,
    suggested: ['ui:a11y', 'other:x'],
    approachPaths: ['lib/src/api.rs', 'src/api.rs', 'lib/src/dsp.rs'],
    // Root lenses match root changed files only.
    changed: ['lib/trackers/gh.ts'],
    carried: ['lib:realtime', 'other:realtime', 'lib:gone', 'ui:a11y', 'nope:code'],
    members,
  });
  // Root lenses in root panel order, then each member's in job.repos and panel order, then carried names.
  assert.deepEqual(r.lenses, ['code', 'security', 'docs', 'tests', 'lib:realtime', 'lib:code', 'lib:perf', 'ui:a11y', 'lib:gone']);
  assert.deepEqual(r.reasons, {
    code: ['always'],
    security: ['paths lib/trackers/**: lib/trackers/gh.ts'],
    docs: ['paths *.md: lib/README.md'],
    tests: ['always'],
    'lib:realtime': ['approach lib/src/api.rs', 'paths src/**: lib/src/dsp.rs (+1 more)', 'carried'],
    'lib:code': ['approach lib/src/api.rs'],
    'lib:perf': ['always'],
    'ui:a11y': ['suggested', 'carried'],
    'lib:gone': ['carried'],
  });
  // Without members, a qualified carried name is dropped and today's rows are unchanged.
  const plain = choosePanel({ kind: 'feature', config: PANEL, suggested: ['lib:realtime'], approachPaths: [], changed: [], carried: ['lib:realtime'] });
  assert.deepEqual(plain.lenses, ['code', 'tests']);
  // A subsumed entry whose root lens isn't in the root panel adds nothing.
  const lone = choosePanel({ kind: 'feature', config: config([{ name: 'code', always: true }]), suggested: [], approachPaths: [], changed: [], carried: [], members: [{ repo: 'lib', changed: ['x.md'], lenses: [ml('lib', 'docs', { paths: ['*.md'] }, true)] }] });
  assert.deepEqual(lone, { lenses: ['code'], reasons: { code: ['always'] } });
});
