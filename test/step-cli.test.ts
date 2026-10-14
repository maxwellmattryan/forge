// `forge job step` through the real CLI (issue #68): one action, read-only, deterministic, and the
// missing-review path driven from state alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { jobDir } from '../lib/jobs.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'forge');

function scratch(answers: Record<string, unknown> = {}) {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const raw = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env });
  const f = (...args: string[]) => {
    const r = raw(...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const answersFile = path.join(path.dirname(repo.dir), `answers-${path.basename(repo.dir)}.json`);
  fs.writeFileSync(answersFile, JSON.stringify({ tracker: { kind: 'none' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` }, ...answers }));
  f('init', 'write', '--answers', answersFile);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
  };
  return { root: repo.dir, f, raw, cleanup };
}

/** Every path under dir with its bytes (directories marked), so a test can assert nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String).sort()) {
    const p = path.join(dir, f);
    out[f] = fs.statSync(p).isDirectory() ? '<dir>' : fs.readFileSync(p, 'base64');
  }
  return out;
}

const ACTIONS = ['spawn', 'run', 'wait', 'procedure', 'done'];

test('job step prints one action and is read-only', () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'Read only');
    const dir = jobDir(s.root, id);
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ dev: { pid: 999999, port: 4100 } }));
    const states: string[][] = [
      [],
      ['--stage', 'review', '--state', 'running', '--field', 'reviewers=["code","tests"]', '--field', 'round=1'],
      ['--stage', 'decide', '--state', 'running'],
      ['--stage', 'pr', '--state', 'waiting', '--waiting-on', 'pr-review'],
      ['--stage', 'build', '--state', 'waiting', '--waiting-on', 'budget', '--reason', 'usd over'],
    ];
    for (const st of states) {
      if (st.length) s.f('job', 'set', id, ...st);
      const before = snapshot(dir);
      const r = s.raw('job', 'step', id);
      assert.equal(r.status, 0, r.stderr);
      const lines = r.stdout.trim().split('\n');
      assert.equal(lines.length, 1, 'exactly one line');
      const a = JSON.parse(lines[0]);
      assert.ok(ACTIONS.includes(a.action), a.action);
      assert.equal(a.id, id);
      assert.deepEqual(snapshot(dir), before, `${st.join(' ')}: the job dir is byte-identical`);
      assert.equal(fs.existsSync(path.join(dir, 'review')), false, 'no review dir is created');
    }
    const unknown = s.raw('job', 'step', 'no-such-job');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /no job "no-such-job"/);
    const file = path.join(dir, 'job.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), schemaVersion: 99 }));
    const newer = s.raw('job', 'step', id);
    assert.equal(newer.status, 1);
    assert.match(newer.stderr, /written by a newer Forge/);
  } finally {
    s.cleanup();
  }
});

test('job step is deterministic', () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'Twice');
    for (const st of [[], ['--stage', 'plan', '--state', 'running'], ['--stage', 'decide', '--state', 'running', '--field', 'round=1']]) {
      if (st.length) s.f('job', 'set', id, ...st);
      const one = s.raw('job', 'step', id).stdout;
      const two = s.raw('job', 'step', id).stdout;
      assert.equal(one, two, 'byte for byte');
      assert.deepEqual(JSON.parse(one), JSON.parse(two));
      assert.doesNotMatch(one, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no timestamps');
    }
  } finally {
    s.cleanup();
  }
});

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const section = (text: string, heading: string) => {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `missing ${heading}`);
  const end = text.indexOf('\n## ', start + heading.length);
  return end > start ? text.slice(start, end) : text.slice(start);
};

test('SKILL.md is the loop', () => {
  const skill = read('skills/forge/SKILL.md');
  assert.ok(Buffer.byteLength(skill) <= 6000, `SKILL.md is ${Buffer.byteLength(skill)} bytes`);
  assert.ok(skill.includes('forge job step <id>'));
  for (const gone of ['--waiting-on spec-approval', 'Split mode: <mode>', '--malformed changes', 'forge job acs', 'dev --background', 'forge job round', 'exhausted', 'Pick the review panel'])
    assert.ok(!skill.includes(gone), `SKILL.md still states "${gone}"`);
  for (const ref of ['commands.md', 'requests.md', 'split.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'forge', 'reference', ref)), `reference/${ref} exists`);
    assert.ok(skill.includes(`reference/${ref}`), `SKILL.md names reference/${ref}`);
  }
  // The frontmatter is unchanged: name, description and argument-hint.
  assert.match(skill, /^---\nname: forge\ndescription: Run Forge, a software factory\./);
  assert.match(skill, /\nargument-hint: "<feature> \| next \[n\] \| issue <ref> \| continue <job\|#pr> \| approve\|revise\|answer\|rework\|cancel <job> \[note\] \| status \| sync \| dash \| init \| retro \| eval … \| requests \| doctor \| update"\n---\n/);
});

test('docs mention job step', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('| `forge job step <id>` |'), 'README command table');
  assert.match(section(readme, '## How it works'), /The CLI decides each step/);
  const arch = read('docs/ARCHITECTURE.md');
  assert.ok(section(arch, '## Why a CLI does the bookkeeping').includes('forge job step <id>'));
  assert.ok(section(arch, '## Data and versioning').includes('Job schema v6'));
  assert.ok(section(read('docs/PROTOCOL.md'), '## The minimum contract').includes('forge job step <id>'));
  const config = read('docs/CONFIG.md');
  assert.ok(config.includes('longer than 600 characters') && config.includes('re-runs the `always: true` lenses'));
  for (const ref of ['pr-lifecycle.md', 'evals.md', 'retro.md']) assert.ok(read(`skills/forge/reference/${ref}`).includes('step loop'), `${ref} drives with the step loop`);
  assert.ok(read('skills/forge/reference/infra.md').includes('`forge job step`'));
  const s = scratch();
  try {
    const usage = s.raw('job');
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage: forge job [a-z|-]*\|step\b/);
    assert.match(s.raw('help').stdout, /forge job step <id>/);
  } finally {
    s.cleanup();
  }
});

test('missing review: retry once then escalate', () => {
  const s = scratch({ commands: { build: 'true', test: 'true', lint: 'true' } });
  try {
    const { id } = s.f('job', 'new', '--title', 'Missing review');
    s.f('worktree', 'create', id);
    s.f('job', 'round', id);
    fs.writeFileSync(path.join(jobDir(s.root, id), 'spec.md'), '# Spec\n\n## Approach\n- `README.md`\n');
    s.f('job', 'set', id, '--stage', 'review', '--state', 'running', '--field', 'reviewers=["code"]');
    const step = () => s.f('job', 'step', id);
    const exec = (argv: string[]) => s.f(...argv);

    let a = step();
    assert.deepEqual([a.action, a.rule, a.command], ['run', 'RV2', ['job', 'scope', id]]);
    exec(a.command);
    a = step();
    assert.equal(a.action, 'spawn');
    assert.equal(a.lens, 'code');
    const output = path.join(jobDir(s.root, id), 'review', 'round-1', 'code.md');
    assert.equal(a.output, output);
    assert.equal(a.retry, undefined);
    exec(a.start);
    assert.equal(s.f('job', 'agent', id, 'end', '--role', 'reviewer:code', '--summary', 'VERDICT: PASS').outputMissing, true);

    a = step();
    assert.equal(a.action, 'spawn');
    assert.equal(a.rule, 'M1');
    assert.equal(a.retry, true);
    assert.equal(a.lens, 'code');
    assert.equal(a.output, output);
    assert.equal(a.start.at(-1), '--retry');
    exec(a.start);
    s.f('job', 'agent', id, 'end', '--role', 'reviewer:code', '--summary', 'VERDICT: PASS');

    a = step();
    assert.equal(a.action, 'run');
    assert.deepEqual(a.command, ['job', 'set', id, '--state', 'waiting', '--waiting-on', 'escalation', '--reason', 'reviewer code wrote no review', '--note', 'reviewer:code ended twice without writing code.md']);
    exec(a.command);
    a = step();
    assert.equal(a.action, 'wait');
    assert.equal(a.waitingOn, 'escalation');
    assert.match(a.tell, /escalated \(reviewer code wrote no review\)/);
  } finally {
    s.cleanup();
  }
});
