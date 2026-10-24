// .github/workflows/release.yml tags and publishes Forge with a write token: the shared checks in
// test/invariants/workflow-lint.ts hold its pins, permissions and where the token reaches; the checks here hold
// that only the gh-only release job writes, after verify and build. scripts/release-plan.ts, the archive step and
// the release job's steps (against a stub gh) are run for real here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { findAttribution } from '#engine/guard/attribution.ts';
import { fakeBin, tempRepo } from '../helpers.ts';
import { credentialRefs, dependencyCaches, eventExpressions, excessPermissions, forbiddenTriggers, loadWorkflow, persistedCredentials, runExpressions, secretLeaks, triggersOf, unpinnedActions } from './workflow-lint.ts';
import * as stampModule from '../../dashboard/build-stamp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const PLAN = path.join(ROOT, 'scripts', 'release-plan.ts');

const WF = loadWorkflow('release.yml');
// Only the release job writes: it creates the tag and the Release.
const ALLOWED = { release: { contents: 'write' as const } };
const WRITE_PERMISSIONS = { contents: 'write', actions: 'read' };

type Step = Record<string, any>;
const stepsOf = (job: any): Step[] => (Array.isArray(job?.steps) ? job.steps : []);
const stepRunning = (wf: any, job: string, pred: (run: string) => boolean): Step => {
  const s = stepsOf(wf.jobs[job]).find((x) => typeof x.run === 'string' && pred(x.run));
  assert.ok(s, `${job} has the step`);
  return s;
};
const mutate = (fn: (wf: any) => void): any => {
  const copy = structuredClone(WF);
  fn(copy);
  return copy;
};
const flags = (problems: string[], what: string) => assert.ok(problems.length > 0, `the checker flags: ${what}`);
/** Runs a step script the way GitHub runs `shell: bash`. */
const bash = (script: string, cwd: string, env: NodeJS.ProcessEnv) =>
  spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

const RELEASE_IF = "needs.detect.outputs.release == 'true'";
const needsOf = (job: any): unknown[] => (Array.isArray(job?.needs) ? job.needs : [job?.needs]);

/** Which refs reach the write token, and what must pass first. */
function gateProblems(wf: any): string[] {
  // A PR, a manual run or another workflow's completion must never reach the write token.
  const out = forbiddenTriggers(wf);
  if (!isDeepStrictEqual(triggersOf(wf), ['push'])) out.push(`only a push may run the release, got ${triggersOf(wf).join(', ')}`);
  // Any other branch (a job branch, say) would tag and publish with the write token.
  if (!isDeepStrictEqual(wf?.on?.push, { branches: ['main'] })) out.push('the push must be limited to branches: [main]');
  const jobs = Object.keys(wf?.jobs ?? {});
  if (!isDeepStrictEqual(jobs, ['detect', 'verify', 'build', 'release'])) out.push(`the jobs must be detect, verify, build and release, got ${jobs.join(', ')}`);
  if (wf?.jobs?.verify?.uses !== './.github/workflows/ci.yml') out.push('verify must run ./.github/workflows/ci.yml');
  const needs = needsOf(wf?.jobs?.release);
  for (const job of ['detect', 'verify', 'build']) if (!needs.includes(job)) out.push(`the release job must need ${job}`);
  // An always() or a looser test would publish after a failed or skipped verify or build.
  for (const job of ['build', 'release']) if (wf?.jobs?.[job]?.if !== RELEASE_IF) out.push(`the ${job} job must run only if ${RELEASE_IF}`);
  return out;
}

test('only a push to main reaches the write token, after verify and build', () => {
  assert.deepEqual(gateProblems(WF), []);
  flags(gateProblems(mutate((wf) => { delete wf.on.push.branches; })), 'branches: [main] removed');
  flags(gateProblems(mutate((wf) => { wf.on.push.branches = ['main', 'forge/*']; })), 'a second branch');
  flags(gateProblems(mutate((wf) => { wf.on.pull_request_target = null; })), 'pull_request_target');
  flags(gateProblems(mutate((wf) => { wf.on.workflow_dispatch = null; })), 'a manual run');
  flags(gateProblems(mutate((wf) => { wf.jobs.release.needs = ['detect', 'build']; })), 'verify dropped from needs');
  flags(gateProblems(mutate((wf) => { wf.jobs.release.needs = ['detect', 'verify']; })), 'build dropped from needs');
  flags(gateProblems(mutate((wf) => { wf.jobs.release.if = `always() && ${RELEASE_IF}`; })), 'a release after a failed verify');
  flags(gateProblems(mutate((wf) => { wf.jobs.build.if = `always() && ${RELEASE_IF}`; })), 'a build on every push');
  flags(gateProblems(mutate((wf) => { wf.jobs.verify.uses = './.github/workflows/lint.yml'; })), 'another verify workflow');
});

const WORD = /\b(?:node|npm|npx)\b/;
/** The write job holds exactly its two scopes, runs gh only, and is the only place a token sits. */
function writeJobProblems(wf: any): string[] {
  const out = excessPermissions(wf, ALLOWED);
  const release = wf?.jobs?.release;
  if (!isDeepStrictEqual(release?.permissions, WRITE_PERMISSIONS)) out.push(`the release job's permissions must be exactly ${JSON.stringify(WRITE_PERMISSIONS)}, got ${JSON.stringify(release?.permissions)}`);
  if (!stepsOf(release).length) out.push('the release job has no steps');
  stepsOf(release).forEach((s, i) => {
    // No checkout and no action: nothing but the runner's gh runs beside the write token.
    if ('uses' in s) out.push(`release step ${i + 1} uses ${s.uses}`);
    if (typeof s.run !== 'string') out.push(`release step ${i + 1} is not a run step`);
    else if (WORD.test(s.run)) out.push(`release step ${i + 1} runs node, npm or npx`);
  });
  for (const r of credentialRefs(wf)) {
    if (r.scope !== 'step-env' || !/^jobs\.release\.steps\[\d+\]\.env\.GH_TOKEN$/.test(r.where)) out.push(`${r.where}: a credential outside the release job's step env GH_TOKEN`);
  }
  return out;
}

test('the write job runs only gh, with exactly contents: write and actions: read', () => {
  assert.deepEqual(writeJobProblems(WF), []);
  assert.ok(credentialRefs(WF).length >= 4, 'not vacuous: every release step holds the token');
  const checkout = WF.jobs.build.steps.find((s: Step) => String(s.uses).startsWith('actions/checkout@'));
  flags(writeJobProblems(mutate((wf) => { wf.jobs.release.steps.unshift(structuredClone(checkout)); })), 'an actions/checkout step in release');
  flags(writeJobProblems(mutate((wf) => { wf.jobs.release.steps.push({ name: 'x', run: 'node x' }); })), 'run: node x');
  flags(writeJobProblems(mutate((wf) => { wf.jobs.release.steps[0].run += '\nnpx something'; })), 'npx in a run');
  flags(writeJobProblems(mutate((wf) => { wf.jobs.release.permissions['pull-requests'] = 'read'; })), 'pull-requests: read added');
  flags(writeJobProblems(mutate((wf) => { delete wf.jobs.release.permissions.actions; })), 'actions: read removed');
  flags(writeJobProblems(mutate((wf) => { wf.jobs.release.permissions.actions = 'write'; })), 'actions: write');
  flags(writeJobProblems(mutate((wf) => { stepRunning(wf, 'build', (r) => r.includes('git archive')).env.GH_TOKEN = '${{ github.token }}'; })), 'GH_TOKEN in a build step');
  flags(writeJobProblems(mutate((wf) => { wf.jobs.release.env = { GH_TOKEN: '${{ github.token }}' }; })), 'a job-level token');
  flags(writeJobProblems(mutate((wf) => { wf.jobs.build.permissions = { contents: 'write' }; })), 'write on build');
  flags(writeJobProblems(mutate((wf) => { wf.permissions = { contents: 'write' }; })), 'write at the top level');
});

test('every action is pinned, no credential leaves the write job\'s gh steps, and no event data reaches a step', () => {
  assert.deepEqual(unpinnedActions(WF), [], 'the local ./.github/workflows/ci.yml call needs no pin');
  assert.deepEqual(persistedCredentials(WF), []);
  assert.deepEqual(secretLeaks(WF), []);
  assert.deepEqual(runExpressions(WF), [], 'values reach run scripts only through step env');
  assert.deepEqual(dependencyCaches(WF), []);
  assert.deepEqual(eventExpressions(WF), [], 'no PR or commit text reaches a step, even through env');

  flags(unpinnedActions(mutate((wf) => { wf.jobs.build.steps[0].uses = 'actions/checkout@v7'; })), 'an unpinned action');
  flags(unpinnedActions(mutate((wf) => { wf.jobs.build.steps.at(-1).uses = 'actions/upload-artifact@v7'; })), 'an unpinned upload');
  flags(persistedCredentials(mutate((wf) => { delete wf.jobs.build.steps[0].with['persist-credentials']; })), 'checkout keeping credentials');
  flags(secretLeaks(mutate((wf) => { wf.env = { GH_TOKEN: '${{ github.token }}' }; })), 'a workflow-level token');
  flags(secretLeaks(mutate((wf) => { wf.jobs.verify.secrets = 'inherit'; })), 'secrets: inherit on the verify call');
  flags(secretLeaks(mutate((wf) => {
    const s = stepRunning(wf, 'release', (r) => r.startsWith('gh release create'));
    s.run = s.run.replace('gh release create', 'GH_TOKEN=${{ github.token }} gh release create');
  })), 'the token interpolated into run');
  flags(secretLeaks(mutate((wf) => { wf.jobs.detect.outputs.extra = '${{ github.token }}'; })), 'the token in a job output');
  flags(runExpressions(mutate((wf) => {
    const s = stepRunning(wf, 'release', (r) => r.startsWith('gh release create'));
    s.run = `echo "\${{ github.event.head_commit.message }}"\n${s.run}`;
  })), 'the commit message interpolated into the release job');
  flags(eventExpressions(mutate((wf) => { stepRunning(wf, 'release', (r) => r.startsWith('gh release create')).env.BODY = '${{ github.event.pull_request.body }}'; })), 'the PR body in a release step env');
  flags(dependencyCaches(mutate((wf) => { delete wf.jobs.build.steps[1].with['package-manager-cache']; })), 'setup-node caching in the build job');
});

const RUN_ID = '777';
const REPO = 'o/forge';
/**
 * A stub gh: `run download` writes the notes and the archive into --dir, the pulls lookup prints $STUB_PR,
 * the tag object call prints $STUB_TAG; every call is recorded.
 */
const STUB_GH = [
  'if [ "$1 $2" = "run download" ]; then',
  '  dir=; prev=',
  '  for a in "$@"; do [ "$prev" = --dir ] && dir=$a; prev=$a; done',
  '  mkdir -p "$dir"',
  "  printf -- '- Notes.\\n' > \"$dir/notes.md\"",
  "  printf 'archive' > \"$dir/forge-1.2.3.tar.gz\"",
  'elif [ "$1" = api ]; then',
  '  case "$2" in',
  "    */pulls) printf '%s\\n' \"$STUB_PR\" ;;",
  "    */git/tags) printf '%s\\n' \"$STUB_TAG\" ;;",
  '  esac',
  'fi',
].join('\n');

/** Runs the release job's steps in order against a stub gh, stopping at the first that fails. */
function runReleaseJob(stubPr: string) {
  const gh = fakeBin('gh', STUB_GH);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-job-')));
  const sha = 'f'.repeat(40);
  const env = {
    PATH: `${gh.dir}${path.delimiter}${process.env.PATH ?? ''}`,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_REPOSITORY: REPO,
    GITHUB_SHA: sha,
    GITHUB_SERVER_URL: 'https://github.com',
    RUNNER_TEMP: tmp,
    VERSION: '1.2.3',
    STUB_PR: stubPr,
    STUB_TAG: 'e'.repeat(40),
  };
  const results = [];
  for (const step of stepsOf(WF.jobs.release)) {
    const r = bash(step.run, tmp, env);
    results.push({ name: step.name, status: r.status, stderr: r.stderr, stdout: r.stdout });
    if (r.status !== 0) break;
  }
  return { calls: gh.calls(), results, tmp, sha, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('the write job downloads its own run\'s files, tags the merge commit and links the PR', POSIX, () => {
  const ok = runReleaseJob('42');
  try {
    assert.ok(ok.results.every((r) => r.status === 0), JSON.stringify(ok.results));
    const [download, lookup, tag, ref, publish] = ok.calls;
    assert.equal(ok.calls.length, 5, JSON.stringify(ok.calls));
    // Only this run's artifact, from this repository: never one another run uploaded.
    assert.deepEqual(download.slice(0, 3), ['run', 'download', RUN_ID]);
    assert.equal(download[download.indexOf('--repo') + 1], REPO);
    assert.equal(download[download.indexOf('--name') + 1], 'release-files');
    assert.deepEqual(lookup.slice(0, 2), ['api', `repos/${REPO}/commits/${ok.sha}/pulls`]);
    assert.equal(tag[1], `repos/${REPO}/git/tags`);
    assert.ok(tag.includes(`object=${ok.sha}`), JSON.stringify(tag));
    assert.ok(tag.includes('tag=v1.2.3'), JSON.stringify(tag));
    assert.ok(ref.includes('ref=refs/tags/v1.2.3') && ref.includes(`sha=${'e'.repeat(40)}`), JSON.stringify(ref));

    assert.deepEqual(publish.slice(0, 3), ['release', 'create', 'v1.2.3']);
    assert.ok(publish.includes('--verify-tag'));
    assert.equal(publish[publish.indexOf('--target') + 1], ok.sha);
    const notes = fs.readFileSync(publish[publish.indexOf('--notes-file') + 1], 'utf8');
    assert.match(notes.trimEnd().split('\n').at(-1)!, /^Release PR: https:\/\/github\.com\/o\/forge\/pull\/42$/);
    assert.ok(notes.startsWith('- Notes.\n'), 'the CHANGELOG section first');
    const valued = new Set(['--repo', '--target', '--title', '--notes-file']);
    const assets = publish.slice(3).filter((a, i, all) => !a.startsWith('--') && !valued.has(all[i - 1]));
    assert.deepEqual(assets.map((a) => path.basename(a)), ['forge-1.2.3.tar.gz'], 'one asset, no .sha256');
  } finally {
    ok.cleanup();
  }

  // No single number from the lookup: nothing is tagged or published.
  for (const stubPr of ['', '42 43', '4x', '-1']) {
    const bad = runReleaseJob(stubPr);
    try {
      const failed = bad.results.at(-1)!;
      assert.equal(failed.name, 'Find the release PR', JSON.stringify(stubPr));
      assert.notEqual(failed.status, 0, JSON.stringify(stubPr));
      assert.match(failed.stdout, /::error title=No release PR::/);
      assert.ok(!bad.calls.some((c) => c[1]?.endsWith('/git/tags') || c[1]?.endsWith('/git/refs') || (c[0] === 'release' && c[1] === 'create')), JSON.stringify(bad.calls));
    } finally {
      bad.cleanup();
    }
  }
});

test('the PR lookup takes only this repository\'s merged release/v<version> PR into main for this commit', POSIX, (t) => {
  if (spawnSync('jq', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('jq is not installed');
  const lookup = stepRunning(WF, 'release', (r) => r.includes('/pulls')).run;
  const filter = /--jq '([^']+)'/.exec(lookup)?.[1];
  assert.ok(filter, 'the lookup filters with --jq');
  const sha = 'f'.repeat(40);
  const pr = (o: Record<string, any> = {}) => ({ number: 42, merged_at: '2026-10-24T00:00:00Z', merge_commit_sha: sha, base: { ref: 'main' }, head: { ref: 'release/v1.2.3', repo: { full_name: REPO } }, ...o });
  const rows: [string, unknown[], string][] = [
    ['the release PR', [pr()], '42'],
    ['beside an unrelated PR', [pr({ number: 7, head: { ref: 'forge/x', repo: { full_name: REPO } } }), pr()], '42'],
    ['a fork with the same branch name', [pr({ head: { ref: 'release/v1.2.3', repo: { full_name: 'fork/forge' } } })], ''],
    ['a deleted fork', [pr({ head: { ref: 'release/v1.2.3', repo: null } })], ''],
    ['not merged', [pr({ merged_at: null })], ''],
    ['into develop', [pr({ base: { ref: 'develop' } })], ''],
    ['another version', [pr({ head: { ref: 'release/v1.2.4', repo: { full_name: REPO } } })], ''],
    ['another merge commit', [pr({ merge_commit_sha: 'a'.repeat(40) })], ''],
    ['two that match', [pr(), pr({ number: 43 })], ''],
    ['none', [], ''],
  ];
  for (const [what, prs, want] of rows) {
    const r = spawnSync('jq', ['-r', filter!], { input: JSON.stringify(prs), encoding: 'utf8', env: { ...process.env, VERSION: '1.2.3', GITHUB_SHA: sha, GITHUB_REPOSITORY: REPO } });
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), want, what);
  }
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
  const build = stepRunning(WF, 'build', (r) => r.includes('git archive')).run;
  const repo = tempRepo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-tmp-')));
  try {
    fs.copyFileSync(path.join(ROOT, 'COMMIT'), path.join(repo.dir, 'COMMIT'));
    fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(repo.dir, '.gitattributes'));
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'stamp');
    const run = () => bash(build, repo.dir, { GITHUB_SHA: repo.git('rev-parse', 'HEAD').toString().trim(), VERSION: '1.2.3', RUNNER_TEMP: tmp });
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'release')), ['forge-1.2.3.tar.gz'], 'the archive and no .sha256');

    repo.git('rm', '-q', '.gitattributes');
    repo.git('commit', '-qm', 'drop attributes');
    const unstamped = run();
    assert.equal(unstamped.status, 1);
    assert.match(unstamped.stdout, /^::error title=Unstamped archive::COMMIT in the archive is not [0-9a-f]{40}$/m);
  } finally {
    repo.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // The build uploads that directory as release-files, with the upload action main-update.yml pins.
  const upload = stepsOf(WF.jobs.build).find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
  const pinned = stepsOf(loadWorkflow('main-update.yml').jobs.build).find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
  assert.ok(upload && pinned);
  assert.equal(upload.uses, pinned.uses);
  assert.deepEqual(upload.with, { name: 'release-files', path: '${{ runner.temp }}/release', 'if-no-files-found': 'error', 'retention-days': 7 });
});

test('detect and COMMIT hold for the merge of a release PR', POSIX, () => {
  const MAIN_UPDATE = path.join(ROOT, 'scripts', 'main-update.ts');
  const FIXTURE_DIST = path.join(ROOT, 'test', 'fixtures', 'dist');
  const repo = tempRepo();
  const dist = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-dist-')));
  try {
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, rel), text);
    };
    const rev = (ref: string) => repo.git('rev-parse', ref).toString().trim();
    // main at a tagged 1.0.0.
    write('package.json', JSON.stringify({ name: 'forge', version: '1.0.0' }));
    write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
    write('dashboard/index.html', '<!doctype html>\n');
    fs.copyFileSync(path.join(ROOT, 'COMMIT'), path.join(repo.dir, 'COMMIT'));
    fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(repo.dir, '.gitattributes'));
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'Release 1.0.0');
    repo.git('tag', '-a', 'v1.0.0', '-m', 'Forge 1.0.0');
    // The release commit on release/v1.1.0, then the main update on top of main.
    repo.git('checkout', '-qb', 'release/v1.1.0');
    write('package.json', JSON.stringify({ name: 'forge', version: '1.1.0' }));
    repo.git('commit', '-qam', 'Release 1.1.0');
    fs.cpSync(FIXTURE_DIST, dist, { recursive: true });
    const { distHash, sourceHash, STAMP } = stampModule;
    fs.writeFileSync(path.join(dist, STAMP), JSON.stringify({ source: sourceHash(path.join(repo.dir, 'dashboard'), path.join(repo.dir, 'package-lock.json')), dist: distHash(dist) }));
    const c = spawnSync(process.execPath, [MAIN_UPDATE, 'commit', '--main', rev('main'), '--develop', rev('HEAD'), '--dist', dist], { cwd: repo.dir, encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const update = c.stdout.trim();
    // GitHub's "Create a merge commit": M has parents [main, the main update].
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #9 from o/release/v1.1.0', update);
    const merge = rev('HEAD');
    assert.equal(rev('HEAD^2'), update);

    assert.equal(plan(repo.dir, 'detect').stdout, 'version=1.1.0\nrelease=true\n', 'the merge of a release PR releases');
    assert.ok(fs.existsSync(path.join(repo.dir, 'dashboard', 'dist', 'manifest.json')), 'main carries the built dashboard');
    const tar = bash('git archive --format=tar --prefix=forge/ "$SHA" | tar -xOf - forge/COMMIT', repo.dir, { SHA: merge });
    assert.equal(tar.status, 0, tar.stderr);
    assert.equal(tar.stdout.trim(), merge, 'the archive stamps the merge commit');

    // A later commit on main that keeps the version (a hotfix not yet bumped) does not release.
    repo.git('commit', '-q', '--allow-empty', '-m', 'fix: hotfix');
    assert.equal(plan(repo.dir, 'detect').stdout, 'version=1.1.0\nrelease=false\n', 'an unchanged version does not');
  } finally {
    repo.cleanup();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('no AI attribution in generated text', () => {
  const files = ['.github/workflows/release.yml', '.github/workflows/ci.yml', '.github/workflows/main-update.yml', 'scripts/main-update.ts', 'docs/RELEASES.md', ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^release(-.*)?\.ts$/.test(f)).map((f) => `scripts/${f}`)];
  for (const f of files) assert.deepEqual(findAttribution(read(f)), [], f);
});
