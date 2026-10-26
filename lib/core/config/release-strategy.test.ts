// The release strategy's validation and doctor's mechanism check (docs/CONFIG.md "Release strategy"), for the
// script mechanism: release.script is a path inside the repo that can't be read as a node option, and doctor
// only looks for node, git, gh and the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults } from './load.ts';
import { validateConfig } from './validate.ts';
import { releaseMechanismCheck } from './release-strategy.ts';
import type { Config } from '../types.ts';

const REPO = { name: 'lib', remote: 'git@github.com:acme/lib.git', defaultBranch: 'main' };
const MECHANISMS = 'release-please | cargo-release | changesets | tag | script';

/** The release problems of a config whose root (`at: 'release'`) or member (`at: 'repos'`) release is `release`. */
function problems(where: 'release' | 'repos', release: Record<string, unknown>): string[] {
  const base = defaults() as Config;
  const config = where === 'release' ? { ...base, release: { ...base.release, ...release } } : { ...base, repos: [{ ...REPO, release }] };
  return validateConfig(config as Config, os.tmpdir()).filter((p) => /release/.test(p));
}

test('release.script validation', () => {
  for (const where of ['release', 'repos'] as const) {
    const at = where === 'release' ? 'release' : 'repos "lib".release';
    for (const script of ['scripts/release.ts', 'release.mjs', 'tools/rel_ease-1.2/run.js', 'a'.repeat(200)])
      assert.deepEqual(problems(where, { mechanism: 'script', script }), [], `${where}: ${script}`);
    const bad: unknown[] = [undefined, null, 7, '', 'a'.repeat(201), '/etc/release.ts', './release.ts', 'scripts/./release.ts', '../release.ts', 'scripts/../release.ts', 'scripts//release.ts', 'scripts/', '-r/x.js', '--require=x.js', 'scripts/release ts', 'scripts\\release.ts', 'release.ts;rm', 'C:/release.ts', 'scripts/release.ts\n'];
    for (const script of bad) {
      const got = problems(where, { mechanism: 'script', ...(script === undefined ? {} : { script }) });
      assert.equal(got.length, 1, `${where}: ${JSON.stringify(script)} gives one message: ${got.join('; ')}`);
      assert.ok(got[0].startsWith(`${at}.script must be a relative path inside the repo of at most 200 characters, using letters, digits and . _ / - (got `), `${where}: ${JSON.stringify(script)}: ${got[0]}`);
    }
    for (const mechanism of ['tag', 'changesets', 'release-please', 'cargo-release']) {
      const extra = mechanism === 'tag' ? { command: 'git tag v1' } : {};
      assert.deepEqual(problems(where, { mechanism, ...extra, script: 'scripts/release.ts' }), [`${at}.script is only read when mechanism is script; remove it or set mechanism: script`], `${where}: ${mechanism}`);
    }
    assert.deepEqual(problems(where, { mechanism: 'npm' }), [`${at}.mechanism must be one of ${MECHANISMS} (got "npm")`]);
  }
});

test("doctor checks the script mechanism's tools and file", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-doctor-')));
  try {
    const bin = path.join(dir, 'bin');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    // The script itself need not be executable: node reads it. It must never run.
    const marker = path.join(dir, 'ran');
    fs.writeFileSync(path.join(repo, 'scripts', 'release.ts'), `require('fs').writeFileSync(${JSON.stringify(marker)}, '')\n`, { mode: 0o644 });
    const tool = (name: string) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { PATH: bin };
    const release = { mechanism: 'script' as const, script: 'scripts/release.ts' };
    const check = (r: Record<string, unknown> = release) => releaseMechanismCheck('release mechanism', repo, r, env, 'linux');

    const none = check();
    assert.equal(none.ok, false);
    for (const hint of ['node not found on PATH; install it: install Node.js', 'git not found on PATH; install it: install git', 'gh not found on PATH; install it: install the GitHub CLI: https://cli.github.com'])
      assert.ok(none.detail.includes(hint), `${hint} in ${none.detail}`);
    assert.ok(!none.detail.includes('release.script'), 'the file is there');

    for (const t of ['node', 'git', 'gh']) tool(t);
    const ok = check();
    assert.deepEqual({ ok: ok.ok, warn: ok.warn }, { ok: true, warn: undefined });
    assert.match(ok.detail, /^script: node at .*, git at .*, gh at .*, scripts\/release\.ts at .*scripts\/release\.ts$/);

    fs.rmSync(path.join(bin, 'gh'));
    const noGh = check();
    assert.equal(noGh.ok, false);
    assert.match(noGh.detail, /gh not found on PATH; install it: install the GitHub CLI/);
    assert.doesNotMatch(noGh.detail, /node not found|git not found/);
    tool('gh');

    const missing = check({ ...release, script: 'scripts/missing.ts' });
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /release\.script scripts\/missing\.ts is not a regular file at .*scripts\/missing\.ts; fix release\.script/);
    fs.mkdirSync(path.join(repo, 'scripts', 'dir.ts'));
    assert.match(check({ ...release, script: 'scripts/dir.ts' }).detail, /fix release\.script/, 'a directory is no script');

    // Cadence on-merge or scheduled only warns, as for the other mechanisms.
    for (const cadence of ['on-merge', 'scheduled']) {
      const warned = check({ ...release, script: 'scripts/missing.ts', cadence });
      assert.deepEqual({ ok: warned.ok, warn: warned.warn }, { ok: true, warn: true }, cadence);
      assert.match(warned.detail, /fix release\.script; cadence .* usually releases from CI/);
    }
    assert.ok(!fs.existsSync(marker), 'doctor never ran the script');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
