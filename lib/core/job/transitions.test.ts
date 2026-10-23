// The transition hook list: registration order, one run per function, a remover, and a hook that
// throws stopping nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onTransition, runTransitionHooks } from './transitions.ts';
import type { LoadedJob, TransitionSide } from '../types.ts';

const job = { id: 'j1' } as LoadedJob;
const from: TransitionSide = { stage: 'build', state: 'running', waitingOn: null };
const to: TransitionSide = { stage: 'build', state: 'failed', waitingOn: null };

test('transition hooks run in order, each once, and a throwing hook stops nothing', () => {
  const calls: string[] = [];
  const first = (root: string, j: LoadedJob, f: TransitionSide, t: TransitionSide) => {
    calls.push(`first ${root} ${j.id} ${f.state}->${t.state}`);
  };
  const removers = [
    onTransition(first),
    onTransition(first),
    onTransition(() => {
      calls.push('thrower');
      throw new Error('boom');
    }),
    onTransition(() => {
      calls.push('last');
    }),
  ];
  try {
    assert.doesNotThrow(() => runTransitionHooks('/r', job, from, to));
    assert.deepEqual(calls, ['first /r j1 running->failed', 'thrower', 'last']);
    removers[0]();
    calls.length = 0;
    runTransitionHooks('/r', job, from, to);
    assert.deepEqual(calls, ['thrower', 'last'], 'the remover takes the hook out, however often it was added');
  } finally {
    for (const remove of removers) remove();
  }
  calls.length = 0;
  runTransitionHooks('/r', job, from, to);
  assert.deepEqual(calls, []);
});
