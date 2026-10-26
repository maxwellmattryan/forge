<!-- A job's merge mode, beside its Effort dropdown in SessionControls (the job drawer's header): whether agents may merge
     its PRs once the approver allows it (Agents merge) or a person always does (Person merges). Inherit follows merge.auto.
     The dashboard is a human channel, so every entry is open here; the CLI asks a person to confirm auto and inherit.
     While a change saves every entry is disabled, but the button stays enabled, so focus stays on it. -->
<script lang="ts">
  import Select from './Select.svelte';
  import Icon from './Icon.svelte';
  import { MERGE_MODES } from '../lib/types.ts';
  import type { MergeMode } from '../lib/types.ts';
  import type { SelectOption } from '../lib/select.ts';
  import { agentsMerge, ownMergeMode, postJobMergeMode } from '../lib/merge-mode.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: string } = $props();
  const row = $derived(S.data?.jobs?.find((j) => j.id === job) ?? null);
  const fallback = $derived(S.data?.config?.autoMerge === true);
  /** Shown until the next /api/state carries the new mode, so the trigger doesn't jump back meanwhile. */
  let picked = $state<string | null>(null);
  let pending = $state(false);
  const name = $derived<Record<MergeMode, string>>({ auto: $t('mergeMode.modes.auto'), human: $t('mergeMode.modes.human') });
  const current = $derived(picked ?? ownMergeMode(row?.mergeMode) ?? '');
  const own = $derived(ownMergeMode(current));
  const options = $derived<SelectOption[]>([
    { value: '', label: $t('mergeMode.inherit', { mode: name[fallback ? 'auto' : 'human'] }), icon: 'settings', disabled: pending },
    ...MERGE_MODES.map((m) => ({ value: m, label: name[m], separator: m === MERGE_MODES[0], disabled: pending })),
  ]);

  async function choose(value: string): Promise<void> {
    const next = value === '' ? null : MERGE_MODES.find((m) => m === value);
    if (next === undefined || next === ownMergeMode(row?.mergeMode)) return;
    picked = value;
    pending = true;
    try {
      await postJobMergeMode(job, next, forgeToken());
      await refresh();
    } catch (err) {
      toast($t('mergeMode.failed', { error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      picked = null;
      pending = false;
    }
  }
</script>

<!-- Agents merge carries a warn dot: it is the one entry that lets a PR land with no person. -->
{#snippet mode(o: SelectOption)}
  {#if o.icon}<Icon name={o.icon} class="shrink-0" />{/if}<span class="truncate">{o.label}</span>{#if o.value === 'auto'}<span class="dot warn ml-auto mt-1.5" aria-hidden="true"></span>{/if}
{/snippet}

{#if row}
  <Select
    variant="button"
    icon="branch"
    align="end"
    label={$t('mergeMode.label')}
    value={current}
    text={own ? name[own] : $t('mergeMode.inheritShort')}
    title={agentsMerge(current, fallback) ? $t('mergeMode.hintAuto') : $t('mergeMode.hintHuman')}
    {options}
    entry={mode}
    onchange={choose}
  />
{/if}
