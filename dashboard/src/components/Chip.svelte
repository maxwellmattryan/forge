<!-- A tone chip: the markup util.ts toneChip() builds, with an optional extra class and a leading icon. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { TONE_CLASS } from '../lib/util.ts';
  import type { IconName } from '../lib/icons.ts';

  let { tone, text, extra = '', icon }: { tone: string; text: unknown; extra?: string; icon?: IconName } = $props();
</script>

<span class="chip {extra} {TONE_CLASS[tone]}">{#if icon}<Icon name={icon} />{/if}{text}</span>
