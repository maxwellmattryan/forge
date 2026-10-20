<!-- A job's reasoning effort, beside the Permissions button in its Log tab: a button naming the level that opens a small
     popover of radios. Inherit clears the job's own level. It works with the daemon off too, because an interactive
     orchestrator reads the level from `forge job step`. A running session keeps the level it started with until its next
     spawn, which the note in the popover (and the button's title) says. -->
<script lang="ts">
  import { tick } from 'svelte';
  import MenuButton from './MenuButton.svelte';
  import { parkFocus } from '../lib/menu.ts';
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
  /** Shown until the next /api/state carries the new level, so the radios don't jump back meanwhile. */
  let picked = $state<string | null>(null);
  let pending = $state(false);
  const name = $derived<Record<Effort, string>>({ low: $t('effort.levels.low'), medium: $t('effort.levels.medium'), high: $t('effort.levels.high'), xhigh: $t('effort.levels.xhigh'), max: $t('effort.levels.max') });
  const current = $derived(picked ?? row?.effort ?? '');
  const levelName = $derived(EFFORTS.find((e) => e === current) ? name[current as Effort] : $t('effort.inheritShort'));
  const uid = $props.id();

  async function choose(value: string, el: HTMLInputElement): Promise<void> {
    const next = value === '' ? null : EFFORTS.find((e) => e === value);
    if (next === undefined || next === (row?.effort ?? null)) return;
    const restore = parkFocus(el);
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
      await tick();
      restore();
    }
  }
</script>

{#if row}
  <MenuButton label={$t('effort.trigger', { level: levelName })} title={$t('effort.label')} icon="gauge" text={levelName} extraTitle={restart ? $t('effort.restart') : undefined}>
    <p class="text-muted">{$t('effort.hint')}</p>
    <fieldset class="flex flex-col gap-2">
      <legend class="sr-only">{$t('effort.label')}</legend>
      <label class="field"><input type="radio" class="radio" name="{uid}-effort" value="" checked={current === ''} disabled={pending} onchange={(e) => choose('', e.currentTarget)} />{$t('effort.inherit', { level: fallback ? name[fallback] : $t('effort.claude') })}</label>
      {#each EFFORTS as e (e)}<label class="field"><input type="radio" class="radio" name="{uid}-effort" value={e} checked={current === e} disabled={pending} onchange={(ev) => choose(e, ev.currentTarget)} />{name[e]}</label>{/each}
    </fieldset>
    {#if restart}<p role="status" class="text-muted">{$t('effort.restart')}</p>{/if}
  </MenuButton>
{/if}
