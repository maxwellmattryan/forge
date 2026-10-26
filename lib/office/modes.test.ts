// The pool's permission modes: shared sessions run in daemon.command's mode unless a human chose one for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModeBook } from './modes.ts';

test('assistant foremen are shared scopes', () => {
  const book = createModeBook('auto');
  assert.equal(book.launch('_assistant-1'), null, "daemon.command's mode, not the job default");
  assert.equal(book.launch('j-1'), 'auto');
  book.choose('_assistant-1', 'auto');
  assert.equal(book.launch('_assistant-1'), 'auto');
  book.chooseJobs('dontAsk');
  assert.equal(book.launch('_assistant-1'), 'auto', 'the job default leaves it alone');
  assert.equal(book.launch('j-1'), 'dontAsk');
});
