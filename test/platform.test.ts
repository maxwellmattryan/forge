// The support matrix (docs/SUPPORT.md): platform tiers, doctor's platform checks, the native Windows
// refusals and the POSIX sh resolver.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { doctor } from '../lib/doctor.ts';
import { SUPPORT_URL, platformTier, posixShell, versionAtLeast } from '../lib/platform.ts';
import type { HostInfo } from '../lib/platform.ts';
import { ForgeError } from '../lib/util.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

const host = (platform: NodeJS.Platform, procVersion: string | null = null): HostInfo => ({ platform, arch: 'x64', procVersion });
const DARWIN = host('darwin');
const WSL = host('linux', 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@1234) (gcc (GCC) 11.2.0) #1 SMP');
const WIN = host('win32');
/** Config that needs no gh, so doctor never calls the real one. */
const noGh = () => {
  const c = defaults();
  c.pr.enabled = false;
  return c;
};

test('SUPPORT.md exists and README Install and the bug form link it', () => {
  const support = read('docs/SUPPORT.md');
  for (const tier of ['**supported**', '**supported with notes**', '**unsupported**']) assert.ok(support.includes(tier), tier);
  for (const meaning of ['tested in CI on every PR', 'best effort', 'refused where it is known to break']) assert.ok(support.includes(meaning), meaning);
  for (const version of ['Node ≥ 22.18', '22.18.0 and the latest 24', 'git ≥ 2.38', 'gh ≥ 2.40']) assert.ok(support.includes(version), version);
  assert.match(support, /never under `\/mnt\/`/);
  assert.match(support, /\*\*Refused\*\*: the daemon .* and `forge update`/);
  assert.match(support, /POSIX `sh`/);
  assert.match(support, /Git Bash/);
  assert.equal(SUPPORT_URL, 'https://github.com/maxwellmattryan/forge/blob/main/docs/SUPPORT.md');

  const readme = read('README.md');
  const install = readme.slice(readme.indexOf('\n## Install\n'), readme.indexOf('\n## ', readme.indexOf('\n## Install\n') + 1));
  assert.ok(install.includes('[docs/SUPPORT.md](docs/SUPPORT.md)'), 'README Install links SUPPORT.md');
  assert.ok(install.includes('git ≥ 2.38') && install.includes('gh` ≥ 2.40'), 'README Install states the git and gh minimums');
  assert.ok(read('.github/ISSUE_TEMPLATE/bug_report.yml').includes(SUPPORT_URL), 'the bug form links SUPPORT.md');
});

test('platformTier classifies each platform', () => {
  assert.equal(platformTier(DARWIN), 'supported');
  assert.equal(platformTier(host('linux', 'Linux version 6.8.0-45-generic (buildd@lcy02) (gcc 13.2.0) #45-Ubuntu SMP')), 'supported');
  assert.equal(platformTier(host('linux', null)), 'supported', 'an unreadable /proc/version is plain Linux');
  assert.equal(platformTier(WSL), 'supported-with-notes');
  assert.equal(platformTier(host('linux', 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)')), 'supported-with-notes');
  assert.equal(platformTier(WIN), 'unsupported');
  assert.equal(platformTier(host('freebsd')), 'unsupported');
});

test('doctor puts the platform tier first', async () => {
  const repo = tempRepo();
  try {
    const config = noGh();
    for (const h of [DARWIN, WSL, WIN, host('freebsd'), host('linux')]) {
      const report = await doctor(repo.dir, config, false, h);
      assert.deepEqual(Object.keys(report), ['ok', 'checks']);
      assert.equal(report.checks[0].name, 'platform', h.platform);
    }
    const mac = (await doctor(repo.dir, config, false, DARWIN)).checks[0];
    assert.equal(mac.ok, true);
    assert.match(mac.detail, /^supported: macOS \(darwin x64\)$/);
    assert.match((await doctor(repo.dir, config, false, host('linux'))).checks[0].detail, /^supported: Linux/);
    const wsl = (await doctor(repo.dir, config, false, WSL)).checks[0];
    assert.equal(wsl.ok, true);
    assert.match(wsl.detail, /^supported with notes: WSL2/);
    const win = await doctor(repo.dir, config, false, WIN);
    assert.equal(win.ok, false, 'an unsupported platform fails doctor');
    assert.equal(win.checks[0].ok, false);
    assert.match(win.checks[0].detail, /^unsupported:/);
    assert.match(win.checks[0].detail, /daemon and forge update are refused/);
    assert.ok(win.checks[0].detail.endsWith(SUPPORT_URL), win.checks[0].detail);
    // On native Windows doctor also says whether the templates' sh resolves.
    const sh = win.checks.find((c) => c.name === 'POSIX sh (command templates)');
    assert.ok(sh, 'the sh check on win32');
    assert.equal(win.checks.indexOf(sh), 1);
    assert.equal((await doctor(repo.dir, config, false, DARWIN)).checks.some((c) => c.name === 'POSIX sh (command templates)'), false);
    const bsd = (await doctor(repo.dir, config, false, host('freebsd'))).checks[0];
    assert.equal(bsd.ok, false);
    assert.match(bsd.detail, /^unsupported:/);
    assert.ok(bsd.detail.endsWith(SUPPORT_URL));
  } finally {
    repo.cleanup();
  }
});

test('doctor warns about /mnt/ on WSL2 only', async () => {
  const NAME = 'repo on the Linux filesystem (WSL2)';
  const repo = tempRepo();
  try {
    const config = noGh();
    const check = async (root: string, cfg = config, h = WSL) => (await doctor(root, cfg, false, h)).checks.find((c) => c.name === NAME);

    const fine = await check(repo.dir);
    assert.ok(fine, 'the check is there on WSL');
    assert.equal(fine.ok, true);
    assert.equal((await doctor(repo.dir, config, false, WSL)).checks[1].name, NAME, 'right after the platform');

    // The repo itself on a Windows drive: its worktrees root (../{repo}.worktrees) is there too.
    const onC = await check('/mnt/c/Users/me/repo');
    assert.equal(onC?.ok, false);
    assert.ok(onC.detail.includes('/mnt/c/Users/me/repo'), onC.detail);
    assert.ok(onC.detail.includes('/mnt/c/Users/me/repo.worktrees'), onC.detail);
    assert.match(onC.detail, /Linux home/);
    assert.ok(onC.detail.endsWith(SUPPORT_URL));

    // Only the worktrees root on a Windows drive.
    const cfg = noGh();
    cfg.worktrees.root = '/mnt/d/worktrees/{repo}';
    const wt = await check(repo.dir, cfg);
    assert.equal(wt?.ok, false);
    assert.ok(wt.detail.startsWith(`/mnt/d/worktrees/${path.basename(repo.dir)} under /mnt/`), wt.detail);
    assert.ok(!wt.detail.includes(fs.realpathSync(repo.dir) + ','), 'the repo itself is not named');

    // A path that merely contains /mnt/ is not on a Windows drive.
    const nested = noGh();
    nested.worktrees.root = path.join(repo.dir, 'mnt', 'x');
    assert.equal((await check(repo.dir, nested))?.ok, true);

    assert.equal(await check('/mnt/c/Users/me/repo', config, DARWIN), undefined, 'absent on darwin');
    assert.equal(await check('/mnt/c/Users/me/repo', config, host('linux')), undefined, 'absent on plain Linux');
  } finally {
    repo.cleanup();
  }
});

test('versionAtLeast and the git/gh minimums', POSIX, async () => {
  assert.equal(versionAtLeast('git version 2.39.5 (Apple Git-154)', [2, 38]), true);
  assert.equal(versionAtLeast('git version 2.45.1.windows.1', [2, 38]), true);
  assert.equal(versionAtLeast('gh version 2.40.0 (2023-12-07)\nhttps://github.com/cli/cli/releases/tag/v2.40.0', [2, 40]), true);
  assert.equal(versionAtLeast('git version 2.37.9', [2, 38]), false);
  assert.equal(versionAtLeast('git version 2.38.0', [2, 38]), true);
  assert.equal(versionAtLeast('git version 3.0.0', [2, 38]), true);
  assert.equal(versionAtLeast('gh version 2.4.0', [2, 40]), false, '2.4 is older than 2.40');
  assert.equal(versionAtLeast('gh version 1.99.0', [2, 40]), false);
  for (const garbage of ['', 'git version', 'not a version', 'v2', '2.']) assert.equal(versionAtLeast(garbage, [2, 38]), false, garbage);
  assert.equal(versionAtLeast(`${'1'.repeat(10_000)}x`, [2, 38]), false, 'a long hostile line');

  const repo = tempRepo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gh-'));
  const PATH = process.env.PATH;
  try {
    const names = (r: { checks: { name: string }[] }) => r.checks.map((c) => c.name);
    const plain = await doctor(repo.dir, noGh(), false, DARWIN);
    const git = plain.checks.find((c) => c.name === 'git >= 2.38');
    assert.ok(git, 'the git check names its minimum');
    assert.match(git.detail, /^git version \d+\.\d+/);
    assert.ok(!names(plain).includes('git'));
    assert.ok(!names(plain).includes('gh >= 2.40'), 'no gh check when gh is not needed');

    const needsGh = defaults();
    assert.equal(needsGh.pr.enabled, true);
    // A gh stub first on PATH: an old one, then a current one.
    const stub = (version: string) => {
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1" = --version ]; then echo "gh version ${version} (2023-12-07)"; else echo "Logged in"; fi\n`, { mode: 0o755 });
    };
    process.env.PATH = `${bin}${path.delimiter}${PATH}`;
    stub('2.39.1');
    const old = await doctor(repo.dir, needsGh, false, DARWIN);
    const auth = names(old).indexOf('gh installed + authenticated');
    assert.ok(auth !== -1);
    assert.equal(old.checks[auth + 1].name, 'gh >= 2.40', 'right after the auth check');
    assert.equal(old.checks[auth + 1].ok, false);
    assert.equal(old.checks[auth + 1].detail, 'gh version 2.39.1 (2023-12-07)');
    stub('2.40.0');
    assert.equal((await doctor(repo.dir, needsGh, false, DARWIN)).checks[auth + 1].ok, true);

    // gh needed but not installed: only the existing auth check, failing.
    fs.rmSync(path.join(bin, 'gh'));
    process.env.PATH = bin;
    const missing = await doctor(repo.dir, needsGh, false, DARWIN);
    assert.ok(names(missing).includes('gh installed + authenticated'));
    assert.ok(!names(missing).includes('gh >= 2.40'), 'no version check without gh');
  } finally {
    process.env.PATH = PATH;
    fs.rmSync(bin, { recursive: true, force: true });
    repo.cleanup();
  }
});
