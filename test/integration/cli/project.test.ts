// `forge project add|remove|list` through the real CLI: it writes only the machine index
// (FORGE_HOME), never inside a project or the developer's home, copies nothing out of a project's
// config, is refused in daemon sessions, and is routed before the repo is resolved.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { BIN, cliEnv, repoTemplate, tempRepo, type CliResult } from '../../helpers.ts';

const initialised = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { build: 'true', test: 'true', lint: 'true' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

const made: string[] = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (prefix = 'forge-proj-'): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
};

/** The CLI in `cwd`, FORGE_ROOT pinned to `root` (undefined: unset), with `env` on top (undefined deletes). */
function cli(args: string[], opts: { cwd: string; root?: string; env?: NodeJS.ProcessEnv }): Promise<CliResult> {
  const env = cliEnv(opts.root ?? '', { ...(opts.root === undefined ? { FORGE_ROOT: undefined } : {}), ...opts.env });
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: opts.cwd, env, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (err as any).code : 0;
      resolve({ status: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}

const json = (r: CliResult): any => {
  assert.ok(r.stdout.trim(), `no stdout (exit ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
};

/** Every path under `dir` with each file's size: what a write anywhere inside would change. */
function listing(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((rel) => {
      const st = fs.lstatSync(path.join(dir, rel));
      return st.isFile() ? `${rel} ${st.size}` : rel;
    })
    .sort();
}

describe('forge project', { concurrency: 4 }, () => {
  it('add, list and remove two projects, writing only FORGE_HOME', async () => {
    const home = path.join(tmp(), 'home');
    const userHome = tmp('forge-user-');
    const a = initialised();
    const b = initialised();
    fs.mkdirSync(path.join(a.dir, '.forge', 'runtime'), { recursive: true });
    const before = [listing(a.dir), listing(b.dir)];
    const env = { FORGE_HOME: home, HOME: userHome, USERPROFILE: userHome };
    const addA = await cli(['project', 'add'], { cwd: a.dir, root: a.dir, env });
    assert.equal(addA.status, 0, addA.stderr);
    assert.equal(json(addA).added, true);
    const addB = await cli(['project', 'add', b.dir], { cwd: userHome, env });
    assert.equal(addB.status, 0, addB.stderr);
    const list = json(await cli(['project', 'list'], { cwd: userHome, env }));
    assert.equal(list.home, home);
    const want = [a.dir, b.dir].map((d) => ({ name: path.basename(d).toLowerCase(), path: fs.realpathSync(d), status: 'ok' })).sort((x, y) => (x.name < y.name ? -1 : 1));
    assert.deepEqual(list.projects.map(({ name, path: p, status }: any) => ({ name, path: p, status })), want);
    const nameA = path.basename(a.dir).toLowerCase();
    const removed = await cli(['project', 'remove', nameA], { cwd: userHome, env });
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(json(removed).removed.path, a.dir);
    assert.deepEqual(json(await cli(['project', 'list'], { cwd: userHome, env })).projects.map((p: any) => p.path), [b.dir]);
    assert.deepEqual(fs.readdirSync(userHome), []);
    assert.deepEqual([listing(a.dir), listing(b.dir)], before);
    a.cleanup();
    b.cleanup();
  });

  it('a deleted project is listed as missing and removed by path', async () => {
    const home = path.join(tmp(), 'home');
    const a = initialised();
    const env = { FORGE_HOME: home };
    assert.equal((await cli(['project', 'add', a.dir], { cwd: os.tmpdir(), env })).status, 0);
    a.cleanup();
    const list = json(await cli(['project', 'list'], { cwd: os.tmpdir(), env }));
    assert.deepEqual(list.projects.map((p: any) => [p.path, p.status]), [[a.dir, 'missing']]);
    assert.ok(fs.readFileSync(path.join(home, 'projects.json'), 'utf8').includes(JSON.stringify(a.dir)), 'still in the file');
    const removed = await cli(['project', 'remove', a.dir], { cwd: os.tmpdir(), env });
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(json(await cli(['project', 'list'], { cwd: os.tmpdir(), env })).projects, []);
  });

  it('the index holds no project config, command or secret', async () => {
    const home = path.join(tmp(), 'home');
    const r = tempRepo();
    fs.mkdirSync(path.join(r.dir, '.forge'));
    fs.writeFileSync(path.join(r.dir, '.forge', 'config.yml'), 'project:\n  name: cfg-name-marker\ncommands:\n  test: echo cmd-marker\n');
    // Built at runtime so the commit scanner never sees a token-shaped literal.
    const token = ['ghp', '_', 'Zx9'.repeat(12)].join('');
    fs.writeFileSync(path.join(r.dir, '.forge', 'local.yml'), `token: ${token}\n`);
    const add = await cli(['project', 'add', r.dir], { cwd: os.tmpdir(), env: { FORGE_HOME: home } });
    assert.equal(add.status, 0, add.stderr);
    const bytes = fs.readFileSync(path.join(home, 'projects.json'), 'utf8');
    for (const marker of ['cfg-name-marker', 'cmd-marker', token]) assert.ok(!bytes.includes(marker), marker);
    const index = JSON.parse(bytes);
    for (const p of index.projects) assert.deepEqual(Object.keys(p).sort(), ['addedAt', 'name', 'path']);
    assert.equal(index.projects[0].name, path.basename(r.dir).toLowerCase());
    r.cleanup();
  });

  it('defaults to ~/.forge', async () => {
    const userHome = tmp('forge-user-');
    const a = initialised();
    const add = await cli(['project', 'add', a.dir], { cwd: userHome, env: { FORGE_HOME: '', HOME: userHome, USERPROFILE: userHome } });
    assert.equal(add.status, 0, add.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(userHome, '.forge', 'projects.json'), 'utf8')).projects[0].path, a.dir);
    a.cleanup();
  });

  it('a daemon session cannot add or remove', async () => {
    const parent = tmp();
    const absent = path.join(parent, 'absent');
    const a = initialised();
    const refusedAdd = await cli(['project', 'add', a.dir, '--json'], { cwd: parent, env: { FORGE_HOME: absent, FORGE_DAEMON: '1' } });
    assert.equal(refusedAdd.status, 1);
    assert.equal(fs.existsSync(absent), false);
    const home = path.join(parent, 'home');
    assert.equal((await cli(['project', 'add', a.dir], { cwd: parent, env: { FORGE_HOME: home } })).status, 0);
    const before = listing(home).concat(fs.readFileSync(path.join(home, 'projects.json'), 'utf8'));
    const daemon = { FORGE_HOME: home, FORGE_DAEMON: '1' };
    assert.equal((await cli(['project', 'remove', a.dir], { cwd: parent, env: daemon })).status, 1);
    assert.equal((await cli(['project', 'add', path.join(a.dir, '..')], { cwd: parent, env: daemon })).status, 1);
    assert.deepEqual(listing(home).concat(fs.readFileSync(path.join(home, 'projects.json'), 'utf8')), before);
    const list = await cli(['project', 'list'], { cwd: parent, env: daemon });
    assert.equal(list.status, 0, list.stderr);
    assert.equal(json(list).projects.length, 1);
    a.cleanup();
  });

  it('concurrent adds keep both', async () => {
    const home = path.join(tmp(), 'home');
    const repos = [initialised(), initialised(), initialised()];
    const results = await Promise.all(repos.map((r) => cli(['project', 'add', r.dir], { cwd: os.tmpdir(), env: { FORGE_HOME: home } })));
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const listed = json(await cli(['project', 'list'], { cwd: os.tmpdir(), env: { FORGE_HOME: home } })).projects.map((p: any) => p.path).sort();
    assert.deepEqual(listed, repos.map((r) => r.dir).sort());
    for (const r of repos) r.cleanup();
  });

  it('help, usage and list outside a repo', async () => {
    const outside = tmp();
    const env = { FORGE_HOME: path.join(outside, 'home') };
    for (const args of [['project', '--help'], ['help', 'project']]) {
      const r = await cli(args, { cwd: outside, env });
      assert.equal(r.status, 0, r.stderr);
      for (const sub of ['project add', 'project list', 'project remove']) assert.ok(r.stdout.includes(sub), `${args.join(' ')}: ${sub}`);
    }
    const bare = await cli(['project', '--json'], { cwd: outside, env });
    assert.equal(bare.status, 2);
    assert.equal(json(bare).error.code, 'usage');
    assert.ok(json(bare).error.message.includes('forge project add|list|remove'), json(bare).error.message);
    const unknown = await cli(['project', 'bogus', '--json'], { cwd: outside, env });
    assert.equal(unknown.status, 2);
    assert.equal(json(unknown).error.code, 'usage');
    const badName = await cli(['project', 'add', outside, '--name', '../x', '--json'], { cwd: outside, env });
    assert.deepEqual([badName.status, json(badName).error.code], [2, 'usage']);
    const noRepo = await cli(['project', 'add', '--json'], { cwd: outside, env });
    assert.deepEqual([noRepo.status, json(noRepo).error.code], [2, 'not_a_repo']);
    const list = await cli(['project', 'list'], { cwd: outside, env });
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(json(list), { home: env.FORGE_HOME, projects: [] });
    assert.equal(fs.existsSync(env.FORGE_HOME), false);
  });
});
