<!-- The bottom toast; toast.svelte.ts drives it. The live region is always in the DOM, so screen readers announce each message as it appears. -->
<script lang="ts">
  import { toastState as toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';
</script>

<div id="toast" role="status" aria-live={toast.bad ? 'assertive' : 'polite'} aria-atomic="true" class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)]">{#if toast.shown}<div class="sheet ticks solid flex items-center gap-2.5 px-4 py-2 text-sm shadow-(--shadow-dialog) {toast.bad ? 'text-bad' : ''}"><span class="tk"></span>{#if toast.bad}<span class="chip rev shrink-0" aria-hidden="true">{$t('common.rev')}</span>{/if}<span class="min-w-0">{toast.msg}</span></div>{/if}</div>
