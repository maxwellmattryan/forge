<!-- A job's reasoning effort, beside the Permissions select in its Log tab. Inherit clears the job's own level. It works with
     the daemon off too, because an interactive orchestrator reads the level from `forge job step`. A running session keeps
     the level it started with until its next spawn, which the note says. -->
<script lang="ts">
  import { EFFORTS } from '../lib/types.ts';
  import type { Effort } from '../lib/types.ts';
  import { postJobEffort, restartPending } from '../lib/effort.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: string } = $props();
  const row = $derived(S.data?.jobs?.find((j) => j.id === job) ?? null);
  const fallback = $derived(S.data?.config?.effort ?? null);
  const session = $derived(S.data?.daemons?.jobs?.[job] ?? null);
  const restart = $derived(row !== null && restartPending(session, row.effort, fallback));
  /** Shown until the next /api/state carries the new level, so the select doesn't jump back meanwhile. */
  let picked = $state<string | null>(null);
  let pending = $state(false);
  const name = $derived<Record<Effort, string>>({ low: $t('effort.levels.low'), medium: $t('effort.levels.medium'), high: $t('effort.levels.high'), xhigh: $t('effort.levels.xhigh'), max: $t('effort.levels.max') });

  async function choose(value: string): Promise<void> {
    const next = value === '' ? null : EFFORTS.find((e) => e === value);
    if (next === undefined || next === (row?.effort ?? null)) return;
    picked = value;
    pending = true;
    try {
      await postJobEffort(job, next, forgeToken());
      await refresh();
    } catch (err) {
      toast($t('effort.failed', { error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      picked = null;
      pending = false;
    }
  }
</script>

{#if row}
  <label class="flex items-center gap-1.5 text-xs text-muted" title={$t('effort.hint')}>
    {$t('effort.label')}
    <!-- Named outright: a label wrapping a select can otherwise lend it the chosen option's text. -->
    <select class="input sm" aria-label={$t('effort.label')} value={picked ?? row.effort ?? ''} disabled={pending} onchange={(e) => choose(e.currentTarget.value)}>
      <option value="">{$t('effort.inherit', { level: fallback ? name[fallback] : $t('effort.claude') })}</option>
      {#each EFFORTS as e (e)}<option value={e}>{name[e]}</option>{/each}
    </select>
  </label>
  {#if restart}<span role="status" class="text-xs text-muted">{$t('effort.restart')}</span>{/if}
{/if}
