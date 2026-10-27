<!-- Foreman: the page header, then a tab strip built from FOREMAN_PANELS (the drawer's tab pattern: arrows, Home and
     End move between panels, each tab controls its panel) and the selected panel: Office first, then Chats. The selected
     tab is app state (S.foremanPanel), so it survives leaving the page, the status bar's Open chat link can switch it
     while the page is open, and a project switch resets it to Office. A new panel is one list entry, one message and one
     component. The page is project-owned: App's {#key} remounts it. -->
<script lang="ts">
  import ChatsPanel from '../components/chats/ChatsPanel.svelte';
  import OfficePanel from '../components/OfficePanel.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { FOREMAN_PANELS, panelKey, type ForemanPanel } from '../lib/foreman.ts';
  import { S } from '../lib/app.svelte.ts';
  import { slideMarker } from '../lib/marker.ts';
  import { t } from '../lib/locale.ts';

  function select(next: ForemanPanel, focus = false): void {
    S.foremanPanel = next;
    if (focus) document.getElementById(`foreman-tab-${next}`)?.focus();
  }

  function stripKey(e: KeyboardEvent): void {
    const next = panelKey(S.foremanPanel, e.key);
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
      <button role="tab" id="foreman-tab-{p}" aria-selected={S.foremanPanel === p} aria-controls="foreman-panel-{p}" tabindex={S.foremanPanel === p ? 0 : -1} class="tab shrink-0 whitespace-nowrap focus-visible:-outline-offset-2 {S.foremanPanel === p ? 'active' : ''}" onclick={() => select(p)}>{#if p === 'office'}{$t('foreman.panel.office')}{:else if p === 'chats'}{$t('foreman.panel.chats')}{/if}</button>
    {/each}
  </div>
</div>
<div role="tabpanel" id="foreman-panel-{S.foremanPanel}" aria-labelledby="foreman-tab-{S.foremanPanel}" class="flex flex-col">
  {#if S.foremanPanel === 'office'}<OfficePanel />{:else if S.foremanPanel === 'chats'}<ChatsPanel />{/if}
</div>
