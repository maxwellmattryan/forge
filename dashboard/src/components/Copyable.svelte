<!-- Text that copies itself: a button showing `text`, with a copy icon, that writes it to the clipboard and toasts. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import Tooltip from './Tooltip.svelte';
  import { t } from '../lib/text/locale.ts';
  import { toast } from '../lib/ui/overlay/toast.svelte.ts';

  let { text, class: cls = '' }: { text: string; class?: string } = $props();

  let wrap = $state<HTMLSpanElement>();

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toast($t('common.copied', { text }));
    } catch {
      toast($t('common.copyFailed', { text }), true);
    }
  }
</script>

<span bind:this={wrap} class="inline-flex min-w-0"><button
    type="button"
    class="group inline-flex min-w-0 items-center gap-1 break-all text-left hover:text-gleam {cls}"
    aria-label={$t('common.copy', { text })}
    onclick={copy}><span>{text}</span><span class="shrink-0 opacity-60 group-hover:opacity-100"><Icon name="copy" /></span></button><Tooltip anchor={wrap} text={$t('common.copy', { text })} /></span>
