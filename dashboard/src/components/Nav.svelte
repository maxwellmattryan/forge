<!-- The view links: the sidebar list, or the compact phone strip (no icons) when `mobile`. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { S } from '../lib/app.svelte.ts';
  import { VIEWS, navCounts, type ViewId } from '../lib/view.ts';
  import { t } from '../lib/locale.ts';

  let { mobile = false }: { mobile?: boolean } = $props();
  const counts = $derived(navCounts(S.data?.jobs ?? []));
  const labels = $derived<Record<ViewId, string>>({
    pipeline: $t('nav.pipeline'),
    inbox: $t('nav.inbox'),
    backlog: $t('nav.backlog'),
    agents: $t('nav.agents'),
    analytics: $t('nav.analytics'),
    evals: $t('nav.evals'),
  });
  const badge = (id: string): number => (id === 'pipeline' ? counts.active : id === 'inbox' ? counts.needs : 0);
</script>

<!-- Inside a .nav container (App.svelte): the sidebar column, or the phone strip's .nav.row. -->
{#each VIEWS as v (v.id)}
  {@const n = badge(v.id)}
  {@const on = S.view === v.id}
  <a href="#/{v.id}" class={on ? 'active' : ''} aria-current={on ? 'page' : undefined}
    ><span class="lbl">{#if !mobile}<Icon name={v.icon} />{/if}{labels[v.id]}</span>
    {#if n}{#if v.id === 'inbox'}<span class="chip rev">{n}</span>{:else}<span class="mono num {on ? '' : 'muted'}">{n}</span>{/if}{/if}</a
  >
{/each}
