<!-- Opens the command palette. Three variants: `header`, the dashed button at the end of every view's title row (md and up);
     `fab`, the round-cornerless phone button fixed at the bottom right (below md); `drawer`, "Command for this job" in the
     drawer header, which opens the palette scoped to `job`. lib/palette.svelte.ts holds the open state and focus return. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { shortcutLabel } from '../lib/command.ts';
  import { openPalette } from '../lib/palette.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { variant, job = null }: { variant: 'header' | 'fab' | 'drawer'; job?: string | null } = $props();
  const shortcut = shortcutLabel(typeof navigator === 'undefined' ? '' : navigator.platform);

  // The button itself is the opener: Safari does not focus a button on click, so activeElement would be <body>.
  function open(e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    openPalette({ scope: variant === 'drawer' ? job : null, opener: e.currentTarget });
  }
</script>

{#if variant === 'header'}
  <!-- max-md:hidden, not hidden md:inline-flex: btn sets display itself, and a variant always sorts after it. The kbd is hidden because aria-keyshortcuts announces it. -->
  <button class="btn sm dashed max-md:hidden max-w-[280px] justify-between" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" onclick={open}><span class="flex min-w-0 items-center gap-2 overflow-hidden"><Icon name="command" /><span class="truncate">{$t('command.open')}</span></span><kbd class="mono muted shrink-0 text-[10px]" aria-hidden="true">{shortcut}</kbd></button>
{:else if variant === 'fab'}
  <!-- The position sits on a wrapper: btn sets position: relative, which would race fixed. -->
  <div class="md:hidden fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-20"><button class="btn primary icon size-14! justify-center" aria-label={$t('command.open')} aria-haspopup="dialog" onclick={open}><Icon name="command" /></button></div>
{:else}
  <!-- Below sm only the icon shows; the label stays as its accessible name, and min-w-11 keeps it 44px wide. -->
  <button class="btn sm shrink-0 max-sm:min-w-11 justify-center" aria-haspopup="dialog" onclick={open}><Icon name="command" /><span class="max-sm:sr-only">{$t('command.forJob')}</span></button>
{/if}
