// A job's environment in-process (issue #198): lib/environment.ts and lib/environment-record.ts
// against the in-memory docker fake (test/fixtures/fake-docker.mjs), injected with setDockerRunner.
// These tests change process.env (a fake gh on PATH), so none runs concurrently.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backingUp, setDockerRunner } from '../lib/backing.ts';
import type { DockerRunner } from '../lib/backing.ts';
import { loadConfig } from '../lib/config.ts';
import { createJob, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { syncPr } from '../lib/pr.ts';
import { emptyState, handle } from './fixtures/fake-docker.mjs';
import { repoTemplate } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const PG = { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], volumes: ['/var/lib/postgresql/data'] };

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  const file = path.join(dir, '.forge', 'config.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify([PG])}`));
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

/** The in-memory docker, every call recorded. */
function fakeDocker() {
  const state = emptyState();
  const calls: string[][] = [];
  const runner: DockerRunner = (args, opts = {}) => {
    calls.push(args);
    const r = handle(state, args, opts.input);
    return { ok: r.status === 0, ...r };
  };
  return { state, calls, runner };
}

// A stand-in `gh` that answers `pr view` with $FAKE_PR_STATE, as test/pr.test.ts's does.
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr view") printf '{"number":7,"url":"https://github.com/o/r/pull/7","state":"%s","isDraft":false,"headRefOid":"abc123","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"","statusCheckRollup":[],"mergedAt":null,"closedAt":null,"headRefName":"forge/x","baseRefName":"main"}' "$FAKE_PR_STATE" ;;
  "repo view") echo o/r ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{}}}}' ;;
esac
`;

test('pr sync done and cancelled tear down', { skip: process.platform === 'win32' }, () => {
  const r = template();
  const bin = path.join(r.dir, '..', `fakebin-${path.basename(r.dir)}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const saved = { ...process.env };
  const docker = fakeDocker();
  const prev = setDockerRunner(docker.runner);
  try {
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
    const config = loadConfig(r.dir).config;
    config.tracker.github.repo = 'o/r';
    for (const [prState, finished] of [['MERGED', 'done'], ['CLOSED', 'cancelled']] as const) {
      const job = createJob(r.dir, config, { title: `sync ${prState}` });
      const up = backingUp(r.dir, config, job, docker.runner);
      assert.ok(up.every((s) => s.ok), JSON.stringify(up));
      setJob(r.dir, job.id, { fields: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } });
      assert.ok(docker.state.containers[`forge-${job.id}-postgres`]);
      process.env.FAKE_PR_STATE = prState;
      syncPr(r.dir, config, job.id);
      assert.equal(loadJob(r.dir, job.id).state, finished);
      assert.equal(docker.state.containers[`forge-${job.id}-postgres`], undefined, `${prState}: container removed`);
      assert.equal(docker.state.volumes[`forge-${job.id}-postgres-0`], undefined, `${prState}: volume removed`);
      const down = readEvents(r.dir, job.id).filter((e) => e.type === 'environment-down');
      assert.equal(down.length, 1, prState);
      assert.equal(down[0].trigger, finished);
      assert.equal(down[0].ok, true);
      // A second sync of a finished job tears nothing down again.
      syncPr(r.dir, config, job.id);
      assert.equal(readEvents(r.dir, job.id).filter((e) => e.type === 'environment-down').length, 1);
    }
  } finally {
    setDockerRunner(prev);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(bin, { recursive: true, force: true });
    r.cleanup();
  }
});
