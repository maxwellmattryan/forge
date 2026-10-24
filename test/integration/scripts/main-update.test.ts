// scripts/main-update.ts: the main update the release PR carries (the release commit's tree plus the
// checked dashboard/dist/, parents [main, release commit]) and the hotfixes a release would undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fakeBin, repoTemplate, tempRepo } from '../../helpers.ts';
import { DIST, FIXTURE_DIST, noDist } from '../../dist.ts';
import { ASSET, checkedDistFiles, mainOnlyCommits, manifestFiles } from '../../../scripts/main-update.ts';
import { distHash, sourceHash, STAMP } from '../../../dashboard/build-stamp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'main-update.ts');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const USAGE = 'usage: node scripts/main-update.ts commit --main <sha> --develop <sha> --dist <dir>\n';

type Repo = { dir: string; git: (...args: string[]) => Buffer; cleanup: () => void };
const out = (repo: Repo, ...args: string[]) => repo.git(...args).toString().trim();
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

/** main at a tagged 1.0.0, and develop one release commit ahead at 1.1.0 with a dashboard source change. */
const fixture: () => Repo = repoTemplate((dir) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  write(dir, 'package.json', JSON.stringify({ name: 'forge', version: '1.0.0' }));
  write(dir, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/vite': { version: '7.0.0' } } }));
  write(dir, 'dashboard/index.html', '<!doctype html>\n');
  write(dir, 'dashboard/src/main.ts', 'export {};\n');
  write(dir, '.gitignore', 'dashboard/dist/\n');
  git('add', '-A');
  git('commit', '-qm', 'Release 1.0.0');
  git('tag', '-a', 'v1.0.0', '-m', 'Forge 1.0.0');
  git('checkout', '-qb', 'develop');
  write(dir, 'package.json', JSON.stringify({ name: 'forge', version: '1.1.0' }));
  write(dir, 'dashboard/src/main.ts', 'export const x = 1;\n');
  git('commit', '-qam', 'Release 1.1.0');
});

const dists: string[] = [];
process.on('exit', () => { for (const d of dists) fs.rmSync(d, { recursive: true, force: true }); });
/** A copy of test/fixtures/dist changed by `before`, stamped against the checkout's sources, then changed by `after`. */
function makeDist(repo: Repo, before: (dist: string) => void = () => {}, after: (dist: string) => void = () => {}): string {
  const dist = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-main-update-dist-')));
  dists.push(dist);
  fs.cpSync(FIXTURE_DIST, dist, { recursive: true });
  before(dist);
  fs.writeFileSync(path.join(dist, STAMP), JSON.stringify({ source: sourceHash(path.join(repo.dir, 'dashboard'), path.join(repo.dir, 'package-lock.json')), dist: distHash(dist) }));
  after(dist);
  return dist;
}
const commit = (repo: Repo, main: string, develop: string, dist: string, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [SCRIPT, 'commit', '--main', main, '--develop', develop, '--dist', dist], { cwd: repo.dir, encoding: 'utf8', env });
const refused = (r: ReturnType<typeof commit>, reason: string | RegExp, what: string) => {
  assert.equal(r.status, 1, `${what}: ${r.stderr}`);
  assert.equal(r.stdout, '', what);
  assert.match(r.stderr, /^main-update: /, what);
  if (typeof reason === 'string') assert.ok(r.stderr.includes(reason), `${what}: ${r.stderr}`);
  else assert.match(r.stderr, reason, what);
};

test('commit is the release commit\'s tree plus dist with parents main and the release commit', POSIX, () => {
  const repo = fixture();
  try {
    const [main, release] = [out(repo, 'rev-parse', 'main'), out(repo, 'rev-parse', 'develop')];
    // A clean filter on .js files must not reshape the built files (hash-object --no-filters).
    repo.git('config', 'filter.shout.clean', 'tr a-z A-Z');
    fs.writeFileSync(path.join(repo.dir, '.git', 'info', 'attributes'), '*.js filter=shout\n');
    const dist = makeDist(repo);
    const index = out(repo, 'ls-files', '--stage');
    const status = out(repo, 'status', '--porcelain', '--untracked-files=all');

    // A tag of another version decides nothing.
    repo.git('tag', 'v1.1.00', release);
    const r = commit(repo, main, release, dist);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^[0-9a-f]{40}\n$/);
    const sha = r.stdout.trim();

    assert.equal(out(repo, 'rev-list', '--parents', '-n', '1', sha), `${sha} ${main} ${release}`);
    const raw = repo.git('cat-file', 'commit', sha).toString();
    assert.equal(raw.slice(raw.indexOf('\n\n') + 2), 'Release 1.1.0\n', 'the subject and nothing else');
    assert.match(raw, /^author Test <test@example\.com> /m);
    assert.match(raw, /^committer Test <test@example\.com> /m);

    const tree = (rev: string) => out(repo, 'ls-tree', '-r', '--full-tree', rev).split('\n');
    const added = tree(sha).filter((l) => !tree(release).includes(l));
    const files = ['assets/index-Fx1.css', 'assets/index-Fx1.js', STAMP, 'index.html', 'manifest.json'];
    assert.deepEqual(added.map((l) => l.split('\t')[1]).sort(), files.map((f) => `dashboard/dist/${f}`).sort(), 'the release tree plus exactly the dist');
    assert.ok(tree(release).every((l) => tree(sha).includes(l)), 'the release tree unchanged');
    for (const l of added) assert.match(l, /^100644 blob [0-9a-f]{40}\t/);
    for (const f of files) assert.deepEqual(repo.git('cat-file', 'blob', `${sha}:dashboard/dist/${f}`), fs.readFileSync(path.join(dist, f)), `${f} byte-equal`);

    assert.equal(out(repo, 'ls-files', '--stage'), index, 'the index untouched');
    assert.equal(out(repo, 'status', '--porcelain', '--untracked-files=all'), status);
    assert.equal(out(repo, 'rev-parse', 'HEAD'), release);

    // Once v<version> is tagged, main moves no more for it.
    repo.git('tag', 'v1.1.0', release);
    refused(commit(repo, main, release, dist), 'v1.1.0 is already tagged', 'tagged');
    repo.git('tag', '-d', 'v1.1.0');

    // The version becomes a commit subject: only X.Y.Z.
    for (const bad of ['1.2', '1.2.0-rc.1', '1.2.0\nx', 7]) {
      repo.git('checkout', '-q', '--detach', release);
      write(repo.dir, 'package.json', JSON.stringify({ name: 'forge', version: bad }));
      repo.git('commit', '-qam', 'bad version');
      refused(commit(repo, main, out(repo, 'rev-parse', 'HEAD'), dist), /is not X\.Y\.Z/, JSON.stringify(bad));
    }
  } finally {
    repo.cleanup();
  }
});

test('commit refuses a bad dist or tree', POSIX, () => {
  const repo = fixture();
  try {
    const [main, release] = [out(repo, 'rev-parse', 'main'), out(repo, 'rev-parse', 'develop')];
    const manifest = (dist: string, fn: (m: any) => void) => {
      const file = path.join(dist, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      fn(m);
      fs.writeFileSync(file, JSON.stringify(m));
    };
    const rows: [string, string, string][] = [
      ['a symlinked file', makeDist(repo, (d) => fs.symlinkSync(path.join(d, 'assets', 'index-Fx1.js'), path.join(d, 'assets', 'link-1.js'))), 'symlink: assets/link-1.js'],
      ['a symlinked assets dir', makeDist(repo, (d) => {
        const real = path.join(path.dirname(d), `${path.basename(d)}-assets`);
        fs.renameSync(path.join(d, 'assets'), real);
        dists.push(real);
        fs.symlinkSync(real, path.join(d, 'assets'));
      }), 'symlink: assets'],
      ['a file the manifest does not name', makeDist(repo, (d) => write(d, 'assets/stray-1.js', 'x')), 'does not name: assets/stray-1.js'],
      ['a file outside the allowed set', makeDist(repo, (d) => write(d, 'notes.txt', 'x')), 'does not name: notes.txt'],
      ['a dotfile', makeDist(repo, (d) => write(d, '.env', 'X=1')), 'does not name: .env'],
      ['a name off the asset pattern', makeDist(repo, (d) => manifest(d, (m) => m['index.html'].css.push('assets/icon.svg'))), 'outside assets'],
      ['a name climbing out', makeDist(repo, (d) => manifest(d, (m) => m['index.html'].css.push('../lib/server.ts'))), 'outside assets'],
      ['a name in a subdirectory', makeDist(repo, (d) => manifest(d, (m) => m['index.html'].css.push('assets/x/a.js'))), 'outside assets'],
      ['a non-string name', makeDist(repo, (d) => manifest(d, (m) => { m['index.html'].file = 7; })), 'non-string'],
      ['a missing named file', makeDist(repo, (d) => fs.rmSync(path.join(d, 'assets', 'index-Fx1.css'))), 'missing assets/index-Fx1.css'],
      ['no stamp', makeDist(repo, undefined, (d) => fs.rmSync(path.join(d, STAMP))), `missing ${STAMP}`],
      ['a hand-edited dist', makeDist(repo, undefined, (d) => fs.appendFileSync(path.join(d, 'assets', 'index-Fx1.js'), '// edited\n')), `does not match its ${STAMP} (dist)`],
      ['a stamp from other sources', makeDist(repo, undefined, (d) => fs.writeFileSync(path.join(d, STAMP), JSON.stringify({ source: 'other', dist: distHash(d) }))), "not built from develop's sources"],
    ];
    for (const [what, dist, reason] of rows) refused(commit(repo, main, release, dist), reason, what);

    // A release tree that already tracks the build.
    repo.git('checkout', '-q', '--detach', release);
    write(repo.dir, 'dashboard/dist/index.html', '<!doctype html>\n');
    repo.git('add', '--force', 'dashboard/dist/index.html');
    repo.git('commit', '-qm', 'tracks dist');
    refused(commit(repo, main, out(repo, 'rev-parse', 'HEAD'), makeDist(repo)), 'develop already tracks dashboard/dist', 'a tracked dist');
  } finally {
    repo.cleanup();
  }
});

test('commit checks its arguments before any git call', POSIX, () => {
  const repo = fixture();
  try {
    const [main, release] = [out(repo, 'rev-parse', 'main'), out(repo, 'rev-parse', 'develop')];
    const dist = makeDist(repo);
    const git = fakeBin('git', 'exit 1');
    const stubbed = { ...process.env, PATH: `${git.dir}${path.delimiter}${process.env.PATH ?? ''}` };
    const rows: [string, string, string][] = [
      ['an option as --main', '-rf', release],
      ['an option as --develop', main, '--output=x'],
      ['a short sha', main.slice(0, 7), release],
      ['an uppercase sha', main.toUpperCase(), release],
      ['a trailing newline', `${main}\n`, release],
      ['a ref name', 'HEAD', release],
    ];
    for (const [what, m, d] of rows) {
      const r = commit(repo, m, d, dist, stubbed);
      assert.equal(r.status, 1, what);
      assert.match(r.stderr, /must be a 40-character lowercase hex sha/, what);
    }
    assert.deepEqual(git.calls(), [], 'no git process started');

    refused(commit(repo, 'f'.repeat(40), release, dist), /not a commit|failed/, 'a sha that is not a commit');

    const usage: string[][] = [
      ['commit', '--main', main, '--develop', release],
      ['commit', '--main', main, '--develop', release, '--dist', dist, '--dist', dist],
      ['commit', '--main', main, '--develop', release, '--dist', dist, '--run-url', 'https://x'],
      ['body', '--main', main, '--develop', release, '--dist', dist],
      ['push', '--main', main, '--develop', release, '--dist', dist],
    ];
    for (const args of usage) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo.dir, encoding: 'utf8' });
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.equal(r.stderr, USAGE, JSON.stringify(args));
    }
  } finally {
    repo.cleanup();
  }
});

test('mainOnlyCommits lists hotfixes since the last release', POSIX, () => {
  const repo = tempRepo();
  const cwd = process.cwd();
  try {
    const empty = (subject: string) => repo.git('commit', '-q', '--allow-empty', '-m', subject);
    repo.git('checkout', '-qb', 'develop');
    empty('feat: develop work');
    repo.git('checkout', '-q', 'main');
    process.chdir(repo.dir);
    const rev = (r: string) => out(repo, 'rev-parse', r);
    assert.deepEqual(mainOnlyCommits(rev('main'), rev('develop')), [], 'main is an ancestor of develop');

    empty('fix: before the release');
    repo.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #4 from o/release/v1.1.0', 'develop');
    const red = `fix: \u001b[31mred\u001b[0m x ${'y'.repeat(250)}`;
    for (const s of ['Update main to develop abc1234 (#5)', 'Release 1.1.1 (#6)', 'Release 1.1.2: pin the source (#7)', red]) empty(s);
    repo.git('checkout', '-q', 'develop');
    empty('feat: more develop work');

    const got = mainOnlyCommits(rev('main'), rev('develop'));
    assert.equal(got.length, 2, JSON.stringify(got));
    for (const c of got) assert.match(c.sha, /^[0-9a-f]{7,40}$/);
    assert.ok(got[0].subject.startsWith('fix:  [31mred [0m x yyy'), got[0].subject);
    assert.ok(got[0].subject.length <= 200 && got[0].subject.endsWith('…'), 'cut to 200 characters');
    assert.equal(got[1].subject, 'Release 1.1.2: pin the source (#7)', 'a hotfix titled after its release is still a hotfix');
  } finally {
    process.chdir(cwd);
    repo.cleanup();
  }
});

test('the real build\'s manifest names only files ASSET matches', { skip: noDist() }, () => {
  const named = manifestFiles(DIST);
  assert.ok(named.size > 0);
  for (const f of named) assert.match(f, ASSET);
  assert.deepEqual(checkedDistFiles(DIST), ['index.html', 'manifest.json', STAMP, ...named].sort());
});
