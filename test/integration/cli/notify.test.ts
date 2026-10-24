// A spawned `forge` notifies on a transition: main() registers notify at start, so a failure set
// from the CLI runs notify.command, with no import doing it. The test waits for the sender's recorded
// result (its last write) so cleanup never races the detached child.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { jobFiles } from '#core/paths.ts';
import { parseEventLines } from '#core/job/store.ts';
import type { JobEvent } from '#core/types.ts';
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
    const files = jobFiles(repo.dir, id, 'events.jsonl');
    const ev = await waitFor(
      () => {
        let last: JobEvent | undefined;
        for (const f of files) {
          if (!fs.existsSync(f)) return false;
          last = parseEventLines(fs.readFileSync(f, 'utf8')).find((e) => {
            const x = e as { target?: unknown; event?: unknown };
            return (e.type === 'notified' || e.type === 'notify-failed') && x.target === 'command' && x.event === 'job-failed';
          });
          if (!last) return false;
        }
        // `last` ends as the folder copy's event, which is the sender's final write.
        return last;
      },
      { what: 'the notify send child recorded its command result (notified/notify-failed, target command) in every events.jsonl copy' },
    );
    assert.equal((ev as JobEvent).type, 'notified', JSON.stringify(ev));
    assert.equal(fs.readFileSync(path.join(repo.dir, 'notified.txt'), 'utf8'), 'job-failed');
  } finally {
    repo.cleanup();
    fs.rmSync(answers, { force: true });
  }
});
