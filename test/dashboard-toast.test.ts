// dashboard/src/lib/toast-place.ts: the toast never covers the board's controls, the job pane's dock or the status bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toastPlacement } from '../dashboard/src/lib/toast-place.ts';

test('toast placement avoids the pane, the dock and the status bar', () => {
  const at = (o: Partial<Parameters<typeof toastPlacement>[0]>) => toastPlacement({ narrow: false, paneOpen: false, paneWidth: 640, ...o });
  // md and up: the bottom right, left of an open drawer.
  assert.deepEqual(at({ paneOpen: true }), { edge: 'bottom-right', right: 640 }, 'drawer open: left of the drawer');
  assert.deepEqual(at({ paneOpen: true, paneWidth: 360 }), { edge: 'bottom-right', right: 360 });
  assert.deepEqual(at({ paneOpen: true, paneWidth: -5 }), { edge: 'bottom-right', right: 0 }, 'never right of the viewport edge');
  assert.deepEqual(at({}), { edge: 'bottom-right', right: 0 }, 'drawer closed: the viewport edge');
  // Below md, top-centre.
  assert.deepEqual(at({ narrow: true }), { edge: 'top' }, 'phone, drawer closed');
  assert.deepEqual(at({ narrow: true, paneOpen: true }), { edge: 'top' }, 'phone, drawer open');
});
