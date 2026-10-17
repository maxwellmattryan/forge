// AC1 end to end: a git-ref consumer is pinned, its dependency merges and is released, step asks for
// verify (PR9), verify bumps the consumer to the release and refreshes Cargo.lock, the seeded
// release-gate script passes, and step moves on to pushing it (PR3). Scratch repos with bare remotes,
// the fake gh and a stub cargo; nothing reaches GitHub or a registry.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BLOCK_BEGIN } from '../lib/interim.ts';
import { PLUGIN_ROOT } from '../lib/paths.ts';
import { prProject, ready } from './job-repos-fixture.ts';

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const POSIX = process.platform === 'win32' ? 'the stub cargo and the fake gh are shell scripts' : false;
const CARGO = '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nengine-core = "1.0.0"\n';
const CARGO_STUB = `#!/bin/sh
echo "$PWD $*" >> "$STUB_DIR/cargo.log"
printf 'refreshed by stub cargo: %s\\n' "$*" > Cargo.lock
`;

describe('interim release bump, end to end', () => {
  test('git-ref consumer: release, bump, verify, gate green', { skip: POSIX }, async () => {
    const p = await prProject(cleanups);
    p.config((c) => {
      c.components = [
        { name: 'app', path: '.', kind: 'app', dependsOn: [{ component: 'lib', type: 'build', link: { ecosystem: 'cargo', name: 'engine-core' } }] },
        { name: 'lib', repo: 'lib', path: '.', kind: 'library' },
      ];
      c.repos[0].release = { interim: 'git-ref' };
      // Cargo.lock is a protected path by default (a human approves its change at pr open); that gate
      // has its own tests, so it is off here to keep this one about the bump.
      c.policy = { ...(c.policy ?? {}), protectedPaths: [] };
    });
    const stubs = path.join(p.parent, 'stubs');
    fs.mkdirSync(path.join(stubs, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(stubs, 'bin', 'cargo'), CARGO_STUB, { mode: 0o755 });
    const env = { ...p.env, PATH: `${path.join(stubs, 'bin')}${path.delimiter}${p.env.PATH}`, STUB_DIR: stubs };
    const f = async (...args: string[]) => {
      const r = await p.raw(args, env);
      assert.equal(r.status, 0, `forge ${args.join(' ')}: ${r.stderr}${r.stdout}`);
      return JSON.parse(r.stdout);
    };
    const j = await ready(p);
    p.commit(j.rootWt, { 'Cargo.toml': CARGO, 'Cargo.lock': '# lock v1\n' }, 'feat: depend on engine-core');
    // Verify pins it; both PRs open; lib's merges.
    await f('verify', j.id);
    assert.ok(p.git(j.rootWt, 'show', 'HEAD:Cargo.toml').includes(BLOCK_BEGIN));
    await f('pr', 'open', j.id);
    p.fake('lib.state', 'MERGED');
    await f('pr', 'sync', j.id);
    await f('job', 'set', j.id, '--stage', 'pr', '--state', 'running');
    assert.equal((await f('job', 'interim', j.id)).gates[0].gate, 'ci');
    const rec = await f('job', 'interim', 'release', j.id, 'lib', '1.2.0');
    assert.deepEqual([rec.recorded, rec.bump], [true, [null]]);

    const s1 = await f('job', 'step', j.id);
    assert.deepEqual([s1.rule, s1.command], ['PR9', ['verify', j.id]]);
    const before = Number(p.git(j.rootWt, 'rev-list', '--count', 'HEAD').trim());
    const v = await f('verify', j.id);
    assert.equal(v.ok, true);
    assert.equal(Number(p.git(j.rootWt, 'rev-list', '--count', 'HEAD').trim()), before + 1, 'one bump commit');
    assert.equal(p.git(j.rootWt, 'log', '-1', '--format=%s').trim(), `forge: release bump for job ${j.id}`);
    assert.deepEqual(p.git(j.rootWt, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['Cargo.lock', 'Cargo.toml']);
    assert.equal(p.git(j.rootWt, 'show', 'HEAD:Cargo.toml'), CARGO.replace('"1.0.0"', '"1.2.0"'), 'no Forge block, the released requirement');
    assert.equal(p.git(j.rootWt, 'show', 'HEAD:Cargo.lock'), 'refreshed by stub cargo: update -p engine-core --precise 1.2.0\n');
    assert.deepEqual(
      p.events(j.id).filter((e) => e.type === 'interim-bumped').map((e) => [e.repo, e.dependency, e.version, e.sha]),
      [[null, 'lib', '1.2.0', p.git(j.rootWt, 'rev-parse', 'HEAD').trim()]],
    );
    const gate = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'templates', 'release-gate', 'release-gate.mjs')], { cwd: j.rootWt, encoding: 'utf8' });
    assert.equal(gate.status, 0, gate.stdout + gate.stderr);
    const st = await f('job', 'interim', j.id);
    assert.deepEqual([st.edges[0].state, st.gates[0].gate, st.gates[0].version], ['released', 'released', '1.2.0']);
    const s2 = await f('job', 'step', j.id);
    assert.deepEqual([s2.rule, s2.command], ['PR3', ['pr', 'open', j.id]]);
  });
});
