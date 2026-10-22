// Secret references (docs/CONFIG.md "Secret references"): their validation, and each source
// (lib/secret-refs.ts) resolved in-process through a fake tool on PATH or a fixture, every failure
// closed without the value. The fakes are sh scripts; the CLI and doctor tests are in
// test/integration/cli/secrets.test.ts.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeBin, repoTemplate } from './helpers.ts';
import { defaults, validateConfig } from '../lib/core/config/load.ts';
import { declaredSecrets, secretRefProblems } from '../lib/core/config/validators/secret-refs.ts';
import { clearSecretMemo, dotenvValue, resolveSecret } from '../lib/secret-refs.ts';

const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `${re} not in:\n${problems.join('\n')}`);

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
});

const template = repoTemplate((dir) => {
  fs.writeFileSync(path.join(dir, '.gitignore'), '.secrets/\n');
  fs.writeFileSync(path.join(dir, 'tracked.env'), 'K=tracked-value-123\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'fixtures'], { cwd: dir, stdio: 'pipe' });
});

/** A scratch repo, a dir outside it, and fake tools (fakeBin) that record their argv and print a value (or fail). */
function scratch() {
  const repo = template();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-secret-outside-')));
  const fakes: string[] = [];
  const fake = (name: string, body: string) => {
    const b = fakeBin(name, body);
    fakes.push(b.dir);
    return b;
  };
  return {
    root: repo.dir,
    outside,
    fake,
    env: (extra: Record<string, string> = {}) => ({ ...process.env, PATH: [...fakes, process.env.PATH].join(path.delimiter), ...extra }),
    cleanup() {
      repo.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    },
  };
}

const val = () => `val-${crypto.randomBytes(8).toString('hex')}`;

describe('secret sources', { concurrency: 4 }, () => {
  test('resolves each source', () => {
    const x = scratch();
    try {
      clearSecretMemo();
      const v = { env: val(), sec: val(), tool: val(), op: val(), file: val(), key: val() };
      const security = x.fake('security', `printf '%s\\n' '${v.sec}'`);
      const secretTool = x.fake('secret-tool', `printf '%s' '${v.tool}'`);
      const op = x.fake('op', `printf '%s\\r\\n' '${v.op}'`);
      fs.mkdirSync(path.join(x.root, '.secrets'));
      fs.writeFileSync(path.join(x.root, '.secrets', 'whole'), `${v.file}\n`);
      fs.writeFileSync(path.join(x.root, '.secrets', 'dev.env'), `# comment\n\nOTHER=x\nexport LOCAL_KEY="${v.key}"\nQ='single quoted'\n`);
      const config = {
        secrets: {
          E: { env: 'FORGE_TEST_SRC_E' },
          MAC: { keychain: { service: 'svc', account: 'acct' } },
          LIN: { keychain: { service: 'svc', account: 'acct' } },
          OP: { op: 'op://v/i/f' },
          WHOLE: { file: '.secrets/whole' },
          KEYED: { file: '.secrets/dev.env', key: 'LOCAL_KEY' },
        },
      } as any;
      const env = x.env({ FORGE_TEST_SRC_E: `${v.env}\n` });
      assert.equal(resolveSecret(x.root, config, 'E', { env }), v.env);
      assert.equal(resolveSecret(x.root, config, 'MAC', { env, platform: 'darwin' }), v.sec);
      assert.equal(resolveSecret(x.root, config, 'LIN', { env, platform: 'linux' }), v.tool);
      assert.equal(resolveSecret(x.root, config, 'OP', { env }), v.op);
      assert.equal(resolveSecret(x.root, config, 'WHOLE', { env }), v.file);
      assert.equal(resolveSecret(x.root, config, 'KEYED', { env }), v.key);
      assert.deepEqual(security.calls(), [['find-generic-password', '-s', 'svc', '-a', 'acct', '-w']]);
      assert.deepEqual(secretTool.calls(), [['lookup', 'service', 'svc', 'account', 'acct']]);
      assert.deepEqual(op.calls(), [['read', 'op://v/i/f']]);
      // Once per process: a second read hits the memo, not the tool.
      assert.equal(resolveSecret(x.root, config, 'OP', { env }), v.op);
      assert.equal(op.calls().length, 1);
      assert.equal(dotenvValue("export Q='single quoted'\n", 'Q'), 'single quoted');
      assert.equal(dotenvValue('A=1\n', 'B'), null);
    } finally {
      x.cleanup();
    }
  });

  test('fails closed without the value in the error', () => {
    const x = scratch();
    try {
      clearSecretMemo();
      const v = val();
      const fails = (config: any, name: string, re: RegExp, opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}) => {
        assert.throws(
          () => resolveSecret(x.root, config, name, { env: x.env(), ...opts }),
          (e: Error) => {
            assert.match(e.message, re);
            assert.ok(e.message.includes(name), e.message);
            assert.ok(!e.message.includes(v), `the value leaked: ${e.message}`);
            return true;
          },
        );
      };
      fails({ secrets: { E: { env: 'FORGE_TEST_SRC_UNSET' } } }, 'E', /^secret E \(env\): FORGE_TEST_SRC_UNSET is not set$/);
      const op = x.fake('op', `printf '%s\\n' '${v}'\necho 'first line' >&2\necho '[ERROR] item not found' >&2\nexit 1`);
      fails({ secrets: { OP: { op: 'op://v/i/f' } } }, 'OP', /^secret OP \(op\) failed: op exited 1: \[ERROR\] item not found$/);
      // A missing tool: PATH holds only the fake op, and no real secret-tool.
      fails({ secrets: { LIN: { keychain: { service: 'svc' } } } }, 'LIN', /^secret LIN \(keychain\) failed: secret-tool could not run/, { platform: 'linux', env: { PATH: op.dir } });
      fails({ secrets: { KC: { keychain: { service: 'svc' } } } }, 'KC', /^secret KC: the keychain source is not supported on win32$/, { platform: 'win32' });
      fails({ secrets: { SHORT: { env: 'FORGE_TEST_SRC_SHORT' } } }, 'SHORT', /^secret SHORT \(env\) resolved to fewer than 8 characters; Forge can't redact a value that short$/, { env: { FORGE_TEST_SRC_SHORT: 'abc\n' } });
      fails({ secrets: { EMPTY: { env: 'FORGE_TEST_SRC_EMPTY' } } }, 'EMPTY', /resolved to fewer than 8 characters/, { env: { FORGE_TEST_SRC_EMPTY: '' } });
      // Files: tracked, not ignored, a symlink, a hard link, outside the root.
      fails({ secrets: { T: { file: 'tracked.env', key: 'K' } } }, 'T', /^secret T \(file\): tracked\.env must be git-ignored and untracked$/);
      fs.writeFileSync(path.join(x.root, 'loose.env'), `${v}\n`);
      fails({ secrets: { L: { file: 'loose.env' } } }, 'L', /^secret L \(file\): loose\.env must be git-ignored and untracked$/);
      fs.mkdirSync(path.join(x.root, '.secrets'));
      const outside = path.join(x.outside, 'outside.env');
      fs.writeFileSync(outside, `${v}\n`);
      fs.symlinkSync(outside, path.join(x.root, '.secrets', 'link'));
      fails({ secrets: { S: { file: '.secrets/link' } } }, 'S', /^secret S \(file\): \.secrets\/link is a symlink$/);
      fs.linkSync(outside, path.join(x.root, '.secrets', 'hard'));
      fails({ secrets: { H: { file: '.secrets/hard' } } }, 'H', /^secret H \(file\): \.secrets\/hard is a hard link$/);
      // A parent symlink out of the root, and a path with `..`.
      fs.symlinkSync(x.outside, path.join(x.root, '.secrets', 'dir'));
      fails({ secrets: { P: { file: '.secrets/dir/outside.env' } } }, 'P', /^secret P \(file\): \.secrets\/dir\/outside\.env resolves outside the repo$/);
      fails({ secrets: { U: { file: '../outside.env' } } }, 'U', /^secret U is invalid: secrets\.U\.file must be a relative path inside the repo/);
      fails({ secrets: {} }, 'NOPE', /^secret NOPE is not declared in secrets$/);
    } finally {
      x.cleanup();
    }
  });
});
