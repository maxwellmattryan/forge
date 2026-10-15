<!-- The bottom toast; toast.svelte.ts drives it. The live region is always in the DOM, so screen readers announce each message as
     it appears, and it holds only the message: Dismiss sits beside it, outside, so the announcement stays the message alone.
     Pointer or focus inside holds the toast past its 4 s. -->
<script lang="ts">
  import CloseButton from './CloseButton.svelte';
  import { toastState as toast, dismissToast, holdToast, releaseToast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (hover and focus only pause the auto-hide; Dismiss is the control) -->
<div id="toast" class="fixed bottom-24 md:bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)]" onmouseenter={holdToast} onmouseleave={releaseToast} onfocusin={holdToast} onfocusout={releaseToast}>
  <div class="{toast.shown ? 'sheet ticks solid flex items-center gap-2.5 py-1 pl-4 pr-1 text-sm shadow-(--shadow-dialog)' : ''} {toast.shown && toast.bad ? 'text-bad' : ''}">
    <span class="tk"></span>
    <div role="status" aria-live={toast.bad ? 'assertive' : 'polite'} aria-atomic="true" class="flex min-w-0 items-center gap-2.5">{#if toast.shown}{#if toast.bad}<span class="chip rev shrink-0" aria-hidden="true">{$t('common.rev')}</span>{/if}<span class="min-w-0">{toast.msg}</span>{/if}</div>
    {#if toast.shown}<CloseButton size="sm" label={$t('common.dismiss')} onclick={dismissToast} />{/if}
  </div>
</div>
