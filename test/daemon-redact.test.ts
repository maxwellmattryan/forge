// A daemon session's log lines are redacted at write (lib/daemon.ts logLine): the file, the replay
// ring and the SSE line all carry the same redacted bytes, at the same offsets. No claude stub runs.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import { createSession, sessionFiles, sessionOptions } from '../lib/daemon.ts';
import type { SessionEvent } from '../lib/daemon.ts';
import { createJob } from '../lib/jobs.ts';
import { recordKnown } from '../lib/known-secrets.ts';

/** A session for `scope` whose log sink appends synchronously to the real log file. */
function session(root: string, scope: string) {
  const emitted: SessionEvent[] = [];
  const ctx = { emit: (e: SessionEvent) => emitted.push(e), config: () => defaults() } as any;
  const file = sessionFiles(root, scope).log;
  const o = sessionOptions({ openLog: (f) => ({ write: (s: string) => (fs.appendFileSync(f, s), true) }) });
  return { s: createSession(root, scope, ctx, o), emitted, file };
}

describe('daemon log redaction', { concurrency: 4 }, () => {
  test('session log lines are redacted at write', () => {
    const repo = tempRepo();
    try {
      const config = defaults();
      const a = createJob(repo.dir, config, { title: 'A' }).id;
      const b = createJob(repo.dir, config, { title: 'B' }).id;
      const va = `va"\\-${crypto.randomBytes(8).toString('hex')}`;
      const vb = `vb-${crypto.randomBytes(8).toString('hex')}`;
      recordKnown(repo.dir, a, { A: va });
      recordKnown(repo.dir, b, { B: vb });

      const { s, emitted, file } = session(repo.dir, a);
      s.logEvent('note', { text: `first ${va} ${vb}` });
      s.logEvent('note', { text: 'second' });
      const disk = fs.readFileSync(file, 'utf8');
      assert.ok(!disk.includes(va) && !disk.includes(JSON.stringify(va).slice(1, -1)), 'the job scope redacts its own value');
      assert.ok(disk.includes(vb), "another job's value is not this scope's to redact");
      const [l1, l2] = disk.split('\n');
      assert.match(l1, /first \[redacted\]/);
      const ring = s.recent();
      assert.deepEqual(ring.map((r) => r.line), [l1, l2]);
      assert.deepEqual(ring.map((r) => r.offset), [0, Buffer.byteLength(l1) + 1], 'offsets count the redacted bytes');
      assert.equal(Buffer.from(disk).subarray(ring[1].offset).toString('utf8'), `${l2}\n`);
      const lines = emitted.filter((e): e is Extract<SessionEvent, { kind: 'line' }> => e.kind === 'line');
      assert.deepEqual(lines.map((e) => [e.offset, e.line]), ring.map((r) => [r.offset, r.line]));

      // The inbox and office scopes redact every job's values.
      const inbox = session(repo.dir, '_inbox');
      inbox.s.logEvent('note', { text: `both ${va} ${vb}` });
      const inboxDisk = fs.readFileSync(inbox.file, 'utf8');
      assert.ok(!inboxDisk.includes(va) && !inboxDisk.includes(JSON.stringify(va).slice(1, -1)) && !inboxDisk.includes(vb));
      assert.match(inboxDisk, /both \[redacted\] \[redacted\]/);
    } finally {
      repo.cleanup();
    }
  });
});
