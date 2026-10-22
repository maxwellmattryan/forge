// Interim strategies, the pure half (lib/interim.ts, lib/interim-apply.ts): resolution, canary
// versions, git specs, the manifest pins and release writers, the release gates, config validation and
// the no-follow manifest write. No CLI; the writers' fixtures go through the seeded release-gate script
// with plain node, so they run on every platform.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaults, validateConfig } from '../lib/core/config/load.ts';
import { declaredLinks } from '../lib/engine/project/links.ts';
import {
  BLOCK_BEGIN,
  BLOCK_END,
  bumpedVersion,
  canaryVersion,
  heldConsumers,
  isReleaseVersion,
  lockfileArgv,
  npmGitSpec,
  npmReleaseSpec,
  pinCargo,
  pinCmake,
  pinNpm,
  releaseCargo,
  releaseCmake,
  releaseGates,
  releaseNpm,
  releasedVersion,
  remoteUrl,
  resolveInterim,
  strategyOf,
} from '../lib/engine/release/interim.ts';
import { isPackageManagerConfig, writeManifest } from '../lib/engine/release/interim-apply.ts';
import { PLUGIN_ROOT } from '../lib/core/paths.ts';
import type { Config, Job } from '../lib/core/types.ts';
import { repoTemplate } from './helpers.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const SHA2 = 'fedcba9876543210fedcba9876543210fedcba98';
const pin = (rev = SHA, extra: Record<string, string> = {}) => ({ source: 'crates-io', name: 'engine-core', git: 'https://example.com/lib.git', rev, ...extra });

describe('interim: pure helpers', { concurrency: 4 }, () => {
  test('canary version from a package version and sha', () => {
    assert.equal(canaryVersion('1.4.0', SHA), '1.4.0-canary.0123456789ab');
    assert.equal(canaryVersion('1.4.0-beta.2', SHA), '1.4.0-canary.0123456789ab', 'a prerelease suffix is dropped');
    assert.equal(canaryVersion('v2.0.10+build.7', SHA), '2.0.10-canary.0123456789ab', 'and a build suffix');
    assert.equal(canaryVersion('1.0.0', '012345678901' + 'a'.repeat(28)), '1.0.0-canary.g012345678901', 'an all-digit sha12 gets the g prefix');
    for (const bad of ['1.0', '01.0.0', 'x', '', 7, null]) assert.equal(canaryVersion(bad, SHA), null, String(bad));
    for (const bad of ['abc', SHA.toUpperCase(), `${SHA}0`, '--x']) assert.equal(canaryVersion('1.0.0', bad), null, bad);
  });

  test('npm git spec from each remote form', () => {
    assert.equal(npmGitSpec('/srv/git/lib.git', SHA), `git+file:///srv/git/lib.git#${SHA}`);
    assert.equal(npmGitSpec('git@github.com:acme/lib.git', SHA), `git+ssh://git@github.com/acme/lib.git#${SHA}`);
    assert.equal(npmGitSpec('https://github.com/acme/lib.git', SHA), `git+https://github.com/acme/lib.git#${SHA}`);
    assert.equal(npmGitSpec('git+ssh://git@host/acme/lib.git', SHA), `git+ssh://git@host/acme/lib.git#${SHA}`, 'already git+');
    assert.equal(npmGitSpec('ssh://git@host/acme/lib.git', SHA), `git+ssh://git@host/acme/lib.git#${SHA}`);
    assert.equal(npmGitSpec('https://user:tok@github.com/acme/lib.git', SHA), `git+https://github.com/acme/lib.git#${SHA}`, 'credentials never reach a manifest');
    for (const bad of ['lib', './lib', '-oops', 'a b', '']) assert.equal(npmGitSpec(bad, SHA), null, bad);
    assert.equal(npmGitSpec('/srv/lib', 'HEAD'), null, 'only a full sha');
    assert.equal(remoteUrl('C:\\git\\lib'), 'file:///C:/git/lib');
    const hostile = `a@${'b'.repeat(10_000)}:${'c'.repeat(10_000)}`;
    const t = Date.now();
    remoteUrl(hostile);
    assert.ok(Date.now() - t < 200, 'a 10k-character remote parses in linear time');
  });

  test('remote credentials are dropped under every scheme', () => {
    assert.equal(remoteUrl('ssh://git:pw@host/acme/lib.git'), 'ssh://host/acme/lib.git', 'a password never stays');
    assert.equal(remoteUrl('ssh://git@host/acme/lib.git'), 'ssh://git@host/acme/lib.git', 'a bare ssh user stays');
    assert.equal(remoteUrl('https://u:p@ss@github.com/acme/lib.git'), 'https://github.com/acme/lib.git', 'through the last @ of the authority');
    assert.equal(remoteUrl('https://ghp_tok@github.com/acme/lib.git'), 'https://github.com/acme/lib.git', 'a token as the user name');
    assert.equal(remoteUrl('git://u:p@host/lib.git'), 'git://host/lib.git');
    assert.equal(remoteUrl('https://github.com/acme/lib@v1.git'), 'https://github.com/acme/lib@v1.git', 'an @ in the path is not userinfo');
    const hostile = `ssh://${'@'.repeat(10_000)}${'a'.repeat(10_000)}`;
    const t = Date.now();
    remoteUrl(hostile);
    assert.ok(Date.now() - t < 200, 'a 10k-character authority parses in linear time');
  });

  test('pinCargo writes, replaces and refuses', () => {
    const base = '[package]\nname = "app"\n\n[dependencies]\nengine-core = "1"\n';
    const first = pinCargo(base, [pin(), pin(SHA, { source: 'https://github.com/acme/x', name: 'a-macro' })]);
    assert.ok('text' in first);
    assert.equal(first.text, `${base}\n${BLOCK_BEGIN}\n[patch."crates-io"]\n"engine-core" = { git = "https://example.com/lib.git", rev = "${SHA}" }\n[patch."https://github.com/acme/x"]\n"a-macro" = { git = "https://example.com/lib.git", rev = "${SHA}" }\n${BLOCK_END}\n`);
    const second = pinCargo(first.text, [pin(SHA2)]);
    assert.ok('text' in second);
    assert.equal(second.text, `${base}\n${BLOCK_BEGIN}\n[patch."crates-io"]\n"engine-core" = { git = "https://example.com/lib.git", rev = "${SHA2}" }\n${BLOCK_END}\n`, 'the block is replaced in place');
    assert.deepEqual(pinCargo(second.text, [pin(SHA2)]), second, 'idempotent');
    for (const foreign of ['[patch.crates-io]', '[ patch."crates-io" ]', "[patch.'crates-io']", 'patch.crates-io.x = { path = "x" }'])
      assert.deepEqual(pinCargo(`${base}${foreign}\n`, [pin()]), { error: 'Cargo.toml has [patch."crates-io"] outside the Forge block' }, foreign);
    assert.ok('text' in pinCargo(`${base}[patch.other]\nx = { path = "x" }\n`, [pin()]), 'another source is fine');
    assert.match((pinCargo(`${BLOCK_BEGIN}\n`, [pin()]) as { error: string }).error, /broken or repeated/);
    assert.match((pinCargo(base, [pin('HEAD')]) as { error: string }).error, /not a commit id/);
    const quoted = pinCargo('', [pin(SHA, { git: 'https://h/a"b\\c' })]);
    assert.ok('text' in quoted && quoted.text.includes('git = "https://h/a\\"b\\\\c"'), 'TOML strings are escaped');
    const t = Date.now();
    pinCargo(`[patch.${'"'.repeat(10_000)}\n${'['.repeat(10_000)}patch.${' '.repeat(10_000)}x`, [pin()]);
    assert.ok(Date.now() - t < 200, 'a hostile 10k-character line parses in linear time');
  });

  test('pinCmake replaces the one GIT_TAG', () => {
    const text = `include(FetchContent)\nFetchContent_Declare(\n  Engine  # the engine\n  GIT_REPOSITORY https://example.com/lib.git\n  GIT_TAG v1.2.3\n)\nFetchContent_Declare(other GIT_TAG main)\n`;
    const r = pinCmake(text, 'engine', SHA);
    assert.deepEqual(r, { text: text.replace('v1.2.3', SHA) });
    assert.deepEqual(pinCmake((r as { text: string }).text, 'engine', SHA2), { text: text.replace('v1.2.3', SHA2) });
    assert.deepEqual(pinCmake(`fetchcontent_declare("engine" GIT_TAG "v1")`, 'Engine', SHA), { text: `fetchcontent_declare("engine" GIT_TAG ${SHA})` });
    assert.match((pinCmake(text + text, 'engine', SHA) as { error: string }).error, /has 2 FetchContent_Declare\(engine …\) calls/);
    assert.match((pinCmake('FetchContent_Declare(x GIT_TAG a)', 'engine', SHA) as { error: string }).error, /has 0 FetchContent_Declare/);
    assert.match((pinCmake('FetchContent_Declare(engine GIT_REPOSITORY x)', 'engine', SHA) as { error: string }).error, /0 GIT_TAG arguments/);
    assert.match((pinCmake('FetchContent_Declare(engine GIT_TAG a GIT_TAG b)', 'engine', SHA) as { error: string }).error, /2 GIT_TAG arguments/);
    assert.match((pinCmake('FetchContent_Declare(engine GIT_TAG a', 'engine', SHA) as { error: string }).error, /unclosed/);
  });

  test('pinNpm sets every section and keeps the format', () => {
    const text = '{\n    "name": "app",\n    "dependencies": {\n        "@acme/lib": "^1.0.0"\n    },\n    "devDependencies": {\n        "@acme/lib": "^1.0.0"\n    }\n}\n';
    const r = pinNpm(text, '@acme/lib', `git+file:///x#${SHA}`);
    assert.ok('text' in r);
    assert.equal(r.text, text.replaceAll('^1.0.0', `git+file:///x#${SHA}`), 'indentation and the trailing newline are kept');
    assert.deepEqual(pinNpm('{"dependencies":{"@acme/lib":"1"}}', '@acme/lib', '2.0.0-canary.x'), { text: '{\n  "dependencies": {\n    "@acme/lib": "2.0.0-canary.x"\n  }\n}' });
    assert.deepEqual(pinNpm('{"dependencies":{}}', '@acme/lib', 'x'), { error: 'package.json has no dependency on @acme/lib' });
    assert.deepEqual(pinNpm('not json', '@acme/lib', 'x'), { error: 'package.json is not valid JSON' });
    assert.deepEqual(pinNpm('{"dependencies":{"constructor":"1"}}', '__proto__', 'x'), { error: 'package.json has no dependency on __proto__' });
  });

  test('resolveInterim states without git', () => {
    const components = [
      { name: 'app', path: '.', kind: 'app', dependsOn: [{ component: 'lib', type: 'build', link: { ecosystem: 'cargo', name: 'lib' } }] },
      { name: 'lib', repo: 'lib', path: 'core', kind: 'library', dependsOn: [{ component: 'tools', type: 'build', link: { ecosystem: 'npm', name: 'tools' } }] },
      { name: 'tools', repo: 'tools', path: 'pkg', kind: 'library' },
    ];
    const repos = [
      { name: 'lib', remote: '/x/lib', defaultBranch: 'main', release: { interim: 'canary' } },
      { name: 'tools', remote: '/x/tools', defaultBranch: 'main', release: { interim: 'git-ref' } },
    ];
    const member = (repo: string, extra: Record<string, unknown> = {}) => ({ repo, worktree: null, branch: 'b', base: 'main', pr: null, verifyOnly: false, interim: null, ...extra });
    const job = { interim: null, pr: null, repos: [{ repo: null, interim: null }, member('lib'), member('tools')] } as unknown as Job;
    const config = { ...defaults(), components, repos } as unknown as Config;
    const r = resolveInterim(config, job);
    assert.deepEqual(r.order, ['tools', 'lib', null]);
    const brief = r.edges.map((e) => [e.consumer, e.dependency, e.strategy, e.state]);
    assert.deepEqual(brief, [
      ['lib', 'tools', 'git-ref', 'blocked'],
      [null, 'tools', 'git-ref', 'blocked'],
      [null, 'lib', 'canary', 'blocked'],
    ]);
    assert.match(r.edges[0].detail, /npm installs a git dependency only from its repo's root, and tools is at pkg/);
    assert.match(r.edges[1].detail, /no dependsOn link joins the root repo to repo tools/, 'a transitive edge has no links');
    assert.match(r.edges[2].detail, /canary is npm-only: the cargo link lib/);
    const seq = { ...job, repos: [{ repo: null }, member('lib', { interim: 'sequential', pr: { number: 7, state: 'OPEN' } }), member('tools', { interim: 'local' })] } as unknown as Job;
    const s = resolveInterim(config, seq).edges.map((e) => [e.consumer, e.dependency, e.strategy, e.source, e.state, e.detail]);
    assert.deepEqual(s, [
      ['lib', 'tools', 'local', 'job', 'held', "repo lib's PR opens as a draft (interim: local)"],
      [null, 'tools', 'local', 'job', 'held', "the root repo's PR opens as a draft (interim: local)"],
      [null, 'lib', 'sequential', 'job', 'waiting', 'repo lib PR #7 is not merged'],
    ]);
    const merged = { ...seq, repos: [{ repo: null }, member('lib', { interim: 'sequential', pr: { number: 7, state: 'MERGED' } }), member('tools')] } as unknown as Job;
    assert.equal(resolveInterim(config, merged).edges[2].state, 'ready');
    assert.deepEqual(resolveInterim(config, { ...job, repos: [{ repo: null }] } as unknown as Job).edges, [], 'a single-repo job has no edges');
  });

  test('package manager config names match by case, Unicode form and filesystem folding', () => {
    const refused = [
      '.npmrc', '.NPMRC', '.Npmrc', 'pkg/.npmrc', 'a/b/.NpMrC', 'pkg\\.npmrc', 'npmrc', 'NPMRC~1',
      '.yarnrc', '.yarnrc.yml', '.YARNRC.YML', '.pnpmrc', '.PNPMRC',
      '.npmrc.', '.npmrc  ', '.npmrc::$DATA', '.npm\u200Brc', '.n\u00ADpmrc', '.\uFF4E\uFF50\uFF4D\uFF52\uFF43',
      '.npmrc/inner', 'sub/.Yarnrc/x',
    ];
    for (const p of refused) assert.equal(isPackageManagerConfig(p), true, JSON.stringify(p));
    for (const p of ['package.json', 'README.md', 'src/npm.ts', 'docs/rc.md', '.npmignore', 'lib/yarn.lock', 'pnpm-lock.yaml'])
      assert.equal(isPackageManagerConfig(p), false, p);
    // A 100k hostile name finishes at once: linear takes well under 1 ms, quadratic takes seconds.
    const t = Date.now();
    assert.equal(isPackageManagerConfig(`${'. '.repeat(50000)}x`), false);
    assert.equal(isPackageManagerConfig(`${'. '.repeat(50000)}`), false);
    assert.equal(isPackageManagerConfig(`.npmrc${':'.repeat(100000)}`), true);
    assert.ok(Date.now() - t < 500);
  });

  test('release gates: bump-due and released', () => {
    const link = [{ ecosystem: 'cargo', name: 'engine-core' }] as any[];
    const edge = (strategy: string, links: any[] = link, consumer: string | null = null) => ({ consumer, dependency: 'lib', strategy, links }) as any;
    const job = (state = 'OPEN') => ({ pr: { number: 11, state }, repos: [] }) as any;
    const rel = (version: unknown, repo: unknown = 'lib') => ({ type: 'interim-released', repo, version });
    const bumped = (version: unknown, extra: Record<string, unknown> = {}) => ({ type: 'interim-bumped', repo: null, dependency: 'lib', version, ...extra });
    const gate = (e: any, events: any[], j = job()) => releaseGates([e], events, j).map((g) => [g.gate, g.version])[0];
    assert.deepEqual(gate(edge('git-ref'), []), ['ci', undefined]);
    assert.deepEqual(gate(edge('canary'), []), ['ci', undefined]);
    assert.deepEqual(gate(edge('local'), []), ['held', undefined]);
    assert.deepEqual(gate(edge('sequential'), []), ['held', undefined]);
    for (const s of ['git-ref', 'canary', 'local', 'sequential']) {
      assert.deepEqual(gate(edge(s), [rel('1.2.0')]), ['bump-due', '1.2.0'], `${s} with links`);
      assert.deepEqual(gate(edge(s), [rel('1.2.0'), bumped('1.2.0')]), ['released', '1.2.0'], `${s} bumped`);
      assert.deepEqual(gate(edge(s, []), [rel('1.2.0')]), ['released', '1.2.0'], `${s} without links`);
      assert.deepEqual(gate(edge(s), [rel('1.2.0')], job('MERGED')), ['released', '1.2.0'], `${s} merged consumer`);
    }
    // A bumped event before the record does not count, nor one for another version; a newer version is due again.
    assert.deepEqual(gate(edge('git-ref'), [bumped('1.2.0'), rel('1.2.0')]), ['bump-due', '1.2.0']);
    assert.deepEqual(gate(edge('git-ref'), [rel('1.2.0'), bumped('1.1.0')]), ['bump-due', '1.2.0']);
    assert.deepEqual(gate(edge('git-ref'), [rel('1.2.0'), bumped('1.2.0'), rel('1.3.0')]), ['bump-due', '1.3.0']);
    assert.deepEqual(gate(edge('git-ref'), [rel('1.2.0'), bumped('1.2.0'), rel('1.3.0'), bumped('1.3.0')]), ['released', '1.3.0']);
    // Malformed events of both types are ignored: events.jsonl is writable outside the CLI.
    const noRepo = { type: 'interim-released', version: '1.2.0' };
    for (const bad of [rel('1.2.0-canary.abc'), rel('-Zunstable'), rel('1.2.0 && x'), rel(`1.2.0-${'a'.repeat(120)}`), rel('1.2.0', '../x'), rel('1.2.0', 7), rel('not a version'), rel(12), noRepo])
      assert.deepEqual(gate(edge('git-ref'), [bad]), ['ci', undefined], JSON.stringify(bad));
    for (const bad of [bumped('1.2.0-canary.abc'), bumped('1.2.0', { repo: '../x' }), bumped('1.2.0', { dependency: undefined }), bumped('1.2.0', { dependency: 'other' }), bumped('1.2.0', { repo: 'web' })])
      assert.deepEqual(gate(edge('git-ref'), [rel('1.2.0'), bad]), ['bump-due', '1.2.0'], JSON.stringify(bad));
    assert.equal(bumpedVersion([rel('1.2.0'), bumped('1.2.0')], null, 'lib', 0), '1.2.0');
    assert.equal(bumpedVersion([bumped('1.2.0'), rel('1.2.0')], null, 'lib', 1), null);
    // heldConsumers: held and bump-due both keep a consumer a draft.
    const gates = releaseGates([edge('local', [], 'a'), edge('git-ref', link, 'b'), edge('git-ref', [], 'c')], [rel('1.0.0', 'other'), rel('1.2.0')], { pr: null, repos: [] } as any);
    assert.deepEqual(gates.map((g) => g.gate), ['released', 'bump-due', 'released']);
    assert.deepEqual([...heldConsumers(gates)], ['b']);
    assert.deepEqual([...heldConsumers(releaseGates([edge('local', [], 'a')], []))], ['a']);
  });
});

// The helpers behind `forge job interim release`; its CLI tests are e2e/release/pr.test.ts.
describe('interim release', () => {
  test('gate helpers', () => {
    assert.equal(isReleaseVersion('1.2.0'), true);
    assert.equal(isReleaseVersion('v1.2.0-rc.1+build.5'), true);
    assert.equal(isReleaseVersion('1.2.0-Canary'), false);
    assert.equal(isReleaseVersion(`1.${'9'.repeat(10_000)}.0`), false, 'a long hostile value is refused fast');
    const events = [
      { type: 'interim-released', repo: 'lib', version: '1.0.0' },
      { type: 'interim-released', repo: null, version: '2.0.0' },
      { type: 'interim-released', repo: 'lib', version: 'bad' },
    ];
    assert.equal(releasedVersion(events, 'lib'), '1.0.0');
    assert.equal(releasedVersion(events, null), '2.0.0');
    assert.equal(releasedVersion(events, 'other'), null);
  });
});

const REPOS = [{ name: 'lib', remote: 'https://example.com/lib.git', defaultBranch: 'main' }];
const cfgLink = (ecosystem: string, extra: Record<string, unknown> = {}) => ({ ecosystem, name: ecosystem === 'npm' ? '@acme/lib' : 'lib', ...extra });
const components = (l: Record<string, unknown>) => [
  { name: 'app', path: 'app', kind: 'app', dependsOn: [{ component: 'lib', type: 'build', link: l }] },
  { name: 'lib', repo: 'lib', path: '.', kind: 'library' },
];
const problems = (c: Record<string, unknown>) => validateConfig({ ...defaults(), repos: REPOS, components: components(cfgLink('cargo')), ...c }, process.cwd());
const noJob = { interim: null, repos: [] } as unknown as Job;

describe('interim strategies: config', { concurrency: 4 }, () => {
  test('release.interim validates on the root and on repos entries', () => {
    assert.deepEqual(defaults().release, { interim: 'local', versioning: null, mechanism: null, command: null, registry: null, cadence: null, publish: null });
    assert.deepEqual(problems({}), []);
    for (const interim of ['canary', 'git-ref', 'local', 'sequential']) {
      assert.deepEqual(problems({ release: { interim } }), [], interim);
      assert.deepEqual(problems({ repos: [{ ...REPOS[0], release: { interim } }] }), [], interim);
    }
    assert.deepEqual(problems({ repos: [{ ...REPOS[0], release: null }] }), [], 'a member may leave release out or null');
    assert.deepEqual(problems({ repos: [{ ...REPOS[0], release: {} }] }), [], 'or give no interim');
    assert.deepEqual(problems({ release: { interim: 'bogus' } }), ['release.interim must be one of canary | git-ref | local | sequential (got "bogus")']);
    assert.deepEqual(problems({ release: 'canary' }), ['release must be a map with interim canary | git-ref | local | sequential (got "canary")']);
    assert.deepEqual(problems({ repos: [{ ...REPOS[0], release: { interim: 'publish' } }] }), ['repos "lib".release.interim must be one of canary | git-ref | local | sequential (got "publish")']);
    assert.deepEqual(problems({ repos: [{ ...REPOS[0], release: ['canary'] }] }), ['repos "lib".release must be a map with interim canary | git-ref | local | sequential (got ["canary"])']);
    // Resolution: a member without release is local; config wins over the default.
    const config = { ...defaults(), repos: REPOS } as Config;
    assert.deepEqual(strategyOf(config, noJob, 'lib'), { strategy: 'local', source: 'config' });
    assert.deepEqual(strategyOf({ ...config, repos: [{ ...REPOS[0], release: { interim: 'git-ref' } }] }, noJob, 'lib'), { strategy: 'git-ref', source: 'config' });
    assert.deepEqual(strategyOf({ ...config, release: { ...config.release, interim: 'sequential' } }, noJob, null), { strategy: 'sequential', source: 'config' });
    assert.deepEqual(strategyOf({ ...config, release: { interim: 'bogus' } } as unknown as Config, noJob, null), { strategy: 'local', source: 'config' }, 'an invalid value never resolves');
  });

  test('link.manifest validates per ecosystem', () => {
    const at = 'components "app".dependsOn[0].link.manifest';
    const ok: [string, string][] = [['cargo', 'Cargo.toml'], ['cargo', 'crates/app/Cargo.toml'], ['cmake', 'CMakeLists.txt'], ['cmake', 'cmake/deps.cmake'], ['npm', 'web/package.json']];
    for (const [eco, manifest] of ok) assert.deepEqual(validateConfig({ ...defaults(), repos: REPOS, components: components(cfgLink(eco, { manifest })) }, process.cwd()), [], `${eco} ${manifest}`);
    const bad: [string, unknown, string][] = [
      ['cargo', '/abs/Cargo.toml', 'a Cargo.toml'],
      ['cargo', '../x/Cargo.toml', 'a Cargo.toml'],
      ['cargo', 'a/../Cargo.toml', 'a Cargo.toml'],
      ['cargo', 'Cargo.lock', 'a Cargo.toml'],
      ['cmake', 'CMakeLists.txt.bak', 'a CMakeLists.txt or a .cmake file'],
      ['cmake', '.cmake', 'a CMakeLists.txt or a .cmake file'],
      ['npm', 'package-lock.json', 'a package.json'],
      ['npm', 'C:\\x\\package.json', 'a package.json'],
      ['npm', 7, 'a package.json'],
    ];
    for (const [eco, manifest, what] of bad) {
      const got = validateConfig({ ...defaults(), repos: REPOS, components: components(cfgLink(eco, { manifest })) }, process.cwd());
      assert.deepEqual(got, [`${at} must be a relative path inside the consumer's repo to ${what} (got ${JSON.stringify(manifest)})`], `${eco} ${manifest}`);
    }
    // The default manifest is the ecosystem's file in the consumer component's path; a set one wins.
    const [d] = declaredLinks({ components: components(cfgLink('cmake')) } as Config);
    assert.equal(d.manifest, 'app/CMakeLists.txt');
    const [m] = declaredLinks({ components: components(cfgLink('npm', { manifest: 'web/package.json' })) } as Config);
    assert.equal(m.manifest, 'web/package.json');
    assert.equal(declaredLinks({ components: components(cfgLink('npm', { manifest: '../package.json' })) } as Config).length, 0, 'an invalid manifest drops the link, as other invalid links are dropped');
  });
});

// The release writers: what verify writes into a consumer's manifests once its dependency's release
// is recorded, and the lockfile argv.
const SCRIPT = path.join(PLUGIN_ROOT, 'templates', 'release-gate', 'release-gate.mjs');
const WSHA = 'a'.repeat(40);
const ok = (r: { text: string } | { error: string }): string => {
  if ('error' in r) throw new Error(r.error);
  return r.text;
};
const err = (r: { text: string } | { error: string }): string => {
  assert.ok('error' in r, `expected an error, got ${JSON.stringify(r)}`);
  return r.error;
};
const wpin = (name = 'engine-core') => ({ source: 'crates-io', name, git: 'https://example.com/lib.git', rev: WSHA });
const gitRepo = repoTemplate(() => {});

/** The seeded gate script over `files`, committed in a scratch repo. */
function gate(files: Record<string, string>): { status: number | null; out: string } {
  const repo = gitRepo();
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, rel), text);
    }
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'manifests');
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo.dir, encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    repo.cleanup();
  }
}

const PKG = 'name = "app"\nversion = "0.1.0"\n';

describe('interim release writers', { concurrency: 4 }, () => {
  test('pinCargo with no pins removes the block', () => {
    const base = `[package]\n${PKG}\n[dependencies]\nengine-core = "1.2.0"\n`;
    const pinned = ok(pinCargo(base, [wpin()]));
    assert.ok(pinned.includes(BLOCK_BEGIN));
    assert.equal(ok(pinCargo(pinned, [])), base, 'the block and the blank line before it go');
    assert.equal(ok(pinCargo(base, [])), base, 'no block: unchanged');
    // A block in the middle of the file loses only its own lines.
    const middle = `[package]\n${PKG}\n${BLOCK_BEGIN}\n[patch."crates-io"]\n"x" = { git = "g", rev = "${WSHA}" }\n${BLOCK_END}\n\n[dependencies]\nx = "1"\n`;
    assert.equal(ok(pinCargo(middle, [])), `[package]\n${PKG}\n\n[dependencies]\nx = "1"\n`);
    const crlf = base.replace(/\n/g, '\r\n');
    assert.equal(ok(pinCargo(ok(pinCargo(crlf, [wpin()])), [])), crlf, 'CRLF kept');
    assert.match(err(pinCargo(`${BLOCK_BEGIN}\n`, [])), /broken or repeated/);
  });

  test('releaseCargo sets the released requirement', () => {
    const cases: [string, string, string, string][] = [
      ['string', '[dependencies]\nengine-core = "1.0.0"\n', '1.2.0', '[dependencies]\nengine-core = "1.2.0"\n'],
      ['literal string', "[dependencies]\nengine-core = '1.0'\n", '1.2.0', "[dependencies]\nengine-core = '1.2.0'\n"],
      ['quoted key', '[dependencies]\n"engine-core" = "1"\n', '1.2.0', '[dependencies]\n"engine-core" = "1.2.0"\n'],
      ['^ kept', '[dependencies]\nengine-core = "^1"\n', '1.2.0', '[dependencies]\nengine-core = "^1.2.0"\n'],
      ['v and +build stripped', '[dependencies]\nengine-core = "1"\n', 'v1.2.0+build.5', '[dependencies]\nengine-core = "1.2.0"\n'],
      ['prerelease kept', '[dependencies]\nengine-core = "1"\n', '1.2.0-rc.1', '[dependencies]\nengine-core = "1.2.0-rc.1"\n'],
      [
        'inline table',
        '[dependencies]\nengine-core = { version = "1.0", features = ["a", "b"], path = "../e" } # local\n',
        '1.2.0',
        '[dependencies]\nengine-core = { version = "1.2.0", features = ["a", "b"], path = "../e" } # local\n',
      ],
      ['subtable', '[dependencies.engine-core]\nversion = "1.0"\nfeatures = ["x"]\n', '1.2.0', '[dependencies.engine-core]\nversion = "1.2.0"\nfeatures = ["x"]\n'],
      [
        'every table kind',
        '[dependencies]\nengine-core = "1"\n\n[dev-dependencies]\nengine-core = "1"\n\n[build-dependencies]\nengine-core = { version = "1" }\n\n[workspace.dependencies]\nengine-core = "1"\n\n[target.\'cfg(unix)\'.dependencies]\nengine-core = "1"\n\n[target."cfg(windows)".dev-dependencies.engine-core]\nversion = "1"\n',
        '1.2.0',
        '[dependencies]\nengine-core = "1.2.0"\n\n[dev-dependencies]\nengine-core = "1.2.0"\n\n[build-dependencies]\nengine-core = { version = "1.2.0" }\n\n[workspace.dependencies]\nengine-core = "1.2.0"\n\n[target.\'cfg(unix)\'.dependencies]\nengine-core = "1.2.0"\n\n[target."cfg(windows)".dev-dependencies.engine-core]\nversion = "1.2.0"\n',
      ],
      ['only workspace = true', '[dependencies]\nengine-core = { workspace = true }\n', '1.2.0', '[dependencies]\nengine-core = { workspace = true }\n'],
      ['other crates and tables untouched', '[package]\nversion = "0.1.0"\n\n[dependencies]\nengine = "1"\nengine-core-x = "1"\n\n[features]\nengine-core = []\n\n[dependencies]\nengine-core = "1"\n', '1.2.0', '[package]\nversion = "0.1.0"\n\n[dependencies]\nengine = "1"\nengine-core-x = "1"\n\n[features]\nengine-core = []\n\n[dependencies]\nengine-core = "1.2.0"\n'],
      ['CRLF kept', '[dependencies]\r\nengine-core = "1"\r\n', '1.2.0', '[dependencies]\r\nengine-core = "1.2.0"\r\n'],
    ];
    for (const [name, text, version, want] of cases) assert.equal(ok(releaseCargo(text, 'engine-core', version)), want, name);
    // The Forge block is skipped: pinCargo removes the crate from it.
    const pinned = ok(pinCargo('[dependencies]\nengine-core = "1"\n', [wpin()]));
    assert.equal(ok(releaseCargo(pinned, 'engine-core', '1.2.0')), pinned.replace('engine-core = "1"', 'engine-core = "1.2.0"'), 'the [patch] entry inside the block stays');
  });

  test('releaseCargo refuses what it cannot rewrite', () => {
    const refusals: [string, string, RegExp][] = [
      ['multi-line inline table', '[dependencies]\nengine-core = {\n  version = "1",\n}\n', /multi-line inline table/],
      ['dotted version key', '[dependencies]\nengine-core.version = "1"\n', /dotted key/],
      ['no version', '[dependencies]\nengine-core = { git = "https://example.com/e.git" }\n', /has no version/],
      ['subtable with no version', '[dependencies.engine-core]\npath = "../e"\n\n[features]\n', /dependency table has no version/],
      ['no entry', '[dependencies]\nengine = "1"\n', /Cargo.toml has no dependency on engine-core/],
      ['not a string', '[dependencies]\nengine-core = 1\n', /neither a version string nor an inline table/],
    ];
    for (const [name, text, re] of refusals) assert.match(err(releaseCargo(text, 'engine-core', '1.2.0')), re, name);
    for (const bad of ['1.2', '1.2.0-canary.abc', '1.2.0 && x']) assert.match(err(releaseCargo('[dependencies]\nengine-core = "1"\n', 'engine-core', bad)), /not a released version/, bad);
    const t = Date.now();
    releaseCargo(`[dependencies]\nengine-core = { ${'"'.repeat(10_000)} ${'{'.repeat(10_000)}\n[${'a.'.repeat(5_000)}`, 'engine-core', '1.2.0');
    assert.ok(Date.now() - t < 2000, 'a hostile line is parsed in linear time');
  });

  test('releaseCmake replaces the tag, kept as recorded', () => {
    const CMAKE = 'include(FetchContent)\nFetchContent_Declare(\n  engine\n  GIT_REPOSITORY https://example.com/engine.git\n  GIT_TAG v1.0.0\n)\n';
    const pinned = ok(pinCmake(CMAKE, 'Engine', WSHA));
    assert.equal(ok(releaseCmake(pinned, 'engine', 'v1.2.0')), CMAKE.replace('v1.0.0', 'v1.2.0'));
    assert.equal(ok(releaseCmake(pinned, 'engine', '1.2.0')), CMAKE.replace('v1.0.0', '1.2.0'));
    assert.match(err(releaseCmake(CMAKE + CMAKE.slice(CMAKE.indexOf('FetchContent_Declare')), 'engine', 'v1.2.0')), /2 FetchContent_Declare\(engine …\) calls; the release needs exactly one/);
    assert.match(err(releaseCmake(CMAKE, 'engine', WSHA)), /not a released version/);
    assert.match(err(pinCmake(CMAKE.replace('  GIT_TAG v1.0.0\n', ''), 'engine', WSHA)), /0 GIT_TAG arguments; the pin needs exactly one with a value/, 'pin wording kept');
  });

  test('releaseNpm follows the per-section range rule', () => {
    const cases: [unknown, string, string][] = [
      ['^1.0.0', '1.2.0', '^1.2.0'],
      ['~1.0.0', 'v1.2.0', '~1.2.0'],
      ['1.0.0', '1.2.0+b', '1.2.0'],
      ['1.0.0-canary.0123456789ab', '1.2.0', '^1.2.0'],
      [`git+https://example.com/e.git#${WSHA}`, '1.2.0', '^1.2.0'],
      [7, '1.2.0', '^1.2.0'],
    ];
    for (const [old, version, want] of cases) assert.equal(npmReleaseSpec(old, version), want, String(old));
    const PKG_JSON = '{\n    "name": "app",\n    "dependencies": {\n        "engine": "1.0.0-canary.0123456789ab"\n    },\n    "devDependencies": {\n        "engine": "~1.0.0"\n    }\n}\n';
    assert.equal(ok(releaseNpm(PKG_JSON, 'engine', '1.2.0')), PKG_JSON.replace('1.0.0-canary.0123456789ab', '^1.2.0').replace('~1.0.0', '~1.2.0'), 'per section, indent kept');
    assert.match(err(releaseNpm(PKG_JSON, 'other', '1.2.0')), /no dependency on other/);
    assert.match(err(releaseNpm(PKG_JSON, 'engine', '1.2.0-canary.x')), /not a released version/);
  });

  test('round trip and the gate script', () => {
    const CARGO = `[package]\n${PKG}\n[dependencies]\nengine-core = "1.2.0"\n`;
    const CMAKE = 'include(FetchContent)\nFetchContent_Declare(\n  engine\n  GIT_REPOSITORY https://example.com/engine.git\n  GIT_TAG v1.2.0\n)\n';
    const JSON_PKG = '{\n  "name": "app",\n  "dependencies": {\n    "engine": "^1.2.0"\n  }\n}\n';
    const cargo = ok(releaseCargo(ok(pinCargo(ok(pinCargo(CARGO, [wpin()])), [])), 'engine-core', '1.2.0'));
    assert.equal(cargo, CARGO, 'Cargo.toml: byte for byte');
    const cmake = ok(releaseCmake(ok(pinCmake(CMAKE, 'engine', WSHA)), 'engine', 'v1.2.0'));
    assert.equal(cmake, CMAKE, 'CMakeLists.txt: byte for byte');
    const npm = ok(releaseNpm(ok(pinNpm(JSON_PKG, 'engine', `git+https://example.com/e.git#${WSHA}`)), 'engine', '1.2.0'));
    assert.equal(npm, JSON_PKG, 'package.json: byte for byte');
    // Two crates pinned, one released: the other's pin stays and the gate still fails on it.
    const two = ok(pinCargo(`${CARGO}engine-macros = "1.2.0"\n`, [wpin(), wpin('engine-macros')]));
    const one = ok(releaseCargo(ok(pinCargo(two, [wpin('engine-macros')])), 'engine-core', '1.2.0'));
    assert.ok(one.includes('"engine-macros" = { git') && !one.includes('"engine-core" = { git'));
    assert.equal(gate({ 'Cargo.toml': one }).status, 1, 'the remaining pin still fails the gate');
    const released = { 'Cargo.toml': cargo, 'cmake/CMakeLists.txt': cmake, 'package.json': npm, 'web/package.json': ok(releaseNpm(ok(pinNpm(JSON_PKG, 'engine', '1.2.0-canary.0123456789ab')), 'engine', '1.2.0')) };
    for (const [file, text] of Object.entries(released)) {
      const r = gate({ [file]: text });
      assert.equal(r.status, 0, `${file}: ${r.out}`);
    }
    const all = gate(released);
    assert.equal(all.status, 0, all.out);
  });

  test('lockfileArgv: argv and refusals', () => {
    assert.deepEqual(lockfileArgv('cargo', 'engine-core', 'v1.2.0+b'), { argv: ['update', '-p', 'engine-core', '--precise', '1.2.0'] });
    assert.deepEqual(lockfileArgv('npm', '@acme/engine', '1.2.0'), { argv: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'] });
    // Option-shaped names and versions never reach the argv, nor a canary or an over-long version.
    for (const [eco, name, version] of [
      ['cargo', '-Zunstable', '1.2.0'],
      ['npm', '-g', '1.2.0'],
      ['cargo', 'engine-core', '-Zunstable'],
      ['cargo', 'engine-core', '1.2.0-canary.abc'],
      ['cargo', 'engine-core', `1.2.0-${'a'.repeat(120)}`],
      ['cmake', 'engine', '1.2.0'],
    ])
      assert.ok('error' in lockfileArgv(eco, name, version), `${eco} ${name} ${version}`);
  });
});

// writeManifest, the interim pin writer: a random-named temp file opened exclusive and no-follow,
// renamed over the manifest, and removed whenever anything after its creation fails.
const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function scratch(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-manifest-')));
  dirs.push(d);
  fs.mkdirSync(path.join(d, 'wt'));
  return d;
}

const forgeTemps = (dir: string) => fs.readdirSync(dir).filter((f) => /\.forge-.*\.tmp$/.test(f));

describe('interim manifest writes', () => {
  test('a symlink planted at the temp path is never followed', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, () => {
    const d = scratch();
    const wt = path.join(d, 'wt');
    const outside = path.join(d, 'outside.txt');
    fs.writeFileSync(outside, 'keep me\n');
    fs.writeFileSync(path.join(wt, 'Cargo.toml'), 'original\n');
    const planted = path.join(wt, '.Cargo.toml.forge-fixed.tmp');
    fs.symlinkSync(outside, planted);
    assert.throws(() => writeManifest(wt, 'Cargo.toml', 'pinned\n', () => 'fixed'), (e: any) => e.code === 'EEXIST' || e.code === 'ELOOP');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me\n');
    assert.equal(fs.readFileSync(path.join(wt, 'Cargo.toml'), 'utf8'), 'original\n');
    assert.ok(fs.lstatSync(planted).isSymbolicLink(), 'the planted link is not Forge\'s to remove');
    assert.deepEqual(forgeTemps(wt), ['.Cargo.toml.forge-fixed.tmp'], 'no temp file of Forge\'s is left');
  });

  test('a failed rename leaves no temp file', () => {
    const d = scratch();
    const wt = path.join(d, 'wt');
    fs.mkdirSync(path.join(wt, 'package.json'));
    fs.writeFileSync(path.join(wt, 'package.json', 'inner'), 'x');
    assert.throws(() => writeManifest(wt, 'package.json', '{}\n'));
    assert.deepEqual(forgeTemps(wt), []);
    assert.ok(fs.statSync(path.join(wt, 'package.json')).isDirectory());
  });

  test('the manifest keeps its mode', () => {
    const d = scratch();
    const wt = path.join(d, 'wt');
    const file = path.join(wt, 'CMakeLists.txt');
    fs.writeFileSync(file, 'old\n');
    fs.chmodSync(file, 0o640);
    writeManifest(wt, 'CMakeLists.txt', 'new\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(forgeTemps(wt), []);
  });
});
