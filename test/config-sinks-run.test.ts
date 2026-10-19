// Config sinks at run time (lib/config-sinks-apply.ts): rendered before a component's command, verify
// step and background start; refused on unsafe paths; values never echoed.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, repoTemplate, waitFor } from './helpers.ts';
import { loadConfig } from '../lib/config.ts';
import { createJob, jobDir, updateJob } from '../lib/jobs.ts';
import { run } from '../lib/util.ts';
import { createWorktree } from '../lib/worktree.ts';
import * as yaml from '../lib/yaml.ts';

const API = path.join('services', 'api');
const EXAMPLE = { server: { host: 'h', port: 1, tags: ['a'] }, keep: true };
const TEMPLATE = 'port = {port}\nname = "{job}"\ntable = { x = 1 }\n';
// Prints what the component sees: its env, config.json, app.toml and the command sink's output.
const SHOW = `const fs = require('fs');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
console.log('SHOW ' + JSON.stringify({ env: { API_BASE: process.env.API_BASE, JOB: process.env.JOB }, cfg: read('config.json'), toml: read('app.toml'), envFile: read('.env.local'), cmd: read('cmd.out') }));
`;
// A command sink: records its env, stdin and cwd.
const WRITE = `const fs = require('fs');
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync('cmd.out', JSON.stringify({ env: { PORT_HTTP: process.env.PORT_HTTP, NAME: process.env.NAME, FORGE_JOB: process.env.FORGE_JOB }, stdin, cwd: process.cwd() }));
`;

const template = repoTemplate((dir) => {
  const api = path.join(dir, API);
  fs.mkdirSync(api, { recursive: true });
  fs.writeFileSync(path.join(api, 'config.example.json'), `${JSON.stringify(EXAMPLE, null, 2)}\n`);
  fs.writeFileSync(path.join(api, 'app.toml.template'), TEMPLATE);
  fs.writeFileSync(path.join(api, 'tracked.json'), '{}\n');
  fs.writeFileSync(path.join(api, 'show.cjs'), SHOW);
  fs.writeFileSync(path.join(api, 'write.cjs'), WRITE);
  fs.writeFileSync(path.join(dir, '.gitignore'), ['services/api/config.json', 'services/api/app.toml', 'services/api/.env.local', 'services/api/out/', 'services/api/cmd.out', 'services/api/ran.marker', ''].join('\n'));
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', '.gitignore'), 'jobs/\nlocks/\nruntime/\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'api'], { cwd: dir, stdio: 'pipe' });
});

const NODE = JSON.stringify(process.execPath);
const COMPONENT_TEST = `${NODE} show.cjs && touch ran.marker`;

/** A scratch repo whose `.forge/config.yml` has the `api` component with `config` sinks; `job()` makes a round-1 job on it. */
function scratch(sinks: unknown[], extra: Record<string, unknown> = {}, component: Record<string, unknown> = {}) {
  const repo = template();
  const root = repo.dir;
  const config = {
    tracker: { kind: 'none' },
    pr: { enabled: false },
    worktrees: { root: `../${path.basename(root)}.wt` },
    commands: { test: `${NODE} services/api/show.cjs`, dev: `${NODE} -e "setInterval(() => {}, 1000)"` },
    components: [{ name: 'api', path: 'services/api', kind: 'service', commands: { test: COMPONENT_TEST }, config: sinks, ...component }],
    ...extra,
  };
  fs.writeFileSync(path.join(root, '.forge', 'config.yml'), yaml.stringify(config));
  return {
    root,
    job(services: string[] = ['api']) {
      const { config: c } = loadConfig(root);
      const id = createJob(root, c, { title: 'sinks' }).id;
      const wt = createWorktree(root, c, id);
      assert.equal(wt.ok, true, JSON.stringify(wt));
      updateJob(root, id, (j) => {
        j.round = 1;
        j.services = services;
      });
      const port = (wt as { port?: number }).port ?? null;
      return { id, wt: wt.path as string, api: path.join(wt.path as string, API), port, setup: (wt as any).setup as { tail: string }[] | undefined };
    },
    events(id: string): any[] {
      return fs.readFileSync(path.join(jobDir(root, id), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    },
    logs(id: string): string[] {
      try {
        return fs.readdirSync(path.join(jobDir(root, id), 'logs'));
      } catch {
        return [];
      }
    },
    cleanup() {
      repo.cleanup();
      fs.rmSync(`${root}.wt`, { recursive: true, force: true });
    },
  };
}

const shown = (tail: string) => JSON.parse(tail.split('\n').find((l) => l.startsWith('SHOW '))!.slice(5));
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sinks-outside-')));

const ENV_SINK = { env: { API_BASE: 'http://localhost:{port}', JOB: '{job}' } };
const MERGE_SINK = { file: { path: 'config.json', format: 'json', mode: 'merge', from: 'config.example.json' }, values: { server: { port: '{port}', name: '{job}' } } };
const TEMPLATE_SINK = { file: { path: 'app.toml', format: 'toml', mode: 'template', from: 'app.toml.template' } };

describe('config sinks at run time', { concurrency: 4 }, () => {
  test('env plus merged config.json render with job values', async () => {
    const x = scratch([ENV_SINK, MERGE_SINK, TEMPLATE_SINK]);
    try {
      const j = x.job();
      assert.ok(j.port, 'the job has a port');
      const r = await forgeAsync(x.root, ['run', j.id, 'test']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      const seen = shown(out.tail);
      assert.deepEqual(seen.env, { API_BASE: `http://localhost:${j.port}`, JOB: j.id });
      assert.deepEqual(JSON.parse(seen.cfg), { server: { host: 'h', port: j.port, tags: ['a'], name: j.id }, keep: true });
      assert.equal(seen.toml, `port = ${j.port}\nname = "${j.id}"\ntable = { x = 1 }\n`);
      assert.deepEqual(out.config, { component: 'api', env: ['API_BASE', 'JOB'], files: ['services/api/config.json', 'services/api/app.toml'], commands: 0 });
      assert.ok(fs.existsSync(path.join(j.api, 'ran.marker')));
      const file = path.join(j.api, 'config.json');
      const st = fs.statSync(file);
      if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
      // The example file is untouched, the worktree stays clean, and a second run rewrites nothing.
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(j.api, 'config.example.json'), 'utf8')), EXAMPLE);
      assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: j.wt, encoding: 'utf8' }), '');
      const again = await forgeAsync(x.root, ['run', j.id, 'test']);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(fs.statSync(file).ino, st.ino, 'an unchanged file is not rewritten');
      const ev = x.events(j.id).filter((e) => e.type === 'config-sinks');
      assert.equal(ev.length, 2);
      assert.deepEqual(ev[0].files, ['services/api/config.json', 'services/api/app.toml']);
    } finally {
      x.cleanup();
    }
  });

  test('verify and background render sinks; setup and component-less jobs do not', async () => {
    const x = scratch([ENV_SINK, { 'env-file': '.env.local', values: { JOB_ID: '{job}' } }], { verify: ['test'], worktrees: { root: `../{repo}.wt`, setup: ['test -e services/api/.env.local && echo present || echo absent'] } });
    try {
      // worktrees.setup ran at creation and saw no sink output.
      const j = x.job();
      assert.equal(j.setup?.[0]?.tail.trim(), 'absent');
      assert.equal(fs.existsSync(path.join(j.api, '.env.local')), false);
      const v = await forgeAsync(x.root, ['verify', j.id]);
      assert.equal(v.status, 0, v.stderr + v.stdout);
      const step = JSON.parse(v.stdout).steps.find((s: any) => s.name === 'test');
      assert.deepEqual(step.config, { component: 'api', env: ['API_BASE', 'JOB'], files: ['services/api/.env.local'], commands: 0 });
      assert.equal(fs.readFileSync(path.join(j.api, '.env.local'), 'utf8'), `JOB_ID=${j.id}\n`);
      assert.equal(x.events(j.id).filter((e) => e.type === 'config-sinks').length, 1);
      // A background start renders them again and gives the server the env.
      fs.rmSync(path.join(j.api, '.env.local'));
      const bg = await forgeAsync(x.root, ['run', j.id, 'dev', '--background']);
      try {
        assert.equal(bg.status, 0, bg.stderr + bg.stdout);
        assert.equal(JSON.parse(bg.stdout).reused, false);
        assert.equal(fs.readFileSync(path.join(j.api, '.env.local'), 'utf8'), `JOB_ID=${j.id}\n`);
        assert.equal(x.events(j.id).filter((e) => e.type === 'config-sinks').length, 2);
        // A reused live process renders nothing.
        fs.rmSync(path.join(j.api, '.env.local'));
        const reused = await forgeAsync(x.root, ['run', j.id, 'dev', '--background']);
        assert.equal(JSON.parse(reused.stdout).reused, true);
        assert.equal(fs.existsSync(path.join(j.api, '.env.local')), false);
        assert.equal(x.events(j.id).filter((e) => e.type === 'config-sinks').length, 2);
      } finally {
        await forgeAsync(x.root, ['stop', j.id]);
      }
      // A job with no component (and one with several) runs the top-level command with no sinks.
      for (const services of [[], ['api', 'web']]) {
        const k = x.job(services);
        const r = await forgeAsync(x.root, ['run', k.id, 'test']);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const out = JSON.parse(r.stdout);
        assert.equal('config' in out, false);
        assert.deepEqual(shown(out.tail).env, {});
        assert.equal(fs.existsSync(path.join(k.api, '.env.local')), false);
        assert.equal(x.events(k.id).some((e) => e.type === 'config-sinks'), false);
      }
    } finally {
      x.cleanup();
    }
  });

  test('unsafe sink paths are refused before the command runs', async () => {
    const outside = tmpDir();
    const x = scratch([]);
    try {
      const refused = async (sinks: unknown[], re: RegExp, plant?: (j: ReturnType<typeof x.job>) => void) => {
        fs.writeFileSync(path.join(x.root, '.forge', 'config.yml'), yaml.stringify({ ...yaml.parse(fs.readFileSync(path.join(x.root, '.forge', 'config.yml'), 'utf8')), components: [{ name: 'api', path: 'services/api', kind: 'service', commands: { test: COMPONENT_TEST }, config: sinks }] }));
        const j = x.job();
        plant?.(j);
        const r = await forgeAsync(x.root, ['run', j.id, 'test']);
        assert.notEqual(r.status, 0, 'refused');
        assert.match(r.stderr, re);
        assert.equal(fs.existsSync(path.join(j.api, 'ran.marker')), false, 'the command never ran');
        assert.equal(x.events(j.id).some((e) => e.type === 'config-sinks' || e.type === 'command'), false);
        return j;
      };
      // Tracked, then merely not ignored.
      await refused([{ file: { path: 'tracked.json', format: 'json', mode: 'merge' }, values: { a: 1 } }], /config sink path services\/api\/tracked\.json must be git-ignored and untracked; add it to \.gitignore/);
      await refused([{ 'env-file': '.env.other', values: { A: 'x' } }], /config sink path services\/api\/\.env\.other must be git-ignored and untracked; add it to \.gitignore/);
      // A symlinked parent pointing outside (the `out/` dir is ignored, so only confinement refuses it).
      await refused([{ 'env-file': 'out/.env', values: { A: 'x' } }], /config sink path services\/api\/out\/\.env has a parent directory that resolves outside/, (j) => fs.symlinkSync(outside, path.join(j.api, 'out')));
      assert.deepEqual(fs.readdirSync(outside), [], 'nothing written outside the worktree');
      // A symlinked parent that stays inside the worktree: the logical path is under the ignored `out/`,
      // but the file would land on a tracked one, so git is asked about the real location.
      const j3 = await refused([{ 'env-file': 'out/services/api/tracked.json', values: { A: 'x' } }], /config sink path services\/api\/out\/services\/api\/tracked\.json \(services\/api\/tracked\.json\) must be git-ignored and untracked; add it to \.gitignore/, (j) => fs.symlinkSync(j.wt, path.join(j.api, 'out')));
      assert.equal(fs.readFileSync(path.join(j3.api, 'tracked.json'), 'utf8'), '{}\n', 'the tracked file is untouched');
      // A `from` that is a symlink to a file outside.
      const secret = path.join(outside, 'id_rsa');
      fs.writeFileSync(secret, 'PRIVATE\n');
      const j4 = await refused([{ file: { path: 'app.toml', format: 'toml', mode: 'template', from: 'secret.template' } }], /config sink 0 of component "api": from services\/api\/secret\.template must be a regular file, not a symlink/, (j) => fs.symlinkSync(secret, path.join(j.api, 'secret.template')));
      assert.equal(fs.existsSync(path.join(j4.api, 'app.toml')), false);
      // A `from` that is missing.
      await refused([{ file: { path: 'app.toml', format: 'toml', mode: 'template', from: 'missing.template' } }], /config sink 0 of component "api": from services\/api\/missing\.template does not exist/);
      // A forged job.worktree.
      await refused([{ 'env-file': '.env.local', values: { A: 'x' } }], /config sinks need the job's own worktree/, (j) => updateJob(x.root, j.id, (job) => void (job.worktree = `${j.wt}${path.sep}`)));
      // A `from` that is a hard link (its content can come from anywhere on the filesystem).
      await refused([{ file: { path: 'app.toml', format: 'toml', mode: 'template', from: 'linked.template' } }], /config sink 0 of component "api": from services\/api\/linked\.template must not be a hard link/, (j) => fs.linkSync(path.join(j.api, 'tracked.json'), path.join(j.api, 'linked.template')));
      // A merge with no `from` reads the output itself as its base: a hard link there is refused too,
      // so a file from outside is never merged into a render the checkout can read.
      const hosts = path.join(outside, 'hosts.json');
      const hostsSentinel = `tok-${crypto.randomBytes(8).toString('hex')}`;
      fs.writeFileSync(hosts, `{"token": "${hostsSentinel}"}\n`);
      const j5 = await refused([{ file: { path: 'config.json', format: 'json', mode: 'merge' }, values: { a: 1 } }], /config sink path services\/api\/config\.json must not be a hard link/, (j) => fs.linkSync(hosts, path.join(j.api, 'config.json')));
      assert.equal(fs.readFileSync(hosts, 'utf8'), `{"token": "${hostsSentinel}"}\n`, 'the linked file is untouched');
      assert.equal(fs.statSync(path.join(j5.api, 'config.json')).nlink, 2, 'the link is not replaced by a render');
      // A merge base that does not parse names the file, and a `from` file's parser message is kept.
      await refused([{ file: { path: 'config.json', format: 'json', mode: 'merge', from: 'app.toml.template' }, values: { a: 1 } }], /config sink 0 \(services\/api\/app\.toml\.template\): the merge base does not parse as json: .*JSON/);
      // A sink that fails validation is refused at run time too (`forge run` does not validate config).
      await refused([{ env: { FORGE_JOB: 'x' } }], /config sinks are invalid: components "api"\.config\[0\]\.env variable "FORGE_JOB" can.t start with FORGE_/);
      // A reserved namespace fails at render with its issue.
      await refused([{ env: { DB: '{secret.db}' } }], /\{secret\.db\} needs secret references \(#197\), which this Forge does not support yet/);
    } finally {
      x.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a garbled previous render is refused without quoting it', async () => {
    const x = scratch([{ file: { path: 'config.json', format: 'json', mode: 'merge' }, values: { port: '{port}' } }]);
    try {
      const j = x.job();
      const sentinel = `tok-${crypto.randomBytes(8).toString('hex')}`;
      fs.writeFileSync(path.join(j.api, 'config.json'), `{"token": "${sentinel}"} trailing\n`);
      const r = await forgeAsync(x.root, ['run', j.id, 'test']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /config sink 0 \(services\/api\/config\.json\): the merge base does not parse as json; delete it or fix it by hand/);
      assert.equal((r.stdout + r.stderr).includes(sentinel), false, 'the previous render is never quoted');
      assert.equal(fs.existsSync(path.join(j.api, 'ran.marker')), false);
    } finally {
      x.cleanup();
    }
  });

  test('a symlink at the output is replaced, not followed', async () => {
    const outside = tmpDir();
    const x = scratch([{ 'env-file': '.env.local', values: { JOB_ID: '{job}' } }]);
    try {
      const target = path.join(outside, 'target');
      fs.writeFileSync(target, 'orig\n');
      const j = x.job();
      fs.symlinkSync(target, path.join(j.api, '.env.local'));
      const r = await forgeAsync(x.root, ['run', j.id, 'test']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const st = fs.lstatSync(path.join(j.api, '.env.local'));
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.isFile(), true);
      assert.equal(fs.readFileSync(path.join(j.api, '.env.local'), 'utf8'), `JOB_ID=${j.id}\n`);
      assert.equal(fs.readFileSync(target, 'utf8'), 'orig\n', 'the symlink target is untouched');
      assert.ok(fs.existsSync(path.join(j.api, 'ran.marker')));
    } finally {
      x.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('command sink gets values on env and stdin', async () => {
    const x = scratch([{ command: `${NODE} write.cjs`, values: { PORT_HTTP: '{port}', NAME: '{job}' } }]);
    try {
      const j = x.job();
      const r = await forgeAsync(x.root, ['run', j.id, 'test']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.config, { component: 'api', env: [], files: [], commands: 1 });
      // show.cjs printed cmd.out, so the sink ran before the command, in the component dir.
      const seen = JSON.parse(shown(out.tail).cmd);
      assert.deepEqual(seen.env, { PORT_HTTP: String(j.port), NAME: j.id, FORGE_JOB: j.id });
      assert.deepEqual(JSON.parse(seen.stdin), { PORT_HTTP: String(j.port), NAME: j.id });
      assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(j.api));
      assert.equal(x.logs(j.id).filter((f) => f.startsWith('config-api-')).length, 1);
    } finally {
      x.cleanup();
    }
  });

  test('a failing command sink stops the command', async () => {
    const x = scratch([{ command: 'echo SINK-OUT; echo SINK-ERR >&2; exit 3' }]);
    try {
      const j = x.job();
      const r = await forgeAsync(x.root, ['run', j.id, 'test']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /config sink command 0 of component "api" exited 3; see .*config-api-.*\.log/);
      assert.equal(fs.existsSync(path.join(j.api, 'ran.marker')), false);
      assert.doesNotMatch(r.stdout + r.stderr, /SINK-(OUT|ERR)/);
      const logs = x.logs(j.id);
      assert.deepEqual(logs.filter((f) => !f.startsWith('config-api-')), [], 'no command log: it never ran');
      assert.equal(logs.length, 1);
      const log = fs.readFileSync(path.join(jobDir(x.root, j.id), 'logs', logs[0]), 'utf8');
      assert.match(log, /SINK-OUT/);
      assert.match(log, /SINK-ERR/);
      assert.match(log, /\[exit 3\]/);
      assert.equal(x.events(j.id).some((e) => e.type === 'command' || e.type === 'config-sinks'), false);
    } finally {
      x.cleanup();
    }
  });

  test('rendered values never reach output, events or logs', async () => {
    const sentinel = `s3ntinel-${crypto.randomBytes(6).toString('hex')}`;
    const x = scratch(
      [{ env: { TOKEN: `x-${sentinel}` } }, { 'env-file': '.env.local', values: { V: sentinel } }, { file: { path: 'config.json', format: 'json', mode: 'merge', from: 'config.example.json' }, values: { token: sentinel } }],
      {},
      { commands: { test: 'true' } },
    );
    try {
      const j = x.job();
      const r = await forgeAsync(x.root, ['run', j.id, 'test']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.config, { component: 'api', env: ['TOKEN'], files: ['services/api/.env.local', 'services/api/config.json'], commands: 0 });
      // The values did land in the worktree.
      assert.match(fs.readFileSync(path.join(j.api, '.env.local'), 'utf8'), new RegExp(sentinel));
      assert.match(fs.readFileSync(path.join(j.api, 'config.json'), 'utf8'), new RegExp(sentinel));
      const dir = jobDir(x.root, j.id);
      const texts = [r.stdout, r.stderr, fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), ...x.logs(j.id).map((f) => fs.readFileSync(path.join(dir, 'logs', f), 'utf8'))];
      if (fs.existsSync(path.join(dir, 'runtime.json'))) texts.push(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
      for (const t of texts) assert.doesNotMatch(t, new RegExp(sentinel));
      // A background start writes runtime.json, which carries no value either.
      const bg = await forgeAsync(x.root, ['run', j.id, 'dev', '--background']);
      try {
        assert.equal(bg.status, 0, bg.stderr + bg.stdout);
        await waitFor(() => fs.existsSync(path.join(dir, 'runtime.json')), { what: 'runtime.json' });
        assert.doesNotMatch(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'), new RegExp(sentinel));
        assert.doesNotMatch(bg.stdout + bg.stderr, new RegExp(sentinel));
      } finally {
        await forgeAsync(x.root, ['stop', j.id]);
      }
    } finally {
      x.cleanup();
    }
  });
});

describe('config sink commands', { concurrency: 4 }, () => {
  test('a command that exits without reading its stdin keeps its exit status', () => {
    // More input than the pipe buffer holds makes the EPIPE deterministic; a small stdin only races it.
    const r = run('sh', ['-c', 'exit 3'], { input: 'x'.repeat(1 << 20), allowFail: true });
    assert.equal(r.status, 3);
    assert.equal(r.ok, false);
    assert.equal(run('sh', ['-c', 'true'], { input: 'x'.repeat(1 << 20), allowFail: true }).status, 0);
    assert.throws(() => run('sh', ['-c', 'exit 3'], { input: 'x'.repeat(1 << 20) }), /exited 3/);
  });
});
