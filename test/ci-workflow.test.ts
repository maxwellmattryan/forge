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
// `|| true`, `|| :` and `set +e` turn a failing command into a passing step.
const MASKS: [RegExp, string][] = [
  [/\|\|\s*(?:true|:)(?![\w-])/, '|| true / || :'],
  [/\bset\s+\+\w*e/, 'set +e'],
];

type Step = Record<string, any>;
type Job = Record<string, any>;

const jobsOf = (wf: any): [string, Job][] => Object.entries(wf?.jobs ?? {}) as [string, Job][];
const stepsOf = (job: Job | undefined): Step[] => (Array.isArray(job?.steps) ? job.steps : []);
const runOf = (step: Step): string | null => (typeof step?.run === 'string' ? step.run : null);
const usesAction = (step: Step, action: string) => typeof step?.uses === 'string' && step.uses.startsWith(`${action}@`);
const label = (job: string, step: Step) => `${job} › ${step?.name ?? step?.uses ?? step?.run}`;

// ---------- pure checkers: each returns the problems it finds, [] when the workflow is sound ----------

function triggerProblems(wf: any, text: string): string[] {
  const out: string[] = [];
  const on = wf?.on;
  if (!on || typeof on !== 'object' || Array.isArray(on)) {
    out.push('`on` must be a map of events');
  } else {
    const events = Object.keys(on).sort();
    if (!isDeepStrictEqual(events, ['pull_request', 'push'])) out.push(`\`on\` must be exactly pull_request and push, got ${events.join(', ')}`);
    if (!isDeepStrictEqual(on.push?.branches, ['main'])) out.push('push.branches must be exactly [main]');
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
  // GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail`; without -e a `for` loop reports only its last command.
  if (wf?.defaults?.run?.shell !== 'bash') out.push('defaults.run.shell must be bash');
  for (const [id, job] of jobsOf(wf)) {
    if (!job || typeof job !== 'object') continue;
    if ('continue-on-error' in job) out.push(`job ${id} must not set continue-on-error`);
    if ('if' in job) out.push(`job ${id} must not set if`);
    if ('defaults' in job) out.push(`job ${id} must not override defaults`);
    for (const step of stepsOf(job)) {
      const at = label(id, step);
      if (usesAction(step, 'actions/checkout') && step.with?.['persist-credentials'] !== false)
        out.push(`${at}: checkout must set persist-credentials: false`);
      if (usesAction(step, 'actions/setup-node')) {
        if (step.with?.['package-manager-cache'] !== false) out.push(`${at}: setup-node must set package-manager-cache: false`);
        if (step.with && 'cache' in step.with) out.push(`${at}: setup-node must not cache`);
      }
      if ('continue-on-error' in step && runOf(step) !== 'npm audit') out.push(`${at}: only the report-only npm audit may set continue-on-error`);
      if ('if' in step) out.push(`${at}: must not set if`);
      if ('shell' in step) out.push(`${at}: must not override the shell`);
      const run = runOf(step);
      if (run !== null) {
        for (const [re, what] of MASKS) if (re.test(run)) out.push(`${at}: run must not mask a failure with ${what}`);
        if (run.includes('${{')) out.push(`${at}: run must not interpolate an expression`);
      }
      const env = step.env && typeof step.env === 'object' ? step.env : {};
      for (const [k, v] of Object.entries(env)) if (String(v).includes('${{')) out.push(`${at}: env ${k} must not interpolate an expression`);
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
  const install = steps.findIndex((s) => CLI_PINNED.test(runOf(s)?.trim() ?? ''));
  const validate = steps.findIndex((s) => runOf(s)?.trim() === VALIDATE);
  if (install === -1) out.push('verify must install @anthropic-ai/claude-code at an exact version');
  if (validate === -1) out.push(`verify must run ${VALIDATE}`);
  if (install !== -1 && validate !== -1 && install > validate) out.push('the CLI must be installed before the plugin is validated');
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
});

test('verify matrix covers Node 22.18.0 and Node 24 on Ubuntu and macOS', () => {
  const verify = WF.jobs.verify;
  assert.equal(verify['runs-on'], '${{ matrix.os }}');
  assert.equal(verify.strategy['fail-fast'], false);
  assert.deepEqual(verify.strategy.matrix.os, ['ubuntu-latest', 'macos-latest']);
  assert.deepEqual(verify.strategy.matrix.node, ['22.18.0', '24.x']);
  assert.equal(typeof verify['timeout-minutes'], 'number');
  const setup = stepsOf(verify).filter((s) => usesAction(s, 'actions/setup-node'));
  assert.equal(setup.length, 1);
  assert.equal(setup[0].with['node-version'], '${{ matrix.node }}');
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
