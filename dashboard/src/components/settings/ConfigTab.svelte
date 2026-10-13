<!-- Settings › a config section: its fields from GET /api/config, and the Save bar that writes them through POST /api/config. -->
<script lang="ts">
  import Banner from '../Banner.svelte';
  import ConfigFieldRow from './ConfigFieldRow.svelte';
  import { S, refresh } from '../../lib/app.svelte.ts';
  import { fieldsFor } from '../../lib/config-form.ts';
  import { t } from '../../lib/locale.ts';
  import type { SettingsSession } from '../../lib/settings-session.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { ConfigSection } from '../../lib/types.ts';

  let { session, section }: { session: SettingsSession; section: ConfigSection } = $props();

  const c = $derived(session.config);
  const fields = $derived(c ? fieldsFor(c.fields, section) : []);
  const locked = $derived(c?.lockedBy === 'daemon' || S.data?.daemon?.wanted === true);
  const changed = $derived(session.changed);
  const canSave = $derived(changed.length > 0 && session.invalid.length === 0 && !locked && !session.saving);

  async function save(): Promise<void> {
    const r = await session.save();
    if (r.failed !== null) toast($t('settings.save.partial', { saved: r.saved, total: r.total }), true);
    else if (r.saved) {
      toast($t('settings.save.done', { count: r.saved }));
      refresh();
    }
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
    <div class="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-panel px-4 md:px-6 py-2.5">
      <span class="mr-auto text-xs text-muted" aria-live="polite">{$t('settings.save.unsaved', { count: changed.length })}</span>
      <button class="btn min-h-11 md:min-h-0" disabled={!Object.keys(session.drafts).length || session.saving} onclick={() => session.reset()}>{$t('settings.save.reset')}</button>
      <button class="btn btn-primary min-h-11 md:min-h-0" disabled={!canSave} onclick={save}>{$t('settings.save.save')}</button>
    </div>
  </div>
{/if}
