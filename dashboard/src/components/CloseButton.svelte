<!-- The one close control: a quiet square icon button at its siblings' height (sm or md). `ghost` drops the border at rest,
     so only the cross shows; hover, press and the focus ring are every btn's. -->
<script lang="ts">
  import Icon from './Icon.svelte';

  let { label, onclick, size = 'md', class: cls = '' }: { label: string; onclick: (e: MouseEvent) => void; size?: 'sm' | 'md'; class?: string } = $props();
</script>

<button type="button" class="btn icon ghost shrink-0 {size === 'sm' ? 'sm' : ''} {cls}" aria-label={label} {onclick}><Icon name="close" /></button>
