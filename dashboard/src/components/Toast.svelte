<!-- The toast; toast.svelte.ts drives it. The live region is always in the DOM and visually hidden, so screen readers announce
     each message as it appears (a region mounted together with its text is often not read), and it holds only the message.
     The visible plate rises in and fades out on its own, with its copy of the message aria-hidden so nothing is read twice;
     toastState.msg outlives `shown`, so the plate keeps its text while it fades. Pointer or focus inside holds the toast past
     its 4 s. Dismiss draws its ring inside itself: the plate clips to its cut corner, which would shave a ring drawn outside.
     It never covers the board's controls, the job drawer's dock or the status bar (src/lib/ui/overlay/toast-place.ts): at md and up it sits
     at the bottom right, left of an open drawer and above its backdrop; below md, top-centre. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import CloseButton from './CloseButton.svelte';
  import { toastState as toast, dismissToast, holdToast, releaseToast } from '../lib/ui/overlay/toast.svelte.ts';
  import { toastPlacement } from '../lib/ui/overlay/toast-place.ts';
  import { S } from '../lib/core/app.svelte.ts';
  import { clampPaneWidth } from '../lib/jobs/drawer.ts';
  import { EXIT, fade, rise } from '../lib/ui/motion.ts';
  import { sidebarShown } from '../lib/shell/sidebar.ts';
  import { t } from '../lib/text/locale.ts';

  const place = $derived(toastPlacement({ narrow: !S.pane.md, paneOpen: S.drawer.open, paneWidth: clampPaneWidth(S.pane.width, S.pane.viewport, sidebarShown(S.side)) }));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (hover and focus only pause the auto-hide; Dismiss is the control) -->
<div id="toast" class="fixed z-50 {place.edge === 'top' ? 'top-3 left-1/2 -translate-x-1/2 max-w-[calc(100vw-2rem)]' : 'bottom-[calc(var(--size-statusbar)_+_env(safe-area-inset-bottom)_+_var(--space-3))] max-w-[24rem]'}" style={place.edge === 'bottom-right' ? `right: calc(${place.right}px + var(--space-4))` : undefined} onmouseenter={holdToast} onmouseleave={releaseToast} onfocusin={holdToast} onfocusout={releaseToast}>
  <div role="status" aria-live={toast.bad ? 'assertive' : 'polite'} aria-atomic="true" class="sr-only">{#if toast.shown}{toast.msg}{/if}</div>
  {#if toast.shown}
    <div class="plate solid flex items-center gap-2.5 py-1.5 pl-4 pr-1.5 text-sm shadow-(--shadow-overlay) {toast.bad ? 'text-bad' : ''}" in:rise|global out:fade|global={EXIT}>
      <div class="flex min-w-0 items-center gap-2.5">{#if toast.bad}<Chip tone="you" extra="shrink-0" ariaHidden text={$t('common.you')} />{/if}<span class="min-w-0" aria-hidden="true">{toast.msg}</span></div>
      <CloseButton size="sm" class="focus-visible:-outline-offset-2" label={$t('common.dismiss')} onclick={dismissToast} />
    </div>
  {/if}
</div>
