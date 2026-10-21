// Secret references (docs/CONFIG.md "Secret references"): validation, `forge secrets list|check` and
// the doctor check. Platform-neutral: nothing here runs a shell script.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { defaults, validateConfig } from '../lib/config.ts';
import { secretsCheck } from '../lib/doctor.ts';
import { declaredSecrets, secretRefProblems } from '../lib/secret-refs-config.ts';
import * as yaml from '../lib/yaml.ts';

const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `${re} not in:\n${problems.join('\n')}`);

const template = repoTemplate((dir) => {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', '.gitignore'), 'jobs/\nlocks/\nruntime/\n');
});

function scratch(secrets: unknown) {
  const repo = template();
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify({ tracker: { kind: 'none' }, pr: { enabled: false }, secrets }));
  return repo;
}

describe('secret references', { concurrency: 4 }, () => {
  test('validation reports each malformed secret entry', () => {
    const good = {
      DB_PASSWORD: { env: 'MYAPP_DB_PASSWORD' },
      STRIPE_KEY: { keychain: { service: 'myapp-dev', account: 'stripe' } },
      ONLY_SERVICE: { keychain: { service: 'svc.name@host:1/x +y' } },
      API_TOKEN: { op: 'op://Dev/myapp/token' },
      LOCAL_KEY: { file: '.secrets/dev.env', key: 'LOCAL_KEY' },
      WHOLE: { file: '.secrets/whole' },
    };
    assert.deepEqual(secretRefProblems({ secrets: good }), []);
    assert.deepEqual(validateConfig({ ...defaults(), secrets: good }, process.cwd()), []);
    assert.deepEqual(secretRefProblems({}), []);
    assert.deepEqual(secretRefProblems({ secrets: {} }), []);
    has(secretRefProblems({ secrets: ['x'] }), /^secrets must be a map of secret names to sources \(got a list\)/);
    const bad = secretRefProblems({
      secrets: {
        'bad-name': { env: 'X_Y' },
        NONE: {},
        TWO: { env: 'A', op: 'op://v/i/f' },
        EXTRA: { env: 'A', what: 1 },
        BAD_ENV: { env: 'not-a-name' },
        DASH: { keychain: { service: '-s' } },
        CHAR: { keychain: { service: 'svc', account: 'a;b' } },
        NO_SVC: { keychain: { account: 'a' } },
        KC_KEY: { keychain: { service: 's', other: 'x' } },
        OP: { op: 'https://vault/item' },
        OP_SPACE: { op: 'op://v/i f' },
        ABS: { file: '/etc/passwd' },
        UP: { file: '../outside.env' },
        KEY: { file: '.secrets/dev.env', key: 'not-env' },
        KEY_ON_ENV: { env: 'A', key: 'B' },
        SCALAR: 'op://v/i/f',
      },
    });
    has(bad, /^secrets\."bad-name" is not a valid secret name/);
    has(bad, /^secrets\.NONE must have exactly one of env \| keychain \| op \| file \(got none\)/);
    has(bad, /^secrets\.TWO must have exactly one of env \| keychain \| op \| file \(got env, op\)/);
    has(bad, /^secrets\.EXTRA has unknown key "what"/);
    has(bad, /^secrets\.BAD_ENV\.env must be an environment variable name/);
    has(bad, /^secrets\.DASH\.keychain\.service must be 1–128 characters .* must not start with -/);
    has(bad, /^secrets\.CHAR\.keychain\.account must be 1–128 characters/);
    has(bad, /^secrets\.NO_SVC\.keychain\.service is required/);
    has(bad, /^secrets\.KC_KEY\.keychain has unknown key "other"/);
    has(bad, /^secrets\.OP\.op must be a 1Password reference/);
    has(bad, /^secrets\.OP_SPACE\.op must be a 1Password reference/);
    has(bad, /^secrets\.ABS\.file must be a relative path inside the repo/);
    has(bad, /^secrets\.UP\.file must be a relative path inside the repo/);
    has(bad, /^secrets\.KEY\.key must be a variable name/);
    has(bad, /^secrets\.KEY_ON_ENV\.key is only for a file source/);
    has(bad, /^secrets\.SCALAR must be a map with exactly one of/);
    // A problem never echoes a field's value: it may be a pasted credential.
    for (const p of bad) assert.doesNotMatch(p, /https:\/\/vault|a;b|not-a-name|\/etc\/passwd|op:\/\/v\/i/, p);
    // An own `__proto__` key, as a parser can produce: a record keyed by it would drop the value.
    const reserved = secretRefProblems({ secrets: JSON.parse('{"__proto__": {"env": "A"}, "constructor": {"env": "A"}, "prototype": {"env": "A"}}') });
    for (const n of ['__proto__', 'constructor', 'prototype']) has(reserved, new RegExp(`^secrets\\.${n} is reserved`));
    assert.deepEqual([...declaredSecrets({ secrets: JSON.parse('{"__proto__": {"env": "A"}, "OK": {"env": "A"}}') })], ['OK']);
  });

  test('an undeclared {secret.NAME} in a sink is a validation problem', () => {
    const component = (env: Record<string, string>) => ({ name: 'api', path: 'api', kind: 'service', config: [{ env }] });
    const c = { ...defaults(), secrets: { DB_PASS: { env: 'MYAPP_DB_PASS' } } };
    assert.deepEqual(validateConfig({ ...c, components: [component({ DB: '{secret.DB_PASS}' })] }, process.cwd()), []);
    const problems = validateConfig({ ...c, components: [component({ DB: 'x-{secret.NOPE}' })] }, process.cwd());
    has(problems, /^components "api"\.config\[0\]\.env\.DB names undeclared secret \{secret\.NOPE\}; declare it under secrets/);
    // With no secrets declared at all, any reference is undeclared.
    has(validateConfig({ ...defaults(), components: [component({ DB: '{secret.DB_PASS}' })] }, process.cwd()), /names undeclared secret \{secret\.DB_PASS\}/);
  });

  test('secrets list and check', async () => {
    const value = `v-${crypto.randomBytes(8).toString('hex')}`;
    const repo = scratch({ GOOD: { env: 'FORGE_TEST_SECRET_GOOD' }, MISSING: { env: 'FORGE_TEST_SECRET_MISSING' }, API: { op: 'op://v/i/f' } });
    try {
      const env = { FORGE_TEST_SECRET_GOOD: value, FORGE_TEST_SECRET_MISSING: undefined };
      const list = await forgeAsync(repo.dir, ['secrets', 'list'], env);
      assert.equal(list.status, 0, list.stderr);
      assert.deepEqual(JSON.parse(list.stdout), { secrets: [{ name: 'GOOD', source: 'env' }, { name: 'MISSING', source: 'env' }, { name: 'API', source: 'op' }] });
      const ok = await forgeAsync(repo.dir, ['secrets', 'check', 'GOOD'], env);
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(JSON.parse(ok.stdout), { secrets: [{ name: 'GOOD', source: 'env', ok: true }] });
      const all = await forgeAsync(repo.dir, ['secrets', 'check', 'GOOD', 'MISSING'], env);
      assert.equal(all.status, 1);
      assert.deepEqual(JSON.parse(all.stdout).secrets[1], { name: 'MISSING', source: 'env', ok: false, error: 'secret MISSING (env): FORGE_TEST_SECRET_MISSING is not set' });
      for (const r of [list, ok, all]) {
        assert.doesNotMatch(r.stdout + r.stderr, new RegExp(value));
        assert.doesNotMatch(r.stdout, /length|"len"/);
      }
      const unknown = await forgeAsync(repo.dir, ['secrets', 'check', 'NOPE'], env);
      assert.equal(unknown.status, 2);
      assert.match(unknown.stderr, /not a declared secret: "NOPE"/);
    } finally {
      repo.cleanup();
    }
  });

  test('doctor never reads a value', async () => {
    const repo = scratch({ API: { op: 'op://v/i/f' }, UNSET: { env: 'FORGE_TEST_SECRET_UNSET' }, KC: { keychain: { service: 'svc' } } });
    const bin = path.join(repo.dir, '..', `${path.basename(repo.dir)}-bin`);
    try {
      fs.mkdirSync(bin);
      const calls = path.join(bin, 'calls');
      for (const tool of ['op', 'security', 'secret-tool']) {
        fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(calls)}\necho value-from-${tool}\n`, { mode: 0o755 });
      }
      const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FORGE_TEST_SECRET_UNSET: undefined };
      const config = { ...defaults(), secrets: { API: { op: 'op://v/i/f' }, UNSET: { env: 'FORGE_TEST_SECRET_UNSET' }, KC: { keychain: { service: 'svc' } } } } as any;
      const c = secretsCheck(repo.dir, config, { env, platform: 'win32' })!;
      assert.equal(c.name, 'secrets');
      assert.equal(c.ok, true);
      assert.equal(c.warn, true);
      assert.match(c.detail, /^3 declared; /);
      assert.match(c.detail, /UNSET \(env\): FORGE_TEST_SECRET_UNSET is not set/);
      assert.match(c.detail, /KC \(keychain\): not supported on win32/);
      assert.equal(secretsCheck(repo.dir, defaults()), null);
      const r = await forgeAsync(repo.dir, ['doctor'], env);
      const report = JSON.parse(r.stdout);
      const check = report.checks.find((x: any) => x.name === 'secrets');
      assert.match(check.detail, /^3 declared/);
      assert.doesNotMatch(r.stdout, /value-from-/);
      assert.equal(fs.existsSync(calls), false, 'no source tool was run');
    } finally {
      repo.cleanup();
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});
