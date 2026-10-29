// The command bar's `project` word: parsing, completion, what running it does, and the bar with no project selected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canRunCommand, commandRequest, emptyReason, parseCommand, suggest, type CommandCtx, type Suggestion } from './command.ts';
import type { SwitcherEntry } from './switcher.ts';

const entry = (name: string, waiting = 0, state: SwitcherEntry['state'] = 'ok'): SwitcherEntry => ({ name, path: `/src/${name}`, state, openable: state === 'ok', waiting, active: 0, daemon: null });
const projects = [entry('api'), entry('apps', 2), entry('gone', 0, 'missing'), entry('web', 1), entry('wiki'), entry('shut', 3, 'unavailable')];
const ctx = (project: string | null): CommandCtx => ({ jobs: [], backlog: [], tracker: 'none', projects, project });
const rows = (s: Suggestion[]): string[] => s.map((o) => (o.kind === 'project' ? `project:${o.entry.name}` : o.kind === 'verb' ? `verb:${o.verb}` : o.kind));

test('project command', () => {
  const on = ctx('web');
  // Parsing.
  assert.deepEqual(parseCommand('project api', on), { kind: 'project', name: 'api' });
  assert.deepEqual(parseCommand('/forge project wiki', on), { kind: 'project', name: 'wiki' });
  assert.deepEqual(parseCommand('project ap', on), { kind: 'partial', verb: 'project', arg: 'ap' }, 'a prefix of an openable name');
  assert.deepEqual(parseCommand('project ', on), { kind: 'partial', verb: 'project', arg: '' });
  assert.deepEqual(parseCommand('project gone', on), { kind: 'free', text: 'project gone' }, 'a missing project is not openable');
  assert.deepEqual(parseCommand('project sh', on), { kind: 'free', text: 'project sh' }, 'nor an unavailable one');
  assert.deepEqual(parseCommand('project api now', on), { kind: 'free', text: 'project api now' });
  assert.deepEqual(parseCommand('projects are hard', on), { kind: 'free', text: 'projects are hard' }, 'a non-project word stays free text');

  // Completion: openable projects only, waiting first, then by name.
  assert.deepEqual(rows(suggest('project ', on)), ['project:apps', 'project:web', 'project:api', 'project:wiki']);
  assert.deepEqual(rows(suggest('project w', on)), ['project:web', 'project:wiki']);
  assert.deepEqual(rows(suggest('project api', on)), ['run-command', 'project:api'], 'a complete name runs, and still lists its row');
  const row = suggest('project ', on)[0];
  assert.ok(row.kind === 'project' && row.entry.waiting === 2 && row.insert === 'project apps');
  assert.deepEqual(rows(suggest('proj', on)), ['verb:project', 'run-job']);
  assert.equal(rows(suggest('', on)).at(-1), 'verb:project', 'the word is listed last');

  // Running it opens the project.
  assert.deepEqual(commandRequest({ kind: 'project', name: 'api' }), { kind: 'open', project: 'api' });
  assert.equal(canRunCommand(parseCommand('project api', on), on), true);
  assert.equal(canRunCommand(parseCommand('next 2', on), on), true);

  // With no project selected.
  const off = ctx(null);
  assert.deepEqual(rows(suggest('', off)), ['project:apps', 'project:web', 'project:api', 'project:wiki', 'verb:project'], 'project rows first, then the word');
  assert.deepEqual(rows(suggest('project w', off)), ['project:web', 'project:wiki']);
  assert.deepEqual(rows(suggest('project web', off)), ['run-command', 'project:web']);
  assert.deepEqual(rows(suggest('pro', off)), ['verb:project']);
  assert.equal(canRunCommand(parseCommand('project web', off), off), true);
  for (const input of ['fix the login page', 'next', 'sync', 'approve j1', 'issue 12', 'project nope']) {
    const p = parseCommand(input, off);
    const options = suggest(input, off);
    assert.deepEqual(options, [], input);
    assert.equal(emptyReason(p, options, null, off), 'noProject', input);
    assert.equal(canRunCommand(p, off), false, `${input} is not runnable`);
  }
  assert.equal(emptyReason(parseCommand('', off), suggest('', off), null, off), null);
  assert.equal(emptyReason(parseCommand('approve ', on), [], null, on), 'noJobs', 'a selected project keeps the old reasons');
});
