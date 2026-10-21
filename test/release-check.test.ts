// scripts/release-check.ts: what `npm run release:check` and CI's `release check` job refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoTemplate } from './helpers.ts';
import { changelogSection, releaseProblems } from '../scripts/release-check.ts';
import { distHash, sourceHash, STAMP } from '../dashboard/build-stamp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release-check.ts');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

function setVersion(dir: string, pkg: string, plugin = pkg): void {
  writeJson(path.join(dir, 'package.json'), { name: 'forge', version: pkg });
  writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'forge', version: plugin });
}

function stamp(dir: string): void {
  const dashboard = path.join(dir, 'dashboard');
  const dist = path.join(dashboard, 'dist');
  writeJson(path.join(dist, STAMP), { source: sourceHash(dashboard, path.join(dir, 'package-lock.json')), dist: distHash(dist) });
}

/** The smallest checkout releaseProblems passes: versions, CHANGELOG, a lockfile and a stamped dist. */
const fixture = repoTemplate((dir) => {
  setVersion(dir, '1.2.3');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3\n\n- Release tags.\n\n## 1.2.2\n\n- Older.\n');
  writeJson(path.join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: { '': {} } });
  fs.mkdirSync(path.join(dir, 'dashboard', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dashboard', 'index.html'), '<!doctype html>\n');
  fs.writeFileSync(path.join(dir, 'dashboard', 'dist', 'x.js'), 'export const x = 1;\n');
  stamp(dir);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('add', '-A');
  git('commit', '-qm', 'release fixture');
});

/** A fixture with `change` committed, so only the problem under test shows. */
function broken(change: (dir: string) => void, commit = true): string[] {
  const repo = fixture();
  try {
    change(repo.dir);
    if (commit) {
      repo.git('add', '-A');
      repo.git('commit', '-qm', 'change');
    }
    return releaseProblems(repo.dir);
  } finally {
    repo.cleanup();
  }
}

const one = (problems: string[], re: RegExp, what: string) => {
  assert.ok(problems.some((p) => re.test(p)), `${what}: ${JSON.stringify(problems)}`);
};

test('changelogSection reads exactly one version', () => {
  const text = '# Changelog\n\n## 0.17.10\n\n- ten\n\n## 0.17.1  \n\n- one\n- more\n\n## 0.17.0\n\n- zero\n';
  assert.equal(changelogSection(text, '0.17.1'), '- one\n- more');
  assert.equal(changelogSection(text, '0.17.10'), '- ten');
  assert.equal(changelogSection(text, '0.17.0'), '- zero');
  assert.equal(changelogSection(text, '0.17'), null);
  assert.equal(changelogSection('## 0.17.10\n- ten\n', '0.17.1'), null, 'a longer version is not this one');
  assert.equal(changelogSection('## 1.0.0\n\n## 0.9.0\n- x\n', '1.0.0'), '');
  assert.equal(changelogSection('### 1.0.0\n- x\n', '1.0.0'), null);
});

test('releaseProblems passes a clean release checkout and names each problem', POSIX, () => {
  const clean = fixture();
  try {
    assert.deepEqual(releaseProblems(clean.dir), []);
  } finally {
    clean.cleanup();
  }

  one(broken((d) => setVersion(d, '1.2.3', '1.2.4')), /package\.json version "1\.2\.3" differs from \.claude-plugin\/plugin\.json version "1\.2\.4"/, 'versions differ');
  for (const v of ['1.0', '1.0.0-rc.1']) {
    one(broken((d) => {
      setVersion(d, v);
      fs.writeFileSync(path.join(d, 'CHANGELOG.md'), `# Changelog\n\n## ${v}\n\n- notes\n`);
    }), /is not X\.Y\.Z/, `version ${v}`);
  }
  one(broken((d) => fs.writeFileSync(path.join(d, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.2\n\n- Older.\n')), /no "## 1\.2\.3" heading/, 'no heading');
  one(broken((d) => {
    setVersion(d, '0.17.1');
    fs.writeFileSync(path.join(d, 'CHANGELOG.md'), '# Changelog\n\n## 0.17.10\n\n- ten\n');
  }), /no "## 0\.17\.1" heading/, 'only 0.17.10 for 0.17.1');
  one(broken((d) => fs.writeFileSync(path.join(d, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3\n\n\n## 1.2.2\n\n- Older.\n')), /"## 1\.2\.3" has no notes/, 'an empty section');
  one(broken((d) => fs.writeFileSync(path.join(d, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3\n\n-\n- \n\n## 1.2.2\n\n- Older.\n')), /"## 1\.2\.3" has no notes/, 'empty bullets');
  one(broken((d) => fs.writeFileSync(path.join(d, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3\n\n- Release tags.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n')), /AI attribution line/, 'an attribution line');
  one(broken((d) => fs.writeFileSync(path.join(d, 'README.md'), '# changed\n'), false), /not clean: README\.md/, 'a modified tracked file');
  one(broken((d) => fs.writeFileSync(path.join(d, 'notes.txt'), 'scratch\n'), false), /not clean: notes\.txt/, 'an untracked file');
  one(broken((d) => fs.writeFileSync(path.join(d, 'dashboard', 'index.html'), '<!doctype html><title>x</title>\n')), /dashboard\/dist is stale/, 'a dashboard source changed after the stamp');
  one(broken((d) => fs.writeFileSync(path.join(d, 'dashboard', 'dist', 'x.js'), 'export const x = 2;\n')), /edited by hand/, 'a hand-edited dist file');
  one(broken((d) => fs.rmSync(path.join(d, 'dashboard', 'dist', STAMP))), /cannot check dashboard\/dist/, 'no stamp');

  // Only the first ten dirty paths are listed.
  const many = broken((d) => {
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(d, `f${String(i).padStart(2, '0')}.txt`), 'x\n');
  }, false);
  one(many, /f09\.txt and 2 more$/, 'a long dirty list');
});

test('dist mode absent/present/default', POSIX, () => {
  const ABSENT = /^dashboard\/dist is tracked: develop never commits the build \(CI builds it for the main update\)$/;
  const PRESENT = /^dashboard\/dist is not committed: main needs the built dashboard$/;
  // The fixture tracks a stamped dist, as main does.
  const main = fixture();
  try {
    assert.deepEqual(releaseProblems(main.dir, { dist: 'present' }), []);
    assert.deepEqual(releaseProblems(main.dir), []);
    one(releaseProblems(main.dir, { dist: 'absent' }), ABSENT, 'absent with a tracked dist');
    // present runs today's stamp checks.
    fs.writeFileSync(path.join(main.dir, 'dashboard', 'dist', 'x.js'), 'export const x = 2;\n');
    main.git('commit', '-qam', 'edit dist');
    one(releaseProblems(main.dir, { dist: 'present' }), /edited by hand/, 'present with a hand-edited dist');
    one(releaseProblems(main.dir), /edited by hand/, 'default with a tracked, hand-edited dist');
  } finally {
    main.cleanup();
  }

  // develop: dist untracked (and not even on disk).
  const develop = fixture();
  try {
    develop.git('rm', '-rq', '--', 'dashboard/dist');
    develop.git('commit', '-qm', 'drop dist');
    assert.deepEqual(releaseProblems(develop.dir, { dist: 'absent' }), []);
    assert.deepEqual(releaseProblems(develop.dir), [], 'default skips the stamp when dist is untracked');
    const present = releaseProblems(develop.dir, { dist: 'present' });
    one(present, PRESENT, 'present with no dist');
    assert.ok(!present.some((p) => /cannot check dashboard\/dist/.test(p)), 'no stamp check without a tracked dist');
    // A dist on disk but gitignored is still not committed.
    fs.writeFileSync(path.join(develop.dir, '.gitignore'), 'dashboard/dist/\n');
    develop.git('add', '.gitignore');
    develop.git('commit', '-qm', 'ignore dist');
    fs.mkdirSync(path.join(develop.dir, 'dashboard', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(develop.dir, 'dashboard', 'dist', 'x.js'), 'export const x = 1;\n');
    stamp(develop.dir);
    one(releaseProblems(develop.dir, { dist: 'present' }), PRESENT, 'present with an ignored, built dist');
    assert.deepEqual(releaseProblems(develop.dir, { dist: 'absent' }), []);
    const r = spawnSync(process.execPath, [SCRIPT, '--dist', 'absent', '--root', develop.dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const p = spawnSync(process.execPath, [SCRIPT, '--root', develop.dir, '--dist', 'present'], { encoding: 'utf8' });
    assert.equal(p.status, 1);
    assert.ok(p.stderr.split('\n').some((l) => PRESENT.test(l)), p.stderr);
  } finally {
    develop.cleanup();
  }
});

test('rejects a bad --dist', POSIX, () => {
  const repo = fixture();
  try {
    for (const args of [['--dist'], ['--dist', 'maybe'], ['--dist', 'ABSENT'], ['--dist', ''], ['--dist', 'absent', '--dist', 'present'], ['--root', repo.dir, '--dist', 'x'], ['--dist', 'absent', '--root'], ['--dist', 'absent', 'extra']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.match(r.stderr, /^usage: node scripts\/release-check\.ts \[--root <dir>\] \[--dist absent\|present\]$/m);
      assert.equal(r.stdout, '');
    }
  } finally {
    repo.cleanup();
  }
});

test('the script prints the passed line or the problems on stderr', POSIX, () => {
  const repo = fixture();
  try {
    const ok = spawnSync(process.execPath, [SCRIPT, '--root', repo.dir], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'release check passed: 1.2.3\n');
    assert.equal(ok.stderr, '');

    fs.writeFileSync(path.join(repo.dir, 'stray.txt'), 'x\n');
    const bad = spawnSync(process.execPath, [SCRIPT, '--root', repo.dir], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /^the working tree is not clean: stray\.txt$/m);

    const usage = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally {
    repo.cleanup();
  }
});
