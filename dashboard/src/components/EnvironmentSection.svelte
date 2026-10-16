<!-- The drawer's Environment card, for active jobs only: Focus or Unfocus (a pointer, POST /api/focus), the job's endpoints
     with a live dot and an Open link, Open in editor (the worktree in FORGE_EDITOR on the machine running forge dash) and
     Run (the job's dev command, started once and reused after). Nothing here starts, stops or signals another job's
     processes. Endpoint URLs come from the server, built from an integer port, and render as text. -->
<script lang="ts">
  import Icon from './Icon.svelte';
  import LiveDot from './LiveDot.svelte';
  import { safeUrl } from '../lib/markdown.ts';
  import { environmentModel, postEditor, postFocus, postRun, runToastKey } from '../lib/focus.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import type { Job } from '../lib/types.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: Pick<Job, 'id' | 'state' | 'worktree'> } = $props();
  // /api/state carries the endpoints and is polled, so the live dot follows it; the detail's job is the fallback.
  const row = $derived(S.data?.jobs?.find((j) => j.id === job.id) ?? null);
  const model = $derived(environmentModel({ id: job.id, state: row?.state ?? job.state, worktree: row?.worktree ?? job.worktree, endpoints: row?.endpoints }, S.data?.focus?.id));
  let busy = $state<'focus' | 'editor' | 'run' | null>(null);

  /** One POST at a time: a second click while one is in flight does nothing. */
  async function act(kind: 'focus' | 'editor' | 'run', fn: () => Promise<string | null>): Promise<void> {
    if (busy !== null) return;
    busy = kind;
    try {
      const done = await fn();
      if (done) toast(done);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      await refresh();
      busy = null;
    }
  }

  const toggleFocus = () =>
    act('focus', async () => {
      await postFocus(model.focused ? null : job.id, forgeToken());
      return null;
    });
  const openEditor = () =>
    act('editor', async () => {
      const r = await postEditor(job.id, forgeToken());
      return $t('environment.editorOpened', { editor: r.editor });
    });
  const run = () =>
    act('run', async () => {
      const r = await postRun(job.id, forgeToken());
      return runToastKey(r.reused) === 'environment.runReused' ? $t('environment.runReused') : $t('environment.runStarted');
    });
</script>

{#if model.visible}
  <div class="plate p-4 flex flex-col gap-3" id="drawer-environment">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="h section">{$t('environment.title')}</h3>
      <div class="flex flex-wrap gap-2">
        <button class="btn sm" disabled={busy !== null} aria-busy={busy === 'focus'} onclick={toggleFocus}><Icon name="review" />{model.focusLabel === 'environment.unfocus' ? $t('environment.unfocus') : $t('environment.focus')}</button>
        <button class="btn sm" disabled={model.editorDisabled || busy !== null} aria-busy={busy === 'editor'} title={model.editorDisabled ? $t('environment.editorNone') : undefined} onclick={openEditor}>{$t('environment.editor')}</button>
        <button class="btn sm" disabled={model.runDisabled || busy !== null} aria-busy={busy === 'run'} title={model.runDisabled ? $t('environment.none') : undefined} onclick={run}><Icon name="play" />{$t('environment.run')}</button>
      </div>
    </div>
    {#if model.endpoints.length}
      <ul class="flex flex-col gap-1.5">
        {#each model.endpoints as e (e.name)}
          {@const href = safeUrl(e.url)}
          <li class="flex items-center gap-2 min-w-0 text-sm">
            <LiveDot on={e.live} /><span class="sr-only">{e.live ? $t('environment.live') : $t('environment.stopped')}</span>
            <span class="label shrink-0">{e.name}</span>
            <span class="mono text-[13px] truncate selectable min-w-0">{e.url}</span>
            {#if href}<a class="btn sm ml-auto shrink-0" {href} target="_blank" rel="noopener">{$t('environment.open')}</a>{/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-sm text-muted">{$t('environment.none')}</p>
    {/if}
  </div>
{/if}
