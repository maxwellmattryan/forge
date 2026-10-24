// Forge's own CI: .github/workflows/ci.yml runs the AGENTS.md verify list in the same order, and stays
// closed to the bypasses a PR author, a retagged action or a later edit could use to make red read green.
// The pin, permission and credential checks live in test/invariants/workflow-lint.ts, shared with the release workflows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '#core/format/yaml.ts';
import { credentialRefs, dependencyCaches, excessPermissions, forbiddenTriggers, loadWorkflow, persistedCredentials, runExpressions, secretLeaks, unpinnedActions } from './workflow-lint.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

const VALIDATE = 'claude plugin validate . --strict';
// CI installs without install scripts, so it runs the package's own wrapper instead of the `claude` stub.
const CI_VALIDATE = 'node "$(npm root -g)/@anthropic-ai/claude-code/cli-wrapper.cjs" plugin validate . --strict';
const CLI_INSTALL = /^npm install -g(?: --ignore-scripts)? @anthropic-ai\/claude-code(?:@\S*)?$/;
const CLI_PINNED = /^npm install -g --ignore-scripts @anthropic-ai\/claude-code@\d+\.\d+\.\d+$/;
const TEST_CMD = 'node --test "test/**/*.test.ts" "lib/**/*.test.ts" "dashboard/src/**/*.test.ts"';
const SHARDED_TEST_CMD = 'node --test --test-shard="$TEST_SHARD" "test/**/*.test.ts" "lib/**/*.test.ts" "dashboard/src/**/*.test.ts"';
// `|| true`, `|| :`, `|| exit 0` and `set +e` turn a failing command into a passing step.
const MASKS: [RegExp, string][] = [
  [/\|\|\s*(?:true|:)(?![\w-])/, '|| true / || :'],
  [/\|\|\s*exit\s+0\b/, '|| exit 0'],
  [/\bset\s+\+\w*e/, 'set +e'],
];
// Writing these from a step reaches every later step: `NODE_OPTIONS=--test-only` makes `node --test` pass a failing suite.
const ENV_REACH = /\b(?:GITHUB_ENV|GITHUB_PATH|BASH_ENV|NODE_OPTIONS)\b/;
// Nothing in CI may write: it runs PR code.
const ALLOWED = {};

type Step = Record<string, any>;
const jobsOf = (wf: any): [string, any][] => Object.entries(wf?.jobs ?? {});
const stepsOf = (job: any): Step[] => (Array.isArray(job?.steps) ? job.steps : []);
const runOf = (step: Step): string | null => (typeof step?.run === 'string' ? step.run : null);
const label = (job: string, step: Step) => `${job} › ${step?.name ?? step?.uses ?? step?.run}`;

/** The ways a step can make a red run read green, or reach the steps after it. */
function gateBypasses(wf: any): string[] {
  const out: string[] = [...forbiddenTriggers(wf), ...runExpressions(wf)];
  for (const scope of [wf, ...jobsOf(wf).map(([, j]) => j)]) {
    for (const k of Object.keys(scope?.env ?? {})) if (ENV_REACH.test(k)) out.push(`env ${k} reaches every step`);
  }
  for (const [id, job] of jobsOf(wf)) {
    if (job?.['continue-on-error'] !== undefined) out.push(`job ${id} must not set continue-on-error`);
    if (job?.if !== undefined) out.push(`job ${id} must not set if`);
    for (const step of stepsOf(job)) {
      const at = label(id, step);
      const run = runOf(step);
      // The full audit is report-only: devDependency advisories must not block a PR.
      if ('continue-on-error' in step && run !== 'npm audit') out.push(`${at}: only the report-only npm audit may set continue-on-error`);
      if ('if' in step) out.push(`${at}: must not set if`);
      if ('shell' in step) out.push(`${at}: its own shell could drop -e`);
      for (const k of Object.keys(step.env ?? {})) if (ENV_REACH.test(k)) out.push(`${at}: env ${k}`);
      if (run === null) continue;
      for (const [re, what] of MASKS) if (re.test(run)) out.push(`${at}: run must not mask a failure with ${what}`);
      if (ENV_REACH.test(run)) out.push(`${at}: run must not set the environment of later steps`);
    }
  }
  return out;
}

/** The AGENTS.md verify fence as a command list: comments stripped, `a && b` split into two. */
function agentsVerifyCommands(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const heading = lines.indexOf('## Verify before claiming it works');
  if (heading === -1) return [];
  const open = lines.findIndex((l, i) => i > heading && /^```bash\s*$/.test(l));
  if (open === -1) return [];
  const close = lines.findIndex((l, i) => i > open && /^```\s*$/.test(l));
  return lines
    .slice(open + 1, close === -1 ? lines.length : close)
    .filter((l) => l.trim())
    .map((l) => l.replace(/\s{2,}#\s.*$/, ''))
    .flatMap((l) => l.split(' && ').map((part) => part.trim()));
}

/** The verify job's `run` steps as the same list: the CLI install is setup. */
function ciVerifyCommands(wf: any): string[] {
  return stepsOf(wf?.jobs?.verify).flatMap((step) => {
    const run = runOf(step);
    if (run === null) return [];
    if (CLI_INSTALL.test(run.trim())) return [];
    if (run.trim() === SHARDED_TEST_CMD) return [TEST_CMD];
    if (run.trim() === CI_VALIDATE) return [VALIDATE];
    return [run.trim()];
  });
}

function verifyListProblems(agentsText: string, wf: any): string[] {
  const out: string[] = [];
  const want = agentsVerifyCommands(agentsText);
  const got = ciVerifyCommands(wf);
  if (!want.length) out.push('AGENTS.md has no verify fence');
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i] !== got[i]) out.push(`command ${i + 1}: AGENTS.md has ${JSON.stringify(want[i] ?? null)}, CI runs ${JSON.stringify(got[i] ?? null)}`);
  }
  return out;
}

function cliProblems(wf: any): string[] {
  const out: string[] = [];
  const steps = stepsOf(wf?.jobs?.verify);
  const installs = steps.filter((s) => CLI_INSTALL.test(runOf(s)?.trim() ?? ''));
  for (const s of installs) if (!CLI_PINNED.test(runOf(s)!.trim())) out.push(`the Claude Code CLI install must pin an exact x.y.z version and pass --ignore-scripts: ${runOf(s)}`);
  // The last install decides which CLI validates, so allow exactly one, directly before validation.
  if (installs.length !== 1) out.push(`verify must install the Claude Code CLI exactly once, got ${installs.length}`);
  const install = steps.findIndex((s) => CLI_INSTALL.test(runOf(s)?.trim() ?? ''));
  const validate = steps.findIndex((s) => runOf(s)?.trim() === CI_VALIDATE);
  if (validate === -1) out.push(`verify must run ${CI_VALIDATE}`);
  if (install !== -1 && validate !== -1 && install !== validate - 1) out.push('the CLI must be installed in the step directly before the plugin is validated');
  return out;
}

const WF = loadWorkflow('ci.yml');
const AGENTS = read('AGENTS.md');

const mutate = (fn: (wf: any) => void): any => {
  const copy = structuredClone(WF);
  fn(copy);
  return copy;
};
const stepRunning = (wf: any, job: string, pred: (run: string) => boolean): Step => {
  const step = stepsOf(wf.jobs[job]).find((s) => runOf(s) !== null && pred(runOf(s)!));
  assert.ok(step, `${job} has the step`);
  return step;
};
/** Runs a step script the way GitHub runs `shell: bash`, with this test's Node first on PATH. */
const bash = (script: string, cwd: string) =>
  spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
  });
const assertFlags = (problems: string[], what: string) => assert.ok(problems.length > 0, `the checker flags: ${what}`);

const SHA = 'a'.repeat(40);
/** A one-job workflow around `job` (indented as under `jobs.j`), with `top` at the top level. */
const workflow = (job: string, top = 'permissions:\n  contents: read\n') =>
  parse(`name: x\non:\n  push:\n${top}jobs:\n  j:\n    runs-on: ubuntu-latest\n${job}`);
const steps = (...lines: string[]) => `    steps:\n${lines.map((l) => `      ${l}`).join('\n')}\n`;

test('workflow-lint reports each bypass and accepts each safe form', () => {
  const all = (wf: any) => [
    ...unpinnedActions(wf),
    ...excessPermissions(wf, ALLOWED),
    ...secretLeaks(wf),
    ...forbiddenTriggers(wf),
    ...runExpressions(wf),
    ...dependencyCaches(wf),
  ];
  const reported: [string, any][] = [
    ['uses: actions/checkout@v4', workflow(steps('- uses: actions/checkout@v4'))],
    ['uses: actions/checkout@main', workflow(steps('- uses: actions/checkout@main'))],
    ['a short SHA', workflow(steps('- uses: actions/checkout@3d3c42e'))],
    ['an uppercase SHA', workflow(steps(`- uses: actions/checkout@${SHA.toUpperCase()}`))],
    ['a docker image by tag', workflow(steps('- uses: docker://alpine:3'))],
    ['a reusable workflow by tag', parse(`on:\n  push:\npermissions:\n  contents: read\njobs:\n  j:\n    uses: org/repo/.github/workflows/x.yml@v1\n`)],
    ['permissions: write-all', workflow(steps('- run: make'), 'permissions: write-all\n')],
    ['a top-level write', workflow(steps('- run: make'), 'permissions:\n  contents: write\n')],
    ['a job write not allowed', workflow(`    permissions:\n      contents: write\n${steps('- run: make')}`)],
    ['a job with no permissions block', parse(`on:\n  push:\njobs:\n  a:\n    permissions:\n      contents: read\n    steps:\n      - run: a\n  b:\n    steps:\n      - run: b\n`)],
    ['no top-level permissions', workflow(`    permissions:\n      contents: read\n${steps('- run: make')}`, '')],
    ['job-level env: { T: ${{ secrets.X }} }', workflow(`    env:\n      T: \${{ secrets.X }}\n${steps('- run: make')}`)],
    ['workflow-level env: { T: ${{ github.token }} }', workflow(steps('- run: make'), 'permissions:\n  contents: read\nenv:\n  T: ${{ github.token }}\n')],
    ['run: echo ${{ secrets.X }}', workflow(steps('- run: echo ${{ secrets.X }}'))],
    ['run: gh api -H "x: ${{ github.token }}"', workflow(steps('- run: gh api -H "x: ${{ github.token }}"'))],
    ["the token through an index in run", workflow(steps("- run: echo ${{ github['token'] }}"))],
    ['toJSON(secrets) in run', workflow(steps('- run: echo ${{ toJSON(secrets) }}'))],
    ['run: echo "${{ github.event.head_commit.message }}"', workflow(steps('- run: echo "${{ github.event.head_commit.message }}"'))],
    ['on: pull_request_target', parse(`on:\n  pull_request_target:\npermissions:\n  contents: read\njobs:\n  j:\n    runs-on: ubuntu-latest\n${steps('- run: make')}`)],
    ['on: [push, workflow_run]', parse(`on: [push, workflow_run]\npermissions:\n  contents: read\njobs:\n  j:\n    runs-on: ubuntu-latest\n${steps('- run: make')}`)],
    ['uses: actions/cache@<40-hex>', workflow(steps(`- uses: actions/cache@${SHA}`))],
    ['setup-node without package-manager-cache: false', workflow(steps(`- uses: actions/setup-node@${SHA}`, '  with:', '    node-version: 22'))],
    ['setup-node with cache: npm', workflow(steps(`- uses: actions/setup-node@${SHA}`, '  with:', '    cache: npm', '    package-manager-cache: false'))],
  ];
  for (const [what, wf] of reported) assertFlags(all(wf), what);
  // A job with no block is named, not just covered by the missing top level.
  assert.ok(excessPermissions(reported[9][1], ALLOWED).some((f) => f.startsWith('job b:')));
  assert.ok(!excessPermissions(reported[9][1], ALLOWED).some((f) => f.startsWith('job a:')));

  const accepted: [string, any][] = [
    ['uses: ./.github/workflows/ci.yml', parse(`on:\n  push:\npermissions:\n  contents: read\njobs:\n  verify:\n    uses: ./.github/workflows/ci.yml\n`)],
    [`uses: docker://alpine@sha256:<64-hex>`, workflow(steps(`- uses: docker://alpine@sha256:${'b'.repeat(64)}`))],
    ['uses: actions/checkout@<40-hex>', workflow(steps(`- uses: actions/checkout@${SHA}`))],
    ['step-level env: { GH_TOKEN: ${{ github.token }} }', workflow(steps('- env:', '    GH_TOKEN: ${{ github.token }}', '  run: gh release list'))],
    ['a token in a step with', workflow(steps(`- uses: actions/checkout@${SHA}`, '  with:', '    token: ${{ secrets.X }}'))],
    ['a job write the allowed map names', workflow(`    permissions:\n      contents: write\n${steps('- run: make')}`)],
    ['an expression passed through step env and quoted', workflow(steps('- env:', '    MSG: ${{ github.event.head_commit.message }}', '  run: echo "$MSG"'))],
    ['setup-node with package-manager-cache: false', workflow(steps(`- uses: actions/setup-node@${SHA}`, '  with:', '    package-manager-cache: false'))],
  ];
  for (const [what, wf] of accepted) {
    const problems = what === 'a job write the allowed map names' ? excessPermissions(wf, { j: { contents: 'write' } }) : all(wf);
    assert.deepEqual(problems, [], what);
  }
  assert.equal(credentialRefs(accepted[3][1]).length, 1, 'the step-level token is found, then accepted');
  assert.deepEqual(persistedCredentials(workflow(steps(`- uses: actions/checkout@${SHA}`))).length, 1, 'a checkout keeping credentials');
});

test('ci.yml pins every action, keeps a read-only token, holds no credential and persists none', () => {
  assert.deepEqual(unpinnedActions(WF), []);
  assert.deepEqual(excessPermissions(WF, ALLOWED), []);
  assert.deepEqual(secretLeaks(WF), []);
  assert.deepEqual(persistedCredentials(WF), []);
  // PR code runs here: a cache it writes would be restored into the next push run.
  assert.deepEqual(dependencyCaches(WF), []);
  assertFlags(dependencyCaches(mutate((wf) => { delete wf.jobs.audit.steps.find((s: Step) => String(s.uses).startsWith('actions/setup-node@')).with['package-manager-cache']; })), 'package-manager-cache unset');
  assertFlags(dependencyCaches(mutate((wf) => { wf.jobs.verify.steps.splice(2, 0, { uses: `actions/cache@${SHA}`, with: { path: 'node_modules', key: 'k' } }); })), 'an actions/cache step');
  assertFlags(unpinnedActions(mutate((wf) => { wf.jobs.verify.steps[0].uses = 'actions/checkout@v7'; })), 'a pin rewritten to @v7');
  assertFlags(excessPermissions(mutate((wf) => { wf.permissions.contents = 'write'; }), ALLOWED), 'contents: write');
  assertFlags(excessPermissions(mutate((wf) => { wf.jobs.verify.permissions = 'write-all'; }), ALLOWED), 'job-level write-all');
  assertFlags(secretLeaks(mutate((wf) => { wf.jobs.verify.env = { NPM_TOKEN: '${{ secrets.NPM_TOKEN }}' }; })), 'a job-level secret');
  assertFlags(persistedCredentials(mutate((wf) => { delete wf.jobs.verify.steps[0].with['persist-credentials']; })), 'checkout keeping credentials');
});

test('no trigger, env or step can make a red run read green', () => {
  assert.deepEqual(gateBypasses(WF), []);
  assertFlags(gateBypasses(mutate((wf) => { wf.on.pull_request_target = null; })), 'pull_request_target');
  assertFlags(gateBypasses(mutate((wf) => { wf.on.workflow_run = { workflows: ['x'] }; })), 'workflow_run');
  assertFlags(gateBypasses(mutate((wf) => { stepRunning(wf, 'verify', (r) => r === 'npm ci').run = 'npm ci || true'; })), 'npm ci || true');
  assertFlags(gateBypasses(mutate((wf) => { stepRunning(wf, 'verify', (r) => r === 'npm ci').run = 'npm ci || :'; })), 'npm ci || :');
  assertFlags(gateBypasses(mutate((wf) => { stepRunning(wf, 'verify', (r) => r === 'npm ci').run = 'npm ci || exit 0'; })), 'npm ci || exit 0');
  assertFlags(gateBypasses(mutate((wf) => { stepRunning(wf, 'verify', (r) => r === SHARDED_TEST_CMD).run = `set +e\n${TEST_CMD}`; })), 'set +e');
  assertFlags(gateBypasses(mutate((wf) => { stepRunning(wf, 'verify', (r) => r === SHARDED_TEST_CMD)['continue-on-error'] = true; })), 'continue-on-error on Run tests');
  assertFlags(gateBypasses(mutate((wf) => { wf.jobs.verify['continue-on-error'] = true; })), 'continue-on-error on a job');
  assertFlags(gateBypasses(mutate((wf) => { wf.jobs.verify.if = false; })), 'a job that never runs');
  assertFlags(gateBypasses(mutate((wf) => { stepRunning(wf, 'verify', (r) => r === CI_VALIDATE).if = false; })), 'a skipped validate step');
  assertFlags(gateBypasses(mutate((wf) => { stepRunning(wf, 'verify', (r) => r.includes('node --check')).shell = 'bash {0}'; })), 'a step dropping -e with its own shell');
  assertFlags(gateBypasses(mutate((wf) => { stepRunning(wf, 'verify', (r) => r === 'npm ci').run = 'echo "${{ github.event.pull_request.title }}"'; })), 'a run interpolating the PR title');
  const testOnly = { NODE_OPTIONS: '--test-only' };
  assertFlags(gateBypasses(mutate((wf) => { stepRunning(wf, 'verify', (r) => r === SHARDED_TEST_CMD).env = testOnly; })), 'NODE_OPTIONS on a step');
  assertFlags(gateBypasses(mutate((wf) => { wf.jobs.verify.env = testOnly; })), 'NODE_OPTIONS on a job');
  assertFlags(gateBypasses(mutate((wf) => { wf.env = testOnly; })), 'NODE_OPTIONS on the workflow');
  assertFlags(gateBypasses(mutate((wf) => {
    const step = stepRunning(wf, 'verify', (r) => r === 'npm run build:dashboard');
    step.run = `echo "NODE_OPTIONS=--test-only" >> "$GITHUB_ENV"\n${step.run}`;
  })), 'a run writing GITHUB_ENV');
});

const RUNTIME_AUDIT = 'npm audit --omit=dev';
/** The runtime audit must exist and fail the run: gateBypasses exempts only the report-only full audit. */
function runtimeAuditProblems(wf: any): string[] {
  const audits = jobsOf(wf).flatMap(([, job]) => stepsOf(job)).filter((s) => runOf(s)?.trim() === RUNTIME_AUDIT);
  if (audits.length === 0) return [`no step runs exactly ${RUNTIME_AUDIT}`];
  return audits.filter((s) => 'continue-on-error' in s).map(() => `${RUNTIME_AUDIT} must not set continue-on-error`);
}

test('the runtime dependency audit blocks', () => {
  assert.deepEqual(runtimeAuditProblems(WF), []);
  assert.deepEqual(gateBypasses(WF), []);
  const setAudit = (fn: (s: Step) => void) => mutate((wf) => fn(stepRunning(wf, 'audit', (r) => r.trim() === RUNTIME_AUDIT)));
  assertFlags(runtimeAuditProblems(mutate((wf) => { wf.jobs.audit.steps = wf.jobs.audit.steps.filter((s: Step) => runOf(s)?.trim() !== RUNTIME_AUDIT); })), 'the runtime audit removed');
  assertFlags(runtimeAuditProblems(setAudit((s) => { s.run = `${RUNTIME_AUDIT} --audit-level=critical`; })), 'a weakened runtime audit');
  assertFlags(runtimeAuditProblems(setAudit((s) => { s['continue-on-error'] = true; })), 'continue-on-error on the runtime audit');
  assertFlags(gateBypasses(setAudit((s) => { s['continue-on-error'] = true; })), 'continue-on-error on the runtime audit');
  assertFlags(gateBypasses(setAudit((s) => { s.run = `${RUNTIME_AUDIT} || true`; })), 'a masked runtime audit');
});

test('ci runs the AGENTS.md verify list in the same order and nothing else', () => {
  assert.deepEqual(verifyListProblems(AGENTS, WF), []);
  assert.deepEqual(agentsVerifyCommands(AGENTS), [
    'npm ci',
    'npm run check:touchpoints',
    'npm run typecheck',
    'npm run check:dashboard',
    'npm run build:dashboard',
    'node --test "test/**/*.test.ts" "lib/**/*.test.ts" "dashboard/src/**/*.test.ts"',
    'for f in bin/forge lib/trackers/status.mjs dashboard/*.mjs; do node --check "$f"; done',
    VALIDATE,
  ]);

  const extraInAgents = AGENTS.replace(`${VALIDATE}\n\`\`\``, `${VALIDATE}\nnpm run extra                           # not in CI\n\`\`\``);
  assert.notEqual(extraInAgents, AGENTS);
  assertFlags(verifyListProblems(extraInAgents, WF), 'AGENTS.md gains an extra command');
  assertFlags(verifyListProblems(AGENTS, mutate((wf) => {
    wf.jobs.verify.steps = wf.jobs.verify.steps.filter((s: Step) => s.run !== 'npm run typecheck');
  })), 'a CI step is missing');
  assertFlags(verifyListProblems(AGENTS, mutate((wf) => {
    const s = wf.jobs.verify.steps;
    const a = s.findIndex((x: Step) => x.run === 'npm run typecheck');
    const b = s.findIndex((x: Step) => x.run === 'npm run check:dashboard');
    [s[a], s[b]] = [s[b], s[a]];
  })), 'two CI steps are swapped');
  assertFlags(verifyListProblems(AGENTS, mutate((wf) => { wf.jobs.verify.steps.push({ name: 'Extra', run: 'npm run extra' }); })), 'CI gains an extra run step');
  assertFlags(verifyListProblems(AGENTS, mutate((wf) => {
    stepRunning(wf, 'verify', (r) => r === SHARDED_TEST_CMD).run = 'node --test --test-shard="$TEST_SHARD" "test/a.test.ts"';
  })), 'a sharded run over fewer files');
});

const TOUCHPOINTS = 'npm run check:touchpoints';
/** The touchpoints check is vacuous against HEAD, and fails without HEAD's parent in the clone. */
function touchpointsProblems(wf: any): string[] {
  const out: string[] = [];
  const steps = stepsOf(wf?.jobs?.verify);
  const step = steps.find((s) => runOf(s)?.trim() === TOUCHPOINTS);
  if (!step) out.push(`verify must run ${TOUCHPOINTS}`);
  else if (step.env?.FORGE_TOUCHPOINTS_BASE !== 'HEAD^1') out.push(`${TOUCHPOINTS} must set FORGE_TOUCHPOINTS_BASE: HEAD^1, got ${JSON.stringify(step.env?.FORGE_TOUCHPOINTS_BASE ?? null)}`);
  const checkout = steps.find((s) => String(s?.uses ?? '').startsWith('actions/checkout@'));
  if (checkout?.with?.['fetch-depth'] !== 2) out.push(`the verify checkout must set fetch-depth: 2, got ${JSON.stringify(checkout?.with?.['fetch-depth'] ?? null)}`);
  return out;
}

test('the touchpoints step compares against the previous commit', () => {
  assert.deepEqual(touchpointsProblems(WF), []);
  const setStep = (fn: (s: Step) => void) => mutate((wf) => fn(stepRunning(wf, 'verify', (r) => r.trim() === TOUCHPOINTS)));
  assertFlags(touchpointsProblems(setStep((s) => { s.env.FORGE_TOUCHPOINTS_BASE = 'HEAD'; })), 'a base of HEAD');
  assertFlags(touchpointsProblems(setStep((s) => { delete s.env; })), 'the env removed');
  assertFlags(touchpointsProblems(mutate((wf) => { wf.jobs.verify.steps[0].with['fetch-depth'] = 1; })), 'fetch-depth: 1');
});

test('the Claude Code CLI is pinned and installed once, directly before validation', () => {
  assert.deepEqual(cliProblems(WF), []);
  const setInstall = (run: string) => mutate((wf) => { stepRunning(wf, 'verify', (r) => CLI_INSTALL.test(r)).run = run; });
  assertFlags(cliProblems(setInstall('npm install -g --ignore-scripts @anthropic-ai/claude-code@latest')), 'an install at @latest');
  assertFlags(cliProblems(setInstall('npm install -g --ignore-scripts @anthropic-ai/claude-code')), 'an install with no version');
  // An install script is code from the package that runs before anything validates it.
  assertFlags(cliProblems(setInstall('npm install -g @anthropic-ai/claude-code@2.1.299')), 'an install without --ignore-scripts');
  assertFlags(cliProblems(mutate((wf) => { wf.jobs.verify.steps = wf.jobs.verify.steps.filter((s: Step) => s.run !== CI_VALIDATE); })), 'no validate step');
  // The last install wins, so a second one could run validation on any version.
  const downgrade = mutate((wf) => {
    const s = wf.jobs.verify.steps;
    s.splice(s.findIndex((x: Step) => x.run === CI_VALIDATE), 0, { name: 'Downgrade', run: 'npm install -g --ignore-scripts @anthropic-ai/claude-code@1.0.0' });
  });
  assert.deepEqual(verifyListProblems(AGENTS, downgrade), [], 'the list check skips every install');
  assertFlags(cliProblems(downgrade), 'a second, pinned install just before validate');
});

test('the syntax-check step fails when any file has a syntax error, not only the last', POSIX, () => {
  const script = runOf(stepRunning(WF, 'verify', (r) => r.includes('node --check')))!;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ci-check-')));
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  try {
    // bin/forge is the first file the loop checks; the files after it pass.
    write('bin/forge', '#!/usr/bin/env node\nconsole.log(;\n');
    write('lib/trackers/status.mjs', 'export const ok = 1;\n');
    write('dashboard/a.mjs', 'export const a = 1;\n');
    const bad = bash(script, dir);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /bin\/forge/);

    write('bin/forge', '#!/usr/bin/env node\nconsole.log(1);\n');
    const good = bash(script, dir);
    assert.equal(good.status, 0, good.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the release check picks --dist from the PR base or the branch', POSIX, () => {
  const script = runOf(stepRunning(WF, 'release-check', (r) => r.includes('release:check')))!;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ci-dist-')));
  try {
    // A stub npm on PATH records the arguments the step passes.
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 });
    const ran = (ref: string) => {
      const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, REF: ref, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` },
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(ran('develop'), 'run release:check -- --dist absent');
    assert.equal(ran('main'), 'run release:check -- --dist present');
    for (const other of ['ci/main-update', 'forge/309-x', 'develop2', 'main/x', '']) assert.equal(ran(other), 'run release:check', JSON.stringify(other));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI starts without a type-stripping warning on this Node', () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'forge'), 'version'], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).version, JSON.parse(read('package.json')).version);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
});
