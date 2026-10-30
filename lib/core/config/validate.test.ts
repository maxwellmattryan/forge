// validateConfig's checks for sections that have no validator file of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { foremanProblems, validateConfig } from './validate.ts';
import { defaults } from './keys/defaults.ts';
import { setConfigValue } from './set.ts';
import { FIELDS } from './fields.ts';

const seedProblems = (seed: unknown): string[] => {
  const c: any = defaults();
  c.worktrees.seed = seed;
  return validateConfig(c, os.tmpdir()).filter((p) => p.startsWith('worktrees.seed'));
};

const block = (over: Record<string, unknown> = {}) => ({ paths: ['node_modules'], key: ['package-lock.json'], setup: ['npm ls'], warm: [], ...over });

test('worktrees.seed problems', () => {
  const rows: [string, unknown, RegExp | null][] = [
    ['not a map', ['node_modules'], /^worktrees\.seed must be a map/],
    ['paths not a list', block({ paths: 'node_modules' }), /^worktrees\.seed\.paths must be a list/],
    ['an absolute path', block({ paths: ['/abs'] }), /^worktrees\.seed\.paths\[0\] must be a relative path/],
    ['a leading -', block({ paths: ['-x'] }), /^worktrees\.seed\.paths\[0\] must be a relative path/],
    ['a .. segment', block({ paths: ['a/../b'] }), /^worktrees\.seed\.paths\[0\] must have no empty, \. or \.\. segment/],
    ['inside .git', block({ paths: ['.git/x'] }), /^worktrees\.seed\.paths\[0\] must not be inside \.git/],
    ['a glob', block({ paths: ['a*'] }), /^worktrees\.seed\.paths\[0\] must be a relative path/],
    ['a duplicate', block({ paths: ['a', 'a'] }), /^worktrees\.seed\.paths lists "a" more than once/],
    ['a nested path', block({ paths: ['a', 'a/b'] }), /^worktrees\.seed\.paths entry "a\/b" sits inside "a"/],
    ['a key entry with a control character', block({ key: ['a\nb'] }), /^worktrees\.seed\.key\[0\] must be a relative path/],
    ['an empty setup entry', block({ setup: [''] }), /^worktrees\.seed\.setup must be a list of non-empty commands/],
    ['paths without a key', block({ key: [] }), /^worktrees\.seed\.key must name at least one file when worktrees\.seed\.paths is set$/],
    ['a valid block', block({ paths: ['node_modules', 'dist/cache'], warm: ['npm run typecheck'] }), null],
    ['the default (off)', { paths: [], key: [], setup: [], warm: [] }, null],
  ];
  for (const [name, seed, want] of rows) {
    const problems = seedProblems(seed);
    if (want === null) assert.deepEqual(problems, [], name);
    else assert.ok(problems.length === 1 && want.test(problems[0]), `${name}: ${JSON.stringify(problems)}`);
  }
});

test('merge.requiredChecks problems', () => {
  const problems = (list: unknown): string[] => {
    const c: any = defaults();
    c.merge.requiredChecks = list;
    return validateConfig(c, os.tmpdir()).filter((p) => p.startsWith('merge.requiredChecks'));
  };
  const rows: [string, unknown, RegExp | null][] = [
    ['the default', [], null],
    ['names and every binding', ['test', { name: 'slow', app: 'github-actions' }, { name: 'ci', workflow: '.github/workflows/ci.yaml' }, { name: 'ext', creator: 'ci-bot[bot]' }, { name: 'both', app: 'x', workflow: '.github/workflows/b.yml' }], null],
    ['not a list', 'test', /^merge\.requiredChecks must be a list/],
    ['an empty name', [''], /^merge\.requiredChecks\[0\] needs a non-empty name/],
    ['a non-string entry', [7], /^merge\.requiredChecks\[0\] must be a check name or a/],
    ['a map without a name', [{ app: 'x' }], /^merge\.requiredChecks\[0\] needs a non-empty name/],
    ['a non-string map name', [{ name: 3 }], /^merge\.requiredChecks\[0\] needs a non-empty name/],
    ['a name over 100 characters', ['x'.repeat(101)], /^merge\.requiredChecks\[0\] name must be at most 100 characters/],
    ['a control character', ['a\nb'], /^merge\.requiredChecks\[0\] name must have no control characters/],
    ['an unknown key', [{ name: 'x', apps: 'y' }], /^merge\.requiredChecks\[0\] has unknown key "apps"/],
    ['creator with app', [{ name: 'x', creator: 'bob', app: 'y' }], /^merge\.requiredChecks\[0\] binds creator together with app or workflow/],
    ['creator with workflow', [{ name: 'x', creator: 'bob', workflow: '.github/workflows/a.yml' }], /^merge\.requiredChecks\[0\] binds creator together with app or workflow/],
    ['a workflow outside .github/workflows', [{ name: 'x', workflow: 'ci.yml' }], /^merge\.requiredChecks\[0\]\.workflow must be a file under/],
    ['a nested workflow path', [{ name: 'x', workflow: '.github/workflows/a/b.yml' }], /^merge\.requiredChecks\[0\]\.workflow must be a file under/],
    ['an app with capitals', [{ name: 'x', app: 'GitHub' }], /^merge\.requiredChecks\[0\]\.app must be a GitHub App slug/],
    ['a creator with a space', [{ name: 'x', creator: 'a b' }], /^merge\.requiredChecks\[0\]\.creator must be a GitHub login/],
    ['a name twice', ['test', { name: 'test', app: 'x' }], /^merge\.requiredChecks lists "test" more than once/],
  ];
  for (const [name, list, want] of rows) {
    const got = problems(list);
    if (want === null) assert.deepEqual(got, [], name);
    else assert.ok(got.length === 1 && want.test(got[0]), `${name}: ${JSON.stringify(got)}`);
  }
});

test('relatedTests problems', () => {
  const problems = (edit: (r: any) => void): string[] => {
    const c: any = defaults();
    edit(c.relatedTests);
    return validateConfig(c, os.tmpdir()).filter((p) => p.startsWith('relatedTests'));
  };
  assert.deepEqual(problems(() => {}), [], 'defaults() validates clean');
  const rows: [string, (r: any) => void, RegExp | null][] = [
    ['a custom block', (r) => Object.assign(r, { tests: ['spec/**/*_spec.rb'], map: ['spec/{dir}/{name}_spec.rb'], full: [] }), null],
    ['tests not a list', (r) => (r.tests = '**/*.test.*'), /^relatedTests\.tests must be a list of non-empty strings/],
    ['an empty map entry', (r) => (r.map = ['{dir}/{name}.test.*', ' ']), /^relatedTests\.map must be a list of non-empty strings/],
    ['a non-string full entry', (r) => (r.full = [3]), /^relatedTests\.full must be a list of non-empty strings/],
    ['an unknown placeholder', (r) => (r.map = ['{dir}/{name}.test.*', '{root}/{name}.test.*', '{job}']), /^relatedTests\.map\[1\] may use only the \{dir\} and \{name\} placeholders/],
  ];
  for (const [name, edit, want] of rows) {
    const got = problems(edit);
    if (want === null) assert.deepEqual(got, [], name);
    else assert.ok(got.length === 1 && want.test(got[0]), `${name}: ${JSON.stringify(got)}`);
  }
  // Every field's problem is reported, one each.
  assert.equal(problems((r) => Object.assign(r, { tests: null, map: ['{x}'], full: [''] })).length, 3);
});

test('improve.transcripts problems', () => {
  const problems = (edit: (c: any) => void): string[] => {
    const c: any = defaults();
    edit(c);
    return validateConfig(c, os.tmpdir()).filter((p) => p.startsWith('improve.transcripts'));
  };
  assert.equal(defaults().improve.transcripts.max, 12);
  const range = /^improve\.transcripts\.max must be an integer from 0 to 50 \(got /;
  const rows: [string, (c: any) => void, RegExp | null][] = [
    ['the default', () => {}, null],
    ['0', (c) => (c.improve.transcripts.max = 0), null],
    ['50', (c) => (c.improve.transcripts.max = 50), null],
    ['51', (c) => (c.improve.transcripts.max = 51), range],
    ['negative', (c) => (c.improve.transcripts.max = -1), range],
    ['a fraction', (c) => (c.improve.transcripts.max = 1.5), range],
    ['a string', (c) => (c.improve.transcripts.max = '12'), range],
    ['not a map', (c) => (c.improve.transcripts = 12), /^improve\.transcripts must be a map/],
    ['a list', (c) => (c.improve.transcripts = [12]), /^improve\.transcripts must be a map/],
  ];
  for (const [name, edit, want] of rows) {
    const got = problems(edit);
    if (want === null) assert.deepEqual(got, [], name);
    else assert.ok(got.length === 1 && want.test(got[0]), `${name}: ${JSON.stringify(got)}`);
  }
});

test('foreman problems', () => {
  const problems = (edit: (f: any) => void): string[] => {
    const c: any = defaults();
    edit(c.foreman);
    return validateConfig(c, os.tmpdir()).filter((p) => p.startsWith('foreman.'));
  };
  assert.deepEqual(problems(() => {}), [], 'defaults() validates clean');
  const rows: [string, (f: any) => void, RegExp][] = [
    ['cadence 0', (f) => (f.cadence = 0), /^foreman\.cadence must be an integer 1-1440 \(got 0\)$/],
    ['cadence 1.5', (f) => (f.cadence = 1.5), /^foreman\.cadence must be an integer 1-1440/],
    ['assistants.parallel 0', (f) => (f.assistants.parallel = 0), /^foreman\.assistants\.parallel must be an integer 1-16 \(got 0\)$/],
    ['assistants.parallel 17', (f) => (f.assistants.parallel = 17), /^foreman\.assistants\.parallel must be an integer 1-16 \(got 17\)$/],
    ['assistants.parallel "x"', (f) => (f.assistants.parallel = 'x'), /^foreman\.assistants\.parallel must be an integer 1-16/],
    ['assistants.sessions written by hand', (f) => (f.assistants.sessions = 2), /^foreman\.assistants has unknown key "sessions"/],
    ['assistants.model --x', (f) => (f.assistants.model = '--x'), /^foreman\.assistants\.model must be a model alias or id/],
    ['surveyors.effort ultra', (f) => (f.surveyors.effort = 'ultra'), /^foreman\.surveyors\.effort must be one of low \| medium/],
    ['mandate.until shipped', (f) => (f.mandate.until = 'shipped'), /^foreman\.mandate\.until must be one of merge-ready \| merged \| released/],
    ['ship deploy', (f) => (f.ship = 'deploy'), /^foreman\.ship must be one of propose \| merge \| release/],
    ['mandate.order random', (f) => (f.mandate.order = 'random'), /^foreman\.mandate\.order must be one of graph \| priority \| listed/],
    ['mandate.decides [nope]', (f) => (f.mandate.decides = ['nope']), /^foreman\.mandate\.decides must be a list of gate classes/],
    ['mandate.budget.usd -1', (f) => (f.mandate.budget.usd = -1), /^foreman\.mandate\.budget\.usd must be a number over 0 and at most 100000/],
    ['mandate.stall.bounces 0', (f) => (f.mandate.stall.bounces = 0), /^foreman\.mandate\.stall\.bounces must be an integer 1-100/],
    ['mandate.onUnfinishable drop', (f) => (f.mandate.onUnfinishable = 'drop'), /^foreman\.mandate\.onUnfinishable must be one of park \| cancel/],
    ['assistants.enabled "yes"', (f) => (f.assistants.enabled = 'yes'), /^foreman\.assistants\.enabled must be true or false/],
    ['escalations board', (f) => (f.escalations = 'board'), /^foreman\.escalations must be one of human \| foreman \(got "board"\)$/],
    ['senior.model --x', (f) => (f.senior.model = '--x'), /^foreman\.senior\.model must be a model alias or id/],
    ['senior.effort ultra', (f) => (f.senior.effort = 'ultra'), /^foreman\.senior\.effort must be one of low \| medium/],
    ['senior not a map', (f) => (f.senior = 'opus'), /^foreman\.senior must be a map/],
  ];
  for (const [name, edit, want] of rows) {
    const got = problems(edit);
    assert.ok(got.length === 1 && want.test(got[0]), `${name}: ${JSON.stringify(got)}`);
  }
  // A partial block a user wrote merges over the defaults, so an absent key is no problem.
  assert.deepEqual(foremanProblems({ foreman: { decides: [], reserved: [], ship: 'propose', assistants: { model: 'haiku' }, mandate: { maxJobs: 4 } } }), []);
  // forge config set checks the value before anything is read: an editable model key still refuses a flag-shaped one.
  assert.throws(
    () => setConfigValue(os.tmpdir(), 'foreman.assistants.model', '--x', () => ({ login: null, source: 'unknown' })),
    (e: any) => e.reason === 'invalid' && /foreman\.assistants\.model must be a model alias or id/.test(e.message),
  );
  // escalations hands escalated gates to the foreman, so only a hand edit of config.yml sets it; the senior's model stays editable and checked.
  const actor = () => ({ login: null, source: 'unknown' as const });
  assert.throws(() => setConfigValue(os.tmpdir(), 'foreman.escalations', 'foreman', actor), (e: any) => e.reason === 'locked');
  assert.throws(
    () => setConfigValue(os.tmpdir(), 'foreman.senior.model', '--x', actor),
    (e: any) => e.reason === 'invalid' && /foreman\.senior\.model must be a model alias or id/.test(e.message),
  );
});

test('worktrees.seed commands get the placeholder check', () => {
  const c: any = defaults();
  c.worktrees.seed = block({ warm: ['curl {endpoint.api}'] });
  assert.ok(validateConfig(c, os.tmpdir()).some((p) => p.startsWith('worktrees.seed.warm[0] uses {endpoint.api}')));
});

test('validates maxTotalRounds, maxCiReworks and daemon.jobBudget', () => {
  const problems = (edit: (c: any) => void, key: string) => {
    const c: any = defaults();
    edit(c);
    return validateConfig(c, process.cwd()).filter((p) => p.startsWith(key));
  };
  assert.deepEqual(problems(() => {}, 'pipeline.maxTotalRounds'), []);
  assert.deepEqual(problems((c) => (c.pipeline.maxTotalRounds = 8), 'pipeline.maxTotalRounds'), []);
  assert.equal(problems((c) => (c.pipeline.maxTotalRounds = 0), 'pipeline.maxTotalRounds').length, 1);
  assert.equal(problems((c) => (c.pipeline.maxTotalRounds = 2.5), 'pipeline.maxTotalRounds').length, 1);
  assert.deepEqual(problems((c) => (c.pr.maxCiReworks = 0), 'pr.maxCiReworks'), []);
  assert.equal(problems((c) => (c.pr.maxCiReworks = -1), 'pr.maxCiReworks').length, 1);
  assert.equal(problems((c) => (c.pr.maxCiReworks = 1.5), 'pr.maxCiReworks').length, 1);
  assert.equal(defaults().pr.needsHumanLabel, 'forge:needs-human');
  for (const ok of ['forge:needs-human', null, 'needs a person', 'x'.repeat(50)]) assert.deepEqual(problems((c) => (c.pr.needsHumanLabel = ok), 'pr.needsHumanLabel'), [], String(ok));
  for (const bad of [3, '', '-x', '--add-label', 'a\nb', 'a\u0007', 'x'.repeat(51), ['l']]) assert.equal(problems((c) => (c.pr.needsHumanLabel = bad), 'pr.needsHumanLabel').length, 1, JSON.stringify(bad));
  assert.deepEqual(problems((c) => (c.daemon.jobBudget = null), 'daemon.jobBudget'), []);
  assert.deepEqual(problems((c) => (c.daemon.jobBudget = { tokens: null, usd: 20, minutes: 90 }), 'daemon.jobBudget'), []);
  assert.equal(problems((c) => (c.daemon.jobBudget = { usd: -1 }), 'daemon.jobBudget').length, 1);
  assert.equal(problems((c) => (c.daemon.jobBudget = { changedLines: 5 }), 'daemon.jobBudget').length, 1);
  assert.equal(problems((c) => (c.daemon.jobBudget = { tokens: 1.5 }), 'daemon.jobBudget').length, 1);
  assert.equal(problems((c) => (c.daemon.jobBudget = [1]), 'daemon.jobBudget').length, 1);
});

test('validates pipeline.resumeRework', () => {
  const problems = (v: unknown) => {
    const c: any = defaults();
    c.pipeline.resumeRework = v;
    return validateConfig(c, process.cwd()).filter((p) => p.startsWith('pipeline.resumeRework'));
  };
  assert.equal(defaults().pipeline.resumeRework, true);
  for (const ok of [true, false]) assert.deepEqual(problems(ok), [], String(ok));
  for (const bad of ['true', 1, null, undefined, {}]) assert.deepEqual(problems(bad), [`pipeline.resumeRework must be true or false (got ${JSON.stringify(bad)})`], String(bad));
  const f = FIELDS.find((x) => x.key === 'pipeline.resumeRework');
  assert.ok(f && f.type === 'boolean' && f.editable && f.default === true);
});

test('validates approver.skipWhenClean', () => {
  const problems = (v: unknown) => {
    const c: any = defaults();
    c.approver.skipWhenClean = v;
    return validateConfig(c, process.cwd()).filter((p) => p.startsWith('approver.skipWhenClean'));
  };
  assert.equal(defaults().approver.skipWhenClean, false);
  for (const ok of [true, false]) assert.deepEqual(problems(ok), [], String(ok));
  for (const bad of ['true', 1, null, {}]) assert.deepEqual(problems(bad), [`approver.skipWhenClean must be true or false (got ${JSON.stringify(bad)})`], String(bad));
  const f = FIELDS.find((x) => x.key === 'approver.skipWhenClean');
  assert.ok(f && f.type === 'boolean' && !f.editable && f.lockedReason && f.default === false);
});
