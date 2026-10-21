// Secret sources (lib/secret-refs.ts): each source through a fake tool on PATH or a fixture, and
// every failure closed without the value. The fakes are sh scripts.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoTemplate } from './helpers.ts';
import { clearSecretMemo, dotenvValue, resolveSecret } from '../lib/secret-refs.ts';

const template = repoTemplate((dir) => {
  fs.writeFileSync(path.join(dir, '.gitignore'), '.secrets/\n');
  fs.writeFileSync(path.join(dir, 'tracked.env'), 'K=tracked-value-123\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'fixtures'], { cwd: dir, stdio: 'pipe' });
});

/** A scratch repo and a bin dir of fakes that record their argv and print `value` (or fail). */
function scratch() {
  const repo = template();
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(repo.dir), 'forge-secret-bin-')));
  const calls = path.join(bin, 'calls');
  const fake = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> ${JSON.stringify(calls)}\n${body}\n`, { mode: 0o755 });
  return {
    root: repo.dir,
    bin,
    fake,
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []),
    env: (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extra }),
    cleanup() {
      repo.cleanup();
      fs.rmSync(bin, { recursive: true, force: true });
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
      x.fake('security', `printf '%s\\n' '${v.sec}'`);
      x.fake('secret-tool', `printf '%s' '${v.tool}'`);
      x.fake('op', `printf '%s\\r\\n' '${v.op}'`);
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
      assert.deepEqual(x.calls(), ['security find-generic-password -s svc -a acct -w', 'secret-tool lookup service svc account acct', 'op read op://v/i/f']);
      // Once per process: a second read hits the memo, not the tool.
      assert.equal(resolveSecret(x.root, config, 'OP', { env }), v.op);
      assert.equal(x.calls().length, 3);
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
      x.fake('op', `printf '%s\\n' '${v}'\necho 'first line' >&2\necho '[ERROR] item not found' >&2\nexit 1`);
      fails({ secrets: { OP: { op: 'op://v/i/f' } } }, 'OP', /^secret OP \(op\) failed: op exited 1: \[ERROR\] item not found$/);
      // A missing tool: PATH without the fakes and without any real secret-tool.
      fails({ secrets: { LIN: { keychain: { service: 'svc' } } } }, 'LIN', /^secret LIN \(keychain\) failed: secret-tool could not run/, { platform: 'linux', env: { PATH: x.bin } });
      fails({ secrets: { KC: { keychain: { service: 'svc' } } } }, 'KC', /^secret KC: the keychain source is not supported on win32$/, { platform: 'win32' });
      fails({ secrets: { SHORT: { env: 'FORGE_TEST_SRC_SHORT' } } }, 'SHORT', /^secret SHORT \(env\) resolved to fewer than 8 characters; Forge can't redact a value that short$/, { env: { FORGE_TEST_SRC_SHORT: 'abc\n' } });
      fails({ secrets: { EMPTY: { env: 'FORGE_TEST_SRC_EMPTY' } } }, 'EMPTY', /resolved to fewer than 8 characters/, { env: { FORGE_TEST_SRC_EMPTY: '' } });
      // Files: tracked, not ignored, a symlink, a hard link, outside the root.
      fails({ secrets: { T: { file: 'tracked.env', key: 'K' } } }, 'T', /^secret T \(file\): tracked\.env must be git-ignored and untracked$/);
      fs.writeFileSync(path.join(x.root, 'loose.env'), `${v}\n`);
      fails({ secrets: { L: { file: 'loose.env' } } }, 'L', /^secret L \(file\): loose\.env must be git-ignored and untracked$/);
      fs.mkdirSync(path.join(x.root, '.secrets'));
      const outside = path.join(x.bin, 'outside.env');
      fs.writeFileSync(outside, `${v}\n`);
      fs.symlinkSync(outside, path.join(x.root, '.secrets', 'link'));
      fails({ secrets: { S: { file: '.secrets/link' } } }, 'S', /^secret S \(file\): \.secrets\/link is a symlink$/);
      fs.linkSync(outside, path.join(x.root, '.secrets', 'hard'));
      fails({ secrets: { H: { file: '.secrets/hard' } } }, 'H', /^secret H \(file\): \.secrets\/hard is a hard link$/);
      // A parent symlink out of the root, and a path with `..`.
      fs.symlinkSync(x.bin, path.join(x.root, '.secrets', 'dir'));
      fails({ secrets: { P: { file: '.secrets/dir/outside.env' } } }, 'P', /^secret P \(file\): \.secrets\/dir\/outside\.env resolves outside the repo$/);
      fails({ secrets: { U: { file: '../outside.env' } } }, 'U', /^secret U is invalid: secrets\.U\.file must be a relative path inside the repo/);
      fails({ secrets: {} }, 'NOPE', /^secret NOPE is not declared in secrets$/);
    } finally {
      x.cleanup();
    }
  });
});
