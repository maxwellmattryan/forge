<!-- The bottom toast; toast.svelte.ts drives it. The live region is always in the DOM, so screen readers announce each message as it appears. -->
<script lang="ts">
  import { toastState as t } from '../lib/toast.svelte.ts';
</script>

<div id="toast" role="status" aria-live={t.bad ? 'assertive' : 'polite'} aria-atomic="true" class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)]">{#if t.shown}<div class="card bg-bg px-4 py-2 text-sm shadow-lg {t.bad ? 'text-bad' : ''}">{t.msg}</div>{/if}</div>
