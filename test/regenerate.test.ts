import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults, validateConfig } from '../lib/config.ts';
import { jobWorktreeProblem, partitionConflicts } from '../lib/regenerate.ts';

test('validateConfig checks worktrees.generated and generatedBy', () => {
  const repo = tempRepo();
  try {
    const problems = (generated: unknown[], generatedBy = 'build', commands: Record<string, string | null> = { build: 'node gen.mjs' }) => {
      const c: any = defaults();
      Object.assign(c.commands, commands);
      c.worktrees.generated = generated;
      c.worktrees.generatedBy = generatedBy;
      return validateConfig(c, repo.dir).filter((p) => p.startsWith('worktrees.'));
    };
    assert.deepEqual(validateConfig(defaults(), repo.dir), [], 'the defaults produce no problem');
    assert.deepEqual(problems(['dist/**', 'dashboard/dist/', '*.min.js']), []);
    for (const bad of ['', '  ', 3, null, '/abs/dist/**', '-rf', '!dist/**', ':(top)dist', '../x/**', 'dist/../../x', 'a\\..\\b']) {
      assert.equal(problems([bad]).length, 1, `${JSON.stringify(bad)} is refused`);
    }
    assert.match(problems(['dist/**'], 'nope')[0], /generatedBy must name a configured command/);
    assert.match(problems(['dist/**'], 'build', { build: null })[0], /generatedBy/, 'an unset command is not configured');
    assert.match(problems(['dist/**'], 'toString', {})[0], /generatedBy/, 'an inherited property is not a command');
    assert.deepEqual(problems([], 'nope'), [], 'generatedBy is only checked when generated is set');
    const c: any = defaults();
    c.worktrees.generated = 'dist/**';
    assert.match(validateConfig(c, repo.dir).join('\n'), /worktrees\.generated must be a list/);
  } finally {
    repo.cleanup();
  }
});

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const commitAll = (cwd: string, msg: string) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};

// Builds dist/out.txt from src/*.txt and one content-hashed dist/assets/<hash>.txt, deleting older
// ones. dist/static.txt and dist/old.txt are generated paths it never writes.
const GEN = `import fs from 'node:fs';
import crypto from 'node:crypto';
const src = fs.readdirSync('src').filter((f) => f.endsWith('.txt')).sort().map((f) => fs.readFileSync('src/' + f, 'utf8')).join('');
fs.mkdirSync('dist/assets', { recursive: true });
fs.writeFileSync('dist/out.txt', src);
const name = crypto.createHash('sha256').update(src).digest('hex').slice(0, 8) + '.txt';
for (const f of fs.readdirSync('dist/assets')) if (f !== name) fs.rmSync('dist/assets/' + f);
fs.writeFileSync('dist/assets/' + name, src);
fs.appendFileSync('.gen-runs', 'x');
`;
const BAD = `import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/junk.txt', 'junk');
console.log('BUILD-BROKE on purpose');
process.exit(3);
`;
const built = (sources: string[]) => sources.sort().join('');
const assetName = (text: string) => `dist/assets/${createHash('sha256').update(text).digest('hex').slice(0, 8)}.txt`;

/**
 * A scratch repo whose `commands.gen` rebuilds dist/ from src/, with a claimed job and its worktree.
 * `config` patches the answers; `edit` rewrites config.yml afterwards (for configs validation refuses).
 */
function fixture(o: { config?: Record<string, any>; edit?: (text: string) => string; extra?: Record<string, string> } = {}) {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir, GIT_EDITOR: 'true' };
  const wtRoot = path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`);
  const answers = path.join(repo.dir, '..', `answers-regen-${path.basename(repo.dir)}.json`);
  const forge = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...env, ...extraEnv } });
    let out: any = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {}
    return { status: r.status, out, stderr: r.stderr };
  };
  const write = (dir: string, files: Record<string, string | null>) => {
    for (const [rel, text] of Object.entries(files)) {
      const f = path.join(dir, rel);
      if (text === null) fs.rmSync(f, { force: true });
      else {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, text);
      }
    }
  };
  const gen = (dir: string) => execFileSync(process.execPath, ['gen.mjs'], { cwd: dir });
  write(repo.dir, { 'gen.mjs': GEN, 'bad.mjs': BAD, 'src/a.txt': 'a\n', '.gitignore': '.gen-runs\n', ...o.extra });
  gen(repo.dir);
  const base = { commands: { gen: 'node gen.mjs', bad: 'node bad.mjs', test: 'true' }, worktrees: { root: `../${path.basename(repo.dir)}.wt`, generated: ['dist/**'], generatedBy: 'gen' } };
  fs.writeFileSync(answers, JSON.stringify({ ...base, ...o.config, worktrees: { ...base.worktrees, ...o.config?.worktrees }, commands: { ...base.commands, ...o.config?.commands } }));
  const init = forge(['init', 'write', '--answers', answers]);
  assert.equal(init.out?.ok, true, init.stderr);
  if (o.edit) {
    const file = path.join(repo.dir, '.forge', 'config.yml');
    fs.writeFileSync(file, o.edit(fs.readFileSync(file, 'utf8')));
  }
  commitAll(repo.dir, 'forge');
  forge(['tracker', 'create', '--title', 'Regen']);
  const id: string = forge(['next', '--claim', '--session', 's1']).out.id;
  const wt: string = forge(['worktree', 'create', id]).out.path;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf8', env, stdio: 'pipe' });
  const events = () =>
    fs
      .readFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return {
    repo,
    wt,
    id,
    forge,
    git,
    events,
    /** Changes files in the worktree (`branch`) or the main checkout (`base`), rebuilds dist/ and commits. */
    commit: (side: 'branch' | 'base', files: Record<string, string | null>, msg: string, o2: { build?: boolean } = {}) => {
      const dir = side === 'branch' ? wt : repo.dir;
      write(dir, files);
      if (o2.build !== false) gen(dir);
      commitAll(dir, msg);
    },
    unmerged: () => git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean),
    inProgress: (ref: string) => fs.existsSync(path.resolve(wt, git('rev-parse', '--git-path', ref).trim())),
    sources: (ref = 'HEAD') =>
      git('ls-tree', '--name-only', `${ref}:src`)
        .split('\n')
        .filter(Boolean)
        .map((f) => git('show', `${ref}:src/${f}`)),
    assets: (ref = 'HEAD') => git('ls-tree', '-r', '--name-only', ref, '--', 'dist/assets').split('\n').filter(Boolean),
    cleanup: () => {
      fs.rmSync(answers, { force: true });
      fs.rmSync(wtRoot, { recursive: true, force: true });
      repo.cleanup();
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

/** Each side adds a different source and commits its rebuilt dist/: a conflict on dist/out.txt only. */
function generatedOnly(f: Fixture) {
  f.commit('branch', { 'src/b.txt': 'b\n' }, 'branch b');
  f.commit('base', { 'src/c.txt': 'c\n' }, 'base c');
}

/** The paths a plain merge or rebase of the branch leaves unmerged (git's rename detection pairs hashed assets up too). */
function probe(f: Fixture, strategy: 'merge' | 'rebase'): string[] {
  try {
    f.git(...(strategy === 'merge' ? ['merge', '--no-edit', 'main'] : ['rebase', 'main']));
  } catch {}
  const paths = f.unmerged().sort();
  f.git(strategy, '--abort');
  return paths;
}

/** How many times gen.mjs has run in the worktree (the fixture's own builds included). */
function genRuns(f: Fixture): number {
  const file = path.join(f.wt, '.gen-runs');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0;
}

/** Sorted, unique generated paths, including dist/out.txt and `also`. */
function assertRegenerated(list: string[], also: string[] = []) {
  assert.ok(Array.isArray(list), JSON.stringify(list));
  assert.deepEqual(list, [...new Set(list)].sort(), 'sorted and unique');
  for (const p of ['dist/out.txt', ...also]) assert.ok(list.includes(p), `${p} in ${list}`);
  assert.ok(list.every((p) => p.startsWith('dist/')), list.join());
}

/** HEAD's dist/ is what a fresh build of HEAD's sources writes. */
function assertFreshBuild(f: Fixture) {
  const text = built(f.sources());
  assert.equal(f.git('show', 'HEAD:dist/out.txt'), text, 'dist/out.txt is a fresh build of the merged sources');
  assert.deepEqual(f.assets(), [assetName(text)], 'stale hashed assets are deleted and the new one added');
}

test('merge: only generated conflicts are rebuilt and committed', () => {
  const f = fixture();
  try {
    generatedOnly(f);
    const staleBranch = f.assets('HEAD')[0];
    const expected = probe(f, 'merge');
    assert.ok(expected.includes('dist/out.txt') && expected.every((p) => p.startsWith('dist/')), expected.join());
    const r = f.forge(['integrate', f.id, '--strategy', 'merge']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out, { ok: true, behind: 1, strategy: 'merge', rewritten: false, regenerated: expected });
    assert.equal(f.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3, 'a two-parent merge commit');
    assert.deepEqual(f.sources().sort(), ['a\n', 'b\n', 'c\n']);
    assertFreshBuild(f);
    assert.ok(!f.assets().includes(staleBranch));
    assert.equal(f.git('status', '--porcelain'), '');
    const evs = f.events();
    assert.deepEqual(evs.filter((e) => e.type === 'integrate-conflicts'), []);
    const last = evs.at(-1);
    assert.equal(last.type, 'integrated');
    assert.deepEqual([last.behind, last.strategy, last.regenerated], [1, 'merge', expected]);
    const logs = fs.readdirSync(path.join(f.repo.dir, '.forge', 'jobs', f.id, 'logs'));
    assert.ok(logs.some((l) => l.startsWith('integrate-regenerate-')), 'the build log is kept');
  } finally {
    f.cleanup();
  }
});

test('rebase: every pick that conflicts only on generated paths is rebuilt', () => {
  const f = fixture();
  try {
    f.commit('branch', { 'src/b.txt': 'b\n' }, 'branch b');
    f.commit('branch', { 'src/d.txt': 'd\n' }, 'branch d');
    f.commit('base', { 'src/c.txt': 'c\n' }, 'base c');
    const r = f.forge(['integrate', f.id, '--strategy', 'rebase']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(r.out), ['ok', 'behind', 'strategy', 'rewritten', 'regenerated']);
    assert.deepEqual([r.out.ok, r.out.behind, r.out.strategy, r.out.rewritten], [true, 1, 'rebase', true]);
    assertRegenerated(r.out.regenerated);
    assert.equal(f.git('rev-list', '--merges', 'HEAD').trim(), '', 'linear history');
    assert.equal(f.git('rev-list', '--count', 'main..HEAD').trim(), '2', 'both picks are on the base');
    f.git('merge-base', '--is-ancestor', 'main', 'HEAD');
    assertFreshBuild(f);
    assert.equal(f.inProgress('rebase-merge'), false);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally {
    f.cleanup();
  }
});

test('the base side wins for generated paths the build does not rewrite', () => {
  for (const strategy of ['merge', 'rebase']) {
    const f = fixture({ extra: { 'dist/static.txt': 'init\n', 'dist/old.txt': 'old\n' } });
    try {
      f.commit('branch', { 'src/b.txt': 'b\n', 'dist/static.txt': 'branch\n', 'dist/old.txt': 'branch edit\n' }, 'branch');
      f.commit('base', { 'src/c.txt': 'c\n', 'dist/static.txt': 'base\n', 'dist/old.txt': null }, 'base');
      const r = f.forge(['integrate', f.id, '--strategy', strategy]);
      assert.equal(r.status, 0, `${strategy}: ${r.stderr} ${JSON.stringify(r.out)}`);
      assertRegenerated(r.out.regenerated, ['dist/old.txt', 'dist/static.txt']);
      assert.equal(f.git('show', 'HEAD:dist/static.txt'), 'base\n', `${strategy}: the base side of a path the build never writes`);
      assert.equal(f.git('ls-tree', '--name-only', 'HEAD', '--', 'dist/old.txt').trim(), '', `${strategy}: deleted on base, deleted here (modify/delete)`);
      assertFreshBuild(f);
      assert.equal(f.git('status', '--porcelain'), '', strategy);
    } finally {
      f.cleanup();
    }
  }
});

test('mixed: only real conflicts are left for the integrator', () => {
  const f = fixture();
  try {
    f.commit('branch', { 'src/b.txt': 'b\n', 'README.md': '# ours\n' }, 'branch');
    f.commit('base', { 'src/c.txt': 'c\n', 'README.md': '# theirs\n' }, 'base');
    const head = f.git('rev-parse', 'HEAD');
    const before = genRuns(f);
    let r = f.forge(['integrate', f.id, '--strategy', 'merge']);
    assert.equal(r.status, 1);
    const { regenerated, ...rest } = r.out;
    assert.deepEqual(rest, { ok: false, behind: 1, strategy: 'merge', conflicts: ['README.md'], inProgress: false });
    assertRegenerated(regenerated);
    assert.equal(f.inProgress('MERGE_HEAD'), false, 'the merge is aborted');
    assert.equal(f.git('status', '--porcelain'), '');
    assert.equal(f.git('rev-parse', 'HEAD'), head);
    const ev = f.events().filter((e) => e.type === 'integrate-conflicts').at(-1);
    assert.deepEqual([ev.conflicts, ev.regenerated], [['README.md'], regenerated]);
    assert.equal(genRuns(f), before, 'nothing is built while sources may hold conflict markers');

    r = f.forge(['integrate', f.id, '--strategy', 'merge', '--keep-conflicts']);
    assert.equal(r.status, 1);
    assert.deepEqual(r.out, { ok: false, behind: 1, strategy: 'merge', conflicts: ['README.md'], inProgress: true, regenerated });
    assert.deepEqual(f.unmerged(), ['README.md']);
    assert.equal(f.git('show', ':dist/out.txt'), f.git('show', 'main:dist/out.txt'), 'the generated path is staged from the base side');
  } finally {
    f.cleanup();
  }
});

test('continue rebuilds and carries on through generated-only picks', () => {
  const f = fixture();
  try {
    f.commit('branch', { 'src/b.txt': 'b\n', 'README.md': '# ours\n' }, 'branch');
    f.commit('base', { 'src/c.txt': 'c\n', 'README.md': '# theirs\n' }, 'base');
    assert.equal(f.forge(['integrate', f.id, '--strategy', 'merge', '--keep-conflicts']).out.inProgress, true);
    fs.writeFileSync(path.join(f.wt, 'README.md'), '# both\n');
    f.git('add', 'README.md');
    const r = f.forge(['integrate', f.id, '--continue']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.ok, true);
    assert.equal(r.out.strategy, 'merge');
    assert.ok(r.out.regenerated.includes('dist/out.txt'), JSON.stringify(r.out));
    assert.equal(f.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3, 'a merge commit');
    assertFreshBuild(f);
    assert.equal(f.git('status', '--porcelain'), '');
    const last = f.events().at(-1);
    assert.deepEqual([last.type, last.strategy, last.regenerated], ['integrated', 'merge', r.out.regenerated]);
  } finally {
    f.cleanup();
  }

  // Rebase: pick 1 is mixed, pick 2 conflicts only on generated paths; one --continue finishes both.
  const g = fixture();
  try {
    g.commit('branch', { 'src/b.txt': 'b\n', 'README.md': '# ours\n' }, 'branch 1');
    g.commit('branch', { 'src/d.txt': 'd\n' }, 'branch 2');
    g.commit('base', { 'src/c.txt': 'c\n', 'README.md': '# theirs\n' }, 'base');
    let r = g.forge(['integrate', g.id, '--strategy', 'rebase', '--keep-conflicts']);
    assert.deepEqual([r.out.ok, r.out.conflicts, r.out.inProgress], [false, ['README.md'], true]);
    assertRegenerated(r.out.regenerated);
    fs.writeFileSync(path.join(g.wt, 'README.md'), '# both\n');
    g.git('add', 'README.md');
    r = g.forge(['integrate', g.id, '--continue']);
    assert.equal(r.status, 0, `${r.stderr} ${JSON.stringify(r.out)}`);
    assert.equal(r.out.ok, true);
    assert.equal(r.out.rewritten, true);
    assert.ok(r.out.regenerated.includes('dist/out.txt'));
    assert.equal(g.inProgress('rebase-merge'), false);
    assert.equal(g.git('rev-list', '--count', 'main..HEAD').trim(), '2');
    assertFreshBuild(g);
    assert.equal(g.git('status', '--porcelain'), '');
  } finally {
    g.cleanup();
  }
});

test('a failing build falls back to today\'s behaviour', () => {
  const f = fixture({ config: { worktrees: { generatedBy: 'bad' } } });
  try {
    generatedOnly(f);
    const head = f.git('rev-parse', 'HEAD');
    const expected = probe(f, 'merge');
    let r = f.forge(['integrate', f.id, '--strategy', 'merge']);
    assert.equal(r.status, 1);
    assert.deepEqual(r.out.conflicts.sort(), expected, 'every unmerged path, generated ones included');
    assert.equal(r.out.inProgress, false);
    assert.equal(r.out.regenerated, undefined);
    assert.match(r.out.regenerateError, /^commands\.bad exited 3 \(log logs\/integrate-regenerate-.*\.log\)\n[\s\S]*BUILD-BROKE on purpose/);
    assert.equal(f.inProgress('MERGE_HEAD'), false, 'the merge is aborted');
    assert.equal(f.git('status', '--porcelain'), '', 'the build output is cleaned up');
    assert.equal(f.git('rev-parse', 'HEAD'), head);
    const ev = f.events().filter((e) => e.type === 'integrate-conflicts').at(-1);
    assert.equal(ev.regenerateError, r.out.regenerateError);

    r = f.forge(['integrate', f.id, '--strategy', 'merge', '--keep-conflicts']);
    assert.equal(r.status, 1);
    assert.deepEqual(r.out.conflicts.sort(), expected);
    assert.equal(r.out.inProgress, true);
    assert.deepEqual(f.unmerged().sort(), expected, 'the generated paths are still unmerged for the integrator');
    assert.match(fs.readFileSync(path.join(f.wt, 'dist', 'out.txt'), 'utf8'), /^<<<<<<< /m, 'with their conflict markers back');
    assert.equal(fs.existsSync(path.join(f.wt, 'dist', 'junk.txt')), false);

    // The integrator resolves it; the build still fails at --continue, so nothing is committed.
    f.git('add', '-A', 'dist');
    r = f.forge(['integrate', f.id, '--continue']);
    assert.equal(r.status, 1);
    assert.equal(r.out.ok, false);
    assert.deepEqual(r.out.conflicts, []);
    assert.equal(r.out.inProgress, true);
    assert.match(r.out.regenerateError, /BUILD-BROKE/);
    assert.equal(f.git('rev-parse', 'HEAD'), head, 'HEAD unchanged');
    assert.equal(f.inProgress('MERGE_HEAD'), true);
  } finally {
    f.cleanup();
  }
});

test('no regenerate command falls back', () => {
  const f = fixture({ edit: (t) => t.replace(/generatedBy: gen/, 'generatedBy: lint') });
  try {
    generatedOnly(f);
    const expected = probe(f, 'merge');
    const r = f.forge(['integrate', f.id, '--strategy', 'merge']);
    assert.equal(r.status, 1);
    assert.deepEqual(r.out.conflicts.sort(), expected);
    assert.match(r.out.regenerateError, /not configured/);
    assert.equal(f.inProgress('MERGE_HEAD'), false);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally {
    f.cleanup();
  }
});

test('a glob that matches nothing changes nothing', () => {
  const f = fixture({ edit: (t) => t.replace(/- dist\/\*\*/, '- nomatch/**').replace(/generated: \["dist\/\*\*"\]/, 'generated: ["nomatch/**"]') });
  try {
    assert.match(fs.readFileSync(path.join(f.repo.dir, '.forge', 'config.yml'), 'utf8'), /nomatch/);
    f.commit('branch', { 'README.md': '# ours\n' }, 'ours', { build: false });
    f.commit('base', { 'README.md': '# theirs\n' }, 'theirs', { build: false });
    let r = f.forge(['integrate', f.id, '--strategy', 'merge']);
    assert.deepEqual(r.out, { ok: false, behind: 1, strategy: 'merge', conflicts: ['README.md'], inProgress: false });
    r = f.forge(['integrate', f.id, '--strategy', 'merge', '--keep-conflicts']);
    assert.deepEqual(r.out, { ok: false, behind: 1, strategy: 'merge', conflicts: ['README.md'], inProgress: true });
    r = f.forge(['integrate', f.id, '--continue']);
    assert.deepEqual(r.out, { ok: false, strategy: 'merge', conflicts: ['README.md'], inProgress: true });
    fs.writeFileSync(path.join(f.wt, 'README.md'), '# both\n');
    f.git('add', 'README.md');
    r = f.forge(['integrate', f.id, '--continue']);
    assert.deepEqual(r.out, { ok: true, strategy: 'merge', rewritten: false });
    for (const e of f.events().filter((e) => e.type.startsWith('integrat'))) {
      assert.equal('regenerated' in e || 'regenerateError' in e, false, JSON.stringify(e));
    }
    assert.equal(genRuns(f), 0, 'the build never ran');
  } finally {
    f.cleanup();
  }
});

test('hostile conflicted paths are refused', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-regen-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-regen-out-')));
  try {
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    const hostile = ['-rf', '--output=x', '../x', '/etc/passwd', 'a/../../x', 'sub/.git/config', 'linked/out.txt', 'a/./b', 'dist//x', ''];
    const r = partitionConflicts(dir, [...hostile, 'dist/ok.txt'], ['**']);
    assert.deepEqual(r.generated, ['dist/ok.txt']);
    assert.deepEqual(r.other, hostile, 'refused paths stay in git\'s order');
    assert.deepEqual(partitionConflicts(dir, ['dist/ok.txt', 'src/x.ts'], ['dist/**']), { generated: ['dist/ok.txt'], other: ['src/x.ts'] });
    assert.deepEqual(partitionConflicts(dir, ['dist/ok.txt'], []), { generated: [], other: ['dist/ok.txt'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  // End to end: a conflicted `-n.txt` under glob `**` stays a conflict, never reaches git before `--`, and nothing builds.
  const f = fixture({ edit: (t) => t.replace(/- dist\/\*\*/, '- "**"').replace(/generated: \["dist\/\*\*"\]/, 'generated: ["**"]') });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gitlog-'));
  try {
    f.commit('branch', { '-n.txt': 'ours\n' }, 'ours', { build: false });
    f.commit('base', { '-n.txt': 'theirs\n' }, 'theirs', { build: false });
    const log = path.join(bin, 'argv.log');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> "${log}"; done\nprintf '\\n' >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const r = f.forge(['integrate', f.id, '--strategy', 'merge', '--keep-conflicts'], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 1);
    assert.deepEqual(r.out.conflicts, ['-n.txt']);
    assert.equal(r.out.regenerated, undefined);
    assert.deepEqual(f.unmerged(), ['-n.txt']);
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\x1f').slice(0, -1));
    assert.ok(calls.some((argv) => argv.includes('merge')), 'the wrapper saw forge\'s git calls');
    for (const argv of calls) {
      const at = argv.indexOf('-n.txt');
      if (at >= 0) assert.ok(argv.indexOf('--') >= 0 && argv.indexOf('--') < at, `-n.txt only after --: ${argv.join(' ')}`);
    }
    assert.equal(genRuns(f), 0, 'the build did not run');
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    f.cleanup();
  }
});

test('the regenerate guard refuses a worktree that is not the job\'s', () => {
  const repo = tempRepo();
  const wt = path.join(repo.dir, '..', `${path.basename(repo.dir)}-guard`);
  try {
    repo.git('worktree', 'add', '-q', '-b', 'feat', wt);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: wt, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true' } });
    fs.writeFileSync(path.join(wt, 'README.md'), '# feat\n');
    commitAll(wt, 'feat');
    fs.writeFileSync(path.join(repo.dir, 'README.md'), '# main\n');
    commitAll(repo.dir, 'main');
    const job = { id: 'j', worktree: wt, branch: 'feat' };
    const cases = (when: string) => {
      assert.equal(jobWorktreeProblem(repo.dir, job), null, `${when}: the job's own worktree on its branch`);
      assert.match(jobWorktreeProblem(repo.dir, { ...job, worktree: repo.dir }) ?? '', /main checkout/, `${when}: the main checkout`);
      const link = `${wt}-link`;
      fs.symlinkSync(repo.dir, link);
      try {
        assert.match(jobWorktreeProblem(repo.dir, { ...job, worktree: link }) ?? '', /main checkout/, `${when}: a link to the main checkout`);
      } finally {
        fs.rmSync(link);
      }
      fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
      assert.match(jobWorktreeProblem(repo.dir, { ...job, worktree: path.join(wt, 'sub') }) ?? '', /not the root of a git worktree/, `${when}: a subdirectory`);
      const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-plain-'));
      try {
        assert.match(jobWorktreeProblem(repo.dir, { ...job, worktree: plain }) ?? '', /not the root of a git worktree/, `${when}: not a repo`);
      } finally {
        fs.rmSync(plain, { recursive: true, force: true });
      }
      assert.match(jobWorktreeProblem(repo.dir, { ...job, branch: 'other' }) ?? '', /not the job's branch other/, `${when}: another branch`);
    };
    assert.throws(() => git('merge', 'main'));
    assert.ok(fs.existsSync(path.resolve(wt, git('rev-parse', '--git-path', 'MERGE_HEAD').trim())));
    cases('mid-merge');
    git('merge', '--abort');
    assert.throws(() => git('rebase', 'main'));
    assert.ok(fs.existsSync(path.resolve(wt, git('rev-parse', '--git-path', 'rebase-merge').trim())));
    cases('mid-rebase');
    git('rebase', '--abort');
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
    repo.cleanup();
  }
});
