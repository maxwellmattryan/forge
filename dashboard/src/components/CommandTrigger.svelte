<!-- "Command for this job" in the drawer header: opens the command palette scoped to `job`. The status bar holds the
     palette's other triggers; src/lib/shell/palette.svelte.ts holds the open state and focus return. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { openPalette } from '../lib/shell/palette.svelte.ts';
  import { t } from '../lib/text/locale.ts';

  let { job }: { job: string | null } = $props();

  // The button itself is the opener: Safari does not focus a button on click, so activeElement would be <body>.
  function open(e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    openPalette({ scope: job, opener: e.currentTarget });
  }
</script>

<!-- Below sm only the icon shows; the label stays as its accessible name, and min-w-11 keeps it 44px wide. -->
<button class="btn sm shrink-0 max-sm:min-w-11 justify-center" aria-haspopup="dialog" onclick={open}><Icon name="command" /><span class="max-sm:sr-only">{$t('command.forJob')}</span></button>
