// `forge release run --dry-run` in process: the recomputed steps with what each runs and whether it asks, and
// nothing run or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initScriptProject, repoTemplate, scriptCalls } from '../../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { releaseFiles, writeReleasePlan } from './files.ts';
import { dryRunRelease } from './dry-run.ts';
import { notesPath } from './script.ts';

const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };
const project = repoTemplate(initScriptProject);

test('dry run lists the steps and runs nothing', POSIX, () => {
  const r = project();
  try {
    const config = loadConfig(r.dir).config;
    const files = releaseFiles(r.dir);
    assert.throws(() => dryRunRelease(r.dir, config), (e: unknown) => e instanceof ForgeError && /no release plan; run forge release plan/.test(e.message));

    writeReleasePlan(r.dir, config, { kind: 'all' }, { log: () => {} });
    const calls = scriptCalls(r.dir).length;
    const runtime = fs.readdirSync(files.dir).sort();
    const out = dryRunRelease(r.dir, config);
    const notes = notesPath(r.dir, null);
    const cmd = (phase: string, ...rest: string[]) => ['node scripts/release.mjs --phase', phase, '1.1.0', ...rest].join(' ');
    assert.equal(out.dryRun, true);
    assert.deepEqual({ done: out.done, total: out.total, selection: out.selection }, { done: 0, total: 7, selection: { kind: 'all' } });
    assert.deepEqual(
      out.steps.map(({ id, command, publish, manual, asks, check, status }) => ({ id, command, publish, manual, asks, check, status })),
      [
        { id: '(root)/preflight', command: '', publish: false, manual: false, asks: false, check: 'ready', status: 'pending' },
        { id: '(root)/start', command: cmd('start', '--notes-file', notes), publish: true, manual: false, asks: true, check: null, status: 'pending' },
        { id: '(root)/build', command: cmd('wait-build'), publish: false, manual: false, asks: false, check: null, status: 'pending' },
        { id: '(root)/pr', command: cmd('pr'), publish: true, manual: false, asks: true, check: null, status: 'pending' },
        { id: '(root)/merge', command: out.steps[4].command, publish: true, manual: true, asks: false, check: 'pr-merged', status: 'pending' },
        { id: '(root)/tag', command: cmd('wait-tag'), publish: false, manual: false, asks: false, check: null, status: 'pending' },
        { id: '(root)/land', command: cmd('land'), publish: true, manual: false, asks: true, check: null, status: 'pending' },
      ],
    );
    assert.match(out.steps[4].command, /^Merge the release PR from release\/v1\.1\.0/);
    assert.ok(out.steps.every((s) => typeof s.title === 'string' && s.title));
    assert.deepEqual(out.bumps, [{ repo: '(root)', from: '1.0.0', to: '1.1.0', bump: 'minor', inferred: 'minor', reasons: ['1 of 1 commits are not fixes, such as "feat: x"'], notes }]);

    // Nothing ran and nothing was written: no script call, no state.json, lock or logs.
    assert.equal(scriptCalls(r.dir).length, calls);
    assert.deepEqual(fs.readdirSync(files.dir).sort(), runtime);
    assert.ok(!fs.existsSync(files.state) && !fs.existsSync(files.logs));
    assert.ok(!fs.existsSync(path.join(r.dir, '.forge', 'locks', 'release')));

    // publish: allow means nothing asks.
    const allow = dryRunRelease(r.dir, { ...config, release: { ...config.release, publish: 'allow' } });
    assert.ok(allow.steps.every((s) => !s.asks));

    // Status from a state.json of this plan; one of another plan is stale and refused, as run refuses it.
    const hash = JSON.parse(fs.readFileSync(files.json, 'utf8')).hash;
    const state = (planHash: string) => ({ version: 1, planHash, startedAt: 'x', updatedAt: 'x', finishedAt: null, steps: { '(root)/preflight': { status: 'done', at: 'x' }, '(root)/start': { status: 'failed', at: 'x', reason: 'exit' } } });
    fs.writeFileSync(files.state, JSON.stringify(state(hash)));
    const resumed = dryRunRelease(r.dir, config);
    assert.deepEqual(resumed.steps.slice(0, 3).map((s) => s.status), ['done', 'failed', 'pending']);
    assert.equal(resumed.done, 1);
    fs.writeFileSync(files.state, JSON.stringify(state('b'.repeat(64))));
    assert.throws(() => dryRunRelease(r.dir, config), /no longer matches config and the repos/);
  } finally {
    r.cleanup();
  }
});
