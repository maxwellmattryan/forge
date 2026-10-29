// .github/workflows/release.yml moves stable, tags and publishes Forge with a write token: the shared checks in
// test/invariants/workflow-lint.ts hold its pins, permissions and where the token reaches; the checks here hold
// that only a push to develop reaches the write job, after verify and build, and that the write job runs only gh.
// scripts/release-plan.ts, the archive step and the release job's steps (against a stub gh) are run for real here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { findAttribution } from '#engine/guard/attribution.ts';
import { fakeBin, repoTemplate, tempRepo } from '../helpers.ts';
import { FIXTURE_DIST } from '../dist.ts';
import { credentialRefs, dependencyCaches, eventExpressions, excessPermissions, forbiddenTriggers, loadWorkflow, persistedCredentials, runExpressions, secretLeaks, triggersOf, unpinnedActions } from './workflow-lint.ts';
import * as stampModule from '../../dashboard/build-stamp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const PLAN = path.join(ROOT, 'scripts', 'release-plan.ts');
const STABLE_TREE = path.join(ROOT, 'scripts', 'stable-tree.ts');

const WF = loadWorkflow('release.yml');
// Only the release job writes: it moves stable, creates the tag and the Release.
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
const hasJq = () => spawnSync('jq', ['--version'], { stdio: 'ignore' }).status === 0;
/** Skips a test that needs jq, except in CI, whose runners ship it (as test/dist.ts does for the build). */
const needJq = (t: { skip: (why: string) => void }): boolean => {
  if (hasJq()) return true;
  assert.notEqual(process.env.FORGE_REQUIRE_DIST, '1', 'jq is required in CI');
  t.skip('jq is not installed');
  return false;
};

const RELEASE_IF = "needs.detect.outputs.release == 'true'";
const needsOf = (job: any): unknown[] => (Array.isArray(job?.needs) ? job.needs : [job?.needs]);

/** Which refs reach the write token, and what must pass first. */
function gateProblems(wf: any): string[] {
  // A PR, a manual run or another workflow's completion must never reach the write token.
  const out = forbiddenTriggers(wf);
  if (!isDeepStrictEqual(triggersOf(wf), ['push'])) out.push(`only a push may run the release, got ${triggersOf(wf).join(', ')}`);
  // Any other branch (a job branch, main, or stable itself) would publish with the write token.
  if (!isDeepStrictEqual(wf?.on?.push, { branches: ['develop'] })) out.push('the push must be limited to branches: [develop]');
  const jobs = Object.keys(wf?.jobs ?? {});
  if (!isDeepStrictEqual(jobs, ['detect', 'verify', 'build', 'release'])) out.push(`the jobs must be detect, verify, build and release, got ${jobs.join(', ')}`);
  if (wf?.jobs?.verify?.uses !== './.github/workflows/ci.yml') out.push('verify must run ./.github/workflows/ci.yml');
  const needs = needsOf(wf?.jobs?.release);
  for (const job of ['detect', 'verify', 'build']) if (!needs.includes(job)) out.push(`the release job must need ${job}`);
  // An always() or a looser test would publish after a failed or skipped verify or build.
  for (const job of ['build', 'release']) if (wf?.jobs?.[job]?.if !== RELEASE_IF) out.push(`the ${job} job must run only if ${RELEASE_IF}`);
  return out;
}

test('only a push to develop reaches the write token, after verify and build', () => {
  assert.deepEqual(gateProblems(WF), []);
  flags(gateProblems(mutate((wf) => { delete wf.on.push.branches; })), 'branches: [develop] removed');
  flags(gateProblems(mutate((wf) => { wf.on.push.branches = ['develop', 'forge/*']; })), 'a second branch');
  flags(gateProblems(mutate((wf) => { wf.on.push.branches = ['develop', 'main']; })), 'main added');
  flags(gateProblems(mutate((wf) => { wf.on.push.branches = ['develop', 'stable']; })), 'stable added');
  flags(gateProblems(mutate((wf) => { wf.on.push.branches = ['main']; })), 'main instead of develop');
  flags(gateProblems(mutate((wf) => { wf.on.pull_request_target = null; })), 'pull_request_target');
  flags(gateProblems(mutate((wf) => { wf.on.workflow_dispatch = null; })), 'a manual run');
  flags(gateProblems(mutate((wf) => { wf.jobs.release.needs = ['detect', 'build']; })), 'verify dropped from needs');
  flags(gateProblems(mutate((wf) => { wf.jobs.release.needs = ['detect', 'verify']; })), 'build dropped from needs');
  flags(gateProblems(mutate((wf) => { wf.jobs.release.if = `always() && ${RELEASE_IF}`; })), 'a release after a failed verify');
  flags(gateProblems(mutate((wf) => { wf.jobs.build.if = `always() && ${RELEASE_IF}`; })), 'a build on every push');
  flags(gateProblems(mutate((wf) => { wf.jobs.verify.uses = './.github/workflows/lint.yml'; })), 'another verify workflow');
});

/**
 * A command position (line start, after `;`, `&`, `|`, `(`, a backtick or `$(`, past any `X=y` prefixes) holding
 * node, npm, npx, git or a path: none may run beside the write token, only gh, jq, base64, find and builtins.
 */
const COMMAND = /(?:^|[;&|(`]|\$\()\s*(?:[A-Za-z_]\w*=\S*\s+)*(node|npm|npx|git|\.{0,2}\/\S+)(?=\s|$|;)/m;
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
    else {
      const m = COMMAND.exec(s.run);
      if (m) out.push(`release step ${i + 1} runs ${m[1]}`);
    }
  });
  for (const r of credentialRefs(wf)) {
    if (r.scope !== 'step-env' || !/^jobs\.release\.steps\[\d+\]\.env\.GH_TOKEN$/.test(r.where)) out.push(`${r.where}: a credential outside the release job's step env GH_TOKEN`);
  }
  return out;
}

test('the write job runs only gh, with exactly contents: write and actions: read', () => {
  assert.deepEqual(writeJobProblems(WF), []);
  assert.ok(credentialRefs(WF).length >= 9, 'not vacuous: every release step holds the token');
  const checkout = WF.jobs.build.steps.find((s: Step) => String(s.uses).startsWith('actions/checkout@'));
  const last = (wf: any) => wf.jobs.release.steps.at(-1);
  flags(writeJobProblems(mutate((wf) => { wf.jobs.release.steps.unshift(structuredClone(checkout)); })), 'an actions/checkout step in release');
  flags(writeJobProblems(mutate((wf) => { wf.jobs.release.steps.push({ name: 'x', run: 'node x' }); })), 'run: node x');
  flags(writeJobProblems(mutate((wf) => { wf.jobs.release.steps[0].run += '\nnpx something'; })), 'npx in a run');
  flags(writeJobProblems(mutate((wf) => { last(wf).run += '\ngit push origin HEAD:stable'; })), 'a git push line');
  flags(writeJobProblems(mutate((wf) => { last(wf).run += '\nGIT_DIR=x git push origin HEAD:stable'; })), 'git behind an env prefix');
  flags(writeJobProblems(mutate((wf) => { last(wf).run += '\nsha="$(git rev-parse HEAD)"'; })), 'git in a command substitution');
  flags(writeJobProblems(mutate((wf) => { last(wf).run += '\n./scripts/x'; })), 'a ./scripts/x call');
  flags(writeJobProblems(mutate((wf) => { last(wf).run += '\ntrue && /usr/bin/node x'; })), 'an absolute path after &&');
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
  const publish = (wf: any) => stepRunning(wf, 'release', (r) => r.includes('gh release create'));

  flags(unpinnedActions(mutate((wf) => { wf.jobs.build.steps[0].uses = 'actions/checkout@v7'; })), 'an unpinned action');
  flags(unpinnedActions(mutate((wf) => { wf.jobs.build.steps.at(-1).uses = 'actions/upload-artifact@v7'; })), 'an unpinned upload');
  flags(persistedCredentials(mutate((wf) => { delete wf.jobs.build.steps[0].with['persist-credentials']; })), 'checkout keeping credentials');
  flags(secretLeaks(mutate((wf) => { wf.env = { GH_TOKEN: '${{ github.token }}' }; })), 'a workflow-level token');
  flags(secretLeaks(mutate((wf) => { wf.jobs.verify.secrets = 'inherit'; })), 'secrets: inherit on the verify call');
  flags(secretLeaks(mutate((wf) => {
    const s = publish(wf);
    s.run = s.run.replace('gh release create', 'GH_TOKEN=${{ github.token }} gh release create');
  })), 'the token interpolated into run');
  flags(secretLeaks(mutate((wf) => { wf.jobs.detect.outputs.extra = '${{ github.token }}'; })), 'the token in a job output');
  flags(runExpressions(mutate((wf) => {
    const s = publish(wf);
    s.run = `echo "\${{ github.event.head_commit.message }}"\n${s.run}`;
  })), 'the commit message interpolated into the release job');
  flags(runExpressions(mutate((wf) => {
    const s = stepRunning(wf, 'release', (r) => r.includes('git/trees'));
    s.run = s.run.replace('[ "$tree" != "$TREE" ]', '[ "$tree" != "${{ needs.build.outputs.tree }}" ]');
  })), 'the tree output interpolated into run');
  flags(eventExpressions(mutate((wf) => { publish(wf).env.BODY = '${{ github.event.pull_request.body }}'; })), 'the PR body in a release step env');
  flags(dependencyCaches(mutate((wf) => { delete wf.jobs.build.steps[1].with['package-manager-cache']; })), 'setup-node caching in the build job');
});

const RUN_ID = '777';
const REPO = 'o/forge';
const SHA = 'f'.repeat(40);
const TREE = '7'.repeat(40);
const BASE = '6'.repeat(40);
const S = '5'.repeat(40);
const BLOB = 'b'.repeat(40);
const COMMIT = 'c'.repeat(40);
const TAG = 'e'.repeat(40);
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];

/**
 * A stub gh. `run download` writes the notes and the archive, or ($STUB_DIST copied) the stable dist, into --dir.
 * `api` answers by method and endpoint with what the step's --jq would print, and logs `METHOD endpoint<TAB>body`
 * (the `--input -` body, compacted) to $RUNNER_TEMP/gh-api.log. heads/stable reads give $STUB_STABLE first and
 * $STUB_STABLE_LATER (default: the same) after that; an empty value is a 404.
 */
const STUB_GH = [
  'if [ "$1 $2" = "run download" ]; then',
  '  dir=; name=; prev=',
  '  for a in "$@"; do [ "$prev" = --dir ] && dir=$a; [ "$prev" = --name ] && name=$a; prev=$a; done',
  '  mkdir -p "$dir"',
  '  if [ "$name" = stable-dist ]; then cp -R "$STUB_DIST/." "$dir/"; exit 0; fi',
  "  printf -- '- Notes.\\n' > \"$dir/notes.md\"",
  "  printf 'archive' > \"$dir/forge-1.2.3.tar.gz\"",
  '  exit 0',
  'fi',
  '[ "$1" = api ] || exit 0',
  'method=; ep=; input=; fields=; prev=',
  'for a in "$@"; do',
  '  [ "$prev" = -X ] && method=$a',
  '  case "$a" in repos/*) ep=$a ;; --input) input=1 ;; -f|-F) fields=1 ;; esac',
  '  prev=$a',
  'done',
  '[ -n "$method" ] || { if [ -n "$fields$input" ]; then method=POST; else method=GET; fi; }',
  'body=',
  '[ -z "$input" ] || body="$(jq -c .)"',
  'printf \'%s %s\\t%s\\n\' "$method" "$ep" "$body" >> "$RUNNER_TEMP/gh-api.log"',
  'case "$method $ep" in',
  '  "GET "*"/commits/$GITHUB_SHA/pulls") printf \'%s\\n\' "$STUB_PR" ;;',
  '  "GET "*/git/matching-refs/tags/*) printf \'%s\\n\' "$STUB_TAGS" ;;',
  '  "GET "*/git/ref/heads/stable)',
  '    n=0; [ -f "$RUNNER_TEMP/stable-reads" ] && read -r n < "$RUNNER_TEMP/stable-reads"',
  '    n=$((n + 1)); printf \'%s\\n\' "$n" > "$RUNNER_TEMP/stable-reads"',
  '    if [ "$n" -gt 1 ]; then v=${STUB_STABLE_LATER-$STUB_STABLE}; else v=$STUB_STABLE; fi',
  "    [ -n \"$v\" ] || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; }",
  '    printf \'%s\\n\' "$v" ;;',
  '  "GET "*"/git/commits/$GITHUB_SHA") printf \'%s\\n\' "$STUB_BASE" ;;',
  '  "GET "*/git/commits/*) printf \'%s\\n\' "$STUB_TIP" ;;',
  '  "GET "*/git/trees/*) printf \'%s\' "$STUB_WORKFLOWS" ;;',
  '  "POST "*/git/blobs) printf \'%s\\n\' "$STUB_BLOB" ;;',
  '  "POST "*/git/trees) printf \'%s\\n\' "$STUB_TREE" ;;',
  '  "POST "*/git/commits) printf \'%s\\n\' "$STUB_COMMIT" ;;',
  '  "POST "*/git/tags) printf \'%s\\n\' "$STUB_TAG" ;;',
  'esac',
].join('\n');

/** Where `base64 -w0` is GNU's (CI's runners), nothing; elsewhere (macOS) a shim that drops -w0, which BSD base64 never wraps anyway. */
function base64Shim(): string | null {
  const probe = spawnSync('base64', ['-w0', PLAN], { stdio: 'ignore' });
  if (probe.status === 0) return null;
  return fakeBin('base64', '[ "$1" = -w0 ] && shift\nexec /usr/bin/base64 < "$1"').dir;
}

type JobResult = { name: string; status: number | null; stdout: string; stderr: string };
/** Runs the release job's steps in order against a stub gh, stopping at the first that fails. */
function runReleaseJob(o: { env?: Record<string, string | undefined>; dist?: string } = {}) {
  const gh = fakeBin('gh', STUB_GH);
  const shim = base64Shim();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-job-')));
  const env: NodeJS.ProcessEnv = {
    ...WF.jobs.release.env,
    PATH: [gh.dir, shim, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_REPOSITORY: REPO,
    GITHUB_SHA: SHA,
    GITHUB_SERVER_URL: 'https://github.com',
    RUNNER_TEMP: tmp,
    VERSION: '1.2.3',
    TREE,
    STUB_DIST: o.dist ?? FIXTURE_DIST,
    STUB_PR: '42',
    STUB_TAGS: '0',
    STUB_STABLE: S,
    STUB_BASE: BASE,
    STUB_TIP: `${'4'.repeat(40)} none`,
    STUB_WORKFLOWS: `${WORKFLOWS.join('\n')}\n`,
    STUB_BLOB: BLOB,
    STUB_TREE: TREE,
    STUB_COMMIT: COMMIT,
    STUB_TAG: TAG,
  };
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const results: JobResult[] = [];
  for (const step of stepsOf(WF.jobs.release)) {
    const r = bash(step.run, tmp, env);
    results.push({ name: step.name, status: r.status, stderr: r.stderr, stdout: r.stdout });
    if (r.status !== 0) break;
  }
  const logFile = path.join(tmp, 'gh-api.log');
  const api = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => {
      const [call, body] = l.split('\t');
      return { call: call.replace(`repos/${REPO}/`, ''), body: body ? JSON.parse(body) : null };
    })
    : [];
  return { calls: gh.calls(), api, results, tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const WRITES = /^(POST git\/(blobs|trees|commits|tags|refs)|PATCH git\/refs)/;
/** Every call that writes: a git-data POST or PATCH, or `release create`. */
const writesOf = (job: ReturnType<typeof runReleaseJob>): string[] => [
  ...job.api.filter((a) => WRITES.test(a.call)).map((a) => a.call),
  ...job.calls.filter((c) => c[0] === 'release' && c[1] === 'create').map(() => 'release create'),
];

test('the write job builds the stable commit from this run\'s files and tags it', POSIX, (t) => {
  if (!needJq(t)) return;
  const ok = runReleaseJob();
  try {
    assert.ok(ok.results.every((r) => r.status === 0), JSON.stringify(ok.results));
    const dist = ['assets/index-Fx1.css', 'assets/index-Fx1.js', 'build-stamp.json', 'index.html', 'manifest.json'];

    // Only this run's artifacts, from this repository: never ones another run uploaded.
    const downloads = ok.calls.filter((c) => c[0] === 'run');
    assert.deepEqual(downloads.map((d) => d[d.indexOf('--name') + 1]), ['release-files', 'stable-dist']);
    for (const d of downloads) {
      assert.deepEqual(d.slice(0, 3), ['run', 'download', RUN_ID]);
      assert.equal(d[d.indexOf('--repo') + 1], REPO);
    }
    assert.ok(ok.calls.indexOf(downloads[1]) < ok.calls.findIndex((c) => c[0] === 'api'), 'both downloads come first');

    assert.deepEqual(ok.api.map((a) => a.call), [
      `GET commits/${SHA}/pulls`,
      'GET git/matching-refs/tags/v1.2.3',
      'GET git/ref/heads/stable',
      `GET git/commits/${SHA}`,
      `GET git/trees/${BASE}?recursive=1`,
      ...dist.map(() => 'POST git/blobs'),
      'POST git/trees',
      `GET git/commits/${S}`,
      'POST git/commits',
      'GET git/ref/heads/stable',
      'PATCH git/refs/heads/stable',
      'POST git/tags',
      'POST git/refs',
    ]);
    // One blob per dist file, its bytes as built.
    const blobs = ok.api.filter((a) => a.call === 'POST git/blobs').map((a) => a.body);
    assert.deepEqual(blobs.map((b) => b.encoding), dist.map(() => 'base64'));
    assert.deepEqual(blobs.map((b) => Buffer.from(b.content, 'base64').toString('base64')).sort(), dist.map((f) => fs.readFileSync(path.join(FIXTURE_DIST, f)).toString('base64')).sort());
    // The pushed commit's tree, plus each dist file, minus each workflow file.
    const tree = ok.api.find((a) => a.call === 'POST git/trees')!.body;
    assert.equal(tree.base_tree, BASE);
    const byPath = (a: any, b: any) => a.path.localeCompare(b.path);
    assert.deepEqual([...tree.tree].sort(byPath), [
      ...dist.map((f) => ({ path: `dashboard/dist/${f}`, mode: '100644', type: 'blob', sha: BLOB })),
      ...WORKFLOWS.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null })),
    ].sort(byPath));
    assert.deepEqual(ok.api.find((a) => a.call === 'POST git/commits')!.body, { message: 'Release 1.2.3', tree: TREE, parents: [S, SHA] });

    const args = (pred: (c: string[]) => boolean) => {
      const c = ok.calls.find(pred);
      assert.ok(c, 'the call was made');
      return c;
    };
    const patch = args((c) => c.includes('PATCH'));
    assert.equal(patch[1 + patch.indexOf('PATCH')], `repos/${REPO}/git/refs/heads/stable`);
    assert.ok(patch.includes(`sha=${COMMIT}`) && patch.includes('force=false'), JSON.stringify(patch));
    assert.ok(!ok.calls.some((c) => c.some((a) => /^force=(?!false$)/.test(a))), 'no call passes force=true');
    const tag = args((c) => c[1] === `repos/${REPO}/git/tags`);
    for (const f of [`object=${COMMIT}`, 'tag=v1.2.3', 'message=Forge 1.2.3', 'type=commit']) assert.ok(tag.includes(f), `${f}: ${JSON.stringify(tag)}`);
    const ref = args((c) => c[1] === `repos/${REPO}/git/refs`);
    assert.ok(ref.includes('ref=refs/tags/v1.2.3') && ref.includes(`sha=${TAG}`), JSON.stringify(ref));

    const publish = args((c) => c[0] === 'release');
    assert.equal(ok.calls.at(-1), publish, 'the Release last');
    assert.deepEqual(publish.slice(0, 3), ['release', 'create', 'v1.2.3']);
    assert.ok(publish.includes('--verify-tag'));
    assert.equal(publish[publish.indexOf('--target') + 1], COMMIT, 'the Release targets the stable commit');
    const notes = fs.readFileSync(publish[publish.indexOf('--notes-file') + 1], 'utf8');
    assert.match(notes.trimEnd().split('\n').at(-1)!, /^Release PR: https:\/\/github\.com\/o\/forge\/pull\/42$/);
    assert.ok(notes.startsWith('- Notes.\n'), 'the CHANGELOG section first');
    const valued = new Set(['--repo', '--target', '--title', '--notes-file']);
    const assets = publish.slice(3).filter((a, i, all) => !a.startsWith('--') && !valued.has(all[i - 1]));
    assert.deepEqual(assets.map((a) => path.basename(a)), ['forge-1.2.3.tar.gz'], 'one asset, no .sha256');
  } finally {
    ok.cleanup();
  }
});

const dists: string[] = [];
process.on('exit', () => { for (const d of dists) fs.rmSync(d, { recursive: true, force: true }); });
/** A copy of the fixture dist changed by `edit`. */
const hostileDist = (edit: (dir: string) => void): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-dist-')));
  dists.push(dir);
  fs.cpSync(FIXTURE_DIST, dir, { recursive: true });
  edit(dir);
  return dir;
};

test('the write job fails closed before it writes', POSIX, (t) => {
  if (!needJq(t)) return;
  type Row = [string, Parameters<typeof runReleaseJob>[0], string, RegExp, RegExp?];
  // [what, overrides, failing step, its ::error, the writes allowed before it]
  const rows: Row[] = [
    ...['', '42 43', '4x', '-1'].map((pr): Row => [`a PR lookup of ${JSON.stringify(pr)}`, { env: { STUB_PR: pr } }, 'Find the release PR', /::error title=No release PR::/]),
    ['the tag exists', { env: { STUB_TAGS: '1' } }, 'Check the tag is new', /::error title=Tag exists::/],
    ['a garbled tag count', { env: { STUB_TAGS: '' } }, 'Check the tag is new', /::error title=Tag exists::/],
    ['no stable branch', { env: { STUB_STABLE: '' } }, 'Read stable', /::error title=No stable branch::/],
    ['a stable that is not a sha', { env: { STUB_STABLE: 'refs/heads/x' } }, 'Read stable', /::error title=No stable branch::/],
    ['a two-part version', { env: { VERSION: '1.2' } }, 'Check the inputs', /::error title=Bad version::/],
    ['a version with a command', { env: { VERSION: '1.2.3; touch pwned' } }, 'Check the inputs', /::error title=Bad version::/],
    ['a version starting with a dash', { env: { VERSION: '-1.2.3' } }, 'Check the inputs', /::error title=Bad version::/],
    ['a short tree', { env: { TREE: 'abc' } }, 'Check the inputs', /::error title=Bad tree::/],
    ['an uppercase tree', { env: { TREE: 'A'.repeat(40) } }, 'Check the inputs', /::error title=Bad tree::/],
    ['no tree', { env: { TREE: '' } }, 'Check the inputs', /::error title=Bad tree::/],
    ['a pushed sha that is not hex', { env: { GITHUB_SHA: 'HEAD' } }, 'Check the inputs', /::error title=Bad commit::/],
    ['a dist file outside the set', { dist: hostileDist((d) => fs.writeFileSync(path.join(d, 'notes.txt'), 'x')) }, 'Download the release files', /::error title=Unexpected dist file::/],
    ['a dist asset of another type', { dist: hostileDist((d) => fs.writeFileSync(path.join(d, 'assets', 'icon.svg'), 'x')) }, 'Download the release files', /::error title=Unexpected dist file::/],
    ['a dist asset in a subdirectory', { dist: hostileDist((d) => { fs.mkdirSync(path.join(d, 'assets', 'x')); fs.writeFileSync(path.join(d, 'assets', 'x', 'a.js'), 'x'); }) }, 'Download the release files', /::error title=Unexpected dist file::/],
    ['a dist file named with a newline', { dist: hostileDist((d) => fs.writeFileSync(path.join(d, 'assets', 'a.js\nindex.html'), 'x')) }, 'Download the release files', /::error title=Unexpected dist file::/],
    ['a symlink in the dist', { dist: hostileDist((d) => fs.symlinkSync('/etc/passwd', path.join(d, 'assets', 'index-Fx2.js'))) }, 'Download the release files', /::error title=Odd dist file::/],
    // Made after build checked it: the API tree differs and nothing is committed.
    ['an API tree that is not the build\'s', { env: { STUB_TREE: '8'.repeat(40) } }, 'Build the stable tree', /::error title=Tree mismatch::/, /^POST git\/(blobs|trees)$/],
    ['stable moved after the first read', { env: { STUB_STABLE_LATER: '9'.repeat(40) } }, 'Commit onto stable', /::error title=stable moved::/, /^POST git\/(blobs|trees|commits)$/],
    ['stable gone at the re-read', { env: { STUB_STABLE_LATER: '' } }, 'Commit onto stable', /::error title=stable moved::/, /^POST git\/(blobs|trees|commits)$/],
  ];
  for (const [what, o, step, error, allowed] of rows) {
    const bad = runReleaseJob(o);
    try {
      const failed = bad.results.at(-1)!;
      assert.equal(failed.name, step, `${what}: ${JSON.stringify(bad.results.map((r) => [r.name, r.status, r.stdout]))}`);
      assert.notEqual(failed.status, 0, what);
      assert.match(failed.stdout, error, what);
      const writes = writesOf(bad).filter((w) => !allowed?.test(w));
      assert.deepEqual(writes, [], `${what}: no write`);
    } finally {
      bad.cleanup();
    }
  }

  // A re-run after a failed tag step: stable's tip already is this release's commit, so it is tagged as it is.
  const rerun = runReleaseJob({ env: { STUB_TIP: `${TREE} ${SHA}` } });
  try {
    assert.ok(rerun.results.every((r) => r.status === 0), JSON.stringify(rerun.results));
    assert.ok(!rerun.api.some((a) => a.call === 'POST git/commits' || a.call.startsWith('PATCH')), JSON.stringify(rerun.api));
    const tag = rerun.calls.find((c) => c[1] === `repos/${REPO}/git/tags`)!;
    assert.ok(tag.includes(`object=${S}`), JSON.stringify(tag));
    const publish = rerun.calls.find((c) => c[0] === 'release')!;
    assert.equal(publish[publish.indexOf('--target') + 1], S);
  } finally {
    rerun.cleanup();
  }
  // A tip with the right second parent but another tree is not this release's commit: a new one is made.
  const other = runReleaseJob({ env: { STUB_TIP: `${'3'.repeat(40)} ${SHA}` } });
  try {
    assert.ok(other.results.every((r) => r.status === 0), JSON.stringify(other.results));
    assert.ok(other.api.some((a) => a.call === 'POST git/commits'));
  } finally {
    other.cleanup();
  }
});

test('the PR lookup takes only this repository\'s merged release/v<version> PR into develop for this commit', POSIX, (t) => {
  if (!needJq(t)) return;
  const lookup = stepRunning(WF, 'release', (r) => r.includes('/pulls')).run;
  const filter = /--jq '([^']+)'/.exec(lookup)?.[1];
  assert.ok(filter, 'the lookup filters with --jq');
  const pr = (o: Record<string, any> = {}) => ({ number: 42, merged_at: '2026-10-24T00:00:00Z', merge_commit_sha: SHA, base: { ref: 'develop' }, head: { ref: 'release/v1.2.3', repo: { full_name: REPO } }, ...o });
  const rows: [string, unknown[], string][] = [
    ['the release PR', [pr()], '42'],
    ['beside an unrelated PR', [pr({ number: 7, head: { ref: 'forge/x', repo: { full_name: REPO } } }), pr()], '42'],
    ['a fork with the same branch name', [pr({ head: { ref: 'release/v1.2.3', repo: { full_name: 'fork/forge' } } })], ''],
    ['a deleted fork', [pr({ head: { ref: 'release/v1.2.3', repo: null } })], ''],
    ['not merged', [pr({ merged_at: null })], ''],
    ['into main', [pr({ base: { ref: 'main' } })], ''],
    ['into stable', [pr({ base: { ref: 'stable' } })], ''],
    ['another version', [pr({ head: { ref: 'release/v1.2.4', repo: { full_name: REPO } } })], ''],
    ['another merge commit', [pr({ merge_commit_sha: 'a'.repeat(40) })], ''],
    ['two that match', [pr(), pr({ number: 43 })], ''],
    ['none', [], ''],
  ];
  for (const [what, prs, want] of rows) {
    const r = spawnSync('jq', ['-r', filter!], { input: JSON.stringify(prs), encoding: 'utf8', env: { ...process.env, VERSION: '1.2.3', GITHUB_SHA: SHA, GITHUB_REPOSITORY: REPO } });
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
    git('init', '-q', '-b', 'develop');
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

  // The build uploads that directory as release-files and the built dashboard as stable-dist, with one pinned upload action.
  const uploads = stepsOf(WF.jobs.build).filter((s) => String(s.uses).startsWith('actions/upload-artifact@'));
  assert.deepEqual(uploads.map((u) => u.with), [
    { name: 'release-files', path: '${{ runner.temp }}/release', 'if-no-files-found': 'error', 'retention-days': 7 },
    { name: 'stable-dist', path: 'dashboard/dist', 'if-no-files-found': 'error', 'retention-days': 7 },
  ]);
  assert.equal(uploads[1].uses, uploads[0].uses);
  // The stable tree's sha is the build job's output, from the step that checked it.
  assert.equal(WF.jobs.build.outputs?.tree, '${{ steps.stable.outputs.tree }}');
  assert.match(stepsOf(WF.jobs.build).find((s) => s.id === 'stable')?.run ?? '', /^node scripts\/stable-tree\.ts --develop "\$GITHUB_SHA" --dist dashboard\/dist >> "\$GITHUB_OUTPUT"$/);
});

const STABLE = { source: 'github', repo: 'maxwellmattryan/forge', ref: 'stable' };
/** develop at a tagged 1.0.0 with stable started from it (without workflows), and release/v1.1.0 cut from develop. */
const releaseRepo = repoTemplate((dir) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  // Formatted as npm writes them: the version lines are the ones a bump rewrites.
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const version = (v: string) => {
    write('package.json', json({ name: 'forge', version: v }));
    write('.claude-plugin/plugin.json', json({ name: 'forge', version: v }));
    write('package-lock.json', json({ name: 'forge', version: v, lockfileVersion: 3, packages: { '': { name: 'forge', version: v }, 'node_modules/dep': { version: '2.0.0', resolved: 'https://registry.npmjs.org/dep/-/dep-2.0.0.tgz' } } }));
  };
  git('checkout', '-qb', 'develop');
  version('1.0.0');
  write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'forge', plugins: [{ name: 'forge', source: STABLE }] }));
  write('CHANGELOG.md', '# Changelog\n\n## 1.0.0\n\n- First.\n');
  write('dashboard/index.html', '<!doctype html>\n');
  write('.github/workflows/ci.yml', 'name: CI\n');
  write('.gitignore', 'dashboard/dist/\n');
  fs.copyFileSync(path.join(ROOT, 'COMMIT'), path.join(dir, 'COMMIT'));
  fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(dir, '.gitattributes'));
  git('add', '-A');
  git('commit', '-qm', 'Release 1.0.0');
  git('tag', '-a', 'v1.0.0', '-m', 'Forge 1.0.0');
  // The human's first stable commit: v1.0.0 without .github/workflows.
  git('checkout', '-q', '--detach', 'v1.0.0');
  git('rm', '-rq', '.github/workflows');
  git('commit', '-qm', 'stable: start from v1.0.0 without .github/workflows');
  git('branch', 'stable');
  git('checkout', '-q', 'develop');
  git('commit', '-q', '--allow-empty', '-m', 'feat: work');
  git('checkout', '-qb', 'release/v1.1.0');
  version('1.1.0');
  write('CHANGELOG.md', '# Changelog\n\n## 1.1.0\n\n- New.\n\n## 1.0.0\n\n- First.\n');
  git('commit', '-qam', 'Release 1.1.0');
  git('checkout', '-q', 'develop');
});

test('detect, the stable tree and COMMIT hold for a merged release PR on develop', POSIX, () => {
  const dist = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-dist-')));
  try {
    for (const form of ['merge commit', 'squash'] as const) {
      const repo = releaseRepo();
      try {
        const rev = (ref: string) => repo.git('rev-parse', ref).toString().trim();
        // GitHub's merge of the release PR into develop, in either form.
        if (form === 'merge commit') repo.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #9 from o/release/v1.1.0', 'release/v1.1.0');
        else {
          repo.git('merge', '-q', '--squash', 'release/v1.1.0');
          repo.git('commit', '-qm', 'Release 1.1.0 (#9)');
        }
        const develop = rev('HEAD');
        assert.equal(plan(repo.dir, 'detect').stdout, 'version=1.1.0\nrelease=true\n', `${form}: the merge of a release PR releases`);

        fs.rmSync(dist, { recursive: true, force: true });
        fs.cpSync(FIXTURE_DIST, dist, { recursive: true });
        const { distHash, sourceHash, STAMP } = stampModule;
        fs.writeFileSync(path.join(dist, STAMP), JSON.stringify({ source: sourceHash(path.join(repo.dir, 'dashboard'), path.join(repo.dir, 'package-lock.json')), dist: distHash(dist) }));
        const c = spawnSync(process.execPath, [STABLE_TREE, '--develop', develop, '--dist', dist], { cwd: repo.dir, encoding: 'utf8' });
        assert.equal(c.status, 0, `${form}: ${c.stderr}`);
        const tree = /^tree=([0-9a-f]{40})\n$/.exec(c.stdout)?.[1];
        assert.ok(tree, c.stdout);
        // What the release job makes through the API: the tree with parents [stable, the develop commit].
        const stable = execFileSync('git', ['commit-tree', tree, '-p', rev('stable'), '-p', develop, '-m', 'Release 1.1.0'], { cwd: repo.dir }).toString().trim();
        const files = repo.git('ls-tree', '-r', '--name-only', stable).toString().split('\n');
        assert.ok(files.includes('dashboard/dist/manifest.json'), `${form}: stable carries the built dashboard`);
        assert.ok(!files.some((f) => f.startsWith('.github/workflows/')), `${form}: stable carries no workflow`);
        assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', develop, stable], { cwd: repo.dir }).status, 0, `${form}: the develop commit is in stable's history`);
        assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', rev('stable'), stable], { cwd: repo.dir }).status, 0, `${form}: stable only moves forward`);

        const tar = bash('git archive --format=tar --prefix=forge/ "$SHA" | tar -xOf - forge/COMMIT', repo.dir, { SHA: develop });
        assert.equal(tar.status, 0, tar.stderr);
        assert.equal(tar.stdout.trim(), develop, `${form}: the archive stamps the develop commit`);

        // A later push to develop that keeps the version does not release.
        repo.git('commit', '-q', '--allow-empty', '-m', 'fix: later');
        assert.equal(plan(repo.dir, 'detect').stdout, 'version=1.1.0\nrelease=false\n', `${form}: an unchanged version does not`);
      } finally {
        repo.cleanup();
      }
    }
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('the build refuses a push that is more than the version bump', POSIX, () => {
  const step = stepsOf(WF.jobs.build).find((s) => s.name === 'Check the push is only the version bump');
  assert.ok(step?.run, 'the build job has the step');
  assert.ok(stepsOf(WF.jobs.build).indexOf(step!) < stepsOf(WF.jobs.build).findIndex((s) => s.run === 'npm ci'), 'it runs before npm ci installs from the lockfile');
  // The step reads package.json with the runner's node: the one running this test.
  const PATH = [path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter);
  const check = (repo: ReturnType<typeof tempRepo>) =>
    bash(step!.run, repo.dir, { PATH, GITHUB_SHA: repo.git('rev-parse', 'HEAD').toString().trim(), VERSION: '1.1.0' });
  const edit = (repo: ReturnType<typeof tempRepo>, rel: string, fn: (text: string) => string) => {
    const file = path.join(repo.dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fn(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''));
  };
  /** The release PR after someone pushed `more` to its branch, merged into develop the way GitHub does. */
  const merged = (form: 'merge commit' | 'squash', more?: (repo: ReturnType<typeof tempRepo>) => void) => {
    const repo = releaseRepo();
    if (more) {
      repo.git('checkout', '-q', 'release/v1.1.0');
      more(repo);
      repo.git('add', '-Af');
      repo.git('commit', '-qm', 'more');
      repo.git('checkout', '-q', 'develop');
    }
    if (form === 'merge commit') repo.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #9 from o/release/v1.1.0', 'release/v1.1.0');
    else {
      repo.git('merge', '-q', '--squash', 'release/v1.1.0');
      repo.git('commit', '-qm', 'Release 1.1.0 (#9)');
    }
    return repo;
  };

  for (const form of ['merge commit', 'squash'] as const) {
    const ok = merged(form);
    try {
      const r = check(ok);
      assert.equal(r.status, 0, `${form}: ${r.stdout}${r.stderr}`);
    } finally {
      ok.cleanup();
    }
  }

  const rows: [string, (repo: ReturnType<typeof tempRepo>) => void][] = [
    ['a script', (repo) => edit(repo, 'scripts/release-plan.ts', () => 'process.exit(0);\n')],
    ['a workflow', (repo) => edit(repo, '.github/workflows/ci.yml', (t) => `${t}# edited\n`)],
    ['a tracked dashboard/dist', (repo) => edit(repo, 'dashboard/dist/index.html', () => '<!doctype html>\n')],
    ['marketplace.json', (repo) => edit(repo, '.claude-plugin/marketplace.json', (t) => t.replace('"stable"', '"main"'))],
    ['a file whose name has a newline', (repo) => edit(repo, 'x\ny::error title=Fake::injected', () => 'x\n')],
    ['another resolved URL in the lockfile', (repo) => edit(repo, 'package-lock.json', (t) => t.replace('registry.npmjs.org', 'evil.example'))],
    ['a dependency version in the lockfile', (repo) => edit(repo, 'package-lock.json', (t) => t.replace('"version": "2.0.0"', '"version": "2.0.1"'))],
    ['a key added to plugin.json', (repo) => edit(repo, '.claude-plugin/plugin.json', (t) => t.replace('"version"', '"hooks": {},\n  "version"'))],
    ['an older CHANGELOG section edited', (repo) => edit(repo, 'CHANGELOG.md', (t) => t.replace('- First.', '- First!'))],
    ['a CHANGELOG section removed', (repo) => edit(repo, 'CHANGELOG.md', (t) => t.replace('- First.\n', ''))],
  ];
  for (const [what, more] of rows) {
    for (const form of ['merge commit', 'squash'] as const) {
      const repo = merged(form, more);
      try {
        const r = check(repo);
        assert.equal(r.status, 1, `${form}, ${what}: refused`);
        assert.match(r.stdout, /^::error title=More than the version bump::/m, `${form}, ${what}`);
        assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('::')).length, 1, `${form}, ${what}: one annotation, never one a file name made`);
      } finally {
        repo.cleanup();
      }
    }
  }

  // A commit with no first parent has nothing to compare with.
  const root = tempRepo();
  try {
    root.git('checkout', '-q', '--orphan', 'orphan');
    root.git('commit', '-qm', 'root', '--allow-empty');
    const r = check(root);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^::error title=No first parent::/m);
  } finally {
    root.cleanup();
  }
});

test('no AI attribution in generated text', () => {
  const files = ['.github/workflows/release.yml', '.github/workflows/ci.yml', 'scripts/stable-tree.ts', 'docs/RELEASES.md', ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^release(-.*)?\.ts$/.test(f)).map((f) => `scripts/${f}`)];
  for (const f of files) assert.deepEqual(findAttribution(read(f)), [], f);
});
