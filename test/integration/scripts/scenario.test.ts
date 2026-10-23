import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { forgeAsync, waitFor } from '../../helpers.ts';
import { NOTIFY_GATES, STAGES } from '#core/job/schema.ts';
import { SCENARIO_DIR, listScenarios, loadScenario, scenarioEnv, seedScenario } from '../../../scripts/scenario.ts';

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'scenario.ts');
const MESSAGES = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'dashboard', 'src', 'messages', 'en.json'), 'utf8'));
const VIEW_IDS = ['pipeline', 'project', 'backlog', 'agents', 'analytics', 'evals'];

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scenario-test-')));
}

/** A minimal valid scenario, for the refusal rows to break one piece of. */
function valid(): any {
  return {
    description: 'test scenario',
    jobs: [{ key: 'a', title: 'Job A' }],
    expect: Object.fromEntries(VIEW_IDS.map((v) => [v, ['x']])),
  };
}

function writeScenario(dir: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body));
}

const json = (r: { status: number | null; stdout: string; stderr: string }) => {
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
};

interface SeededJob {
  id: string;
  title: string;
  stage: string;
  state: string;
  waitingOn: string | null;
  verify: string | null;
  lastVerdicts: Record<string, string> | null;
  estCostUsd: number;
  agents: Record<string, { status?: string; model?: string | null }>;
  models: string[];
}

async function readJobs(root: string): Promise<SeededJob[]> {
  const list = json(await forgeAsync(root, ['job', 'list', '--all', '--json']));
  return Promise.all(
    list.map(async (j: { id: string }) => {
      const [show, full] = await Promise.all([forgeAsync(root, ['job', 'show', j.id, '--json']), forgeAsync(root, ['job', 'show', j.id, '--full', '--json'])]);
      const c = json(show);
      const f = json(full);
      return { ...c, agents: f.agents, models: Object.keys(f.usage.byModel) };
    }),
  );
}

const ROWS: { name: string; check: (jobs: SeededJob[]) => void }[] = [
  { name: 'empty', check: (jobs) => assert.equal(jobs.length, 0) },
  {
    name: 'busy',
    check: (jobs) => {
      assert.deepEqual(new Set(jobs.map((j) => j.stage)), new Set(STAGES));
      assert.ok(jobs.some((j) => Object.values(j.agents).some((a) => a.status === 'running')));
    },
  },
  {
    name: 'gates',
    check: (jobs) => {
      assert.equal(jobs.length, NOTIFY_GATES.length);
      assert.deepEqual(new Set(jobs.map((j) => j.waitingOn)), new Set(NOTIFY_GATES));
    },
  },
  {
    name: 'failures',
    check: (jobs) => {
      assert.ok(jobs.some((j) => j.verify === 'FAIL'), 'a failed verify');
      assert.ok(jobs.some((j) => Object.values(j.lastVerdicts ?? {}).includes('CHANGES')), 'a CHANGES verdict');
      assert.ok(jobs.some((j) => j.state === 'failed'), 'a failed job');
      assert.ok(jobs.some((j) => j.state === 'blocked'), 'a blocked job');
      assert.ok(jobs.some((j) => Object.values(j.agents).some((a) => a.status === 'failed')), 'a failed agent');
    },
  },
  {
    name: 'costs',
    check: (jobs) => {
      const spent = jobs.filter((j) => j.estCostUsd > 0);
      assert.ok(spent.length >= 3, `${spent.length} jobs with a cost`);
      assert.ok(new Set(spent.flatMap((j) => j.models)).size >= 3, 'three models');
    },
  },
];

describe('scripts/scenario.ts', () => {
  it('listScenarios reads the scenario dir', async () => {
    assert.deepEqual(listScenarios(), ['busy', 'costs', 'empty', 'failures', 'gates']);
    const dir = tempDir();
    try {
      writeScenario(dir, 'extra', valid());
      fs.writeFileSync(path.join(dir, 'notes.md'), 'not a scenario');
      assert.deepEqual(listScenarios(dir), ['extra']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      execFile(process.execPath, [SCRIPT, '--list'], { encoding: 'utf8' }, (err, stdout) => resolve({ code: err ? ((err as any).code ?? null) : 0, stdout }));
    });
    assert.equal(out.code, 0);
    const lines = out.stdout.trim().split('\n');
    assert.deepEqual(
      lines.map((l) => l.split('  ')[0]),
      listScenarios(SCENARIO_DIR),
    );
    for (const l of lines) assert.match(l, /^[a-z0-9-]+ {2}\S/);
  });

  describe('every scenario seeds through the CLI and cleans up', { concurrency: 4 }, () => {
    for (const row of ROWS) {
      it(row.name, async () => {
        const started = Date.now();
        // The daemon's markers must never reach the scratch repo's CLI: with them it would refuse.
        const seeded = await seedScenario(row.name, { env: { ...process.env, FORGE_DAEMON: '1', FORGE_DAEMON_TRUST: 'bogus-trust' } });
        try {
          assert.ok(Date.now() - started < 20_000, `${row.name} took ${Date.now() - started} ms`);
          assert.equal(seeded.worktrees, `${seeded.root}.worktrees`);
          const jobs = await readJobs(seeded.root);
          const titles = loadScenario(row.name).jobs.map((j) => j.title);
          assert.deepEqual(jobs.map((j) => j.title).sort(), [...titles].sort());
          assert.deepEqual(Object.keys(seeded.jobs).length, titles.length);
          row.check(jobs);
        } finally {
          seeded.cleanup();
        }
        assert.equal(fs.existsSync(seeded.root), false);
        assert.equal(fs.existsSync(seeded.worktrees), false);
        seeded.cleanup();
      });
    }
  });

  it('loadScenario refuses malformed scenarios', () => {
    const dir = tempDir();
    const jobWith = (extra: Record<string, unknown>) => ({ ...valid(), jobs: [{ key: 'a', title: 'Job A', ...extra }] });
    const rows: [string, unknown, string][] = [
      ['bad-json', '{ "description": ', 'not valid JSON'],
      ['extra-key', { ...valid(), extra: 1 }, 'unknown key "extra"'],
      ['no-description', { ...valid(), description: undefined }, 'description'],
      ...['daemon', 'tracker', 'worktrees', 'notify'].map((k): [string, unknown, string] => [`config-${k}`, { ...valid(), config: { [k]: {} } }, `config key "${k}" is not allowed`]),
      ['dup-key', { ...valid(), jobs: [{ key: 'a', title: 'A' }, { key: 'a', title: 'B' }] }, 'duplicate job key'],
      ['bad-key', { ...valid(), jobs: [{ key: 'A B', title: 'A' }] }, 'job key'],
      ['step-dash', jobWith({ steps: [['dash']] }), 'forge dash is not allowed'],
      ['step-json', jobWith({ steps: [['job', 'show', '{id}', '--json']] }), '--json'],
      ['new-title', jobWith({ new: ['--title', 'x'] }), '--title'],
      ['new-body-file', jobWith({ new: ['--body-file', 'x'] }), '--body-file'],
      ['unknown-ref', jobWith({ steps: [['job', 'show', '{id:nope}']] }), 'unknown job key "nope"'],
      ...['../x.md', '/abs.md', 'job.json', 'events.jsonl'].map((p, i): [string, unknown, string] => [`file-${i}`, jobWith({ files: { [p]: 'x' } }), 'file path']),
      ['evals-missing', { ...valid(), expect: { ...valid().expect, evals: undefined } }, 'expect has no text for evals'],
      ['evals-empty', { ...valid(), expect: { ...valid().expect, evals: [] } }, 'expect has no text for evals'],
      ['bad-message', { ...valid(), expect: { ...valid().expect, evals: ['@nope.key'] } }, 'unknown message key "nope.key"'],
      ['plural-message', { ...valid(), expect: { ...valid().expect, evals: ['@project.problems'] } }, 'not a plain string'],
      ['drawer-no-job', { ...valid(), jobs: [], expect: { ...valid().expect, drawer: { text: ['x'] } } }, 'drawer needs a job'],
    ];
    try {
      for (const [name, body] of rows) writeScenario(dir, name, body);
      assert.throws(() => loadScenario('../busy', dir), /scenario name/);
      const known = listScenarios(dir).join(', ');
      assert.throws(() => loadScenario('nope', dir), (e: Error) => e.message.includes(`unknown scenario "nope" (${known})`));
      for (const [name, , fragment] of rows) {
        assert.throws(
          () => loadScenario(name, dir),
          (e: Error) => e.message.startsWith(`scenario ${name}: `) && e.message.includes(fragment),
          `${name} should be refused with ${fragment}`,
        );
      }
      // The baseline the rows break loads, its @keys resolved and its drawer defaulted to the first job.
      writeScenario(dir, 'ok', { ...valid(), expect: { ...valid().expect, evals: ['@nav.evals'] } });
      const ok = loadScenario('ok', dir);
      assert.deepEqual(ok.expect.views.evals, [MESSAGES.nav.evals]);
      assert.deepEqual(ok.expect.drawer, { title: 'Job A', text: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scenarioEnv keeps the CLI off the caller's repo and daemon", () => {
    const base = {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--import=x',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_DIR: '/repo/.git',
      GIT_WORK_TREE: '/repo',
      GIT_INDEX_FILE: '/repo/.git/index',
      FORGE_ROOT: '/repo',
      FORGE_DAEMON: '1',
      FORGE_DAEMON_TRUST: 'trust',
      FORGE_DAEMON_SCOPE: 'job:x',
      FORGE_PORT: '7400',
      FORGE_PORT_WEB: '7401',
      FORGE_ENDPOINT_API: 'http://x',
      FORGE_BACKING_DB: 'x',
      FORGE_JOB: 'x',
      FORGE_WORKTREE: '/repo.worktrees/x',
      FORGE_ACTOR: 'me',
      FORGE_NOTIFY_URL: 'x',
      FORGE_MODE: 'human',
      FORGE_RENDER_CHROME: '/chrome',
    };
    const env = scenarioEnv(base, '/scratch');
    assert.deepEqual(env, {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--import=x',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      FORGE_RENDER_CHROME: '/chrome',
      FORGE_ROOT: '/scratch',
    });
    assert.equal(base.FORGE_ROOT, '/repo', 'the caller env is not changed');
  });

  it('the scenario script cleans up on a signal and after a failed step', async () => {
    const child = spawn(process.execPath, [SCRIPT, 'empty'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await waitFor(() => stdout.endsWith('\n'), { timeoutMs: 20_000, what: 'the scratch path' });
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1, stdout);
    const root = lines[0];
    assert.ok(path.basename(root).startsWith('forge-scenario-'), root);
    assert.ok(fs.statSync(root).isDirectory());
    assert.match(stderr, /seeded empty in \d+ ms/);
    fs.mkdirSync(`${root}.worktrees`);
    child.kill('SIGTERM');
    assert.equal(await exited, 0, stderr);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(`${root}.worktrees`), false);

    const dir = tempDir();
    try {
      writeScenario(dir, 'broken', { ...valid(), jobs: [{ key: 'a', title: 'Job A', steps: [['job', 'show', 'missing-0000']] }] });
      const logs: string[] = [];
      await assert.rejects(seedScenario('broken', { dir, log: (s) => logs.push(s) }), (e: Error) => {
        assert.match(e.message, /^scenario broken: a step 1 \(forge job show missing-0000\) exited 1, expected 0: /);
        return true;
      });
      const seeding = logs.find((l) => l.startsWith('seeding broken into '));
      assert.ok(seeding, logs.join('\n'));
      const failedRoot = seeding.slice('seeding broken into '.length);
      assert.equal(fs.existsSync(failedRoot), false);
      assert.equal(fs.existsSync(`${failedRoot}.worktrees`), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
