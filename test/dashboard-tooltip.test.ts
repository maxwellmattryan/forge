// dashboard/src/lib/tooltip.ts: where an icon button's tooltip opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIP_DELAY_MS, placeTip } from '../dashboard/src/lib/tooltip.ts';

const VIEW = { vw: 1440, vh: 900 };
// A 28×28 button at x 900..928, y 100..128.
const BUTTON = { top: 100, bottom: 128, left: 900, right: 928 };

test('hover waits 400 ms', () => {
  assert.equal(TIP_DELAY_MS, 400);
});

test('placeTip centres the tip 6 px below the button when there is room', () => {
  // Centre 914, an 80×24 tip: left 874, top 128 + 6.
  assert.deepEqual(placeTip({ ...BUTTON, ...VIEW, width: 80, height: 24 }), { left: 874, top: 134 });
});

test('placeTip keeps the tip 8 px inside the right edge', () => {
  const at = placeTip({ top: 100, bottom: 128, left: 1410, right: 1438, ...VIEW, width: 120, height: 24 });
  assert.deepEqual(at, { left: 1440 - 120 - 8, top: 134 });
});

test('placeTip keeps the tip 8 px inside the left edge', () => {
  const at = placeTip({ top: 100, bottom: 128, left: 0, right: 28, ...VIEW, width: 120, height: 24 });
  assert.deepEqual(at, { left: 8, top: 134 });
});

test('placeTip flips above near the bottom', () => {
  // Below would end at 860 + 6 + 40 = 906, past 900 - 8: above at 832 - 6 - 40.
  assert.deepEqual(placeTip({ top: 832, bottom: 860, left: 900, right: 928, ...VIEW, width: 80, height: 40 }), { left: 874, top: 786 });
  // Ending exactly 8 px above the bottom still fits below.
  assert.deepEqual(placeTip({ top: 800, bottom: 828, left: 900, right: 928, ...VIEW, width: 80, height: 58 }), { left: 874, top: 834 });
  // One pixel more flips.
  assert.equal(placeTip({ top: 800, bottom: 828, left: 900, right: 928, ...VIEW, width: 80, height: 59 }).top, 800 - 6 - 59);
});

test('placeTip pins a tip larger than the viewport to the top-left margin', () => {
  assert.deepEqual(placeTip({ top: 50, bottom: 78, left: 100, right: 128, vw: 200, vh: 100, width: 300, height: 150 }), { left: 8, top: 8 });
});
