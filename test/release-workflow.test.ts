// .github/workflows/release.yml tags and publishes Forge with a write token, so it is held to exact
// allowlists like ci.yml (test/ci-workflow.test.ts): triggers, permissions, job graph, pins, the
// token's reach and every expression. scripts/release-plan.ts and the docs are checked here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync, spawnSync } from 'node:child_process';
import { findAttribution } from '../lib/attribution.ts';
import { parse } from '../lib/yaml.ts';
import { tempRepo } from './helpers.ts';
import * as stampModule from '../dashboard/build-stamp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const PLAN = path.join(ROOT, 'scripts', 'release-plan.ts');

const TEXT = read('.github/workflows/release.yml');
const WF = parse(TEXT);
const CI_TEXT = read('.github/workflows/ci.yml');

const WORKFLOW_KEYS = ['name', 'on', 'permissions', 'concurrency', 'defaults', 'jobs'];
const JOBS = ['detect', 'release', 'verify'];
const JOB_KEYS = ['name', 'needs', 'if', 'runs-on', 'timeout-minutes', 'permissions', 'outputs', 'steps'];
const STEP_KEYS = ['name', 'id', 'uses', 'with', 'run', 'env'];
const ACTIONS = ['actions/checkout', 'actions/setup-node'];
const IS_RELEASE = "needs.detect.outputs.release == 'true'";
const CI_CALL = './.github/workflows/ci.yml';
// The reusable call inherits the top-level read-only token: no inputs, no secrets, no permissions of its own.
const VERIFY_JOB = { name: 'verify', needs: 'detect', if: IS_RELEASE, uses: CI_CALL };
const DETECT_OUTPUTS = { release: '${{ steps.plan.outputs.release }}', version: '${{ steps.plan.outputs.version }}' };
const DETECT_RUN = 'node scripts/release-plan.ts detect >> "$GITHUB_OUTPUT"';
const NOTES_RUN = 'node scripts/release-plan.ts notes > "$RUNNER_TEMP/notes.md"';
const BUILD_RUN = [
  'archive="$RUNNER_TEMP/forge-$VERSION.tar.gz"',
  'git archive --format=tar.gz --prefix="forge-$VERSION/" -o "$archive" "$GITHUB_SHA"',
  'stamped="$(tar -xzOf "$archive" "forge-$VERSION/COMMIT")"',
  'if [ "$stamped" != "$GITHUB_SHA" ]; then',
  '  echo "::error title=Unstamped archive::COMMIT in the archive is not $GITHUB_SHA"',
  '  exit 1',
  'fi',
  'cd "$RUNNER_TEMP"',
  'sha256sum "forge-$VERSION.tar.gz" > "forge-$VERSION.tar.gz.sha256"',
].join('\n');
const TAG_RUN = [
  'tag_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/tags" -f tag="v$VERSION" -f message="Forge $VERSION" -f object="$GITHUB_SHA" -f type=commit --jq .sha)"',
  'gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/v$VERSION" -f sha="$tag_sha" > /dev/null',
].join('\n');
const PUBLISH_RUN = 'gh release create "v$VERSION" --repo "$GITHUB_REPOSITORY" --verify-tag --title "Forge $VERSION" --notes-file "$RUNNER_TEMP/notes.md" "$RUNNER_TEMP/forge-$VERSION.tar.gz" "$RUNNER_TEMP/forge-$VERSION.tar.gz.sha256"';
// Every run in the release job, in order: notes, archive, tag, publish. A new step means editing this test.
const RELEASE_RUNS = [NOTES_RUN, BUILD_RUN, TAG_RUN, PUBLISH_RUN];
const VERSION_ENV = '${{ needs.detect.outputs.version }}';
const TOKEN_ENV = '${{ github.token }}';
// The only env each step may set, exactly; the token reaches only the two steps that call gh.
const STEP_ENVS: Record<string, Record<string, string>> = {
  [BUILD_RUN]: { VERSION: VERSION_ENV },
  [TAG_RUN]: { GH_TOKEN: TOKEN_ENV, VERSION: VERSION_ENV },
  [PUBLISH_RUN]: { GH_TOKEN: TOKEN_ENV, VERSION: VERSION_ENV },
};
const EXPRESSIONS = ['${{ steps.plan.outputs.release }}', '${{ steps.plan.outputs.version }}', VERSION_ENV, TOKEN_ENV];
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

type Step = Record<string, any>;
const isMap = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const jobsOf = (wf: any): [string, any][] => Object.entries(isMap(wf?.jobs) ? wf.jobs : {});
const stepsOf = (job: any): Step[] => (Array.isArray(job?.steps) ? job.steps : []);
const runOf = (s: Step): string | null => (typeof s?.run === 'string' ? s.run.trim() : null);
const extraKeys = (v: unknown, allowed: string[]) => (isMap(v) ? Object.keys(v).filter((k) => !allowed.includes(k)) : []);
const label = (job: string, s: Step) => `${job} › ${s?.name ?? s?.uses ?? s?.run}`;

/** Every `permissions` map in the workflow, top level and per job. */
function permissionMaps(wf: any): [string, unknown][] {
  const out: [string, unknown][] = [['workflow', wf?.permissions]];
  for (const [id, job] of jobsOf(wf)) if (isMap(job) && 'permissions' in job) out.push([`job ${id}`, job.permissions]);
  return out;
}

function graphProblems(wf: any, text: string): string[] {
  const out: string[] = [];
  for (const k of extraKeys(wf, WORKFLOW_KEYS)) out.push(`the workflow must not set ${k}`);
  if (!isDeepStrictEqual(wf?.on, { push: { branches: ['main'] } })) out.push('`on` must be exactly push: branches: [main]');
  // A PR, a manual run or another workflow's completion must never reach the write token.
  for (const word of ['pull_request', 'workflow_run', 'workflow_dispatch', 'repository_dispatch', 'schedule']) if (text.includes(word)) out.push(`the workflow must not mention ${word}`);
  if (!isDeepStrictEqual(wf?.permissions, { contents: 'read' })) out.push('top-level permissions must be exactly { contents: read }');
  for (const [where, p] of permissionMaps(wf)) {
    const s = JSON.stringify(p ?? null);
    if (/packages|id-token|write-all/.test(s)) out.push(`${where}: must not grant ${s}`);
  }
  if (!isDeepStrictEqual(wf?.concurrency, { group: 'release', 'cancel-in-progress': false })) out.push('concurrency must be exactly group: release, cancel-in-progress: false');
  if (!isDeepStrictEqual(wf?.defaults, { run: { shell: 'bash' } })) out.push('defaults must be exactly run.shell: bash');
  const ids = jobsOf(wf).map(([id]) => id).sort();
  if (!isDeepStrictEqual(ids, JOBS)) out.push(`jobs must be exactly ${JOBS.join(', ')}, got ${ids.join(', ')}`);
  for (const [id, job] of jobsOf(wf)) {
    if (!isMap(job)) {
      out.push(`job ${id} must be a map`);
      continue;
    }
    if (id === 'verify') {
      if (!isDeepStrictEqual(job, VERIFY_JOB)) out.push(`job verify must be exactly ${JSON.stringify(VERIFY_JOB)} (no with, secrets or permissions)`);
      continue;
    }
    for (const k of extraKeys(job, JOB_KEYS)) out.push(`job ${id} must not set ${k}`);
    if (job.name !== id) out.push(`job ${id} must be named ${id}`);
    if (id === 'detect') {
      if ('permissions' in job) out.push('job detect must not set permissions');
      if ('needs' in job || 'if' in job) out.push('job detect must run on every push');
      if (!isDeepStrictEqual(job.outputs, DETECT_OUTPUTS)) out.push(`job detect outputs must be exactly ${JSON.stringify(DETECT_OUTPUTS)}`);
    }
    if (id === 'release') {
      if (!isDeepStrictEqual(job.permissions, { contents: 'write' })) out.push('job release permissions must be exactly { contents: write }');
      if (!isDeepStrictEqual(job.needs, ['detect', 'verify'])) out.push('job release must need exactly [detect, verify]');
      if (job.if !== IS_RELEASE) out.push(`job release must run only if ${IS_RELEASE}`);
      if ('outputs' in job) out.push('job release must not set outputs');
    }
  }
  return out;
}

/** `owner/action` → `sha # vX.Y.Z` as a workflow's `uses:` lines pin it. */
function pins(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of text.split(/\r?\n/)) {
    const m = PINNED_LINE.exec(l);
    if (m) out.set(m[1], `${m[2]} # ${m[3]}`);
  }
  return out;
}

function supplyChainProblems(wf: any, text: string, ciText: string): string[] {
  const out: string[] = [];
  const ciPins = pins(ciText);
  const lines = text.split(/\r?\n/).filter((l) => USES_LINE.test(l) && l.trim() !== `uses: ${CI_CALL}`);
  for (const l of lines) {
    const m = PINNED_LINE.exec(l);
    if (!m) out.push(`not pinned to a full commit SHA with its version comment: ${l.trim()}`);
    else if (ciPins.get(m[1]) !== `${m[2]} # ${m[3]}`) out.push(`${m[1]} must use ci.yml's pin ${ciPins.get(m[1]) ?? '(none)'}: ${l.trim()}`);
  }
  const used = jobsOf(wf).flatMap(([id, job]) => stepsOf(job).filter((s) => 'uses' in s).map((s) => [id, String(s.uses)] as const));
  if (used.length !== lines.length) out.push(`${used.length} actions are used but ${lines.length} \`uses:\` lines carry a pin`);
  for (const [id, job] of jobsOf(wf)) {
    if (id === 'verify') continue;
    const actions = stepsOf(job).filter((s) => 'uses' in s).map((s) => String(s.uses).split('@')[0]);
    if (!isDeepStrictEqual(actions, ACTIONS)) out.push(`job ${id} must use exactly ${ACTIONS.join(' then ')}, got ${actions.join(', ') || 'none'}`);
    for (const s of stepsOf(job)) {
      if (String(s.uses ?? '').startsWith('actions/checkout@')) {
        const want = id === 'detect' ? { 'persist-credentials': false, 'fetch-depth': 0 } : { 'persist-credentials': false };
        if (!isDeepStrictEqual(s.with, want)) out.push(`${label(id, s)}: checkout must set exactly ${JSON.stringify(want)}`);
      }
      if (String(s.uses ?? '').startsWith('actions/setup-node@') && !isDeepStrictEqual(s.with, { 'node-version-file': '.nvmrc', 'package-manager-cache': false }))
        out.push(`${label(id, s)}: setup-node must set exactly node-version-file: .nvmrc, package-manager-cache: false`);
    }
  }
  return out;
}

function injectionProblems(wf: any, text: string): string[] {
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
        if (run.includes('GITHUB_OUTPUT') && run !== DETECT_RUN) out.push(`${at}: only the detect step may write GITHUB_OUTPUT`);
        for (const [re, what] of MASKS) if (re.test(run)) out.push(`${at}: run must not mask a failure with ${what}`);
      }
      if ('env' in s) {
        const allowed = run !== null && Object.hasOwn(STEP_ENVS, run) ? STEP_ENVS[run] : undefined;
        if (!allowed || !isDeepStrictEqual(s.env, allowed)) out.push(`${at}: env must be exactly its pinned map (only the archive, tag and publish steps set env)`);
      }
      if (isMap(s.env) && s.env.GH_TOKEN !== undefined) {
        tokenEnvs++;
        if (!/(^|\n)\s*(?:\S+="\$\()?gh /.test(run ?? '')) out.push(`${at}: GH_TOKEN only on a step that calls gh`);
      }
    }
    if (id === 'detect' && (stepsOf(job).find((s) => s.id === 'plan')?.run ?? '').trim() !== DETECT_RUN) out.push(`the plan step must run exactly ${DETECT_RUN}`);
  }
  if (tokenUses !== tokenEnvs || tokenEnvs !== 2) out.push(`github.token must appear only as GH_TOKEN on the two gh steps (found ${tokenUses} uses, ${tokenEnvs} GH_TOKEN envs)`);
  const runs = stepsOf(wf?.jobs?.release).map(runOf).filter((r) => r !== null);
  if (!isDeepStrictEqual(runs, RELEASE_RUNS)) out.push('the release job must run exactly the notes, archive, tag and publish scripts, in that order');
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
const all = (wf: any, text = TEXT) => [...graphProblems(wf, text), ...supplyChainProblems(wf, text, CI_TEXT), ...injectionProblems(wf, text)];

test('triggers, permissions and job graph', () => {
  assert.equal(WF.name, 'Release');
  assert.deepEqual(graphProblems(WF, TEXT), []);

  for (const event of ['pull_request', 'pull_request_target', 'workflow_run', 'workflow_dispatch']) {
    const t = TEXT.replace('on:\n  push:\n', `on:\n  ${event}:\n  push:\n`);
    assert.notEqual(t, TEXT);
    flags(graphProblems(parse(t), t), `${event} added`);
  }
  flags(graphProblems(mutate((wf) => { wf.permissions = { contents: 'write' }; }), TEXT), 'contents: write at the top level');
  flags(graphProblems(mutate((wf) => { wf.jobs.release.permissions['packages'] = 'write'; }), TEXT), 'packages: write');
  flags(graphProblems(mutate((wf) => { wf.permissions['id-token'] = 'write'; }), TEXT), 'id-token: write');
  flags(graphProblems(mutate((wf) => { wf.jobs.detect.permissions = { contents: 'read' }; }), TEXT), 'permissions on detect');
  flags(graphProblems(mutate((wf) => { wf.jobs.verify.secrets = 'inherit'; }), TEXT), 'secrets: inherit on verify');
  flags(graphProblems(mutate((wf) => { wf.jobs.verify.with = { ref: 'main' }; }), TEXT), 'with on verify');
  flags(graphProblems(mutate((wf) => { wf.jobs.verify.permissions = { contents: 'write' }; }), TEXT), 'permissions on verify');
  flags(graphProblems(mutate((wf) => { wf.jobs.release.needs = ['detect']; }), TEXT), 'release without needs: verify');
  flags(graphProblems(mutate((wf) => { wf.jobs.release.if = 'always()'; }), TEXT), 'release that runs always');
  flags(graphProblems(mutate((wf) => { wf.jobs.release.permissions = { contents: 'write', actions: 'write' }; }), TEXT), 'an extra write scope');
  flags(graphProblems(mutate((wf) => { wf.concurrency['cancel-in-progress'] = true; }), TEXT), 'cancel-in-progress');
  flags(graphProblems(mutate((wf) => { wf.jobs.publish = { 'runs-on': 'ubuntu-latest', steps: [] }; }), TEXT), 'an extra job');
  flags(graphProblems(mutate((wf) => { wf.jobs.detect.outputs.extra = '${{ github.token }}'; }), TEXT), 'an extra detect output');
});

test('pins, token scope and injection', () => {
  assert.deepEqual(supplyChainProblems(WF, TEXT, CI_TEXT), []);
  assert.deepEqual(injectionProblems(WF, TEXT), []);

  const checkoutPin = '@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
  assert.ok(TEXT.includes(checkoutPin) && CI_TEXT.includes(checkoutPin), 'the same checkout pin as ci.yml');
  flags(supplyChainProblems(WF, TEXT.replace(checkoutPin, '@v7'), CI_TEXT), 'an unpinned action');
  flags(supplyChainProblems(WF, TEXT.replace(checkoutPin, `@${'b'.repeat(40)} # v7.0.1`), CI_TEXT), "a pin that differs from ci.yml's");
  const third = { name: 'Release', uses: `softprops/action-gh-release@${'c'.repeat(40)}` };
  const thirdText = TEXT.replace('      - name: Write release notes\n', `      - name: Release\n        uses: softprops/action-gh-release@${'c'.repeat(40)} # v2.0.0\n      - name: Write release notes\n`);
  flags(supplyChainProblems(mutate((wf) => { wf.jobs.release.steps.splice(2, 0, third); }), thirdText, CI_TEXT), 'a third-party action');
  flags(supplyChainProblems(mutate((wf) => { delete step(wf, 'release', 'Check out').with['persist-credentials']; }), TEXT, CI_TEXT), 'checkout keeping credentials');

  flags(injectionProblems(mutate((wf) => { step(wf, 'release', 'Write release notes').env = { GH_TOKEN: TOKEN_ENV }; }), TEXT), 'GH_TOKEN on the notes step');
  const inRun = mutate((wf) => { step(wf, 'release', 'Publish the GitHub Release').run = PUBLISH_RUN.replaceAll('$VERSION', VERSION_ENV); });
  flags(injectionProblems(inRun, TEXT), '${{ needs.detect.outputs.version }} inside a run');
  const withSecret = TEXT.replace('          GH_TOKEN: ${{ github.token }}\n          VERSION: ${{ needs.detect.outputs.version }}\n        run: gh release', '          GH_TOKEN: ${{ secrets.X }}\n          VERSION: ${{ needs.detect.outputs.version }}\n        run: gh release');
  assert.notEqual(withSecret, TEXT);
  flags(injectionProblems(parse(withSecret), withSecret), 'a ${{ secrets.X }}');
  flags(injectionProblems(WF, TEXT.replace('${{ github.token }}', "${{ github['token'] }}")), 'the token through an index');
  flags(injectionProblems(mutate((wf) => { step(wf, 'release', 'Write release notes').run = `${NOTES_RUN} || true`; }), TEXT), 'a masked failure');
  flags(injectionProblems(mutate((wf) => { step(wf, 'release', 'Write release notes').run = `echo "NODE_OPTIONS=x" >> "$GITHUB_ENV"\n${NOTES_RUN}`; }), TEXT), 'a run writing GITHUB_ENV');
  flags(injectionProblems(mutate((wf) => { step(wf, 'release', 'Write release notes').run = `${NOTES_RUN}\necho "release=true" >> "$GITHUB_OUTPUT"`; }), TEXT), 'GITHUB_OUTPUT outside detect');
  flags(injectionProblems(mutate((wf) => { wf.jobs.release.steps.push({ name: 'Extra', run: 'gh release upload "v$VERSION" x' }); }), TEXT), 'an extra release step');
  flags(injectionProblems(mutate((wf) => { wf.jobs.release.env = { GH_TOKEN: TOKEN_ENV }; }), TEXT), 'a job-level env');
});

/** A scratch repo whose commits each set package.json's version. */
function versionRepo(...versions: string[]): ReturnType<typeof tempRepo> {
  const repo = tempRepo();
  for (const v of versions) {
    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'forge', version: v }));
    repo.git('add', '-A');
    repo.git('commit', '-qm', `v ${v}`, '--allow-empty');
  }
  return repo;
}
const plan = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [PLAN, ...args], { cwd, encoding: 'utf8' });

test('detect decides from the version change and the tag', POSIX, () => {
  const repos: { cleanup: () => void }[] = [];
  try {
    const bumped = versionRepo('1.0.0', '1.1.0');
    repos.push(bumped);
    const r = plan(bumped.dir, 'detect');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'version=1.1.0\nrelease=true\n');

    const same = versionRepo('1.1.0', '1.1.0');
    repos.push(same);
    same.git('commit', '-qm', 'docs', '--allow-empty');
    assert.equal(plan(same.dir, 'detect').stdout, 'version=1.1.0\nrelease=false\n', 'unchanged version');

    bumped.git('tag', '-a', 'v1.1.0', '-m', 'Forge 1.1.0');
    assert.equal(plan(bumped.dir, 'detect').stdout, 'version=1.1.0\nrelease=false\n', 'already tagged');

    // A root commit has no parent to compare with: it counts as a change.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-root-')));
    repos.push({ cleanup: () => fs.rmSync(root, { recursive: true, force: true }) });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    git('add', '-A');
    git('commit', '-qm', 'root');
    assert.equal(plan(root, 'detect').stdout, 'version=0.1.0\nrelease=true\n', 'a root commit');

    for (const bad of ['1.0.0\nrelease=true', '1.0', 'v1.0.0', '1.0.0-rc.1', 7]) {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: bad }));
      const out = plan(root, 'detect');
      assert.equal(out.status, 1, JSON.stringify(bad));
      assert.equal(out.stdout, '', `nothing reaches GITHUB_OUTPUT for ${JSON.stringify(bad)}`);
    }
    assert.equal(plan(root, 'publish').status, 2, 'an unknown subcommand');
  } finally {
    for (const r of repos) r.cleanup();
  }
});

test('notes are the CHANGELOG section', POSIX, () => {
  const repo = versionRepo('0.17.1');
  try {
    const changelog = (body: string) => fs.writeFileSync(path.join(repo.dir, 'CHANGELOG.md'), body);
    changelog('# Changelog\n\n## 0.17.10\n\n- ten\n\n## 0.17.1\n\n- one\n\n  more\n\n## 0.17.0\n\n- zero\n');
    const ok = plan(repo.dir, 'notes');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, '- one\n\n  more\n');
    for (const [what, body] of [
      ['missing', '# Changelog\n\n## 0.17.10\n\n- ten\n'],
      ['empty', '# Changelog\n\n## 0.17.1\n\n## 0.17.0\n\n- zero\n'],
      ['attribution', '# Changelog\n\n## 0.17.1\n\n- one\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'],
    ]) {
      changelog(body);
      const r = plan(repo.dir, 'notes');
      assert.equal(r.status, 1, what);
      assert.equal(r.stdout, '', what);
    }
    fs.rmSync(path.join(repo.dir, 'CHANGELOG.md'));
    assert.equal(plan(repo.dir, 'notes').status, 1, 'no CHANGELOG.md');
  } finally {
    repo.cleanup();
  }
});

test('the archive step stamps and checks COMMIT', POSIX, () => {
  assert.equal(step(WF, 'release', 'Build the source archive').run.trim(), BUILD_RUN);
  const tag = step(WF, 'release', 'Create the annotated tag').run.trim();
  assert.equal(tag, TAG_RUN);
  assert.ok(tag.indexOf('/git/tags"') < tag.indexOf('/git/refs"'), 'the tag object first, then its ref');
  assert.equal(step(WF, 'release', 'Publish the GitHub Release').run.trim(), PUBLISH_RUN);

  const repo = tempRepo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-tmp-')));
  try {
    fs.copyFileSync(path.join(ROOT, 'COMMIT'), path.join(repo.dir, 'COMMIT'));
    fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(repo.dir, '.gitattributes'));
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'stamp');
    const run = () => {
      const sha = repo.git('rev-parse', 'HEAD').toString().trim();
      return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', BUILD_RUN], {
        cwd: repo.dir,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_SHA: sha, VERSION: '1.2.3', RUNNER_TEMP: tmp },
      });
    };
    const hasSha256sum = spawnSync('sha256sum', ['--version'], { stdio: 'ignore' }).status === 0;
    const ok = run();
    if (hasSha256sum) {
      assert.equal(ok.status, 0, ok.stderr + ok.stdout);
      assert.ok(fs.existsSync(path.join(tmp, 'forge-1.2.3.tar.gz')));
      const check = spawnSync('sha256sum', ['-c', 'forge-1.2.3.tar.gz.sha256'], { cwd: tmp, encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
    } else {
      // Without sha256sum only the last line can fail; the archive and its COMMIT check passed.
      assert.ok(fs.existsSync(path.join(tmp, 'forge-1.2.3.tar.gz')));
      assert.doesNotMatch(ok.stdout, /Unstamped archive/);
    }

    repo.git('rm', '-q', '.gitattributes');
    repo.git('commit', '-qm', 'drop attributes');
    const unstamped = run();
    assert.equal(unstamped.status, 1);
    assert.match(unstamped.stdout, /^::error title=Unstamped archive::COMMIT in the archive is not [0-9a-f]{40}$/m);
  } finally {
    repo.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('detect and COMMIT hold for a merged main-update PR', POSIX, () => {
  const MAIN_UPDATE = path.join(ROOT, 'scripts', 'main-update.ts');
  const FIXTURE_DIST = path.join(ROOT, 'test', 'fixtures', 'dist');
  const dirs: string[] = [];
  /** main at 1.0.0 (tagged), develop at `next`, merged into main through a main-update commit: returns the merge sha. */
  const merged = (next: string) => {
    const repo = tempRepo();
    dirs.push(repo.dir);
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, rel), text);
    };
    write('package.json', JSON.stringify({ name: 'forge', version: '1.0.0' }));
    write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
    write('dashboard/index.html', '<!doctype html>\n');
    fs.copyFileSync(path.join(ROOT, 'COMMIT'), path.join(repo.dir, 'COMMIT'));
    fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(repo.dir, '.gitattributes'));
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'release 1.0.0');
    repo.git('tag', '-a', 'v1.0.0', '-m', 'Forge 1.0.0');
    repo.git('checkout', '-qb', 'develop');
    write('package.json', JSON.stringify({ name: 'forge', version: next }));
    write('README.md', '# develop\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'feat: develop work');
    const dist = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-dist-')));
    dirs.push(dist);
    fs.cpSync(FIXTURE_DIST, dist, { recursive: true });
    const { distHash, sourceHash, STAMP } = stampModule;
    fs.writeFileSync(path.join(dist, STAMP), JSON.stringify({ source: sourceHash(path.join(repo.dir, 'dashboard'), path.join(repo.dir, 'package-lock.json')), dist: distHash(dist) }));
    const rev = (ref: string) => repo.git('rev-parse', ref).toString().trim();
    const c = spawnSync(process.execPath, [MAIN_UPDATE, 'commit', '--main', rev('main'), '--develop', rev('develop'), '--dist', dist], { cwd: repo.dir, encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const update = c.stdout.trim();
    repo.git('checkout', '-q', 'main');
    // GitHub's "Create a merge commit": first parent the old main tip, second the PR head.
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #9 from o/ci/main-update', update);
    const merge = rev('HEAD');
    assert.deepEqual(repo.git('log', '-1', '--format=%P', merge).toString().trim().split(' ')[1], update);
    return { repo, merge };
  };
  try {
    const bumped = merged('1.1.0');
    assert.equal(plan(bumped.repo.dir, 'detect').stdout, 'version=1.1.0\nrelease=true\n', 'a bumped version releases');
    assert.ok(fs.existsSync(path.join(bumped.repo.dir, 'dashboard', 'dist', 'manifest.json')), 'main carries the built dashboard');
    const tar = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', 'git archive --format=tar --prefix=forge/ "$SHA" | tar -xOf - forge/COMMIT'], { cwd: bumped.repo.dir, encoding: 'utf8', env: { ...process.env, SHA: bumped.merge } });
    assert.equal(tar.status, 0, tar.stderr);
    assert.equal(tar.stdout.trim(), bumped.merge, 'the archive stamps the merge commit');

    const same = merged('1.0.0');
    assert.equal(plan(same.repo.dir, 'detect').stdout, 'version=1.0.0\nrelease=false\n', 'an unchanged version does not');
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('no AI attribution in generated text', () => {
  const files = ['.github/workflows/release.yml', '.github/workflows/ci.yml', '.github/workflows/main-update.yml', 'scripts/main-update.ts', 'docs/RELEASES.md', ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^release-.*\.ts$/.test(f)).map((f) => `scripts/${f}`)];
  assert.ok(files.includes('scripts/release-plan.ts') && files.includes('scripts/release-check.ts'));
  for (const f of files) assert.deepEqual(findAttribution(read(f)), [], f);
  // The tag message and the Release title are fixed text, never taken from a commit or PR.
  assert.ok(TAG_RUN.includes('-f message="Forge $VERSION"'));
  assert.ok(PUBLISH_RUN.includes('--title "Forge $VERSION"'));
  assert.ok(PUBLISH_RUN.includes('--notes-file "$RUNNER_TEMP/notes.md"'), 'CHANGELOG text reaches gh only as a file');
});

test('release docs', () => {
  const sections = (text: string) => text.split('\n').filter((l) => l.startsWith('## '));
  /** From `heading` to the next heading of the same or a higher level. */
  const section = (text: string, heading: string) => {
    const start = text.indexOf(`\n${heading}\n`);
    assert.ok(start !== -1, heading);
    const level = heading.indexOf(' ');
    const next = new RegExp(`\\n#{1,${level}} `, 'g');
    next.lastIndex = start + heading.length + 1;
    const end = next.exec(text)?.index;
    return text.slice(start, end);
  };
  const releases = read('docs/RELEASES.md');
  for (const h of ['## Versioning', '## Support', '## Deprecation', '## Releasing', '## Provenance and pinning', '## Release checklist']) assert.ok(sections(releases).includes(h), h);
  const versioning = section(releases, '## Versioning');
  for (const surface of ['CLI JSON', '/api/state', 'job.json', 'Config keys', 'agent/skill contract']) assert.ok(versioning.includes(surface), `Versioning names ${surface}`);
  const pinning = section(releases, '## Provenance and pinning');
  for (const s of ['forge version --json', 'sha256sum -c', 'git clone --branch v', '--plugin-dir']) assert.ok(pinning.includes(s), `Provenance and pinning covers ${s}`);
  assert.match(section(releases, '## Release checklist'), /^1\. /m);
  assert.ok(section(releases, '## Releasing').includes('npm run release:check'));

  const updating = section(read('README.md'), '### Updating');
  assert.ok(updating.includes('docs/RELEASES.md'));
  assert.match(updating, /pin/i);
  assert.match(updating, /roll back/i);

  const supported = section(read('SECURITY.md'), '## Supported versions');
  assert.ok(supported.includes('docs/RELEASES.md'));
  assert.doesNotMatch(supported, /\b\d+\.\d+(?:\.\d+|\.x)?\b/, 'no hard-coded version');

  assert.ok(sections(read('docs/ARCHITECTURE.md')).includes('## Release security'));
  const agents = read('AGENTS.md');
  for (const h of ['## Layout', '## Where a change goes', '## Publishing']) {
    const s = section(agents, h);
    assert.ok(s.includes('release.yml') || s.includes('release:check'), `AGENTS.md ${h} names the release pipeline`);
  }
  assert.ok(section(agents, '## Layout').includes('.github/workflows/release.yml'));
  assert.ok(section(agents, '## Where a change goes').includes('test/release-workflow.test.ts'));
  assert.ok(section(agents, '## Publishing').includes('npm run release:check'));
});
