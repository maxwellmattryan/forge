<!-- The view links: the sidebar list, or the compact phone bar when `mobile`. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { S } from '../lib/app.svelte.ts';
  import { VIEWS, navCounts } from '../lib/view.ts';

  let { mobile = false }: { mobile?: boolean } = $props();
  const counts = $derived(navCounts(S.data?.jobs ?? []));
  const badge = (id: string): number => (id === 'pipeline' ? counts.active : id === 'inbox' ? counts.needs : 0);
</script>

{#each VIEWS as v (v.id)}
  {#if mobile}
    <a href="#/{v.id}" class="nav-item shrink-0 {S.view === v.id ? 'active' : ''}">{badge(v.id) ? `${v.label} ` : v.label}{#if badge(v.id)}<span class="text-muted">{badge(v.id)}</span>{/if}</a>
  {:else}
    <a href="#/{v.id}" class="nav-item {S.view === v.id ? 'active' : ''}"><span class="flex items-center gap-2"><Icon name={v.icon} />{v.label}</span>{#if badge(v.id)}<span class="text-[11px] tabular-nums {v.id === 'inbox' ? 'chip bg-warn/15 text-warn' : 'text-muted'}">{badge(v.id)}</span>{/if}</a>
  {/if}
{/each}
