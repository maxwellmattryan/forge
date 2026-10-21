// scripts/main-update.ts: the commit `npm run release` pushes to main (develop's tree plus the checked dist,
// parents [main, develop]) and the hotfixes on main that a release would undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoTemplate } from './helpers.ts';
import { FIXTURE_DIST } from './dist.ts';
import { distHash, sourceHash, STAMP } from '../dashboard/build-stamp.mjs';
import { mainOnlyCommits } from '../scripts/main-update.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'main-update.ts');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

/** main at 1.0.0 (tagged v1.0.0); develop one commit ahead at 1.1.0 with a dashboard source change. Checked out: develop. */
const fixture = repoTemplate((dir) => {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'pipe' });
  writeJson(path.join(dir, 'package.json'), { name: 'forge', version: '1.0.0' });
  writeJson(path.join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: { '': { version: '1.0.0' }, 'node_modules/vite': { version: '8.3.4' } } });
  fs.mkdirSync(path.join(dir, 'dashboard', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dashboard', 'index.html'), '<!doctype html>\n');
  fs.writeFileSync(path.join(dir, 'dashboard', 'src', 'main.ts'), 'export {};\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dashboard/dist/\n');
  git('add', '-A');
  git('commit', '-qm', 'release 1.0.0');
  git('tag', '-a', 'v1.0.0', '-m', 'Forge 1.0.0');
  git('checkout', '-qb', 'develop');
  writeJson(path.join(dir, 'package.json'), { name: 'forge', version: '1.1.0' });
  fs.writeFileSync(path.join(dir, 'dashboard', 'src', 'main.ts'), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'feat: develop work');
});

type Repo = ReturnType<typeof fixture>;
const rev = (repo: Repo, ref: string) => repo.git('rev-parse', ref).toString().trim();
const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env });

/** A copy of the fixture dist, stamped against the repo's develop sources unless `source` says otherwise. */
function distFor(repo: Repo, source?: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-main-update-dist-')));
  fs.cpSync(FIXTURE_DIST, dir, { recursive: true });
  restamp(dir, source ?? sourceHash(path.join(repo.dir, 'dashboard'), path.join(repo.dir, 'package-lock.json')));
  return dir;
}
const restamp = (dir: string, source: string) => writeJson(path.join(dir, STAMP), { source, dist: distHash(dir) });

function listFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(dir, r) : [r];
  });
}

test('commit is develop\'s tree plus dist with parents main, develop', POSIX, () => {
  const repo = fixture();
  const dist = distFor(repo);
  try {
    const main = rev(repo, 'main');
    const develop = rev(repo, 'develop');
    const before = [repo.git('status', '--porcelain', '--untracked-files=all').toString(), repo.git('ls-files', '-s').toString(), rev(repo, 'HEAD')];
    const r = run(repo.dir, ['commit', '--main', main, '--develop', develop, '--dist', dist]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^[0-9a-f]{40}\n$/);
    const sha = r.stdout.trim();

    assert.deepEqual(repo.git('log', '-1', '--format=%P', sha).toString().trim().split(' '), [main, develop]);
    const tree = (ref: string) => repo.git('ls-tree', '-r', '--full-tree', ref).toString().split('\n').filter(Boolean);
    const isDist = (l: string) => l.split('\t')[1].startsWith('dashboard/dist/');
    assert.deepEqual(tree(sha).filter((l) => !isDist(l)), tree(develop), "develop's tree, unchanged");
    const files = listFiles(dist).sort();
    assert.deepEqual(tree(sha).filter(isDist).map((l) => l.split('\t')[1].slice('dashboard/dist/'.length)).sort(), files, 'exactly the dist files');
    for (const l of tree(sha).filter(isDist)) assert.ok(l.startsWith('100644 blob '), l);
    for (const f of files) assert.ok(repo.git('cat-file', 'blob', `${sha}:dashboard/dist/${f}`).equals(fs.readFileSync(path.join(dist, f))), `${f} is byte-equal`);

    assert.equal(repo.git('log', '-1', '--format=%B', sha).toString(), 'Release 1.1.0\n\n', 'the subject alone, no trailers');
    assert.equal(repo.git('log', '-1', '--format=%an <%ae>|%cn <%ce>', sha).toString().trim(), 'Test <test@example.com>|Test <test@example.com>', 'whoever runs the release');
    assert.equal(repo.git('log', '-1', '--format=%(trailers)', sha).toString().trim(), '');
    assert.deepEqual([repo.git('status', '--porcelain', '--untracked-files=all').toString(), repo.git('ls-files', '-s').toString(), rev(repo, 'HEAD')], before, 'the index, working tree and HEAD are untouched');

    // Once v1.1.0 is tagged, main has nothing new to release.
    repo.git('tag', 'v1.1.0', develop);
    const again = run(repo.dir, ['commit', '--main', main, '--develop', develop, '--dist', dist]);
    assert.equal(again.status, 1);
    assert.equal(again.stdout, '');
    assert.match(again.stderr, /v1\.1\.0 is already tagged/);
    // A tag of another version decides nothing.
    repo.git('tag', '-d', 'v1.1.0');
    repo.git('tag', 'v1.1.00', develop);
    assert.equal(run(repo.dir, ['commit', '--main', main, '--develop', develop, '--dist', dist]).status, 0);
  } finally {
    repo.cleanup();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('commit refuses a bad dist or develop tree', POSIX, () => {
  const repo = fixture();
  const dists: string[] = [];
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-main-update-bin-')));
  try {
    const main = rev(repo, 'main');
    const develop = rev(repo, 'develop');
    const refuses = (what: string, args: string[], env?: NodeJS.ProcessEnv) => {
      const r = run(repo.dir, args, env);
      assert.equal(r.status, 1, `${what}: ${r.stderr}`);
      assert.equal(r.stdout, '', `${what}: nothing on stdout`);
      return r.stderr;
    };
    const broken = (what: string, change: (dir: string) => void, re: RegExp) => {
      const dir = distFor(repo);
      dists.push(dir);
      change(dir);
      assert.match(refuses(what, ['commit', '--main', main, '--develop', develop, '--dist', dir]), re, what);
    };
    const restamped = (fn: (dir: string) => void) => (dir: string) => {
      fn(dir);
      restamp(dir, JSON.parse(fs.readFileSync(path.join(dir, STAMP), 'utf8')).source);
    };
    const manifest = (dir: string, entry: Record<string, unknown>) => writeJson(path.join(dir, 'manifest.json'), { 'index.html': entry });

    broken('a symlink', restamped((d) => fs.symlinkSync('index-Fx1.js', path.join(d, 'assets', 'link-1.js'))), /symlink: assets\/link-1\.js/);
    broken('a symlinked assets dir', restamped((d) => {
      fs.renameSync(path.join(d, 'assets'), path.join(d, 'real'));
      fs.symlinkSync('real', path.join(d, 'assets'));
    }), /symlink: assets/);
    broken('a file the manifest does not name', restamped((d) => fs.writeFileSync(path.join(d, 'assets', 'stray-1.js'), 'x')), /does not name: assets\/stray-1\.js/);
    broken('a file outside the allowed set', restamped((d) => fs.writeFileSync(path.join(d, 'notes.txt'), 'x')), /does not name: notes\.txt/);
    broken('a dotfile', restamped((d) => fs.writeFileSync(path.join(d, '.env'), 'x')), /does not name: \.env/);
    broken('a manifest name off the asset pattern', restamped((d) => {
      fs.writeFileSync(path.join(d, 'assets', 'icon.svg'), '<svg/>');
      manifest(d, { file: 'assets/index-Fx1.js', css: ['assets/index-Fx1.css'], assets: ['assets/icon.svg'] });
    }), /outside assets/);
    broken('a manifest name that climbs out', restamped((d) => manifest(d, { file: '../lib/server.ts' })), /outside assets/);
    broken('a manifest name in a subdirectory', restamped((d) => {
      fs.mkdirSync(path.join(d, 'assets', 'x'));
      fs.writeFileSync(path.join(d, 'assets', 'x', 'a.js'), 'x');
      manifest(d, { file: 'assets/index-Fx1.js', css: ['assets/index-Fx1.css'], assets: ['assets/x/a.js'] });
    }), /outside assets/);
    broken('a non-string manifest name', restamped((d) => manifest(d, { file: 7 })), /non-string/);
    broken('a missing named file', restamped((d) => fs.rmSync(path.join(d, 'assets', 'index-Fx1.css'))), /missing assets\/index-Fx1\.css/);
    broken('no stamp', (d) => fs.rmSync(path.join(d, STAMP)), /missing build-stamp\.json/);
    broken('a hand-edited dist', (d) => fs.appendFileSync(path.join(d, 'assets', 'index-Fx1.js'), '// edit\n'), /does not match its build-stamp\.json \(dist\)/);
    broken('a stamp from other sources', (d) => restamp(d, 'f'.repeat(64)), /not built from develop's sources/);

    // develop's tree already tracks a dist path.
    repo.git('checkout', '-qb', 'tracks-dist', 'develop');
    fs.mkdirSync(path.join(repo.dir, 'dashboard', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, 'dashboard', 'dist', 'index.html'), '<p>');
    repo.git('add', '--force', 'dashboard/dist/index.html');
    repo.git('commit', '-qm', 'commit the build');
    const tracks = rev(repo, 'tracks-dist');
    repo.git('checkout', '-q', 'develop');
    const dist = distFor(repo);
    dists.push(dist);
    assert.match(refuses('develop tracks dist', ['commit', '--main', main, '--develop', tracks, '--dist', dist]), /develop already tracks dashboard\/dist/);

    // Option-shaped and malformed shas are refused before any git call: a git stub on PATH would leave a marker.
    const marker = path.join(tmp, 'git-ran');
    fs.writeFileSync(path.join(tmp, 'git'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    const stubbed = { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}` };
    for (const [flag, value] of [['--main', '-rf'], ['--develop', '--output=x'], ['--main', main.slice(0, 7)], ['--develop', develop.toUpperCase()], ['--main', `${main}\n`], ['--develop', 'HEAD']]) {
      const args = ['commit', '--main', main, '--develop', develop, '--dist', dist];
      args[args.indexOf(flag) + 1] = value;
      assert.match(refuses(`${flag} ${JSON.stringify(value)}`, args, stubbed), /must be a 40-character lowercase hex sha/);
      assert.ok(!fs.existsSync(marker), `no git call for ${JSON.stringify(value)}`);
    }
    // A sha that is not a commit in this repo.
    refuses('an unknown sha', ['commit', '--main', 'a'.repeat(40), '--develop', develop, '--dist', dist]);
    for (const args of [['commit', '--main', main, '--develop', develop], ['commit', '--main', main, '--develop', develop, '--dist', dist, '--dist', dist], ['commit', '--main', main, '--develop', develop, '--dist', dist, '--run-url', 'x'], ['body', '--main', main, '--develop', develop, '--dist', dist], ['push']]) {
      assert.equal(run(repo.dir, args).status, 2, JSON.stringify(args));
    }
  } finally {
    repo.cleanup();
    for (const d of dists) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const commitOn = (repo: Repo, message: string) => {
  repo.git('commit', '-q', '--allow-empty', '-m', message);
  return rev(repo, 'HEAD');
};

test('mainOnlyCommits lists hotfixes since the last release', POSIX, () => {
  const repo = fixture();
  const cwd = process.cwd();
  try {
    process.chdir(repo.dir);
    const develop = rev(repo, 'develop');
    // No main-only commits: main is an ancestor of develop.
    assert.deepEqual(mainOnlyCommits(rev(repo, 'main'), develop), []);

    // main moves on: a hotfix before the last release, the release itself, then two hotfixes after it.
    repo.git('checkout', '-q', 'main');
    commitOn(repo, 'fix: before the last release');
    repo.git('merge', '-q', '--no-ff', '-m', 'Release 1.1.0', 'develop');
    const hotfix = commitOn(repo, 'fix: guard the token');
    commitOn(repo, `Update main to develop ${develop.slice(0, 7)} (#5)`);
    commitOn(repo, 'Release 1.1.1 (#6)');
    const hostile = commitOn(repo, `fix: \u001b[31mred\u001b[0m ${'x'.repeat(10_000)}`);
    const main = rev(repo, 'HEAD');
    repo.git('checkout', '-q', 'develop');

    const listed = mainOnlyCommits(main, develop);
    assert.equal(listed.length, 2, JSON.stringify(listed));
    assert.deepEqual(listed[1], { sha: hotfix.slice(0, 7), subject: 'fix: guard the token' });
    assert.equal(listed[0].sha, hostile.slice(0, 7));
    assert.ok(listed[0].subject.startsWith('fix:  [31mred [0m x'), listed[0].subject);
    assert.ok(listed[0].subject.length <= 200, 'a long subject is cut');
    assert.doesNotMatch(listed.map((c) => c.subject).join('\n'), /\u001b/, 'no control characters');
    assert.ok(!listed.some((c) => c.subject.includes('before the last release')), 'the last release already took it');
  } finally {
    process.chdir(cwd);
    repo.cleanup();
  }
});

test('commit refuses a version that is not X.Y.Z', POSIX, () => {
  const repo = fixture();
  const dist = distFor(repo);
  try {
    const main = rev(repo, 'main');
    // The version reaches a commit subject, so only X.Y.Z passes.
    for (const v of ['1.2', '1.2.0-rc.1', '1.2.0\nx', 7]) {
      writeJson(path.join(repo.dir, 'package.json'), { name: 'forge', version: v });
      repo.git('commit', '-qam', `version ${JSON.stringify(v)}`);
      const r = run(repo.dir, ['commit', '--main', main, '--develop', rev(repo, 'HEAD'), '--dist', dist]);
      assert.equal(r.status, 1, JSON.stringify(v));
      assert.equal(r.stdout, '', JSON.stringify(v));
    }
  } finally {
    repo.cleanup();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});
