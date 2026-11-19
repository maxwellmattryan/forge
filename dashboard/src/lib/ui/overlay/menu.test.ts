// A role="menu" panel's arrow-key focus moves (MenuButton's menu mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import { menuMove } from './menu.ts';

test('menuMove', () => {
  // Down and Up step and wrap at both ends.
  assert.equal(menuMove(4, 0, 'ArrowDown'), 1);
  assert.equal(menuMove(4, 3, 'ArrowDown'), 0);
  assert.equal(menuMove(4, 2, 'ArrowUp'), 1);
  assert.equal(menuMove(4, 0, 'ArrowUp'), 3);
  // Home and End jump to the ends from anywhere.
  assert.equal(menuMove(4, 2, 'Home'), 0);
  assert.equal(menuMove(4, 1, 'End'), 3);
  // One item stays put.
  assert.equal(menuMove(1, 0, 'ArrowDown'), 0);
  assert.equal(menuMove(1, 0, 'ArrowUp'), 0);
  // An unhandled key, or an empty menu, is -1.
  for (const key of ['Enter', ' ', 'Tab', 'ArrowLeft', 'a']) assert.equal(menuMove(4, 1, key), -1, key);
  assert.equal(menuMove(0, 0, 'ArrowDown'), -1);
  assert.equal(menuMove(0, 0, 'Home'), -1);
});
