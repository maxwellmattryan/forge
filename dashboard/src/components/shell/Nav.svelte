<!-- The sidebar's two sections: General (the Overview, then, with a project selected, its Office and Foreman, then the
     Machine page: GENERAL_NAV), then the project section, which is the project switcher and, with a project selected, its
     other view links. As the sidebar list, the phone strip (`mobile`: no icons, one scrolling row) or the icon-only rail
     (`compact`: each control named by aria-label, with a rail tooltip). Each section is its own navlist, so the Select
     never takes the list's link styles. -->
<script lang="ts">
  import Icon from '../ui/Icon.svelte';
  import ProjectSwitcher from './ProjectSwitcher.svelte';
  import { S } from '../../lib/core/app.svelte.ts';
  import { GENERAL_NAV, PROJECT_NAV, navCounts, type GlobalViewId, type ViewId } from '../../lib/shell/nav.ts';
  import { railTipOn } from '../../lib/shell/rail-tip.svelte.ts';
  import { slideMarker } from '../../lib/ui/marker.ts';
  import { t } from '../../lib/text/locale.ts';

  let { mobile = false, compact = false }: { mobile?: boolean; compact?: boolean } = $props();
  const project = $derived(S.selected);
  const counts = $derived(navCounts(S.data?.jobs ?? []));
  const labels = $derived<Record<GlobalViewId | ViewId, string>>({
    overview: $t('nav.overview'),
    machine: $t('nav.machine'),
    office: $t('nav.office'),
    pipeline: $t('nav.pipeline'),
    project: $t('nav.project'),
    issues: $t('nav.issues'),
    agents: $t('nav.agents'),
    foreman: $t('nav.foreman'),
    analytics: $t('nav.analytics'),
    evals: $t('nav.evals'),
  });
  const badge = (id: string): number => (id === 'pipeline' ? counts.active : 0);
  /** The rail link's name: the label, and the count when there is one ("Pipeline · 3"). */
  const railName = (id: ViewId, n: number): string => (n ? `${labels[id]} · ${n}` : labels[id]);
  // The phone strip keeps its items' own selected style, as before: no sliding bar in a scrolling row. Elsewhere one
  // marker lives on the wrapper around both sections, so it slides between a global page and a project view.
  const list = $derived(mobile ? 'navlist row' : `navlist ${compact ? 'rail' : ''}`);
  const marker = slideMarker('.active', 'bar-left');
</script>

{#snippet globals()}
  <div class={list}>
    {#each GENERAL_NAV.filter((g) => g.scope === 'global' || project) as g (g.id)}
      {@const on = S.route.scope === g.scope && S.route.view === g.id}
      <a href="#/{g.scope === 'global' ? g.id : `p/${project}/${g.id}`}" class={on ? 'active' : ''} aria-current={on ? 'page' : undefined} aria-label={compact ? labels[g.id] : undefined} {@attach compact && railTipOn(labels[g.id])}
        >{#if compact}<Icon name={g.icon} />{:else}<span class="lbl">{#if !mobile}<Icon name={g.icon} />{/if}{labels[g.id]}</span>{/if}</a
      >
    {/each}
  </div>
{/snippet}

{#snippet views(name: string)}
  <div class={list}>
    {#each PROJECT_NAV as v (v.id)}
      {@const n = badge(v.id)}
      {@const on = S.route.scope === 'project' && S.route.view === v.id}
      <a href="#/p/{name}/{v.id}" class={on ? 'active' : ''} aria-current={on ? 'page' : undefined} aria-label={compact ? railName(v.id, n) : undefined} {@attach compact && railTipOn(railName(v.id, n))}
        >{#if compact}<Icon name={v.icon} />{#if n}<span class="mono num absolute top-1 right-1 text-[10px] leading-none {on ? '' : 'muted'}" aria-hidden="true">{n}</span>{/if}{:else}<span class="lbl">{#if !mobile}<Icon name={v.icon} />{/if}{labels[v.id]}</span>
          {#if n}<span class="mono num {on ? '' : 'muted'}">{n}</span>{/if}{/if}</a
      >
    {/each}
  </div>
{/snippet}

{#if mobile}
  {@render globals()}
  <span class="h-6 shrink-0 border-l border-line-strong" aria-hidden="true"></span>
  <ProjectSwitcher variant="phone" />
  {#if project}{@render views(project)}{/if}
{:else if compact}
  <div class="navlist-marks slide-marker flex flex-col gap-1" {@attach marker}>
    {@render globals()}
    <div class="mx-2 my-1.5 border-t border-line-strong" aria-hidden="true"></div>
    <div class="navlist rail"><ProjectSwitcher variant="rail" /></div>
    {#if project}{@render views(project)}{/if}
  </div>
{:else}
  <div class="navlist-marks slide-marker flex flex-col gap-1" {@attach marker}>
  <div role="group" aria-labelledby="nav-global-label" class="flex flex-col gap-1.5 border-b border-line-strong pb-3">
    <div id="nav-global-label" class="label px-2.5">{$t('nav.global')}</div>
    {@render globals()}
  </div>
  <div role="group" aria-labelledby="project-switcher-label" class="mt-3 flex flex-col gap-1.5">
    <div id="project-switcher-label" class="label px-2.5">{$t('switcher.label')}</div>
    <ProjectSwitcher variant="field" labelledby="project-switcher-label" />
    {#if project}<div class="mt-1">{@render views(project)}</div>{/if}
  </div>
  </div>
{/if}
