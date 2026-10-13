import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { acCoverage, buildAcTable, specAcs } from '../lib/acs.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

const SPEC4 = [
  '# Spec',
  '## Behaviour',
  '- AC9 — not in the AC section',
  '## Acceptance criteria',
  '- [ ] AC1 — first · Proven by: `test/a.test.mjs` › "one"',
  '- [ ] AC2 — second',
  '  - a sub-bullet without an id',
  '- [ ] AC3 — third',
  '- [ ] AC4 — fourth',
  '## Out of scope',
  '- AC5 — not an AC',
].join('\n');

const table = (...rows) => ['| AC | Proof | Result |', '|---|---|---|', ...rows].join('\n');
const GAP_BUILD = ['# Build', '## Round 1', 'Changes: x', '', table('| AC1 | `test/a.test.mjs` › "one" | pass |', '| AC2 | manual: drawer at 375px | passed |', '| AC3 | `test/c.test.mjs` | fail |'), ''].join('\n');
const FULL_BUILD = ['## Round 1', table('| AC1, AC2 | `test/a.test.mjs` | pass |', '| AC3 | cmd | ok |', '| AC4 | screenshots/ac4.png | ✅ |'), ''].join('\n');

/** @param {string} dir */
function cli(dir) {
  const env = { ...process.env, FORGE_ROOT: dir };
  const f = (...args) => {
    const out = execFileSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env });
    try {
      return JSON.parse(out);
    } catch {
      return out.trim();
    }
  };
  const fails = (...args) => {
    try {
      execFileSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env });
    } catch (e) {
      assert.notEqual(e.status, 0);
      return String(e.stderr) + String(e.stdout);
    }
    assert.fail(`forge ${args.join(' ')} should have failed`);
  };
  return { f, fails };
}

/** A repo with forge initialised and one job; returns the job's dir. @param {string} dir */
function setup(dir) {
  const { f } = cli(dir);
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: `../${path.basename(dir)}.wt` } }));
  f('init', 'write', '--answers', answers);
  const job = f('job', 'new', '--title', 'AC check');
  return { id: job.id, jobDir: path.join(dir, job.dir) };
}

const cleanup = (repo) => {
  repo.cleanup();
  fs.rmSync(path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`), { recursive: true, force: true });
};

test('forge job acs: gap pair and complete pair (CLI)', () => {
  const repo = tempRepo();
  try {
    const { f } = cli(repo.dir);
    const { id, jobDir } = setup(repo.dir);
    fs.writeFileSync(path.join(jobDir, 'spec.md'), SPEC4);
    fs.writeFileSync(path.join(jobDir, 'build.md'), GAP_BUILD);
    let r = f('job', 'acs', id);
    assert.deepEqual(r, { id, total: 4, covered: 2, unmapped: ['AC4'], failing: ['AC3'], extra: [], round: 1, table: true, spec: true, build: true });
    fs.writeFileSync(path.join(jobDir, 'build.md'), FULL_BUILD);
    r = f('job', 'acs', id);
    assert.equal(r.covered, 4);
    assert.deepEqual(r.unmapped, []);
    assert.deepEqual(r.failing, []);
  } finally {
    cleanup(repo);
  }
});

test('latest round only; fenced examples ignored', () => {
  const full = table('| AC1 | t | pass |', '| AC2 | t | pass |', '| AC3 | t | pass |', '| AC4 | t | pass |');
  const stale = ['## Round 1', full, '', '## Round 2', 'Changes: rework, no table yet', ''].join('\n');
  let r = acCoverage(SPEC4, stale);
  assert.equal(r.round, 2);
  assert.equal(r.table, false);
  assert.deepEqual(r.unmapped, ['AC1', 'AC2', 'AC3', 'AC4']);
  assert.equal(r.covered, 0);

  r = acCoverage(SPEC4, ['## Round 1', table('| AC1 | t | fail |'), '## Round 2', full, ''].join('\n'));
  assert.equal(r.round, 2);
  assert.equal(r.covered, 4);

  // A level-3 heading stays inside the round; a later table in the same round wins.
  r = acCoverage(SPEC4, ['## Round 3', table('| AC1 | t | fail |'), '### Acceptance criteria', full, ''].join('\n'));
  assert.equal(r.round, 3);
  assert.equal(r.covered, 4);

  // A fenced example table, and a fenced `## Round 9`, are not evidence.
  const fencedBuild = ['## Round 1', '```', '## Round 9', table('| AC1 | t | pass |'), '```', '~~~md', full, '~~~', ''].join('\n');
  r = acCoverage(SPEC4, fencedBuild);
  assert.equal(r.round, 1);
  assert.equal(r.table, false);
  assert.equal(r.unmapped.length, 4);

  // A fenced heading can't open or close the spec's AC section, and fenced items don't count.
  const fencedSpec = ['## Approach', '```', '## Acceptance criteria', '- AC7 — example', '```', '## Acceptance criteria', '- AC1 — real', '```', '## Tasks', '- AC8 — still fenced', '```', '- AC2 — still inside', '## Tasks', '- AC3 — outside'].join('\n');
  assert.deepEqual(specAcs(fencedSpec), ['AC1', 'AC2']);

  // No round heading: the whole file is used.
  assert.equal(buildAcTable(table('| AC1 | t | pass |')).round, null);
  assert.equal(acCoverage(SPEC4, table('| AC1 | t | pass |')).covered, 1);
});

test('spec and table tolerance', () => {
  // Unlabelled checkbox ACs get positional ids; the section heading may be any level and longer.
  assert.deepEqual(specAcs('# S\n### Acceptance criteria (must all hold)\n- [ ] works\n- [x] still works\n* third\n#### Detail\n+ fourth\n## Next\n- no'), ['AC1', 'AC2', 'AC3', 'AC4']);
  // Labels normalise; unlabelled items are ignored once any item has a label; duplicates count once.
  const spec = ['## Acceptance Criteria', '- [ ] AC1 one', '- [ ] AC-3 three', '- [x] **AC4** four', '- AC5: five', '- ac 6 six', '- unlabelled', '- [ ] AC1 again', '    - AC7 indented four spaces is not an item'].join('\n');
  assert.deepEqual(specAcs(spec), ['AC1', 'AC3', 'AC4', 'AC5', 'AC6']);
  assert.deepEqual(specAcs('# no AC section\n- AC1'), []);

  // Columns by header name in any order; several ids in one cell; last row wins; extra ids.
  const build = [
    '## Round 1',
    '| ac | Status | Notes | Evidence |',
    '| :-- | --- | --- | --- |',
    '| AC1 | pass | x | `test/a.test.mjs` |',
    '| AC3, AC-4 | pass | x | cmd \\| with pipe |',
    '| AC5 | ok | x | - |',
    '| AC6 | yes | x | n/a |',
    '| AC1 | fail | x | `test/a.test.mjs` |',
    '| AC12 | pass | x | t |',
    'not a row',
    '| AC6 | pass | x | t |',
  ].join('\n');
  const t = buildAcTable(build);
  assert.equal(t.rows.AC4.proof, 'cmd \\| with pipe');
  assert.equal(t.rows.AC1.result, 'fail');
  assert.equal(t.rows.AC6.proof, 'n/a', 'rows stop at the first non-table line');
  const r = acCoverage(spec, build);
  assert.equal(r.total, 5);
  assert.equal(r.covered, 2); // AC3, AC4
  assert.deepEqual(r.unmapped, ['AC5', 'AC6']);
  assert.deepEqual(r.failing, ['AC1']);
  assert.deepEqual(r.extra, ['AC12']);

  // Default columns 2 and 3 when headers don't say; result words must start the cell.
  const plain = '| AC | What | Notes |\n|---|---|---|\n| AC1 | t | passing |\n| AC2 | t | ok |\n| AC3 | `—` | pass |\n| AC4 | t | pending |';
  const p = acCoverage('## Acceptance criteria\n- AC1\n- AC2\n- AC3\n- AC4', plain);
  assert.deepEqual([p.covered, p.unmapped, p.failing], [1, ['AC3'], ['AC1', 'AC4']]);
  // A table whose first header isn't AC is not the AC table.
  assert.equal(buildAcTable('| Id | Proof | Result |\n|---|---|---|\n| AC1 | t | pass |').table, false);
});

test('missing files never throw and acs is read-only', () => {
  const repo = tempRepo();
  try {
    const { f, fails } = cli(repo.dir);
    const { id, jobDir } = setup(repo.dir);
    const events = path.join(jobDir, 'events.jsonl');
    const jobJson = path.join(jobDir, 'job.json');
    const before = { events: fs.readFileSync(events, 'utf8').split('\n').length, job: fs.readFileSync(jobJson), files: fs.readdirSync(jobDir).sort() };

    let r = f('job', 'acs', id);
    assert.deepEqual(r, { id, total: 0, covered: 0, unmapped: [], failing: [], extra: [], round: null, table: false, spec: false, build: false });

    fs.writeFileSync(path.join(jobDir, 'spec.md'), SPEC4);
    r = f('job', 'acs', id);
    assert.equal(r.build, false);
    assert.equal(r.spec, true);
    assert.deepEqual(r.unmapped, ['AC1', 'AC2', 'AC3', 'AC4']);

    fs.rmSync(path.join(jobDir, 'spec.md'));
    fs.writeFileSync(path.join(jobDir, 'build.md'), GAP_BUILD);
    r = f('job', 'acs', id);
    assert.equal(r.spec, false);
    assert.equal(r.total, 0);
    assert.deepEqual(r.extra, []);

    assert.equal(fs.readFileSync(events, 'utf8').split('\n').length, before.events, 'no event logged');
    assert.ok(fs.readFileSync(jobJson).equals(before.job), 'job.json unchanged');
    assert.deepEqual(fs.readdirSync(jobDir).filter((x) => x !== 'build.md').sort(), before.files, 'no file written');
    assert.match(fails('job', 'acs', 'no-such-job'), /no job "no-such-job"/);
  } finally {
    cleanup(repo);
  }
});

test('help lists acs', () => {
  const repo = tempRepo();
  try {
    const { f, fails } = cli(repo.dir);
    setup(repo.dir);
    assert.match(f('--help'), /forge job [^\n]*\|acs/);
    assert.match(fails('job', 'bogus'), /usage: forge job [^\n]*\|acs/);
  } finally {
    cleanup(repo);
  }
});

test('pathological lines parse in linear time', () => {
  // A heading whose long run of spaces ends in a non-space once took minutes (cubic backtracking);
  // a long whitespace-only line after a table header was quadratic in the separator check.
  const spaces = ' '.repeat(20_000);
  const spec = ['## Acceptance criteria', '- AC1 one', `# a${spaces}x`, `## a${spaces}#${spaces}x`, `- AC2${spaces}x`].join('\n');
  const build = ['## Round 1', `### b${spaces}x`, '| AC | Proof | Result |', ' '.repeat(100_000), table('| AC1 | t | pass |'), `## Round 2${spaces}x`, table('| AC1 | t | pass |')].join('\n');
  const started = performance.now();
  assert.deepEqual(specAcs(spec), ['AC1']);
  const r = acCoverage(['## Acceptance criteria', '- AC1'].join('\n'), build);
  const ms = performance.now() - started;
  assert.equal(r.round, 2);
  assert.equal(r.covered, 1);
  assert.ok(ms < 500, `parsing took ${Math.round(ms)} ms`);
});
