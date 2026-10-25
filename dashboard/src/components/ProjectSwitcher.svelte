<!-- The project switcher over the machine's registered projects (lib/switcher.ts): in the expanded sidebar a select-only
     combobox (`field`), in the phone strip its small button (`phone`), and on the rail an icon button that opens the
     palette with `project ` typed, which lists the projects (`rail`). Choosing a project opens its same view from a
     project page and its Pipeline from a global page; missing and unavailable projects are listed but can't be chosen. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import Select from './Select.svelte';
  import { S } from '../lib/app.svelte.ts';
  import { openPalette } from '../lib/palette.svelte.ts';
  import { railTipOn } from '../lib/rail-tip.svelte.ts';
  import { routeProject, switchHash } from '../lib/routes.ts';
  import type { SelectOption } from '../lib/select.ts';
  import { switcherEntries, type SwitcherEntry } from '../lib/switcher.ts';
  import { t } from '../lib/locale.ts';

  let { variant, labelledby }: { variant: 'field' | 'rail' | 'phone'; labelledby?: string } = $props();

  const project = $derived(routeProject(S.route));
  const entries = $derived(switcherEntries(S.machine));
  const hint = (e: SwitcherEntry): string | undefined =>
    e.state === 'missing' ? $t('switcher.missing') : e.state === 'unavailable' ? $t('switcher.unavailable') : e.waiting ? $t('switcher.waiting', { count: e.waiting }) : undefined;
  const options = $derived<SelectOption[]>(entries.map((e) => ({ value: e.name, label: e.name, disabled: !e.openable, hint: hint(e) })));

  function choose(name: string): void {
    if (name === project) return;
    location.hash = switchHash(name, S.route);
  }
</script>

{#if variant === 'rail'}
  <button id="project-switcher" aria-label={$t('switcher.rail')} aria-haspopup="dialog" onclick={(e) => openPalette({ text: 'project ', opener: e.currentTarget })} {@attach railTipOn($t('switcher.rail'))}><Icon name="anvil" /></button>
{:else if variant === 'field'}
  <Select id="project-switcher" value={project ?? ''} {options} onchange={choose} {labelledby} placeholder={$t('switcher.placeholder')} disabled={!entries.length} class="w-full" />
{:else}
  <Select id="project-switcher-mobile" variant="button" icon="anvil" value={project ?? ''} {options} onchange={choose} label={$t('switcher.label')} placeholder={$t('switcher.placeholder')} disabled={!entries.length} class="shrink-0 max-w-[12rem]" />
{/if}
