<!-- The Workers popover's body: the daemon pool and its job sessions. One controls row: the pool pill and live/cap on the
     left; on the right the job sessions' default permission mode (a job's own choice in its Log tab overrides it; Auto
     adds a warn icon whose tooltip carries the warning) and the pool's one Start/Stop icon toggle. Under it the pool error
     or, for a project whose files no human has approved, the line that says to review them and press Start, and a line when
     billing variables are set where forge dash started (warn tone for a provider switch or ANTHROPIC_BASE_URL, as doctor).
     Then one row per job session in status order, in a fixed-height list that alone scrolls, or a muted line when there is
     none. A row's second line is its job id, its own mode when it has one, and its running child's last turn context
     (` · 245k context`). A row opens that job's pane on the Log tab. The rows say held and waiting themselves, so no
     chips repeat them; permission prompts are answered in the Needs-you popover. The inbox session lives in its own Inbox
     popover. StatusBar owns the pool state and act(), so the indicator and this panel agree. Session errors and job titles
     are untrusted and render as text. -->
<script lang="ts">
  import Chip from '../Chip.svelte';
  import Icon from '../Icon.svelte';
  import IconButton from '../IconButton.svelte';
  import Select from '../Select.svelte';
  import Tooltip from '../Tooltip.svelte';
  import { PERMISSION_MODES, START_HINT, billingNote, daemonRows, jobFallbackMode, postDaemonMode, type Pill, type PoolModel } from '../../lib/daemon.ts';
  import type { DaemonBilling } from '../../lib/types.ts';
  import type { SelectOption } from '../../lib/select.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { JOBS_SCOPE } from '../../lib/types.ts';
  import { S, forgeToken, openDrawer, refresh } from '../../lib/app.svelte.ts';
  import { closePopover } from '../../lib/popover.svelte.ts';
  import { t } from '../../lib/locale.ts';
  import { tokensShort } from '../../lib/util.ts';

  let {
    model,
    pending,
    act,
    billing = null,
  }: { model: PoolModel | null; pending: boolean; act: (action: 'start' | 'stop') => void; billing?: DaemonBilling | null } = $props();
  const uid = $props.id();
  let warning = $state<HTMLSpanElement>();
  // Billing variables set where forge dash started: sessions ignore them, or (api-key) bill that account. Muted for an API key alone.
  const note = $derived(billingNote(billing));

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

  function openJob(id: string): void {
    closePopover('navigate');
    openDrawer(id, null, 'log');
  }
</script>

{#snippet pill(p: Pill)}<Chip tone={p.tone} extra="sm shrink-0" title={p.title} text={p.label} />{/snippet}

{#if model}
  <div class="flex flex-col gap-3" aria-busy={pending}>
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <!-- gap-x-3 keeps the two facts apart without a separator that a wrap would leave dangling. -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Chip tone={model.pill.tone} extra="sm" title={model.pill.title} text={$t('daemon.pill', { label: model.pill.label })} />
        <span class="mono muted num">{$t('daemon.live', { live: model.live, cap: model.cap })}</span>
      </div>
      <div class="flex items-center gap-1.5" title={$t('statusbar.workers.jobModeAbout')}>
        <!-- Left of the select, so turning Auto on or off never moves it or Start/Stop under the pointer. As the session controls: an icon, hover shows the tooltip, a tap toggles it. -->
        {#if jobMode === 'auto'}<span bind:this={warning} role="img" class="inline-flex items-center px-1 text-warn" aria-label={$t('statusbar.workers.jobModeAutoWarning')} aria-describedby="{uid}-warning"><Icon name="warning" /></span><span id="{uid}-warning" class="sr-only">{$t('statusbar.workers.jobModeAutoWarning')}</span><Tooltip anchor={warning} text={$t('statusbar.workers.jobModeAutoWarning')} toggle />{/if}
        <Select variant="button" icon="shield" align="end" label={$t('statusbar.workers.jobMode')} value={shownMode} text={named(shownMode)} options={modeOptions} onchange={setJobMode} />
        <IconButton icon={model.toggle.action === 'start' ? 'play' : 'stop'} label={model.toggle.action === 'start' ? $t('daemon.start') : $t('daemon.stop')} hint={model.toggle.action === 'start' ? (model.approval ? $t('statusbar.workers.approvalHint') : model.startHint) : null} disabled={!model.toggle.enabled} onclick={() => act(model.toggle.action)} />
      </div>
    </div>
    {#if model.error !== null}<p class="text-sm text-bad whitespace-pre-line break-words">{model.error}</p>{/if}
    {#if model.approval}<p class="text-sm text-warn break-words">{$t('statusbar.workers.approval')}</p>{/if}
    {#if note}<p class="text-xs {note.warn ? 'text-warn' : 'muted'}">{note.passed ? $t('statusbar.workers.billingPassed', { vars: note.vars }) : $t('statusbar.workers.billingIgnored', { vars: note.vars })}</p>{/if}
    {#if rows.length === 0}
      <p class="text-sm text-muted border-t border-line pt-3">{$t('statusbar.workers.empty')}</p>
    {:else}
      <ul class="flex h-64 flex-col gap-1 overflow-y-auto overscroll-contain border-t border-line pt-3" aria-label={$t('daemon.rows.label')}>
        {#each rows as r (r.id)}
          <li class="shrink-0">
            <button class="plain clickable flex w-full min-w-0 items-center gap-3 border border-line-soft px-2 py-1.5 text-left" title={[r.id, r.pill.title, ...(r.mode ? [$t('daemon.modeTitle', { mode: named(r.mode) })] : [])].join('\n')} onclick={() => openJob(r.id)}>
              <span class="flex min-w-0 flex-1 flex-col"><span class="truncate text-sm">{r.title ?? r.id}</span><span class="mono muted truncate">{r.id}{#if r.mode} · {named(r.mode)}{/if}{#if r.context !== null} · {$t('daemon.context', { tokens: tokensShort(r.context) })}{/if}</span></span>
              {@render pill(r.pill)}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{:else}
  <div class="flex flex-col gap-3">
    <p class="text-sm text-muted">{$t('statusbar.workers.disabled')}</p>
    <div><IconButton icon="play" label={$t('daemon.start')} hint={START_HINT} disabled /></div>
  </div>
{/if}
