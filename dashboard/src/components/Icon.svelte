<!-- An inline stroke icon from lib/icons.ts. -->
<script lang="ts">
  import { ICONS, type IconName } from '../lib/icons.ts';

  let { name, class: cls = 'size-4' }: { name: IconName; class?: string } = $props();
</script>

<svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d={ICONS[name]} /></svg>
