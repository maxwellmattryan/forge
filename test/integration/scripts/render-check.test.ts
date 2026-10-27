import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Imported for its side effects: git config pinned and the daemon's markers dropped, which the
// in-process server and the seeder's children inherit.
import '../../helpers.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { launchBrowser, parseRenderArgs, renderCheck, renderExitCode } from '../../../scripts/render-check.ts';

const BROKEN = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'render-broken');
const VIEW_IDS = ['office', 'foreman', 'project', 'pipeline', 'issues', 'agents', 'analytics', 'evals'];
const USAGE = 'usage: npm run test:render [-- --scenario NAME]... [--dist DIR]';

/** A temp scenario dir holding `one`: a single job the fixture's views and drawer name. */
function oneJobScenario(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-render-test-')));
  const title = 'Render fixture job';
  fs.writeFileSync(
    path.join(dir, 'one.json'),
    JSON.stringify({ description: 'one job', jobs: [{ key: 'one', title }], expect: Object.fromEntries(VIEW_IDS.map((v) => [v, [title]])) }),
  );
  return dir;
}

describe('scripts/render-check.ts', () => {
  it('parseRenderArgs reads scenarios and a dist', () => {
    const dist = path.join(PLUGIN_ROOT, 'dashboard', 'dist');
    assert.deepEqual(parseRenderArgs([]), { scenarios: null, dist });
    assert.deepEqual(parseRenderArgs(['--scenario', 'busy', '--scenario', 'gates']), { scenarios: ['busy', 'gates'], dist });
    assert.deepEqual(parseRenderArgs(['--dist', '/tmp/build', '--scenario', 'empty']), { scenarios: ['empty'], dist: '/tmp/build' });
    for (const argv of [['--scenario'], ['--nope'], ['gates']]) assert.throws(() => parseRenderArgs(argv), { message: USAGE }, argv.join(' '));
  });

  it('renderCheck refuses an unknown scenario and a dist with no manifest before starting Chrome', async () => {
    await assert.rejects(renderCheck({ scenarios: ['nope'] }), (e: any) => e.exitCode === 2 && /unknown scenario "nope"/.test(e.message));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-render-test-'));
    try {
      await assert.rejects(renderCheck({ scenarios: ['empty'], dist: dir }), (e: any) => e.exitCode === 1 && e.message === `render check: ${dir} has no manifest.json: run npm run build:dashboard`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the render check fails broken views and passes the rest', async (t) => {
    try {
      await (await launchBrowser()).close();
    } catch (e) {
      if (process.env.FORGE_REQUIRE_BROWSER === '1') throw e;
      t.skip(`no Chrome: ${String((e as Error).message).split('\n')[0]}`);
      return;
    }
    const dir = oneJobScenario();
    try {
      const result = await renderCheck({ scenarios: ['one'], scenarioDir: dir, dist: BROKEN, textTimeoutMs: 1500 });
      const of = (view: string) => result.problems.filter((p) => p.view === view).map((p) => p.problem);
      assert.ok(
        of('agents').some((p) => p.startsWith('page error: ') && p.includes('agents throws')),
        JSON.stringify(of('agents')),
      );
      assert.ok(
        of('evals').some((p) => p.startsWith('console error: ') && p.includes('evals logs an error')),
        JSON.stringify(of('evals')),
      );
      assert.deepEqual(of('analytics'), ['missing text "Render fixture job"']);
      for (const view of ['office', 'foreman', 'pipeline', 'project', 'issues', 'drawer']) assert.deepEqual(of(view), [], view);
      // The machine's checks: the fixture lists no project and has no switcher, so each reports what is missing.
      const registered = ['repo', 'other-project', 'gone-project'].map((n) => `missing text "${n}"`);
      assert.deepEqual(of('overview'), [...registered, ...['Jobs shipped', 'Cost', 'Machine'].map((n) => `missing text "${n}"`)]);
      assert.deepEqual(of('machine'), registered);
      assert.deepEqual(of('switch'), ['could not switch to other-project in the project switcher']);
      assert.deepEqual(of('add'), ['could not choose Add project in the project switcher']);
      // The fixture build has no login: its link neither signs in nor drops the key.
      assert.deepEqual(of('login'), ['the login link did not sign in and open #/p/repo/pipeline', 'the login key stayed in the URL']);
      // Nor does it show the signed-out banner, so the paste-into-an-open-page check stops at the first step.
      assert.deepEqual(of('relogin'), ['a page without the login cookie did not show the signed-out banner']);
      assert.equal(result.checked, VIEW_IDS.length + 1 + 6);
      assert.equal(result.passed, 6);
      assert.equal(renderExitCode(result), 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
