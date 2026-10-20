// Interim strategies in config (config schemaVersion 13): `release.interim` on the root and on
// `repos` entries, and a link's `manifest`. Pure data, no sh, so it also runs on CI's Windows leg.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig } from '../lib/config.ts';
import { declaredLinks } from '../lib/links.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import { strategyOf } from '../lib/interim.ts';
import type { Config, Job } from '../lib/types.ts';

const REPOS = [{ name: 'lib', remote: 'https://example.com/lib.git', defaultBranch: 'main' }];
const link = (ecosystem: string, extra: Record<string, unknown> = {}) => ({ ecosystem, name: ecosystem === 'npm' ? '@acme/lib' : 'lib', ...extra });
const components = (l: Record<string, unknown>) => [
  { name: 'app', path: 'app', kind: 'app', dependsOn: [{ component: 'lib', type: 'build', link: l }] },
  { name: 'lib', repo: 'lib', path: '.', kind: 'library' },
];
const problems = (c: Record<string, unknown>) => validateConfig({ ...defaults(), repos: REPOS, components: components(link('cargo')), ...c }, process.cwd());
const noJob = { interim: null, repos: [] } as unknown as Job;

describe('interim strategies: config', { concurrency: 4 }, () => {
  test('v12 config migrates to v13 unchanged', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 21);
    const v12 = { schemaVersion: 12, repos: structuredClone(REPOS), components: components(link('npm')), aiAttribution: 'forbid' };
    const { config, from } = migrateConfig(structuredClone(v12));
    assert.equal(from, 12);
    assert.deepEqual(config, { ...v12, schemaVersion: 21, downstream: { enabled: true, max: 5, skip: [] } });
  });

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
    for (const [eco, manifest] of ok) assert.deepEqual(validateConfig({ ...defaults(), repos: REPOS, components: components(link(eco, { manifest })) }, process.cwd()), [], `${eco} ${manifest}`);
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
      const got = validateConfig({ ...defaults(), repos: REPOS, components: components(link(eco, { manifest })) }, process.cwd());
      assert.deepEqual(got, [`${at} must be a relative path inside the consumer's repo to ${what} (got ${JSON.stringify(manifest)})`], `${eco} ${manifest}`);
    }
    // The default manifest is the ecosystem's file in the consumer component's path; a set one wins.
    const [d] = declaredLinks({ components: components(link('cmake')) } as Config);
    assert.equal(d.manifest, 'app/CMakeLists.txt');
    const [m] = declaredLinks({ components: components(link('npm', { manifest: 'web/package.json' })) } as Config);
    assert.equal(m.manifest, 'web/package.json');
    assert.equal(declaredLinks({ components: components(link('npm', { manifest: '../package.json' })) } as Config).length, 0, 'an invalid manifest drops the link, as other invalid links are dropped');
  });
});
