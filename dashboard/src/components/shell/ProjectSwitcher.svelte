<!-- The project switcher over the machine's registered projects (lib/shell/switcher.ts): in the expanded sidebar a select-only
     combobox (`field`), in the phone strip its small button (`phone`), and on the rail an icon button that opens the
     palette with `project ` typed, which lists the projects (`rail`). Choosing a project opens its same view from a
     project page and its Pipeline from a global page; missing and unavailable projects are listed but can't be chosen.
     Below the projects, ruled off, Add project opens the Add project dialog where the person is (an action: it never
     becomes the selection, and focus returns to this trigger when the dialog closes). The list is enabled once the
     machine's projects have loaded, even with none registered. While another project has jobs waiting on you, the
     trigger shows an ember dot (described by hidden text with the count) and the list marks those projects' rows. -->
<script lang="ts">
  import Icon from '../ui/Icon.svelte';
  import Select from '../ui/Select.svelte';
  import { S } from '../../lib/core/app.svelte.ts';
  import { openAddProject } from '../../lib/shell/add-project.svelte.ts';
  import { openPalette } from '../../lib/shell/palette.svelte.ts';
  import { railTipOn } from '../../lib/shell/rail-tip.svelte.ts';
  import { othersWaiting, switcherChoice, switcherEntries, switcherOptions, type SwitcherEntry } from '../../lib/shell/switcher.ts';
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

  function choose(value: string): void {
    const to = switcherChoice(value, project, S.route);
    if (to === null) return;
    if ('add' in to) openAddProject(document.getElementById(variant === 'phone' ? 'project-switcher-mobile' : 'project-switcher'));
    else location.hash = to.hash;
  }
</script>

{#if variant === 'rail'}
  <button id="project-switcher" aria-label={$t('switcher.rail')} aria-describedby={waitingText ? descId : undefined} aria-haspopup="dialog" onclick={(e) => openPalette({ text: 'project ', opener: e.currentTarget })} {@attach railTipOn($t('switcher.rail'))}><Icon name="anvil" />{#if others > 0}<span class="dot ember absolute top-1.5 right-4 size-2" aria-hidden="true"></span>{/if}</button>
{:else if variant === 'field'}
  <Select id="project-switcher" value={project ?? ''} {options} onchange={choose} {labelledby} describedby={waitingText ? descId : undefined} title={waitingText} badge={others > 0} badgeTone="ember" placeholder={$t('switcher.placeholder')} disabled={!S.machine} class="w-full" />
{:else}
  <Select id="project-switcher-mobile" variant="button" icon="anvil" value={project ?? ''} {options} onchange={choose} label={$t('switcher.label')} describedby={waitingText ? descId : undefined} title={waitingText} badge={others > 0} badgeTone="ember" placeholder={$t('switcher.placeholder')} disabled={!S.machine} class="shrink-0 max-w-[12rem]" />
{/if}
{#if waitingText}<span id={descId} class="sr-only">{waitingText}</span>{/if}
