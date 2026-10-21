// .github/workflows/main-update.yml pushes a branch, edits a PR and dispatches CI with a write token, so it is
// held to exact allowlists like release.yml (test/release-workflow.test.ts): triggers, permissions, pins, the
// token's reach, every expression and every script the publish job runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { parse } from '../lib/yaml.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

const TEXT = read('.github/workflows/main-update.yml');
const WF = parse(TEXT);
const CI_TEXT = read('.github/workflows/ci.yml');

const ON_DEVELOP = "github.ref == 'refs/heads/develop'";
const CI_CALL = './.github/workflows/ci.yml';
const JOBS = ['build', 'publish', 'verify'];
const WORKFLOW_KEYS = ['name', 'on', 'permissions', 'concurrency', 'defaults', 'jobs'];
const JOB_KEYS = ['name', 'needs', 'if', 'runs-on', 'timeout-minutes', 'permissions', 'steps'];
const STEP_KEYS = ['name', 'uses', 'with', 'run', 'env'];
// The reusable call inherits the top-level read-only token: no inputs, no secrets, no permissions of its own.
const VERIFY_JOB = { name: 'verify', if: ON_DEVELOP, uses: CI_CALL };
const NEEDS: Record<string, string> = { build: 'verify', publish: 'build' };
const PUBLISH_PERMISSIONS = { contents: 'write', 'pull-requests': 'write', actions: 'write' };
const ACTIONS: Record<string, string[]> = {
  build: ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'],
  publish: ['actions/checkout', 'actions/setup-node', 'actions/download-artifact'],
};
const CHECKOUT_WITH: Record<string, unknown> = { build: { 'persist-credentials': false }, publish: { 'persist-credentials': false, 'fetch-depth': 0 } };
const SETUP_NODE_WITH = { 'node-version-file': '.nvmrc', 'package-manager-cache': false };
const UPLOAD_WITH = { name: 'dashboard-dist', path: 'dashboard/dist', 'if-no-files-found': 'error', 'retention-days': 1 };
const DOWNLOAD_WITH = { name: 'dashboard-dist', path: '${{ runner.temp }}/dist' };
const BUILD_RUNS = ['npm ci', 'npm run build:dashboard'];

const COMMIT_RUN = [
  `main="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')"`,
  'node scripts/main-update.ts commit --main "$main" --develop "$DEVELOP" --dist "$RUNNER_TEMP/dist" > "$RUNNER_TEMP/sha"',
  'node scripts/main-update.ts body --main "$main" --develop "$DEVELOP" --run-url "$RUN_URL" --dist "$RUNNER_TEMP/dist" > "$RUNNER_TEMP/body.md"',
].join('\n');
const PUSH_RUN = [
  'sha="$(cat "$RUNNER_TEMP/sha")"',
  'if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then',
  '  echo "::error title=No main-update commit::scripts/main-update.ts printed no commit sha"',
  '  exit 1',
  'fi',
  `auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"`,
  'echo "::add-mask::$auth"',
  'if ! git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" push --force origin "$sha:refs/heads/ci/main-update"; then',
  '  echo "::error title=Push refused::GitHub refused the ci/main-update push. If the log says a workflow file needs the workflows permission, develop changes .github/workflows/ and main lacks it: push the commit by hand (docs/RELEASES.md, Workflow changes)"',
  '  exit 1',
  'fi',
].join('\n');
const PR_RUN = [
  'title="$(head -n 1 "$RUNNER_TEMP/body.md")"',
  'title="${title#title=}"',
  'tail -n +2 "$RUNNER_TEMP/body.md" > "$RUNNER_TEMP/pr-body.md"',
  `pr="$(gh pr list --repo "$GITHUB_REPOSITORY" --head ci/main-update --base main --state open --json number --jq '.[0].number // empty')"`,
  'if [ -z "$pr" ]; then',
  '  gh pr create --repo "$GITHUB_REPOSITORY" --base main --head ci/main-update --title "$title" --body-file "$RUNNER_TEMP/pr-body.md"',
  'elif [[ "$pr" =~ ^[0-9]+$ ]]; then',
  '  gh pr edit "$pr" --repo "$GITHUB_REPOSITORY" --title "$title" --body-file "$RUNNER_TEMP/pr-body.md"',
  'else',
  '  echo "::error title=Unexpected PR number::gh pr list printed a non-number"',
  '  exit 1',
  'fi',
].join('\n');
const DISPATCH_RUN = 'gh workflow run ci.yml --repo "$GITHUB_REPOSITORY" --ref ci/main-update';
// Every run in the publish job, in order. A new step means editing this test.
const PUBLISH_RUNS = [COMMIT_RUN, PUSH_RUN, PR_RUN, DISPATCH_RUN];
const TOKEN_ENV = '${{ github.token }}';
const STEP_ENVS: Record<string, Record<string, string>> = {
  [COMMIT_RUN]: { DEVELOP: '${{ github.sha }}', RUN_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}' },
  [PUSH_RUN]: { GH_TOKEN: TOKEN_ENV },
  [PR_RUN]: { GH_TOKEN: TOKEN_ENV },
  [DISPATCH_RUN]: { GH_TOKEN: TOKEN_ENV },
};
const EXPRESSIONS = [TOKEN_ENV, '${{ github.sha }}', '${{ github.server_url }}', '${{ github.repository }}', '${{ github.run_id }}', '${{ runner.temp }}'];
const USES_LINE = /^\s*(?:-\s+)?uses:/;
const PINNED_LINE = /^\s*(?:-\s+)?uses:\s+([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)\s*$/;
const MASKS: [RegExp, string][] = [
  [/\|\|\s*(?:true|:)(?![\w-])/, '|| true / || :'],
  [/\|\|\s*exit\s+0\b/, '|| exit 0'],
  [/\bset\s+\+\w*e/, 'set +e'],
];
const ENV_REACH = /\b(?:GITHUB_ENV|GITHUB_PATH|BASH_ENV|NODE_OPTIONS)\b/;
const SECRETS = /\bsecrets\b/i;
const TOKEN_FORMS = /\bgithub\s*\[\s*['"]token|toJSON\(\s*github\s*\)/i;
// The publish job holds the write token: nothing from the registry or node_modules runs there.
const PUBLISH_BANNED = /\bnpm\b|\bnpx\b|node_modules|build:dashboard|\byarn\b|\bpnpm\b/;
// Ways a token ends up in git config or a URL, where a later step or a log could read it.
const CREDENTIAL_LEAKS: [RegExp, string][] = [
  [/:\/\/[^\s/"'@]*@/, 'credentials in a URL'],
  [/https:\/\/x-access-token/, 'x-access-token in a URL'],
  [/\bgit\b[^\n]*\bconfig\b/, 'git config'],
  [/credential\.helper|\bauth setup-git\b|--global/, 'a credential helper or global config'],
];

type Step = Record<string, any>;
const isMap = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const jobsOf = (wf: any): [string, any][] => Object.entries(isMap(wf?.jobs) ? wf.jobs : {});
const stepsOf = (job: any): Step[] => (Array.isArray(job?.steps) ? job.steps : []);
const runOf = (s: Step): string | null => (typeof s?.run === 'string' ? s.run.trim() : null);
const extraKeys = (v: unknown, allowed: string[]) => (isMap(v) ? Object.keys(v).filter((k) => !allowed.includes(k)) : []);
const label = (job: string, s: Step) => `${job} › ${s?.name ?? s?.uses ?? s?.run}`;

function triggerProblems(wf: any, text: string): string[] {
  const out: string[] = [];
  if (!isDeepStrictEqual(wf?.on, { push: { branches: ['develop'] }, workflow_dispatch: null })) out.push('`on` must be exactly push: branches: [develop] and a workflow_dispatch with no inputs');
  // A PR, another workflow's completion or a timer must never reach the write token.
  for (const word of ['pull_request', 'pull_request_target', 'workflow_run', 'schedule', 'repository_dispatch']) if (text.includes(word)) out.push(`the workflow must not mention ${word}`);
  // workflow_dispatch can name any branch, so every job checks the ref itself.
  for (const [id, job] of jobsOf(wf)) if (!isMap(job) || job.if !== ON_DEVELOP) out.push(`job ${id} must run only if ${ON_DEVELOP}`);
  return out;
}

function privilegeProblems(wf: any, text: string, ciText: string): string[] {
  const out: string[] = [];
  for (const k of extraKeys(wf, WORKFLOW_KEYS)) out.push(`the workflow must not set ${k}`);
  if (!isDeepStrictEqual(wf?.permissions, { contents: 'read' })) out.push('top-level permissions must be exactly { contents: read }');
  if (!isDeepStrictEqual(wf?.concurrency, { group: 'main-update', 'cancel-in-progress': false })) out.push('concurrency must be exactly group: main-update, cancel-in-progress: false');
  if (!isDeepStrictEqual(wf?.defaults, { run: { shell: 'bash' } })) out.push('defaults must be exactly run.shell: bash');
  const ids = jobsOf(wf).map(([id]) => id).sort();
  if (!isDeepStrictEqual(ids, JOBS)) out.push(`jobs must be exactly ${JOBS.join(', ')}, got ${ids.join(', ')}`);
  for (const [id, job] of jobsOf(wf)) {
    if (!isMap(job)) continue;
    if (id === 'verify') {
      if (!isDeepStrictEqual(job, VERIFY_JOB)) out.push(`job verify must be exactly ${JSON.stringify(VERIFY_JOB)} (no with, secrets or permissions)`);
      continue;
    }
    for (const k of extraKeys(job, JOB_KEYS)) out.push(`job ${id} must not set ${k}`);
    if (job.name !== id) out.push(`job ${id} must be named ${id}`);
    if (!isDeepStrictEqual(job.needs, NEEDS[id])) out.push(`job ${id} must need exactly ${NEEDS[id]}`);
    if (id === 'publish') {
      if (!isDeepStrictEqual(job.permissions, PUBLISH_PERMISSIONS)) out.push(`job publish permissions must be exactly ${JSON.stringify(PUBLISH_PERMISSIONS)}`);
    } else if ('permissions' in job) out.push(`job ${id} must not set permissions: it keeps the read-only token`);
    const actions = stepsOf(job).filter((s) => 'uses' in s).map((s) => String(s.uses).split('@')[0]);
    if (!isDeepStrictEqual(actions, ACTIONS[id])) out.push(`job ${id} must use exactly ${ACTIONS[id]?.join(', ')}, got ${actions.join(', ') || 'none'}`);
    for (const s of stepsOf(job)) {
      const uses = String(s.uses ?? '');
      if (uses.startsWith('actions/checkout@') && !isDeepStrictEqual(s.with, CHECKOUT_WITH[id])) out.push(`${label(id, s)}: checkout must set exactly ${JSON.stringify(CHECKOUT_WITH[id])}`);
      if (uses.startsWith('actions/setup-node@') && !isDeepStrictEqual(s.with, SETUP_NODE_WITH)) out.push(`${label(id, s)}: setup-node must set exactly ${JSON.stringify(SETUP_NODE_WITH)}`);
      if (uses.startsWith('actions/upload-artifact@') && !isDeepStrictEqual(s.with, UPLOAD_WITH)) out.push(`${label(id, s)}: upload-artifact must set exactly ${JSON.stringify(UPLOAD_WITH)}`);
      if (uses.startsWith('actions/download-artifact@') && !isDeepStrictEqual(s.with, DOWNLOAD_WITH)) out.push(`${label(id, s)}: download-artifact must set exactly ${JSON.stringify(DOWNLOAD_WITH)}`);
      if (id === 'publish' && PUBLISH_BANNED.test(runOf(s) ?? '')) out.push(`${label(id, s)}: publish must run no npm, npx or node_modules binary, and no dashboard build`);
    }
  }
  const buildRuns = stepsOf(wf?.jobs?.build).map(runOf).filter((r) => r !== null);
  if (!isDeepStrictEqual(buildRuns, BUILD_RUNS)) out.push(`job build must run exactly ${BUILD_RUNS.join(', then ')}`);

  // Pins: every action by a full SHA with its version comment, checkout and setup-node as ci.yml pins them.
  const ciPins = new Map<string, string>();
  for (const l of ciText.split(/\r?\n/)) {
    const m = PINNED_LINE.exec(l);
    if (m) ciPins.set(m[1], `${m[2]} # ${m[3]}`);
  }
  const lines = text.split(/\r?\n/).filter((l) => USES_LINE.test(l) && l.trim() !== `uses: ${CI_CALL}`);
  for (const l of lines) {
    const m = PINNED_LINE.exec(l);
    if (!m) out.push(`not pinned to a full commit SHA with its version comment: ${l.trim()}`);
    else if (ciPins.has(m[1]) && ciPins.get(m[1]) !== `${m[2]} # ${m[3]}`) out.push(`${m[1]} must use ci.yml's pin ${ciPins.get(m[1])}: ${l.trim()}`);
  }
  const used = jobsOf(wf).flatMap(([, job]) => stepsOf(job).filter((s) => 'uses' in s));
  if (used.length !== lines.length) out.push(`${used.length} actions are used but ${lines.length} \`uses:\` lines carry a pin`);
  return out;
}

function tokenProblems(wf: any, text: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf('${{'); i !== -1; i = text.indexOf('${{', i + 3)) {
    if (!EXPRESSIONS.some((e) => text.startsWith(e, i))) out.push(`expression not on the allowlist: ${text.slice(i, i + 80).split('\n')[0]}`);
  }
  if (SECRETS.test(text)) out.push('the workflow must not reference the secrets context');
  if (TOKEN_FORMS.test(text)) out.push('the token must be read only as github.token');
  const tokenUses = text.split('github.token').length - 1;
  let tokenEnvs = 0;
  for (const [id, job] of jobsOf(wf)) {
    if (isMap(job) && 'env' in job) out.push(`job ${id} must not set env`);
    for (const s of stepsOf(job)) {
      const at = label(id, s);
      for (const k of extraKeys(s, STEP_KEYS)) out.push(`${at}: must not set ${k}`);
      const run = runOf(s);
      if (run !== null) {
        if (run.includes('${{')) out.push(`${at}: run must not interpolate an expression`);
        if (ENV_REACH.test(run)) out.push(`${at}: run must not set the environment of later steps`);
        for (const [re, what] of MASKS) if (re.test(run)) out.push(`${at}: run must not mask a failure with ${what}`);
        for (const [re, what] of CREDENTIAL_LEAKS) if (re.test(run)) out.push(`${at}: run must not put the token in ${what}`);
      }
      if ('env' in s) {
        const allowed = id === 'publish' && run !== null && Object.hasOwn(STEP_ENVS, run) ? STEP_ENVS[run] : undefined;
        if (!allowed || !isDeepStrictEqual(s.env, allowed)) out.push(`${at}: env must be exactly its pinned map (only the publish steps set env)`);
      }
      if (isMap(s.env) && s.env.GH_TOKEN !== undefined) tokenEnvs++;
    }
  }
  if (tokenUses !== tokenEnvs || tokenEnvs !== 3) out.push(`github.token must appear only as GH_TOKEN on the push, PR and dispatch steps (found ${tokenUses} uses, ${tokenEnvs} GH_TOKEN envs)`);
  const runs = stepsOf(wf?.jobs?.publish).map(runOf).filter((r) => r !== null);
  if (!isDeepStrictEqual(runs, PUBLISH_RUNS)) out.push('the publish job must run exactly the commit, push, PR and dispatch scripts, in that order');
  return out;
}

const mutate = (fn: (wf: any) => void): any => {
  const copy = structuredClone(WF);
  fn(copy);
  return copy;
};
const step = (wf: any, job: string, name: string): Step => {
  const s = stepsOf(wf.jobs[job]).find((x) => x.name === name);
  assert.ok(s, `${job} has ${name}`);
  return s;
};
const flags = (problems: string[], what: string) => assert.ok(problems.length > 0, `the checker flags: ${what}`);
const all = (wf: any, text = TEXT) => [...triggerProblems(wf, text), ...privilegeProblems(wf, text, CI_TEXT), ...tokenProblems(wf, text)];

test('triggers only on develop', () => {
  assert.equal(WF.name, 'Main update');
  assert.deepEqual(triggerProblems(WF, TEXT), []);
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'schedule']) {
    const t = TEXT.replace('on:\n  push:\n', `on:\n  ${event}:\n  push:\n`);
    assert.notEqual(t, TEXT);
    flags(triggerProblems(parse(t), t), `${event} added`);
  }
  flags(triggerProblems(mutate((wf) => { wf.on.push.branches = ['develop', 'main']; }), TEXT), 'a second branch');
  flags(triggerProblems(mutate((wf) => { wf.on.workflow_dispatch = { inputs: { ref: { type: 'string' } } }; }), TEXT), 'workflow_dispatch inputs');
  for (const id of JOBS) {
    flags(triggerProblems(mutate((wf) => { delete wf.jobs[id].if; }), TEXT), `no ref guard on ${id}`);
    flags(triggerProblems(mutate((wf) => { wf.jobs[id].if = "github.ref == 'refs/heads/main'"; }), TEXT), `another ref on ${id}`);
  }
});

test('least privilege', () => {
  assert.deepEqual(privilegeProblems(WF, TEXT, CI_TEXT), []);
  assert.equal(WF.jobs.publish.needs, 'build');
  assert.ok(!('permissions' in WF.jobs.build), 'build keeps the read-only token');
  flags(privilegeProblems(mutate((wf) => { wf.jobs.build.permissions = { contents: 'write' }; }), TEXT, CI_TEXT), 'write on build');
  flags(privilegeProblems(mutate((wf) => { wf.jobs.publish.permissions['id-token'] = 'write'; }), TEXT, CI_TEXT), 'id-token on publish');
  flags(privilegeProblems(mutate((wf) => { wf.jobs.publish.permissions = 'write-all'; }), TEXT, CI_TEXT), 'write-all on publish');
  flags(privilegeProblems(mutate((wf) => { wf.permissions = { contents: 'write' }; }), TEXT, CI_TEXT), 'write at the top level');
  flags(privilegeProblems(mutate((wf) => { wf.jobs.verify.secrets = 'inherit'; }), TEXT, CI_TEXT), 'secrets: inherit on verify');
  flags(privilegeProblems(mutate((wf) => { wf.jobs.verify.permissions = { contents: 'write' }; }), TEXT, CI_TEXT), 'permissions on verify');
  flags(privilegeProblems(mutate((wf) => { wf.jobs.publish.needs = 'verify'; }), TEXT, CI_TEXT), 'publish without the build');
  const upload = '@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2';
  assert.ok(TEXT.includes(upload));
  flags(privilegeProblems(WF, TEXT.replace(upload, '@v7'), CI_TEXT), 'an unpinned action');
  flags(privilegeProblems(WF, TEXT.replace(upload, '@cf430e030ddbb5b0abf93d22962f4752f3646cd9'), CI_TEXT), 'a pin without its version comment');
  const checkout = '@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
  flags(privilegeProblems(WF, TEXT.replace(checkout, `@${'b'.repeat(40)} # v7.0.1`), CI_TEXT), "a checkout pin that differs from ci.yml's");
  for (const run of ['npm ci', 'npx vite build', 'node_modules/.bin/vite build', 'node scripts/x.ts && npm run build:dashboard']) {
    flags(privilegeProblems(mutate((wf) => { wf.jobs.publish.steps.splice(3, 0, { name: 'Extra', run }); }), TEXT, CI_TEXT), `${run} in publish`);
  }
  for (const job of ['build', 'publish']) flags(privilegeProblems(mutate((wf) => { delete step(wf, job, 'Check out').with['persist-credentials']; }), TEXT, CI_TEXT), `${job} checkout keeping credentials`);
  flags(privilegeProblems(mutate((wf) => { wf.concurrency['cancel-in-progress'] = true; }), TEXT, CI_TEXT), 'cancel-in-progress');
  flags(privilegeProblems(mutate((wf) => { wf.concurrency.group = 'x'; }), TEXT, CI_TEXT), 'another concurrency group');
  flags(privilegeProblems(mutate((wf) => { wf.jobs.extra = { name: 'extra', 'runs-on': 'ubuntu-latest', steps: [] }; }), TEXT, CI_TEXT), 'an extra job');
  flags(privilegeProblems(mutate((wf) => { step(wf, 'publish', 'Download the build').with.path = '.'; }), TEXT, CI_TEXT), 'the artifact extracted over the checkout');
  flags(privilegeProblems(mutate((wf) => { wf.jobs.build.steps.push({ name: 'Cache', uses: `actions/cache@${'a'.repeat(40)}` }); }), TEXT, CI_TEXT), 'a third-party action');
});

test('token handling', () => {
  assert.deepEqual(tokenProblems(WF, TEXT), []);
  const push = step(WF, 'publish', 'Push ci/main-update').run.trim();
  assert.ok(push.includes('-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth"'), 'the push authenticates through a -c header');
  const withRun = (run: string) => mutate((wf) => { step(wf, 'publish', 'Push ci/main-update').run = run; });
  flags(tokenProblems(withRun('git push "https://x-access-token:$GH_TOKEN@github.com/o/r.git" "$sha:refs/heads/ci/main-update"'), TEXT), 'x-access-token in a URL');
  flags(tokenProblems(withRun('git push "https://u:$GH_TOKEN@github.com/o/r.git" x'), TEXT), 'any credentials in a URL');
  flags(tokenProblems(withRun('git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic $auth"\ngit push origin x'), TEXT), 'git config extraheader');
  flags(tokenProblems(withRun('gh auth setup-git\ngit push origin x'), TEXT), 'gh auth setup-git');
  const withSecret = TEXT.replace('          GH_TOKEN: ${{ github.token }}\n        run: gh workflow run', '          GH_TOKEN: ${{ secrets.X }}\n        run: gh workflow run');
  assert.notEqual(withSecret, TEXT);
  flags(tokenProblems(parse(withSecret), withSecret), 'secrets.X');
  flags(tokenProblems(WF, TEXT.replace('${{ github.token }}', "${{ github['token'] }}")), 'the token through an index');
  flags(tokenProblems(mutate((wf) => { step(wf, 'publish', 'Build the main-update commit and PR body').env.GH_TOKEN = TOKEN_ENV; }), TEXT), 'GH_TOKEN on the commit step');
  flags(tokenProblems(mutate((wf) => { wf.jobs.build.steps[2].env = { GH_TOKEN: TOKEN_ENV }; }), TEXT), 'the token in the build job');
  flags(tokenProblems(mutate((wf) => { wf.jobs.publish.env = { GH_TOKEN: TOKEN_ENV }; }), TEXT), 'a job-level env');
  flags(tokenProblems(mutate((wf) => { step(wf, 'publish', 'Run CI on the PR head').run = `${DISPATCH_RUN} || true`; }), TEXT), 'a masked failure');
  flags(tokenProblems(mutate((wf) => { step(wf, 'publish', 'Run CI on the PR head').run = 'gh workflow run ci.yml --ref "${{ github.head_ref }}"'; }), TEXT), 'an expression in a run');
  flags(tokenProblems(WF, TEXT.replace('${{ github.sha }}', '${{ github.event.head_commit.message }}')), 'an expression off the allowlist');
  flags(tokenProblems(mutate((wf) => { step(wf, 'publish', 'Push ci/main-update').run = `echo "x=1" >> "$GITHUB_ENV"\n${PUSH_RUN}`; }), TEXT), 'a run writing GITHUB_ENV');
  assert.deepEqual(all(WF), [], 'the real workflow passes every check');
});

/** Runs a publish step's script in a fresh $RUNNER_TEMP holding `files`, with stub git/gh on PATH that log their argv. */
function runStep(script: string, env: Record<string, string>, stubs: Record<string, string>, files: Record<string, string> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-main-update-wf-')));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  for (const [name, body] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\nprintf '%s' "${name}" >> ${JSON.stringify(log)}\nfor a in "$@"; do printf ' [%s]' "$a" >> ${JSON.stringify(log)}; done\necho >> ${JSON.stringify(log)}\n${body}\n`, { mode: 0o755 });
  }
  try {
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: dir, GITHUB_REPOSITORY: 'o/forge', ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { ...r, calls, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

test('one PR, updated in place', POSIX, () => {
  const steps = stepsOf(WF.jobs.publish);
  assert.deepEqual(steps.map(runOf).filter((r) => r !== null), PUBLISH_RUNS);
  for (const s of steps) if (runOf(s) !== null) assert.deepEqual(s.env, STEP_ENVS[runOf(s)!], label('publish', s));
  assert.ok(PR_RUN.includes('gh pr list --repo "$GITHUB_REPOSITORY" --head ci/main-update --base main --state open'));
  assert.ok(PR_RUN.includes('--body-file "$RUNNER_TEMP/pr-body.md"') && !/--body\s/.test(PR_RUN), 'the body reaches gh only as a file');

  const body = 'title=Release 1.2.3\nUpdates `main`.\n$(touch pwned) `x`\n';
  const pr = (listed: string) => {
    const gh = `if [ "$1 $2" = "pr list" ]; then printf '%s\\n' ${JSON.stringify(listed)}; fi`;
    const r = runStep(PR_RUN, { GH_TOKEN: 't' }, { gh }, { 'body.md': body });
    try {
      const prBody = path.join(r.dir, 'pr-body.md');
      return { ...r, pwned: fs.existsSync(path.join(r.dir, 'pwned')), prBody: fs.existsSync(prBody) ? fs.readFileSync(prBody, 'utf8') : '' };
    } finally {
      r.cleanup();
    }
  };
  const created = pr('');
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.calls.length, 2);
  assert.match(created.calls[1], /^gh \[pr\] \[create\] \[--repo\] \[o\/forge\] \[--base\] \[main\] \[--head\] \[ci\/main-update\] \[--title\] \[Release 1\.2\.3\] \[--body-file\] \[.*\/pr-body\.md\]$/);
  assert.equal(created.prBody, 'Updates `main`.\n$(touch pwned) `x`\n', 'the body without its title line');
  assert.equal(created.pwned, false, 'body text is never run');
  const edited = pr('17');
  assert.equal(edited.status, 0, edited.stderr);
  assert.match(edited.calls[1], /^gh \[pr\] \[edit\] \[17\] \[--repo\] \[o\/forge\] \[--title\] \[Release 1\.2\.3\] \[--body-file\] \[.*\/pr-body\.md\]$/);
  const odd = pr('17; rm -rf /');
  assert.equal(odd.status, 1);
  assert.equal(odd.calls.length, 1, 'neither create nor edit for a non-number');

  const dispatch = runStep(DISPATCH_RUN, { GH_TOKEN: 't' }, { gh: '' });
  try {
    assert.deepEqual(dispatch.calls, ['gh [workflow] [run] [ci.yml] [--repo] [o/forge] [--ref] [ci/main-update]']);
  } finally {
    dispatch.cleanup();
  }
});

test('the push sends the token as a header, never in a URL or git config', POSIX, () => {
  const sha = 'a'.repeat(40);
  const token = 'ghs_example';
  const r = runStep(`printf '%s\\n' ${sha} > "$RUNNER_TEMP/sha"\n${PUSH_RUN}`, { GH_TOKEN: token }, { git: '' });
  try {
    assert.equal(r.status, 0, r.stderr);
    const header = Buffer.from(`x-access-token:${token}`).toString('base64');
    assert.deepEqual(r.calls, [`git [-c] [http.https://github.com/.extraheader=AUTHORIZATION: basic ${header}] [push] [--force] [origin] [${sha}:refs/heads/ci/main-update]`]);
    assert.ok(!r.calls.join('\n').includes(token), 'the raw token is in no argument');
    assert.match(r.stdout, new RegExp(`^::add-mask::${header}$`, 'm'), 'the encoded header is masked in the log');
  } finally {
    r.cleanup();
  }
  const none = runStep(`: > "$RUNNER_TEMP/sha"\n${PUSH_RUN}`, { GH_TOKEN: token }, { git: '' });
  try {
    assert.equal(none.status, 1, 'no sha, no push');
    assert.deepEqual(none.calls, []);
  } finally {
    none.cleanup();
  }
  // GITHUB_TOKEN can't push a commit that changes .github/workflows/; the step must fail and say where the manual push is.
  const refused = runStep(`printf '%s\\n' ${sha} > "$RUNNER_TEMP/sha"\n${PUSH_RUN}`, { GH_TOKEN: token }, { git: 'echo "refusing to allow a GitHub App to create or update workflow" >&2; exit 1' });
  try {
    assert.equal(refused.status, 1, 'a refused push fails the step');
    assert.equal(refused.calls.length, 1);
    assert.match(refused.stdout, /^::error title=Push refused::.*docs\/RELEASES\.md, Workflow changes\)$/m);
  } finally {
    refused.cleanup();
  }
});
