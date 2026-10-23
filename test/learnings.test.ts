import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, jobDir, setJob } from '#core/job/store.ts';
import { expiredLearnings, learningSummary, ledgerItems, metricValue, parseExperiments, parseLearnings, validDate } from '#engine/evals/learnings.ts';
import { prepareRetro } from '#engine/evals/retro.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** A scratch repo with Forge initialised (local tracker, PRs off). */
const repo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, stdio: 'pipe', env: { ...process.env, FORGE_ROOT: dir } });
  fs.rmSync(answers);
});

const HEADER = [
  '# Forge learnings',
  '',
  '<!--',
  'Format:',
  '- **<rule>** — why, evidence: <job ids>. (added YYYY-MM-DD · experiment: <id> · review-by: YYYY-MM-DD)',
  '-->',
  '',
];

/** Copies of the five ledger lines in this repo's .forge/notes/experiments.md when this job ran, with ids. */
const LEDGER = [
  '- 2026-10-13 · id builder-hostile-input · builder addendum: hostile-input checklist for engine code (.forge/notes/builder.md) · metric reviewers.security.changeRate (down) · baseline 0.344 (11/32) · evidence daemon-per-job-with-detailed-alva, daemon-supervisor-config-migration-and-roz1, 1-verify-reports-test-integrity-deleted, 17-measure-the-human-delta-after, 7-eval-worktrees-leak-the-solution, 4-wave2-ac-ui-proof-model-diversity · status open',
  '- 2026-10-13 · id spec-threat-model · spec-writer addendum: guards state a threat model with one AC per bypass (.forge/notes/spec-writer.md) · metric quality.avgRounds (down) · baseline 1.59 · evidence 1-verify-reports-test-integrity-deleted, 15-auto-merge-must-not-bypass, daemon-supervisor-config-migration-and-roz1 · status open',
  '- 2026-10-13 · id spec-live-session-proof · spec-writer addendum: live Claude Code checks get a runnable proxy proof and move to Infra & rollout (.forge/notes/spec-writer.md) · metric quality.escalationRate (down) · baseline 0.318 (7/22; 3 for unproven live-session ACs) · evidence engine-ts-toolchain-and-foundation-lkmo, engine-ts-surface-modules-and-vnos, daemon-per-job-with-detailed-alva · status open',
  "- 2026-10-13 · id verify-base-config · learning: verify runs the base branch's commands, so specs list config edits as a human pre-step (.forge/notes/learnings.md) · metric quality.verifyFirstPassRate (up) · baseline 0.591 · evidence dashboard-svelte-5-view-port-aig1, engine-ts-surface-modules-and-vnos, dashboard-vite-build-pipeline-compiled-3qc3, dashboard-strict-typescript-helpers-and-3mxp · status open",
  '- 2026-10-13 · id docs-lens-narrow · config: narrow the docs lens `when` to CLI, config, /api and orchestrator changes (.forge/config.yml) · metric docs reviews per code review (down; guard: humanDeltaRate stays 0) · baseline 1.0 (35/35, docs changeRate 0) · evidence 35 docs reviews across all 22 reviewed jobs with 0 changes · status open',
];
const withoutId = (line: string) => line.replace(/ · id [a-z0-9-]+/, '');
/** Every expired line names the notes file its entry came from. */
const PREFIX = '- (notes/learnings.md) ';

function writeNotes(dir: string, learnings: string[], ledger: string[] = LEDGER) {
  const notes = path.join(dir, '.forge', 'notes');
  fs.writeFileSync(path.join(notes, 'learnings.md'), [...HEADER, ...learnings, ''].join('\n'));
  fs.writeFileSync(path.join(notes, 'experiments.md'), ['# Forge experiments', '', ...ledger, ''].join('\n'));
}

/** A repo with one reviewed job (1 round, so quality.avgRounds is 1) that has signals, and a retro job. */
function retroRepo(learnings: string[], ledger?: string[]) {
  const r = repo();
  const config = defaults();
  const job = createJob(r.dir, config, { title: 'Reviewed' });
  setJob(r.dir, job.id, { fields: { 'verdicts.1': { code: 'PASS' } } });
  fs.writeFileSync(path.join(jobDir(r.dir, job.id), 'questions.md'), '1. Which way?\n'); // gives the job its own signals section
  const retro = createJob(r.dir, config, { title: 'Retro', kind: 'retro' });
  writeNotes(r.dir, learnings, ledger);
  const prepare = (today = '2026-10-16') => {
    const res = prepareRetro(r.dir, config, retro.id, { since: '1970-01-01', today });
    return { res, signals: fs.readFileSync(res.signals, 'utf8'), stats: JSON.parse(fs.readFileSync(res.stats, 'utf8')) };
  };
  return { r, retro, prepare };
}

/** The lines of the expired-learnings section, or null when it is absent. */
function section(signals: string): string[] | null {
  const at = signals.indexOf('## Learnings past review-by\n');
  if (at < 0) return null;
  return signals.slice(at).split('\n\n')[0].split('\n').slice(1);
}

test('parses old and new learning entries', () => {
  const text = [
    ...HEADER,
    '- **Old rule** — why, evidence: a, b. (added 2026-10-12)',
    '- **New rule** — why, evidence: c. (added 2026-10-14 · experiment: spec-threat-model · review-by: 2026-11-11)',
    '- **Wrapped rule** — why, which runs on',
    '  to a second line, evidence: d. (added 2026-10-14 · experiment: verify-base-config',
    '  · review-by: 2026-11-01)',
    'Not an entry.',
    '- plain text entry without bold, review-by: 2026-02-30 and experiment: Bad_Id',
    '<!-- - **Commented out** (review-by: 2020-01-01) -->',
  ].join('\n');
  assert.deepEqual(parseLearnings(text), [
    { rule: 'Old rule', experiment: null, reviewBy: null, added: '2026-10-12' },
    { rule: 'New rule', experiment: 'spec-threat-model', reviewBy: '2026-11-11', added: '2026-10-14' },
    { rule: 'Wrapped rule', experiment: 'verify-base-config', reviewBy: '2026-11-01', added: '2026-10-14' },
    { rule: 'plain text entry without bold, review-by: 2026-02-30 and experiment: Bad_Id', experiment: null, reviewBy: null, added: null },
  ]);
  // The header's format example sits in a comment and is never counted.
  assert.deepEqual(parseLearnings(HEADER.join('\n')), []);
  assert.deepEqual(learningSummary(text), { count: 4, oldestReviewBy: '2026-11-01' });

  for (const bad of ['2026-13-45', '2026-02-30', '2026-1-01', '20261001', '']) assert.equal(validDate(bad), false, bad);
  for (const good of ['2026-10-16', '2024-02-29']) assert.equal(validDate(good), true, good);

  // Expiry includes today.
  const entries = parseLearnings(text);
  assert.deepEqual(expiredLearnings(entries, '2026-11-01').map((l) => l.rule), ['Wrapped rule']);
  assert.deepEqual(expiredLearnings(entries, '2026-10-31'), []);

  // An unclosed comment, or a long hostile line, parses in linear time.
  const started = Date.now();
  parseLearnings('<!--'.repeat(10_000) + '\n- **' + 'x'.repeat(10_000) + ' review-by: ' + '9'.repeat(10_000));
  parseExperiments('- ' + ' · metric '.repeat(5_000) + '(' + 'u'.repeat(10_000));
  assert.ok(Date.now() - started < 2000, 'linear on hostile input');
});

test('ledgerItems finds the open status in linear time on a hostile ledger', () => {
  const head = '- 2026-10-01 · id x · y · metric quality.avgRounds (down) · baseline 1';
  // About 1 MiB each: a continuation line of 200k leading blanks and decoys before the real segment,
  // and decoys split by a comment (so each maps back to the raw text) before 500k trailing blanks.
  const leading = `${head}\n${' '.repeat(200_000)}${'evidence status open '.repeat(40_000)}· status open\n`;
  const trailing = `${head} ·${' status <!---->open ·'.repeat(25_000)} status open${' '.repeat(500_000)}\n`;
  const started = Date.now();
  const [a] = ledgerItems(leading);
  const [b] = ledgerItems(trailing);
  assert.ok(Date.now() - started < 1000, `linear on hostile input (${Date.now() - started} ms)`);
  assert.deepEqual([a.statusSegment, a.openAt], ['status open', leading.lastIndexOf('status open')]);
  assert.deepEqual([b.statusSegment, b.openAt], ['status open', trailing.lastIndexOf('status open')]);
});

test('parses ledger entries with and without ids', () => {
  const expected = [
    { id: 'builder-hostile-input', metric: 'reviewers.security.changeRate', direction: 'down', baseline: 0.344, status: 'open' },
    { id: 'spec-threat-model', metric: 'quality.avgRounds', direction: 'down', baseline: 1.59, status: 'open' },
    { id: 'spec-live-session-proof', metric: 'quality.escalationRate', direction: 'down', baseline: 0.318, status: 'open' },
    { id: 'verify-base-config', metric: 'quality.verifyFirstPassRate', direction: 'up', baseline: 0.591, status: 'open' },
    { id: 'docs-lens-narrow', metric: 'docs reviews per code review', direction: 'down', baseline: 1, status: 'open' },
  ];
  const pick = ({ id, metric, direction, baseline, status }) => ({ id, metric, direction, baseline, status });
  const withIds = parseExperiments(['# Forge experiments', '<!-- - 2026-01-01 · id comment · x · status open -->', ...LEDGER].join('\n'));
  assert.deepEqual(withIds.map(pick), expected);
  assert.equal(withIds[0].date, '2026-10-13');
  assert.equal(withIds[0].change, 'builder addendum: hostile-input checklist for engine code (.forge/notes/builder.md)');
  assert.deepEqual(parseExperiments(LEDGER.map(withoutId).join('\n')).map(pick), expected.map((e) => ({ ...e, id: null })));
  // A baseline that carries its sample gives its denominator: `(11/32)` and `(7/22; …)`, not `(35/35, …)`.
  assert.deepEqual(withIds.map((e) => e.baselineN), [32, null, 22, null, null]);

  const odd = parseExperiments('- not-a-date · id Bad_Id · change · metric quality.avgRounds (sideways) · baseline n/a · status kept');
  assert.deepEqual(odd, [{ id: null, date: null, change: 'change', metric: 'quality.avgRounds', direction: null, baseline: null, baselineN: null, status: 'kept' }]);
});

test('metric paths read stats, and expired lines carry the open entries\' verdicts', () => {
  const stats = { quality: { avgRounds: 1.2, escalationRate: null, humanDeltaCoverage: { merged: 2 } }, reviewers: { code: { changeRate: 0.5 } } } as any;
  assert.equal(metricValue(stats, 'quality.avgRounds'), 1.2);
  assert.equal(metricValue(stats, 'reviewers.code.changeRate'), 0.5);
  assert.equal(metricValue(stats, 'quality.escalationRate'), null);
  for (const name of ['quality', 'quality.humanDeltaCoverage', 'quality.missing', 'docs reviews per code review', 'quality.__proto__', 'quality.constructor', 'constructor.name', 'quality.avgRounds.toFixed', '', 'a.' + 'b'.repeat(300)]) {
    assert.equal(metricValue(stats, name), undefined, name);
  }

  // Through prepareRetro: no job is done, so every open entry waits for samples.
  const ledger = [
    '- 2026-10-01 · id up-higher · x · metric quality.avgRounds (up) · baseline 0.5 · status open',
    '- 2026-10-01 · id down-higher · x · metric quality.avgRounds (down) · baseline 0.5 · status open',
    '- 2026-10-01 · id down-lower · x · metric quality.avgRounds (down) · baseline 1.5 · status open',
    '- 2026-10-01 · id equal · x · metric quality.avgRounds (down) · baseline 1 · status open',
    '- 2026-10-01 · id no-direction · x · metric quality.avgRounds · baseline 0.5 · status open',
  ];
  const ids = ['up-higher', 'down-higher', 'down-lower', 'equal', 'no-direction'];
  const { r, prepare } = retroRepo(ids.map((id) => `- **Rule ${id}** (added 2026-09-01 · experiment: ${id} · review-by: 2026-10-01)`), ledger);
  try {
    const { signals, stats: s } = prepare();
    assert.equal(s.quality.avgRounds, 1);
    assert.deepEqual(section(signals), [
      '- (notes/learnings.md) Rule up-higher · review-by 2026-10-01 · experiment up-higher · metric quality.avgRounds (up) · baseline 0.5 · current 1 · pending',
      '- (notes/learnings.md) Rule down-higher · review-by 2026-10-01 · experiment down-higher · metric quality.avgRounds (down) · baseline 0.5 · current 1 · pending',
      '- (notes/learnings.md) Rule down-lower · review-by 2026-10-01 · experiment down-lower · metric quality.avgRounds (down) · baseline 1.5 · current 1 · pending',
      '- (notes/learnings.md) Rule equal · review-by 2026-10-01 · experiment equal · metric quality.avgRounds (down) · baseline 1 · current 1 · pending',
      // No direction can never be settled by measurement.
      '- (notes/learnings.md) Rule no-direction · review-by 2026-10-01 · experiment no-direction · metric quality.avgRounds · baseline 0.5 · current 1 · inconclusive',
    ]);
  } finally {
    r.cleanup();
  }
});

test('retro prepare lists an expired learning with its baseline and current value', () => {
  const { r, prepare } = retroRepo([
    '- **Guards state a threat model** — why, evidence: x. (added 2026-10-13 · experiment: spec-threat-model · review-by: 2026-10-15)',
  ]);
  try {
    const { res, signals, stats } = prepare('2026-10-16');
    assert.equal(res.expiredLearnings, 1);
    assert.equal(stats.quality.avgRounds, 1);
    assert.deepEqual(section(signals), [
      '- (notes/learnings.md) Guards state a threat model · review-by 2026-10-15 · experiment spec-threat-model · metric quality.avgRounds (down) · baseline 1.59 · current 1 · pending',
    ]);
    // Between the window count and the per-job sections.
    const lines = signals.split('\n');
    const at = lines.indexOf('## Learnings past review-by');
    assert.equal(lines[at - 2], '1 job(s) in window.');
    const firstJob = lines.findIndex((l) => /^## (?!Learnings)/.test(l));
    assert.ok(firstJob > at, signals);
  } finally {
    r.cleanup();
  }
});

test('unexpired, undated and malformed learnings stay out of signals', () => {
  const { r, prepare } = retroRepo([
    '- **Future** (added 2026-10-13 · experiment: spec-threat-model · review-by: 2099-01-01)',
    '- **Undated** (added 2026-10-12)',
    '- **Malformed** (added 2026-10-13 · experiment: spec-threat-model · review-by: 2026-13-45)',
    '- **Impossible** (added 2026-10-13 · experiment: spec-threat-model · review-by: 2026-02-30)',
  ]);
  try {
    const { res, signals } = prepare('2026-10-16');
    assert.equal(res.expiredLearnings, 0);
    assert.equal(section(signals), null);
    assert.doesNotMatch(signals, /Learnings past review-by|Future|Undated|Malformed|Impossible/);

    // The rest of signals.md is what it was without any learnings.
    const notes = path.join(r.dir, '.forge', 'notes', 'learnings.md');
    fs.rmSync(notes);
    const missing = prepare('2026-10-16');
    assert.equal(missing.res.expiredLearnings, 0);
    assert.equal(missing.signals, signals);
  } finally {
    r.cleanup();
  }
});

test('expired learnings with missing experiments or metrics degrade to unknown', () => {
  const ledger = [
    LEDGER[4], // docs-lens-narrow: a prose metric
    '- 2026-10-01 · id proto · x · metric quality.__proto__ (down) · baseline 1 · status open',
    '- 2026-10-01 · id ctor · x · metric constructor.name (down) · baseline 1 · status open',
    '- 2026-10-01 · id nulled · x · metric quality.escalationRate (down) · baseline 0.3 · status open',
    '- 2026-10-01 · id nobase · x · metric quality.avgRounds (down) · baseline n/a · status open',
    '- 2026-10-01 · id spec-threat-model · a later copy · metric quality.avgRounds (up) · baseline 9 · status open',
    LEDGER[1],
  ];
  const { r, prepare } = retroRepo(
    [
      '- **No experiment** (added 2026-09-01 · review-by: 2026-10-01)',
      '- **Unknown experiment** (added 2026-09-01 · experiment: nope · review-by: 2026-10-01)',
      '- **Prose metric** (added 2026-09-01 · experiment: docs-lens-narrow · review-by: 2026-10-01)',
      '- **Proto path** (added 2026-09-01 · experiment: proto · review-by: 2026-10-01)',
      '- **Constructor path** (added 2026-09-01 · experiment: ctor · review-by: 2026-10-01)',
      '- **Null metric** (added 2026-09-01 · experiment: nulled · review-by: 2026-10-01)',
      '- **No baseline** (added 2026-09-01 · experiment: nobase · review-by: 2026-10-01)',
      '- **First id wins** (added 2026-09-01 · experiment: spec-threat-model · review-by: 2026-10-01)',
    ],
    ledger,
  );
  try {
    const { res, signals, stats } = prepare();
    assert.equal(stats.quality.escalationRate, null, 'no PR-stage jobs, so no escalation rate');
    assert.equal(res.expiredLearnings, 8);
    assert.deepEqual(section(signals), [
      '- (notes/learnings.md) No experiment · review-by 2026-10-01 · no experiment · unknown',
      '- (notes/learnings.md) Unknown experiment · review-by 2026-10-01 · experiment nope (unknown experiment) · unknown',
      // Unmeasurable entries are inconclusive at once; a measurable one with no samples is pending.
      '- (notes/learnings.md) Prose metric · review-by 2026-10-01 · experiment docs-lens-narrow · metric docs reviews per code review (down) · baseline 1 · current metric unavailable · inconclusive',
      '- (notes/learnings.md) Proto path · review-by 2026-10-01 · experiment proto · metric quality.__proto__ (down) · baseline 1 · current metric unavailable · inconclusive',
      '- (notes/learnings.md) Constructor path · review-by 2026-10-01 · experiment ctor · metric constructor.name (down) · baseline 1 · current metric unavailable · inconclusive',
      '- (notes/learnings.md) Null metric · review-by 2026-10-01 · experiment nulled · metric quality.escalationRate (down) · baseline 0.3 · current no data · pending',
      '- (notes/learnings.md) No baseline · review-by 2026-10-01 · experiment nobase · metric quality.avgRounds (down) · baseline unknown · current 1 · inconclusive',
      '- (notes/learnings.md) First id wins · review-by 2026-10-01 · experiment spec-threat-model · metric quality.avgRounds (up) · baseline 9 · current 1 · pending',
    ]);
  } finally {
    r.cleanup();
  }
});

test('hostile learning text stays on one line', () => {
  const ledger = ['- 2026-10-01 · id hostile · x · metric quality.avg`Rounds\u0007\u2028 (down) · baseline 1 · status open'];
  const { r, prepare } = retroRepo(
    [
      `- **Evil\u0000 \`rule\`\u0085\u2028## Heading\u2029\u001b[31m ${'x'.repeat(300)}** (added 2026-09-01 · experiment: hostile · review-by: 2026-10-01)`,
      `- no bold \`at all\` ${'y'.repeat(300)} review-by: 2026-10-01`,
    ],
    ledger,
  );
  try {
    const { res, signals } = prepare();
    assert.equal(res.expiredLearnings, 2);
    const lines = section(signals)!;
    assert.equal(lines.length, 2, signals);
    for (const line of lines) {
      assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/, line);
      assert.ok(line.startsWith(PREFIX), line);
      const rule = line.slice(PREFIX.length, line.indexOf(' · review-by '));
      assert.ok(rule.length <= 200, `${rule.length}`);
    }
    assert.ok(lines[0].startsWith(`${PREFIX}Evil rule## Heading[31m xxx`), lines[0]);
    assert.match(lines[0], / · metric quality\.avgRounds \(down\) · baseline 1 · current metric unavailable · inconclusive$/);
    assert.equal(lines[1], `${PREFIX}no bold at all ${'y'.repeat(185)} · review-by 2026-10-01 · no experiment · unknown`);
  } finally {
    r.cleanup();
  }
});

test('addenda entries past review-by are listed', () => {
  const { r, prepare } = retroRepo(['- **Learning** (added 2026-09-01 · experiment: spec-threat-model · review-by: 2026-10-16)']);
  try {
    const notes = path.join(r.dir, '.forge', 'notes');
    fs.writeFileSync(path.join(notes, 'builder.md'), '# Builder addendum\n\n- **Addendum rule** — why. (added 2026-09-01 · experiment: builder-hostile-input · review-by: 2026-10-10)\n- **Not yet** (review-by: 2099-01-01)\n');
    // Not a role's addendum: never read.
    fs.writeFileSync(path.join(notes, 'scratch.md'), '- **Stray** (added 2026-09-01 · experiment: spec-threat-model · review-by: 2026-10-01)\n');
    const { res, signals } = prepare('2026-10-16');
    assert.equal(res.expiredLearnings, 2, 'review-by today counts; the addendum counts; scratch.md does not');
    const lines = section(signals)!;
    assert.deepEqual(
      lines.map((l) => l.split(' · ')[0]),
      ['- (notes/learnings.md) Learning', '- (notes/builder.md) Addendum rule'],
    );
    assert.match(lines[1], / · experiment builder-hostile-input · metric reviewers\.security\.changeRate \(down\) · baseline 0\.344 · current metric unavailable · pending$/);
    assert.doesNotMatch(signals, /Stray|Not yet/);
  } finally {
    r.cleanup();
  }
});

test('retro prepare uses the experiment verdicts', () => {
  const ledger = [
    '- 2026-10-01 · id up-kept · x · metric counts.done (up) · baseline 0.5 · status open',
    '- 2026-10-01 · id down-reverted · x · metric counts.done (down) · baseline 0.5 · status open',
    '- 2026-10-01 · id prose · x · metric docs per code (down) · baseline 1 · status open',
    '- 2099-01-01 · id later · x · metric counts.done (up) · baseline 0.5 · status open',
    '- 2026-10-01 · id closed · x · metric counts.done (up) · baseline 0.5 · status kept (2026-10-10, n 5, bootstrap, diff 0.5..0.5)',
  ];
  const ids = ['up-kept', 'down-reverted', 'prose', 'later', 'closed'];
  const { r, retro, prepare } = retroRepo(ids.map((id) => `- **Rule ${id}** (added 2026-09-01 · experiment: ${id} · review-by: 2026-10-01)`), ledger);
  try {
    // Five done jobs after the entries' date: counts.done is 1 for each, so the bootstrap mean is 1.
    for (let i = 0; i < 5; i++) setJob(r.dir, createJob(r.dir, defaults(), { title: `Done ${i}` }).id, { state: 'done' });
    const notes = path.join(r.dir, '.forge', 'notes');
    const before = fs.readFileSync(path.join(notes, 'experiments.md'), 'utf8');
    const listing = fs.readdirSync(notes).sort();
    const { res, signals } = prepare('2026-10-16');
    assert.deepEqual(res.verdicts, { kept: 1, reverted: 1, inconclusive: 1, pending: 1 });
    const at = signals.indexOf('## Experiment verdicts\n');
    assert.ok(at >= 0, signals);
    assert.deepEqual(signals.slice(at).split('\n\n')[0].split('\n').slice(1), [
      '- up-kept · metric counts.done (up) · baseline 0.5 · n 5 · bootstrap · diff 0.5..0.5 · kept',
      '- down-reverted · metric counts.done (down) · baseline 0.5 · n 5 · bootstrap · diff 0.5..0.5 · reverted',
      '- prose · metric docs per code (down) · baseline 1 · n - · - · diff - · inconclusive',
      '- later · metric counts.done (up) · baseline 0.5 · n 0 · bootstrap · diff - · pending',
    ]);
    assert.deepEqual(
      section(signals)!.map((l) => l.split(' · ').pop()),
      ['kept', 'reverted', 'inconclusive', 'pending', 'status kept (2026-10-10, n 5, bootstrap, diff 0.5..0.5)'],
      'open entries show the dry-run verdict, a closed one its written status',
    );
    assert.equal(fs.readFileSync(path.join(notes, 'experiments.md'), 'utf8'), before, 'the ledger is never written');
    assert.deepEqual(fs.readdirSync(notes).sort(), listing, 'nor any other notes file');
    assert.ok(retro.id);
  } finally {
    r.cleanup();
  }
});

describe('retro prepare over the CLI', () => {
  test('retro prepare reports expiredLearnings over the CLI', async () => {
    const { r, retro } = retroRepo(['- **Expired** (added 2020-01-01 · experiment: spec-threat-model · review-by: 2020-02-01)', '- **Later** (review-by: 2099-01-01)']);
    try {
      const res = await forgeAsync(r.dir, ['retro', 'prepare', retro.id]);
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.expiredLearnings, 1);
      for (const key of ['stats', 'signals', 'experiments', 'jobsInWindow', 'since']) assert.ok(key in out, key);
      assert.match(fs.readFileSync(out.signals, 'utf8'), /## Learnings past review-by\n- \(notes\/learnings\.md\) Expired · review-by 2020-02-01 · experiment spec-threat-model/);
      assert.deepEqual(out.verdicts, { kept: 0, reverted: 0, inconclusive: 1, pending: 4 }, 'docs-lens-narrow is unmeasurable; the rest wait for samples');
    } finally {
      r.cleanup();
    }
  });
});
