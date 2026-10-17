// Interim strategies, the pure half (lib/interim.ts): resolution, canary versions, git specs and the
// manifest rewrites. No git or sh, so it also runs on CI's Windows leg.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../lib/config.ts';
import { BLOCK_BEGIN, BLOCK_END, canaryVersion, npmGitSpec, pinCargo, pinCmake, pinNpm, remoteUrl, resolveInterim } from '../lib/interim.ts';
import { isPackageManagerConfig } from '../lib/interim-apply.ts';
import type { Config, Job } from '../lib/types.ts';

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
});
