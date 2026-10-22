<!-- The toast; toast.svelte.ts drives it. The live region is always in the DOM, so screen readers announce each message as
     it appears, and it holds only the message: Dismiss sits beside it, outside, so the announcement stays the message alone.
     Pointer or focus inside holds the toast past its 4 s. Dismiss draws its ring inside itself: the plate clips to its cut corner, which would shave a ring drawn outside.
     It never covers the board's controls, the job drawer's dock or the status bar (lib/toast-place.ts): at md and up it sits
     at the bottom right, left of an open drawer and above its backdrop; below md, top-centre. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import CloseButton from './CloseButton.svelte';
  import { toastState as toast, dismissToast, holdToast, releaseToast } from '../lib/toast.svelte.ts';
  import { toastPlacement } from '../lib/toast-place.ts';
  import { S } from '../lib/app.svelte.ts';
  import { clampPaneWidth } from '../lib/drawer.ts';
  import { sidebarShown } from '../lib/sidebar.ts';
  import { t } from '../lib/locale.ts';

  const place = $derived(toastPlacement({ narrow: !S.pane.md, paneOpen: S.drawer.id !== null, paneWidth: clampPaneWidth(S.pane.width, S.pane.viewport, sidebarShown(S.side)) }));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (hover and focus only pause the auto-hide; Dismiss is the control) -->
<div id="toast" class="fixed z-50 {place.edge === 'top' ? 'top-3 left-1/2 -translate-x-1/2 max-w-[calc(100vw-2rem)]' : 'bottom-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom)_+_var(--space-3))] max-w-[24rem]'}" style={place.edge === 'bottom-right' ? `right: calc(${place.right}px + var(--space-4))` : undefined} onmouseenter={holdToast} onmouseleave={releaseToast} onfocusin={holdToast} onfocusout={releaseToast}>
  <div class="{toast.shown ? 'plate solid flex items-center gap-2.5 py-1.5 pl-4 pr-1.5 text-sm shadow-(--shadow-overlay)' : ''} {toast.shown && toast.bad ? 'text-bad' : ''}">
    <div role="status" aria-live={toast.bad ? 'assertive' : 'polite'} aria-atomic="true" class="flex min-w-0 items-center gap-2.5">{#if toast.shown}{#if toast.bad}<Chip tone="you" extra="shrink-0" ariaHidden text={$t('common.you')} />{/if}<span class="min-w-0">{toast.msg}</span>{/if}</div>
    {#if toast.shown}<CloseButton size="sm" class="focus-visible:-outline-offset-2" label={$t('common.dismiss')} onclick={dismissToast} />{/if}
  </div>
</div>
