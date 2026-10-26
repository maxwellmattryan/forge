<!-- Foreman: the page header, then a tab strip built from FOREMAN_PANELS (the drawer's tab pattern: arrows, Home and
     End move between panels, each tab controls its panel) and the selected panel. Office is the first panel and the one
     the page opens on; #396 adds Chats beside it with one list entry, one message and one component. The strip renders
     with one panel too, so adding one never moves anything. The page is project-owned: App's {#key} remounts it. -->
<script lang="ts">
  import OfficePanel from '../components/OfficePanel.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { DEFAULT_FOREMAN_PANEL, FOREMAN_PANELS, panelKey, type ForemanPanel } from '../lib/foreman.ts';
  import { slideMarker } from '../lib/marker.ts';
  import { t } from '../lib/locale.ts';

  let panel = $state<ForemanPanel>(DEFAULT_FOREMAN_PANEL);

  function select(next: ForemanPanel, focus = false): void {
    panel = next;
    if (focus) document.getElementById(`foreman-tab-${next}`)?.focus();
  }

  function stripKey(e: KeyboardEvent): void {
    const next = panelKey(panel, e.key);
    if (!next) return;
    e.preventDefault();
    select(next, true);
  }
</script>

<PageHeader title={$t('foreman.title')}>
  {#snippet sub()}{$t('foreman.sub')}{/snippet}
</PageHeader>
<div class="plate flat mb-5 px-3">
  <div role="tablist" tabindex="-1" aria-label={$t('foreman.panels')} {@attach slideMarker('[aria-selected="true"]', 'bar-bottom')} class="tabs slide-marker overflow-x-auto overflow-y-hidden border-b-0!" onkeydown={stripKey}>
    {#each FOREMAN_PANELS as p (p)}
      <button role="tab" id="foreman-tab-{p}" aria-selected={panel === p} aria-controls="foreman-panel-{p}" tabindex={panel === p ? 0 : -1} class="tab shrink-0 whitespace-nowrap focus-visible:-outline-offset-2 {panel === p ? 'active' : ''}" onclick={() => select(p)}>{#if p === 'office'}{$t('foreman.panel.office')}{/if}</button>
    {/each}
  </div>
</div>
<div role="tabpanel" id="foreman-panel-{panel}" aria-labelledby="foreman-tab-{panel}" class="flex flex-col">
  {#if panel === 'office'}<OfficePanel />{/if}
</div>
