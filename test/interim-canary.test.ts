// The canary interim strategy: verify pins the consumer to `<core>-canary.<sha12>`, `pr open` defers
// the consumer until the canary is published, and only `forge job interim publish --confirm`, run by
// a human, ever runs `npm publish`. npm is a stub (an sh script that logs its argv) first on PATH,
// and the registry points at a closed port, so nothing can reach a real registry.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LIB_COMMANDS, prProject, ready } from './job-repos-fixture.ts';
import type { PrProject } from './job-repos-fixture.ts';
import { TRUST_ENV, trustDigest } from '../lib/config.ts';
import { loadJob } from '../lib/jobs.ts';
import { token } from './secret-fixtures.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

// One line per call (`<cwd> <args>`), and the package.json it saw beside the log.
const STUB = `#!/bin/sh
d="$STUB_DIR"
echo "$PWD $*" >> "$d/npm.log"
cp package.json "$d/published-$(wc -l < "$d/npm.log" | tr -d ' ').json" 2>/dev/null
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
}

async function canary(libPkg = LIB_PKG()): Promise<Canary> {
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
  const j = await ready(p, { libFiles: { 'package.json': libPkg } });
  p.commit(j.rootWt, { 'package.json': APP_PKG });
  const log = () => (fs.existsSync(path.join(stub, 'npm.log')) ? fs.readFileSync(path.join(stub, 'npm.log'), 'utf8').split('\n').filter(Boolean) : []);
  return { ...p, ...j, jobDir: path.join(p.root, '.forge', 'jobs', j.id), stub, log, env, run: (args, extra = {}) => p.raw(args, { ...env, ...extra }) };
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
    const pub = json(await c.run(['job', 'interim', 'publish', c.id, 'lib', '--confirm']));
    assert.equal(pub.confirm, true);
    assert.equal(pub.resumed, true);
    assert.deepEqual(pub.published.map((x: any) => [x.name, x.version, x.tag, x.skipped]), [['engine', version, 'canary', undefined]]);
    const calls = c.log();
    assert.equal(calls.length, 1);
    const [cwd, ...argv] = calls[0].split(' ');
    assert.deepEqual(argv, ['publish', '--tag', 'canary']);
    assert.ok(fs.realpathSync(cwd).startsWith(fs.realpathSync(path.join(c.jobDir, 'canary', 'lib')) + path.sep), cwd);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.stub, 'published-1.json'), 'utf8')), { name: 'engine', version });
    assert.deepEqual(fs.readdirSync(cwd).sort(), ['README.md', 'package.json'], 'only the tracked files of the verified commit');
    assert.deepEqual(c.events(c.id).filter((e) => e.type === 'canary-published').map((e) => [e.repo, e.name, e.version, e.sha]), [['lib', 'engine', version, sha]]);
    const job = loadJob(c.root, c.id);
    assert.deepEqual([job.state, job.waitingOn], ['running', null]);
    assert.equal(json(await c.run(['job', 'step', c.id])).rule, 'PR7');
    const opened = json(await c.run(['pr', 'open', c.id]));
    assert.deepEqual([opened.number, opened.created, opened.deferred], [11, true, undefined]);
    const again = json(await c.run(['job', 'interim', 'publish', c.id, 'lib', '--confirm']));
    assert.deepEqual(again.published.map((x: any) => x.skipped), [true]);
    assert.equal(c.log().length, 1, 'a published version is not published again');
  });

  test('publish refuses an unverified head, a renamed package and a secret', async () => {
    const c = await canary();
    json(await c.run(['verify', c.id]));
    c.commit(c.libWt, { 'late.txt': 'x\n' });
    let r = await c.run(['job', 'interim', 'publish', c.id, 'lib', '--confirm']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not the commit the latest passing verify checked/);
    const root = await c.run(['job', 'interim', 'publish', c.id, '--root']);
    assert.equal(root.status, 1);
    assert.match(root.stderr, /the root repo is not the dependency of a canary edge with npm links/);

    c.commit(c.libWt, { 'package.json': LIB_PKG('someone-else') });
    json(await c.run(['verify', c.id]));
    r = await c.run(['job', 'interim', 'publish', c.id, 'lib', '--confirm']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is named "someone-else", not the link's engine/);

    c.config((x) => (x.verifySecrets = 'warn'));
    c.commit(c.libWt, { 'package.json': LIB_PKG(), 'k.ts': `export const k = '${token.github('canary-publish')}';\n` });
    json(await c.run(['verify', c.id]));
    c.config((x) => (x.verifySecrets = 'block'));
    r = await c.run(['job', 'interim', 'publish', c.id, 'lib', '--confirm', '--json']);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error.code, 'secret_found');
    assert.deepEqual(c.log(), [], 'every refusal came before npm');
  });
});
