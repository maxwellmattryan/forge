<!-- A job's reasoning effort, beside the Permissions dropdown in SessionControls (the job drawer's header): a small button Select naming the level.
     Inherit clears the job's own level. It works with the daemon off too, because an interactive orchestrator reads the
     level from `forge job step`. A running session keeps the level it started with until its next spawn, which the
     button's title and badge say. While a change saves every entry is disabled, but the button itself stays enabled, so
     focus stays on it instead of dropping to <body>. -->
<script lang="ts">
  import Select from './Select.svelte';
  import Icon from './Icon.svelte';
  import { EFFORTS } from '../lib/types.ts';
  import type { Effort } from '../lib/types.ts';
  import type { SelectOption } from '../lib/select.ts';
  import { effortTone, postJobEffort, restartPending } from '../lib/effort.ts';
  import { S, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: string } = $props();
  const row = $derived(S.data?.jobs?.find((j) => j.id === job) ?? null);
  const fallback = $derived(S.data?.config?.effort ?? null);
  const session = $derived(S.data?.daemons?.jobs?.[job] ?? null);
  const restart = $derived(row !== null && restartPending(session, row.effort, fallback));
  /** Shown until the next /api/state carries the new level, so the trigger doesn't jump back meanwhile. */
  let picked = $state<string | null>(null);
  let pending = $state(false);
  const name = $derived<Record<Effort, string>>({ low: $t('effort.levels.low'), medium: $t('effort.levels.medium'), high: $t('effort.levels.high'), xhigh: $t('effort.levels.xhigh'), max: $t('effort.levels.max') });
  const current = $derived(picked ?? row?.effort ?? '');
  const levelName = $derived(EFFORTS.find((e) => e === current) ? name[current as Effort] : $t('effort.inheritShort'));
  const options = $derived<SelectOption[]>([
    { value: '', label: $t('effort.inherit', { level: fallback ? name[fallback] : $t('effort.claude') }), icon: 'settings', disabled: pending },
    ...EFFORTS.map((e) => ({ value: e, label: name[e], separator: e === EFFORTS[0], disabled: pending })),
  ]);

  async function choose(value: string): Promise<void> {
    const next = value === '' ? null : EFFORTS.find((e) => e === value);
    if (next === undefined || next === (row?.effort ?? null)) return;
    picked = value;
    pending = true;
    try {
      await postJobEffort(job, next);
      await refresh();
    } catch (err) {
      toast($t('effort.failed', { error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      picked = null;
      pending = false;
    }
  }
</script>

<!-- Inherit keeps the icon + text layout; a level shows its name and, for the costly ones, a warn dot. -->
{#snippet level(o: SelectOption)}
  {@const lv = EFFORTS.find((e) => e === o.value)}
  {#if o.icon}<Icon name={o.icon} class="shrink-0" />{/if}<span class="truncate">{o.label}</span>{#if lv && effortTone(lv) === 'warn'}<span class="dot warn ml-auto mt-1.5" aria-hidden="true"></span>{/if}
{/snippet}

{#if row}
  <Select
    variant="button"
    icon="gauge"
    align="end"
    label={$t('effort.label')}
    value={current}
    text={levelName}
    title={restart ? `${$t('effort.hint')} ${$t('effort.restart')}` : $t('effort.hint')}
    badge={restart}
    {options}
    entry={level}
    onchange={choose}
  />
{/if}
