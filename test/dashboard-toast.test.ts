// dashboard/src/lib/toast-place.ts and Toast.svelte: the toast never covers the board's controls, the job pane's dock or
// the status bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toastPlacement } from '../dashboard/src/lib/toast-place.ts';

const TOAST = path.resolve(import.meta.dirname, '..', 'dashboard', 'src', 'components', 'Toast.svelte');

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

  const src = fs.readFileSync(TOAST, 'utf8');
  assert.match(src, /toastPlacement\(\{ narrow: !S\.pane\.md, paneOpen: S\.drawer\.id !== null, paneWidth: clampPaneWidth\(S\.pane\.width, S\.pane\.viewport\) \}\)/, 'Toast.svelte passes the clamped drawer width');
  assert.match(src, /id="toast" class="fixed z-50 /, 'above the drawer backdrop (z-30) and the drawer (z-40)');
  assert.match(src, /'bottom-\[calc\(var\(--size-statusbar\)_\+_env\(safe-area-inset-bottom\)_\+_var\(--space-3\)\)\] max-w-\[24rem\]'/, 'bottom-right: above the bar, at most 24rem');
  assert.match(src, /'top-3 left-1\/2 -translate-x-1\/2 max-w-\[calc\(100vw-2rem\)\]'/, 'top: centred, inside the viewport');
  assert.match(src, /right: calc\(\$\{place\.right\}px \+ var\(--space-4\)\)/, 'space-4 left of the pane or the viewport');
  for (const ev of ['onmouseenter={holdToast}', 'onmouseleave={releaseToast}', 'onfocusin={holdToast}', 'onfocusout={releaseToast}']) assert.ok(src.includes(ev), `${ev} still holds it`);
});
