import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults, lensNeedsApp, panelPathsProblems, reviewerChecklist, validateConfig } from '#core/config/load.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { choosePanel, reworkPanel, selectPanel } from '#engine/pipeline/step.ts';
import type { Config } from '#core/types.ts';

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

test('choosePanel: pathsOnly lenses run on path hits only', () => {
  const c = config([
    { name: 'code', always: true },
    { name: 'security', when: 'lib/server.ts, anything that runs commands', paths: ['lib/server.ts', 'lib/trackers/**'], pathsOnly: true },
    { name: 'docs', paths: ['docs/**'] },
  ]);
  // SP3 (spec time): a suggestion or an Approach path never picks a pathsOnly lens.
  const spec = choosePanel({ kind: 'feature', config: c, suggested: ['security', 'docs'], approachPaths: ['lib/server.ts', 'lib/trackers/github.ts'], changed: null, carried: [] });
  assert.deepEqual(spec.lenses, ['code', 'docs']);
  assert.deepEqual(selectPanel({ job: { kind: 'feature' } as any, config: c, spec: { suggested: ['security'], approachPaths: ['lib/server.ts'] } as any }), ['code']);
  // RV9 (forge job panel): a diff hit does, with its reason; a suggestion still adds nothing.
  const hit = choosePanel({ kind: 'feature', config: c, suggested: ['security'], approachPaths: ['lib/server.ts'], changed: ['lib/server.ts'], carried: [] });
  assert.deepEqual(hit.lenses, ['code', 'security']);
  assert.deepEqual(hit.reasons.security, ['paths lib/server.ts: lib/server.ts']);
  // Carried and always still count.
  assert.deepEqual(choosePanel({ kind: 'feature', config: c, suggested: [], approachPaths: [], changed: [], carried: ['security'] }).reasons.security, ['carried']);
  const always = config([{ name: 'code', always: true, pathsOnly: true, paths: ['lib/**'] }]);
  assert.deepEqual(choosePanel({ kind: 'feature', config: always, suggested: [], approachPaths: [], changed: [], carried: [] }).lenses, ['code']);
  // pathsOnly false behaves as before.
  const off = config([{ name: 'security', paths: ['lib/server.ts'], pathsOnly: false }]);
  assert.deepEqual(choosePanel({ kind: 'feature', config: off, suggested: ['security'], approachPaths: [], changed: null, carried: [] }).lenses, ['security']);
});

test('review.panel pathsOnly validation', () => {
  const problems = (entry: Record<string, unknown>) => validateConfig(config([{ name: 'code', always: true }, { name: 'security', ...entry } as any]), ROOT).filter((p) => p.includes('pathsOnly'));
  assert.deepEqual(problems({ pathsOnly: true, paths: ['lib/server.ts'] }), []);
  assert.deepEqual(problems({ pathsOnly: false }), []);
  assert.deepEqual(problems({ pathsOnly: true }), ['review.panel "security".pathsOnly needs non-empty paths: a pathsOnly lens with none would never run']);
  assert.deepEqual(problems({ pathsOnly: true, paths: [] }), ['review.panel "security".pathsOnly needs non-empty paths: a pathsOnly lens with none would never run']);
  assert.deepEqual(problems({ pathsOnly: 'yes', paths: ['lib/**'] }), ['review.panel "security".pathsOnly must be true or false (got "yes")']);
});

const needsAppProblems = (problems: string[]) => problems.filter((p) => p.includes('needsApp'));

test('needsApp must be a boolean', () => {
  const cfg = defaults();
  cfg.review.panel.push({ name: 'ui', needsApp: 'yes' as any });
  assert.deepEqual(needsAppProblems(validateConfig(cfg, ROOT)), ['review.panel "ui".needsApp must be true or false (got "yes")']);

  for (const needsApp of [undefined, true, false]) {
    const ok = defaults();
    ok.review.panel.push(needsApp === undefined ? { name: 'ui' } : { name: 'ui', needsApp });
    assert.deepEqual(needsAppProblems(validateConfig(ok, ROOT)), [], `needsApp ${needsApp}`);
  }
});

test('the design lens has a plugin checklist', () => {
  const file = path.join(PLUGIN_ROOT, 'reviewers', 'design.md');
  // An empty dir: this repo's own .forge/reviewers/design.md would shadow the plugin's.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-panel-')));
  try {
    const cfg = defaults();
    cfg.review.panel.push({ name: 'design' });
    assert.deepEqual(validateConfig(cfg, dir).filter((p) => p.includes('design')), []);
    assert.equal(reviewerChecklist(dir, 'design'), file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lensNeedsApp defaults by name and honours the panel entry', () => {
  const cfg = defaults();
  for (const lens of ['ui', 'ux', 'accessibility', 'design']) assert.equal(lensNeedsApp(cfg, lens), true, `${lens} with no entry`);
  assert.equal(lensNeedsApp(cfg, 'code'), false);
  assert.equal(lensNeedsApp(cfg, 'visual-qa'), false);

  cfg.review.panel.push({ name: 'design' }, { name: 'ui', needsApp: false }, { name: 'visual-qa', needsApp: true });
  assert.equal(lensNeedsApp(cfg, 'design'), true, 'an entry with no key keeps the name default');
  assert.equal(lensNeedsApp(cfg, 'ui'), false);
  assert.equal(lensNeedsApp(cfg, 'visual-qa'), true);
});

// The rework panel's pure decision (review.onRework: narrow); test/integration/cli/panel.test.ts
// runs it through `forge job panel`.
const REWORK_PANEL = [
  { name: 'code', always: true },
  // Opts out of security's always-on-rework name default, so these tests can watch a passed lens
  // narrow; the shipped default is held by "the shipped default panel re-runs security".
  { name: 'security', paths: ['lib/server.ts', 'lib/trackers/**'], alwaysOnRework: false },
  { name: 'docs', paths: ['docs/**'] },
  { name: 'design', paths: ['*.svelte'] },
];
const REWORK_LENSES = ['code', 'security', 'docs'];
const MIXED: Record<string, any> = { code: 'PASS', security: 'PASS', docs: 'CHANGES' };

describe('rework panel', () => {
  test('the shipped default panel re-runs security on every rework round', () => {
    // defaults()'s security entry has no paths, so only its name default brings it back.
    const config = defaults();
    config.review.panel = [...defaults().review.panel, { name: 'docs' }];
    assert.equal(config.review.panel.find((p) => p.name === 'security')?.paths, undefined, 'the shipped security lens has no paths');
    const lenses = ['code', 'tests', 'security', 'docs'];
    const job = { round: 2, verdicts: { 1: { code: 'PASS', tests: 'CHANGES', security: 'PASS', docs: 'PASS' } }, pr: null, kind: 'feature' as const } as any;
    // A fix for a tests finding that also adds a process call in the server.
    const r = reworkPanel({ job, config, lenses, changedSince: ['test/a.test.ts', 'lib/server.ts'], members: 0 });
    assert.deepEqual(r, { rerun: ['code', 'tests', 'security'], reasons: { code: ['always'], tests: ['always', 'changes requested in round 1'], security: ['always on rework'] }, skipped: ['docs'] });
    // Round 3 too: a pass in round 2 never lets it drop.
    const r3 = reworkPanel({ job: { ...job, round: 3, verdicts: { ...job.verdicts, 2: { code: 'PASS', tests: 'CHANGES', security: 'PASS' } } }, config, lenses, changedSince: ['README.md'], members: 0 });
    assert.deepEqual(r3?.rerun, ['code', 'tests', 'security']);
    // An explicit opt-out narrows it like any other passed lens.
    config.review.panel = config.review.panel.map((p) => (p.name === 'security' ? { ...p, alwaysOnRework: false } : p));
    assert.deepEqual(reworkPanel({ job, config, lenses, changedSince: ['lib/server.ts'], members: 0 })?.skipped, ['security', 'docs']);
  });

  test('review.panel alwaysOnRework validation', () => {
    const config = defaults();
    const problems = (v: unknown) => {
      config.review.panel = [{ name: 'code', always: true }, { name: 'security', alwaysOnRework: v } as any];
      return validateConfig(config, ROOT).filter((p) => p.includes('alwaysOnRework'));
    };
    assert.deepEqual(problems(true), []);
    assert.deepEqual(problems(false), []);
    assert.deepEqual(problems('yes'), ['review.panel "security".alwaysOnRework must be true or false (got "yes")']);
  });

  test('a lens carried from an earlier round keeps its pass', () => {
    const config = defaults();
    config.review.panel = REWORK_PANEL;
    // Round 2 re-ran only code and docs; round 3 must not treat security as new.
    const job = { round: 3, verdicts: { 1: MIXED, 2: { code: 'PASS', docs: 'CHANGES' } }, pr: null, kind: 'feature' as const } as any;
    const r = reworkPanel({ job, config, lenses: REWORK_LENSES, changedSince: ['README.md'], members: 0 });
    assert.deepEqual(r, { rerun: ['code', 'docs'], reasons: { code: ['always'], docs: ['changes requested in round 2'] }, skipped: ['security'] });
  });
});
