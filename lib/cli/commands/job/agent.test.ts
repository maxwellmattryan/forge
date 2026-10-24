// forge job agent: the role becomes a job.json key and part of a review path, so a name that is not
// a role is refused before anything is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { jobFiles } from '#core/paths.ts';
import { createJob, loadJob } from '#core/job/store.ts';
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
