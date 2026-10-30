<!-- Settings › a config section: its fields from GET /api/config, and the Save bar that writes them through POST /api/config. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Banner from '../ui/feedback/Banner.svelte';
  import Chip from '../ui/Chip.svelte';
  import ConfigFieldRow from './ConfigFieldRow.svelte';
  import { S, refresh } from '../../lib/core/app.svelte.ts';
  import { fieldsFor } from '../../lib/settings/config-form.ts';
  import { t } from '../../lib/text/locale.ts';
  import type { SettingsSession } from '../../lib/settings/session.svelte.ts';
  import { toast } from '../../lib/ui/overlay/toast.svelte.ts';
  import type { ConfigSection } from '../../lib/core/types.ts';

  let { session, section, goto }: { session: SettingsSession; section: ConfigSection; goto: (key: string) => void } = $props();

  const c = $derived(session.config);
  const fields = $derived(c ? fieldsFor(c.fields, section) : []);
  const locked = $derived(c?.lockedBy === 'daemon' || S.data?.daemons?.wanted === true);
  const changed = $derived(session.changed);
  const invalid = $derived(session.invalid);
  const canSave = $derived(changed.length > 0 && invalid.length === 0 && !locked && !session.saving);
  // The field a Save stopped at, or the first invalid draft, even on another tab.
  const problemKey = $derived(session.failedKey ?? invalid[0] ?? null);
  const problem = $derived(problemKey ? (c?.fields.find((f) => f.key === problemKey) ?? null) : null);
  let status = $state<HTMLElement>();

  async function save(): Promise<void> {
    const r = await session.save();
    const label = r.failed ? (c?.fields.find((f) => f.key === r.failed)?.label ?? r.failed) : '';
    if (r.failed !== null && r.saved === 0) toast($t('settings.save.failed', { label }), true);
    else if (r.failed !== null) toast($t('settings.save.partial', { saved: r.saved, total: r.total, label }), true);
    else if (r.saved) {
      toast($t('settings.save.done', { count: r.saved }));
      refresh();
    }
    // Save was disabled while it ran, which drops focus to <body>; bring it back to the result.
    await tick();
    if (!document.activeElement || document.activeElement === document.body) status?.focus();
  }
</script>

{#if !c}
  {#if session.configError}
    <div class="p-4 md:p-6"><Banner msg={session.configError} /><button class="btn" onclick={() => session.loadConfig()}>{$t('settings.retry')}</button></div>
  {:else}
    <div class="p-4 md:p-6 text-sm text-muted">{$t('settings.loading')}</div>
  {/if}
{:else if !c.initialized}
  <div class="p-4 md:p-6 text-sm text-muted">{$t('app.noConfig')}</div>
{:else}
  <div class="flex flex-col min-h-full">
    <div class="flex-1 px-4 md:px-6 pt-2">
      {#if session.configError}<div class="pt-3"><Banner msg={session.configError} /><button class="btn mb-3" onclick={() => session.loadConfig()}>{$t('settings.retry')}</button></div>{/if}
      {#if locked}<div class="pt-3"><Banner msg={$t('settings.locked')} /></div>{/if}
      {#each fields as f (f.key)}<ConfigFieldRow field={f} value={c.values[f.key]} {session} disabled={locked || session.saving} />{/each}
    </div>
    <div class="sticky bottom-0 flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 border-t border-line bg-panel px-4 md:px-6 py-2.5">
      <div bind:this={status} tabindex="-1" class="mr-auto min-w-0 text-xs outline-none" aria-live="polite">
        {#if changed.length || invalid.length}
        <!-- Each part is a flex item of the chip, so its gap spaces them. -->
        <Chip tone="you" extra="sm max-w-full flex-wrap whitespace-normal"><span aria-hidden="true">{$t('common.you')} ·</span><span>{$t('settings.save.unsaved', { count: changed.length })}</span>{#if invalid.length}<span>· {$t('settings.save.invalid', { count: invalid.length })}</span>{/if}</Chip>{:else}<span class="label">{$t('settings.save.unsaved', { count: 0 })}</span>{/if}
        {#if problem}
          <button class="block text-left text-bad underline-offset-2 hover:underline break-words" onclick={() => goto(problem.key)}>{session.failedKey ? $t('settings.save.failedHere', { label: problem.label, error: session.saveErrors[problem.key] ?? '' }) : $t('settings.save.fixHere', { label: problem.label })}</button>
        {/if}
      </div>
      <button class="btn" disabled={!Object.keys(session.drafts).length || session.saving} onclick={() => session.reset()}>{$t('settings.save.reset')}</button>
      <button class="btn primary" disabled={!canSave} onclick={save}>{$t('settings.save.save')}</button>
    </div>
  </div>
{/if}
