<!-- The view links: the sidebar list, the compact phone strip (no icons) when `mobile`, or the sidebar's icon-only rail
     when `compact` (each link named by aria-label, with a tooltip on hover and focus). -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { S } from '../lib/app.svelte.ts';
  import { VIEWS, navCounts, type ViewId } from '../lib/nav.ts';
  import { railTipOn } from '../lib/rail-tip.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { mobile = false, compact = false }: { mobile?: boolean; compact?: boolean } = $props();
  const counts = $derived(navCounts(S.data?.jobs ?? []));
  const labels = $derived<Record<ViewId, string>>({
    pipeline: $t('nav.pipeline'),
    project: $t('nav.project'),
    backlog: $t('nav.backlog'),
    agents: $t('nav.agents'),
    analytics: $t('nav.analytics'),
    evals: $t('nav.evals'),
  });
  const badge = (id: string): number => (id === 'pipeline' ? counts.active : 0);
  /** The rail link's name: the label, and the count when there is one ("Pipeline · 3"). */
  const railName = (id: ViewId, n: number): string => (n ? `${labels[id]} · ${n}` : labels[id]);
</script>

<!-- Inside a .nav container (App.svelte): the sidebar column, or the phone strip's .nav.row. -->
{#each VIEWS as v (v.id)}
  {@const n = badge(v.id)}
  {@const on = S.view === v.id}
  <a href="#/{v.id}" class={on ? 'active' : ''} aria-current={on ? 'page' : undefined} aria-label={compact ? railName(v.id, n) : undefined} {@attach compact && railTipOn(railName(v.id, n))}
    >{#if compact}<Icon name={v.icon} />{#if n}<span class="mono num absolute top-1 right-1 text-[10px] leading-none {on ? '' : 'muted'}" aria-hidden="true">{n}</span>{/if}{:else}<span class="lbl">{#if !mobile}<Icon name={v.icon} />{/if}{labels[v.id]}</span>
      {#if n}<span class="mono num {on ? '' : 'muted'}">{n}</span>{/if}{/if}</a
  >
{/each}
