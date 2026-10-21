// .github/workflows/release.yml tags and publishes Forge with a write token: the shared checks in
// test/workflow-lint.ts hold its pins, permissions and where the token reaches. scripts/release-plan.ts
// and the archive step are run for real here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { findAttribution } from '../lib/attribution.ts';
import { tempRepo } from './helpers.ts';
import { credentialRefs, excessPermissions, loadWorkflow, persistedCredentials, secretLeaks, unpinnedActions } from './workflow-lint.ts';
import * as stampModule from '../dashboard/build-stamp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const PLAN = path.join(ROOT, 'scripts', 'release-plan.ts');

const WF = loadWorkflow('release.yml');
// Only the release job writes: it creates the tag and the Release.
const ALLOWED = { release: { contents: 'write' as const } };

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

test('only a push to main reaches the write token, and only the release job holds it', () => {
  assert.deepEqual(Object.keys(WF.on), ['push'], 'a PR, a manual run or another workflow must never reach the write token');
  assert.deepEqual(excessPermissions(WF, ALLOWED), []);
  flags(excessPermissions(mutate((wf) => { wf.permissions = { contents: 'write' }; }), ALLOWED), 'contents: write at the top level');
  flags(excessPermissions(mutate((wf) => { wf.jobs.release.permissions.packages = 'write'; }), ALLOWED), 'packages: write');
  flags(excessPermissions(mutate((wf) => { wf.permissions['id-token'] = 'write'; }), ALLOWED), 'id-token: write');
  flags(excessPermissions(mutate((wf) => { wf.jobs.detect.permissions = { contents: 'write' }; }), ALLOWED), 'write on detect');
  flags(excessPermissions(mutate((wf) => { wf.jobs.verify.permissions = { contents: 'write' }; }), ALLOWED), 'write on the reusable verify call');
  flags(excessPermissions(mutate((wf) => { wf.jobs.release.permissions = 'write-all'; }), ALLOWED), 'write-all on release');
});

test('every action is pinned, and the token reaches only the steps that call gh', () => {
  assert.deepEqual(unpinnedActions(WF), [], 'the local ./.github/workflows/ci.yml call needs no pin');
  assert.deepEqual(persistedCredentials(WF), []);
  assert.deepEqual(secretLeaks(WF), []);
  // Not vacuous: the tag and publish steps hold the token, in their own env.
  const refs = credentialRefs(WF);
  assert.ok(refs.length >= 1, 'release.yml holds a credential ref');
  assert.ok(refs.every((r) => r.scope === 'step-env' && r.where.endsWith('.env.GH_TOKEN')), JSON.stringify(refs));

  flags(unpinnedActions(mutate((wf) => { wf.jobs.release.steps[0].uses = 'actions/checkout@v7'; })), 'an unpinned action');
  flags(persistedCredentials(mutate((wf) => { delete wf.jobs.release.steps[0].with['persist-credentials']; })), 'checkout keeping credentials');
  flags(secretLeaks(mutate((wf) => { wf.jobs.release.env = { GH_TOKEN: '${{ github.token }}' }; })), 'a job-level token');
  flags(secretLeaks(mutate((wf) => { wf.env = { GH_TOKEN: '${{ github.token }}' }; })), 'a workflow-level token');
  flags(secretLeaks(mutate((wf) => { wf.jobs.verify.secrets = 'inherit'; })), 'secrets: inherit on the verify call');
  flags(secretLeaks(mutate((wf) => {
    const s = stepRunning(wf, 'release', (r) => r.startsWith('gh release create'));
    s.run = s.run.replace('gh release create', 'GH_TOKEN=${{ github.token }} gh release create');
  })), 'the token interpolated into run');
  flags(secretLeaks(mutate((wf) => { wf.jobs.detect.outputs.extra = '${{ github.token }}'; })), 'the token in a job output');
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
  const build = stepRunning(WF, 'release', (r) => r.includes('git archive')).run;
  const repo = tempRepo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-tmp-')));
  try {
    fs.copyFileSync(path.join(ROOT, 'COMMIT'), path.join(repo.dir, 'COMMIT'));
    fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(repo.dir, '.gitattributes'));
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'stamp');
    const run = () => {
      const sha = repo.git('rev-parse', 'HEAD').toString().trim();
      return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', build], {
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

test('detect and COMMIT hold for the commit npm run release pushes to main', POSIX, () => {
  const MAIN_UPDATE = path.join(ROOT, 'scripts', 'main-update.ts');
  const FIXTURE_DIST = path.join(ROOT, 'test', 'fixtures', 'dist');
  const dirs: string[] = [];
  /** main at 1.0.0 (tagged), develop at `next`, and main moved to the main-update commit as release.ts pushes it. */
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
    // A fast-forward: the commit's first parent is main's old tip.
    repo.git('merge', '-q', '--ff-only', update);
    assert.equal(rev('HEAD'), update);
    return { repo, merge: update };
  };
  try {
    const bumped = merged('1.1.0');
    assert.equal(plan(bumped.repo.dir, 'detect').stdout, 'version=1.1.0\nrelease=true\n', 'a bumped version releases');
    assert.ok(fs.existsSync(path.join(bumped.repo.dir, 'dashboard', 'dist', 'manifest.json')), 'main carries the built dashboard');
    const tar = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', 'git archive --format=tar --prefix=forge/ "$SHA" | tar -xOf - forge/COMMIT'], { cwd: bumped.repo.dir, encoding: 'utf8', env: { ...process.env, SHA: bumped.merge } });
    assert.equal(tar.status, 0, tar.stderr);
    assert.equal(tar.stdout.trim(), bumped.merge, 'the archive stamps the pushed commit');

    // A later commit on main that keeps the version (a hotfix not yet bumped) does not release.
    bumped.repo.git('commit', '-q', '--allow-empty', '-m', 'fix: hotfix');
    assert.equal(plan(bumped.repo.dir, 'detect').stdout, 'version=1.1.0\nrelease=false\n', 'an unchanged version does not');
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('no AI attribution in generated text', () => {
  const files = ['.github/workflows/release.yml', '.github/workflows/ci.yml', '.github/workflows/main-update.yml', 'scripts/main-update.ts', 'docs/RELEASES.md', ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^release(-.*)?\.ts$/.test(f)).map((f) => `scripts/${f}`)];
  for (const f of files) assert.deepEqual(findAttribution(read(f)), [], f);
});
