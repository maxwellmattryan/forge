// `step` as a table (issue #68): fixture state → the action it must return. The rows live in
// test/step-rows.ts; the rule tables in lib/step/ (order: lib/step/order.ts, pinned in
// test/step-tables.test.ts). Every rule ID in RULES is what step returns for at least one row
// ("every transition has a row"), and every row's commands are checked for shell safety
// ("emitted commands are shell-safe"). A row's `command`/`start` names the subcommand, the job and
// only the flags that decide it: argvMatch (test/step-rows.ts) ignores the flags a row leaves out.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RULES, hasSpecDeltas, listLineCount, parsePlan, parseSpecHeader, roundLenses, selectPanel, shellLine, step } from '#engine/pipeline/step.ts';
import type { Job } from '#core/types.ts';
import type { StepAction } from '#engine/pipeline/types.ts';
import { fixture, verdicts } from './step-fixture.ts';
import { DS_CHECKED, DS_VERIFY, OPEN_PR, PANEL_SET, SPEC_DONE, ag, argvMatch, assertWant, atIntegrate, dsConfig, entered, ev, inReview, job, panelled, recallSkips, rows, run, scoped, vr } from './step-rows.ts';
import type { Row } from './step-rows.ts';

// DS1's negative cases: another rule decides, so they can't be `rows`.
const ds1Skips: Row[] = [
  { name: 'DS1 not when the last check names every candidate', fx: { config: dsConfig, job: job(DS_VERIFY), events: [DS_CHECKED(4, ['app-a'], ['app-b'])] }, want: { rule: 'V1' } },
  { name: 'DS1 not when downstream.enabled is false', fx: { config: (c) => { dsConfig(c); c.downstream.enabled = false; }, job: job(DS_VERIFY) }, want: { rule: 'V1' } },
  { name: 'DS1 not for an eval job', fx: { config: dsConfig, job: job({ ...DS_VERIFY, kind: 'eval' }) }, want: {} },
  { name: 'DS1 not in a single-repo project', fx: { job: job(DS_VERIFY) }, want: { rule: 'V1' } },
  { name: 'DS1 not in plan', fx: { config: dsConfig, job: job({ stage: 'plan' }) }, want: {} },
  { name: 'DS1 not in spec', fx: { config: dsConfig, job: job({ stage: 'spec', agents: SPEC_DONE }), events: [PANEL_SET] }, want: {} },
  { name: 'DS1 not in review', fx: { config: dsConfig, job: inReview() }, want: {} },
  { name: 'DS1 not in pr', fx: { config: dsConfig, job: job({ stage: 'pr', round: 1, verifyRuns: [vr(1, 10, true)] }) }, want: {} },
];

for (const row of ds1Skips) {
  test(row.name, () => {
    const a = step(fixture(row.fx)) as any;
    assert.notEqual(a.rule, 'DS1', row.name);
    assertWant(a, row.want, row.name);
    assertSafe(a, row.name);
  });
}

const SAFE = /^[A-Za-z0-9 ._:/@=,+\-[\]"]*$/;

function assertSafe(a: StepAction, name: string) {
  const argv = a.action === 'run' ? a.command : a.action === 'spawn' ? a.start : [];
  for (const el of argv) {
    assert.match(el, SAFE, `${name}: ${el}`);
    assert.ok(!el.includes("'"), `${name}: ${el}`);
    for (const bad of ["a';touch x;'", '$(id)', '`x`', '$(rm', 'x; rm']) assert.ok(!el.includes(bad), `${name}: ${el} contains ${bad}`);
  }
  if (a.action === 'run') assert.equal(a.shell, shellLine(a.command));
  if (a.action === 'spawn') assert.equal(a.startShell, shellLine(a.start));
  if (a.action === 'spawn') for (const s of a.spawns ?? []) assertSafe(s, `${name} › ${s.role}`);
}

for (const row of rows) {
  test(row.name, () => {
    const a = step(fixture(row.fx)) as any;
    const prefix = row.name.split(' ')[0];
    if ((RULES as readonly string[]).includes(prefix)) assert.equal(a.rule, prefix, `${row.name}: decided by ${a.rule}`);
    assertWant(a, row.want, row.name);
    row.check?.(a);
    assertSafe(a, row.name);
  });
}

// RV9's negative cases: another rule decides, so they can't be `rows` (whose name prefix is the deciding rule).
const rv9Skips: Row[] = [
  { name: 'RV9 a current panel moves on to RV2', fx: { job: inReview(), events: [panelled] }, want: { ...run('job', 'scope', 'j'), rule: 'RV2' } },
  { name: 'RV9 skipped once a reviewer of this round has started', fx: { job: inReview({ 'reviewer:code': ag(1, 12) }), events: [ev('scope', 11, { round: 1 })] }, want: { action: 'spawn', rule: 'RV4', role: 'reviewer:tests' } },
  { name: 'RV9 skipped once the verdicts are recorded', fx: { job: inReview({}, { verdicts: { 1: { code: 'PASS', tests: 'PASS' } } }), events: [ev('scope', 11, { round: 1 })] }, want: { rule: 'RV8c' } },
  { name: 'RV9 skipped on a PR rework under changed', fx: { job: inReview({}, { pr: OPEN_PR }), events: [ev('scope', 11, { round: 1 })] }, want: { action: 'spawn', rule: 'RV4', role: 'reviewer:code' } },
  { name: 'RV9 skipped on a PR rework under none', fx: { config: (c) => (c.review.onPrFeedback = 'none'), job: inReview({}, { pr: OPEN_PR }) }, want: { rule: 'RV1' } },
];

for (const row of recallSkips) {
  test(row.name, () => {
    const a = step(fixture(row.fx)) as any;
    assert.ok(!['RC1', 'RC2'].includes(a.rule), `${row.name}: decided by ${a.rule}`);
    assertWant(a, row.want, row.name);
    // No gate at all is "not checked", never "none": that would claim the diff changes no reviewer prompts.
    const line =
      row.fx.job?.kind === 'eval'
        ? 'Reviewer recall: not checked (an eval job)'
        : row.fx.recall?.fixtures === false
          ? 'Reviewer recall: not checked (no recall fixtures in the main checkout)'
          : 'Reviewer recall: none (the diff changes no reviewer prompts)';
    assert.ok(a.brief.split('\n').includes(line), `${line}\n${a.brief}`);
    assertSafe(a, row.name);
  });
}

for (const row of rv9Skips) {
  test(row.name, () => {
    const a = step(fixture(row.fx)) as any;
    assert.notEqual(a.rule, 'RV9', row.name);
    assertWant(a, row.want, row.name);
    assertSafe(a, row.name);
  });
}

// B7's negative cases and its tell: another rule decides, so they can't be `rows`.
const b7Skips: Row[] = [
  {
    name: "B7 a person's rework past the ceiling opens one round",
    fx: { job: job({ stage: 'build', round: 5, maxRounds: 2, agents: { builder: ag(4, 5, 6) } }), events: [ev('round', 7), ev('human', 8, { action: 'rework', actor: { login: 'alice', source: 'cli' } }), ev('round', 9)] },
    want: { action: 'spawn', rule: 'B4', role: 'builder' },
  },
  {
    name: 'B7 tell names the ceiling and a human',
    fx: { job: job({ stage: 'build', round: 5, maxRounds: 2, state: 'waiting', waitingOn: 'rounds-exhausted' }) },
    want: { action: 'wait', rule: 'G4b', tell: 'j reached the total-round ceiling (4 rounds): only a human may clear it. /forge approve j to ship, or /forge rework j <note>' },
  },
  { name: 'B7 a round within the ceiling parks on B2', fx: { job: job({ stage: 'build', round: 4, maxRounds: 2, agents: { builder: ag(3, 5, 6) } }), events: [ev('round', 7)] }, want: { rule: 'B2' } },
];

for (const row of b7Skips) {
  test(row.name, () => {
    const a = step(fixture(row.fx)) as any;
    assert.notEqual(a.rule, 'B7', row.name);
    assertWant(a, row.want, row.name);
    assertSafe(a, row.name);
  });
}

// IG1 must not run `forge integrate` again once this episode integrated: another rule decides, so not `rows`.
const ig1Skips: Row[] = [
  {
    name: "IG1 runs once when integrated shares the entry's millisecond",
    fx: { job: atIntegrate(), events: [entered, ev('integrated', 30, { behind: 0 })] },
    want: { ...run('job', 'set', 'j', '--stage', 'decide', '--state', 'running'), rule: 'IG3' },
  },
];

for (const row of ig1Skips) {
  test(row.name, () => {
    const a = step(fixture(row.fx)) as any;
    assert.notEqual(a.rule, 'IG1', row.name);
    assertWant(a, row.want, row.name);
    assertSafe(a, row.name);
  });
}

// The pr-review wait a CI rework cap leaves: G3 waits, so the PR5 tell rows can't be `rows`.
const CAP_REASON = 'CI rework cap: 3 CI reworks in a row, checks still failing on PR #3: lint, unit tests and 2 more. A human decides';
const prTellRows: Row[] = [
  {
    name: 'PR5 tell: a CI rework cap names the failing checks',
    fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', round: 1, pr: OPEN_PR, reason: CAP_REASON }) },
    want: { action: 'wait', rule: 'G3c', tell: `j PR https://github.com/o/r/pull/3 waits on review\nj: ${CAP_REASON}. /forge rework j <note> once a human has looked` },
  },
  {
    name: 'PR5 tell: a reason outside the cap class is never echoed',
    fx: { job: job({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', round: 1, pr: OPEN_PR, reason: 'CI rework cap: `$(id)`' }) },
    want: { action: 'wait', rule: 'G3c', tell: 'j PR https://github.com/o/r/pull/3 waits on review\nj: CI rework cap reached. /forge rework j <note> once a human has looked' },
  },
];

for (const row of prTellRows) {
  test(row.name, () => {
    const a = step(fixture(row.fx)) as any;
    assertWant(a, row.want, row.name);
  });
}

test('every spawn carries an effort key', () => {
  const spawns = rows.map((row) => step(fixture(row.fx))).filter((a) => a.action === 'spawn');
  assert.ok(spawns.length > 20);
  for (const a of spawns) assert.ok(Object.hasOwn(a, 'effort'), `${a.rule} ${(a as any).role}`);
});

test('retry and integration spawns never batch', () => {
  let checked = 0;
  for (const row of rows) {
    const a = step(fixture(row.fx));
    if (a.action !== 'spawn') continue;
    const integration = row.fx.job?.stage === 'integrate' && a.role.startsWith('reviewer:');
    if (a.rule !== 'M1' && a.rule !== 'RV5' && !integration) continue;
    assert.ok(!Object.hasOwn(a, 'spawns'), `${row.name}: ${a.rule} ${a.role} carries spawns`);
    checked++;
  }
  assert.ok(checked >= 5, `only ${checked} retry or integration spawns checked`);
});

/** The IDs in `ids` that no row's fixture makes step return. */
function uncovered(ids: readonly string[], list: Row[]): string[] {
  const decided = new Set(list.map((row) => step(fixture(row.fx)).rule));
  return ids.filter((id) => !decided.has(id));
}

test('every transition has a row', () => {
  assert.deepEqual(uncovered(RULES, rows), []);
  // It counts what step returns, not row names: a row named P2b that P1 decides covers nothing.
  assert.deepEqual(uncovered(['P1', 'P2b'], [{ name: 'P2b only in name', fx: { job: job({ stage: 'plan' }) }, want: {} }]), ['P2b']);
});

test('emitted commands are shell-safe', () => {
  for (const row of rows) assertSafe(step(fixture(row.fx)), row.name);
  assert.equal(shellLine(['job', 'set', 'j', '--reason', 'spec ready', '--field', 'reviewers=["code"]']), `forge job set j --reason 'spec ready' --field 'reviewers=["code"]'`);
  assert.equal(shellLine(['verify', 'j']), 'forge verify j');
  for (const bad of ["it's", 'a;b', '$(id)', '`x`', 'a\nb', 'a|b', 'a&b', '~/x', 'a>b']) assert.throws(() => shellLine(['job', 'note', bad]), /unsafe argument/, bad);
});

test('a UI review starts the dev server once and stops it once', () => {
  // Plays runtime.json and the recorded verdicts through each action until step leaves the stage:
  // RV3 and RV7 must not alternate once the verdicts are in.
  const runtime: string[] = [];
  const reviewers = { 'reviewer:code': ag(1, 12, 13, { outputMissing: false }), 'reviewer:ui': ag(1, 12, 13, { outputMissing: false }) };
  const seen: string[] = [];
  let recorded = false;
  for (let i = 0; i < 10; i++) {
    const a = step(
      fixture({
        config: (c) => (c.commands.dev = 'npm run dev'),
        job: inReview(reviewers, { reviewers: ['code', 'ui'], ...(recorded ? { verdicts: { 1: { code: 'PASS', ui: 'PASS' } } } : {}) }),
        events: scoped,
        runtime: [...runtime],
        verdicts: { round: verdicts({ code: 'PASS', ui: 'PASS' }) },
      }),
    );
    seen.push(a.rule);
    if (a.rule === 'RV3') runtime.push('dev');
    else if (a.rule === 'RV6') recorded = true;
    else if (a.rule === 'RV7') runtime.length = 0;
    else break;
  }
  assert.deepEqual(seen, ['RV3', 'RV6', 'RV7', 'RV8c']);
});

test('three lost reviewers are retried back to back, then one wait', () => {
  // Plays each M1 through as its `agent start --retry`: the record becomes running and retried.
  const roles = ['reviewer:code', 'reviewer:tests', 'reviewer:security'];
  const agents: Job['agents'] = Object.fromEntries(roles.map((r) => [r, ag(1, 12, 13, { status: 'lost', outputMissing: true })]));
  const spawned: string[] = [];
  let last: any;
  for (let i = 0; i < 10; i++) {
    last = step(fixture({ job: inReview({ ...agents }, { reviewers: ['code', 'tests', 'security'] }), events: scoped }));
    if (last.rule !== 'M1') break;
    assert.equal(last.parallel, true);
    assert.equal(last.retry, true);
    spawned.push(last.role);
    agents[last.role] = ag(1, 14, undefined, { retry: true });
  }
  assert.deepEqual(spawned, roles);
  assert.equal(last.rule, 'G5');
  assert.equal(last.action, 'wait');
  assert.equal(last.waitingOn, 'agents');
  assert.deepEqual(last.running, [...roles].sort());

  // Every retry ends; code again wrote nothing: escalate, no fourth M1.
  agents['reviewer:code'] = ag(1, 14, 15, { retry: true, outputMissing: true });
  agents['reviewer:tests'] = ag(1, 14, 15, { retry: true, outputMissing: false });
  agents['reviewer:security'] = ag(1, 14, 15, { retry: true, outputMissing: false });
  const a = step(fixture({ job: inReview(agents, { reviewers: ['code', 'tests', 'security'] }), events: scoped, verdicts: { round: verdicts({ code: 'MISSING', tests: 'PASS', security: 'PASS' }) } })) as any;
  assert.equal(a.rule, 'M2');
  argvMatch(a.command, ['job', 'set', 'j', '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'reviewer code wrote no review'], 'M2');
});

test('the step-row matcher', () => {
  const argv = ['job', 'set', 'j', '--stage', 'pr', '--state', 'running', '--note', 'n', '--field', 'a=1', '--field', 'b=2', '--compact'];
  const ok = (want: string[]) => assert.doesNotThrow(() => argvMatch(argv, want, 'm'), JSON.stringify(want));
  const fails = (want: string[], why: RegExp) => assert.throws(() => argvMatch(argv, want, 'm'), why, JSON.stringify(want));
  ok(['job', 'set', 'j']);
  ok(['job', 'set', 'j', '--state', 'running', '--stage', 'pr']);
  ok(['job', 'set', 'j', '--field', 'b=2', '--compact', '--field', 'a=1']);
  fails(['job', 'set', 'k'], /positionals differ/);
  fails(['job', 'set'], /positionals differ/);
  fails(['job', 'set', 'j', '--stage', 'decide'], /no --stage "decide"/);
  fails(['job', 'set', 'j', '--reason', 'x'], /no --reason/);
  fails(['job', 'set', 'j', '--field', 'a=1', '--field', 'a=1'], /no --field "a=1"/);
  fails(['job', 'set', 'j', '--compact', '--compact'], /no --compact/);
  // The flag's value is its own, never the next flag.
  fails(['job', 'set', 'j', '--stage'], /no --stage/);
  assert.throws(() => argvMatch(undefined, ['verify', 'j'], 'm'), /actual: undefined/);
});

test('loadStepInput parsers read plan, spec header and design deltas', () => {
  assert.deepEqual(parsePlan('PLAN: SPLIT\nSize: L\n\n## Jobs            (only for SPLIT)\n1. A — x. Depends on: -\n2. B — y. Depends on: #1\n\n## External\n- None\n'), { verdict: 'SPLIT', jobs: 2, recommendSplit: false });
  assert.deepEqual(parsePlan('PLAN: SINGLE\n## External\n- Recommend splitting: (a) x (b) y\n'), { verdict: 'SINGLE', jobs: 0, recommendSplit: true });
  assert.deepEqual(parsePlan('# no plan line\n'), { verdict: null, jobs: 0, recommendSplit: false });
  const header = parseSpecHeader('# T\n\nSize: L\nServices: -\nNeeds design: yes\nSuggested reviewers: code, tests, UI , evil;rm\n\n## Goal\nSize: S\n');
  assert.deepEqual(header, { size: 'L', complexity: null, needsDesign: true, components: [], suggested: ['code', 'tests', 'UI', 'evil;rm'] });
  assert.equal(parseSpecHeader('Size: M\nComplexity: High\n').complexity, 'high', 'stored lowercase');
  assert.equal(parseSpecHeader('Size: M\nComplexity: extreme\n').complexity, 'extreme', 'SP3 decides validity');
  assert.deepEqual(parseSpecHeader('Components: dashboard, cli\n').components, ['dashboard', 'cli']);
  assert.deepEqual(parseSpecHeader('Services: api, web\n').components, ['api', 'web'], 'an older spec reads the same way');
  assert.deepEqual(parseSpecHeader('Services: api\nComponents: web\n').components, ['web'], 'Components: wins over Services:');
  assert.equal(hasSpecDeltas('## Spec deltas\n"None"\n## Open questions\nx\n'), false);
  assert.equal(hasSpecDeltas('## Spec deltas\n- None.\n'), false);
  assert.equal(hasSpecDeltas('## Spec deltas\n- AC3 needs an empty state\n'), true);
  assert.equal(hasSpecDeltas('# Design\n'), false);
});

test('roundLenses and selectPanel are pure helpers', () => {
  const f = fixture({ job: { reviewers: ['code', 'tests', 'security'] } });
  assert.deepEqual(roundLenses(f.job, f.config), ['code', 'tests', 'security']);
  assert.deepEqual(roundLenses({ reviewers: [], pr: null }, f.config), ['code', 'tests']);
  assert.deepEqual(selectPanel({ ...f, spec: { ...f.spec, suggested: ['security'] } }), ['code', 'tests', 'security']);
});

test('listLineCount counts list and heading lines inside blockquotes', () => {
  assert.equal(listLineCount('> - a\n> - b\n> ## c\nplain'), 3);
  assert.equal(listLineCount('- a\n1. b\n# c'), 3);
  assert.equal(listLineCount('>\n> plain\n>-not a list'), 0);
  const t0 = performance.now();
  assert.equal(listLineCount(`${' >'.repeat(5_000)}x`), 0);
  assert.ok(performance.now() - t0 < 1000, 'stays linear on a 10k-character hostile line');
});
