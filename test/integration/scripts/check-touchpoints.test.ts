// scripts/check-touchpoints.ts: the touchpoint rules decide by the diff, the change list is read from git's
// output, the base is picked and refused as documented, and the spawned check exits by what is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from '../../helpers.ts';
import { check, parseChanges, pickBase, RULES } from '../../../scripts/check-touchpoints.ts';
import type { Change } from '../../../scripts/check-touchpoints.ts';

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'check-touchpoints.ts');

const ch = (file: string, added: string[] = [], removed: string[] = [], status: Change['status'] = 'M'): Change => ({ path: file, status, added, removed });

const FIELD = ['  name: string;'];
const API_STEP = ch('lib/api/versions.ts', ["  { id: 'api-38' },"]);
const CONFIG_STEP = ch('lib/core/versions/config.ts', ["  { id: 'new-key', up: (c) => c },"]);
const MOVED_TYPE = ['/** A job row. */', 'export interface Row {', '  id: string;', '}'];
const MOVED_FN = ['export function notes(x: string): string {', '  return x.trim();', '}'];
const PIN = (sha: string, v: string) => `      - uses: actions/checkout@${sha} # ${v}`;

// [what, rule id, changes, whether that rule reports a finding]
const ROWS: [string, string, Change[], boolean][] = [
  ['a field added to an /api shape', 'api-version', [ch('lib/api/job.ts', FIELD)], true],
  ['a new untracked /api module', 'api-version', [ch('lib/api/extra.ts', ['export interface X {', '  a: string;', '}'], [], 'A')], true],
  ['an /api module deleted', 'api-version', [ch('lib/api/stats.ts', [], ['export interface Stats {', '  n: number;', '}'], 'D')], true],
  ['a field added with its API_CHANGES step', 'api-version', [ch('lib/api/job.ts', FIELD), API_STEP], false],
  ['only comments edited', 'api-version', [ch('lib/api/job.ts', ['/** Who acted, now in lib/x.ts. */', '  // why'], ['/** Who acted, in lib/y.ts. */', ' * old'])], false],
  ['only imports edited', 'api-version', [ch('lib/api/jobs.ts', ["import type { Job, Progress } from './job.ts';"], ["import type { Job } from './job.ts';"])], false],
  ['only re-exports added', 'api-version', [ch('lib/api/types.ts', ["export type * from './extra.ts';", "export type { Row } from './jobs.ts';", "export * from './x.ts';"])], false],
  ['a type moved unchanged from jobs.ts to job.ts', 'api-version', [ch('lib/api/jobs.ts', [], MOVED_TYPE), ch('lib/api/job.ts', MOVED_TYPE.map((l) => `${l}  `))], false],
  ['only lib/api/tracker.ts edited', 'api-version', [ch('lib/api/tracker.ts', FIELD)], false],
  ['only an /api test edited', 'api-version', [ch('lib/api/constants.test.ts', ["  assert.equal(STAGES.length, 9);"])], false],
  ['a dotted config key added', 'config-step', [ch('lib/core/config/keys/docs.ts', ["  'git.depth': { doc: 'clone depth' },"])], true],
  ['a config key removed', 'config-step', [ch('lib/core/config/keys/docs.ts', [], ["  'git.depth': { doc: 'clone depth' },"])], true],
  ['a config key added with its config step', 'config-step', [ch('lib/core/config/keys/docs.ts', ["  'git.depth': {"]), CONFIG_STEP], false],
  ['a changed value of an existing KEY_DOCS key', 'config-step', [ch('lib/core/config/keys/docs.ts', ["  'git.base': { doc: 'the PR target' },"], ["  'git.base': { doc: 'PR target / integration branch' },"])], false],
  ['KEY_DOCS created whole', 'config-step', [ch('lib/core/config/keys/docs.ts', ['export const KEY_DOCS = {', "  git: { doc: 'x' },", "  'git.base': { doc: 'y' },", '};'], [], 'A')], false],
  ['a top-level config key added', 'config-disclosure', [ch('lib/core/config/keys/docs.ts', ["  mirror: { doc: 'a mirror' },"]), CONFIG_STEP], true],
  ['a top-level key added with its disclosure class', 'config-disclosure', [ch('lib/core/config/keys/docs.ts', ["  mirror: { doc: 'a mirror' },"]), ch('lib/core/config/fields.ts', ["  mirror: 'plain',"])], false],
  ['a quoted top-level key added with its disclosure class', 'config-disclosure', [ch('lib/core/config/keys/docs.ts', ["  'my-mirror': { doc: 'a mirror' },"]), ch('lib/core/config/fields.ts', ["  'my-mirror': 'path',"])], false],
  ['a new dotted key under an existing section', 'config-disclosure', [ch('lib/core/config/keys/docs.ts', ["  'git.depth': { doc: 'clone depth' },"])], false],
  ['a ci.yml step added', 'ci-docs', [ch('.github/workflows/ci.yml', ['      - name: Lint', '        run: npm run lint'])], true],
  ['a ci.yml step added with docs/CI.md', 'ci-docs', [ch('.github/workflows/ci.yml', ['        run: npm run lint']), ch('docs/CI.md', ['- lint'])], false],
  ['an action pin bump', 'ci-docs', [ch('.github/workflows/ci.yml', [PIN('b'.repeat(40), 'v2')], [PIN('a'.repeat(40), 'v1')])], false],
  ['a comment-only ci.yml edit', 'ci-docs', [ch('.github/workflows/ci.yml', ['# runs the verify list', '        run: npm ci # once'], ['# runs the list', '        run: npm ci  # setup'])], false],
  ['a 10k-space hostile ci.yml line', 'ci-docs', [ch('.github/workflows/ci.yml', [`x:${' '.repeat(10_000)}y`])], true],
  ['a release.yml change', 'release-docs', [ch('.github/workflows/release.yml', ['    timeout-minutes: 20'], ['    timeout-minutes: 10'])], true],
  ['a release.yml change with docs/RELEASES.md', 'release-docs', [ch('.github/workflows/release.yml', ['    timeout-minutes: 20']), ch('docs/RELEASES.md', ['x'])], false],
  ['a release script change', 'release-tests', [ch('scripts/release.ts', ["  const tag = `v${version}`;"])], true],
  ['a stable-tree script change', 'release-tests', [ch('scripts/stable-tree.ts', ['  return null;'])], true],
  ['a release script change with its integration test', 'release-tests', [ch('scripts/release-plan.ts', ['  return null;']), ch('test/integration/scripts/release.test.ts', ['x'])], false],
  ['a stable-tree script change with the release workflow invariant', 'release-tests', [ch('scripts/stable-tree.ts', ['  return null;']), ch('test/invariants/release-workflow.test.ts', ['x'])], false],
  ['a function moved unchanged from release.ts to release-plan.ts', 'release-tests', [ch('scripts/release.ts', ["import { notes } from './release-plan.ts';"], MOVED_FN), ch('scripts/release-plan.ts', MOVED_FN)], false],
  ['a price changed', 'pricing-asof', [ch('lib/integrations/claude/pricing.json', ['    "m": { "input": 4.0 },'], ['    "m": { "input": 5.0 },'])], true],
  ['a price changed with asOf', 'pricing-asof', [ch('lib/integrations/claude/pricing.json', ['  "asOf": "2026-10-23",', '    "m": { "input": 4.0 },'], ['  "asOf": "2026-10-06",', '    "m": { "input": 5.0 },'])], false],
  ['a tracker contract change', 'tracker-docs', [ch('lib/api/tracker.ts', ['  close(id: string): Promise<void>;'])], true],
  ['a tracker contract change with docs/TRACKERS.md', 'tracker-docs', [ch('lib/api/tracker.ts', ['  close(id: string): Promise<void>;']), ch('docs/TRACKERS.md', ['- close'])], false],
  ['a comment-only tracker edit', 'tracker-docs', [ch('lib/api/tracker.ts', ['// adapters read this'], ['// adapters use this'])], false],
];

test('each touchpoint rule fires only when its companion is missing', () => {
  const ids = RULES.map((r) => r.id);
  for (const [what, id, changes, fires] of ROWS) {
    assert.ok(ids.includes(id), `${what}: ${id} is not in RULES`);
    const finding = check(changes).find((f) => f.rule === id);
    assert.equal(Boolean(finding), fires, `${what}: ${id} ${fires ? 'fires' : 'stays quiet'}`);
  }
  for (const id of ids) {
    assert.ok(ROWS.some(([, rid, , fires]) => rid === id && fires), `${id} has a row where it fires`);
    assert.ok(ROWS.some(([, rid, , fires]) => rid === id && !fires), `${id} has a row where it stays quiet`);
  }

  // Findings come in rule order with their files sorted, and the config rules name their keys.
  const all = check([
    ch('.github/workflows/ci.yml', ['        run: npm run lint']),
    ch('lib/api/state.ts', FIELD),
    ch('lib/api/job.ts', FIELD),
    ch('lib/core/config/keys/docs.ts', ["  mirror: { doc: 'a' },", "  'git.depth': { doc: 'b' },"]),
  ]);
  assert.deepEqual(all.map((f) => [f.rule, f.files]), [
    ['api-version', ['lib/api/job.ts', 'lib/api/state.ts']],
    ['config-step', ['lib/core/config/keys/docs.ts']],
    ['config-disclosure', ['lib/core/config/keys/docs.ts']],
    ['ci-docs', ['.github/workflows/ci.yml']],
  ]);
  assert.match(all[1].fix, /^config keys git\.depth, mirror changed: /);
  assert.match(all[2].fix, /^give mirror a CONFIG_DISCLOSURE class/);
});

test('parseChanges reads renames, deletions and untracked files', () => {
  const nameStatus = ['M', 'lib/a.ts', 'R100', 'lib/old.ts', 'lib/new.ts', 'R090', 'lib/x.ts', 'lib/y.ts', 'D', 'lib/gone.ts', 'C075', 'lib/src.ts', 'lib/copy.ts', 'T', 'lib/link', ''].join('\0');
  const diff = [
    'diff --git a/lib/a.ts b/lib/a.ts',
    'index 1111111..2222222 100644',
    '--- a/lib/a.ts',
    '+++ b/lib/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/lib/x.ts b/lib/y.ts',
    'similarity index 90%',
    'rename from lib/x.ts',
    'rename to lib/y.ts',
    '--- a/lib/x.ts',
    '+++ b/lib/y.ts',
    '@@ -2,0 +3 @@',
    '+++ b/not-a-header',
    'diff --git a/lib/gone.ts b/lib/gone.ts',
    'deleted file mode 100644',
    'index 3333333..0000000',
    '--- a/lib/gone.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-one',
    '-two',
    '',
  ].join('\n');
  assert.deepEqual(parseChanges(nameStatus, diff, [{ path: 'notes.txt', text: 'a\nb\n' }, { path: 'empty.txt', text: '' }]), [
    { path: 'lib/a.ts', status: 'M', added: ['new'], removed: ['old'] },
    { path: 'lib/new.ts', from: 'lib/old.ts', status: 'R', added: [], removed: [] },
    { path: 'lib/y.ts', from: 'lib/x.ts', status: 'R', added: ['++ b/not-a-header'], removed: [] },
    { path: 'lib/gone.ts', status: 'D', added: [], removed: ['one', 'two'] },
    { path: 'lib/copy.ts', status: 'A', added: [], removed: [] },
    { path: 'lib/link', status: 'M', added: [], removed: [] },
    { path: 'notes.txt', status: 'A', added: ['a', 'b'], removed: [] },
    { path: 'empty.txt', status: 'A', added: [], removed: [] },
  ]);
  assert.throws(() => parseChanges(['R100', 'lib/old.ts', ''].join('\0'), '', []), /truncated/);
});

test('pickBase picks and refuses base refs', () => {
  const known = new Set(['main', 'origin/develop', 'develop', 'HEAD^1']);
  const has = (ref: string) => known.has(ref);
  const picks: [string, Parameters<typeof pickBase>[0], string][] = [
    ['--base first', { base: 'main', env: { FORGE_TOUCHPOINTS_BASE: 'HEAD^1' }, resolves: has }, 'main'],
    ['then the env', { env: { FORGE_TOUCHPOINTS_BASE: 'HEAD^1' }, resolves: has }, 'HEAD^1'],
    ['then origin/develop', { env: {}, resolves: has }, 'origin/develop'],
    ['then develop', { env: {}, resolves: (r) => r === 'develop' }, 'develop'],
  ];
  for (const [what, opts, ref] of picks) assert.deepEqual(pickBase(opts), { ref }, what);

  const refused: [string, Parameters<typeof pickBase>[0]][] = [
    ['nothing resolves', { env: {}, resolves: () => false }],
    ['an unresolvable --base', { base: 'nope', env: {}, resolves: has }],
    ['an unresolvable env base', { env: { FORGE_TOUCHPOINTS_BASE: 'nope' }, resolves: has }],
    ['an unresolvable --base, even with a good env', { base: 'nope', env: { FORGE_TOUCHPOINTS_BASE: 'main' }, resolves: has }],
  ];
  for (const bad of ['', '-x', '--output=out.txt', 'a b', 'a\tb', 'main\n', 'a\x01b', 'a\x7fb']) {
    refused.push([`--base ${JSON.stringify(bad)}`, { base: bad, env: {}, resolves: () => true }]);
    refused.push([`env ${JSON.stringify(bad)}`, { env: { FORGE_TOUCHPOINTS_BASE: bad }, resolves: () => true }]);
  }
  for (const [what, opts] of refused) {
    const got = pickBase(opts);
    assert.ok('error' in got, what);
    assert.doesNotMatch(got.error, /[\x00-\x1f]/, `${what}: the message is one clean line`);
  }
});

test('check:touchpoints exits by what the diff is missing', () => {
  const repo = tempRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-touchpoints-')));
  const env = { ...process.env };
  delete env.FORGE_TOUCHPOINTS_BASE;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo.dir, env: { ...env, ...extra }, encoding: 'utf8' });
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, rel), body);
  };
  const JOB = 'export interface Job {\n  id: string;\n}\n';
  const VERSIONS = "export const API_CHANGES = [\n  { id: 'api-2' },\n] as const;\n";
  try {
    write('lib/api/job.ts', JOB);
    write('lib/api/versions.ts', VERSIONS);
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'seed');

    const clean = run(['--base', 'main']);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /^touchpoints: ok, 0 changed files since main \([0-9a-f]{7}\)\n$/);

    // An untracked symlink is never read, so the code it points at changes nothing.
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(outside, 'shape.ts'), 'export interface Leak {\n  a: string;\n}\n');
      fs.symlinkSync(path.join(outside, 'shape.ts'), path.join(repo.dir, 'lib/api/link.ts'));
      const link = run(['--base', 'main']);
      assert.equal(link.status, 0, link.stdout);
      fs.rmSync(path.join(repo.dir, 'lib/api/link.ts'));
    }

    write('lib/api/job.ts', JOB.replace('}', '  name: string;\n}'));
    write('lib/api/extra.ts', 'export interface Extra {\n  a: string;\n}\n');
    const missing = run([], { FORGE_TOUCHPOINTS_BASE: 'main' });
    assert.equal(missing.status, 1, missing.stderr);
    const lines = missing.stdout.split('\n');
    assert.match(lines[0], /^touchpoints: 1 missing since main \([0-9a-f]{7}\)$/);
    assert.equal(lines[1], 'api-version: lib/api/extra.ts, lib/api/job.ts');
    assert.match(lines[2], /^ {2}fix: append \{ id: '<kebab-id>' \} to API_CHANGES in lib\/api\/versions\.ts/);
    assert.equal(missing.stderr, '');

    write('lib/api/versions.ts', VERSIONS.replace('] as const', "  { id: 'x' },\n] as const"));
    const fixed = run(['--base', 'main']);
    assert.equal(fixed.status, 0, fixed.stdout);
    assert.match(fixed.stdout, /^touchpoints: ok, 3 changed files since main /);

    // Refusals: one stderr line, nothing on stdout, and no option smuggled through a ref.
    for (const args of [['--base', 'nope'], ['--base', '--output=out.txt'], ['--head', 'nope'], ['--json'], ['--base']]) {
      const r = run(args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.stdout, '', args.join(' '));
      assert.match(r.stderr, /^touchpoints: [^\n]+\n$/, args.join(' '));
    }
    assert.equal(run([], { FORGE_TOUCHPOINTS_BASE: '' }).status, 2, 'an empty env base');
    assert.ok(!fs.existsSync(path.join(repo.dir, 'out.txt')), '--base --output=out.txt wrote no file');

    // Threat model: config and attributes that reshape diff output, and a replace object that makes the
    // branch tip read as the base, leave a committed api change without a step flagged.
    repo.git('checkout', '-q', '--', '.');
    fs.rmSync(path.join(repo.dir, 'lib/api/extra.ts'));
    repo.git('checkout', '-qb', 'feat');
    write('lib/api/job.ts', JOB.replace('}', '  name: string;\n}'));
    repo.git('commit', '-qam', 'field');
    for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['color.diff', 'always'], ['diff.external', 'false']]) repo.git('config', k, v);
    write('.gitattributes', '* -diff\n');
    const tip = repo.git('rev-parse', 'HEAD').toString().trim();
    const base = repo.git('rev-parse', 'main').toString().trim();
    repo.git('replace', tip, base);
    assert.equal(repo.git('diff', '--name-only', 'main', 'HEAD').toString(), '', 'the replace object hides the change from a plain diff');
    const hostile = run(['--base', 'main', '--head', 'HEAD']);
    assert.equal(hostile.status, 1, hostile.stderr);
    assert.match(hostile.stdout, /\napi-version: lib\/api\/job\.ts\n/);

    // No merge base: a branch with unrelated history.
    repo.git('checkout', '-q', '--orphan', 'lone');
    repo.git('commit', '-qm', 'lone');
    const lone = run(['--base', 'main', '--head', 'lone']);
    assert.equal(lone.status, 2, lone.stdout);
    assert.match(lone.stderr, /no merge base .*fetch-depth: 2/);
  } finally {
    repo.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
