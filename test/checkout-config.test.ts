// checkout: config (issue #187): validation of each step, the default, and the v13 -> v14 migration.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkoutProblems, resolveTarget } from '../lib/checkout-config.ts';
import { defaults, loadConfig } from '../lib/config.ts';
import { tempRepo } from './helpers.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';

const base = { commands: { install: 'make install', uninstall: 'make uninstall', gone: null }, components: [{ name: 'ui', path: 'ui', kind: 'app', commands: { deploy: 'x' } }] };
const problems = (checkout: unknown) => checkoutProblems({ ...base, checkout });

describe('checkout config', { concurrency: 4 }, () => {
  test('validation', () => {
    assert.deepEqual(problems([]), []);
    assert.deepEqual(checkoutProblems({}), [], 'absent is fine');
    assert.deepEqual(
      problems([
        { link: 'build/MyPlugin.vst3', to: '~/Library/Audio/Plug-Ins/VST3/MyPlugin.vst3' },
        { run: 'install', undo: 'uninstall' },
        { run: 'deploy', undo: null },
        { link: '.', to: '/opt/x' },
      ]),
      [],
    );
    assert.deepEqual(problems('nope'), ['checkout must be a list (got "nope")']);
    assert.deepEqual(problems({ link: 'a' }), ['checkout must be a list (got {"link":"a"})']);
    const cases: [unknown, string][] = [
      [{}, 'checkout[0] needs exactly one of link or run'],
      [{ link: 'a', to: '/x', run: 'install' }, 'checkout[0] needs exactly one of link or run'],
      ['x', 'checkout[0] must be a map with link and to, or run'],
      [{ link: 'a' }, 'checkout[0].to must be an absolute path or start with ~/ (got nothing)'],
      [{ link: 'a', to: 'x' }, 'checkout[0].to must be an absolute path or start with ~/ (got "x")'],
      [{ link: 'a', to: '~x' }, 'checkout[0].to must be an absolute path or start with ~/ (got "~x")'],
      [{ link: 'a', to: '/a/../b' }, 'checkout[0].to must not contain a .. segment (got "/a/../b")'],
      [{ link: 'a', to: '~/../b' }, 'checkout[0].to must not contain a .. segment (got "~/../b")'],
      [{ link: 'a', to: '/a\\..\\b' }, 'checkout[0].to must not contain a .. segment (got "/a\\\\..\\\\b")'],
      [{ link: 'a', to: '/' }, 'checkout[0].to must name a path below / or ~ (got "/")'],
      [{ link: 'a', to: '~/' }, 'checkout[0].to must name a path below / or ~ (got "~/")'],
      [{ link: 'a', to: '/x\0y' }, 'checkout[0].to must not contain a NUL character'],
      [{ link: '../a', to: '/x' }, `checkout[0].link must be a relative path inside the job's worktree, with no .. segment (got "../a")`],
      [{ link: '/abs', to: '/x' }, `checkout[0].link must be a relative path inside the job's worktree, with no .. segment (got "/abs")`],
      [{ link: '', to: '/x' }, `checkout[0].link must be a relative path inside the job's worktree, with no .. segment (got "")`],
      [{ link: 'a', to: '/x', undo: 'uninstall' }, 'checkout[0].undo is only for a run step'],
      [{ run: 'install', to: '/x' }, 'checkout[0].to is only for a link step'],
      [{ run: 'deploy-prod' }, 'checkout[0].run names no configured command "deploy-prod"'],
      [{ run: 'gone' }, 'checkout[0].run names no configured command "gone"'],
      [{ run: 'install', undo: 'nope' }, 'checkout[0].undo names no configured command "nope"'],
      [{ run: '' }, 'checkout[0].run must name a configured command (got "")'],
      [{ run: 3 }, 'checkout[0].run must name a configured command (got 3)'],
    ];
    for (const [step, message] of cases) assert.deepEqual(problems([step]), [message], JSON.stringify(step));
    const home = os.homedir();
    assert.deepEqual(
      problems([{ link: 'a', to: path.join(home, 'p') }, { run: 'install' }, { link: 'b', to: '~/p' }, { link: 'c', to: '/q' }, { link: 'd', to: '/q/' }]),
      ['checkout[2].to repeats checkout[0].to', 'checkout[4].to repeats checkout[3].to'],
    );
    assert.equal(resolveTarget('~/a/b'), path.join(home, 'a', 'b'));
    assert.equal(resolveTarget('/a/./b/'), path.resolve('/a/b'));
    if (process.platform === 'win32') {
      // A drive or UNC path is absolute there, and the same target in another case or separator repeats.
      assert.deepEqual(problems([{ link: 'a', to: 'C:\\Users\\p' }, { link: 'b', to: '\\\\host\\share\\p' }, { link: 'c', to: 'c:/users/P' }]), ['checkout[2].to repeats checkout[0].to']);
      assert.deepEqual(problems([{ link: 'a', to: 'C:\\' }]), ['checkout[0].to must name a path below / or ~ (got "C:\\\\")']);
    }
  });

  test('defaults', () => {
    assert.deepEqual(defaults().checkout, []);
    assert.deepEqual(checkoutProblems(defaults()), []);
  });

  test('a previous-version config migrates', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 18);
    const v14 = { schemaVersion: 14, git: { base: 'trunk' }, components: [], repos: [], downstream: { enabled: true, max: 5, skip: [] } };
    const { config, from } = migrateConfig(structuredClone(v14));
    assert.equal(from, 14);
    assert.deepEqual(config, { ...v14, schemaVersion: 18 }, 'nothing but schemaVersion changes');
    const repo = tempRepo();
    try {
      const cfg = path.join(repo.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, 'schemaVersion: 14\n');
      const loaded = loadConfig(repo.dir);
      assert.equal(loaded.migratedFrom, 14);
      assert.equal(loaded.config.schemaVersion, 18);
      assert.deepEqual(loaded.config.checkout, []);
    } finally {
      repo.cleanup();
    }
  });
});
