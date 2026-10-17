// Local links through the CLI: `forge run` and `forge verify` put the link shims first on PATH in the
// root and in a member, lockfiles come back byte for byte, and removing a job repo removes its links.
// Stub cargo, cmake and npm (sh scripts) record their argv; the real toolchains are in
// links-toolchains.test.ts, the pure resolution and rendering in links.test.ts.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LIB_COMMANDS, twoRepo } from './job-repos-fixture.ts';
import type { TwoRepo } from './job-repos-fixture.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const LINKS = [
  { component: 'lib', type: 'build', link: { ecosystem: 'cargo', name: 'engine-core' } },
  { component: 'lib', type: 'build', link: { ecosystem: 'cmake', name: 'engine' } },
  { component: 'lib', type: 'build', link: { ecosystem: 'npm', name: 'engine' } },
];
const BUILD = 'cargo +nightly build --release && cargo test && cmake -S . -B build && cmake --build build && npm install';

// One line per call: the tool, each argument, then the two link env vars, all `|`-separated. With
// STUB_LOCK set, cargo rewrites a Cargo.lock in its cwd as a `[patch]` would.
const stub = (tool: string) => `#!/bin/sh
{ printf '%s' '${tool}'; for a in "$@"; do printf '|%s' "$a"; done; printf '|CFG=%s|CMK=%s\\n' "\${FORGE_CARGO_CONFIG-}" "\${FORGE_CMAKE_ARGS-}"; } >> "$STUB_LOG"
${tool === 'cargo' ? '[ -n "${STUB_LOCK-}" ] && [ -f Cargo.lock ] && echo "patched $$" >> Cargo.lock\n' : ''}exit 0
`;

interface Linked extends TwoRepo {
  id: string;
  rootWt: string;
  libWt: string;
  stubs: string;
  jobDir: string;
  env: NodeJS.ProcessEnv;
  /** The stub calls logged since the last read, each split on `|`. */
  calls: () => string[][];
  run: (args: string[], env?: NodeJS.ProcessEnv) => Promise<any>;
}

/** The two-repo project with links both ways (root consumes lib; lib consumes the root), stubs on PATH and the worktrees created. */
async function linked(edit: (c: any) => void = () => {}): Promise<Linked> {
  const p = await twoRepo();
  cleanups.push(p.cleanup);
  const stubs = path.join(p.parent, 'stubs');
  fs.mkdirSync(stubs);
  for (const t of ['cargo', 'cmake', 'npm']) fs.writeFileSync(path.join(stubs, t), stub(t), { mode: 0o755 });
  const log = path.join(p.parent, 'stub.log');
  p.config((c) => {
    c.commands.build = BUILD;
    c.components = [
      { name: 'app', path: '.', kind: 'app', dependsOn: structuredClone(LINKS) },
      { name: 'lib', repo: 'lib', path: '.', kind: 'library', commands: { ...LIB_COMMANDS, build: 'cargo build' }, dependsOn: [{ component: 'app', type: 'runtime', link: { ecosystem: 'cargo', name: 'app-core' } }] },
    ];
    edit(c);
  });
  const j = await p.f('job', 'new', '--title', `links ${Math.random().toString(36).slice(2, 8)}`);
  await p.f('job', 'repo', 'add', j.id, 'lib');
  const created = await p.f('worktree', 'create', j.id);
  const env = { PATH: `${stubs}${path.delimiter}${process.env.PATH}`, STUB_LOG: log };
  let seen = 0;
  const calls = () => {
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    const fresh = lines.slice(seen);
    seen = lines.length;
    return fresh.map((l) => l.split('|'));
  };
  const run = async (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = await p.raw(args, { ...env, ...extra });
    assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  return { ...p, id: j.id, rootWt: created.path, libWt: created.repos[0].path, stubs, jobDir: path.join(p.root, '.forge', 'jobs', j.id), env, calls, run };
}

const status = (p: TwoRepo, cwd: string) => p.git(cwd, 'status', '--porcelain', '--untracked-files=all');

describe('links: forge run and verify', { concurrency: 4 }, () => {
  test('forge run applies cargo, cmake and npm links', async () => {
    const p = await linked();
    const cfg = path.join(p.jobDir, 'links', '_root', 'cargo-links.toml');
    const cmk = `'-DFETCHCONTENT_SOURCE_DIR_ENGINE=${p.libWt}'`;
    const out = await p.run(['run', p.id, 'build']);
    assert.equal(out.ok, true, out.tail);
    assert.equal(out.cmd, BUILD, 'the result keeps the filled command');
    assert.deepEqual(out.links, ['cargo:engine-core', 'cmake:engine', 'npm:engine']);
    assert.equal('restored' in out, false);
    const env = [`CFG=${cfg}`, `CMK=${cmk}`];
    assert.deepEqual(p.calls(), [
      ['cargo', '+nightly', '--config', cfg, 'build', '--release', ...env],
      ['cargo', '--config', cfg, 'test', ...env],
      ['cmake', `-DFETCHCONTENT_SOURCE_DIR_ENGINE=${p.libWt}`, '-S', '.', '-B', 'build', ...env],
      ['cmake', '--build', 'build', ...env],
      ['npm', 'install', ...env],
      ['npm', 'install', '--no-save', '--no-audit', '--no-fund', '--install-links=false', p.libWt, ...env],
    ]);
    assert.ok(fs.readFileSync(cfg, 'utf8').includes(`[patch."crates-io"]\n"engine-core" = { path = ${JSON.stringify(p.libWt)} }\n`));
    const log = fs.readFileSync(path.join(p.jobDir, out.log), 'utf8');
    assert.match(log, new RegExp(`^\\$ ${BUILD.replace(/[+.]/g, '\\$&')}\\n\\(cwd .*\\)\\n\\(links ${path.join(p.jobDir, 'links', '_root', 'bin')}\\)\\n`));
    // The member consumes the root: its own file, its own key.
    const lib = await p.run(['run', p.id, 'build', '--repo', 'lib']);
    const libCfg = path.join(p.jobDir, 'links', 'lib', 'cargo-links.toml');
    assert.deepEqual(lib.links, ['cargo:app-core']);
    assert.deepEqual(p.calls(), [['cargo', '--config', libCfg, 'build', `CFG=${libCfg}`, 'CMK=']]);
    assert.ok(fs.readFileSync(libCfg, 'utf8').includes(`"app-core" = { path = ${JSON.stringify(p.rootWt)} }`));
    // A login profile that puts the real tool's directory first runs before the PATH line, so the shim still wins.
    const profile = path.join(p.parent, 'profile-shell');
    fs.writeFileSync(profile, `#!/bin/sh\nPATH='${p.stubs}':"$PATH"; export PATH\n[ "$1" = -lc ] && shift && exec /bin/sh -c "$@"\nexec /bin/sh "$@"\n`, { mode: 0o755 });
    await p.run(['run', p.id, 'build'], { SHELL: profile });
    assert.deepEqual(p.calls()[0].slice(0, 4), ['cargo', '+nightly', '--config', cfg]);
  });

  test('verify applies links to root and member steps', async () => {
    const p = await linked((c) => {
      c.verify = ['build'];
    });
    await p.f('job', 'round', p.id);
    const r = await p.raw(['verify', p.id], p.env);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, r.stdout);
    assert.deepEqual(out.steps.find((s: any) => s.name === 'build').links, ['cargo:engine-core', 'cmake:engine', 'npm:engine']);
    const calls = p.calls();
    const cfg = path.join(p.jobDir, 'links', '_root', 'cargo-links.toml');
    const libCfg = path.join(p.jobDir, 'links', 'lib', 'cargo-links.toml');
    assert.deepEqual(calls[0].slice(0, 4), ['cargo', '+nightly', '--config', cfg]);
    assert.ok(calls.some((c) => c[0] === 'cmake' && c[1] === `-DFETCHCONTENT_SOURCE_DIR_ENGINE=${p.libWt}`));
    assert.deepEqual(calls.at(-1)!.slice(0, 4), ['cargo', '--config', libCfg, 'build'], 'the member step');
  });

  test('lockfiles are restored after run and verify', async () => {
    const p = await linked((c) => {
      c.commands.lock = 'cargo update';
      c.verify = [['build', 'lock']];
    });
    const lock = path.join(p.rootWt, 'Cargo.lock');
    p.commit(p.rootWt, { 'Cargo.lock': '# locked\n' }, 'lockfile');
    const out = await p.run(['run', p.id, 'build'], { STUB_LOCK: '1' });
    assert.deepEqual(out.restored, ['Cargo.lock']);
    assert.equal(status(p, p.rootWt), '');
    assert.deepEqual(
      p.events(p.id).filter((e) => e.type === 'link-lockfiles-restored').map((e) => [e.repo, e.paths]),
      [[null, ['Cargo.lock']]],
    );
    // Two steps of one group both rewrite it: restored once the group settles, and verify passes.
    await p.f('job', 'round', p.id);
    const r = await p.raw(['verify', p.id], { ...p.env, STUB_LOCK: '1' });
    const v = JSON.parse(r.stdout);
    assert.equal(v.ok, true, r.stdout);
    for (const name of ['build', 'lock']) assert.deepEqual(v.steps.find((s: any) => s.name === name).restored, ['Cargo.lock'], name);
    assert.equal(status(p, p.rootWt), '');
    assert.equal(fs.readFileSync(lock, 'utf8'), '# locked\n');
    // A builder's own edit, made before the run, is what the snapshot holds.
    fs.writeFileSync(lock, '# builder edit\n');
    await p.run(['run', p.id, 'build'], { STUB_LOCK: '1' });
    assert.equal(fs.readFileSync(lock, 'utf8'), '# builder edit\n');
  });

  test('no tracked file changes', async () => {
    const p = await linked((c) => {
      c.verify = ['build'];
    });
    await p.run(['run', p.id, 'build']);
    await p.run(['run', p.id, 'build', '--repo', 'lib']);
    await p.f('job', 'round', p.id);
    assert.equal(JSON.parse((await p.raw(['verify', p.id], p.env)).stdout).ok, true);
    for (const wt of [p.rootWt, p.libWt]) assert.equal(status(p, wt), '', wt);
    const rendered: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk : (f: string) => rendered.push(f))(path.join(d, e.name));
    };
    walk(path.join(p.jobDir, 'links'));
    assert.deepEqual(rendered.map((f) => path.relative(p.jobDir, f)).sort(), [
      path.join('links', '_root', 'bin', 'cargo'),
      path.join('links', '_root', 'bin', 'cmake'),
      path.join('links', '_root', 'bin', 'npm'),
      path.join('links', '_root', 'cargo-links.toml'),
      path.join('links', 'lib', 'bin', 'cargo'),
      path.join('links', 'lib', 'cargo-links.toml'),
    ]);
    for (const f of rendered) assert.match(fs.readFileSync(f, 'utf8'), new RegExp(`^(#!/bin/sh\\n)?# Written by Forge for job ${p.id}: never commit this\\n`));
  });

  test('removing a job repo removes its links', async () => {
    const p = await linked();
    await p.run(['run', p.id, 'build', '--repo', 'lib']);
    assert.ok(fs.existsSync(path.join(p.jobDir, 'links', 'lib')));
    await p.f('worktree', 'remove', p.id, '--repo', 'lib');
    await p.f('job', 'repo', 'remove', p.id, 'lib');
    assert.equal(fs.existsSync(path.join(p.jobDir, 'links', 'lib')), false);
    const { links } = await p.f('job', 'links', p.id);
    const cargo = links.find((l: any) => l.ecosystem === 'cargo' && l.consumerRepo === null);
    assert.deepEqual([cargo.active, cargo.dir, cargo.reason], [false, null, 'repo lib is not on the job']);
    p.calls();
    const out = await p.run(['run', p.id, 'build']);
    assert.equal('links' in out, false);
    const calls = p.calls();
    assert.deepEqual(calls[0], ['cargo', '+nightly', 'build', '--release', 'CFG=', "CMK='-UFETCHCONTENT_SOURCE_DIR_ENGINE'"]);
    assert.deepEqual(calls[2].slice(0, 2), ['cmake', '-UFETCHCONTENT_SOURCE_DIR_ENGINE']);
    assert.equal(calls.filter((c) => c[0] === 'npm').length, 1, 'no link install');
    assert.deepEqual(fs.readdirSync(path.join(p.jobDir, 'links', '_root', 'bin')), ['cmake']);
  });

  test('forge job links output', async () => {
    const p = await linked();
    const out = await p.f('job', 'links', p.id);
    assert.equal(out.id, p.id);
    assert.deepEqual(
      out.links.map((l: any) => [l.consumer, l.consumerRepo, l.dependency, l.dependencyRepo, l.ecosystem, l.name, l.source, l.dir, l.active, l.reason]),
      [
        ['app', null, 'lib', 'lib', 'cargo', 'engine-core', 'crates-io', p.libWt, true, null],
        ['app', null, 'lib', 'lib', 'cmake', 'engine', null, p.libWt, true, null],
        ['app', null, 'lib', 'lib', 'npm', 'engine', null, p.libWt, true, null],
        ['lib', 'lib', 'app', null, 'cargo', 'app-core', 'crates-io', p.rootWt, true, null],
      ],
    );
    // A job whose member has no worktree yet.
    const k = await p.f('job', 'new', '--title', 'no worktrees');
    await p.f('job', 'repo', 'add', k.id, 'lib');
    const pending = await p.f('job', 'links', k.id);
    assert.ok(pending.links.every((l: any) => !l.active && l.reason === `repo ${l.consumerRepo ?? 'app'} has no worktree yet; run: forge worktree create ${k.id}`), JSON.stringify(pending));
    const missing = await p.raw(['job', 'links', 'no-such-job']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no-such-job/);
    p.config((c) => {
      for (const comp of c.components) delete comp.dependsOn;
    });
    assert.deepEqual(await p.f('job', 'links', p.id), { id: p.id, links: [] });
  });
});
