// A spawned `forge` notifies on a transition: main() registers notify at start, so a failure set
// from the CLI runs notify.command, with no import doing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, forgeInProcess, tempRepo, waitFor } from '../../helpers.ts';

test('a forge process notifies through the hook main registers', async () => {
  const repo = tempRepo();
  const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
  try {
    fs.writeFileSync(answers, JSON.stringify({ notify: { command: 'printf %s {event} > notified.txt' } }));
    const init = await forgeInProcess(repo.dir, ['init', 'write', '--answers', answers]);
    assert.equal(init.status, 0, JSON.stringify(init.error));
    const job = await forgeInProcess(repo.dir, ['job', 'new', '--title', 'notify me']);
    const id = (job.data as { id: string }).id;
    // In-process, so no hook is registered and the running transition notifies nothing.
    assert.equal((await forgeInProcess(repo.dir, ['job', 'set', id, '--state', 'running'])).status, 0);
    const r = await forgeAsync(repo.dir, ['job', 'set', id, '--state', 'failed']);
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(repo.dir, 'notified.txt');
    const text = await waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8'), { what: 'notify.command wrote its file' });
    assert.equal(text, 'job-failed');
  } finally {
    repo.cleanup();
    fs.rmSync(answers, { force: true });
  }
});
