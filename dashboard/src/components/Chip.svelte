<!-- A tone chip: the markup util.ts toneChip() builds, with an optional extra class. -->
<script lang="ts">
  import { TONE_CLASS } from '../lib/util.ts';

  let { tone, text, extra = '' }: { tone: string; text: unknown; extra?: string } = $props();
</script>

<span class="chip {extra} {TONE_CLASS[tone]}">{text}</span>
