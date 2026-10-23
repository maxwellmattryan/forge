// Every secret source fails closed, and its error names the secret but never carries the value. Kept
// through the test rewrite (docs/test-rewrite/README.md): the security posture AGENTS.md says to preserve.
// The fakes are sh scripts on PATH (fakeBin).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeBin, repoTemplate } from '../../../test/helpers.ts';
import { clearSecretMemo, resolveSecret } from './secret-refs.ts';

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
