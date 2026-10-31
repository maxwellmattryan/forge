import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { forgeAsync, waitFor } from '../../helpers.ts';
import { NOTIFY_GATES, STAGES } from '#core/job/schema.ts';
import { mergeCatalogs } from '../../../dashboard/src/lib/text/i18n.ts';
import { SCENARIO_DIR, listScenarios, loadScenario, scenarioEnv, seedScenario } from '../../../scripts/scenario.ts';

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'scenario.ts');
const MESSAGE_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'dashboard', 'src', 'messages', 'en');
const MESSAGES = mergeCatalogs(Object.fromEntries(
  fs.readdirSync(MESSAGE_DIR).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(fs.readFileSync(path.join(MESSAGE_DIR, f), 'utf8'))]),
)) as any;
const VIEW_IDS = ['office', 'foreman', 'project', 'pipeline', 'issues', 'agents', 'analytics', 'evals'];
const SEED_BUDGET_MS = 60_000;

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
  reason: string | null;
  waitingOn: string | null;
  verify: string | null;
  lastVerdicts: Record<string, string> | null;
  estCostUsd: number;
  agents: Record<string, { status?: string; model?: string | null }>;
  models: string[];
  issues: { tracker: string; ref: string | null }[];
}

async function readJobs(root: string): Promise<SeededJob[]> {
  const list = json(await forgeAsync(root, ['job', 'list', '--all', '--json']));
  return Promise.all(
    list.map(async (j: { id: string }) => {
      const [show, full] = await Promise.all([forgeAsync(root, ['job', 'show', j.id, '--json']), forgeAsync(root, ['job', 'show', j.id, '--full', '--json'])]);
      const c = json(show);
      const f = json(full);
      return { ...c, agents: f.agents, models: Object.keys(f.usage.byModel), issues: f.issues };
    }),
  );
}

const ROWS: { name: string; check: (jobs: SeededJob[], seeded: { worktrees: string; root: string; jobs: Record<string, string> }) => void }[] = [
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
      // One job per human gate, and one a person shelved (the Shelved list), which is no gate.
      const gated = jobs.filter((j) => j.waitingOn !== 'shelved');
      assert.equal(gated.length, NOTIFY_GATES.length);
      assert.deepEqual(new Set(gated.map((j) => j.waitingOn)), new Set(NOTIFY_GATES));
      assert.deepEqual(jobs.filter((j) => j.waitingOn === 'shelved').map((j) => [j.stage, j.reason]), [['decide', 'shelved: waiting on the billing owner']]);
    },
  },
  {
    name: 'failures',
    check: (jobs, seeded) => {
      // `worktree create` puts the worktree where the seeder says, beside the repo in the private parent.
      assert.ok(fs.statSync(seeded.worktrees).isDirectory(), 'a worktree under the worktrees sibling');
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
  {
    name: 'issues',
    check: (jobs, seeded) => {
      assert.deepEqual(jobs.map((j) => j.state).sort(), ['cancelled', 'done', 'running']);
      for (const j of jobs) assert.ok(j.issues.length && j.issues.every((i) => i.tracker === 'local' && typeof i.ref === 'string'), `${j.title}: ${JSON.stringify(j.issues)}`);
      // Written after the steps, with the holding job's id filled in.
      assert.ok(fs.readFileSync(path.join(seeded.root, '.forge', 'backlog.md'), 'utf8').includes(`→ ${seeded.jobs.export}`));
    },
  },
];

describe('scripts/scenario.ts', () => {
  it('listScenarios reads the scenario dir', async () => {
    assert.deepEqual(listScenarios(), ['busy', 'costs', 'empty', 'failures', 'gates', 'issues']);
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
        // The daemon's markers must never reach the scratch repo's CLI: with them it would refuse.
        const seeded = await seedScenario(row.name, { env: { ...process.env, FORGE_DAEMON: '1', FORGE_DAEMON_TRUST: 'bogus-trust' } });
        const parent = path.dirname(seeded.root);
        try {
          // A seed is 20-40 CLI starts, 2-3 s on an idle machine; inside the whole suite on a busy one
          // it took up to 32 s, so the budget catches a step that hangs, not ordinary load.
          assert.ok(seeded.ms < SEED_BUDGET_MS, `${row.name} took ${seeded.ms} ms`);
          assert.equal(seeded.worktrees, `${seeded.root}.worktrees`);
          // Both live in one private directory, so no other local user can plant the worktrees sibling first.
          assert.ok(path.basename(parent).startsWith('forge-scenario-'), parent);
          assert.equal(path.dirname(seeded.worktrees), parent);
          assert.equal(fs.statSync(parent).mode & 0o077, 0, 'the parent is private to its owner');
          const jobs = await readJobs(seeded.root);
          const titles = loadScenario(row.name).jobs.map((j) => j.title);
          assert.deepEqual(jobs.map((j) => j.title).sort(), [...titles].sort());
          assert.deepEqual(Object.keys(seeded.jobs).length, titles.length);
          row.check(jobs, seeded);
        } finally {
          seeded.cleanup();
        }
        assert.equal(fs.existsSync(seeded.root), false);
        assert.equal(fs.existsSync(seeded.worktrees), false);
        assert.equal(fs.existsSync(parent), false);
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
      // `job advance` runs pr, run and eval actions; `from-ref` and `link` reach a tracker; a flag in
      // argv[1] must not stand in for the subcommand; a bare `job` has none.
      ...['advance', 'from-ref', 'link', '--session'].map((sub, i): [string, unknown, string] => [`step-job-${i}`, jobWith({ steps: [['job', sub, '{id}', '--session', 's']] }), `forge job ${sub} is not allowed`]),
      ['step-job-bare', jobWith({ steps: [['job']] }), 'forge job is not allowed'],
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
      ['backlog-not-string', { ...valid(), backlog: ['- [ ] x'] }, 'backlog must be a non-empty string'],
      ['backlog-unknown-key', { ...valid(), backlog: '- [~] x → {id:nope}' }, 'backlog: unknown job key "nope"'],
      ['issue-no-backlog', { ...valid(), expect: { ...valid().expect, issue: [{ title: 'x' }] } }, 'expect.issue needs a backlog'],
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
      // and each allowed command group loads.
      const steps = [['job', 'set', '{id}', '--stage', 'spec'], ['job', 'human', '{id}', 'approve'], ['worktree', 'create', '{id}'], ['verify', '{id}'], ['requests', 'list']];
      writeScenario(dir, 'ok', { ...valid(), jobs: [{ key: 'a', title: 'Job A', steps }], expect: { ...valid().expect, evals: ['@nav.evals'] } });
      const ok = loadScenario('ok', dir);
      assert.equal(ok.jobs[0].steps.length, steps.length);
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
      FORGE_HOME: '/home/.forge',
      GH_REPO: 'someone/real-repo',
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
      FORGE_HOME: path.join(path.dirname('/scratch'), 'forge-home'),
      // Pinned, not dropped: a human-event step would otherwise ask `gh` who the developer is.
      FORGE_ACTOR: 'scenario',
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
    await waitFor(() => stdout.endsWith('\n'), { timeoutMs: SEED_BUDGET_MS, what: 'the scratch path' });
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1, stdout);
    const root = lines[0];
    const parent = path.dirname(root);
    assert.ok(path.basename(parent).startsWith('forge-scenario-'), root);
    assert.ok(fs.statSync(root).isDirectory());
    assert.match(stderr, /seeded empty in \d+ ms/);
    fs.mkdirSync(`${root}.worktrees`);
    child.kill('SIGTERM');
    assert.equal(await exited, 0, stderr);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(`${root}.worktrees`), false);
    assert.equal(fs.existsSync(parent), false);

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
      assert.equal(fs.existsSync(path.dirname(failedRoot)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
