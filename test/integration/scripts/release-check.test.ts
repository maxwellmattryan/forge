// scripts/release-check.ts: whether a checkout is fit to be a release commit, through releaseProblems and
// the spawned `npm run release:check` script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { repoTemplate } from '../../helpers.ts';
import { changelogSection, releaseProblems, type DistMode } from '../../../scripts/release-check.ts';
import { distHash, sourceHash, STAMP } from '../../../dashboard/build-stamp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release-check.ts');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const USAGE = 'usage: node scripts/release-check.ts [--root <dir>] [--dist absent|present]';
const MARKETPLACE = '.claude-plugin/marketplace.json';
const marketplace = (ref: string | null, name = 'forge') =>
  JSON.stringify({ name: 'forge', plugins: [{ name, source: { source: 'url', url: 'https://github.com/o/forge.git', ...(ref === null ? {} : { ref }) } }] }, null, 2);

type Repo = { dir: string; git: (...args: string[]) => Buffer; cleanup: () => void };
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const stamp = (dir: string) => {
  const dist = path.join(dir, 'dashboard', 'dist');
  write(dir, `dashboard/dist/${STAMP}`, JSON.stringify({ source: sourceHash(path.join(dir, 'dashboard'), path.join(dir, 'package-lock.json')), dist: distHash(dist) }));
};

/** A clean release checkout at 1.2.3 with a tracked, stamped dashboard/dist. */
const fixture: () => Repo = repoTemplate((dir) => {
  const version = JSON.stringify({ name: 'forge', version: '1.2.3' });
  write(dir, 'package.json', version);
  write(dir, '.claude-plugin/plugin.json', version);
  write(dir, MARKETPLACE, marketplace('v1.2.3'));
  write(dir, 'CHANGELOG.md', '# Changelog\n\n## 1.2.3\n\n- Release tags.\n\n## 1.2.2\n\n- Older.\n');
  write(dir, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
  write(dir, 'dashboard/index.html', '<!doctype html>\n');
  write(dir, 'dashboard/dist/x.js', 'export {};\n');
  stamp(dir);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'release 1.2.3'], { cwd: dir, stdio: 'pipe' });
});
/** A fresh fixture copy changed by `edit`, committed unless `commit` is false. */
function changed(edit: (dir: string, repo: Repo) => void, commit = true): Repo {
  const repo = fixture();
  edit(repo.dir, repo);
  if (commit) {
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'change', '--allow-empty');
  }
  return repo;
}
const sha = (repo: Repo, rev = 'HEAD') => repo.git('rev-parse', rev).toString().trim();
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('changelogSection reads exactly one version', () => {
  const text = '# Changelog\n\n## 0.17.10\n\n- ten\n\n## 0.17.1  \n\n- one\n- more\n\n## 0.17.0\n\n- zero\n';
  const rows: [string, string, string | null][] = [
    [text, '0.17.1', '- one\n- more'],
    [text, '0.17.10', '- ten'],
    [text, '0.17.0', '- zero'],
    [text, '0.17', null],
    ['## 0.17.10\n- ten\n', '0.17.1', null],
    ['## 1.0.0\n\n## 0.9.0\n- x\n', '1.0.0', ''],
    ['### 1.0.0\n- x\n', '1.0.0', null],
  ];
  for (const [body, version, want] of rows) assert.equal(changelogSection(body, version), want, `${version} in ${JSON.stringify(body)}`);
});

test('releaseProblems passes a clean release checkout and names each problem', POSIX, () => {
  const clean = fixture();
  const repos: Repo[] = [clean];
  try {
    assert.deepEqual(releaseProblems(clean.dir), []);
    assert.deepEqual(releaseProblems(clean.dir, { dist: 'present' }), []);

    const version = (dir: string, v: string, plugin = v) => {
      write(dir, 'package.json', JSON.stringify({ name: 'forge', version: v }));
      write(dir, '.claude-plugin/plugin.json', JSON.stringify({ name: 'forge', version: plugin }));
    };
    const changelog = (body: string) => (dir: string) => write(dir, 'CHANGELOG.md', `# Changelog\n\n${body}`);
    const rows: [string, (dir: string, repo: Repo) => void, boolean, string | RegExp][] = [
      ['versions differ', (d) => version(d, '1.2.3', '1.2.4'), true, 'package.json version "1.2.3" differs from .claude-plugin/plugin.json version "1.2.4"'],
      ['a two-part version', (d) => version(d, '1.0'), true, 'version "1.0" is not X.Y.Z'],
      ['a prerelease', (d) => version(d, '1.0.0-rc.1'), true, 'version "1.0.0-rc.1" is not X.Y.Z'],
      ['no heading', changelog('## 1.2.2\n\n- Older.\n'), true, 'CHANGELOG.md has no "## 1.2.3" heading'],
      ['only a longer version', (d) => { version(d, '0.17.1'); changelog('## 0.17.10\n\n- ten\n')(d); }, true, 'CHANGELOG.md has no "## 0.17.1" heading'],
      ['an empty section', changelog('## 1.2.3\n\n## 1.2.2\n\n- Older.\n'), true, 'CHANGELOG.md "## 1.2.3" has no notes'],
      ['empty bullets', changelog('## 1.2.3\n\n-\n- \n'), true, 'CHANGELOG.md "## 1.2.3" has no notes'],
      ['an attribution line', changelog('## 1.2.3\n\n- x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'), true, /AI attribution line/],
      ['a modified tracked file', (d) => write(d, 'README.md', '# changed\n'), false, 'the working tree is not clean: README.md'],
      ['an untracked file', (d) => write(d, 'notes.txt', 'x\n'), false, 'the working tree is not clean: notes.txt'],
      ['more than ten dirty paths', (d) => { for (let i = 0; i < 12; i++) write(d, `f${String(i).padStart(2, '0')}.txt`, 'x'); }, false, /not clean: f00\.txt, .*f09\.txt and 2 more$/],
      ['a dashboard source changed after the stamp', (d) => write(d, 'dashboard/index.html', '<!doctype html>\n<p>new</p>\n'), true, /^dashboard\/dist is stale/],
      ['a hand-edited dist', (d) => write(d, 'dashboard/dist/x.js', 'export const x = 1;\n'), true, /edited by hand/],
      ['no stamp', (d) => fs.rmSync(path.join(d, 'dashboard', 'dist', STAMP)), true, /^cannot check dashboard\/dist against build-stamp\.json/],
    ];
    for (const [what, edit, commit, problem] of rows) {
      const repo = changed(edit, commit);
      repos.push(repo);
      const problems = releaseProblems(repo.dir);
      assert.ok(problems.some((p) => (typeof problem === 'string' ? p === problem : problem.test(p))), `${what}: ${JSON.stringify(problems)}`);
    }

    // The marketplace ref names the version's tag, whatever the dist mode.
    const refRows: [string, (dir: string) => void, string | RegExp | null][] = [
      ['the tag', (d) => write(d, MARKETPLACE, marketplace('v1.2.3')), null],
      ['ref: main', (d) => write(d, MARKETPLACE, marketplace('main')), '.claude-plugin/marketplace.json points installs at "main", not v1.2.3'],
      ['the previous tag', (d) => write(d, MARKETPLACE, marketplace('v1.2.2')), '.claude-plugin/marketplace.json points installs at "v1.2.2", not v1.2.3'],
      ['no forge plugin', (d) => write(d, MARKETPLACE, marketplace('v1.2.3', 'other')), '.claude-plugin/marketplace.json has no forge plugin with a source.ref'],
      ['no source.ref', (d) => write(d, MARKETPLACE, marketplace(null)), '.claude-plugin/marketplace.json has no forge plugin with a source.ref'],
      ['no file', (d) => fs.rmSync(path.join(d, MARKETPLACE)), /^cannot read marketplace\.json: /],
      ['not JSON', (d) => write(d, MARKETPLACE, '{ "plugins": ['), /^cannot read marketplace\.json: /],
    ];
    for (const [what, edit, problem] of refRows) {
      const repo = changed(edit);
      repos.push(repo);
      for (const dist of ['absent', 'present', undefined] as (DistMode | undefined)[]) {
        const found = releaseProblems(repo.dir, { dist }).filter((p) => /marketplace\.json/.test(p));
        if (problem === null) assert.deepEqual(found, [], `${what}, --dist ${dist}`);
        else assert.ok(found.length === 1 && (typeof problem === 'string' ? found[0] === problem : problem.test(found[0])), `${what}, --dist ${dist}: ${JSON.stringify(found)}`);
      }
    }
  } finally {
    for (const r of repos) r.cleanup();
  }
});

test('dist mode absent/present/default', POSIX, () => {
  const tracked = fixture();
  const untracked = changed((d, r) => r.git('rm', '-rq', 'dashboard/dist'));
  const ignored = changed((d, r) => {
    r.git('rm', '-rq', '--cached', 'dashboard/dist');
    write(d, '.gitignore', 'dashboard/dist/\n');
  });
  const edited = changed((d) => write(d, 'dashboard/dist/x.js', 'export const edited = 1;\n'));
  try {
    assert.deepEqual(releaseProblems(tracked.dir, { dist: 'present' }), []);
    assert.deepEqual(releaseProblems(tracked.dir), []);
    assert.deepEqual(releaseProblems(tracked.dir, { dist: 'absent' }), ['dashboard/dist is tracked: develop never commits the build (CI builds it for the main update)']);
    assert.ok(releaseProblems(edited.dir, { dist: 'present' }).some((p) => /edited by hand/.test(p)));
    assert.ok(releaseProblems(edited.dir).some((p) => /edited by hand/.test(p)));

    for (const [what, repo] of [['untracked', untracked], ['built but gitignored', ignored]] as const) {
      assert.deepEqual(releaseProblems(repo.dir, { dist: 'absent' }), [], what);
      assert.deepEqual(releaseProblems(repo.dir, { dist: 'present' }), ['dashboard/dist is not committed: main needs the built dashboard'], what);
    }
    assert.deepEqual(releaseProblems(untracked.dir), [], 'no stamp check without a tracked dist');

    const ok = run('--dist', 'absent', '--root', untracked.dir);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = run('--root', untracked.dir, '--dist', 'present');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^dashboard\/dist is not committed: main needs the built dashboard$/m);
  } finally {
    for (const r of [tracked, untracked, ignored, edited]) r.cleanup();
  }
});

test('a version already tagged at another commit fails the present check', POSIX, () => {
  const repos: Repo[] = [];
  const fresh = () => {
    const r = fixture();
    repos.push(r);
    return r;
  };
  try {
    const untagged = fresh();
    assert.deepEqual(releaseProblems(untagged.dir, { dist: 'present' }), [], 'untagged');

    const atHead = fresh();
    atHead.git('tag', '-a', 'v1.2.3', '-m', 'Forge 1.2.3');
    assert.deepEqual(releaseProblems(atHead.dir, { dist: 'present' }), [], 'tagged at HEAD');

    // A hotfix on main without a bump: v1.2.3 tags the commit before it.
    const hotfix = fresh();
    hotfix.git('tag', '-a', 'v1.2.3', '-m', 'Forge 1.2.3');
    const tagged = sha(hotfix);
    write(hotfix.dir, 'README.md', '# fixed\n');
    hotfix.git('commit', '-qam', 'fix: hotfix');
    const head = sha(hotfix);
    assert.deepEqual(releaseProblems(hotfix.dir, { dist: 'present' }), [`v1.2.3 is already tagged at ${tagged.slice(0, 7)}, not this commit (${head.slice(0, 7)}): bump the version to release again`]);
    assert.deepEqual(releaseProblems(hotfix.dir), [], 'the default mode');
    assert.deepEqual(releaseProblems(hotfix.dir, { dist: 'absent' }), ['dashboard/dist is tracked: develop never commits the build (CI builds it for the main update)'], 'absent: no tag problem');
    // A tag of another version decides nothing.
    const other = fresh();
    other.git('tag', 'v1.2.30', 'HEAD');
    write(other.dir, 'README.md', '# later\n');
    other.git('commit', '-qam', 'later');
    assert.deepEqual(releaseProblems(other.dir, { dist: 'present' }), []);
  } finally {
    for (const r of repos) r.cleanup();
  }
});

test('the script prints the passed line or the problems on stderr, and rejects bad arguments', POSIX, () => {
  const clean = fixture();
  const dirty = changed((d) => {
    write(d, '.claude-plugin/plugin.json', JSON.stringify({ name: 'forge', version: '1.2.4' }));
    write(d, 'stray.txt', 'x\n');
  }, false);
  try {
    const ok = run('--root', clean.dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'release check passed: 1.2.3\n');
    assert.equal(ok.stderr, '');

    const bad = run('--root', dirty.dir);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
    const lines = bad.stderr.trimEnd().split('\n');
    assert.ok(lines.includes('the working tree is not clean: .claude-plugin/plugin.json, stray.txt'), bad.stderr);
    assert.ok(lines.includes('package.json version "1.2.3" differs from .claude-plugin/plugin.json version "1.2.4"'), bad.stderr);

    const usage: string[][] = [
      ['--dist'],
      ['--dist', 'maybe'],
      ['--dist', 'ABSENT'],
      ['--dist', ''],
      ['--dist', 'absent', '--dist', 'absent'],
      ['--root', clean.dir, '--dist', 'x'],
      ['--dist', 'absent', '--root'],
      ['--root', clean.dir, 'extra'],
      ['--nope'],
    ];
    for (const args of usage) {
      const r = run(...args);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.equal(r.stdout, '', JSON.stringify(args));
      assert.equal(r.stderr, `${USAGE}\n`, JSON.stringify(args));
    }
  } finally {
    clean.cleanup();
    dirty.cleanup();
  }
});
