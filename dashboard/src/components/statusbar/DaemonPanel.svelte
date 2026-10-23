<!-- The Daemon popover's body. First the Foreman row: the supervisor above this pool, a button that opens the Foreman
     popover (StatusBar's openForeman anchors it on the bar's Foreman indicator), in both branches. Below it, under a
     divider, the pool pill, live/cap, the pool error, the job sessions' default permission mode (a job's own choice in its
     Log tab overrides it), the pool's one Start/Stop icon toggle, then one row per session:
     the Inbox session, then each job session in status order, and under them the Inbox session log toggle (remembered
     under LOG_KEY). A job row opens that job's pane on the Log tab. The rows say held and waiting themselves, so no chips
     repeat them; permission prompts are answered in the Needs-you popover. StatusBar owns the pool state and act(), so the indicator and this panel agree. Session errors
     and job titles are untrusted and render as text. -->
<script lang="ts">
  import Chip from '../Chip.svelte';
  import Icon from '../Icon.svelte';
  import IconButton from '../IconButton.svelte';
  import Select from '../Select.svelte';
  import SessionLog from '../SessionLog.svelte';
  import { PERMISSION_MODES, START_HINT, daemonRows, jobFallbackMode, postDaemonMode, type Pill, type PoolModel } from '../../lib/daemon.ts';
  import type { SelectOption } from '../../lib/select.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { LOG_KEY } from '../../lib/daemon-log.ts';
  import { INBOX_SCOPE, JOBS_SCOPE } from '../../lib/types.ts';
  import type { ForemanIndicator } from '../../lib/statusbar.ts';
  import { S, forgeToken, openDrawer, refresh } from '../../lib/app.svelte.ts';
  import { closePopover } from '../../lib/popover.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let { model, pending, act, foreman, openForeman }: { model: PoolModel | null; pending: boolean; act: (action: 'start' | 'stop') => void; foreman: ForemanIndicator; openForeman: () => void } = $props();

  const modeName = $derived<Record<string, string>>({ default: $t('session.modes.default'), auto: $t('session.modes.auto'), dontAsk: $t('session.modes.dontAsk') });
  const modeHint = $derived<Record<string, string>>({ default: $t('session.modes.defaultHint'), auto: $t('session.modes.autoHint'), dontAsk: $t('session.modes.dontAskHint') });
  /** A mode's name, own keys only, so a mode from the server never reads Object.prototype. */
  const named = (mode: string): string => (Object.hasOwn(modeName, mode) ? modeName[mode] : mode);
  // What a job session without its own choice runs in: the default chosen here, else daemon.command's.
  const jobMode = $derived(jobFallbackMode(S.data?.daemons ?? null));
  let modePending = $state(false);
  /** Shown until the next /api/state carries the new default, so the trigger doesn't jump back meanwhile. */
  let picked = $state<string | null>(null);
  const shownMode = $derived(picked ?? jobMode);
  const modeOptions = $derived<SelectOption[]>([
    ...PERMISSION_MODES.map((m) => ({ value: m, label: modeName[m], hint: modeHint[m], disabled: modePending })),
    ...(PERMISSION_MODES.some((m) => m === jobMode) ? [] : [{ value: jobMode, label: jobMode, disabled: true, separator: true }]),
  ]);
  async function setJobMode(value: string): Promise<void> {
    const next = PERMISSION_MODES.find((m) => m === value);
    if (!next || next === jobMode) return;
    picked = next;
    modePending = true;
    try {
      await postDaemonMode(JOBS_SCOPE, next, forgeToken());
      await refresh();
    } catch (err) {
      toast($t('session.modeFailed', { error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      picked = null;
      modePending = false;
    }
  }
  const rows = $derived(model ? daemonRows(model, S.data?.jobs ?? []) : []);

  const readOpen = (): boolean => {
    try {
      return localStorage.getItem(LOG_KEY) === '1';
    } catch {
      return false;
    }
  };
  let inboxOpen = $state(readOpen());
  function toggleInbox(): void {
    inboxOpen = !inboxOpen;
    try {
      localStorage.setItem(LOG_KEY, inboxOpen ? '1' : '0');
    } catch {}
  }

  function openJob(id: string): void {
    closePopover('navigate');
    openDrawer(id, null, 'log');
  }
</script>

{#snippet pill(p: Pill)}<Chip tone={p.tone} extra="sm shrink-0" title={p.title} text={p.label} />{/snippet}

{#snippet foremanRow()}
  <button class="plain foreman clickable flex w-full min-w-0 items-center gap-3 border px-2 py-1.5 text-left {foreman.on ? '' : 'off'}" onclick={openForeman}>
    <Icon name="foreman" />
    {#if foreman.on}
      <span class="flex min-w-0 flex-1 flex-col"><span class="truncate text-sm">{$t('daemon.rows.foremanRow')}</span><span class="caption muted truncate">{$t('daemon.rows.foremanRowAbout')}</span></span>
      {@render pill(foreman.pill)}
    {:else}
      <span class="min-w-0 flex-1 truncate text-sm">{$t('statusbar.foreman.off')}</span>
    {/if}
  </button>
{/snippet}

{#if model}
  <div class="flex flex-col gap-3" aria-busy={pending}>
    {@render foremanRow()}
    <div class="border-t border-line"></div>
    <!-- gap-x-3 keeps the two facts apart without a separator that a wrap would leave dangling. -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Chip tone={model.pill.tone} extra="sm" title={model.pill.title} text={$t('daemon.pill', { label: model.pill.label })} />
      <span class="mono muted num">{$t('daemon.live', { live: model.live, cap: model.cap })}</span>
    </div>
    {#if model.error !== null}<p class="text-sm text-bad whitespace-pre-line break-words">{model.error}</p>{/if}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span class="flex min-w-0 flex-1 flex-col"><span class="text-sm">{$t('statusbar.daemon.jobMode')}</span><span class="caption muted">{$t('statusbar.daemon.jobModeAbout')}</span></span>
      <Select variant="button" icon="shield" align="end" label={$t('statusbar.daemon.jobMode')} value={shownMode} text={named(shownMode)} options={modeOptions} onchange={setJobMode} />
    </div>
    {#if jobMode === 'auto'}<p class="text-xs text-warn">{$t('statusbar.daemon.jobModeAutoWarning')}</p>{/if}
    <div class="flex flex-wrap items-center gap-2">
      <IconButton icon={model.toggle.action === 'start' ? 'play' : 'stop'} label={model.toggle.action === 'start' ? $t('daemon.start') : $t('daemon.stop')} hint={model.toggle.action === 'start' ? model.startHint : null} disabled={!model.toggle.enabled} onclick={() => act(model.toggle.action)} />
    </div>
    <ul class="flex flex-col gap-1 border-t border-line pt-3" aria-label={$t('daemon.rows.label')}>
      {#each rows as r (r.kind === 'job' ? `job:${r.id}` : r.kind)}
        <li>
          {#if r.kind === 'job'}
            <button class="plain clickable flex w-full min-w-0 items-center gap-3 border border-line-soft px-2 py-1.5 text-left" title={[r.id, r.pill.title, ...(r.mode ? [$t('daemon.modeTitle', { mode: named(r.mode) })] : [])].join('\n')} onclick={() => openJob(r.id)}>
              <span class="flex min-w-0 flex-1 flex-col"><span class="truncate text-sm">{r.title ?? r.id}</span><span class="mono muted truncate">{r.id}{#if r.mode} · {named(r.mode)}{/if}</span></span>
              {@render pill(r.pill)}
            </button>
          {:else}
            <div class="plain flex min-w-0 items-center gap-3 border border-transparent px-2 py-1.5">
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="text-sm">{$t('daemon.rows.inbox')}</span>
                <span class="caption muted">{$t('daemon.rows.inboxAbout')}</span>
              </span>
              {@render pill(r.pill)}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <div class="border-t border-line pt-3">
      <button class="btn sm" aria-expanded={inboxOpen ? 'true' : 'false'} onclick={toggleInbox}><Icon name="inbox" />{$t('statusbar.daemon.inboxLog')}</button>
      {#if inboxOpen}<div class="mt-3 border-t border-line pt-3"><SessionLog scope={INBOX_SCOPE} compact /></div>{/if}
    </div>
  </div>
{:else}
  <div class="flex flex-col gap-3">
    {@render foremanRow()}
    <div class="border-t border-line"></div>
    <p class="text-sm text-muted">{$t('statusbar.daemon.disabled')}</p>
    <div><IconButton icon="play" label={$t('daemon.start')} hint={START_HINT} disabled /></div>
  </div>
{/if}
