<!-- The Pipeline table's filter row: a search over ref, id and title, one removable chip per filter, + Filter offering the
     mandates, states and stages present among the table's jobs (src/lib/jobs/board.ts filterChoices), and the Group by
     mandate toggle when some job has a mandate. Chips and search live in the table, never in prefs. -->
<script lang="ts">
  import Icon from '../../ui/Icon.svelte';
  import Select from '../../ui/Select.svelte';
  import CloseButton from '../../ui/CloseButton.svelte';
  import { filterChoices } from '../../../lib/jobs/board.ts';
  import type { FilterChip, FilterField } from '../../../lib/jobs/board.ts';
  import type { JobLike } from '../../../lib/jobs/state.ts';
  import { STAGE_LABEL } from '../../../lib/core/labels.ts';
  import type { Stage } from '../../../lib/core/types.ts';
  import type { SelectOption } from '../../../lib/ui/select.ts';
  import { t } from '../../../lib/text/locale.ts';

  let {
    jobs,
    chips = $bindable([]),
    text = $bindable(''),
    group,
    ongroup,
    showGroup,
  }: { jobs: JobLike[]; chips: FilterChip[]; text: string; group: boolean; ongroup: () => void; showGroup: boolean } = $props();

  const fieldLabel = $derived<Record<FilterField, string>>({ mandate: $t('table.filter.mandate'), state: $t('table.filter.state'), stage: $t('table.filter.stage') });
  const groupLabel = $derived<Record<FilterField, string>>({ mandate: $t('table.group.mandate'), state: $t('table.state'), stage: $t('table.stage') });
  const valueLabel = (c: FilterChip): string =>
    c.field === 'mandate' ? c.value || $t('table.filter.noMandate') : c.field === 'state' ? (c.value === 'open' ? $t('table.filter.open') : c.value) : (STAGE_LABEL[c.value as Stage] ?? c.value);
  const choices = $derived(filterChoices(jobs, chips));
  const options = $derived<SelectOption[]>(choices.map((c) => ({ value: `${c.field}:${c.value}`, label: valueLabel(c), group: groupLabel[c.field], action: true })));

  function add(v: string): void {
    const chip = choices.find((c) => `${c.field}:${c.value}` === v);
    if (chip) chips = [...chips, chip];
  }
</script>

<div class="plain flex flex-wrap items-center gap-2 border-b border-line p-2">
  <!-- The icon sits over the field; the inline padding clears it, since the unlayered native-input rule in style.css outranks utilities. -->
  <div class="relative w-full max-w-64">
    <Icon name="search" class="sm pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
    <input class="input sm w-full" style="padding-left: 30px" type="search" placeholder={$t('table.filter.search')} aria-label={$t('table.filter.search')} bind:value={text} />
  </div>
  {#each chips as c, i (`${c.field}:${c.value}`)}
    {@const name = `${fieldLabel[c.field]} ${valueLabel(c)}`}
    <span class="chip normal-case tracking-normal pr-0.5">{fieldLabel[c.field]} <b class="text-fg">{valueLabel(c)}</b><CloseButton size="sm" label={$t('table.filter.remove', { chip: name })} onclick={() => (chips = chips.filter((_, k) => k !== i))} /></span>
  {/each}
  <Select variant="button" icon="plus" text={$t('table.filter.add')} label={$t('table.filter.add')} {options} onchange={add} disabled={!options.length} check={false} />
  {#if showGroup}<button type="button" class="btn sm ml-auto {group ? 'sel' : ''}" aria-pressed={group} onclick={ongroup}>{$t('table.group.toggle')}</button>{/if}
</div>
