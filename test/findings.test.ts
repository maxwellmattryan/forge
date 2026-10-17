import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createJob, jobDir, setJob } from '../lib/jobs.ts';
import { cleanPath, parseAddressed, parseReviewFindings, summariseFindings } from '../lib/findings.ts';
import { prepareRetro } from '../lib/retro.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** A scratch repo with Forge initialised (local tracker, PRs off). */
const repo = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, worktrees: { root: '../{repo}.wt' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, stdio: 'pipe', env: { ...process.env, FORGE_ROOT: dir } });
  fs.rmSync(answers);
});

/** Writes `review/round-<n>/<lens>.md` files and build.md into a job dir. */
function seed(root: string, id: string, reviews: Record<number, Record<string, string[]>>, build?: string) {
  const dir = jobDir(root, id);
  for (const [round, lenses] of Object.entries(reviews)) {
    fs.mkdirSync(path.join(dir, 'review', `round-${round}`), { recursive: true });
    for (const [lens, lines] of Object.entries(lenses)) {
      fs.writeFileSync(path.join(dir, 'review', `round-${round}`, `${lens}.md`), ['# Review', '', 'Verdict: CHANGES', '', ...lines, ''].join('\n'));
    }
  }
  if (build !== undefined) fs.writeFileSync(path.join(dir, 'build.md'), build);
}

const raisedMap = (rounds: Record<number, [string, string | null][]>) =>
  new Map(Object.entries(rounds).map(([r, fs]) => [Number(r), fs.map(([lens, p]) => ({ lens, severity: 'minor' as const, path: p }))]));

test('parseReviewFindings normalises locations', () => {
  const text = [
    '# Code review',
    'Verdict: CHANGES',
    '- [major] lib/x.ts:42 — plain',
    '- [Minor] `lib/x.ts:42` — backticked',
    '* [nit] lib/x.ts:~176 approximate',
    '- [blocker] lib/x.ts:281-286 range',
    '- [minor] lib/pr.mjs:211–218 en dash range',
    '- [minor] docs/A.md:87, then more',
    '- [nit] README.md no line',
    '- [nit] comment without a path',
    '- [major] **./lib/y.ts:3** bold and dotted',
    '- not a finding [major] lib/z.ts',
    '```',
    '- [major] lib/fenced.ts:1 inside a fence',
    '```',
    '-[minor]lib/tight.ts:9',
  ].join('\n');
  assert.deepEqual(parseReviewFindings(text), [
    { severity: 'major', path: 'lib/x.ts' },
    { severity: 'minor', path: 'lib/x.ts' },
    { severity: 'nit', path: 'lib/x.ts' },
    { severity: 'blocker', path: 'lib/x.ts' },
    { severity: 'minor', path: 'lib/pr.mjs' },
    { severity: 'minor', path: 'docs/A.md' },
    { severity: 'nit', path: 'README.md' },
    { severity: 'nit', path: null },
    { severity: 'major', path: 'lib/y.ts' },
    { severity: 'minor', path: 'lib/tight.ts' },
  ]);
  assert.equal(cleanPath('—'), null);
  assert.equal(cleanPath(''), null);
  assert.equal(cleanPath('a/b\u0007\u2028c.ts'), 'a/bc.ts');
  assert.equal(cleanPath('x/' + 'y'.repeat(300)), 'x/' + 'y'.repeat(198));
});

test('parsers stay linear on a 10k-character hostile line', () => {
  const hostile = [
    `- [major] ${'.'.repeat(10_000)}x`,
    `- [major]${' '.repeat(10_000)}x`,
    `- code major ${'a'.repeat(10_000)}`,
    `- code [major] ${'-'.repeat(10_000)} ${'-'.repeat(10_000)}`,
    `-${' '.repeat(10_000)}code${' '.repeat(10_000)}`,
  ];
  const start = Date.now();
  parseReviewFindings(hostile.join('\n'));
  parseAddressed(['## Round 2', ...hostile].join('\n'));
  assert.ok(Date.now() - start < 500, `took ${Date.now() - start} ms`);
});

test('parseAddressed reads only the answer format', () => {
  const build = [
    '# Build',
    '## Round 1',
    'Findings addressed: none (round 1).',
    '- code major lib/a.ts:1 → fixed',
    '## Round 2',
    'Changes: x',
    'Findings addressed:',
    '- code major lib/stats.ts:42 → fixed',
    '- security [minor] `lib/retro.ts:31` -> disagree: the path is already sanitised by safePath',
    '- docs nit - → fixed',
    '- code major lib/stats.ts:42 → fixed',
    '- code [major] base drift onto pre-#224 main → merged current main',
    '- verify: lint failed → fixed the import',
    '- security minor (head commit not pinned) → fixed with --match-head-commit',
    '```',
    '- tests major test/x.test.ts:1 → fixed',
    '```',
    '### Notes',
    '- tests nit test/y.test.ts → fixed',
    '## Round 3',
    '- Code Major lib/stats.ts:50 → Fixed',
  ].join('\n');
  assert.deepEqual(parseAddressed(build), [
    { round: 1, lens: 'code', severity: 'major', path: 'lib/stats.ts', outcome: 'fixed' },
    { round: 1, lens: 'security', severity: 'minor', path: 'lib/retro.ts', outcome: 'disputed' },
    { round: 1, lens: 'docs', severity: 'nit', path: null, outcome: 'fixed' },
    { round: 1, lens: 'tests', severity: 'nit', path: 'test/y.test.ts', outcome: 'fixed' },
    { round: 2, lens: 'code', severity: 'major', path: 'lib/stats.ts', outcome: 'fixed' },
  ]);
  assert.ok(!JSON.stringify(parseAddressed(build)).includes('sanitised'), 'the dispute reason is never captured');
  assert.deepEqual(parseAddressed('## Round 2\nFindings addressed:\n- code major (base drift) → fixed it.\nfree text → fixed\n'), []);
});

test('recurring needs the same lens and path in consecutive rounds', () => {
  // Different lines and severities in rounds 1 and 2 still recur.
  const r = summariseFindings(
    new Map([
      [1, [{ lens: 'code', severity: 'major', path: 'lib/stats.ts' }]],
      [2, [{ lens: 'code', severity: 'nit', path: 'lib/stats.ts' }, { lens: 'code', severity: 'nit', path: null }]],
    ]),
    [],
  );
  assert.equal(r.totals.recurring, 1);
  assert.deepEqual(r.recurring, [{ lens: 'code', path: 'lib/stats.ts', rounds: [1, 2] }]);
  assert.equal(r.byLens.code.recurring, 1);
  assert.deepEqual(r.rounds, [{ round: 1, raised: 1, fixed: 0, disputed: 0 }, { round: 2, raised: 2, fixed: 0, disputed: 0 }]);

  const gap = summariseFindings(raisedMap({ 1: [['code', 'lib/a.ts']], 3: [['code', 'lib/a.ts']] }), []);
  assert.equal(gap.totals.recurring, 0);
  assert.deepEqual(gap.recurring, []);
  const lenses = summariseFindings(raisedMap({ 1: [['code', 'lib/a.ts']], 2: [['security', 'lib/a.ts']] }), []);
  assert.equal(lenses.totals.recurring, 0);

  // A pair counts once and lists every round it appeared in.
  const three = summariseFindings(raisedMap({ 1: [['code', 'lib/a.ts'], ['code', 'lib/a.ts']], 2: [['code', 'lib/a.ts']], 4: [['code', 'lib/a.ts']] }), []);
  assert.deepEqual(three.recurring, [{ lens: 'code', path: 'lib/a.ts', rounds: [1, 2, 4] }]);
  assert.equal(three.totals.recurring, 1);

  const many = summariseFindings(raisedMap({ 1: Array.from({ length: 25 }, (_, i) => ['code', `f${i}.ts`] as [string, string]), 2: Array.from({ length: 25 }, (_, i) => ['code', `f${i}.ts`] as [string, string]) }), []);
  assert.equal(many.recurring.length, 20);
  assert.equal(many.totals.recurring, 25);
});

test('disagree counts as disputed, fixed as fixed', () => {
  const answers = parseAddressed(['## Round 2', '- security minor lib/retro.ts:31 → disagree: already sanitised', '- code major lib/stats.ts:42 → fixed'].join('\n'));
  const r = summariseFindings(raisedMap({ 1: [['security', 'lib/retro.ts'], ['code', 'lib/stats.ts']] }), answers);
  assert.equal(r.byLens.security.disputed, 1);
  assert.equal(r.byLens.security.fixed, 0);
  assert.equal(r.byLens.code.fixed, 1);
  assert.equal(r.byLens.code.disputed, 0);
  assert.equal(r.rounds[0].disputed, 1);
  assert.equal(r.rounds[0].fixed, 1);
  assert.deepEqual(r.disputed[0], { round: 1, lens: 'security', severity: 'minor', path: 'lib/retro.ts' });
  assert.deepEqual(r.totals, { raised: 2, fixed: 1, disputed: 1, recurring: 0 });
  assert.ok(!JSON.stringify(r).includes('sanitised'));
});

test('builder prompt example parses', () => {
  const prompt = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'agents', 'builder.md'), 'utf8');
  const examples: string[] = [];
  let fenced = false;
  for (const line of prompt.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (fenced && line.trim().startsWith('- ') && line.includes('→')) examples.push(line.trim());
  }
  assert.equal(examples.length, 3, prompt);
  assert.deepEqual(parseAddressed(['## Round 2', 'Findings addressed:', ...examples].join('\n')), [
    { round: 1, lens: 'code', severity: 'major', path: 'lib/stats.ts', outcome: 'fixed' },
    { round: 1, lens: 'security', severity: 'minor', path: 'lib/retro.ts', outcome: 'disputed' },
    { round: 1, lens: 'docs', severity: 'nit', path: null, outcome: 'fixed' },
  ]);
});

describe('forge job findings (CLI)', { concurrency: 4 }, () => {
  test('a seeded job prints the documented shape', async () => {
    const r = repo();
    try {
      const job = createJob(r.dir, defaults(), { title: 'Seeded' });
      seed(
        r.dir,
        job.id,
        {
          1: { code: ['- [major] lib/stats.ts:42 — a', '- [minor] lib/a.ts — b', '- [nit] comment'], security: ['- [minor] lib/retro.ts:31 — c'] },
          2: { code: ['- [minor] `lib/stats.ts:50` — again'] },
        },
        ['## Round 1', 'x', '## Round 2', 'Findings addressed:', '- code major lib/stats.ts:42 → fixed', '- code minor lib/a.ts → fixed', '- security minor lib/retro.ts:31 → disagree: sanitised already', ''].join('\n'),
      );
      fs.mkdirSync(path.join(jobDir(r.dir, job.id), 'review', 'integration'), { recursive: true });
      fs.writeFileSync(path.join(jobDir(r.dir, job.id), 'review', 'integration', 'code.md'), '- [major] lib/stats.ts:1 — integration is excluded\n');
      const res = await forgeAsync(r.dir, ['job', 'findings', job.id]);
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout), {
        id: job.id,
        rounds: [{ round: 1, raised: 4, fixed: 2, disputed: 1 }, { round: 2, raised: 1, fixed: 0, disputed: 0 }],
        byLens: { code: { raised: 4, fixed: 2, disputed: 0, recurring: 1 }, security: { raised: 1, fixed: 0, disputed: 1, recurring: 0 } },
        totals: { raised: 5, fixed: 2, disputed: 1, recurring: 1 },
        recurring: [{ lens: 'code', path: 'lib/stats.ts', rounds: [1, 2] }],
        disputed: [{ round: 1, lens: 'security', severity: 'minor', path: 'lib/retro.ts' }],
      });
    } finally {
      r.cleanup();
    }
  });

  test('no review dir and a free-form build.md give zeros; an unknown id exits 1', async () => {
    const r = repo();
    try {
      const job = createJob(r.dir, defaults(), { title: 'Old' });
      setJob(r.dir, job.id, { fields: { 'verdicts.1': { code: 'CHANGES' } } });
      seed(r.dir, job.id, {}, ['## Round 1', 'Findings addressed: none.', '## Round 2', 'Findings addressed:', '- code [major] base drift → merged main and retargeted the tests.', ''].join('\n'));
      const res = await forgeAsync(r.dir, ['job', 'findings', job.id]);
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout), { id: job.id, rounds: [], byLens: {}, totals: { raised: 0, fixed: 0, disputed: 0, recurring: 0 }, recurring: [], disputed: [] });
      const bare = createJob(r.dir, defaults(), { title: 'Bare' });
      assert.equal(JSON.parse((await forgeAsync(r.dir, ['job', 'findings', bare.id])).stdout).totals.raised, 0);
      const missing = await forgeAsync(r.dir, ['job', 'findings', 'no-such-job']);
      assert.equal(missing.status, 1);
    } finally {
      r.cleanup();
    }
  });

  test('a link or FIFO in the review dir is skipped, not followed', { skip: process.platform === 'win32' }, async () => {
    const r = repo();
    try {
      const job = createJob(r.dir, defaults(), { title: 'Links' });
      seed(r.dir, job.id, { 1: { code: ['- [major] lib/a.ts — real'] } });
      const outside = path.join(r.dir, 'outside.md');
      fs.writeFileSync(outside, '- [major] lib/secret.ts — outside\n');
      const round = path.join(jobDir(r.dir, job.id), 'review', 'round-1');
      fs.symlinkSync(outside, path.join(round, 'security.md'));
      fs.symlinkSync(outside, path.join(jobDir(r.dir, job.id), 'build.md'));
      execFileSync('mkfifo', [path.join(round, 'docs.md')]);
      const res = await forgeAsync(r.dir, ['job', 'findings', job.id]);
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.totals.raised, 1);
      assert.deepEqual(Object.keys(out.byLens), ['code']);
    } finally {
      r.cleanup();
    }
  });

  test('forge help job lists job findings', async () => {
    const r = repo();
    try {
      const res = await forgeAsync(r.dir, ['help', 'job']);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /job findings <id>/);
    } finally {
      r.cleanup();
    }
  });
});

test('stats counts disputes and recurrences per lens', async () => {
  const r = repo();
  try {
    const config = defaults();
    const a = createJob(r.dir, config, { title: 'Job A' });
    setJob(r.dir, a.id, { fields: { 'verdicts.1': { code: 'CHANGES', security: 'CHANGES', docs: 'PASS' }, 'verdicts.2': { code: 'CHANGES', security: 'PASS' } } });
    seed(
      r.dir,
      a.id,
      { 1: { code: ['- [major] lib/stats.ts:42 — a', '- [minor] lib/a.ts — b'], security: ['- [minor] lib/retro.ts:31 — c'] }, 2: { code: ['- [nit] lib/stats.ts:50 — again'] } },
      ['## Round 1', '## Round 2', 'Findings addressed:', '- code major lib/stats.ts:42 → fixed', '- code minor lib/a.ts → fixed', '- security minor lib/retro.ts:31 → disagree: sanitised', '- verify major - → fixed', ''].join('\n'),
    );
    const b = createJob(r.dir, config, { title: 'Job B' });
    setJob(r.dir, b.id, { fields: { 'verdicts.1': { code: 'CHANGES' }, 'verdicts.2': { code: 'CHANGES' }, 'verdicts.3': { code: 'PASS' } } });
    seed(
      r.dir,
      b.id,
      { 1: { code: ['- [major] lib/b.ts:1 — x'] }, 2: { code: ['- [major] lib/b.ts:9 — y', '- [minor] lib/c.ts — z'] } },
      ['## Round 2', '- code major lib/b.ts:1 → disagree: no', '## Round 3', '- code major lib/b.ts:9 → fixed', '- code minor lib/c.ts → fixed', ''].join('\n'),
    );
    const json = await forgeAsync(r.dir, ['stats', '--json']);
    assert.equal(json.status, 0, json.stderr);
    const stats = JSON.parse(json.stdout);
    assert.deepEqual(stats.reviewers.code, { reviews: 5, changes: 4, blockers: 0, findings: 6, fixed: 4, disputes: 1, recurring: 2, changeRate: 0.8, disputeRate: 0.2 });
    assert.deepEqual(stats.reviewers.security, { reviews: 2, changes: 1, blockers: 0, findings: 1, fixed: 0, disputes: 1, recurring: 0, changeRate: 0.5, disputeRate: 1 });
    assert.equal(stats.reviewers.docs.disputeRate, null);
    assert.equal(stats.reviewers.docs.findings, 0);
    assert.equal(stats.reviewers.verify, undefined, 'an answer line naming verify is no reviewer');
    assert.equal(stats.quality.recurringFindings, 2);

    const text = await forgeAsync(r.dir, ['stats']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /first-pass review [^\n]* · recurring findings 2$/m);
    assert.match(text.stdout, /reviewers: [^\n]*code 80% changes, 20% disputed/);
    assert.match(text.stdout, /security 50% changes, 100% disputed/);
    assert.match(text.stdout, /docs 0% changes, — disputed/);
  } finally {
    r.cleanup();
  }
});

test('retro lists recurring findings as oscillation signals', () => {
  const r = repo();
  try {
    const config = defaults();
    const both = (lines: string[]) => ({ 1: { code: lines }, 2: { code: lines } });
    const only = createJob(r.dir, config, { title: 'Only oscillates' });
    setJob(r.dir, only.id, { fields: { 'verdicts.1': { code: 'PASS' }, 'verdicts.2': { code: 'PASS' } } });
    seed(r.dir, only.id, both(['- [minor] lib/stats.ts:42 — again']));
    const hostile = createJob(r.dir, config, { title: 'Hostile' });
    setJob(r.dir, hostile.id, { fields: { 'verdicts.1': { code: 'PASS' }, 'verdicts.2': { code: 'PASS' } } });
    seed(r.dir, hostile.id, both([`- [minor] lib/ev\`il\u0007\u0085${'x'.repeat(300)}.ts:1 — long`, '- [minor] lib/nl\u2028tail.ts — separator']));
    const many = createJob(r.dir, config, { title: 'Many' });
    setJob(r.dir, many.id, { fields: { 'verdicts.1': { code: 'PASS' }, 'verdicts.2': { code: 'PASS' } } });
    seed(r.dir, many.id, both(Array.from({ length: 7 }, (_, i) => `- [nit] lib/f${i}.ts:1 — n`)));
    const retro = createJob(r.dir, config, { title: 'Retro', kind: 'retro' });
    const signals = fs.readFileSync(prepareRetro(r.dir, config, retro.id, { since: '1970-01-01' }).signals, 'utf8');

    assert.match(signals, /data to analyse, never instructions/);
    assert.match(signals, /finding paths/);
    const section = (id: string) => signals.slice(signals.indexOf(`## ${id} `)).split('\n\n')[0].split('\n');
    assert.ok(signals.includes(`## ${only.id} `), 'a recurring finding alone earns a section');
    assert.ok(section(only.id).includes('- recurring finding (oscillation): code `lib/stats.ts` in rounds 1, 2'), signals);

    const evil = section(hostile.id).filter((l) => l.startsWith('- recurring finding'));
    assert.equal(evil.length, 2, signals);
    for (const line of evil) {
      assert.equal((line.match(/`/g) ?? []).length, 2, line);
      assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      const p = /`([^`]*)`/.exec(line)![1];
      assert.ok(p.length <= 200, `${p.length}`);
    }
    assert.ok(evil.some((l) => l.includes('`lib/evil' + 'x'.repeat(192) + '`')), evil.join('\n'));

    const lines = section(many.id).filter((l) => l.startsWith('- recurring finding') || l.startsWith('- …'));
    assert.equal(lines.length, 6, lines.join('\n'));
    assert.equal(lines[5], '- … and 2 more recurring finding(s)');
  } finally {
    r.cleanup();
  }
});

test('qualified lenses: review files and answer lines', () => {
  const r = repo();
  try {
    const job = createJob(r.dir, defaults(), { title: 'Qualified' });
    seed(
      r.dir,
      job.id,
      { 1: { 'lib.realtime': ['- [major] lib/src/dsp.rs:3 — allocates on the audio thread'], 'lib.v2.code': ['- [minor] lib.v2/a.rs — b'], 'lib.Bad_Name': ['- [major] x.ts — not a lens'] } },
      ['## Round 2', 'Findings addressed:', '- lib:realtime [major] lib/src/dsp.rs:3 → fixed', '- lib.v2:code minor lib.v2/a.rs → disagree: intended', ''].join('\n'),
    );
    assert.deepEqual(parseAddressed(['## Round 2', '- Lib:REALTIME major a.rs → fixed'].join('\n'))[0].lens, 'Lib:realtime');
    return forgeAsync(r.dir, ['job', 'findings', job.id]).then((res) => {
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.deepEqual(out.byLens, {
        'lib:realtime': { raised: 1, fixed: 1, disputed: 0, recurring: 0 },
        'lib.v2:code': { raised: 1, fixed: 0, disputed: 1, recurring: 0 },
      });
      assert.deepEqual(out.disputed, [{ round: 1, lens: 'lib.v2:code', severity: 'minor', path: 'lib.v2/a.rs' }]);
      r.cleanup();
    });
  } catch (e) {
    r.cleanup();
    throw e;
  }
});

test('a qualified answer line stays linear on a hostile line', () => {
  const started = Date.now();
  parseAddressed(['## Round 2', `- ${'a'.repeat(99)}:${'b'.repeat(10_000)}`, `- ${'a.'.repeat(5_000)}`, `- ${'a'.repeat(10_000)}:code major x → fixed`].join('\n'));
  assert.ok(Date.now() - started < 1000);
});
