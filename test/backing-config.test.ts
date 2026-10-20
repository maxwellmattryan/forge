// backing: config (issue #193): validation of each entry, the default, and the v18 -> v19 migration.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backingProblems } from '../lib/backing-config.ts';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { tempRepo } from './helpers.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';

const EXAMPLE = [
  {
    name: 'postgres',
    isolation: 'per-job',
    image: 'postgres:16',
    ports: [5432],
    env: { POSTGRES_PASSWORD: 'forge', POSTGRES_DB: 'app' },
    volumes: ['/var/lib/postgresql/data'],
    url: 'postgres://postgres:forge@{host}:{port}/app',
  },
  { name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] },
  { name: 'queue', isolation: 'external', url: 'amqp://mq.internal:5672' },
];
const pg = EXAMPLE[0];
const problems = (backing: unknown, extra: Record<string, unknown> = {}) => backingProblems({ backing, ...extra });

describe('backing config', { concurrency: 4 }, () => {
  test('backing validation', () => {
    assert.deepEqual(problems(EXAMPLE), [], 'the example config is valid');
    assert.deepEqual(backingProblems({}), [], 'absent is fine');
    assert.deepEqual(problems([]), []);
    assert.deepEqual(validateConfig({ ...defaults(), backing: EXAMPLE }, process.cwd()), []);
    assert.deepEqual(problems('x'), ['backing must be a list (got a string)']);
    const cases: [unknown, string][] = [
      ['x', 'backing[0] must be a map with name and isolation'],
      [{ ...pg, name: 'Postgres' }, 'backing[0].name must match ^[a-z][a-z0-9-]{0,31}$ (got "Postgres")'],
      [{ ...pg, name: undefined }, 'backing[0].name must match ^[a-z][a-z0-9-]{0,31}$ (got nothing)'],
      [{ ...pg, isolation: undefined }, 'backing[0].isolation must be one of per-job | shared | external (got nothing)'],
      [{ ...pg, isolation: 'global' }, 'backing[0].isolation must be one of per-job | shared | external (got "global")'],
      [{ ...pg, image: '--privileged' }, 'backing[0].image must be an image reference matching ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$ (got "--privileged")'],
      [{ ...pg, image: undefined }, 'backing[0].image must be an image reference matching ^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$ (got nothing)'],
      [{ ...pg, ports: [0] }, 'backing[0].ports[0] must be an integer from 1 to 65535 (got 0)'],
      [{ ...pg, ports: [70000] }, 'backing[0].ports[0] must be an integer from 1 to 65535 (got 70000)'],
      [{ ...pg, ports: [5432, 5432] }, 'backing[0].ports[1] repeats 5432'],
      [{ ...pg, ports: [1, 2, 3, 4, 5, 6, 7, 8, 9], url: undefined }, 'backing[0].ports must be a list of at most 8 ports (got [1,2,3,4,5,6,7,8,9])'],
      [{ ...pg, env: { '1X': 'a' } }, 'backing[0].env key "1X" must match ^[A-Za-z_][A-Za-z0-9_]*$'],
      [{ ...pg, env: { A: 'x\ny' } }, 'backing[0].env.A must not contain a NUL, CR or LF'],
      [{ ...pg, env: { A: { b: 1 } } }, 'backing[0].env.A must be a string, number or boolean'],
      [{ ...pg, volumes: ['data'] }, 'backing[0].volumes[0] must be an absolute container path of letters, digits and ._/- with no .. segment (got "data")'],
      [{ ...pg, volumes: ['/a/../b'] }, 'backing[0].volumes[0] must be an absolute container path of letters, digits and ._/- with no .. segment (got "/a/../b")'],
      [{ name: 'q', isolation: 'external' }, 'backing[0].url is required for an external entry'],
      [{ name: 'q', isolation: 'external', url: 'a b' }, 'backing[0].url must be a non-empty string of at most 500 characters with no whitespace or control characters (got a string)'],
      [{ name: 'q', isolation: 'external', url: 'amqp://x', image: 'rabbitmq' }, 'backing[0].image is only for a per-job or shared entry'],
      [{ ...pg, url: 'postgres://{host}:{port_9999}/app' }, 'backing[0].url placeholder {port_9999} is not {host}, {port} or {port_<n>} for a port in ports'],
      [{ ...pg, ports: [], url: 'x://{host}:{port}' }, 'backing[0].url uses {port} but the entry has no ports'],
      [{ ...pg, command: 'sh' }, 'backing[0] has unknown key "command"'],
    ];
    for (const [entry, message] of cases) assert.deepEqual(problems([entry]), [message], JSON.stringify(entry));
    assert.deepEqual(problems([pg, { ...pg }]), ['backing[1].name repeats backing[0].name "postgres"']);
    assert.ok(!problems([{ ...pg, env: { A: 'x\ny' } }]).some((p) => p.includes('x\ny')), 'an env value never shows in a problem');
    // A url or a non-list backing value can hold credentials: problems name the field, never the value.
    const cred = ['hunter', '2'].join('');
    const leaks: unknown[] = [
      `postgres://u:${cred}@db`,
      [{ name: 'q', isolation: 'external', url: `amqp://u:${cred}@mq x` }],
      [{ name: 'q', isolation: 'external', url: `amqp://u:${cred}@mq`.padEnd(600, 'x') }],
      [{ name: 'q', isolation: 'external', url: { password: cred } }],
      [{ ...pg, url: `postgres://u:${cred}@{host}:{port} ` }],
      [{ ...pg, url: `postgres://{host}:{port}/{user:${cred}}` }],
      { url: `x://${cred}` },
    ];
    for (const backing of leaks) {
      const found = problems(backing);
      assert.equal(found.length, 1, JSON.stringify(backing));
      assert.ok(!found.some((p) => p.includes(cred)), found.join('; '));
    }
    assert.deepEqual(problems({ url: `x://${cred}` }), ['backing must be a list (got a map)']);
    assert.match(problems([{ ...pg, url: `postgres://{host}:{port}/{user:${cred}}` }])[0], /^backing\[0\]\.url placeholder \(not shown\) is not/);
    // dependsOn backing edges name a declared entry once backing is non-empty.
    const components = [{ name: 'api', kind: 'service', path: '.', dependsOn: [{ backing: 'postgres', type: 'runtime' }, { backing: 'mysql', type: 'runtime' }] }];
    assert.deepEqual(problems(EXAMPLE, { components }), ['components[0].dependsOn[1].backing names no backing entry "mysql"']);
    assert.deepEqual(problems([], { components }), [], 'with no backing entries, edges are only shape-checked');
  });

  test('v18 config migrates to v19 with no backing', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 21);
    assert.deepEqual(defaults().backing, []);
    const v18 = { schemaVersion: 18, git: { base: 'trunk' }, components: [], repos: [], downstream: { enabled: true, max: 5, skip: [] } };
    const { config, from } = migrateConfig(structuredClone(v18));
    assert.equal(from, 18);
    assert.deepEqual(config, { ...v18, schemaVersion: 21 }, 'migration 18 changes nothing but schemaVersion');
    const repo = tempRepo();
    try {
      const cfg = path.join(repo.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, 'schemaVersion: 18\n');
      const loaded = loadConfig(repo.dir);
      assert.equal(loaded.migratedFrom, 18);
      assert.equal(loaded.config.schemaVersion, 21);
      assert.deepEqual(loaded.config.backing, []);
    } finally {
      repo.cleanup();
    }
  });
});
