<!-- The project switcher over the machine's registered projects (lib/shell/switcher.ts): in the expanded sidebar a select-only
     combobox (`field`), in the phone strip its small button (`phone`), and on the rail an icon button that opens the
     palette with `project ` typed, which lists the projects (`rail`). Choosing a project opens its same view from a
     project page and its Pipeline from a global page; missing and unavailable projects are listed but can't be chosen.
     Below the projects, ruled off, Add project opens the Add project dialog where the person is (an action: it never
     becomes the selection, and focus returns to this trigger when the dialog closes). The list is enabled once the
     machine's projects have loaded, even with none registered. While another project has jobs waiting on you, the
     trigger shows an ember dot (described by hidden text with the count) and the list marks those projects' rows. Cmd+O
     on a Mac, Ctrl+O elsewhere, calls the exported toggle() through Nav: the field and phone lists open or close, the
     rail does what its click does; each trigger names the shortcut in its title (the rail in its tooltip) and
     aria-keyshortcuts. -->
<script lang="ts">
  import Icon from '../ui/Icon.svelte';
  import Select from '../ui/Select.svelte';
  import { S } from '../../lib/core/app.svelte.ts';
  import { openAddProject } from '../../lib/shell/add-project.svelte.ts';
  import { openPalette } from '../../lib/shell/palette.svelte.ts';
  import { railTipOn } from '../../lib/shell/rail-tip.svelte.ts';
  import { othersWaiting, switcherChoice, switcherEntries, switcherKeyShortcuts, switcherOptions, switcherShortcutLabel, type SwitcherEntry } from '../../lib/shell/switcher.ts';
  import { t } from '../../lib/text/locale.ts';

  let { variant, labelledby }: { variant: 'field' | 'rail' | 'phone'; labelledby?: string } = $props();

  const project = $derived(S.selected);
  const entries = $derived(switcherEntries(S.machine));
  const hint = (e: SwitcherEntry): string | undefined =>
    e.state === 'missing' ? $t('switcher.missing') : e.state === 'unavailable' ? $t('switcher.unavailable') : e.waiting ? $t('switcher.waiting', { count: e.waiting }) : undefined;
  const options = $derived(switcherOptions(entries, { add: $t('switcher.add'), hint }, project));
  const others = $derived(othersWaiting(entries, project));
  // The phone strip and the sidebar can both be in the DOM, so the description's id is per variant.
  const descId = $derived(variant === 'phone' ? 'project-switcher-mobile-waiting' : 'project-switcher-waiting');
  const waitingText = $derived(others > 0 ? $t('switcher.othersWaiting', { count: others }) : undefined);
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  const keyshortcuts = switcherKeyShortcuts(platform);
  const tip = $derived($t('switcher.shortcut', { key: switcherShortcutLabel(platform) }));
  const title = $derived(waitingText ? `${tip}\n${waitingText}` : tip);

  let select = $state<ReturnType<typeof Select>>();
  let railButton = $state<HTMLButtonElement>();

  /** The Cmd/Ctrl+O shortcut: on the rail what a click does (the palette with `project ` typed), else the list opens or closes. */
  export function toggle(): void {
    if (variant === 'rail') openPalette({ text: 'project ', opener: railButton });
    else select?.toggle();
  }

  function choose(value: string): void {
    const to = switcherChoice(value, project, S.route);
    if (to === null) return;
    if ('add' in to) openAddProject(document.getElementById(variant === 'phone' ? 'project-switcher-mobile' : 'project-switcher'));
    else location.hash = to.hash;
  }
</script>

{#if variant === 'rail'}
  <button bind:this={railButton} id="project-switcher" aria-label={$t('switcher.rail')} aria-describedby={waitingText ? descId : undefined} aria-haspopup="dialog" aria-keyshortcuts={keyshortcuts} onclick={(e) => openPalette({ text: 'project ', opener: e.currentTarget })} {@attach railTipOn(tip)}><Icon name="anvil" />{#if others > 0}<span class="dot ember absolute top-1 right-1.5 size-2" aria-hidden="true"></span>{/if}</button>
{:else if variant === 'field'}
  <Select bind:this={select} id="project-switcher" value={project ?? ''} {options} onchange={choose} {labelledby} describedby={waitingText ? descId : undefined} {title} {keyshortcuts} badge={others > 0} badgeTone="ember" placeholder={$t('switcher.placeholder')} disabled={!S.machine} class="w-full" />
{:else}
  <Select bind:this={select} id="project-switcher-mobile" variant="button" icon="anvil" value={project ?? ''} {options} onchange={choose} label={$t('switcher.label')} describedby={waitingText ? descId : undefined} {title} {keyshortcuts} badge={others > 0} badgeTone="ember" placeholder={$t('switcher.placeholder')} disabled={!S.machine} class="shrink-0 max-w-[12rem]" />
{/if}
{#if waitingText}<span id={descId} class="sr-only">{waitingText}</span>{/if}
