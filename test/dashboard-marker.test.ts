// The sliding selected marker's geometry (dashboard/src/lib/marker.ts): the nav's bar, a tab strip's baseline and a seg's fill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markerBox } from '../dashboard/src/lib/marker.ts';

test('markerBox: bar-left, bar-bottom and fill', () => {
  const item = { offsetLeft: 12, offsetTop: 40, offsetWidth: 180, offsetHeight: 36 };
  assert.deepEqual(markerBox('bar-left', item), { x: 12, y: 40, width: 3, height: 36 }, 'a 3px bar down the left edge, the item tall');
  assert.deepEqual(markerBox('bar-bottom', item), { x: 12, y: 74, width: 180, height: 2 }, 'a 2px baseline at the bottom, the item wide');
  assert.deepEqual(markerBox('fill', item), { x: 12, y: 40, width: 180, height: 36 }, 'the item box');
});
