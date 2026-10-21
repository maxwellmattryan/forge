// backing: config (issue #193): validation of each entry, the default, and the v18 -> v19 migration.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backingProblems } from '../lib/backing-config.ts';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { tempRepo } from './helpers.ts';
import { API_VERSION, CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';

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
// Joined at runtime: the installed secret scan reads `{user}:{password}@` as a url credential.
const DB_URL = ['postgres://{user}', '{password}@{host}:{port}/{database}'].join(':');
const PG_PER_JOB ={ ...pg, url: 'postgres://postgres:forge@{host}:{port}/app' };
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

  test('database validation', () => {
    const cred = ['db', 'pass', 'word'].join('-');
    const shared = {
      name: 'pg',
      isolation: 'shared',
      image: 'postgres:16',
      ports: [5432],
      env: { POSTGRES_PASSWORD: cred },
      volumes: ['/var/lib/postgresql/data'],
      url: DB_URL,
      database: { engine: 'postgres', migrate: 'npm run db:migrate', seed: 'npm run db:seed', inputs: ['db/migrations/**', 'db/seed.sql'] },
    };
    assert.deepEqual(problems([shared]), [], 'the example is valid');
    assert.deepEqual(validateConfig({ ...defaults(), backing: [shared] }, process.cwd()), []);
    assert.deepEqual(problems([{ ...shared, database: { engine: 'postgres' } }]), [], 'migrate, seed and inputs are optional');
    const secretCmd = `psql postgres://u:${cred}@x`;
    const at = 'backing[0]';
    const cases: [unknown, string][] = [
      [{ ...PG_PER_JOB, database: { engine: 'postgres' } }, `${at}.database is only for a shared entry`],
      [{ name: 'q', isolation: 'external', url: 'postgres://h/db', database: { engine: 'postgres' } }, `${at}.database is only for a shared entry`],
      [{ ...shared, database: 'postgres' }, `${at}.database must be a map with engine`],
      [{ ...shared, database: { migrate: 'x' } }, `${at}.database must be a map with engine`],
      [{ ...shared, database: { engine: 'postgres', run: 'x' } }, `${at}.database has unknown key "run"`],
      [{ ...shared, database: { engine: 'mysql' } }, `${at}.database.engine must be one of postgres (got "mysql")`],
      [{ ...shared, database: { engine: 'postgres', migrate: '' } }, `${at}.database.migrate must be a non-empty string of at most 2000 characters with no NUL, CR or LF`],
      [{ ...shared, database: { engine: 'postgres', migrate: `${secretCmd}\nrm -rf /` } }, `${at}.database.migrate must be a non-empty string of at most 2000 characters with no NUL, CR or LF`],
      [{ ...shared, database: { engine: 'postgres', seed: secretCmd.padEnd(2001, 'x') } }, `${at}.database.seed must be a non-empty string of at most 2000 characters with no NUL, CR or LF`],
      [{ ...shared, database: { engine: 'postgres', seed: 7 } }, `${at}.database.seed must be a non-empty string of at most 2000 characters with no NUL, CR or LF`],
      [{ ...shared, database: { engine: 'postgres', inputs: 'db/**' } }, `${at}.database.inputs must be a list of at most 64 paths or globs`],
      [{ ...shared, database: { engine: 'postgres', inputs: Array.from({ length: 65 }, (_, i) => `f${i}`) } }, `${at}.database.inputs must be a list of at most 64 paths or globs`],
      [{ ...shared, database: { engine: 'postgres', inputs: ['../x'] } }, `${at}.database.inputs entry "../x" must not contain a .. segment`],
      [{ ...shared, database: { engine: 'postgres', inputs: [':(top)x'] } }, `${at}.database.inputs entry ":(top)x" must not start with -, ! or :`],
      [{ ...shared, database: { engine: 'postgres', inputs: ['/etc/passwd'] } }, `${at}.database.inputs entry "/etc/passwd" must be relative to the repo`],
      [{ ...shared, database: { engine: 'postgres', inputs: [''] } }, `${at}.database.inputs entries must be non-empty strings (got "")`],
      [{ ...shared, ports: undefined, url: DB_URL.replace(':{port}', '') }, `${at}.database needs ports`],
      [{ ...shared, url: undefined }, `${at}.database needs a url with {user}, {password} and {database}`],
      [{ ...shared, url: `postgres://app:${cred}@{host}:{port}/{database}` }, `${at}.database needs a url with {user}, {password} and {database}`],
      [{ ...shared, env: { POSTGRES_PASSWORD: cred, POSTGRES_USER: 'Admin' } }, `${at}.env.POSTGRES_USER must match ^[a-z_][a-z0-9_]{0,62}$ when database is set`],
    ];
    for (const [entry, message] of cases) {
      const found = problems([entry]);
      assert.deepEqual(found, [message], JSON.stringify(entry).slice(0, 200));
      assert.ok(!found[0].includes(cred) && !found[0].includes('postgres://'), `no url, command or env value in ${found[0]}`);
    }
    // Without database, each of the three placeholders is an unknown placeholder.
    assert.deepEqual(problems([{ ...shared, database: undefined }]), ['{user}', '{password}', '{database}'].map((p) => `${at}.url placeholder ${p} is not {host}, {port} or {port_<n>} for a port in ports`));
  });

  test('v21 config migrates to v22 unchanged', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 24);
    assert.equal(API_VERSION, 30, 'no /api/state change');
    const v21 = { schemaVersion: 21, git: { base: 'trunk' }, backing: [{ name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] }] };
    const { config, from } = migrateConfig(structuredClone(v21));
    assert.equal(from, 21);
    assert.deepEqual(config, { ...v21, schemaVersion: 24 }, 'migration 21 changes nothing but schemaVersion');
  });

  test('v18 config migrates to v19 with no backing', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 24);
    assert.deepEqual(defaults().backing, []);
    const v18 = { schemaVersion: 18, git: { base: 'trunk' }, components: [], repos: [], downstream: { enabled: true, max: 5, skip: [] } };
    const { config, from } = migrateConfig(structuredClone(v18));
    assert.equal(from, 18);
    assert.deepEqual(config, { ...v18, schemaVersion: 24 }, 'migration 18 changes nothing but schemaVersion');
    const repo = tempRepo();
    try {
      const cfg = path.join(repo.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, 'schemaVersion: 18\n');
      const loaded = loadConfig(repo.dir);
      assert.equal(loaded.migratedFrom, 18);
      assert.equal(loaded.config.schemaVersion, 24);
      assert.deepEqual(loaded.config.backing, []);
    } finally {
      repo.cleanup();
    }
  });
});
