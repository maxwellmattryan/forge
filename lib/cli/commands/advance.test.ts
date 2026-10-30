// `forge job advance`'s record of what one call ran, in-process: a fake dispatch decides each command's outcome, so
// nothing runs and the event is compared with the call's own `ran`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobAt, tempRepo, withLease } from '../../../test/helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { readEvents } from '#core/job/store.ts';
import { progressMark } from '#office/reconcile.ts';
import { advance } from './advance.ts';
import type { AdvanceRan, CliContext, Dispatch } from '../types.ts';

const S = '11111111-1111-4111-8111-111111111111';

test('advance logs what it ran', async () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const ctx: CliContext = { root, config: loadConfig(root).config, initialized: true };
    // The first command works with a reply far over the line cap; the second fails, which ends the call.
    let calls = 0;
    const dispatch: Dispatch = async () => (++calls === 1 ? { data: 'x'.repeat(500), exitCode: 0 } : { data: { error: 'the remote\nrefused it' }, exitCode: 1 });
    const { id } = jobAt(root, 'backlog');
    withLease(root, id, S);
    const r = await advance(ctx, id, { session: S, max: 20 }, dispatch);
    const out = r.data as { ran: AdvanceRan[]; failed?: boolean };
    assert.deepEqual([r.exitCode, out.failed, out.ran.length], [1, true, 2], JSON.stringify(out));
    const events = readEvents(root, id);
    const logged = events.filter((e) => e.type === 'advance-ran');
    assert.equal(logged.length, 1, 'one event per call');
    assert.deepEqual(
      logged[0].ran,
      out.ran.map((x) => ({ rule: x.rule, command: ['forge', ...x.command.slice(0, 3)].join(' '), ok: x.ok, text: x.tell ?? (x.ok ? x.result : x.error) })),
    );
    const [first, failed] = logged[0].ran as { command: string; ok: boolean; text: string }[];
    assert.ok(first.command.split(' ').length <= 4 && first.command.startsWith('forge '), first.command);
    assert.ok(first.text.length <= 200 && !first.text.includes('\n'), 'one line of at most 200 characters');
    assert.deepEqual([failed.ok, failed.text.includes('\n')], [false, false], 'the failed entry is included, on one line');
    // No progress: the reconciler's mark is the same with and without it.
    assert.equal(progressMark(events), progressMark(events.filter((e) => e.type !== 'advance-ran')));

    // A call whose first step is no `run` ran nothing, and logs nothing.
    const { id: planned } = jobAt(root, 'plan');
    withLease(root, planned, S);
    const p = await advance(ctx, planned, { session: S, max: 20 }, dispatch);
    assert.deepEqual([(p.data as { action: string }).action, (p.data as { ran: unknown[] }).ran], ['spawn', []]);
    assert.equal(readEvents(root, planned).filter((e) => e.type === 'advance-ran').length, 0);
  } finally {
    repo.cleanup();
  }
});
