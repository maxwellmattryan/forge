// .github/workflows/main-update.yml builds the dashboard that `npm run release` puts on main, so it is held to
// exact allowlists like release.yml (test/release-workflow.test.ts): triggers, a read-only token, pins, every
// expression and every command it runs. Nothing in it may write: the maintainer pushes main.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from '../lib/yaml.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TEXT = read('.github/workflows/main-update.yml');
const WF = parse(TEXT);
const CI_TEXT = read('.github/workflows/ci.yml');
const RELEASE_SCRIPT = read('scripts/release.ts');

const ON_DEVELOP = "github.ref == 'refs/heads/develop'";
const WORKFLOW_KEYS = ['name', 'on', 'permissions', 'concurrency', 'defaults', 'jobs'];
const JOB_KEYS = ['name', 'if', 'runs-on', 'timeout-minutes', 'steps'];
const STEP_KEYS = ['name', 'uses', 'with', 'run'];
const ACTIONS = ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'];
const CHECKOUT_WITH = { 'persist-credentials': false };
const SETUP_NODE_WITH = { 'node-version-file': '.nvmrc', 'package-manager-cache': false };
// scripts/release.ts downloads this artifact by name; a week lets a stopped release resume.
const UPLOAD_WITH = { name: 'dashboard-dist', path: 'dashboard/dist', 'if-no-files-found': 'error', 'retention-days': 7 };
const RUNS = ['npm ci', 'npm run build:dashboard'];
// One group per commit, so a later push never cancels the pending build of a release commit.
const CONCURRENCY = { group: 'main-update-${{ github.sha }}', 'cancel-in-progress': false };
const EXPRESSIONS = ['${{ github.sha }}'];
const USES_LINE = /^\s*(?:-\s+)?uses:/;
const PINNED_LINE = /^\s*(?:-\s+)?uses:\s+([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)\s*$/;

type Step = Record<string, any>;
const isMap = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const stepsOf = (job: any): Step[] => (Array.isArray(job?.steps) ? job.steps : []);
const extraKeys = (v: unknown, allowed: string[]) => (isMap(v) ? Object.keys(v).filter((k) => !allowed.includes(k)) : []);

function problems(wf: any, text: string): string[] {
  const out: string[] = [];
  if (!isDeepStrictEqual(wf?.on, { push: { branches: ['develop'] }, workflow_dispatch: null })) out.push('`on` must be exactly push: branches: [develop] and a workflow_dispatch with no inputs');
  for (const word of ['pull_request', 'pull_request_target', 'workflow_run', 'schedule', 'repository_dispatch']) if (text.includes(word)) out.push(`the workflow must not mention ${word}`);
  for (const k of extraKeys(wf, WORKFLOW_KEYS)) out.push(`the workflow must not set ${k}`);
  if (!isDeepStrictEqual(wf?.permissions, { contents: 'read' })) out.push('permissions must be exactly { contents: read }');
  if (!isDeepStrictEqual(wf?.concurrency, CONCURRENCY)) out.push(`concurrency must be exactly ${JSON.stringify(CONCURRENCY)}`);
  if (!isDeepStrictEqual(wf?.defaults, { run: { shell: 'bash' } })) out.push('defaults must be exactly run.shell: bash');
  if (!isDeepStrictEqual(Object.keys(isMap(wf?.jobs) ? wf.jobs : {}), ['build'])) out.push('the only job must be build');
  const job = wf?.jobs?.build;
  for (const k of extraKeys(job, JOB_KEYS)) out.push(`job build must not set ${k}`);
  if (job?.name !== 'build') out.push('job build must be named build');
  // workflow_dispatch can name any branch, so the job checks the ref itself.
  if (job?.if !== ON_DEVELOP) out.push(`job build must run only if ${ON_DEVELOP}`);
  const steps = stepsOf(job);
  for (const s of steps) for (const k of extraKeys(s, STEP_KEYS)) out.push(`step ${s.name}: must not set ${k}`);
  const actions = steps.filter((s) => 'uses' in s).map((s) => String(s.uses).split('@')[0]);
  if (!isDeepStrictEqual(actions, ACTIONS)) out.push(`build must use exactly ${ACTIONS.join(', ')}, got ${actions.join(', ') || 'none'}`);
  for (const s of steps) {
    const uses = String(s.uses ?? '');
    if (uses.startsWith('actions/checkout@') && !isDeepStrictEqual(s.with, CHECKOUT_WITH)) out.push(`checkout must set exactly ${JSON.stringify(CHECKOUT_WITH)}`);
    if (uses.startsWith('actions/setup-node@') && !isDeepStrictEqual(s.with, SETUP_NODE_WITH)) out.push(`setup-node must set exactly ${JSON.stringify(SETUP_NODE_WITH)}`);
    if (uses.startsWith('actions/upload-artifact@') && !isDeepStrictEqual(s.with, UPLOAD_WITH)) out.push(`upload-artifact must set exactly ${JSON.stringify(UPLOAD_WITH)}`);
  }
  const runs = steps.filter((s) => typeof s.run === 'string').map((s) => s.run.trim());
  if (!isDeepStrictEqual(runs, RUNS)) out.push(`build must run exactly ${RUNS.join(', then ')}`);

  for (let i = text.indexOf('${{'); i !== -1; i = text.indexOf('${{', i + 3)) {
    if (!EXPRESSIONS.some((e) => text.startsWith(e, i))) out.push(`expression not on the allowlist: ${text.slice(i, i + 80).split('\n')[0]}`);
  }
  if (/\bsecrets\b|github\.token|GH_TOKEN/i.test(text)) out.push('the workflow must use no token or secret');

  // Pins: every action by a full SHA with its version comment, checkout and setup-node as ci.yml pins them.
  const ciPins = new Map<string, string>();
  for (const l of CI_TEXT.split(/\r?\n/)) {
    const m = PINNED_LINE.exec(l);
    if (m) ciPins.set(m[1], `${m[2]} # ${m[3]}`);
  }
  const lines = text.split(/\r?\n/).filter((l) => USES_LINE.test(l));
  for (const l of lines) {
    const m = PINNED_LINE.exec(l);
    if (!m) out.push(`not pinned to a full commit SHA with its version comment: ${l.trim()}`);
    else if (ciPins.has(m[1]) && ciPins.get(m[1]) !== `${m[2]} # ${m[3]}`) out.push(`${m[1]} must use ci.yml's pin ${ciPins.get(m[1])}: ${l.trim()}`);
  }
  if (actions.length !== lines.length) out.push(`${actions.length} actions are used but ${lines.length} \`uses:\` lines carry a pin`);
  return out;
}

const mutate = (fn: (wf: any) => void): any => {
  const copy = structuredClone(WF);
  fn(copy);
  return copy;
};
const flags = (wf: any, what: string, text = TEXT) => assert.ok(problems(wf, text).length > 0, `the checker flags: ${what}`);

test('the build runs on develop with a read-only token and writes nothing', () => {
  assert.equal(WF.name, 'Main update');
  assert.deepEqual(problems(WF, TEXT), []);
  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'schedule']) {
    const t = TEXT.replace('on:\n  push:\n', `on:\n  ${event}:\n  push:\n`);
    assert.notEqual(t, TEXT);
    flags(parse(t), `${event} added`, t);
  }
  flags(mutate((wf) => { wf.on.push.branches = ['develop', 'main']; }), 'a second branch');
  flags(mutate((wf) => { wf.on.workflow_dispatch = { inputs: { ref: { type: 'string' } } }; }), 'workflow_dispatch inputs');
  flags(mutate((wf) => { delete wf.jobs.build.if; }), 'no ref guard');
  flags(mutate((wf) => { wf.permissions = { contents: 'write' }; }), 'write at the top level');
  flags(mutate((wf) => { wf.jobs.build.permissions = { contents: 'write' }; }), 'write on build');
  flags(mutate((wf) => { wf.jobs.publish = { name: 'publish', 'runs-on': 'ubuntu-latest', steps: [] }; }), 'a second job');
  flags(mutate((wf) => { wf.jobs.build.steps.push({ name: 'Push', run: 'git push origin HEAD:main' }); }), 'an extra command');
  flags(mutate((wf) => { delete wf.jobs.build.steps[0].with['persist-credentials']; }), 'checkout keeping credentials');
  flags(mutate((wf) => { wf.jobs.build.steps[4].with['retention-days'] = 1; }), 'a shorter retention');
  flags(mutate((wf) => { wf.concurrency['cancel-in-progress'] = true; }), 'cancel-in-progress');
  flags(WF, 'a token', TEXT.replace('run: npm ci', 'run: npm ci\n        env:\n          GH_TOKEN: ${{ github.token }}'));
  flags(WF, 'an expression off the allowlist', TEXT.replace('${{ github.sha }}', '${{ github.event.head_commit.message }}'));
  const upload = '@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2';
  assert.ok(TEXT.includes(upload));
  flags(WF, 'an unpinned action', TEXT.replace(upload, '@v7'));
  flags(WF, 'a pin without its version comment', TEXT.replace(upload, '@cf430e030ddbb5b0abf93d22962f4752f3646cd9'));
  const checkout = '@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
  flags(WF, "a checkout pin that differs from ci.yml's", TEXT.replace(checkout, `@${'b'.repeat(40)} # v7.0.1`));
});

test('scripts/release.ts reads the artifact and the run this workflow makes', () => {
  assert.ok(RELEASE_SCRIPT.includes("'main-update.yml'"), 'release.ts waits for this workflow by file name');
  assert.ok(RELEASE_SCRIPT.includes(`'--name', '${UPLOAD_WITH.name}'`), 'release.ts downloads the artifact this workflow uploads');
});
