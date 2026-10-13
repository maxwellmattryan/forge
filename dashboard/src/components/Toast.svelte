<!-- The bottom toast; toast.svelte.ts drives it. -->
<script lang="ts">
  import { toastState as t } from '../lib/toast.svelte.ts';
</script>

<div id="toast" class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 {t.shown ? '' : 'hidden'} card px-4 py-2 text-sm shadow-lg {t.bad ? 'text-bad' : ''}">{t.msg}</div>
