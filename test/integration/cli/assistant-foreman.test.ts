// Assistant foremen through the CLI: they see and claim every gate request and nothing else, the Foreman's
// gate authority (foreman decisions, hand-offs, assist) is theirs and no longer the office's, they drive no
// job, and `forge daemon log --assistant` reads one's log. Serial: the daemon rows set process.env through
// forgeInProcess.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeAsync, forgeInProcess, parkedAt, repoTemplate } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { enqueue } from '#core/job/requests.ts';
import { jobDir, readEvents } from '#core/job/store.ts';
import { sessionFiles } from '#core/job/session-files.ts';

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ foreman: { enabled: true, decides: ['spec-approval', 'conflicts'], reserved: [] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

const env = (scope: string): NodeJS.ProcessEnv => ({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: scope });
const ASSISTANT = env('_assistant-1');
const OFFICE = env('_office');

/** A job parked on spec approval with its gate request, and a second job with a resume request. */
function arrange() {
  const r = scratch();
  const config = loadConfig(r.dir).config;
  const job = parkedAt(r.dir, 'spec-approval', { title: 'parked' }).id;
  const gate = enqueue(r.dir, config, { type: 'gate', job, args: { gate: 'spec-approval', reserved: null }, from: 'forge' }).id;
  const other = parkedAt(r.dir, 'spec-approval', { title: 'resumed' }).id;
  const resume = enqueue(r.dir, config, { type: 'resume', job: other, from: 'dashboard' }).id;
  return { ...r, job, gate, other, resume };
}

const ids = (data: unknown) => (data as { id: string }[]).map((x) => x.id);

test('assistant foremen see and claim gate requests, and only those', async () => {
  const r = arrange();
  try {
    const list = async (scope: string) => {
      const res = await forgeInProcess(r.dir, ['requests', 'list'], { env: env(scope) });
      assert.equal(res.status, 0, JSON.stringify(res.error));
      return ids(res.data);
    };
    assert.deepEqual(await list('_assistant-1'), [r.gate]);
    assert.ok(!(await list('_office')).includes(r.gate), 'the office sees no gate');
    assert.ok(!(await list(r.job)).includes(r.gate), "the job's own session sees no gate");
    assert.deepEqual((await forgeInProcess(r.dir, ['requests', 'scope'], { env: ASSISTANT })).data, { daemon: true, scope: 'assistant', job: null });

    const claim = (scope: string, id: string, session: string) => forgeInProcess(r.dir, ['requests', 'claim', id, '--session', session], { env: env(scope) });
    assert.equal((await claim('_assistant-1', r.gate, 's-1')).status, 0);
    assert.equal((await claim('_assistant-2', r.gate, 's-2')).status, 3, 'the second assistant loses the race');
    assert.equal((await claim('_assistant-1', r.resume, 's-1')).status, 1, 'an assistant claims no job request');
    assert.equal((await claim('_office', r.gate, 's-o')).status, 1, 'the office claims no gate');
    const ack = await forgeInProcess(r.dir, ['requests', 'ack', r.gate, '--status', 'done'], { env: ASSISTANT });
    assert.equal(ack.status, 0, JSON.stringify(ack.error));
    assert.equal((ack.data as { status: string }).status, 'done');
  } finally {
    r.cleanup();
  }
});

test("the Foreman's gate authority is the assistant foremen's", async () => {
  const r = arrange();
  try {
    const events = () => fs.readFileSync(path.join(jobDir(r.dir, r.job), 'events.jsonl'), 'utf8');
    const before = events();
    const decide = ['job', 'human', r.job, 'approve-spec', '--actor', 'foreman', '--note', 'ok'];
    const handoff = ['job', 'handoff', r.job, '--class', 'escalated', '--reason', 'needs a person'];
    const assist = ['job', 'assist', r.job, '--gate', 'spec-approval'];

    const refused = await forgeInProcess(r.dir, decide, { env: OFFICE });
    assert.equal(refused.status, 1);
    assert.equal(refused.error?.message, "--actor foreman refused: only the Foreman's gate runner in forge dash records foreman decisions");
    const h = await forgeInProcess(r.dir, handoff, { env: OFFICE });
    assert.deepEqual([h.status, h.error?.message], [1, "Foreman hand-off refused: only the Foreman's gate runner in forge dash records foreman decisions"]);
    const a = await forgeInProcess(r.dir, assist, { env: OFFICE });
    assert.deepEqual([a.status, a.error?.message], [1, 'forge job assist is for an assistant foreman session (or a human outside the daemon)']);
    assert.equal(events(), before, 'the office wrote nothing');

    const assisted = await forgeInProcess(r.dir, assist, { env: ASSISTANT });
    assert.equal(assisted.status, 0, JSON.stringify(assisted.error));
    assert.equal((assisted.data as { stale: boolean }).stale, false);
    const handed = await forgeInProcess(r.dir, handoff, { env: ASSISTANT });
    assert.equal(handed.status, 0, JSON.stringify(handed.error));
    const decided = await forgeInProcess(r.dir, decide, { env: ASSISTANT });
    assert.equal(decided.status, 0, JSON.stringify(decided.error));
    const human = readEvents(r.dir, r.job).filter((e) => e.type === 'human');
    assert.equal(human.length, 1);
    assert.deepEqual(human[0].actor, { login: null, source: 'foreman' });

    const advance = await forgeInProcess(r.dir, ['job', 'advance', r.job], { env: ASSISTANT });
    assert.equal(advance.status, 1);
    assert.match(advance.error?.message ?? '', /an assistant foreman session decides gates and does not drive jobs; forge job advance is not available in an assistant foreman session \(only assist, human, set/);
  } finally {
    r.cleanup();
  }
});

test('forge daemon log --assistant', async () => {
  const r = scratch();
  try {
    const log = sessionFiles(r.dir, '_assistant-1').log;
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, '{"event":"spawn","scope":"_assistant-1"}\n');
    const shown = await forgeAsync(r.dir, ['daemon', 'log', '--assistant', '1']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /"scope":"_assistant-1"/);
    for (const args of [
      ['--assistant', '0'],
      ['--assistant', '17'],
      ['--assistant', '1', '--office'],
    ]) {
      const bad = await forgeAsync(r.dir, ['daemon', 'log', ...args]);
      assert.equal(bad.status, 2, `${args.join(' ')}: ${bad.stderr}`);
    }
  } finally {
    r.cleanup();
  }
});
