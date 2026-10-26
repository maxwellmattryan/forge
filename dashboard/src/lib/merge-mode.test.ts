// The drawer's merge mode against the engine's rule (agentsMerge is autoMerge's), and the POST it sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoMerge, defaults } from '#core/config/load.ts';
import { normalizeJob } from '#core/job/schema.ts';
import { agentsMerge, postJobMergeMode } from './merge-mode.ts';
import { setProject } from './project.ts';

setProject('web');

test('agentsMerge agrees with the engine for every mode, valid or not, over merge.auto on and off', () => {
  for (const auto of [true, false]) {
    const config = defaults();
    config.merge.auto = auto;
    for (const mode of [null, 'auto', 'human', 'yes', 'AUTO', 1]) assert.equal(agentsMerge(mode, auto), autoMerge(config, normalizeJob({ id: 'x', mergeMode: mode })), `${auto} ${String(mode)}`);
  }
});

test('postJobMergeMode posts the mode to the project route, and throws the server error', async () => {
  const calls: [string, RequestInit][] = [];
  const reply = (status: number, body: string): typeof fetch => (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return new Response(body, { status });
  }) as typeof fetch;
  await postJobMergeMode('a/b', null, 'tok', reply(200, '{}'));
  assert.deepEqual([calls[0][0], calls[0][1].body, (calls[0][1].headers as Record<string, string>)['x-forge-token']], ['/api/p/web/jobs/a%2Fb/merge-mode', '{"mergeMode":null}', 'tok']);
  await assert.rejects(postJobMergeMode('j', 'auto', 'tok', reply(400, '{"error":"mergeMode must be one of auto, human, or null"}')), /mergeMode must be one of/);
});
