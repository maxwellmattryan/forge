// The canary interim strategy: verify pins the consumer to `<core>-canary.<sha12>`, `pr open` defers
// the consumer until the canary is published, and only `forge job interim publish --confirm`, run by
// a human at a terminal, ever runs `npm publish`. npm is a stub (an sh script that logs its argv)
// first on PATH, and the registry points at a closed port, so nothing can reach a real registry.
// `--confirm` runs go through test/fixtures/tty-forge.ts, which stands in for the terminal.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIB_COMMANDS, prProject, ready } from './job-repos-fixture.ts';
import type { PrProject } from './job-repos-fixture.ts';
import { TRUST_ENV, trustDigest } from '../lib/config.ts';
import { loadJob } from '../lib/jobs.ts';
import { token } from './secret-fixtures.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

// One line per call (`<cwd> <args>`), and the package.json and files it saw in the package dir
// (\$2, after \`publish\`) beside the log, with the global config npm was pointed at.
const STUB = `#!/bin/sh
d="$STUB_DIR"
echo "$PWD $*" >> "$d/npm.log"
n=$(wc -l < "$d/npm.log" | tr -d ' ')
cp "$2/package.json" "$d/published-$n.json" 2>/dev/null
ls -A "$2" > "$d/files-$n.txt"
ls -A "$PWD" > "$d/cwd-$n.txt"
echo "$npm_config_globalconfig" > "$d/globalconfig-$n.txt"
[ -f "$d/fail" ] && exit 1
exit 0
`;

const LIB_PKG = (name = 'engine', version = '1.4.0-beta.2') => `{\n  "name": "${name}",\n  "version": "${version}"\n}\n`;
const APP_PKG = '{\n  "name": "app",\n  "dependencies": {\n    "engine": "^1.0.0"\n  }\n}\n';

interface Canary extends PrProject {
  id: string;
  rootWt: string;
  libWt: string;
  jobDir: string;
  stub: string;
  /** Every stub npm call so far. */
  log: () => string[];
  run: (args: string[], extra?: NodeJS.ProcessEnv) => Promise<{ status: number | null; stdout: string; stderr: string }>;
  /** forge as if a human ran it at a terminal. */
  tty: (args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
}

const TTY_FORGE = path.join(import.meta.dirname, 'fixtures', 'tty-forge.ts');

async function canary(libPkg = LIB_PKG(), opts: { libFiles?: Record<string, string>; libBase?: Record<string, string> } = {}): Promise<Canary> {
  const p = await prProject(cleanups);
  p.config((c) => {
    c.components = [
      { name: 'app', path: '.', kind: 'app', dependsOn: [{ component: 'lib', type: 'build', link: { ecosystem: 'npm', name: 'engine' } }] },
      { name: 'lib', repo: 'lib', path: '.', kind: 'library', commands: { ...LIB_COMMANDS } },
    ];
    c.repos[0].release = { interim: 'canary' };
  });
  const stub = path.join(p.parent, 'npm-stub');
  fs.mkdirSync(path.join(stub, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stub, 'bin', 'npm'), STUB, { mode: 0o755 });
  const env = { ...p.env, PATH: `${path.join(stub, 'bin')}${path.delimiter}${p.env.PATH}`, STUB_DIR: stub, npm_config_registry: 'http://127.0.0.1:9/' };
  if (opts.libBase) {
    // Content already on lib's default branch, which the branch scan never reads.
    p.commit(p.lib, opts.libBase, 'chore: base');
    p.git(p.lib, 'push', '-q', 'origin', 'HEAD:main');
  }
  const j = await ready(p, { libFiles: { 'package.json': libPkg, ...opts.libFiles } });
  p.commit(j.rootWt, { 'package.json': APP_PKG });
  const log = () => (fs.existsSync(path.join(stub, 'npm.log')) ? fs.readFileSync(path.join(stub, 'npm.log'), 'utf8').split('\n').filter(Boolean) : []);
  const tty = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [TTY_FORGE, ...args], { cwd: p.root, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: p.root, ...env } }, (err, stdout, stderr) => {
        const code = err ? (err as any).code : 0;
        resolve({ status: typeof code === 'number' ? code : null, stdout, stderr });
      });
    });
  return { ...p, ...j, jobDir: path.join(p.root, '.forge', 'jobs', j.id), stub, log, env, run: (args, extra = {}) => p.raw(args, { ...env, ...extra }), tty };
}

const json = (r: { status: number | null; stdout: string; stderr: string }) => {
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout);
};
const head = (p: PrProject, cwd: string) => p.git(cwd, 'rev-parse', 'HEAD').trim();
const sha12 = (sha: string) => (/^\d+$/.test(sha.slice(0, 12)) ? `g${sha.slice(0, 12)}` : sha.slice(0, 12));

describe('interim strategies: canary', { concurrency: 4 }, () => {
  test('canary pins the consumer and defers its PR until published', async () => {
    const c = await canary();
    json(await c.run(['verify', c.id]));
    const version = `1.4.0-canary.${sha12(head(c, c.libWt))}`;
    assert.equal(c.git(c.rootWt, 'show', 'HEAD:package.json'), APP_PKG.replace('^1.0.0', version), 'the exact version, not the dist-tag');
    assert.match(c.git(c.rootWt, 'log', '-1', '--format=%B'), new RegExp(`lib: canary ${version.replace(/\./g, '\\.')}`));
    const out = json(await c.run(['pr', 'open', c.id]));
    assert.deepEqual([out.number, out.created], [null, false]);
    assert.deepEqual(out.deferred, [{ repo: null, why: 'canary', waitingOn: ['lib'], version, name: 'engine' }]);
    assert.deepEqual(out.repos.map((r: any) => [r.repo, r.created]), [['lib', true]], "the dependency's PR opens");
    const st = json(await c.run(['job', 'interim', c.id]));
    assert.deepEqual(st.edges.map((e: any) => [e.strategy, e.state]), [['canary', 'waiting']]);
    assert.match(st.edges[0].detail, new RegExp(`a human runs: forge job interim publish ${c.id} lib --confirm`));
  });

  test('nothing publishes without forge job interim publish --confirm', async () => {
    const c = await canary();
    json(await c.run(['verify', c.id]));
    json(await c.run(['pr', 'open', c.id]));
    await c.f('job', 'set', c.id, '--stage', 'pr', '--state', 'running');
    const s = json(await c.run(['job', 'step', c.id]));
    assert.equal(s.rule, 'PR6');
    assert.match(s.command.join(' '), /--waiting-on human/);
    json(await c.run(s.command));
    json(await c.run(['pr', 'sync', c.id]));
    assert.equal(json(await c.run(['job', 'step', c.id])).rule, 'G4', 'parked on the human');
    // A hand-set override changes nothing either: it only defers.
    json(await c.run(['job', 'repo', 'interim', c.id, 'lib', 'canary']));
    json(await c.run(['verify', c.id]));
    assert.deepEqual(c.log(), [], 'no automatic path ran npm');

    const daemon = await c.run(['job', 'interim', 'publish', c.id, 'lib', '--confirm'], { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(c.root) });
    assert.equal(daemon.status, 1);
    assert.match(daemon.stderr, /publishes a package from this job, which a daemon session may not do/);
    // An agent's Bash tool has no terminal on stdin.
    const piped = await c.run(['job', 'interim', 'publish', c.id, 'lib', '--confirm']);
    assert.equal(piped.status, 1);
    assert.match(piped.stderr, /needs a human at a terminal \(stdin is not a TTY\)/);
    const dry = json(await c.run(['job', 'interim', 'publish', c.id, 'lib']));
    const version = `1.4.0-canary.${sha12(head(c, c.libWt))}`;
    assert.deepEqual(dry, { id: c.id, repo: 'lib', confirm: false, would: [{ name: 'engine', version, tag: 'canary', dir: '.' }] });
    assert.deepEqual(c.log(), [], 'a dry run publishes nothing');
    assert.ok(!fs.existsSync(path.join(c.jobDir, 'canary')), 'and exports nothing');
  });

  test('publish runs npm in a clean export and resumes the job', async () => {
    const c = await canary();
    json(await c.run(['verify', c.id]));
    json(await c.run(['pr', 'open', c.id]));
    await c.f('job', 'set', c.id, '--stage', 'pr', '--state', 'running');
    json(await c.run(json(await c.run(['job', 'step', c.id])).command));
    assert.deepEqual([loadJob(c.root, c.id).state, loadJob(c.root, c.id).waitingOn], ['waiting', 'human']);
    // Untracked and ignored files in lib's worktree never ship.
    fs.writeFileSync(path.join(c.libWt, '.env'), 'SECRET=1\n');
    const sha = head(c, c.libWt);
    const version = `1.4.0-canary.${sha12(sha)}`;
    const pub = json(await c.tty(['job', 'interim', 'publish', c.id, 'lib', '--confirm']));
    assert.equal(pub.confirm, true);
    assert.equal(pub.resumed, true);
    assert.deepEqual(pub.published.map((x: any) => [x.name, x.version, x.tag, x.skipped]), [['engine', version, 'canary', undefined]]);
    const calls = c.log();
    assert.equal(calls.length, 1);
    const [cwd, ...argv] = calls[0].split(' ');
    const [, pkgDir] = argv;
    assert.deepEqual(argv, ['publish', pkgDir, '--ignore-scripts', '--workspaces=false', '--tag', 'canary', '--prefix', cwd], 'no lifecycle script runs, and npm runs from an empty prefix');
    for (const d of [cwd, pkgDir])
      assert.ok(path.resolve(d).startsWith(path.join(fs.realpathSync(os.tmpdir()), 'forge-canary-')) || path.resolve(d).startsWith(path.join(os.tmpdir(), 'forge-canary-')), `exported outside the repo and the job dir: ${d}`);
    assert.ok(!pkgDir.startsWith(cwd + path.sep), 'the package is not under the prefix npm reads project config from');
    assert.deepEqual(fs.readFileSync(path.join(c.stub, 'cwd-1.txt'), 'utf8').split('\n').filter(Boolean), ['npmrc'], 'the prefix holds only the empty global config');
    assert.equal(fs.readFileSync(path.join(c.stub, 'globalconfig-1.txt'), 'utf8').trim(), path.join(cwd, 'npmrc'));
    assert.ok(!fs.existsSync(cwd) && !fs.existsSync(pkgDir), 'and removed after the publish');
    assert.ok(!fs.existsSync(path.join(c.jobDir, 'canary')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.stub, 'published-1.json'), 'utf8')), { name: 'engine', version });
    assert.deepEqual(fs.readFileSync(path.join(c.stub, 'files-1.txt'), 'utf8').split('\n').filter(Boolean).sort(), ['README.md', 'package.json'], 'only the tracked files of the verified commit');
    assert.deepEqual(c.events(c.id).filter((e) => e.type === 'canary-published').map((e) => [e.repo, e.name, e.version, e.sha]), [['lib', 'engine', version, sha]]);
    const job = loadJob(c.root, c.id);
    assert.deepEqual([job.state, job.waitingOn], ['running', null]);
    assert.equal(json(await c.run(['job', 'step', c.id])).rule, 'PR7');
    const opened = json(await c.run(['pr', 'open', c.id]));
    assert.deepEqual([opened.number, opened.created, opened.deferred], [11, true, undefined]);
    const again = json(await c.tty(['job', 'interim', 'publish', c.id, 'lib', '--confirm']));
    assert.deepEqual(again.published.map((x: any) => x.skipped), [true]);
    assert.equal(c.log().length, 1, 'a published version is not published again');
  });

  test('publish refuses an unverified head, a renamed package and a secret', async () => {
    const c = await canary();
    json(await c.run(['verify', c.id]));
    c.commit(c.libWt, { 'late.txt': 'x\n' });
    let r = await c.tty(['job', 'interim', 'publish', c.id, 'lib', '--confirm']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not the commit the latest passing verify checked/);
    const root = await c.run(['job', 'interim', 'publish', c.id, '--root']);
    assert.equal(root.status, 1);
    assert.match(root.stderr, /the root repo is not the dependency of a canary edge with npm links/);

    c.commit(c.libWt, { 'package.json': LIB_PKG('someone-else') });
    json(await c.run(['verify', c.id]));
    r = await c.tty(['job', 'interim', 'publish', c.id, 'lib', '--confirm']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is named "someone-else", not the link's engine/);

    c.config((x) => (x.verifySecrets = 'warn'));
    c.commit(c.libWt, { 'package.json': LIB_PKG(), 'k.ts': `export const k = '${token.github('canary-publish')}';\n` });
    json(await c.run(['verify', c.id]));
    c.config((x) => (x.verifySecrets = 'block'));
    r = await c.tty(['job', 'interim', 'publish', c.id, 'lib', '--confirm', '--json']);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error.code, 'secret_found');
    assert.deepEqual(c.log(), [], 'every refusal came before npm');
  });

  test('publish refuses npm config, strips publishConfig and scans the whole export', async () => {
    const rc = await canary(LIB_PKG(), { libFiles: { 'sub/.npmrc': 'registry=http://127.0.0.1:9/\n' } });
    json(await rc.run(['verify', rc.id]));
    for (const args of [[], ['--confirm']]) {
      const r = await rc.tty(['job', 'interim', 'publish', rc.id, 'lib', ...args]);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /tracks "sub\/\.npmrc" in the package engine; npm would read it as config/);
    }
    assert.deepEqual(rc.log(), []);

    // The class, not the instance: any case, a nested package dir, and a name that only folds to .npmrc.
    const upper = await canary(LIB_PKG(), { libFiles: { '.NPMRC': 'registry=http://127.0.0.1:9/\n', 'pkg/.Npmrc': 'x=1\n' } });
    json(await upper.run(['verify', upper.id]));
    const ur = await upper.tty(['job', 'interim', 'publish', upper.id, 'lib', '--confirm']);
    assert.equal(ur.status, 1);
    assert.match(ur.stderr, /tracks "(\.NPMRC|pkg\/\.Npmrc)" in the package engine; npm would read it as config/);
    assert.deepEqual(upper.log(), []);

    const pkg = '{\n  "name": "engine",\n  "version": "1.4.0",\n  "scripts": { "prepublishOnly": "touch PWNED" },\n  "publishConfig": { "registry": "http://127.0.0.1:9/", "tag": "latest" }\n}\n';
    const pc = await canary(pkg);
    json(await pc.run(['verify', pc.id]));
    json(await pc.tty(['job', 'interim', 'publish', pc.id, 'lib', '--confirm']));
    const published = JSON.parse(fs.readFileSync(path.join(pc.stub, 'published-1.json'), 'utf8'));
    assert.equal(published.publishConfig, undefined, 'publishConfig never reaches npm');
    assert.match(pc.log()[0], / publish \S+ --ignore-scripts /);

    const base = await canary(LIB_PKG(), { libBase: { 'k.ts': `export const k = '${token.github('canary-base')}';\n` } });
    json(await base.run(['verify', base.id]));
    const r = await base.tty(['job', 'interim', 'publish', base.id, 'lib', '--confirm', '--json']);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error.code, 'secret_found', 'a key already on the default branch ships too');
    assert.match(JSON.parse(r.stdout).error.message, /the package engine of repo lib/, 'found in the export, not the branch commits');
    assert.deepEqual(base.log(), []);
  });

  test('publish refuses a tracked symlink', async () => {
    const c = await canary();
    fs.symlinkSync('../../../.npmrc', path.join(c.libWt, 'notes'));
    c.commit(c.libWt, {}, 'feat: link');
    json(await c.run(['verify', c.id]));
    for (const args of [[], ['--confirm']]) {
      const r = await c.tty(['job', 'interim', 'publish', c.id, 'lib', ...args]);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /tracks the symlink "notes" in the package engine; Forge publishes regular files only/);
    }
    assert.deepEqual(c.log(), []);
  });

  test('publish checks the verified commit is on the job branch in git', async () => {
    const c = await canary();
    json(await c.run(['verify', c.id]));
    // A hand-edited job.json names a branch the verified commit is not on.
    const file = path.join(c.jobDir, 'job.json');
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    job.branch = 'main';
    fs.writeFileSync(file, JSON.stringify(job, null, 2));
    const r = await c.tty(['job', 'interim', 'publish', c.id, 'lib', '--confirm']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /verified commit [0-9a-f]{12} is not on the job branch "main"/);
    assert.deepEqual(c.log(), []);
  });
});
