<!-- The settings modal: a labelled, focus-trapped dialog with a tab rail. A centred plate at md and up, a full-screen plate below.
     With no project selected it offers only General and About; `start` opens a tab in place of the saved one. -->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import CloseButton from './CloseButton.svelte';
  import Icon from './Icon.svelte';
  import AboutTab from './settings/AboutTab.svelte';
  import ConfigTab from './settings/ConfigTab.svelte';
  import DiagnosticsTab from './settings/DiagnosticsTab.svelte';
  import GeneralTab from './settings/GeneralTab.svelte';
  import { t } from '../lib/locale.ts';
  import { slideMarker } from '../lib/marker.ts';
  import { EXIT, fade, pop } from '../lib/motion.ts';
  import { pref } from '../lib/prefs.ts';
  import { currentProject } from '../lib/project.ts';
  import { SETTINGS_TABS, moveTab, openingTab, sectionOf, settingsTabsFor, wrapFocus, type SettingsTabId } from '../lib/settings.ts';
  import { SettingsSession } from '../lib/settings-session.svelte.ts';

  let { onclose, start }: { onclose: () => void; start?: SettingsTabId } = $props();

  const session = new SettingsSession();
  // App re-keys Settings on the selected project, so the project read once here holds for this open.
  const hasProject = currentProject() !== null;
  const tabs = settingsTabsFor(hasProject);
  let tab = $state<SettingsTabId>(openingTab(tabs, untrack(() => start), pref.get('settingsTab', 'general')));
  let dialog = $state<HTMLDivElement>();
  let panel = $state<HTMLDivElement>();
  let wide = $state(false);
  const section = $derived(sectionOf(tab));
  // Which config tabs hold an unsaved change or a field to fix, so a problem on another tab can be found.
  const marks = $derived.by(() => {
    const out: Partial<Record<SettingsTabId, 'error' | 'changed'>> = {};
    const fields = session.config?.fields ?? [];
    const { changed, errors } = session.flagged;
    for (const [keys, mark] of [[changed, 'changed'], [errors, 'error']] as const) {
      for (const key of keys) {
        const s = fields.find((f) => f.key === key)?.section;
        const id = SETTINGS_TABS.find((x) => x.section === s)?.id;
        if (id) out[id] = mark;
      }
    }
    return out;
  });
  let pressedOnBackdrop = false;

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
    const next = moveTab(tab, e.key, tabs);
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

  /** Opens the field's tab and focuses its control: the Save bar's pointer to a problem. */
  function goto(key: string): void {
    const s = session.config?.fields.find((f) => f.key === key)?.section;
    const id = SETTINGS_TABS.find((x) => x.section === s)?.id;
    if (!id) return;
    select(id);
    tick().then(() => {
      const el = document.getElementById(`cfg-${key.replace(/[^A-Za-z0-9]/g, '-')}`) ?? document.getElementById(`settings-panel-${id}`);
      el?.scrollIntoView({ block: 'center' });
      el?.focus();
    });
  }

  // Both ends of the click must be on the backdrop: a text selection dragged out of the dialog
  // ends its click on the backdrop too.
  function backdropDown(e: MouseEvent): void {
    pressedOnBackdrop = e.target === e.currentTarget;
  }

  function backdrop(e: MouseEvent): void {
    const both = pressedOnBackdrop && e.target === e.currentTarget;
    pressedOnBackdrop = false;
    if (both && matchMedia('(min-width: 768px)').matches) requestClose();
  }

  onMount(() => {
    const mq = matchMedia('(min-width: 768px)');
    const onWidth = () => (wide = mq.matches);
    onWidth();
    mq.addEventListener('change', onWidth);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // The config is a project's: with none selected there is nothing to load.
    if (hasProject) session.loadConfig();
    tick().then(() => document.getElementById(`settings-tab-${tab}`)?.focus());
    return () => {
      mq.removeEventListener('change', onWidth);
      document.body.style.overflow = overflow;
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the backdrop; Escape and the close button close the dialog from the keyboard) -->
<div class="fixed inset-0 z-45 flex md:items-center md:justify-center md:p-6 backdrop" in:fade|global out:fade|global={EXIT} onmousedown={backdropDown} onclick={backdrop}>
  <div bind:this={dialog} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabindex="-1" in:pop|global class="plate solid flex flex-col w-full h-full min-w-0 md:h-[min(80vh,720px)] md:max-w-(--size-dialog) md:shadow-(--shadow-overlay)" onkeydown={trap}>
    <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-2 md:px-5">
      <h2 id="settings-title" class="h sheet-title min-w-0">{$t('settings.title')}</h2>
      <CloseButton label={$t('settings.close')} onclick={requestClose} />
    </div>
    <div class="flex flex-col md:flex-row flex-1 min-h-0">
      <div role="tablist" tabindex="-1" aria-label={$t('settings.sections')} aria-orientation={wide ? 'vertical' : 'horizontal'} {@attach slideMarker('.active', 'bar-left')} class="navlist slide-marker {wide ? '' : 'row'} shrink-0 overflow-x-auto md:overflow-y-auto overscroll-contain md:w-(--size-settings-rail) border-b md:border-b-0 md:border-r border-line p-2" onkeydown={railKey}>
        {#each tabs as item (item.id)}
          <!-- In the vertical rail, the project's own tabs sit under its name, and About below a rule. -->
          {#if wide && item.id === 'pipeline'}<div class="label truncate px-2.5 pt-3 pb-1" aria-hidden="true">{currentProject()}</div>{/if}
          {#if wide && hasProject && item.id === 'about'}<div class="mx-2 my-1.5 border-t border-line-strong" aria-hidden="true"></div>{/if}
          <button
            role="tab"
            id="settings-tab-{item.id}"
            aria-selected={tab === item.id}
            aria-controls="settings-panel-{item.id}"
            tabindex={tab === item.id ? 0 : -1}
            class="min-h-11 md:min-h-0 whitespace-nowrap {tab === item.id ? 'active' : ''}"
            onclick={() => select(item.id)}
            ><span class="lbl"><Icon name={item.icon} />{labels[item.id]}</span>{#if marks[item.id] === 'error'}<span class="dot ember" aria-hidden="true"></span><span class="sr-only">{$t('settings.tabs.hasError')}</span>{:else if marks[item.id] === 'changed'}<span class="dot spark" aria-hidden="true"></span><span class="sr-only">{$t('settings.tabs.hasChanges')}</span>{/if}</button
          >
        {/each}
      </div>
      <div bind:this={panel} role="tabpanel" id="settings-panel-{tab}" aria-labelledby="settings-tab-{tab}" tabindex="0" class="flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-line-strong focus-visible:-outline-offset-2">
        <div class="label callout px-4 pt-4 md:px-6" aria-hidden="true">{labels[tab]}</div>
        {#if tab === 'general'}<GeneralTab />
        {:else if tab === 'diagnostics'}<DiagnosticsTab {session} />
        {:else if tab === 'about'}<AboutTab {session} />
        {:else if section}<ConfigTab {session} {section} {goto} />{/if}
      </div>
    </div>
  </div>
</div>
