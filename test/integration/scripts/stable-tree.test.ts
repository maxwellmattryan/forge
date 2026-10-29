// scripts/stable-tree.ts: the stable tree release.yml's build checks (the released develop commit's tree minus
// .github/workflows/ plus the checked dashboard/dist/), printed only once a checkout of it passes the release check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fakeBin, repoTemplate } from '../../helpers.ts';
import { DIST, FIXTURE_DIST, noDist } from '../../dist.ts';
import { ASSET, checkedDistFiles, checkStable, manifestFiles, Refusal, stableTree } from '../../../scripts/stable-tree.ts';
import { distHash, sourceHash, STAMP } from '../../../dashboard/build-stamp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'stable-tree.ts');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const USAGE = 'usage: node scripts/stable-tree.ts --develop <sha> --dist <dir>\n';
const STABLE = { source: 'github', repo: 'maxwellmattryan/forge', ref: 'stable' };

type Repo = { dir: string; git: (...args: string[]) => Buffer; cleanup: () => void };
const out = (repo: Repo, ...args: string[]) => repo.git(...args).toString().trim();
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

/** develop at a merged release 1.1.0: a clean release checkout with workflows and a dashboard source change. */
const fixture: () => Repo = repoTemplate((dir) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const version = (v: string) => {
    write(dir, 'package.json', JSON.stringify({ name: 'forge', version: v }));
    write(dir, '.claude-plugin/plugin.json', JSON.stringify({ name: 'forge', version: v }));
  };
  version('1.0.0');
  write(dir, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'forge', plugins: [{ name: 'forge', source: STABLE }] }));
  write(dir, 'CHANGELOG.md', '# Changelog\n\n## 1.0.0\n\n- First.\n');
  write(dir, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/vite': { version: '7.0.0' } } }));
  write(dir, 'dashboard/index.html', '<!doctype html>\n');
  write(dir, 'dashboard/src/main.ts', 'export {};\n');
  write(dir, '.github/workflows/ci.yml', 'name: CI\n');
  write(dir, '.github/workflows/release.yml', 'name: Release\n');
  write(dir, '.github/dependabot.yml', 'version: 2\n');
  write(dir, '.gitignore', 'dashboard/dist/\n');
  git('add', '-A');
  git('commit', '-qm', 'Release 1.0.0');
  git('tag', '-a', 'v1.0.0', '-m', 'Forge 1.0.0');
  git('checkout', '-qb', 'develop');
  version('1.1.0');
  write(dir, 'CHANGELOG.md', '# Changelog\n\n## 1.1.0\n\n- New.\n\n## 1.0.0\n\n- First.\n');
  write(dir, 'dashboard/src/main.ts', 'export const x = 1;\n');
  git('commit', '-qam', 'Release 1.1.0');
});

const dists: string[] = [];
process.on('exit', () => { for (const d of dists) fs.rmSync(d, { recursive: true, force: true }); });
/** A copy of test/fixtures/dist changed by `before`, stamped against the checkout's sources, then changed by `after`. */
function makeDist(repo: Repo, before: (dist: string) => void = () => {}, after: (dist: string) => void = () => {}): string {
  const dist = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stable-tree-dist-')));
  dists.push(dist);
  fs.cpSync(FIXTURE_DIST, dist, { recursive: true });
  before(dist);
  fs.writeFileSync(path.join(dist, STAMP), JSON.stringify({ source: sourceHash(path.join(repo.dir, 'dashboard'), path.join(repo.dir, 'package-lock.json')), dist: distHash(dist) }));
  after(dist);
  return dist;
}
const run = (repo: Repo, develop: string, dist: string, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [SCRIPT, '--develop', develop, '--dist', dist], { cwd: repo.dir, encoding: 'utf8', env });
/** checkStable run in `repo`, as the script runs it from the checkout. */
function inRepo<T>(repo: Repo, fn: () => T): T {
  const cwd = process.cwd();
  process.chdir(repo.dir);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
}
const refuses = (repo: Repo, develop: string, dist: string, reason: string | RegExp, what: string) =>
  assert.throws(() => inRepo(repo, () => checkStable(develop, dist)), (e: unknown) => e instanceof Refusal && (typeof reason === 'string' ? e.message.includes(reason) : reason.test(e.message)), what);

test('the stable tree is the develop tree without .github/workflows plus dist', POSIX, () => {
  const repo = fixture();
  try {
    const develop = out(repo, 'rev-parse', 'develop');
    const dist = makeDist(repo);
    const index = out(repo, 'ls-files', '--stage');
    const status = out(repo, 'status', '--porcelain', '--untracked-files=all');

    const r = run(repo, develop, dist);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^tree=[0-9a-f]{40}\n$/);
    const tree = r.stdout.trim().slice('tree='.length);
    assert.equal(out(repo, 'cat-file', '-t', tree), 'tree');

    const listing = (rev: string) => out(repo, 'ls-tree', '-r', '--full-tree', rev).split('\n');
    const kept = listing(develop).filter((l) => !l.split('\t')[1].startsWith('.github/workflows/'));
    assert.equal(kept.length, listing(develop).length - 2, 'both workflow files dropped');
    const got = listing(tree);
    assert.ok(kept.every((l) => got.includes(l)), 'the rest of the develop tree unchanged, .github/dependabot.yml included');
    assert.ok(!got.some((l) => l.split('\t')[1].startsWith('.github/workflows/')), 'no workflow file');
    const added = got.filter((l) => !kept.includes(l));
    const files = ['assets/index-Fx1.css', 'assets/index-Fx1.js', STAMP, 'index.html', 'manifest.json'];
    assert.deepEqual(added.map((l) => l.split('\t')[1]).sort(), files.map((f) => `dashboard/dist/${f}`).sort(), 'plus exactly the dist');
    for (const l of added) assert.match(l, /^100644 blob [0-9a-f]{40}\t/);
    for (const f of files) assert.deepEqual(repo.git('cat-file', 'blob', `${tree}:dashboard/dist/${f}`), fs.readFileSync(path.join(dist, f)), `${f} byte-equal`);

    assert.equal(out(repo, 'ls-files', '--stage'), index, 'the index untouched');
    assert.equal(out(repo, 'status', '--porcelain', '--untracked-files=all'), status);
    assert.equal(out(repo, 'rev-parse', 'HEAD'), develop);
    assert.equal(out(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'the check worktree is gone');
    assert.ok(!out(repo, 'for-each-ref', '--format=%(objectname)').split('\n').some((sha) => out(repo, 'rev-parse', `${sha}^{tree}`) === tree), 'the check commit is on no ref');

    // A tag of another version decides nothing; the same inputs give the same tree.
    repo.git('tag', 'v1.1.00', develop);
    assert.equal(run(repo, develop, dist).stdout, r.stdout);
    // A clean filter on .js files must not reshape the built files (hash-object --no-filters). The check's
    // checkout would see them as changed and refuse, so this is the tree alone.
    repo.git('config', 'filter.shout.clean', 'tr a-z A-Z');
    fs.writeFileSync(path.join(repo.dir, '.git', 'info', 'attributes'), '*.js filter=shout\n');
    assert.equal(inRepo(repo, () => stableTree(develop, dist)), tree);
  } finally {
    repo.cleanup();
  }
});

test('the stable tree refuses a bad dist or tree', POSIX, () => {
  const repo = fixture();
  try {
    const develop = out(repo, 'rev-parse', 'develop');
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
    for (const [what, dist, reason] of rows) refuses(repo, develop, dist, reason, what);

    // The script's side of a refusal: exit 1, the reason on stderr, nothing for GITHUB_OUTPUT.
    const r = run(repo, develop, rows[0][1]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^stable-tree: dashboard\/dist holds a symlink/);

    const dist = makeDist(repo);
    const onDevelop = (change: () => void) => {
      repo.git('checkout', '-q', '--detach', develop);
      change();
      repo.git('add', '--force', '-A');
      repo.git('commit', '-qm', 'change');
      return out(repo, 'rev-parse', 'HEAD');
    };
    // A develop commit that already tracks the build.
    refuses(repo, onDevelop(() => write(repo.dir, 'dashboard/dist/index.html', '<!doctype html>\n')), dist, 'develop already tracks dashboard/dist', 'a tracked dist');
    // A tree the release check refuses: marketplace.json off stable, notes missing.
    const offStable = onDevelop(() => write(repo.dir, '.claude-plugin/marketplace.json', JSON.stringify({ name: 'forge', plugins: [{ name: 'forge', source: { ...STABLE, ref: 'v1.1.0' } }] })));
    refuses(repo, offStable, dist, /fails the release check:\n\.claude-plugin\/marketplace\.json must point the forge plugin at/, 'a marketplace ref');
    const noNotes = onDevelop(() => write(repo.dir, 'CHANGELOG.md', '# Changelog\n\n## 1.0.0\n\n- First.\n'));
    refuses(repo, noNotes, dist, 'CHANGELOG.md has no "## 1.1.0" heading', 'no notes');
    // The version already tagged at another commit.
    repo.git('tag', 'v1.1.0', 'main');
    refuses(repo, develop, dist, /v1\.1\.0 is already tagged at [0-9a-f]{7}/, 'tagged elsewhere');
    repo.git('tag', '-d', 'v1.1.0');
    assert.equal(out(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'every check worktree removed');
  } finally {
    repo.cleanup();
  }
});

test('arguments are checked before any git call', POSIX, () => {
  const repo = fixture();
  try {
    const develop = out(repo, 'rev-parse', 'develop');
    const dist = makeDist(repo);
    const git = fakeBin('git', 'exit 1');
    const stubbed = { ...process.env, PATH: `${git.dir}${path.delimiter}${process.env.PATH ?? ''}` };
    const usage: string[][] = [
      ['--develop', '-rf', '--dist', dist],
      ['--develop', '--output=x', '--dist', dist],
      ['--develop', develop.slice(0, 7), '--dist', dist],
      ['--develop', develop.toUpperCase(), '--dist', dist],
      ['--develop', `${develop}\n`, '--dist', dist],
      ['--develop', 'HEAD', '--dist', dist],
      ['--develop', develop],
      ['--develop', develop, '--dist', dist, '--dist', dist],
      ['--develop', develop, '--dist', dist, '--main', develop],
      ['commit', '--develop', develop, '--dist', dist],
      [],
    ];
    for (const args of usage) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo.dir, encoding: 'utf8', env: stubbed });
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.equal(r.stdout, '', JSON.stringify(args));
      assert.equal(r.stderr, USAGE, JSON.stringify(args));
    }
    assert.deepEqual(git.calls(), [], 'no git process started');

    const missing = run(repo, 'f'.repeat(40), dist);
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /^stable-tree: .*(not a commit|failed)/);
  } finally {
    repo.cleanup();
  }
});

test('the real build\'s manifest names only files ASSET matches', { skip: noDist() }, () => {
  const named = manifestFiles(DIST);
  assert.ok(named.size > 0);
  for (const f of named) assert.match(f, ASSET);
  assert.deepEqual(checkedDistFiles(DIST), ['index.html', 'manifest.json', STAMP, ...named].sort());
});
