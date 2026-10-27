// Only forge dash's gate runner records a Foreman decision: through the CLI, `--actor foreman` is refused in
// every scope (a person's terminal included) before anything is written, `forge job handoff` is gone, assist is
// a person's read-only view, no session sees a gate request, and a gate run's `_gates` scope runs no forge
// command (docs/architecture/foreman.md › Authority). Each scope row runs in-process; one spawned call per
// command proves the route through bin/forge. Serial: the scope rows set process.env through forgeInProcess.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BIN, forgeAsync, forgeInProcess, parkedAt, repoTemplate } from '../../helpers.ts';
import { jobDir } from '#core/job/store.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';

const scratch = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ daemon: { enabled: true }, foreman: { enabled: true, decides: ['spec-approval', 'release', 'milestone-approval'], reserved: [] } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
});

/** No daemon scope at all, whatever the test runner's own environment holds. */
const TERMINAL: NodeJS.ProcessEnv = { FORGE_DAEMON: undefined, FORGE_DAEMON_SCOPE: undefined };
const scoped = (scope: string): NodeJS.ProcessEnv => ({ FORGE_DAEMON: '1', FORGE_DAEMON_SCOPE: scope });

const AUTHORITY = "--actor foreman refused: only the Foreman's gate runner in forge dash records foreman decisions";
const BROKEN = /FORGE_DAEMON_SCOPE is missing or invalid/;
const GATES = "forge refuses: a gate run's assistant runs no forge commands";
const OFFICE_HUMAN = "the office session records no gate decisions: forge dash's gate runner decides gates";

const events = (root: string, job: string) => fs.readFileSync(path.join(jobDir(root, job), 'events.jsonl'));

test('no session sees a gate request', async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  const job = parkedAt(r.dir, 'spec-approval').id;
  const gid = enqueue(r.dir, null, { type: 'gate', job, args: { gate: 'spec-approval', reserved: null }, from: 'forge' }).id;
  for (const scope of ['_inbox', '_office', '_chat-0123456789ab', job]) {
    const env = scoped(scope);
    const list = await forgeInProcess(r.dir, ['requests', 'list', '--all'], { env });
    assert.equal(list.status, 0, `${scope}: ${JSON.stringify(list.error)}`);
    assert.ok(!(list.data as { id: string }[]).some((x) => x.id === gid), `${scope} lists no gate request`);
    for (const args of [['requests', 'claim', gid, '--session', 's-1'], ['requests', 'ack', gid, '--status', 'rejected', '--result', 'x']]) {
      const res = await forgeInProcess(r.dir, args, { env });
      assert.deepEqual([res.status, res.error?.message], [1, `request ${gid} belongs to scope _gates, not this session's scope ${scope}`], `${scope} ${args[1]}`);
    }
    const s = await forgeInProcess(r.dir, ['requests', 'scope'], { env });
    assert.ok(['inbox', 'office', 'chat', 'job'].includes((s.data as { scope: string }).scope), `${scope}: ${JSON.stringify(s.data)}`);
  }
  for (const scope of ['_assistant-1', '_gates']) assert.equal((await forgeInProcess(r.dir, ['requests', 'scope'], { env: scoped(scope) })).status, 1, scope);
  assert.deepEqual([listRequests(r.dir).find((x) => x.id === gid)?.status], ['pending'], 'the gate request is untouched');
});

test('only the gate runner records foreman decisions', async (t) => {
  const r = scratch();
  t.after(r.cleanup);
  const job = parkedAt(r.dir, 'spec-approval').id;
  const commands: [string, string[]][] = [
    ['approve-spec', ['job', 'human', job, 'approve-spec', '--actor', 'foreman', '--note', 'x']],
    ['approve-release', ['job', 'human', job, 'approve-release', '--actor', 'foreman', '--note', 'x']],
    ['draft approve', ['mandate', 'draft', 'approve', 'g1', '--actor', 'foreman', '--note', 'x']],
  ];
  const before = events(r.dir, job);
  const rows: [string, NodeJS.ProcessEnv, string | RegExp | null][] = [
    ['no daemon scope', TERMINAL, null],
    ['the office', scoped('_office'), null],
    ['the inbox', scoped('_inbox'), null],
    ['the job', scoped(job), null],
    ["a legacy assistant's scope", scoped('_assistant-1'), BROKEN],
    ["a gate run's scope", scoped('_gates'), GATES],
  ];
  for (const [name, args] of commands) {
    for (const [where, env, want] of rows) {
      const res = await forgeInProcess(r.dir, args, { env });
      // The office decides no gate at all: any forge job human there is refused before the actor is read.
      const expected = want ?? (where === 'the office' && args[0] === 'job' ? OFFICE_HUMAN : AUTHORITY);
      assert.equal(res.status, 1, `${name} in ${where}`);
      if (expected instanceof RegExp) assert.match(res.error?.message ?? '', expected, `${name} in ${where}`);
      else assert.equal(res.error?.message, expected, `${name} in ${where}`);
      assert.deepEqual(events(r.dir, job), before, `${name} in ${where}: events.jsonl untouched`);
    }
    // One spawned call per command: the refusal's route and exit through bin/forge.
    const spawned = await forgeAsync(r.dir, args);
    assert.equal(spawned.status, 1, `${name}: ${spawned.stderr}`);
    assert.ok(spawned.stderr.includes(AUTHORITY), `${name}: ${spawned.stderr}`);
  }
  assert.ok(!fs.existsSync(path.join(r.dir, '.forge', 'runtime', 'mandates', 'g1')), 'no mandate dir written');

  // forge job handoff is gone: a usage error, and nothing written.
  const handoff = await forgeAsync(r.dir, ['job', 'handoff', job, '--class', 'escalated', '--reason', 'x']);
  assert.equal(handoff.status, 2, handoff.stderr);
  assert.deepEqual(events(r.dir, job), before, 'handoff: events.jsonl untouched');

  // assist: a person's read-only view, refused in every daemon session.
  const assist = await forgeInProcess(r.dir, ['job', 'assist', job, '--gate', 'spec-approval'], { env: TERMINAL });
  assert.equal(assist.status, 0, JSON.stringify(assist.error));
  assert.equal((assist.data as { stale: boolean }).stale, false);
  for (const scope of ['_office', '_inbox', job]) {
    const refused = await forgeInProcess(r.dir, ['job', 'assist', job, '--gate', 'spec-approval'], { env: scoped(scope) });
    assert.deepEqual([refused.status, refused.error?.message], [1, "forge job assist is for a person's own terminal: forge dash's gate runner assists each gate in-process"], scope);
  }

  // A gate run's scope runs no forge command, a read included.
  const list = await forgeInProcess(r.dir, ['requests', 'list'], { env: scoped('_gates') });
  assert.deepEqual([list.status, list.error?.message], [1, GATES]);
  assert.deepEqual(events(r.dir, job), before, 'nothing above wrote an event');
});
