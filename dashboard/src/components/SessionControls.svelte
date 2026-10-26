<!-- One daemon session's controls: in Auto, a flat warning icon (text on the surface, not a button) whose tooltip is the
     reminder, then the Permissions dropdown, a job's Effort dropdown and, with `toggle`, the Start/Stop icon toggle
     (SessionToggle), with the session's notes (its last error, a mode switch claude hasn't confirmed) under them,
     right-aligned. The session log shows them for the inbox and the office; the job drawer shows a job's in its header,
     so every tab has them, and its Start/Stop at the end of the tab row instead. `live` is the caller's freshest session
     state (the log's stream), else the 2 s /api/state poll's; `onacted` runs after a Start or Stop so the caller can drop
     that state. The last error is session output: text only. -->
<script lang="ts">
  import EffortSelect from './EffortSelect.svelte';
  import Icon from './Icon.svelte';
  import Select from './Select.svelte';
  import SessionToggle from './SessionToggle.svelte';
  import Tooltip from './Tooltip.svelte';
  import type { SelectOption } from '../lib/select.ts';
  import { sharedScope } from '../lib/types.ts';
  import type { DaemonSessionState } from '../lib/types.ts';
  import { PERMISSION_MODES, postDaemonMode, scopeSession, sessionMode } from '../lib/daemon.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { scope, live = null, onacted, toggle = true }: { scope: string; live?: Partial<DaemonSessionState> | null; onacted?: () => void; toggle?: boolean } = $props();

  const session = $derived(live ?? scopeSession(S.data?.daemons ?? null, scope));
  let pending = $state(false);
  const uid = $props.id();
  let warning = $state<HTMLSpanElement>();
  // The choice lives in the pool, so it shows (and applies at the next spawn) even while no child runs.
  const mode = $derived(sessionMode(S.data?.daemons ?? null, scope, session));
  /** Shown until the next /api/state carries the new choice, so the trigger doesn't jump back meanwhile. */
  let picked = $state<string | null>(null);
  const modeName = $derived<Record<string, string>>({ default: $t('session.modes.default'), auto: $t('session.modes.auto'), dontAsk: $t('session.modes.dontAsk') });
  const modeHint = $derived<Record<string, string>>({ default: $t('session.modes.defaultHint'), auto: $t('session.modes.autoHint'), dontAsk: $t('session.modes.dontAskHint') });
  const shownMode = $derived(picked ?? mode.chosen);
  const modeLocked = $derived(pending || S.data?.daemons?.enabled !== true);
  // modeLocked covers a change that is saving (pending). A chosen mode this dashboard doesn't know shows last, selected
  // and disabled.
  const modeOptions = $derived<SelectOption[]>([
    ...PERMISSION_MODES.map((m) => ({ value: m, label: modeName[m], hint: modeHint[m], disabled: modeLocked })),
    ...(PERMISSION_MODES.some((m) => m === mode.chosen) ? [] : [{ value: mode.chosen, label: mode.chosen, disabled: true, separator: true }]),
  ]);

  async function setMode(value: string): Promise<void> {
    const next = PERMISSION_MODES.find((m) => m === value);
    if (!next || next === mode.chosen) return;
    picked = next;
    pending = true;
    try {
      await postDaemonMode(scope, next, forgeToken());
      await refresh();
    } catch (err) {
      toast($t('session.modeFailed', { error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      picked = null;
      pending = false;
    }
  }
</script>

<div class="flex min-w-0 flex-col items-end gap-1">
  <div class="flex flex-wrap items-center justify-end gap-1.5">
    <!-- Left of Permissions, so turning Auto on or off never moves the dropdowns or Start/Stop under the pointer. It only
         explains, so it is an icon on the surface, not a button: hovering shows its tooltip, and a tap toggles it. -->
    {#if mode.chosen === 'auto'}<span bind:this={warning} role="img" class="inline-flex items-center px-1 text-warn" aria-label={$t('session.modes.autoWarning')} aria-describedby="{uid}-warning"><Icon name="warning" /></span><span id="{uid}-warning" class="sr-only">{$t('session.modes.autoWarningHint')}</span><Tooltip anchor={warning} text={$t('session.modes.autoWarning')} hint={$t('session.modes.autoWarningHint')} toggle />{/if}
    <!-- The Select stays enabled while its entries can't change, so it still opens and the hints stay readable. -->
    <Select variant="button" icon="shield" align="end" label={$t('session.modeLabel')} value={shownMode} text={modeName[shownMode] ?? shownMode} options={modeOptions} onchange={setMode} />
    {#if !sharedScope(scope)}<EffortSelect job={scope} />{/if}
    {#if toggle}<SessionToggle {scope} {live} {onacted} />{/if}
  </div>
  {#if session?.lastError}<div role="status" class="text-xs text-bad text-right break-words">{session.lastError}</div>{/if}
  {#if mode.live !== null}<div role="status" class="text-xs text-muted text-right">{$t('session.modeSwitching', { mode: modeName[mode.live] ?? mode.live })}</div>{/if}
</div>
