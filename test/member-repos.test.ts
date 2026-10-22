// Member repos (config schemaVersion 11): `repos` in config.yml, clone paths in .forge/local.yml,
// and the doctor checks that read them without writing anything in a member clone.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo, scratchGitConfig } from './helpers.ts';
import { defaults, loadConfig, validateConfig } from '../lib/core/config/load.ts';
import { CONFIG_SCHEMA_VERSION } from '../lib/core/job/schema.ts';
import { doctor } from '../lib/doctor.ts';
import { initWrite, migrate } from '../lib/commands/init.ts';
import { memberRepoChecks, readLocalConfig, remotesMatch, repoProblems, resolveMemberPath, sameDir, shellWord } from '../lib/member-repos.ts';
import { deepMerge } from '../lib/core/shape.ts';
import * as yaml from '../lib/core/format/yaml.ts';

const A = 'git@github.com:acme/a.git';
const B = 'https://github.com/acme/b.git';

/** A config with no gh-backed checks, plus `extra` merged over it. */
function cfg(extra: Record<string, any> = {}): any {
  const c = deepMerge(defaults(), { tracker: { kind: 'none' }, pr: { enabled: false } });
  return { ...c, ...extra };
}

const scratch = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-members-')));

/** A git clone at `dir` on main with one commit and `origin` set to `remote` (null: no origin). */
function clone(dir: string, remote: string | null): (...args: string[]) => string {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  scratchGitConfig(git);
  fs.writeFileSync(path.join(dir, 'README.md'), '# member\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  if (remote) git('remote', 'add', 'origin', remote);
  return git;
}

function writeLocal(root: string, text: string): void {
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'local.yml'), text);
}

const member = (name: string, remote: string, defaultBranch = 'main') => ({ name, remote, defaultBranch });
const byName = (checks: { name: string }[], name: string) => checks.find((c) => c.name === name) as any;

/** One root repo plus a scratch parent for member clones, cleaned up together. */
function project() {
  const root = tempRepo();
  const parent = scratch();
  return { root: root.dir, parent, cleanup: () => (root.cleanup(), fs.rmSync(parent, { recursive: true, force: true })) };
}

describe('member repos config', { concurrency: 4 }, () => {
  test('a v10 config loads and migrates with empty repos', () => {
    assert.deepEqual(defaults().repos, []);
    const r = tempRepo();
    try {
      fs.mkdirSync(path.join(r.dir, '.forge'));
      const file = path.join(r.dir, '.forge', 'config.yml');
      fs.writeFileSync(file, 'schemaVersion: 10\ntracker:\n  kind: none\n'); // old-version fixture
      const loaded = loadConfig(r.dir);
      assert.equal(loaded.migratedFrom, 10);
      assert.deepEqual(loaded.config.repos, []);
      assert.equal(loaded.config.schemaVersion, CONFIG_SCHEMA_VERSION);
      assert.deepEqual(validateConfig(loaded.config, r.dir), []);
      migrate(r.dir);
      const onDisk = yaml.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(onDisk.schemaVersion, CONFIG_SCHEMA_VERSION);
      assert.deepEqual(onDisk.repos, []);
    } finally {
      r.cleanup();
    }
  });

  test('repos validation reports every bad entry', () => {
    const root = '/x/app';
    const good = [
      member('ui-kit', 'git@github.com:acme/ui-kit.git'),
      { ...member('docs.site', 'https://example.com/docs', 'release/1.x'), tracker: { kind: 'github', repo: 'acme/docs' } },
    ];
    assert.deepEqual(repoProblems({ repos: good }, root), []);
    assert.deepEqual(repoProblems({}, root), [], 'absent is the empty list');
    assert.deepEqual(repoProblems({ repos: { a: 1 } }, root), ['repos must be a list (got {"a":1})']);
    const cases: [any, RegExp][] = [
      ['str', /^repos\[0\] must be a map$/],
      [member('', A), /^repos\[0\]\.name must start with a letter or digit/],
      [member('-x', A), /^repos\[0\]\.name must/],
      [member('a/b', A), /^repos\[0\]\.name must/],
      [member('x'.repeat(101), A), /^repos\[0\]\.name must/],
      [member('app', A), /^repos "app" is the root repo; the root repo is implicit$/],
      [member('m', ''), /^repos "m"\.remote must be a git url/],
      [member('m', 42 as any), /^repos "m"\.remote must/],
      [member('m', '-uhttps://x'), /^repos "m"\.remote must/],
      [member('m', 'https://x/a b'), /^repos "m"\.remote must/],
      [member('m', 'https://x/a\u0007'), /^repos "m"\.remote must/],
      [member('m', 'h'.repeat(2001)), /^repos "m"\.remote must/],
      [member('m', A, '-main'), /^repos "m"\.defaultBranch must/],
      [member('m', A, 'a..b'), /^repos "m"\.defaultBranch must/],
      [member('m', A, 'a//b'), /^repos "m"\.defaultBranch must/],
      [member('m', A, 'a/'), /^repos "m"\.defaultBranch must/],
      [member('m', A, 'main.lock'), /^repos "m"\.defaultBranch must/],
      [{ name: 'm', remote: A }, /^repos "m"\.defaultBranch must/],
      [{ ...member('m', A), tracker: 'github' }, /^repos "m"\.tracker must be a map with kind github \| none/],
      [{ ...member('m', A), tracker: { kind: 'jira' } }, /^repos "m"\.tracker must/],
      [{ ...member('m', A), tracker: { kind: 'github', repo: 'acme' } }, /^repos "m"\.tracker\.repo must be owner\/name/],
      [{ ...member('m', A), tracker: { kind: 'github', repo: 'acme/a..b' } }, /^repos "m"\.tracker\.repo must/],
      [{ ...member('m', A), tracker: { kind: 'github', repo: 'a/b/c' } }, /^repos "m"\.tracker\.repo must/],
    ];
    for (const [entry, re] of cases) {
      const problems = repoProblems({ repos: [entry] }, root);
      assert.equal(problems.length, 1, `${JSON.stringify(entry)?.slice(0, 80)}: ${problems.join(' | ')}`);
      assert.match(problems[0], re);
    }
    assert.deepEqual(repoProblems({ repos: [member('m', A), member('m', B)] }, root), ['repos "m" is listed more than once']);
    for (const t of [null, undefined, { kind: 'none' }, { kind: 'github' }, { kind: 'github', repo: null }])
      assert.deepEqual(repoProblems({ repos: [{ ...member('m', A), tracker: t }] }, root), [], JSON.stringify(t));
    // Through validateConfig, as forge config validate and doctor see it.
    const all = validateConfig(cfg({ repos: [member('m', '')] }), process.cwd());
    assert.ok(all.some((p) => p.startsWith('repos "m".remote must')), all.join('\n'));
  });

  test('component repo must name a member repo', () => {
    const root = '/x/app';
    const comp = (repo: unknown) => ({ name: 'web', path: 'web', kind: 'app', ...(repo === undefined ? {} : { repo }) });
    const repos = [member('ui-kit', A)];
    assert.deepEqual(repoProblems({ repos, components: [comp('ui-kit')] }, root), []);
    assert.deepEqual(repoProblems({ repos, components: [comp(null), comp(undefined)] }, root), []);
    assert.deepEqual(repoProblems({ repos, components: [comp('other')] }, root), ['components "web".repo names unknown repo "other"']);
    assert.deepEqual(repoProblems({ components: [comp('ui-kit')] }, root), ['components "web".repo names unknown repo "ui-kit"']);
    const problems = validateConfig(cfg({ repos, components: [comp('other')] }), process.cwd());
    assert.ok(problems.includes('components "web".repo names unknown repo "other"'), problems.join('\n'));
  });

  test('init ignores local.yml without clobbering', () => {
    const r = tempRepo();
    try {
      const answers = () => ({ tracker: { kind: 'none' }, pr: { enabled: false } });
      const first = initWrite(r.dir, answers(), false);
      assert.ok(first.written.includes(path.join('.forge', '.gitignore')));
      const ignore = path.join(r.dir, '.forge', '.gitignore');
      assert.match(fs.readFileSync(ignore, 'utf8'), /^local\.yml$/m);
      execFileSync('git', ['check-ignore', '-q', '.forge/local.yml'], { cwd: r.dir });

      fs.writeFileSync(ignore, 'jobs/\nlocks/');
      const second = initWrite(r.dir, answers(), false);
      assert.ok(second.written.includes(path.join('.forge', '.gitignore')));
      const after = fs.readFileSync(ignore, 'utf8');
      assert.ok(after.startsWith('jobs/\nlocks/\n'), after);
      assert.equal(after.match(/^local\.yml$/gm)?.length, 1);
      execFileSync('git', ['check-ignore', '-q', '.forge/local.yml'], { cwd: r.dir });

      const third = initWrite(r.dir, answers(), false);
      assert.equal(third.written.includes(path.join('.forge', '.gitignore')), false);
      assert.equal(fs.readFileSync(ignore, 'utf8'), after);
    } finally {
      r.cleanup();
    }
  });
});

describe('member repo doctor checks', { concurrency: 4 }, () => {
  test('doctor passes a project with two member repos', async () => {
    const p = project();
    try {
      clone(path.join(p.parent, 'a'), A);
      clone(path.join(p.parent, 'b'), B);
      writeLocal(p.root, `repos:\n  a: { path: ${path.join(p.parent, 'a')} }\n  b:\n    path: ${path.join(p.parent, 'b')}\n`);
      const report = await doctor(p.root, cfg({ repos: [member('a', A), member('b', B)] }), true);
      const names = report.checks.map((c) => c.name);
      const valid = byName(report.checks, 'config valid');
      assert.equal(valid.ok, true, valid.detail);
      assert.equal(byName(report.checks, 'local.yml'), undefined);
      for (const n of ['repo a', 'repo b']) {
        const c = byName(report.checks, n);
        assert.equal(c.ok, true, c.detail);
        assert.equal(c.warn, undefined, c.detail);
        assert.match(c.detail, / on main$/);
        assert.ok(names.indexOf(n) > names.indexOf('config valid'), `${n} after config valid`);
      }
      assert.ok(names.indexOf('repo a') < names.indexOf('repo b'), 'config order');
    } finally {
      p.cleanup();
    }
  });

  test('a missing clone is reported with the fix', () => {
    const p = project();
    try {
      writeLocal(p.root, `repos:\n  b: { path: ${path.join(p.parent, 'gone dir')} }\n`);
      const checks = memberRepoChecks(p.root, cfg({ repos: [member('a', A), member('b', B)] }));
      const a = byName(checks, 'repo a');
      assert.equal(a.ok, false);
      assert.ok(a.detail.includes(`git clone ${A} ../a`), a.detail);
      assert.ok(a.detail.includes('.forge/local.yml: repos: { a: { path: ../a } }'), a.detail);
      const b = byName(checks, 'repo b');
      assert.equal(b.ok, false);
      const quoted = `'${path.join(p.parent, 'gone dir')}'`;
      assert.equal(b.detail, `missing clone at ${quoted}; run: git clone ${B} ${quoted}`);
      // No local.yml at all: every member reads as having no entry.
      fs.rmSync(path.join(p.root, '.forge', 'local.yml'));
      const none = memberRepoChecks(p.root, cfg({ repos: [member('a', A)] }));
      assert.deepEqual(none.map((c) => c.name), ['repo a']);
      assert.match(none[0].detail, /^no path in \.forge\/local\.yml/);
    } finally {
      p.cleanup();
    }
  });

  test("a path that is not a clone's top level fails", () => {
    const p = project();
    try {
      fs.mkdirSync(path.join(p.parent, 'plain'));
      clone(path.join(p.parent, 'other'), A);
      fs.mkdirSync(path.join(p.parent, 'other', 'sub'));
      fs.mkdirSync(path.join(p.root, 'sub'));
      fs.writeFileSync(path.join(p.parent, 'file'), 'x');
      const cases = [path.join(p.parent, 'plain'), path.join(p.parent, 'other', 'sub'), 'sub', path.join(p.parent, 'file')];
      for (const dir of cases) {
        writeLocal(p.root, `repos:\n  a: { path: ${dir} }\n`);
        const [c] = memberRepoChecks(p.root, cfg({ repos: [member('a', A)] }));
        assert.equal(c.ok, false, dir);
        assert.match(c.detail, / is not a git clone; point \.forge\/local\.yml at the clone's top-level directory$/, dir);
      }
    } finally {
      p.cleanup();
    }
  });

  test('the top-level check matches the clone however git spells its path', () => {
    const p = project();
    try {
      const dir = path.join(p.parent, 'spelled');
      fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
      // A junction needs no privilege on Windows; posix ignores the type.
      fs.symlinkSync(dir, path.join(p.parent, 'link'), 'junction');
      // git on Windows prints C:/Users/... with forward slashes; on posix the form is unchanged.
      assert.equal(sameDir(dir.replaceAll('\\', '/'), dir), true);
      assert.equal(sameDir(path.join(dir, 'sub', '..'), dir), true);
      assert.equal(sameDir(path.join(p.parent, 'link'), dir), true);
      assert.equal(sameDir(path.join(dir, 'sub'), dir), false);
      assert.equal(sameDir(path.join(p.parent, 'missing'), dir), false);
      if (process.platform === 'win32') assert.equal(sameDir(dir.toUpperCase(), dir.toLowerCase()), true);
    } finally {
      p.cleanup();
    }
  });

  test('remote mismatch fails and equivalent urls match', () => {
    for (const [x, y] of [
      ['git@github.com:acme/x.git', 'https://github.com/acme/x'],
      ['https://github.com/acme/x.git', 'https://github.com/acme/x/'],
      ['https://github.com/Acme/X', 'ssh://git@github.com/acme/x.git'],
      ['/srv/git/x.git', '/srv/git/x'],
      ['https://example.com/x/', 'https://example.com/x'],
    ])
      assert.ok(remotesMatch(x, y), `${x} = ${y}`);
    for (const [x, y] of [
      ['git@github.com:acme/x.git', 'git@github.com:acme/y.git'],
      ['https://example.com/acme/x', 'https://github.com/acme/x'],
    ])
      assert.ok(!remotesMatch(x, y), `${x} != ${y}`);

    const p = project();
    try {
      const dir = path.join(p.parent, 'a');
      const git = clone(dir, 'https://github.com/acme/wrong');
      writeLocal(p.root, `repos:\n  a: { path: ${dir} }\n`);
      const check = () => memberRepoChecks(p.root, cfg({ repos: [member('a', A)] }))[0] as any;
      let c = check();
      assert.equal(c.ok, false);
      assert.equal(c.detail, `remote "origin" is https://github.com/acme/wrong, expected ${A}; run: git -C ${shellWord(dir)} remote set-url origin ${A}`);
      // A Windows path has backslashes, which shellWord quotes, so the expected details here go through it too.
      assert.equal(shellWord('C:\\x\\a'), "'C:\\x\\a'");
      git('remote', 'remove', 'origin');
      c = check();
      assert.equal(c.ok, false);
      assert.equal(c.detail, `remote "origin" is missing, expected ${A}; run: git -C ${shellWord(dir)} remote add origin ${A}`);
      git('remote', 'add', 'origin', 'https://github.com/acme/a');
      c = check();
      assert.equal(c.ok, true, c.detail);
    } finally {
      p.cleanup();
    }
  });

  test('a credentialed remote never shows its secret', () => {
    // Built at runtime so no literal credential sits in the source.
    const secret = crypto.randomBytes(12).toString('hex');
    const want = 'https://git.example.com/acme/x.git';
    const userinfo = [`user:${secret}`, secret];
    for (const info of userinfo) assert.ok(remotesMatch(`https://${info}@git.example.com/acme/x`, want), info);
    const p = project();
    try {
      const dir = path.join(p.parent, 'x');
      const git = clone(dir, `https://user:${secret}@git.example.com/acme/other.git`);
      writeLocal(p.root, `repos:\n  x: { path: ${dir} }\n`);
      const check = () => memberRepoChecks(p.root, cfg({ repos: [member('x', want)] }))[0] as any;
      let c = check();
      assert.equal(c.ok, false);
      assert.ok(!c.detail.includes(secret), c.detail);
      assert.equal(c.detail, `remote "origin" is https://git.example.com/acme/other.git, expected ${want}; run: git -C ${shellWord(dir)} remote set-url origin ${want}`);
      git('remote', 'set-url', 'origin', `https://${secret}@git.example.com/acme/other.git`);
      c = check();
      assert.ok(!c.detail.includes(secret), c.detail);
      // The right repo behind credentials is not a mismatch.
      git('remote', 'set-url', 'origin', `https://user:${secret}@git.example.com/acme/x.git`);
      c = check();
      assert.equal(c.ok, true, c.detail);
      assert.ok(!c.detail.includes(secret), c.detail);
    } finally {
      p.cleanup();
    }
  });

  test('member names that are Object.prototype keys do not crash', () => {
    const p = project();
    try {
      const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];
      const config = cfg({ repos: names.map((n) => member(n, A)) });
      assert.deepEqual(repoProblems(config, p.root), []);
      const none = memberRepoChecks(p.root, config);
      assert.deepEqual(none.map((c) => [c.name, c.ok]), names.map((n) => [`repo ${n}`, false]));
      for (const c of none) assert.match(c.detail as string, /^no path in \.forge\/local\.yml/);
      const dir = path.join(p.parent, 'constructor');
      clone(dir, A);
      writeLocal(p.root, `repos:\n  constructor: { path: ${dir} }\n`);
      const checks = memberRepoChecks(p.root, config);
      assert.equal(byName(checks, 'repo constructor').ok, true, byName(checks, 'repo constructor').detail);
      assert.match(byName(checks, 'repo toString').detail, /^no path in/);
      assert.equal(Object.getPrototypeOf(readLocalConfig(p.root).repos), null);
    } finally {
      p.cleanup();
    }
  });

  test('dirty default branch warns', () => {
    const p = project();
    try {
      const dir = path.join(p.parent, 'a');
      const git = clone(dir, A);
      writeLocal(p.root, `repos:\n  a: { path: ${dir} }\n`);
      const check = (branch = 'main') => memberRepoChecks(p.root, cfg({ repos: [member('a', A, branch)] }))[0] as any;
      fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
      fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
      let c = check();
      assert.deepEqual([c.ok, c.warn], [true, true]);
      assert.equal(c.detail, `main has uncommitted changes (2 paths) at ${shellWord(dir)}`);
      git('checkout', '-q', '-b', 'feature');
      c = check();
      assert.equal(c.ok, true);
      assert.equal(c.warn, undefined);
      assert.equal(c.detail, `${shellWord(dir)} on feature`);
      c = check('develop');
      assert.deepEqual([c.ok, c.warn], [true, true]);
      assert.equal(c.detail, `no local branch develop; run: git -C ${shellWord(dir)} fetch origin develop:develop`);
      git('checkout', '-q', '--detach');
      c = check();
      assert.equal(c.detail, `${shellWord(dir)} on detached`);
    } finally {
      p.cleanup();
    }
  });

  test('local.yml problems are reported', () => {
    const p = project();
    try {
      const config = cfg({ repos: [member('a', A)] });
      const dir = path.join(p.parent, 'a');
      clone(dir, A);
      for (const [text, re] of [
        ['repos: [unclosed', /^local\.yml is not valid YAML: /],
        ['repos:\n  a: {}\n', /^local\.yml repos "a" needs a non-empty string path/],
        ['repos:\n  a: { path: 3 }\n', /needs a non-empty string path/],
        ['repos:\n  a: ../a\n', /needs a non-empty string path/],
        ['repos: [a]\n', /^local\.yml repos must be a map/],
        ['- a\n', /^local\.yml must be a map/],
      ] as [string, RegExp][]) {
        writeLocal(p.root, text);
        const checks = memberRepoChecks(p.root, config);
        const local = byName(checks, 'local.yml');
        assert.equal(local?.ok, false, text);
        assert.match(local.detail, re, text);
        assert.equal(byName(checks, 'repo a').ok, false, `${text}: member reads as missing`);
        assert.match(byName(checks, 'repo a').detail, /^no path in/);
      }
      writeLocal(p.root, `repos:\n  a: { path: ${dir} }\n  zed: { path: ../zed }\n`);
      let checks = memberRepoChecks(p.root, config);
      assert.deepEqual(byName(checks, 'local.yml'), { name: 'local.yml', ok: true, warn: true, detail: 'names not in repos: "zed"' });
      assert.equal(byName(checks, 'repo a').ok, true);
      // Relative paths resolve against the root repo.
      writeLocal(p.root, `repos:\n  a: { path: ${path.relative(p.root, dir)} }\n`);
      checks = memberRepoChecks(p.root, config);
      assert.deepEqual(checks.map((c) => c.name), ['repo a']);
      assert.equal(checks[0].ok, true, checks[0].detail);
      assert.equal(readLocalConfig(p.root).repos.a.path, path.relative(p.root, dir));
      assert.equal(resolveMemberPath(p.root, '~/x'), path.join(os.homedir(), 'x'));
      assert.equal(resolveMemberPath(p.root, '../x'), path.resolve(p.root, '../x'));
      assert.equal(resolveMemberPath(p.root, '/abs/x'), '/abs/x');
      // Anything but a regular file in its place is refused rather than read: a directory on every
      // platform, and a FIFO where the OS has them (Windows has none; MSYS mkfifo makes nothing Node sees).
      const localFile = path.join(p.root, '.forge', 'local.yml');
      fs.rmSync(localFile);
      fs.mkdirSync(localFile);
      assert.match(byName(memberRepoChecks(p.root, config), 'local.yml')?.detail, /not a regular file/);
      if (process.platform !== 'win32') {
        fs.rmSync(localFile, { recursive: true });
        execFileSync('mkfifo', [localFile]);
        assert.match(byName(memberRepoChecks(p.root, config), 'local.yml')?.detail, /not a regular file/);
      }
    } finally {
      p.cleanup();
    }
  });

  test('doctor writes nothing in member clones', async () => {
    const p = project();
    try {
      const a = path.join(p.parent, 'a');
      const b = path.join(p.parent, 'b');
      clone(a, A);
      clone(b, B);
      fs.writeFileSync(path.join(b, 'README.md'), 'dirty\n');
      fs.writeFileSync(path.join(b, 'untracked.txt'), 'u\n');
      // A stale index stat makes a plain `git status` want to refresh and rewrite the index.
      const old = new Date(Date.now() - 3600_000);
      fs.utimesSync(path.join(a, 'README.md'), old, old);
      writeLocal(p.root, `repos:\n  a: { path: ${a} }\n  b: { path: ${b} }\n`);
      const snap = (dir: string) => {
        const out: Record<string, [number, number, string]> = {};
        for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
          const full = path.join(dir, rel);
          const st = fs.lstatSync(full);
          out[rel] = [st.size, st.mtimeMs, st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : ''];
        }
        return out;
      };
      const before = { a: snap(a), b: snap(b), parent: fs.readdirSync(p.parent).sort() };
      const report = await doctor(p.root, cfg({ repos: [member('a', A), member('b', B)] }), true);
      assert.equal(byName(report.checks, 'repo a').ok, true);
      assert.equal(byName(report.checks, 'repo b').warn, true);
      assert.deepEqual({ a: snap(a), b: snap(b), parent: fs.readdirSync(p.parent).sort() }, before);
    } finally {
      p.cleanup();
    }
  });

  test('one-repo projects get no member checks', async () => {
    const p = project();
    try {
      const report = await doctor(p.root, cfg(), true);
      assert.deepEqual(report.checks.filter((c) => c.name === 'local.yml' || c.name.startsWith('repo ')), []);
    } finally {
      p.cleanup();
    }
  });
});
