<!-- The project switcher over the machine's registered projects (lib/shell/switcher.ts): in the expanded sidebar a select-only
     combobox (`field`), in the phone strip its small button (`phone`), and on the rail an icon button that opens the
     palette with `project ` typed, which lists the projects (`rail`). Choosing a project opens its same view from a
     project page and its Pipeline from a global page; missing and unavailable projects are listed but can't be chosen.
     Below the projects, ruled off, Add project opens the Add project dialog where the person is (an action: it never
     becomes the selection, and focus returns to this trigger when the dialog closes). The list is enabled once the
     machine's projects have loaded, even with none registered. While another project has jobs waiting on you, the
     trigger shows an ember dot (described by hidden text with the count), its only dot. Every project row is the same two
     lines: a pilot lamp on the name's line (working while its sessions or a Foreman office run are live, you while jobs
     wait on you, else idle), the name and, while sessions run, the pool's live/cap, then a status line that is never
     empty (switcherActivity). The chosen project's name is lit in place of a check column. Cmd+O
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
  import { othersWaiting, switcherActivity, switcherChoice, switcherEntries, switcherKeyShortcuts, switcherOptions, switcherShortcutLabel, type SwitcherEntry, type SwitcherStatusPart } from '../../lib/shell/switcher.ts';
  import type { SelectOption } from '../../lib/ui/select.ts';
  import { t } from '../../lib/text/locale.ts';

  let { variant, labelledby }: { variant: 'field' | 'rail' | 'phone'; labelledby?: string } = $props();

  const project = $derived(S.selected);
  const entries = $derived(switcherEntries(S.machine));
  const hint = (e: SwitcherEntry): string | undefined =>
    e.state === 'missing' ? $t('switcher.missing') : e.state === 'unavailable' ? $t('switcher.unavailable') : e.waiting ? $t('switcher.waiting', { count: e.waiting }) : undefined;
  const options = $derived(switcherOptions(entries, { add: $t('switcher.add'), hint }, project));
  const others = $derived(othersWaiting(entries, project));
  const byName = $derived(new Map(entries.map((e) => [e.name, e])));
  // Whole literals, so Tailwind's scan and the lamp utility's states both see them.
  const LAMP = { working: 'lamp working', you: 'lamp you', idle: 'lamp idle', off: 'lamp idle opacity-50' } as const;
  const part = (p: SwitcherStatusPart): string =>
    p.key === 'working' ? $t('switcher.status.working', { count: p.count })
    : p.key === 'waiting' ? $t('switcher.status.waiting', { count: p.count })
    : p.key === 'open' ? $t('switcher.status.open', { count: p.count })
    : p.key === 'foreman' ? $t('switcher.status.foreman')
    : p.key === 'idle' ? $t('switcher.status.idle')
    : p.key === 'missing' ? $t('switcher.status.missing')
    : $t('switcher.status.unavailable');
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
  <Select bind:this={select} id="project-switcher" value={project ?? ''} {options} onchange={choose} {labelledby} describedby={waitingText ? descId : undefined} {title} {keyshortcuts} badge={others > 0} badgeTone="ember" placeholder={$t('switcher.placeholder')} disabled={!S.machine} entry={row} roomy check={false} class="w-full" />
{:else}
  <Select bind:this={select} id="project-switcher-mobile" variant="button" icon="anvil" value={project ?? ''} {options} onchange={choose} label={$t('switcher.label')} describedby={waitingText ? descId : undefined} {title} {keyshortcuts} badge={others > 0} badgeTone="ember" placeholder={$t('switcher.placeholder')} disabled={!S.machine} entry={row} roomy check={false} class="shrink-0 max-w-[12rem]" />
{/if}
{#if waitingText}<span id={descId} class="sr-only">{waitingText}</span>{/if}

{#snippet row(o: SelectOption)}
  {@const e = byName.get(o.value)}
  {#if e}
    {@const a = switcherActivity(e)}
    <span class="ic flex h-[1lh]! shrink-0 items-center justify-center self-start" aria-hidden="true"><span class={LAMP[a.lamp]}></span></span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="flex min-w-0 items-baseline gap-2">
        <span class="font-mono truncate min-w-0 flex-1 {e.name === project ? 'text-gleam' : 'text-fg'}">{e.name}</span>
        {#if a.sessions && a.sessions.live > 0}<span class="font-mono text-xs num shrink-0 text-fg" title={$t('switcher.sessions', { live: a.sessions.live, cap: a.sessions.cap })}>{a.sessions.live}/{a.sessions.cap}</span>{/if}
      </span>
      <span class="truncate text-xs text-muted">{#each a.status as p, k (k)}{#if k > 0}<span aria-hidden="true">{' · '}</span>{/if}<span class={p.key === 'waiting' ? 'text-ember' : p.key === 'working' || p.key === 'foreman' ? 'text-fg' : ''}>{part(p)}</span>{/each}</span>
    </span>
  {:else}
    <span class="truncate">{o.label}</span>
  {/if}
{/snippet}
