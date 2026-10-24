// The machine index store: where it lives, name rules, root resolution, add and remove, a bad file
// refused and never rewritten, and the private modes. Every call passes `home` explicitly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { ForgeError } from '#core/errors.ts';
import { forgeHome, machinePaths } from '#core/paths.ts';
import { MACHINE_INDEX_VERSION } from '#core/job/schema.ts';
import { addProject, defaultProjectName, listProjects, removeProject, resolveProjectRoot } from './machine-index.ts';

const made: string[] = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const scratch = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mi-')));
  made.push(d);
  return d;
};
/** A not-yet-created index directory in a fresh scratch dir. */
const freshHome = (): string => path.join(scratch(), 'home');
const indexBytes = (home: string): string | null => (fs.existsSync(machinePaths(home).projects) ? fs.readFileSync(machinePaths(home).projects, 'utf8') : null);
const initialised = (): ReturnType<typeof tempRepo> => {
  const r = tempRepo();
  fs.mkdirSync(path.join(r.dir, '.forge'));
  fs.writeFileSync(path.join(r.dir, '.forge', 'config.yml'), 'project:\n  name: x\n');
  return r;
};
const codeOf = (fn: () => unknown): { code: string; exit: number; message: string } => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ForgeError, `a ForgeError, got ${String(e)}`);
    return { code: e.code, exit: e.exitCode, message: e.message };
  }
  assert.fail('expected a throw');
};

describe('forgeHome', () => {
  const rows: { name: string; env: NodeJS.ProcessEnv; want: string }[] = [
    { name: 'set', env: { FORGE_HOME: path.join(os.tmpdir(), 'fh') }, want: path.join(os.tmpdir(), 'fh') },
    { name: 'relative', env: { FORGE_HOME: 'rel/home' }, want: path.resolve('rel/home') },
    { name: 'empty', env: { FORGE_HOME: '' }, want: path.join(os.homedir(), '.forge') },
    { name: 'unset', env: {}, want: path.join(os.homedir(), '.forge') },
  ];
  for (const r of rows) it(r.name, () => assert.equal(forgeHome(r.env), r.want));
});

describe('defaultProjectName', () => {
  const rows: [string, string][] = [
    ['forge', 'forge'],
    ['My Repo!', 'my-repo-'],
    ['.hidden', 'hidden'],
    ['___', 'project'],
    ['-_.Web.App', 'web.app'],
    ['a'.repeat(70), 'a'.repeat(64)],
  ];
  for (const [base, want] of rows) it(JSON.stringify(base), () => assert.equal(defaultProjectName(path.join(os.tmpdir(), base)), want));
});

describe('resolveProjectRoot', () => {
  it('refuses a directory outside git (not_a_repo)', () => {
    const dir = scratch();
    assert.equal(codeOf(() => resolveProjectRoot(dir)).code, 'not_a_repo');
    assert.equal(codeOf(() => resolveProjectRoot(dir)).exit, 2);
  });
  it('refuses a path that does not exist (not_a_repo)', () => {
    assert.equal(codeOf(() => resolveProjectRoot(path.join(scratch(), 'gone'))).code, 'not_a_repo');
  });
  it('refuses a git repo without .forge/config.yml (not_initialized)', () => {
    const r = tempRepo();
    const e = codeOf(() => resolveProjectRoot(r.dir));
    assert.deepEqual([e.code, e.exit], ['not_initialized', 2]);
    r.cleanup();
  });
  it('the root itself, a subdirectory, a relative path and a linked worktree all resolve to the main checkout', () => {
    const r = initialised();
    const sub = path.join(r.dir, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    const wt = `${r.dir}.wt`;
    r.git('worktree', 'add', '-q', wt);
    assert.equal(resolveProjectRoot(r.dir), r.dir);
    assert.equal(resolveProjectRoot(sub), r.dir);
    assert.equal(resolveProjectRoot('..', sub), r.dir);
    assert.equal(resolveProjectRoot(wt), r.dir);
    r.cleanup();
    fs.rmSync(wt, { recursive: true, force: true });
  });
  it('a symlinked path is stored as its realpath', { skip: process.platform === 'win32' }, () => {
    const r = initialised();
    const link = path.join(scratch(), 'link');
    fs.symlinkSync(r.dir, link);
    assert.equal(resolveProjectRoot(link), r.dir);
    r.cleanup();
  });
});

describe('addProject', () => {
  it('derives the name from the basename and records name, path and addedAt only', () => {
    const home = freshHome();
    const root = path.join(scratch(), 'My Repo!');
    const r = addProject(home, root, { now: '2026-10-24T00:00:00.000Z' });
    assert.deepEqual(r, { added: true, project: { name: 'my-repo-', path: root, addedAt: '2026-10-24T00:00:00.000Z' } });
    assert.deepEqual(JSON.parse(indexBytes(home)!), { schemaVersion: MACHINE_INDEX_VERSION, projects: [r.project] });
  });
  it('--name overrides the default', () => {
    const home = freshHome();
    assert.equal(addProject(home, path.join(scratch(), 'x'), { name: 'web.app_2' }).project.name, 'web.app_2');
  });
  for (const name of ['../x', 'A', '-x', 'a'.repeat(65), '', 'a/b']) {
    it(`refuses --name ${JSON.stringify(name).slice(0, 20)} (usage) and creates nothing`, () => {
      const home = freshHome();
      const e = codeOf(() => addProject(home, path.join(scratch(), 'x'), { name }));
      assert.deepEqual([e.code, e.exit], ['usage', 2]);
      assert.equal(fs.existsSync(home), false);
    });
  }
  it('a name another path holds is refused (exit 1) naming both paths, and the file is unchanged', () => {
    const home = freshHome();
    const a = path.join(scratch(), 'forge');
    const b = path.join(scratch(), 'forge');
    addProject(home, a);
    const before = indexBytes(home);
    const e = codeOf(() => addProject(home, b));
    assert.equal(e.exit, 1);
    assert.ok(e.message.includes(a) && e.message.includes(b), e.message);
    assert.equal(indexBytes(home), before);
  });
  it('the same path again is added: false, even with another name, and the file is byte-for-byte unchanged', () => {
    const home = freshHome();
    const root = path.join(scratch(), 'forge');
    const first = addProject(home, root).project;
    const before = indexBytes(home);
    assert.deepEqual(addProject(home, root, { name: 'other' }), { added: false, project: first });
    assert.equal(indexBytes(home), before);
  });
  it('refuses a path with a newline', () => {
    const home = freshHome();
    assert.equal(codeOf(() => addProject(home, path.join(scratch(), 'a\nb'), { name: 'ab' })).exit, 1);
    assert.equal(fs.existsSync(home), false);
  });
});

describe('removeProject', () => {
  it('an unknown name or path is not_found and leaves the file unchanged', () => {
    const home = freshHome();
    addProject(home, path.join(scratch(), 'kept'));
    const before = indexBytes(home);
    for (const arg of ['nope', path.join(scratch(), 'nope'), './nope']) {
      const e = codeOf(() => removeProject(home, arg, scratch()));
      assert.deepEqual([e.code, e.exit], ['not_found', 1], arg);
    }
    assert.equal(indexBytes(home), before);
  });
  it('`.` from a registered repo subdirectory removes that project', () => {
    const home = freshHome();
    const r = initialised();
    const sub = path.join(r.dir, 'sub');
    fs.mkdirSync(sub);
    const other = addProject(home, path.join(scratch(), 'other')).project;
    const p = addProject(home, resolveProjectRoot(r.dir)).project;
    assert.deepEqual(removeProject(home, '.', sub), { removed: p });
    assert.deepEqual(listProjects(home).projects.map((x) => x.name), [other.name]);
    r.cleanup();
  });
  it('by name, and by a path that no longer exists', () => {
    const home = freshHome();
    const gone = path.join(scratch(), 'gone');
    const a = addProject(home, gone).project;
    const b = addProject(home, path.join(scratch(), 'byname')).project;
    assert.deepEqual(removeProject(home, 'byname'), { removed: b });
    assert.deepEqual(removeProject(home, gone), { removed: a });
    assert.deepEqual(listProjects(home).projects, []);
  });
});

describe('listProjects', () => {
  it('a missing index lists nothing and creates nothing', () => {
    const home = freshHome();
    assert.deepEqual(listProjects(home), { home, projects: [] });
    assert.equal(fs.existsSync(home), false);
  });
  it('sorts by name and reports ok, missing and not-initialized without writing', () => {
    const home = freshHome();
    const r = initialised();
    const bare = scratch();
    addProject(home, r.dir, { name: 'c-ok' });
    addProject(home, path.join(scratch(), 'gone'), { name: 'a-missing' });
    addProject(home, bare, { name: 'b-bare' });
    const before = indexBytes(home);
    assert.deepEqual(listProjects(home).projects.map((p) => [p.name, p.status]), [['a-missing', 'missing'], ['b-bare', 'not-initialized'], ['c-ok', 'ok']]);
    assert.equal(indexBytes(home), before);
    r.cleanup();
  });
  it('a file without schemaVersion reads as version 1', () => {
    const home = freshHome();
    fs.mkdirSync(home);
    const entry = { name: 'x', path: path.join(scratch(), 'x'), addedAt: 't' };
    fs.writeFileSync(machinePaths(home).projects, JSON.stringify({ projects: [entry] }));
    assert.deepEqual(listProjects(home).projects.map((p) => p.name), ['x']);
  });
});

describe('a bad index is refused and never rewritten', () => {
  const entry = { name: 'ok', path: path.join(os.tmpdir(), 'ok'), addedAt: '2026-10-24T00:00:00.000Z' };
  const index = (projects: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: MACHINE_INDEX_VERSION, projects, ...extra });
  const rows: { name: string; text: string }[] = [
    { name: 'not JSON', text: '{not json' },
    { name: 'an array', text: '[]' },
    { name: 'a non-array projects', text: index({}) },
    { name: 'a relative path', text: index([{ ...entry, path: 'rel/x' }]) },
    { name: 'a path with a newline', text: index([{ ...entry, path: `${entry.path}\nx` }]) },
    { name: 'a path with a NUL', text: index([{ ...entry, path: `${entry.path}\0x` }]) },
    { name: 'a bad name', text: index([{ ...entry, name: 'A/b' }]) },
    { name: 'a non-string addedAt', text: index([{ ...entry, addedAt: 5 }]) },
    { name: 'an extra entry key', text: index([{ ...entry, token: 'x' }]) },
    { name: 'two entries with one name', text: index([entry, { ...entry, path: `${entry.path}2` }]) },
    { name: 'a newer schemaVersion', text: JSON.stringify({ schemaVersion: MACHINE_INDEX_VERSION + 1, projects: [] }) },
  ];
  for (const r of rows) {
    it(r.name, () => {
      const home = freshHome();
      fs.mkdirSync(home);
      const file = machinePaths(home).projects;
      fs.writeFileSync(file, r.text);
      for (const call of [() => listProjects(home), () => addProject(home, path.join(scratch(), 'new')), () => removeProject(home, 'ok')]) {
        const e = codeOf(call);
        assert.equal(e.exit, 1);
        assert.ok(e.message.includes(file), e.message);
      }
      assert.equal(fs.readFileSync(file, 'utf8'), r.text);
    });
  }
  it('a symlink at projects.json', { skip: process.platform === 'win32' }, () => {
    const home = freshHome();
    fs.mkdirSync(home);
    const target = path.join(scratch(), 'elsewhere.json');
    fs.writeFileSync(target, index([entry]));
    fs.symlinkSync(target, machinePaths(home).projects);
    for (const call of [() => listProjects(home), () => addProject(home, path.join(scratch(), 'new'))]) assert.ok(codeOf(call).message.includes(machinePaths(home).projects));
    assert.equal(fs.readFileSync(target, 'utf8'), index([entry]));
    assert.ok(fs.lstatSync(machinePaths(home).projects).isSymbolicLink());
  });
});

it('creates the index private', { skip: process.platform === 'win32' }, () => {
  const home = freshHome();
  addProject(home, path.join(scratch(), 'x'));
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(machinePaths(home).projects).mode & 0o777, 0o600);
});
