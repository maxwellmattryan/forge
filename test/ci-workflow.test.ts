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
import { planWindowsRun } from '../scripts/windows-plan.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

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
const JOBS = ['audit', 'release-check', 'verify', 'windows'];
const JOB_KEYS = ['name', 'needs', 'runs-on', 'timeout-minutes', 'strategy', 'steps'];
// Only the release check waits, and only on verify: it adds nothing when the suite is red.
const NEEDS: Record<string, string> = { 'release-check': 'verify' };
// release.yml and main-update.yml call this workflow whole; inputs or secrets on the call would let a caller reshape
// the gate. main-update.yml dispatches it on ci/main-update with no inputs, and the token here stays read-only.
const TRIGGERS = ['pull_request', 'push', 'workflow_call', 'workflow_dispatch'];
const STEP_KEYS = ['name', 'uses', 'with', 'run', 'env', 'continue-on-error'];
const ACTIONS = ['actions/checkout', 'actions/setup-node'];
const VALIDATE_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
// Each verify cell runs one shard of the test files. The shard reaches the command through env, not
// interpolated into run, and the strategy pin below holds the matrix to every shard of the split.
const TEST_CMD = 'node --test "test/*.test.ts"';
const SHARDED_TEST_CMD = 'node --test --test-shard="$TEST_SHARD" "test/*.test.ts"';
// FORGE_REQUIRE_DIST turns the real-build tests' skip into a run (test/dist.ts): the step before built it.
const TEST_ENV = { TEST_SHARD: '${{ matrix.shard }}', FORGE_REQUIRE_DIST: '1' };
// develop never tracks dashboard/dist; main and the main-update PR head must. The ref reaches the script through env.
const REF_EXPR = '${{ github.base_ref || github.ref_name }}';
const RELEASE_CHECK_RUN = [
  'case "$REF" in',
  '  develop) npm run release:check -- --dist absent ;;',
  '  main | ci/main-update) npm run release:check -- --dist present ;;',
  '  *) npm run release:check ;;',
  'esac',
].join('\n');
const RELEASE_CHECK_ENV = { REF: REF_EXPR };
// The only steps that may set env, each to exactly this map.
const STEP_ENVS: Record<string, Record<string, string>> = { [VALIDATE]: VALIDATE_ENV, [SHARDED_TEST_CMD]: TEST_ENV, [RELEASE_CHECK_RUN]: RELEASE_CHECK_ENV };
// The Windows leg: no matrix, one Node, and exactly these runs. Its test step's one env key, WINDOWS_SKIP, is free text,
// so it is validated (planWindowsRun, as the script does) rather than pinned.
const WINDOWS_CMD = 'node scripts/windows-tests.ts';
const WINDOWS_RUNS = ['npm ci', 'npm run typecheck', WINDOWS_CMD];
const TEST_FILES = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.ts')).sort().map((f) => `test/${f}`);
// Values pinned exactly, not just by key: each is free text a one-line edit could use to drop coverage or mask a failure.
// Branch protection, once set, requires checks by these names, so a rename would leave a required check waiting forever.
const JOB_NAMES: Record<string, string> = {
  verify: 'verify (${{ matrix.os }}, node ${{ matrix.node }}, shard ${{ matrix.shard }})',
  audit: 'audit',
  'release-check': 'release check',
  windows: 'windows (node 22.18.0)',
};
// An `exclude` or `include` under the matrix silently drops or swaps a cell.
const STRATEGIES: Record<string, unknown> = {
  verify: { 'fail-fast': false, matrix: { os: ['ubuntu-latest', 'macos-latest'], node: ['22.18.0', '24.x'], shard: ['1/2', '2/2'] } },
};
const SETUP_NODE_WITH: Record<string, unknown> = {
  verify: { 'node-version': '${{ matrix.node }}', 'package-manager-cache': false },
  audit: { 'node-version-file': '.nvmrc', 'package-manager-cache': false },
  'release-check': { 'node-version-file': '.nvmrc', 'package-manager-cache': false },
  windows: { 'node-version': '22.18.0', 'package-manager-cache': false },
};
// An extra step before the blocking audit could swap the lockfile it reads.
const AUDIT_RUNS = ['npm audit --omit=dev', 'npm audit'];
// Built-ins only, so no `npm ci` first: nothing from the registry runs before it.
const RELEASE_CHECK_RUNS = [`${RELEASE_CHECK_RUN}\n`];
const EXPRESSIONS = [
  '${{ matrix.os }}',
  '${{ matrix.node }}',
  '${{ matrix.shard }}',
  '${{ github.workflow }}',
  '${{ github.event.pull_request.number || github.sha }}',
  REF_EXPR,
];
// These and the expression allowlist read the raw text, comments included, so a comment saying "no secrets" fails too
// (WINDOWS_SKIP file names aside: see withoutSkipFileNames).
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

/** The Windows test step's env: exactly WINDOWS_SKIP, a literal list the script would accept. */
function windowsEnvProblems(env: unknown, at: string): string[] {
  if (!isMap(env) || !isDeepStrictEqual(Object.keys(env), ['WINDOWS_SKIP'])) return [`${at}: env must be exactly WINDOWS_SKIP`];
  const skip = env.WINDOWS_SKIP;
  if (typeof skip !== 'string') return [`${at}: WINDOWS_SKIP must be a literal block`];
  if (skip.includes('${{')) return [`${at}: env WINDOWS_SKIP must not interpolate an expression`];
  return planWindowsRun(skip, TEST_FILES).problems.map((p) => `${at}: WINDOWS_SKIP ${p}`);
}

function triggerProblems(wf: any, text: string): string[] {
  const out: string[] = [];
  const on = wf?.on;
  if (!on || typeof on !== 'object' || Array.isArray(on)) {
    out.push('`on` must be a map of events');
  } else {
    const events = Object.keys(on).sort();
    if (!isDeepStrictEqual(events, TRIGGERS)) out.push(`\`on\` must be exactly ${TRIGGERS.join(', ')}, got ${events.join(', ')}`);
    if (!(on.workflow_call === null || (isMap(on.workflow_call) && !Object.keys(on.workflow_call).length)))
      out.push('workflow_call must take no inputs, secrets or outputs');
    // A filter (branches, paths, paths-ignore, types) quietly stops the gate running on some PRs.
    if (!(on.pull_request === null || (isMap(on.pull_request) && !Object.keys(on.pull_request).length)))
      out.push('pull_request must have no filters');
    if (!isDeepStrictEqual(on.push, { branches: ['develop', 'main'] })) out.push('push must be exactly branches: [develop, main], with no other filter');
    // Inputs would let a dispatcher reshape the gate.
    if (on.workflow_dispatch !== null) out.push('workflow_dispatch must take no inputs');
  }
  // Both hand fork code a write token and secrets.
  for (const word of ['pull_request_target', 'workflow_run']) if (text.includes(word)) out.push(`the workflow must not mention ${word}`);
  return out;
}

// The one exemption from the raw-text secrets check: a WINDOWS_SKIP entry's file name, so test/secrets.test.ts can
// be listed. Only the leading `test/<name>.test.ts` of a line inside that block is dropped; its reason is still read.
const SKIP_ENTRY_FILE = /^(\s+)test\/[A-Za-z0-9._-]+\.test\.ts(?=: )/;

function withoutSkipFileNames(text: string): string {
  const lines = text.split('\n');
  let indent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lead = line.length - line.trimStart().length;
    if (indent >= 0 && line.trim() && lead <= indent) indent = -1;
    if (indent >= 0) lines[i] = line.replace(SKIP_ENTRY_FILE, '$1');
    else if (/^\s*WINDOWS_SKIP:\s*\|\s*$/.test(line)) indent = lead;
  }
  return lines.join('\n');
}

function permissionProblems(wf: any, text: string): string[] {
  const out: string[] = [];
  if (!isDeepStrictEqual(wf?.permissions, { contents: 'read' })) out.push('top-level permissions must be exactly { contents: read }');
  for (const [id, job] of jobsOf(wf)) if (job && typeof job === 'object' && 'permissions' in job) out.push(`job ${id} must not set permissions`);
  const scanned = withoutSkipFileNames(text);
  if (scanned.includes('secrets.')) out.push('the workflow must not reference secrets.');
  if (text.includes('github.token')) out.push('the workflow must not reference github.token');
  // Index and toJSON forms reach the same values: secrets['X'], toJSON(secrets), github['token'], toJSON(github).
  if (SECRETS.test(scanned)) out.push('the workflow must not reference the secrets context');
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
    if (!isDeepStrictEqual(job.needs, NEEDS[id])) out.push(id in NEEDS ? `job ${id} must set exactly needs: ${NEEDS[id]}` : `job ${id} must not set needs`);
    if (!isDeepStrictEqual(job.strategy, STRATEGIES[id]))
      out.push(id in STRATEGIES ? `job ${id} strategy must be exactly ${JSON.stringify(STRATEGIES[id])}` : `job ${id} must not set strategy`);
    if (id === 'audit') {
      const runs = stepsOf(job).map(runOf).filter((r) => r !== null);
      if (!isDeepStrictEqual(runs, AUDIT_RUNS)) out.push(`job audit must run exactly ${AUDIT_RUNS.join(', then ')}`);
    }
    if (id === 'release-check') {
      const runs = stepsOf(job).map(runOf).filter((r) => r !== null);
      if (!isDeepStrictEqual(runs, RELEASE_CHECK_RUNS)) out.push(`job release-check must run exactly ${RELEASE_CHECK_RUNS.join(', then ')}`);
    }
    if (id === 'windows') {
      const runs = stepsOf(job).map(runOf).filter((r) => r !== null);
      if (!isDeepStrictEqual(runs, WINDOWS_RUNS)) out.push(`job windows must run exactly ${WINDOWS_RUNS.join(', then ')}`);
      if (job['runs-on'] !== 'windows-latest') out.push('job windows must run on windows-latest');
      if (typeof job['timeout-minutes'] !== 'number') out.push('job windows must set timeout-minutes');
      if (stepsOf(job).some((st) => runOf(st)?.trim() === WINDOWS_CMD && !('env' in st))) out.push('job windows must pass WINDOWS_SKIP to its test step');
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
      }
      if ('env' in step && id === 'windows' && run?.trim() === WINDOWS_CMD) {
        out.push(...windowsEnvProblems(step.env, at));
      } else if ('env' in step) {
        const allowed = run !== null && Object.hasOwn(STEP_ENVS, run.trim()) ? STEP_ENVS[run.trim()] : undefined;
        // Each allowed map is pinned exactly; TEST_SHARD's expression is a matrix value the workflow fixes itself.
        if (!allowed || !isDeepStrictEqual(step.env, allowed)) {
          out.push(`${at}: only Validate plugin, the sharded Run tests, the release check and the Windows test step may set env, each only to its allowed map`);
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

/** The verify job's `run` steps as the same list: the CLI install is setup. */
function ciVerifyCommands(wf: any): string[] {
  return stepsOf(wf?.jobs?.verify).flatMap((step) => {
    const run = runOf(step);
    if (run === null) return [];
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

test('workflow triggers on pull_request, pushes to develop and main, workflow_call and a bare workflow_dispatch', () => {
  assert.equal(WF.name, 'CI');
  assert.deepEqual(triggerProblems(WF, TEXT), []);
  assert.deepEqual(WF.on.push, { branches: ['develop', 'main'] });
  assert.equal(WF.on.workflow_dispatch, null, 'main-update.yml dispatches it with nothing passed in');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.push.branches = ['main']; }), TEXT), 'develop dropped from push');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.push.branches = ['develop', 'main', 'release']; }), TEXT), 'a third push branch');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.workflow_dispatch = { inputs: { ref: { type: 'string' } } }; }), TEXT), 'workflow_dispatch with inputs');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.workflow_dispatch = {}; }), TEXT), 'workflow_dispatch as an empty map');
  assertFlags(triggerProblems(mutate((wf) => { delete wf.on.workflow_dispatch; }), TEXT), 'no workflow_dispatch');

  const withTarget = TEXT.replace('on:\n  pull_request:\n', 'on:\n  pull_request:\n  pull_request_target:\n');
  assert.notEqual(withTarget, TEXT);
  assertFlags(triggerProblems(parse(withTarget), withTarget), 'pull_request_target in `on` (text)');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.pull_request_target = null; }), TEXT), 'pull_request_target in `on` (parsed)');
  assertFlags(triggerProblems(WF, `${TEXT}\n# on workflow_run\n`), 'text containing workflow_run');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.push.branches = ['main', 'dev']; }), TEXT), 'push to another branch');
  assertFlags(triggerProblems(mutate((wf) => { delete wf.on.push; }), TEXT), 'no push trigger');
  assert.equal(WF.on.workflow_call, null, 'release.yml can call it, with nothing passed in');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.workflow_call = { inputs: { ref: { type: 'string' } } }; }), TEXT), 'workflow_call with inputs');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.workflow_call = { secrets: { NPM: { required: false } } }; }), TEXT), 'workflow_call with secrets');
  assertFlags(triggerProblems(mutate((wf) => { delete wf.on.workflow_call; }), TEXT), 'no workflow_call');
  assertFlags(triggerProblems(mutate((wf) => { wf.on.schedule = [{ cron: '0 0 * * *' }]; }), TEXT), 'a schedule trigger');
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

test('the release check job runs after verify, with built-ins only', () => {
  const job = WF.jobs['release-check'];
  assert.equal(job.name, 'release check');
  assert.equal(job.needs, 'verify');
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(typeof job['timeout-minutes'], 'number');
  assert.deepEqual(stepsOf(job).map((s) => s.uses?.split('@')[0] ?? s.run), ['actions/checkout', 'actions/setup-node', `${RELEASE_CHECK_RUN}\n`]);
  assert.deepEqual(stepNamed(WF, 'release-check', 'Check release metadata').env, RELEASE_CHECK_ENV);
  assert.deepEqual(JSON.parse(read('package.json')).scripts['release:check'], 'node scripts/release-check.ts');
  assert.deepEqual(hardeningProblems(WF), []);
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'release-check', 'Check release metadata').env.REF = '${{ github.head_ref }}'; })), 'REF from the PR head branch');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'release-check', 'Check release metadata').run = 'npm run release:check\n'; })), 'the --dist choice dropped');

  for (const other of ['verify', 'audit']) assertFlags(hardeningProblems(mutate((wf) => { wf.jobs[other].needs = 'release-check'; })), `needs on ${other}`);
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs['release-check'].steps.push({ name: 'Extra', run: 'npm ci' }); })), 'a second run step in release-check');
  assertFlags(hardeningProblems(mutate((wf) => {
    wf.jobs['release-check'].steps.splice(2, 0, { name: 'Install dependencies', run: 'npm ci' });
  })), 'npm ci before the release check');
  assertFlags(hardeningProblems(mutate((wf) => { delete wf.jobs['release-check'].needs; })), 'release-check without needs');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs['release-check'].needs = 'audit'; })), 'release-check needing audit');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs['release-check'].name = 'release'; })), 'release check renamed');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'release-check', 'Check release metadata').run = 'npm run release:check || true'; })), 'a masked release check');
  assertFlags(hardeningProblems(mutate((wf) => { delete stepNamed(wf, 'release-check', 'Check out').with['persist-credentials']; })), 'release-check checkout keeping credentials');
});

test('the release check picks --dist from the PR base or the branch', POSIX, () => {
  const script = stepRunning('release-check', (r) => r.includes('release:check'));
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
    assert.equal(ran('ci/main-update'), 'run release:check -- --dist present');
    for (const other of ['forge/309-x', 'develop2', 'main/x', '']) assert.equal(ran(other), 'run release:check', JSON.stringify(other));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

  // The word is allowed only as a WINDOWS_SKIP entry's file name, never in its reason or anywhere else.
  assert.ok(TEXT.includes('            test/secrets.test.ts: '), 'the real list names test/secrets.test.ts');
  const skipLine = '            test/daemon.test.ts: spawns';
  const swap = (from: string, to: string) => {
    const t = TEXT.replace(from, to);
    assert.notEqual(t, TEXT, from);
    return permissionProblems(parse(t), t);
  };
  assertFlags(swap(skipLine, '            test/daemon.test.ts: reads secrets and spawns'), 'the word in a skip reason');
  assertFlags(swap(skipLine, '            secrets.NPM_TOKEN\n            test/daemon.test.ts: spawns'), 'a bare secrets. line inside WINDOWS_SKIP');
  assertFlags(swap(skipLine, '            test/secrets.test.ts.x: y\n            test/daemon.test.ts: spawns'), 'a name that is not one test file');
  assertFlags(swap('      - name: Typecheck engine and tests\n', '      # test/secrets.test.ts: x\n      - name: Typecheck engine and tests\n'), 'a file-name line outside WINDOWS_SKIP');
  assertFlags(swap('          WINDOWS_SKIP: |\n', '          WINDOWS_SKIP: |\n            test/secrets.test.ts: x\n          NOTE: |\n            test/secrets.test.ts: x\n'), 'a file-name line in a later block');
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
    const step = stepNamed(wf, 'verify', 'Build dashboard');
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
  assert.ok(verify.includes('](docs/CI.md)'), 'the verify section links docs/CI.md');
  // The Windows leg sits outside the list; both say what it runs, and docs/CI.md how its skips are held.
  const ci = read('docs/CI.md');
  for (const s of ['windows-latest', 'WINDOWS_SKIP', 'windows (node 22.18.0)', 'scripts/windows-tests.ts', 'npm run typecheck']) {
    assert.ok(verify.includes(s), s);
    assert.ok(ci.includes(s), `docs/CI.md: ${s}`);
  }
  assert.ok(ci.includes('test/ci-workflow.test.ts') && ci.includes('every Windows skip names an existing test file and its reason'));
  const pkg = cliPackage(WF);
  assert.ok(pkg, 'the workflow pins the CLI');
  assert.ok(verify.includes(pkg), `the verify section names ${pkg}`);
  assert.ok(ci.includes(pkg), `docs/CI.md names ${pkg}`);
  assert.deepEqual(verifyListProblems(AGENTS, WF), [], 'the fence is in CI order');

  assert.match(section('## Layout'), /^- `\.github\/workflows\/ci\.yml`: /m);
  assert.match(section('## Where a change goes'), /^\| CI \| `\.github\/workflows\/ci\.yml` \| .*`test\/ci-workflow\.test\.ts` \|$/m);
});

// ---------- the Windows leg ----------

const windowsStep = (wf: any): Step => stepNamed(wf, 'windows', 'Run the tests that pass on Windows');
const skipText = (wf: any): string => windowsStep(wf).env.WINDOWS_SKIP;
const withSkip = (text: string) => mutate((wf) => { windowsStep(wf).env.WINDOWS_SKIP = text; });

test('the Windows leg runs typecheck and the skip-filtered tests and nothing else', () => {
  const win = WF.jobs.windows;
  assert.equal(win.name, 'windows (node 22.18.0)');
  assert.equal(win['runs-on'], 'windows-latest');
  assert.equal(typeof win['timeout-minutes'], 'number');
  assert.ok(!('strategy' in win), 'no matrix');
  const steps = stepsOf(win);
  assert.ok(usesAction(steps[0], 'actions/checkout'));
  assert.deepEqual(steps[0].with, { 'persist-credentials': false });
  assert.ok(usesAction(steps[1], 'actions/setup-node'));
  assert.deepEqual(steps[1].with, { 'node-version': '22.18.0', 'package-manager-cache': false });
  assert.deepEqual(steps.map(runOf).filter((r) => r !== null), WINDOWS_RUNS);
  assert.deepEqual(Object.keys(windowsStep(WF).env), ['WINDOWS_SKIP']);
  assert.deepEqual(steps.filter((st) => 'env' in st).length, 1, 'only the test step sets env');
  assert.deepEqual(hardeningProblems(WF), []);
  assert.deepEqual(verifyListProblems(AGENTS, WF), [], 'the verify list is the verify job alone');

  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.windows.name = 'windows'; })), 'windows renamed');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.windows.strategy = { matrix: { node: ['22.18.0', '24.x'] } }; })), 'a matrix on windows');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.windows.steps.push({ name: 'Extra', run: 'npm run extra' }); })), 'an extra run step');
  assertFlags(hardeningProblems(mutate((wf) => {
    wf.jobs.windows.steps.splice(4, 0, { name: 'Empty the tests', run: 'for t in test/*.test.ts; do : > "$t"; done' });
  })), 'a run step before the tests');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'windows', 'Set up Node 22.18.0').with['node-version'] = '24.x'; })), 'node changed');
  assertFlags(hardeningProblems(mutate((wf) => { wf.jobs.windows['runs-on'] = 'ubuntu-latest'; })), 'off windows-latest');
  assertFlags(hardeningProblems(mutate((wf) => { delete wf.jobs.windows['timeout-minutes']; })), 'no timeout');
  assertFlags(hardeningProblems(mutate((wf) => { windowsStep(wf).run = 'node --test "test/*.test.ts"'; })), 'the script swapped for a plain run');
  assertFlags(hardeningProblems(mutate((wf) => { windowsStep(wf).run = `${WINDOWS_CMD} || true`; })), 'a masked test step');
  assertFlags(hardeningProblems(mutate((wf) => { windowsStep(wf)['continue-on-error'] = true; })), 'continue-on-error on the test step');
  assertFlags(hardeningProblems(mutate((wf) => { delete stepNamed(wf, 'windows', 'Check out').with['persist-credentials']; })), 'credentials kept');
  assertFlags(hardeningProblems(mutate((wf) => { delete windowsStep(wf).env; })), 'no WINDOWS_SKIP at all');
  // NODE_OPTIONS=--test-only or a second key would change what runs; GITHUB_ENV would reach the test step from another.
  assertFlags(hardeningProblems(mutate((wf) => { windowsStep(wf).env.NODE_OPTIONS = '--test-only'; })), 'NODE_OPTIONS beside WINDOWS_SKIP');
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'windows', 'Install dependencies').env = { WINDOWS_SKIP: 'test/a.test.ts: x' }; })), 'env on another windows step');
  assertFlags(hardeningProblems(mutate((wf) => {
    stepNamed(wf, 'windows', 'Install dependencies').run = 'echo "WINDOWS_SKIP=test/cli.test.ts: x" >> "$GITHUB_ENV"\nnpm ci';
  })), 'a run writing GITHUB_ENV');
  assertFlags(hardeningProblems(mutate((wf) => { windowsStep(wf).env.WINDOWS_SKIP = '${{ github.event.pull_request.title }}'; })), 'WINDOWS_SKIP from an expression');
  const expr = TEXT.replace('            test/daemon.test.ts:', '            ${{ github.event.pull_request.body }}\n            test/daemon.test.ts:');
  assert.notEqual(expr, TEXT);
  assertFlags(permissionProblems(parse(expr), expr), 'an expression inside WINDOWS_SKIP (text)');
  // WINDOWS_SKIP belongs to the Windows step alone.
  assertFlags(hardeningProblems(mutate((wf) => { stepNamed(wf, 'verify', 'Run tests').env.WINDOWS_SKIP = skipText(WF); })), 'WINDOWS_SKIP on verify');
});

test('every Windows skip names an existing test file and its reason', () => {
  const text = skipText(WF);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const plan = planWindowsRun(text, TEST_FILES);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.skipped.length, lines.length, 'every line is one skip');
  for (const [file, reason] of plan.skipped) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    assert.ok(reason.trim().length > 0, file);
  }
  assert.ok(plan.run.length > 0);
  assert.equal(plan.run.length + plan.skipped.length, TEST_FILES.length);

  const [first] = plan.skipped;
  const mutations: [string, string][] = [
    ['a line with no reason', `${text}test/acs.test.ts\n`],
    ['a line ending in a bare colon', `${text}test/acs.test.ts:\n`],
    ['a whitespace reason', `${text}test/acs.test.ts:    \t\n`],
    ['a missing file', `${text}test/no-such-file.test.ts: gone\n`],
    ['a glob', `${text}test/*.test.ts: everything\n`],
    ['a directory', `${text}test/: everything\n`],
    ['a nested path', `${text}test/fixtures/a.test.ts: nested\n`],
    ['a path outside test/', `${text}lib/cli.test.ts: elsewhere\n`],
    ['a file that is not a .test.ts', `${text}test/helpers.ts: not a test\n`],
    ['a duplicate', `${text}${first[0]}: ${first[1]} again\n`],
    ['a list that skips every file', TEST_FILES.map((f) => `${f}: all of them`).join('\n')],
  ];
  for (const [what, mutated] of mutations) {
    assertFlags(planWindowsRun(mutated, TEST_FILES).problems, what);
    assertFlags(hardeningProblems(withSkip(mutated)), `${what} (in the workflow)`);
  }
  // Blank lines and surrounding whitespace are not entries.
  assert.deepEqual(planWindowsRun(`\n  ${first[0]}: ${first[1]}  \n\n`, TEST_FILES).skipped, [[first[0], first[1]]]);
  assert.deepEqual(planWindowsRun('', TEST_FILES).run, TEST_FILES);
  // A hostile line costs linear time.
  const started = Date.now();
  assertFlags(planWindowsRun(`test/${'a'.repeat(10_000)}.test.ts${': '.repeat(5_000)}`, TEST_FILES).problems, 'a 10k-character line');
  assert.ok(Date.now() - started < 1000);
});

test('windows-tests.ts fails closed and propagates the test exit code', POSIX, () => {
  const script = path.join(ROOT, 'scripts', 'windows-tests.ts');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-windows-tests-')));
  const marker = path.join(dir, 'ran');
  try {
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(
      path.join(dir, 'test', 'pass.test.ts'),
      `import test from 'node:test';\nimport fs from 'node:fs';\ntest('passes', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'x'); });\n`,
    );
    fs.writeFileSync(path.join(dir, 'test', 'fail.test.ts'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => { assert.fail('red'); });\n`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const runWith = (skip: string | undefined, entry = script) => {
      fs.rmSync(marker, { force: true });
      const e = { ...env };
      if (skip === undefined) delete e.WINDOWS_SKIP;
      else e.WINDOWS_SKIP = skip;
      const r = spawnSync(process.execPath, [entry], { cwd: dir, env: e, encoding: 'utf8' });
      return { ...r, ran: fs.existsSync(marker) };
    };

    for (const bad of ['test/fail.test.ts', 'test/fail.test.ts:   ', 'test/*.test.ts: all', 'test/: all', 'test/gone.test.ts: x', 'test/fail.test.ts: a\ntest/fail.test.ts: b', 'test/fail.test.ts: a\ntest/pass.test.ts: b']) {
      const r = runWith(bad);
      assert.equal(r.status, 1, bad);
      assert.match(r.stderr, /WINDOWS_SKIP is invalid; no tests ran/, bad);
      assert.equal(r.ran, false, `nothing ran for ${JSON.stringify(bad)}`);
    }

    const red = runWith(undefined);
    assert.notEqual(red.status, 0, 'a failing file fails the run');
    assert.equal(red.ran, true);
    const green = runWith('test/fail.test.ts: fails on purpose');
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.equal(green.ran, true);
    assert.match(green.stdout, /^skip test\/fail\.test\.ts: fails on purpose$/m);

    // Started through a symlink (argv[1] differs from the module's realpath), it still runs and still
    // fails closed: an entry-point guard here once made this exit 0 having run nothing.
    fs.symlinkSync(path.dirname(script), path.join(dir, 'scripts'));
    const linked = path.join(dir, 'scripts', 'windows-tests.ts');
    const invalid = runWith('test/nope.test.ts: gone', linked);
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.match(invalid.stderr, /WINDOWS_SKIP is invalid; no tests ran/);
    const linkedRed = runWith(undefined, linked);
    assert.notEqual(linkedRed.status, 0, 'a failing file fails the run through a symlink');
    assert.equal(linkedRed.ran, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
