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

test('a chat launches in default unless the owner chose its mode', () => {
  const chat = '_chat-0123456789ab';
  const book = createModeBook('auto');
  book.setCommand('claude -p {session} --permission-mode dontAsk');
  assert.equal(book.launch(chat), 'default', "not daemon.command's dontAsk, nor the job default");
  assert.equal(book.launch('_inbox'), null, "the inbox keeps daemon.command's");
  book.chooseJobs('dontAsk');
  assert.equal(book.launch(chat), 'default', 'chooseJobs never reaches a chat');
  book.choose(chat, 'auto');
  assert.equal(book.launch(chat), 'auto', "the owner's choice");
  assert.equal(book.launch('_chat-ffffffffffff'), 'default', 'only that chat');
  book.choose(chat, 'default');
  assert.equal(book.launch(chat), 'default');
  assert.equal(book.chosen(chat), false, 'default is its fallback, so no entry is held');
  book.choose(chat, 'dontAsk');
  assert.equal(book.launch(chat), 'dontAsk');
});
