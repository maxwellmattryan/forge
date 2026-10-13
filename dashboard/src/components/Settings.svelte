<!-- The settings modal: a labelled, focus-trapped dialog with a tab rail. A centred card at md and up, a full-screen sheet below. -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import AboutTab from './settings/AboutTab.svelte';
  import ConfigTab from './settings/ConfigTab.svelte';
  import DiagnosticsTab from './settings/DiagnosticsTab.svelte';
  import GeneralTab from './settings/GeneralTab.svelte';
  import { t } from '../lib/locale.ts';
  import { pref } from '../lib/prefs.ts';
  import { SETTINGS_TABS, isSettingsTab, moveTab, sectionOf, wrapFocus, type SettingsTabId } from '../lib/settings.ts';
  import { SettingsSession } from '../lib/settings-session.svelte.ts';

  let { onclose }: { onclose: () => void } = $props();

  const session = new SettingsSession();
  const saved = pref.get('settingsTab', 'general');
  let tab = $state<SettingsTabId>(isSettingsTab(saved) ? saved : 'general');
  let dialog = $state<HTMLDivElement>();
  let panel = $state<HTMLDivElement>();
  let wide = $state(false);
  const section = $derived(sectionOf(tab));

  const labels = $derived<Record<SettingsTabId, string>>({
    general: $t('settings.tabs.general'),
    pipeline: $t('settings.tabs.pipeline'),
    review: $t('settings.tabs.review'),
    agents: $t('settings.tabs.agents'),
    tracker: $t('settings.tabs.tracker'),
    dashboard: $t('settings.tabs.dashboard'),
    daemon: $t('settings.tabs.daemon'),
    diagnostics: $t('settings.tabs.diagnostics'),
    about: $t('settings.tabs.about'),
  });

  /** Closes unless unsaved drafts exist and the person keeps them. */
  export function requestClose(): void {
    if (session.dirty && !confirm($t('settings.discard'))) return;
    onclose();
  }

  function select(id: SettingsTabId, focus = false): void {
    if (tab !== id && panel) panel.scrollTop = 0;
    tab = id;
    pref.set('settingsTab', id);
    if (focus) tick().then(() => document.getElementById(`settings-tab-${id}`)?.focus());
  }

  function railKey(e: KeyboardEvent): void {
    const next = moveTab(tab, e.key);
    if (next === null) return;
    e.preventDefault();
    select(next, true);
  }

  const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trap(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || !dialog) return;
    // A radio group is one stop: its checked radio (any radio when none is checked).
    const tabStop = (el: HTMLElement) => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && dialog?.querySelector(`input[type="radio"][name="${el.name}"]:checked`));
    const items = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0 && tabStop(el));
    const n = wrapFocus(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (n === null) return;
    e.preventDefault();
    items[n].focus();
  }

  function backdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget && matchMedia('(min-width: 768px)').matches) requestClose();
  }

  onMount(() => {
    const mq = matchMedia('(min-width: 768px)');
    const onWidth = () => (wide = mq.matches);
    onWidth();
    mq.addEventListener('change', onWidth);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    session.loadConfig();
    tick().then(() => document.getElementById(`settings-tab-${tab}`)?.focus());
    return () => {
      mq.removeEventListener('change', onWidth);
      document.body.style.overflow = overflow;
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop; Escape and the close button close the dialog from the keyboard) -->
<div class="fixed inset-0 z-45 flex md:items-center md:justify-center md:p-6 bg-black/50" onclick={backdrop}>
  <div bind:this={dialog} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1" class="flex flex-col w-full h-full min-w-0 bg-bg md:h-[min(80vh,720px)] md:max-w-4xl md:rounded-xl md:border md:border-line md:shadow-2xl overflow-hidden" onkeydown={trap}>
    <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-2 md:px-5">
      <h2 id="settings-title" class="text-base font-semibold">{$t('settings.title')}</h2>
      <button class="btn size-11 justify-center p-0" aria-label={$t('settings.close')} onclick={requestClose}><Icon name="close" /></button>
    </div>
    <div class="flex flex-col md:flex-row flex-1 min-h-0">
      <div role="tablist" aria-label={$t('settings.title')} aria-orientation={wide ? 'vertical' : 'horizontal'} tabindex="-1" class="flex md:flex-col gap-1 shrink-0 overflow-x-auto md:overflow-y-auto md:w-48 border-b md:border-b-0 md:border-r border-line p-2" onkeydown={railKey}>
        {#each SETTINGS_TABS as item (item.id)}
          <button
            role="tab"
            id="settings-tab-{item.id}"
            aria-selected={tab === item.id}
            aria-controls="settings-panel-{item.id}"
            tabindex={tab === item.id ? 0 : -1}
            class="nav-item shrink-0 min-h-11 md:min-h-0 whitespace-nowrap {tab === item.id ? 'active' : ''}"
            onclick={() => select(item.id)}>{labels[item.id]}</button>
        {/each}
      </div>
      <div bind:this={panel} role="tabpanel" id="settings-panel-{tab}" aria-labelledby="settings-tab-{tab}" tabindex="0" class="flex-1 min-h-0 min-w-0 overflow-y-auto">
        {#if tab === 'general'}<GeneralTab />
        {:else if tab === 'diagnostics'}<DiagnosticsTab {session} />
        {:else if tab === 'about'}<AboutTab {session} />
        {:else if section}<ConfigTab {session} {section} />{/if}
      </div>
    </div>
  </div>
</div>
