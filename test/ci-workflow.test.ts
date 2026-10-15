// Forge's own CI: .github/workflows/ci.yml runs the AGENTS.md verify list in the same order, and stays
// closed to the bypasses a PR author, a retagged action or a later edit could use to make red read green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '../lib/yaml.ts';
import { tempRepo } from './helpers.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = { skip: process.platform === 'win32' && 'POSIX-only' };

const STALE_CMD = 'git status --porcelain -- dashboard/dist';

type Step = Record<string, any>;
type Job = Record<string, any>;

const stepsOf = (job: Job | undefined): Step[] => (Array.isArray(job?.steps) ? job.steps : []);
const runOf = (step: Step): string | null => (typeof step?.run === 'string' ? step.run : null);

// ---------- fixtures ----------

const TEXT = read('.github/workflows/ci.yml');
const WF = parse(TEXT);

const stepRunning = (job: string, pred: (run: string) => boolean): string => {
  const run = stepsOf(WF.jobs[job]).map(runOf).find((r) => r !== null && pred(r));
  assert.ok(run, `${job} has the step`);
  return run;
};
/** Runs a step script the way GitHub runs `shell: bash`, with this test's Node first on PATH. */
const bash = (script: string, cwd: string) =>
  spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
  });

// ---------- tests ----------

test('the stale dist step fails and names the stale files', POSIX, () => {
  const script = stepRunning('verify', (r) => r.includes(STALE_CMD));
  const repo = tempRepo();
  try {
    const dist = path.join(repo.dir, 'dashboard', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'a.js'), 'export const a = 1;\n');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'dist');

    const clean = bash(script, repo.dir);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout + clean.stderr, '');

    fs.writeFileSync(path.join(repo.dir, 'README.md'), '# changed\n');
    const readmeOnly = bash(script, repo.dir);
    assert.equal(readmeOnly.status, 0, readmeOnly.stderr);
    assert.equal(readmeOnly.stdout + readmeOnly.stderr, '');

    fs.writeFileSync(path.join(dist, 'a.js'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(dist, 'b.js'), 'export const b = 1;\n');
    const stale = bash(script, repo.dir);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /^::error title=Stale dashboard\/dist::dashboard\/dist is stale: run npm run build:dashboard and commit dashboard\/dist$/m);
    assert.match(stale.stdout, /^Stale files:$/m);
    assert.match(stale.stdout, /^ M dashboard\/dist\/a\.js$/m);
    assert.match(stale.stdout, /^\?\? dashboard\/dist\/b\.js$/m);
  } finally {
    repo.cleanup();
  }
});

test('the syntax-check step fails when any file has a syntax error, not only the last', POSIX, () => {
  const script = stepRunning('verify', (r) => r.includes('node --check'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ci-check-')));
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  try {
    // bin/forge is the first file the loop checks; the files after it pass.
    write('bin/forge', '#!/usr/bin/env node\nconsole.log(;\n');
    write('lib/trackers/status.mjs', 'export const ok = 1;\n');
    write('dashboard/a.mjs', 'export const a = 1;\n');
    const bad = bash(script, dir);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /bin\/forge/);

    write('bin/forge', '#!/usr/bin/env node\nconsole.log(1);\n');
    const good = bash(script, dir);
    assert.equal(good.status, 0, good.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI starts without a type-stripping warning on this Node', () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'forge'), 'version'], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).version, JSON.parse(read('package.json')).version);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
});
