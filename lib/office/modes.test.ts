// The pool's permission modes: the launch mode starts every job and inbox session (and the `_office` scope, the retired office session's), a chat asks, and a human's own choice wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModeBook } from './modes.ts';

test("the launch mode is every session's starting mode but a chat's", () => {
  const book = createModeBook('auto');
  for (const scope of ['_inbox', '_office', 'j-1', 'j-later']) assert.equal(book.launch(scope), 'auto', scope);
  assert.equal(book.launch('_chat-0123456789ab'), 'default', 'a chat still asks');
  assert.equal(book.state().launchPermissionMode, 'auto');
  assert.equal(book.state().jobPermissionMode, 'auto', 'the job default starts at the launch mode');
  book.chooseJobs('dontAsk');
  assert.equal(book.launch('j-1'), 'dontAsk');
  assert.equal(book.launch('_inbox'), 'auto', 'the job default never moves the inbox');
  assert.equal(book.launch('_office'), 'auto', 'nor the office');
  assert.equal(book.launch('_chat-0123456789ab'), 'default', 'nor a chat');
  assert.equal(book.state().launchPermissionMode, 'auto');

  const none = createModeBook();
  none.setCommand('claude -p {session} --permission-mode dontAsk');
  assert.equal(none.launch('_inbox'), null, "without a launch mode the inbox keeps daemon.command's");
  assert.equal(none.launch('_office'), null, "and so does the office");
  assert.equal(none.state().launchPermissionMode, null);
});

test('a session\'s own choice overrides the launch mode both ways', () => {
  const auto = createModeBook('auto');
  auto.choose('_inbox', 'default');
  assert.equal(auto.launch('_inbox'), 'default', 'narrower');
  auto.choose('_office', 'dontAsk');
  assert.equal(auto.launch('_office'), 'dontAsk');
  auto.choose('_office', 'auto');
  assert.equal(auto.launch('_office'), 'auto');
  assert.equal(auto.chosen('_office'), false, 'the launch mode holds no entry');

  const ask = createModeBook('default');
  ask.choose('_inbox', 'auto');
  assert.equal(ask.launch('_inbox'), 'auto', 'wider');
  ask.refused('_inbox', 'auto', 'default');
  assert.equal(ask.chosen('_inbox'), false, 'a refused switch back to the launch mode leaves no entry');
  assert.equal(ask.launch('_inbox'), 'default');
});

test('a chat launches in default unless the owner chose its mode', () => {
  const chat = '_chat-0123456789ab';
  const book = createModeBook('auto');
  book.setCommand('claude -p {session} --permission-mode dontAsk');
  assert.equal(book.launch(chat), 'default', "not daemon.command's dontAsk, nor the launch mode");
  assert.equal(createModeBook().launch('_inbox'), null, "without a launch mode the inbox keeps daemon.command's");
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
