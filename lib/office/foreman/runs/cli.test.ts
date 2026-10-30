// An office run's CLI argv and how a child's exit and JSON are read, in-process: only the seven office
// commands, every positional after `--`, the reason one cleaned `--reason=` word, and every id checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { officeArgv, officeCliResult, type OfficeArgs, type OfficeCommand } from './cli.ts';

const RID = '1761800000000-abc123';
const UUID = '0b5d6c3e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

test('officeArgv', () => {
  const ok: [OfficeCommand, OfficeArgs, string[]][] = [
    ['draft-prepare', { mandate: 'm-1', request: RID }, ['mandate', 'draft', 'prepare', '--json', `--request=${RID}`, '--', 'm-1']],
    ['draft-record', { mandate: 'm-1', request: RID, agentId: UUID }, ['mandate', 'draft', 'record', '--json', `--request=${RID}`, `--agent-id=${UUID}`, '--', 'm-1']],
    ['survey', {}, ['office', 'survey', '--json']],
    ['board', { mandate: 'm-1' }, ['office', 'board', '--json', '--', 'm-1']],
    ['start', { mandate: 'm-1', ref: '-F-1', reason: 'next listed issue' }, ['office', 'start', '--json', '--reason=next listed issue', '--', 'm-1', '-F-1']],
    ['resume', { mandate: 'm-1', job: 'add-json-flag', reason: 'resumable: queued with no live lease' }, ['office', 'resume', '--json', '--reason=resumable: queued with no live lease', '--', 'm-1', 'add-json-flag']],
    ['note', { mandate: 'm-1', reason: 'held F-1: waits on "F-2" `$(x)`\n--force' }, ['office', 'note', '--json', '--reason=held F-1: waits on F-2 (x)--force', '--', 'm-1']],
  ];
  for (const [cmd, args, want] of ok) assert.deepEqual(officeArgv(cmd, args), want, cmd);

  const refused: [string, string, OfficeArgs][] = [
    ['another command', 'job-claim', { mandate: 'm-1' }],
    ['pr merge', 'pr merge', {}],
    ['a mandate id that fails the pattern', 'board', { mandate: '--all' }],
    ['an uppercase mandate id', 'note', { mandate: 'M-1', reason: 'r' }],
    ['a mandate id that climbs', 'draft-prepare', { mandate: '../m', request: RID }],
    ['a request id that fails the pattern', 'draft-prepare', { mandate: 'm-1', request: '--request=x' }],
    ['a request id with a path', 'draft-record', { mandate: 'm-1', request: '1-../x', agentId: UUID }],
    ['a non-UUID agent id', 'draft-record', { mandate: 'm-1', request: RID, agentId: 'agent-1' }],
    ['a job id that fails validJobId', 'resume', { mandate: 'm-1', job: '../x', reason: 'r' }],
    ['an empty ref', 'start', { mandate: 'm-1', ref: '', reason: 'r' }],
    ['a ref with a control character', 'start', { mandate: 'm-1', ref: 'F-1\n--force', reason: 'r' }],
    ['an empty reason once cleaned', 'note', { mandate: 'm-1', reason: ' `$\\" ' }],
    ['no reason', 'start', { mandate: 'm-1', ref: 'F-1' }],
  ];
  for (const [name, cmd, args] of refused) assert.throws(() => officeArgv(cmd as OfficeCommand, args), name);
});

test('officeCliResult', () => {
  assert.deepEqual(officeCliResult({ exit: 0, json: { ok: true }, problem: null }), { kind: 'ok', data: { ok: true } });
  assert.deepEqual(officeCliResult({ exit: 1, json: { error: { message: 'mandate m-1 is paused' } }, problem: null }), { kind: 'refused', exit: 1, message: 'mandate m-1 is paused' });
  assert.equal(officeCliResult({ exit: 4, json: { error: { message: 'repo budget: held' } }, problem: null }).kind, 'refused');
  const crashes = [
    { exit: 0, json: null, problem: null },
    { exit: 0, json: { error: { message: 'x' } }, problem: null },
    { exit: 0, json: [1], problem: null },
    { exit: 5, json: { error: { message: 'gh failed' } }, problem: null },
    { exit: 1, json: null, problem: null },
    { exit: null, json: null, problem: 'killed by SIGKILL' },
    { exit: 0, json: { ok: true }, problem: 'timed out' },
  ];
  for (const r of crashes) assert.equal(officeCliResult(r).kind, 'crash', JSON.stringify(r));
});
