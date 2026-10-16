// Forge's own CI: .github/workflows/ci.yml runs the AGENTS.md verify list in the same order, and stays
// closed to the bypasses a PR author, a retagged action or a later edit could use to make red read green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { parse } from '../lib/yaml.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

const STALE_CMD = 'git status --porcelain -- dashboard/dist';
const VALIDATE = 'claude plugin validate . --strict';
const CLI_INSTALL = /^npm install -g @anthropic-ai\/claude-code(?:@\S*)?$/;
const CLI_PINNED = /^npm install -g (@anthropic-ai\/claude-code@\d+\.\d+\.\d+)$/;
const USES_LINE = /^\s*(?:-\s+)?uses:/;
const PINNED_LINE = /^\s*(?:-\s+)?uses:\s+[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/;
const PINNED_REF = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
// `|| true`, `|| :`, `|| exit 0` and `set +e` turn a failing command into a passing step.
const MASKS: [RegExp, string][] = [
  [/\|\|\s*(?:true|:)(?![\w-])/, '|| true / || :'],
  [/\|\|\s*exit\s+0\b/, '|| exit 0'],
  [/\bset\s+\+\w*e/, 'set +e'],
];
// Writing these from a step reaches every later step: `NODE_OPTIONS=--test-only` makes `node --test` pass a failing suite.
const ENV_REACH = /\b(?:GITHUB_ENV|GITHUB_PATH|BASH_ENV|NODE_OPTIONS)\b/;

// Allowlists rather than deny-lists: a key, action or expression the workflow does not use today fails here, so adding
// one means editing this test too, in the same reviewed diff.
const WORKFLOW_KEYS = ['name', 'on', 'permissions', 'concurrency', 'defaults', 'jobs'];
const JOBS = ['audit', 'verify'];
const JOB_KEYS = ['name', 'runs-on', 'timeout-minutes', 'strategy', 'steps'];
const STEP_KEYS = ['name', 'uses', 'with', 'run', 'env', 'continue-on-error'];
const ACTIONS = ['actions/checkout', 'actions/setup-node'];
const VALIDATE_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
// Each verify cell runs one shard of the test files. The shard reaches the command through env, not
// interpolated into run, and the strategy pin below holds the matrix to every shard of the split.
const TEST_CMD = 'node --test "test/*.test.ts"';
const SHARDED_TEST_CMD = 'node --test --test-shard="$TEST_SHARD" "test/*.test.ts"';
const TEST_ENV = { TEST_SHARD: '${{ matrix.shard }}' };
// The only steps that may set env, each to exactly this map.
const STEP_ENVS: Record<string, Record<string, string>> = { [VALIDATE]: VALIDATE_ENV, [SHARDED_TEST_CMD]: TEST_ENV };
// Values pinned exactly, not just by key: each is free text a one-line edit could use to drop coverage or mask a failure.
// Branch protection, once set, requires checks by these names, so a rename would leave a required check waiting forever.
const JOB_NAMES: Record<string, string> = { verify: 'verify (${{ matrix.os }}, node ${{ matrix.node }}, shard ${{ matrix.shard }})', audit: 'audit' };
// An `exclude` or `include` under the matrix silently drops or swaps a cell.
const STRATEGIES: Record<string, unknown> = {
  verify: { 'fail-fast': false, matrix: { os: ['ubuntu-latest', 'macos-latest'], node: ['22.18.0', '24.x'], shard: ['1/2', '2/2'] } },
};
const SETUP_NODE_WITH: Record<string, unknown> = {
  verify: { 'node-version': '${{ matrix.node }}', 'package-manager-cache': false },
  audit: { 'node-version-file': '.nvmrc', 'package-manager-cache': false },
};
// An extra step before the blocking audit could swap the lockfile it reads.
const AUDIT_RUNS = ['npm audit --omit=dev', 'npm audit'];
// The one free-form script in the gate. AC3 maps it to its git command, so anything else in it (emptying the test files,
// checking out old sources) would pass the list check; hold it to this exact text instead.
const STALE_SCRIPT = [
  'stale="$(git status --porcelain -- dashboard/dist)"',
  'if [ -n "$stale" ]; then',
  '  echo "::error title=Stale dashboard/dist::dashboard/dist is stale: run npm run build:dashboard and commit dashboard/dist"',
  '  echo "Stale files:"',
  '  echo "$stale"',
  '  exit 1',
  'fi',
].join('\n');
const EXPRESSIONS = [
  '${{ matrix.os }}',
  '${{ matrix.node }}',
  '${{ matrix.shard }}',
  '${{ github.workflow }}',
  '${{ github.event.pull_request.number || github.sha }}',
];
// These and the expression allowlist read the raw text, comments included, so a comment saying "no secrets" fails too.
// That is deliberate: it fails closed with a clear message, and the parser's view of the file never has to be trusted.
const SECRETS = /\bsecrets\b/i;
const TOKEN = /\bgithub\s*(?:\.|\[\s*['"])token\b|toJSON\(\s*github\s*\)/i;

type Step = Record<string, any>;
type Job = Record<string, any>;

const jobsOf = (wf: any): [string, Job][] => Object.entries(wf?.jobs ?? {}) as [string, Job][];
const stepsOf = (job: Job | undefined): Step[] => (Array.isArray(job?.steps) ? job.steps : []);
const runOf = (step: Step): string | null => (typeof step?.run === 'string' ? step.run : null);
const usesAction = (step: Step, action: string) => typeof step?.uses === 'string' && step.uses.startsWith(`${action}@`);
const label = (job: string, step: Step) => `${job} › ${step?.name ?? step?.uses ?? step?.run}`;
const isMap = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const extraKeys = (v: unknown, allowed: string[]) => (isMap(v) ? Object.keys(v).filter((k) => !allowed.includes(k)) : []);

// ---------- pure checkers: each returns the problems it finds, [] when the workflow is sound ----------

function triggerProblems(wf: any, text: string): string[] {
  const out: string[] = [];
  const on = wf?.on;
  if (!on || typeof on !== 'object' || Array.isArray(on)) {
    out.push('`on` must be a map of events');
  } else {
    const events = Object.keys(on).sort();
    if (!isDeepStrictEqual(events, ['pull_request', 'push'])) out.push(`\`on\` must be exactly pull_request and push, got ${events.join(', ')}`);
    // A filter (branches, paths, paths-ignore, types) quietly stops the gate running on some PRs.
    if (!(on.pull_request === null || (isMap(on.pull_request) && !Object.keys(on.pull_request).length)))
      out.push('pull_request must have no filters');
    if (!isDeepStrictEqual(on.push, { branches: ['main'] })) out.push('push must be exactly branches: [main], with no other filter');
  }
  // Both hand fork code a write token and secrets.
  for (const word of ['pull_request_target', 'workflow_run']) if (text.includes(word)) out.push(`the workflow must not mention ${word}`);
  return out;
}

function permissionProblems(wf: any, text: string): string[] {
  const out: string[] = [];
  if (!isDeepStrictEqual(wf?.permissions, { contents: 'read' })) out.push('top-level permissions must be exactly { contents: read }');
  for (const [id, job] of jobsOf(wf)) if (job && typeof job === 'object' && 'permissions' in job) out.push(`job ${id} must not set permissions`);
  for (const word of ['secrets.', 'github.token']) if (text.includes(word)) out.push(`the workflow must not reference ${word}`);
  // Index and toJSON forms reach the same values: secrets['X'], toJSON(secrets), github['token'], toJSON(github).
  if (SECRETS.test(text)) out.push('the workflow must not reference the secrets context');
  if (TOKEN.test(text)) out.push('the workflow must not reference the github token');
  for (let i = text.indexOf('${{'); i !== -1; i = text.indexOf('${{', i + 3)) {
    if (!EXPRESSIONS.some((e) => text.startsWith(e, i))) out.push(`expression not on the allowlist: ${text.slice(i, i + 80).split('\n')[0]}`);
  }
  return out;
}

function pinProblems(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => USES_LINE.test(l));
  if (!lines.length) out.push('no `uses:` lines found');
  for (const l of lines) if (!PINNED_LINE.test(l)) out.push(`not pinned to a full commit SHA with its version comment: ${l.trim()}`);
  // A `uses` written some other way (a flow map, a quoted key) never shows up as a `uses:` line above.
  let wf: any;
  try {
    wf = parse(text);
  } catch (e) {
    return [...out, `the workflow does not parse: ${(e as Error).message}`];
  }
  const parsed = jobsOf(wf).flatMap(([, job]) => [job?.uses, ...stepsOf(job).map((s) => s?.uses)]).filter((u) => u !== undefined);
  for (const u of parsed) if (typeof u !== 'string' || !PINNED_REF.test(u)) out.push(`not pinned to a full commit SHA: ${u}`);
  if (parsed.length !== lines.length) out.push(`${parsed.length} actions are used but ${lines.length} \`uses:\` lines carry a pin`);
  return out;
}

function hardeningProblems(wf: any): string[] {
  const out: string[] = [];
  for (const k of extraKeys(wf, WORKFLOW_KEYS)) out.push(`the workflow must not set ${k}`);
  // GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail`; without -e a `for` loop reports only its last command.
  if (!isDeepStrictEqual(wf?.defaults, { run: { shell: 'bash' } })) out.push('defaults must be exactly run.shell: bash');
  const ids = jobsOf(wf).map(([id]) => id).sort();
  if (!isDeepStrictEqual(ids, JOBS)) out.push(`jobs must be exactly ${JOBS.join(', ')}, got ${ids.join(', ')}`);
  for (const [id, job] of jobsOf(wf)) {
    if (!isMap(job)) continue;
    for (const k of extraKeys(job, JOB_KEYS)) out.push(`job ${id} must not set ${k}`);
    if (id in JOB_NAMES && job.name !== JOB_NAMES[id]) out.push(`job ${id} must be named exactly ${JOB_NAMES[id]}`);
    if (!isDeepStrictEqual(job.strategy, STRATEGIES[id]))
      out.push(id in STRATEGIES ? `job ${id} strategy must be exactly ${JSON.stringify(STRATEGIES[id])}` : `job ${id} must not set strategy`);
    if (id === 'audit') {
      const runs = stepsOf(job).map(runOf).filter((r) => r !== null);
      if (!isDeepStrictEqual(runs, AUDIT_RUNS)) out.push(`job audit must run exactly ${AUDIT_RUNS.join(', then ')}`);
    }
    const actions = stepsOf(job).filter((s) => isMap(s) && 'uses' in s).map((s) => String(s.uses).split('@')[0]);
    if (!isDeepStrictEqual(actions, ACTIONS)) out.push(`job ${id} must use exactly ${ACTIONS.join(' then ')}, got ${actions.join(', ') || 'none'}`);
    for (const step of stepsOf(job)) {
      const at = label(id, step);
      for (const k of extraKeys(step, STEP_KEYS)) out.push(`${at}: must not set ${k}`);
      if (usesAction(step, 'actions/checkout') && !isDeepStrictEqual(step.with, { 'persist-credentials': false }))
        out.push(`${at}: checkout must set exactly persist-credentials: false`);
      if (usesAction(step, 'actions/setup-node')) {
        if (step.with?.['package-manager-cache'] !== false) out.push(`${at}: setup-node must set package-manager-cache: false`);
        if (!isDeepStrictEqual(step.with, SETUP_NODE_WITH[id])) out.push(`${at}: setup-node must set exactly ${JSON.stringify(SETUP_NODE_WITH[id] ?? null)}`);
      }
      if ('continue-on-error' in step && runOf(step) !== 'npm audit') out.push(`${at}: only the report-only npm audit may set continue-on-error`);
      const run = runOf(step);
      if (run !== null) {
        for (const [re, what] of MASKS) if (re.test(run)) out.push(`${at}: run must not mask a failure with ${what}`);
        if (run.includes('${{')) out.push(`${at}: run must not interpolate an expression`);
        if (ENV_REACH.test(run)) out.push(`${at}: run must not set the environment of later steps`);
        if (run.includes(STALE_CMD) && run.trim() !== STALE_SCRIPT) out.push(`${at}: the stale-dist script must be exactly the reviewed one`);
      }
      if ('env' in step) {
        const allowed = run !== null && Object.hasOwn(STEP_ENVS, run.trim()) ? STEP_ENVS[run.trim()] : undefined;
        // Each allowed map is pinned exactly; TEST_SHARD's expression is a matrix value the workflow fixes itself.
        if (!allowed || !isDeepStrictEqual(step.env, allowed)) {
          out.push(`${at}: only Validate plugin and the sharded Run tests may set env, each only to its pinned map`);
          for (const [k, v] of Object.entries(isMap(step.env) ? step.env : {})) if (String(v).includes('${{')) out.push(`${at}: env ${k} must not interpolate an expression`);
        }
      }
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

/** The verify job's `run` steps as the same list: the stale-dist script is its git command, the CLI install is setup. */
function ciVerifyCommands(wf: any): string[] {
  return stepsOf(wf?.jobs?.verify).flatMap((step) => {
    const run = runOf(step);
    if (run === null) return [];
    if (run.includes(STALE_CMD)) return [STALE_CMD];
    if (CLI_INSTALL.test(run.trim())) return [];
    if (run.trim() === SHARDED_TEST_CMD) return [TEST_CMD];
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
  for (const [id, job] of jobsOf(wf)) {
    const seen = new Set<string>();
    for (const step of stepsOf(job)) {
      const name = typeof step?.name === 'string' ? step.name.trim() : '';
      if (!name) out.push(`job ${id} has a step with no name`);
      else if (seen.has(name)) out.push(`job ${id} has two steps named ${JSON.stringify(name)}`);
      seen.add(name);
    }
  }
  return out;
}

function cliProblems(wf: any): string[] {
  const out: string[] = [];
  const steps = stepsOf(wf?.jobs?.verify);
  for (const s of steps) {
    const run = runOf(s)?.trim() ?? '';
    if (CLI_INSTALL.test(run) && !CLI_PINNED.test(run)) out.push(`the Claude Code CLI install must pin an exact x.y.z version: ${run}`);
  }
  // A second install would decide which CLI actually validates, and AC3 skips every install, so allow exactly one.
  const installs = steps.filter((s) => CLI_INSTALL.test(runOf(s)?.trim() ?? '')).length;
  if (installs > 1) out.push(`verify must install the Claude Code CLI exactly once, got ${installs}`);
  const install = steps.findIndex((s) => CLI_PINNED.test(runOf(s)?.trim() ?? ''));
  const validate = steps.findIndex((s) => runOf(s)?.trim() === VALIDATE);
  if (install === -1) out.push('verify must install @anthropic-ai/claude-code at an exact version');
  if (validate === -1) out.push(`verify must run ${VALIDATE}`);
  if (install !== -1 && validate !== -1 && install !== validate - 1) out.push('the CLI must be installed in the step directly before the plugin is validated');
  // A condition or continue-on-error here would make validation a quiet skip.
  for (const i of [install, validate]) {
    if (i === -1) continue;
    for (const key of ['if', 'continue-on-error']) if (key in steps[i]) out.push(`${label('verify', steps[i])}: must not set ${key}`);
  }
  return out;
}

/** `@anthropic-ai/claude-code@x.y.z` as the workflow installs it. */
function cliPackage(wf: any): string | undefined {
  for (const s of stepsOf(wf?.jobs?.verify)) {
    const m = (runOf(s)?.trim() ?? '').match(CLI_PINNED);
    if (m) return m[1];
  }
  return undefined;
}

// ---------- fixtures ----------

const TEXT = read('.github/workflows/ci.yml');
const WF = parse(TEXT);
const AGENTS = read('AGENTS.md');

const mutate = (fn: (wf: any) => void): any => {
  const copy = structuredClone(WF);
  fn(copy);
  return copy;
};
const stepNamed = (wf: any, job: string, name: string): Step => {
  const step = stepsOf(wf.jobs[job]).find((s) => s.name === name);
  assert.ok(step, `${job} has a step named ${name}`);
  return step;
};
const stepRunning = (job: string, pred: (run: string) => boolean): string => {
  const run = stepsOf(WF.jobs[job]).map(runOf).find((r) => r !== null && pred(r));
  assert.ok(run, `${job} has the step`);
  return run;
};
/** Runs a step script the way GitHub runs `shell: bash`, with this test's Node first on PATH. */
const bash = (script: string, cwd: string) =>
  spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
  });
const assertFlags = (problems: string[], what: string) => assert.ok(problems.length > 0, `the checker flags: ${what}`);

// ---------- tests ----------

test('workflow triggers on pull_request and pushes to main only', () => {
  assert.equal(WF.name, 'CI');
  assert.deepEqual(triggerProblems(WF, TEXT), []);

  const withTarget = TEXT.replace('on:\n  pull_request:\n', 'on:\n  pull_request:\n  pull_request_target:\n');
  assert.notEqual(withTarget, TEXT);
  assertFlags(triggerProblems(parse(withTarget), withTarget), 'pull_request_target in `on` (text)');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.pull_request_target = null; }), TEXT), 'pull_request_target in `on` (parsed)');
  assertFlags(triggerProblems(WF, `${TEXT}\n# on workflow_run\n`), 'text containing workflow_run');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.push.branches = ['main', 'dev']; }), TEXT), 'push to a second branch');
  assertFlags(triggerProblems(mutate((wf) => { delete wf.on.push; }), TEXT), 'no push trigger');
  // Filters that stop the gate running on some or all PRs, or on main.
  const prFilter = (filter: string) => {
    const t = TEXT.replace('on:\n  pull_request:\n', `on:\n  pull_request:\n    ${filter}\n`);
    assert.notEqual(t, TEXT);
    return triggerProblems(parse(t), t);
  };
  assertFlags(prFilter("paths-ignore: ['**']"), 'pull_request paths-ignore');
  assertFlags(prFilter('branches: [nothing]'), 'pull_request branches');
  assertFlags(prFilter('types: [closed]'), 'pull_request types');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.push['paths-ignore'] = ['**']; }), TEXT), 'push paths-ignore');
});

test('verify matrix covers Node 22.18.0 and Node 24 on Ubuntu and macOS, every test shard in each', () => {
  const verify = WF.jobs.verify;
  assert.equal(verify['runs-on'], '${{ matrix.os }}');
  assert.equal(verify.strategy['fail-fast'], false);
  assert.deepEqual(verify.strategy.matrix.os, ['ubuntu-latest', 'macos-latest']);
  assert.deepEqual(verify.strategy.matrix.node, ['22.18.0', '24.x']);
  // k/N for every k: a missing shard would silently skip its share of the test files.
  const shards: string[] = verify.strategy.matrix.shard;
  assert.deepEqual(shards, shards.map((_, i) => `${i + 1}/${shards.length}`));
  assert.equal(stepNamed(WF, 'verify', 'Run tests').run, SHARDED_TEST_CMD);
  assert.deepEqual(stepNamed(WF, 'verify', 'Run tests').env, TEST_ENV);
  assert.equal(typeof verify['timeout-minutes'], 'number');
  const setup = stepsOf(verify).filter((s) => usesAction(s, 'actions/setup-node'));
  assert.equal(setup.length, 1);
  assert.equal(setup[0].with['node-version'], '${{ matrix.node }}');
  // One check per cell, under the names branch protection requires.
  assert.equal(verify.name, 'verify (${{ matrix.os }}, node ${{ matrix.node }}, shard ${{ matrix.shard }})');
  assert.deepEqual(Object.keys(verify.strategy), ['fail-fast', 'matrix']);
  assert.deepEqual(Object.keys(verify.strategy.matrix), ['os', 'node', 'shard']);

  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.strategy.matrix.exclude = [{ node: '22.18.0' }]; })), 'a matrix exclude dropping the floor');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.strategy.matrix.exclude = [{ os: 'macos-latest' }]; })), 'a matrix exclude dropping macOS');
  assertFlags(hardeningProblems(mutate((wf) => {
    wf.jobs.verify.strategy.matrix.include = [{ os: 'macos-latest', node: '24.x', extra: true }];
  })), 'a matrix include');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.strategy['fail-fast'] = true; })), 'fail-fast: true');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.strategy.matrix.shard = ['1/2']; })), 'a shard dropped');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Run tests').env.TEST_SHARD = '${{ github.event.pull_request.title }}'; })), 'TEST_SHARD from the PR title');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Run tests').run = TEST_CMD; })), 'the shard env on an unsharded run');
  assertFlags(verifyListProblems(AGENTS, mutate((wf) => { stepNamed(wf, 'verify', 'Run tests').run = 'node --test --test-shard="$TEST_SHARD" "test/a.test.ts"'; })), 'a sharded run over fewer files');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.name = 'build'; })), 'verify renamed');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.audit.strategy = { matrix: { os: ['ubuntu-latest'] } }; })), 'a strategy on audit');
  assertFlags(hardeningProblems(mutate((wf) => {
    stepNamed(wf, 'verify', 'Set up Node ${{ matrix.node }}').with['node-version'] = '24.x';
  })), 'a hard-coded node-version');
});

test('ci runs the AGENTS.md verify list in the same order and nothing else', () => {
  assert.deepEqual(verifyListProblems(AGENTS, WF), []);
  assert.deepEqual(agentsVerifyCommands(AGENTS), [
    'npm ci',
    'npm run typecheck',
    'npm run check:dashboard',
    'npm run build:dashboard',
    STALE_CMD,
    'node --test "test/*.test.ts"',
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
    const steps = wf.jobs.verify.steps;
    const a = steps.findIndex((s: Step) => s.name === 'Typecheck engine and tests');
    const b = steps.findIndex((s: Step) => s.name === 'Check dashboard sources');
    [steps[a], steps[b]] = [steps[b], steps[a]];
  })), 'two CI steps are swapped');
  assertFlags(verifyListProblems(AGENTS, mutate((wf) => { wf.jobs.verify.steps.push({ name: 'Extra', run: 'npm run extra' }); })), 'CI gains an extra run step');
  assertFlags(verifyListProblems(AGENTS, mutate((wf) => { delete stepNamed(wf, 'verify', 'Run tests').name; })), 'a step with no name');
  assertFlags(verifyListProblems(AGENTS, mutate((wf) => { stepNamed(wf, 'audit', 'Set up Node').name = 'Check out'; })), 'two steps with one name');
});

test('the stale dist step fails and names the stale files', POSIX, () => {
  const script = stepRunning('verify', (r) => r.includes(STALE_CMD));
  const repo = tempRepo();
  try {
    const dist = path.join(repo.dir, 'dashboard', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'a.js'), 'export const a = 1;\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'dist');

    const clean = bash(script, repo.dir);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout + clean.stderr, '');

    fs.writeFileSync(path.join(repo.dir, 'README.md'), '# changed\n');
    const readmeOnly = bash(script, repo.dir);
    assert.equal(readmeOnly.status, 0, readmeOnly.stderr);
    assert.equal(readmeOnly.stdout + readmeOnly.stderr, '');

    fs.writeFileSync(path.join(dist, 'a.js'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(dist, 'b.js'), 'export const b = 1;\n');
    const stale = bash(script, repo.dir);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /^::error title=Stale dashboard\/dist::dashboard\/dist is stale: run npm run build:dashboard and commit dashboard\/dist$/m);
    assert.match(stale.stdout, /^Stale files:$/m);
    assert.match(stale.stdout, /^ M dashboard\/dist\/a\.js$/m);
    assert.match(stale.stdout, /^\?\? dashboard\/dist\/b\.js$/m);
  } finally {
    repo.cleanup();
  }

  // AC3 maps this script to its git command, so extra lines in it must fail elsewhere; both of these pass the scratch repo above.
  assert.deepEqual(hardeningProblems(WF), []);
  const prepend = (line: string) => mutate((wf) => {
    const step = stepNamed(wf, 'verify', 'Check dashboard/dist is committed');
    step.run = `${line}\n${step.run}`;
  });
  for (const line of ['for t in test/*.test.ts; do : > "$t"; done', 'git checkout HEAD~50 -- test lib']) {
    assert.deepEqual(verifyListProblems(AGENTS, prepend(line)), [], 'the list check alone does not see it');
    assertFlags(hardeningProblems(prepend(line)), `the stale-dist script also running ${line}`);
  }
});

test('the syntax-check step fails when any file has a syntax error, not only the last', POSIX, () => {
  const script = stepRunning('verify', (r) => r.includes('node --check'));
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

test('the Claude Code CLI is pinned and plugin validation always runs', () => {
  assert.deepEqual(cliProblems(WF), []);
  assert.match(stepRunning('verify', (r) => CLI_INSTALL.test(r)), /^npm install -g @anthropic-ai\/claude-code@\d+\.\d+\.\d+$/);

  const setInstall = (run: string) => mutate((wf) => { stepNamed(wf, 'verify', 'Install Claude Code CLI').run = run; });
  assertFlags(cliProblems(setInstall('npm install -g @anthropic-ai/claude-code@latest')), 'an install at @latest');
  assertFlags(cliProblems(setInstall('npm install -g @anthropic-ai/claude-code')), 'an install with no version');
  assertFlags(cliProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Validate plugin').if = false; })), 'if: false on the validate step');
  assertFlags(cliProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Validate plugin')['continue-on-error'] = true; })), 'continue-on-error on the validate step');
  assertFlags(cliProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Install Claude Code CLI').if = "runner.os == 'Linux'"; })), 'a condition on the install step');
  assertFlags(cliProblems(mutate((wf) => {
    wf.jobs.verify.steps = wf.jobs.verify.steps.filter((s: Step) => s.run !== VALIDATE);
  })), 'no validate step');
  assertFlags(cliProblems(mutate((wf) => {
    const steps = wf.jobs.verify.steps;
    const i = steps.findIndex((s: Step) => s.name === 'Install Claude Code CLI');
    [steps[i], steps[i + 1]] = [steps[i + 1], steps[i]];
  })), 'install after validate');
  // The last install wins, so a second one could run validation on any version.
  const downgrade = mutate((wf) => {
    const steps = wf.jobs.verify.steps;
    const i = steps.findIndex((s: Step) => s.run === VALIDATE);
    steps.splice(i, 0, { name: 'Downgrade Claude Code CLI', run: 'npm install -g @anthropic-ai/claude-code@1.0.0' });
  });
  assert.deepEqual(verifyListProblems(AGENTS, downgrade), [], 'the list check skips every install');
  assertFlags(cliProblems(downgrade), 'a second, pinned install just before validate');
  assertFlags(cliProblems(mutate((wf) => {
    const steps = wf.jobs.verify.steps;
    const i = steps.findIndex((s: Step) => s.name === 'Install Claude Code CLI');
    steps.splice(i - 1, 0, steps.splice(i, 1)[0]);
  })), 'an install that is not directly before validate');
});

test('the audit job blocks on runtime advisories and only reports devDependency ones', () => {
  const audit = WF.jobs.audit;
  assert.equal(audit['runs-on'], 'ubuntu-latest');
  const steps = stepsOf(audit);
  const setup = steps.filter((s) => usesAction(s, 'actions/setup-node'));
  assert.equal(setup.length, 1);
  assert.equal(setup[0].with['node-version-file'], '.nvmrc');
  const runtime = steps.findIndex((s) => s.run === 'npm audit --omit=dev');
  const all = steps.findIndex((s) => s.run === 'npm audit');
  assert.ok(runtime !== -1, 'a blocking runtime audit');
  assert.ok(!('continue-on-error' in steps[runtime]), 'the runtime audit blocks');
  assert.ok(all > runtime, 'the full audit comes after the runtime audit');
  assert.equal(steps[all]['continue-on-error'], true);
  assert.equal(audit.name, 'audit');

  assertFlags(hardeningProblems(mutate((wf) => {
    wf.jobs.audit.steps.splice(2, 0, { name: 'Older lockfile', run: 'git checkout HEAD~1 -- package-lock.json' });
  })), 'an extra run before the blocking audit');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'audit', 'Audit runtime dependencies').run = 'npm audit --omit=dev --audit-level=critical'; })), 'a weakened runtime audit');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.audit.name = 'verify (ubuntu-latest, node 22.18.0)'; })), 'audit renamed to a verify check name');
});

test('a new push to a PR cancels its previous run and pushes to main never cancel', () => {
  assert.equal(WF.concurrency.group, '${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}');
  assert.equal(WF.concurrency['cancel-in-progress'], true);
});

test('the token is read-only and no secret is referenced', () => {
  assert.deepEqual(permissionProblems(WF, TEXT), []);
  assertFlags(permissionProblems(mutate((wf) => { wf.permissions.contents = 'write'; }), TEXT), 'contents: write');
  assertFlags(permissionProblems(mutate((wf) => { wf.jobs.verify.permissions = 'write-all'; }), TEXT), 'job-level permissions: write-all');
  const withSecret = TEXT.replace("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
  assert.notEqual(withSecret, TEXT);
  assertFlags(permissionProblems(parse(withSecret), withSecret), 'a ${{ secrets.NPM_TOKEN }} reference');
  assertFlags(permissionProblems(WF, TEXT.replace('persist-credentials: false', 'token: ${{ github.token }}')), 'a github.token reference');
  // The same values reached through index and toJSON forms, each in a workflow-level env.
  for (const expr of ["${{ secrets['NPM_TOKEN'] }}", '${{ toJSON(secrets) }}', "${{ github['token'] }}", '${{ toJSON(github) }}']) {
    const t = TEXT.replace('\npermissions:\n', `\nenv:\n  LEAK: ${expr}\n\npermissions:\n`);
    assert.notEqual(t, TEXT);
    assertFlags(permissionProblems(parse(t), t), expr);
  }
  assertFlags(permissionProblems(WF, TEXT.replace('${{ matrix.node }}\n', '${{ github.event.pull_request.title }}\n')), 'an expression off the allowlist');
});

test('every action is pinned to a full commit SHA with its version comment', () => {
  assert.deepEqual(pinProblems(TEXT), []);
  const pin = '@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
  assert.ok(TEXT.includes(pin));
  assertFlags(pinProblems(TEXT.replace(pin, '@v7')), 'a pin rewritten to @v7');
  assertFlags(pinProblems(TEXT.replace(pin, '@3d3c42e # v7.0.1')), 'a 7-character SHA');
  assertFlags(pinProblems(TEXT.replace(pin, '@3d3c42e5aac5ba805825da76410c181273ba90b1')), 'a full SHA without the version comment');
  assertFlags(pinProblems(TEXT.replace(pin, '@3D3C42E5AAC5BA805825DA76410C181273BA90B1 # v7.0.1')), 'an uppercase SHA');
  const checkout = `      - name: Check out\n        uses: actions/checkout${pin}\n        with:\n          persist-credentials: false\n`;
  const flow = TEXT.replace(checkout, '      - { name: Check out, uses: actions/checkout@v7, with: { persist-credentials: false } }\n');
  assert.notEqual(flow, TEXT);
  assert.equal(parse(flow).jobs.verify.steps[0].uses, 'actions/checkout@v7', 'the flow-map step parses');
  assertFlags(pinProblems(flow), 'a uses hidden in a flow map');
});

test('checkout keeps no credentials, nothing is cached, and no step can mask a failure or inject an expression', () => {
  assert.deepEqual(hardeningProblems(WF), []);
  assert.equal(stepsOf(WF.jobs.verify).concat(stepsOf(WF.jobs.audit)).filter((s) => 'continue-on-error' in s).length, 1);

  assertFlags(hardeningProblems(mutate((wf) => { delete stepNamed(wf, 'verify', 'Check out').with['persist-credentials']; })), 'persist-credentials unset');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Set up Node ${{ matrix.node }}').with.cache = 'npm'; })), 'cache: npm on setup-node');
  assertFlags(hardeningProblems(mutate((wf) => { delete stepNamed(wf, 'audit', 'Set up Node').with['package-manager-cache']; })), 'package-manager-cache unset');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Run tests')['continue-on-error'] = true; })), 'continue-on-error on Run tests');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify['continue-on-error'] = true; })), 'continue-on-error on a job');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Install dependencies').run = 'npm ci || true'; })), 'npm ci || true');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Install dependencies').run = 'npm ci || :'; })), 'npm ci || :');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Run tests').run = 'set +e\nnode --test "test/*.test.ts"'; })), 'set +e');
  assertFlags(hardeningProblems(mutate((wf) => {
    stepNamed(wf, 'verify', 'Run tests').run = 'echo "${{ github.event.pull_request.title }}"';
  })), 'a run interpolating the PR title');
  assertFlags(hardeningProblems(mutate((wf) => {
    stepNamed(wf, 'verify', 'Validate plugin').env.TITLE = '${{ github.event.pull_request.title }}';
  })), 'a step env interpolating the PR title');
  assertFlags(hardeningProblems(mutate((wf) => { delete wf.defaults; })), 'defaults unset');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Syntax-check JavaScript entry points').shell = 'bash {0}'; })), 'a step dropping -e with its own shell');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.if = false; })), 'a job that never runs');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Install dependencies').run = 'npm ci || exit 0'; })), 'npm ci || exit 0');

  // `NODE_OPTIONS=--test-only` makes `node --test` exit 0 on a failing suite, from any env scope.
  const testOnly = { NODE_OPTIONS: '--test-only' };
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Run tests').env = testOnly; })), 'NODE_OPTIONS on the Run tests step');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.env = testOnly; })), 'NODE_OPTIONS on the verify job');
  assertFlags(hardeningProblems(mutate((wf) => { wf.env = testOnly; })), 'NODE_OPTIONS on the workflow');
  assertFlags(hardeningProblems(mutate((wf) => { Object.assign(stepNamed(wf, 'verify', 'Validate plugin').env, testOnly); })), 'an extra env on Validate plugin');
  assertFlags(hardeningProblems(mutate((wf) => {
    const step = stepNamed(wf, 'verify', 'Check dashboard/dist is committed');
    step.run = `echo "NODE_OPTIONS=--test-only" >> "$GITHUB_ENV"\n${step.run}`;
  })), 'a run writing GITHUB_ENV');

  // Any action other than checkout then setup-node runs code the gate never sees, however well it is pinned.
  const extraAction = { name: 'Cache', uses: `actions/cache@${'a'.repeat(40)}` };
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.steps.splice(2, 0, extraAction); })), 'an extra SHA-pinned action in verify');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.audit.steps.push(extraAction); })), 'an extra SHA-pinned action in audit');
  assertFlags(hardeningProblems(mutate((wf) => {
    const steps = wf.jobs.verify.steps;
    [steps[0], steps[1]] = [steps[1], steps[0]];
  })), 'setup-node before checkout');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.steps.shift(); })), 'no checkout');

  // Keys outside the allowlists.
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Run tests')['working-directory'] = 'docs'; })), 'a step working-directory');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Run tests')['timeout-minutes'] = 1; })), 'a step timeout');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.verify.container = 'node:22'; })), 'a job container');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.extra = { 'runs-on': 'ubuntu-latest', steps: [] }; })), 'an extra job');
  assertFlags(hardeningProblems(mutate((wf) => { wf.defaults.run['working-directory'] = 'docs'; })), 'a default working-directory');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Check out').with.ref = 'main'; })), 'a checkout ref');
  assertFlags(hardeningProblems(mutate((wf) => {
    stepNamed(wf, 'verify', 'Set up Node ${{ matrix.node }}').with['registry-url'] = 'https://registry.npmjs.org';
  })), 'a setup-node registry-url');
});

test('.nvmrc, the engines floor and the matrix floor agree', () => {
  const nvmrc = read('.nvmrc');
  assert.equal(nvmrc, '22.18.0\n');
  const engines = JSON.parse(read('package.json')).engines.node;
  const m = engines.match(/^>=(\d+)\.(\d+)(?:\.(\d+))?$/);
  assert.ok(m, `engines.node is a >= floor: ${engines}`);
  const floor = `${m[1]}.${m[2]}.${m[3] ?? 0}`;
  assert.equal(nvmrc.trim(), floor);
  assert.equal(WF.jobs.verify.strategy.matrix.node[0], floor);
});

test('the CLI starts without a type-stripping warning on this Node', () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'forge'), 'version'], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).version, JSON.parse(read('package.json')).version);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
});

test('README carries the CI badge and the Node 22.18 floor', () => {
  const lines = read('README.md').split('\n');
  const version = lines.findIndex((l) => l.includes('<img alt="version"'));
  assert.ok(version !== -1, 'the version badge');
  const open = lines.lastIndexOf('<p align="center">', version);
  const close = lines.indexOf('</p>', version);
  assert.ok(open !== -1 && close !== -1 && !lines.slice(open + 1, version).includes('</p>'), 'the version badge sits in a centred badge block');

  const ci = lines[version + 1].match(/^\s*<a href="([^"]+)"><img alt="CI" src="([^"]+)"><\/a>$/);
  assert.ok(ci && version + 1 < close, 'the CI badge directly follows the version badge, in the same block');
  assert.equal(ci[1], 'https://github.com/maxwellmattryan/forge/actions/workflows/ci.yml');
  assert.ok(ci[2].includes('img.shields.io/github/actions/workflow/status/maxwellmattryan/forge/ci.yml'), ci[2]);

  const node = lines.slice(open, close).find((l) => l.includes('<img alt="node"'));
  assert.ok(node, 'the Node badge is in the block');
  assert.ok(node.includes('node-%E2%89%A522.18-'), node);
  assert.ok(!lines.join('\n').includes('%E2%89%A520-'), 'no badge still says >=20');
});

test('AGENTS.md says CI runs the verify list and names the pinned CLI version', () => {
  const section = (heading: string) => {
    const start = AGENTS.indexOf(`\n${heading}\n`);
    assert.ok(start !== -1, heading);
    const end = AGENTS.indexOf('\n## ', start + 1);
    return AGENTS.slice(start, end === -1 ? undefined : end);
  };
  const verify = section('## Verify before claiming it works');
  assert.ok(verify.includes('.github/workflows/ci.yml'));
  assert.ok(verify.includes('test/ci-workflow.test.ts'));
  const pkg = cliPackage(WF);
  assert.ok(pkg, 'the workflow pins the CLI');
  assert.ok(verify.includes(pkg), `the verify section names ${pkg}`);
  assert.deepEqual(verifyListProblems(AGENTS, WF), [], 'the fence is in CI order');

  assert.match(section('## Layout'), /^- `\.github\/workflows\/ci\.yml`: /m);
  assert.match(section('## Where a change goes'), /^\| CI \| `\.github\/workflows\/ci\.yml` \| .*`test\/ci-workflow\.test\.ts` \|$/m);
});
