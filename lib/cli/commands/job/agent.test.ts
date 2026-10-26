// forge job agent: the role becomes a job.json key and part of a review path, so a name that is not
// a role is refused before anything is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobAt, tempRepo } from '../../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { jobFiles } from '#core/paths.ts';
import { createJob, loadJob, readEvents } from '#core/job/store.ts';
import { agent } from './agent.ts';

/** Every path under `dir` but `.git`, so a file written anywhere in the repo shows. */
function tree(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((p) => p !== '.git' && !p.startsWith(`.git${path.sep}`)).sort();
}

test('job agent refuses a role that is not a role name before anything is written', (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const root = repo.dir;
  const config = defaults();
  const id = createJob(root, config, { title: 'roles' }).id;
  const files = [...jobFiles(root, id, 'job.json'), ...jobFiles(root, id, 'events.jsonl')];
  assert.equal(files.length, 4, 'the CLI copy and the job folder mirror');
  const snapshot = () => ({ files: files.map((f) => fs.readFileSync(f, 'utf8')), tree: tree(root) });
  const before = snapshot();

  const bad: unknown[] = ['__proto__', 'constructor', 'toString', 'reviewer:../x', 'reviewer:../../../../../x', '', true, ['builder', 'builder'], 'Builder', 'lib:realtime', 'reviewer:', 'reviewer:Bad!'];
  for (const role of bad) {
    for (const [phase, extra] of [['start', {}], ['end', {}], ['attach', { 'agent-id': 'a1b2c3' }]] as const) {
      assert.throws(
        () => agent(root, config, [id, phase], { role, ...extra }),
        (e: any) => e.exitCode === 2 && e.code === 'usage',
        `${phase} --role ${JSON.stringify(role)}`,
      );
    }
  }
  assert.deepEqual(snapshot(), before, 'no job file changed and nothing was created');
  assert.equal(Object.hasOwn(Object.prototype, 'status'), false);
  assert.equal(Object.hasOwn(Object.prototype, 'runs'), false);
  assert.throws(() => agent(root, config, [id, 'start'], { role: '__proto__' }), /--role must be a role name .*\(got "__proto__"\)/);

  for (const role of ['builder', 'reviewer:code', 'reviewer:lib:realtime']) {
    assert.equal(agent(root, config, [id, 'start'], { role }).status, 'running', role);
    assert.equal(Object.hasOwn(loadJob(root, id).agents, role), true, role);
  }
});

test("a daemon session's agent end is measured, never self-reported", (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  // An empty transcripts dir, so every lookup misses rather than reading the developer's own.
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });
  const root = repo.dir;
  const config = defaults();
  const id = jobAt(root, 'build', { title: 'driven', config }).id;
  const env = { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: id };
  const files = () => [...jobFiles(root, id, 'job.json'), ...jobFiles(root, id, 'events.jsonl')].map((f) => fs.readFileSync(f, 'utf8'));
  const ends = (role: string) => readEvents(root, id).filter((e) => e.type === 'agent-end' && e.role === role);
  agent(root, config, [id, 'start'], { role: 'builder' }, env);

  for (const [flag, value] of [['tokens', '5'], ['tool-uses', '1'], ['duration-ms', '1']]) {
    const before = files();
    assert.throws(
      () => agent(root, config, [id, 'end'], { role: 'builder', 'agent-id': 'a1', [flag]: value }, env),
      (e: unknown) => e instanceof ForgeError && e.code === 'usage' && /refuses --tokens, --tool-uses and --duration-ms in a daemon session/.test(e.message),
      flag,
    );
    assert.deepEqual(files(), before, `--${flag}: job.json and events.jsonl unchanged`);
  }
  assert.throws(() => agent(root, config, [id, 'end'], { role: 'builder' }, env), (e: unknown) => e instanceof ForgeError && e.code === 'usage' && /needs --agent-id in a daemon session/.test(e.message));
  assert.equal(agent(root, config, [id, 'end'], { role: 'builder', status: 'lost' }, env).status, 'lost', 'an agent that never started ends lost');

  agent(root, config, [id, 'start'], { role: 'planner' }, env);
  agent(root, config, [id, 'attach'], { role: 'planner', 'agent-id': 'attached-1' }, env);
  type Ended = { usage: { tokens: number } | null; unmeasured?: boolean };
  const out = agent(root, config, [id, 'end'], { role: 'planner' }, env) as Ended;
  assert.deepEqual([out.usage, out.unmeasured], [null, true], 'the recorded id, whose transcript is missing');
  const [end] = ends('planner');
  assert.deepEqual([end.agentId, end.unmeasured, end.metered, end.usage], ['attached-1', true, true, undefined]);
  assert.equal(loadJob(root, id).state, 'running', 'never held for a lagging transcript');

  agent(root, config, [id, 'start'], { role: 'docs' }, env);
  agent(root, config, [id, 'end'], { role: 'docs', 'agent-id': 'inbox-1' }, { FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: '_inbox' });
  assert.deepEqual([ends('docs')[0].unmeasured, ends('docs')[0].metered], [true, undefined], 'another scope: no metered mark');

  agent(root, config, [id, 'start'], { role: 'tester' }, {});
  const own = agent(root, config, [id, 'end'], { role: 'tester', tokens: '500' }, {}) as Ended;
  assert.equal(own.usage?.tokens, 500, 'outside a daemon session --tokens still records usage');
  assert.equal(ends('tester')[0].usage?.totalTokens, 500);
});

test('agent end records each run with its billing split and composition', (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });
  const subagents = path.join(claudeDir, 'projects', '-scratch', 'session-1', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, '..', '..', '..', '..', 'test', 'fixtures', 'transcript-composition.jsonl'), path.join(subagents, 'agent-comp1.jsonl'));
  const root = repo.dir;
  const config = defaults();
  const id = createJob(root, config, { title: 'runs' }).id;

  agent(root, config, [id, 'start'], { role: 'builder' }, {});
  agent(root, config, [id, 'end'], { role: 'builder', 'agent-id': 'comp1', import: true }, {});
  let job = loadJob(root, id);
  const bucket = job.usage.byRole.builder!;
  const [first] = job.agents.builder!.runHistory!;
  assert.deepEqual(first!.usage, { input: bucket.input, output: bucket.output, cacheRead: bucket.cacheRead, cacheWrite: bucket.cacheWrite, totalTokens: bucket.tokens }, 'the run holds what the end added to the role');
  const c = first!.composition!;
  assert.equal(c.forgePrompt + c.harness + c.carried + c.assistant + c.user + c.tools.reduce((n, p) => n + p.tokens, 0), c.total);
  assert.ok(c.forgePrompt > 0, "the builder's prompt counts toward the Forge share");
  const [end] = readEvents(root, id).filter((e) => e.type === 'agent-end' && e.role === 'builder');
  assert.equal(Object.hasOwn(end!.usage!, 'composition'), false, 'the event keeps only token counts');

  agent(root, config, [id, 'start'], { role: 'builder' }, {});
  agent(root, config, [id, 'end'], { role: 'builder', tokens: '500' }, {});
  job = loadJob(root, id);
  assert.equal(job.agents.builder!.runHistory!.length, 2);
  const second = job.agents.builder!.runHistory![1]!;
  assert.deepEqual([second.usage, second.composition], [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500 }, null]);
});
