<!-- One session's structured log (a job's, or the inbox's in the status bar's Inbox popover): one compact control row
     (status facts, then SessionControls' Permissions and Effort dropdowns and Start/Stop toggle, the Filter button, the rendered/raw
     icon toggle, Follow and Load older; the filters sit in a MenuButton popover), and turns with tool calls
     and subagents, followed live. Each turn's items render through LogItem.svelte, which holds the escaping rules for
     untrusted session output (md() for prose only, everything else as text). With `transcript`, it follows a job's Claude Code transcript
     instead (an agent's, or an interactive owner's): read-only, with no status, Start/Stop, mode or effort controls.
     With `controls` false (the job drawer, whose header holds them) it leaves out SessionControls.
     With `fill` (the drawer's Log tab, the Foreman popover), it takes its container's remaining height and its log pane is the one scroller,
     instead of capping the pane's height. Every daemon-scoped header also states its model (from the newest init line), and
     the office's its effort, both read-only: the daemon passes no --model, and the office's effort follows runtime.effort.
     It is a station terminal (style.css `station`): the bezel holds the nameplate (pilot lamp, then the facts) and the
     controls, and the screen is the log pane, always drawn. Heat is activity (src/lib/logs/station.ts): the bezel warms while
     live lines stream, a call that arrives live strikes its gutter, the screen clocks in the
     first time the lamp goes live after the dashboard settles, and a stage change drops the nameplate's shutter. -->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Banner from '../ui/feedback/Banner.svelte';
  import Chip from '../ui/Chip.svelte';
  import Lamp from './Lamp.svelte';
  import LogItem from './LogItem.svelte';
  import MarkdownToggle from '../ui/MarkdownToggle.svelte';
  import MenuButton from '../ui/overlay/MenuButton.svelte';
  import SessionControls from '../sessions/SessionControls.svelte';
  import { mdView } from '../../lib/text/md-view.svelte.ts';
  import { clock, usd } from '../../lib/core/util.ts';
  import { projectApi } from '../../lib/core/project.ts';
  import { INBOX_SCOPE, OFFICE_SCOPE, sharedScope } from '../../lib/core/types.ts';
  import type { DaemonSessionState } from '../../lib/core/types.ts';
  import { atBottom, buildSessionView, filtersActive, latestInitModel, readFilters } from '../../lib/logs/session-log.ts';
  import { modelLabel } from '../../lib/shell/statusbar.ts';
  import { EFFORTS } from '../../lib/core/types.ts';
  import type { Effort } from '../../lib/core/types.ts';
  import type { Filters } from '../../lib/logs/session-log.ts';
  import type { Entry } from '../../lib/logs/session-parse.ts';
  import { createSessionLog } from '../../lib/logs/daemon-log.ts';
  import type { SessionLogUrls } from '../../lib/logs/daemon-log.ts';
  import { promptRefreshKey } from '../../lib/sessions/permissions.ts';
  import { mergeSessionState, scopeSession, sessionPill } from '../../lib/sessions/daemon.ts';
  import { S, refresh } from '../../lib/core/app.svelte.ts';
  import { ticker } from '../../lib/core/clock.svelte.ts';
  import { settled, shutter } from '../../lib/ui/motion.ts';
  import { LIVE_LAMPS, lampState, streaming } from '../../lib/logs/station.ts';
  import { pref } from '../../lib/settings/prefs.ts';
  import { t } from '../../lib/text/locale.ts';

  /** A transcript to follow in place of the daemon session: the job, the agent's role (null for the owner) and the banner text. */
  type Transcript = { job: string; agent: string | null; label: string };
  let {
    scope,
    compact = false,
    active = true,
    transcript = null,
    fill = false,
    controls = true,
    stage = null,
    finished = false,
  }: {
    scope: string;
    compact?: boolean;
    active?: boolean;
    transcript?: Transcript | null;
    fill?: boolean;
    /** False in the job drawer, whose header holds the session controls. */
    controls?: boolean;
    /** The job's stage (the drawer's Log tab): a change drops the nameplate's shutter and relights the lamp. */
    stage?: string | null;
    /** A transcript's agent has finished (the Agents tab), so its lamp is done. */
    finished?: boolean;
  } = $props();

  /** The transcript routes: the stream (an EventSource) and the pages before it. */
  function transcriptUrls(tr: Transcript): SessionLogUrls {
    const base = projectApi(`/api/jobs/${encodeURIComponent(tr.job)}/transcript`);
    const who: Record<string, string> = tr.agent === null ? {} : { agent: tr.agent };
    return {
      events: `${base}/events?${new URLSearchParams(who)}`,
      page: (before) => `${base}?${new URLSearchParams({ ...who, ...(before === undefined ? {} : { before: String(before) }) })}`,
    };
  }

  // The stream's state frames are freshest; the 2 s /api/state poll covers the rest.
  let live = $state<Partial<DaemonSessionState> | null>(null);
  const polled = $derived(scopeSession(S.data?.daemons ?? null, scope));
  const session = $derived(live ?? polled);
  const pill = $derived(sessionPill(session));

  let filters = $state<Filters>(readFilters(pref.get('sessionFilters', '')));
  const filtering = $derived(filtersActive(filters));
  $effect(() => pref.set('sessionFilters', JSON.stringify(filters)));

  // The stream sees a new or answered prompt before the poll does, and PermissionPrompts (the drawer's dock, the
  // Needs-you popover) reads the poll: re-poll once per prompt-id set the poll doesn't have yet. Not $state: nothing renders it.
  let promptsAsked: string | null = null;

  // untrack: the log belongs to the scope (or transcript) it was created for; Drawer keys this component by both.
  const log = untrack(() =>
    createSessionLog({
      scope,
      urls: transcript ? transcriptUrls(transcript) : undefined,
      onState: (st) => {
        if (transcript) return;
        live = mergeSessionState(live, st);
        const key = promptRefreshKey(st, polled, promptsAsked);
        if (key !== null) {
          promptsAsked = key;
          void refresh();
        }
      },
      onChange: () => {
        entries = log.entries.slice();
        more = log.more;
        closed = log.closed;
        // A closed stream sends no more state frames: fall back to the /api/state poll.
        if (closed) live = null;
        loading = log.loading;
        error = log.error;
        lastLiveAt = log.lastLiveAt;
      },
    }),
  );
  /** When the newest live line arrived (daemon-log.ts): page fetches and replayed lines never set it. */
  let lastLiveAt = $state<number | null>(null);
  let entries = $state.raw<Entry[]>([]);
  let more = $state(false);
  let closed = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  const view = $derived(buildSessionView(entries, filters, { partial: more }));
  let follow = $state(true);
  const effortName = $derived<Record<Effort, string>>({ low: $t('effort.levels.low'), medium: $t('effort.levels.medium'), high: $t('effort.levels.high'), xhigh: $t('effort.levels.xhigh'), max: $t('effort.levels.max') });
  const level = (v: unknown): Effort | null => EFFORTS.find((e) => e === v) ?? null;
  // The nameplate's facts. The job id on job-scoped terminals; the model on every daemon-scoped one, from session output
  // (the init line), shown as text.
  const jobId = $derived(sharedScope(scope) ? null : (transcript?.job ?? scope));
  const model = $derived.by(() => {
    if (transcript) return '';
    const raw = latestInitModel(entries);
    return raw === null ? $t('session.modelUnknown') : (modelLabel(raw).label ?? raw);
  });
  const officeEffort = $derived.by(() => {
    const spawned = level(session?.effort);
    if (spawned !== null) return effortName[spawned];
    const fallback = level(S.data?.config?.effort);
    return fallback === null ? $t('effort.claude') : $t('effort.inherit', { level: effortName[fallback] });
  });
  let pane = $state<HTMLDivElement>();

  // ---------- the station's life ----------
  /** When the screen clocked in: it warms the bezel as if a line had arrived. */
  let clockIn = $state<number | null>(null);
  let powering = $state(false);
  let clocked = false;
  const isStreaming = $derived(streaming(Math.max(lastLiveAt ?? -Infinity, clockIn ?? -Infinity), ticker.now));
  const lamp = $derived(
    lampState(transcript ? { kind: 'stream', ended: finished, waiting: view.openTool, streaming: isStreaming } : { kind: 'session', session, waiting: view.openTool, streaming: isStreaming }),
  );
  // Nothing heats for SETTLE_MS after the dashboard's first data or a reconnect.
  const hot = $derived(isStreaming && settled(ticker.now, S.readyAt));
  // Once per mount: the first time the lamp is live, the screen powers on, unless that is before the dashboard settled
  // (a page load), which spends the clock-in without showing it.
  $effect(() => {
    if (clocked || !LIVE_LAMPS.has(lamp)) return;
    clocked = true;
    const now = Date.now();
    if (!untrack(() => settled(now, S.readyAt))) return;
    clockIn = now;
    powering = true;
  });
  const initialStage = untrack(() => stage);
  const ready = (): number | null => S.readyAt;
  /** A stage change since mount: the nameplate's shutter drops and the lamp relights; the first render does neither. */
  const shifted = $derived(stage !== initialStage);

  $effect(() => {
    const shown = active;
    untrack(() => {
      if (!shown) live = null;
      log.sync(shown);
    });
  });
  onDestroy(() => log.dispose());

  // Following keeps the pane at the bottom as lines arrive.
  $effect.pre(() => {
    void view;
    if (!pane || !follow) return;
    const p = pane;
    tick().then(() => (p.scrollTop = p.scrollHeight));
  });

  function onScroll(): void {
    if (!pane) return;
    follow = atBottom(pane.scrollHeight, pane.scrollTop, pane.clientHeight);
  }

  function jump(): void {
    follow = true;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }
</script>

<svelte:document onvisibilitychange={() => log.visibilityChanged()} />

<div class="station flex flex-col gap-2 {hot ? 'hot' : ''} {fill ? 'min-h-0 flex-1' : ''}">
  <!-- One row that wraps: the nameplate on the left, the controls pushed right as one group, so on a phone the group wraps
       under the nameplate as a whole before its own buttons wrap. -->
  <div class="flex items-center gap-x-1.5 gap-y-2 {compact ? 'flex-nowrap' : 'flex-wrap'}">
    {#key stage}
      <div class="nameplate {compact ? 'flex-nowrap overflow-hidden' : ''}" in:shutter={shifted ? { ready } : { duration: 0 }}>
        <Lamp state={lamp} relit={shifted && settled(Date.now(), S.readyAt)} />
        {#if jobId}<span class="min-w-0 break-all text-fg normal-case selectable">{jobId}</span>{/if}
        {#if transcript}
          <span role="note" class="min-w-0 break-all">{transcript.label}</span>
        {:else}
          {#if !compact}<Chip ariaHidden tone={pill.tone} title={pill.title} text={pill.label} />{/if}
          <span class="text-fg {compact ? 'shrink-0 whitespace-nowrap' : ''}">{$t('session.turns', { count: view.totals.turns })}</span>
          {#if view.totals.results}<span class="text-fg {compact ? 'shrink-0 whitespace-nowrap' : ''}" title={$t('session.costTitle')}>{$t('session.cost', { cost: usd(view.totals.costUsd) })}</span>{/if}
          <span class="min-w-0 text-fg {compact ? 'truncate' : 'break-all'}" title={model}>{$t('session.model', { model })}</span>
          {#if scope === OFFICE_SCOPE}<span class="text-fg" title={$t('session.effortHint')}>{$t('session.effort', { effort: officeEffort })}</span>{/if}
        {/if}
      </div>
    {/key}
    <!-- The pill's live region stays mounted outside the key: a region remounted with its text, as the key does on a stage
         change, is often not read. The visible chip is aria-hidden so nothing is read twice. -->
    {#if !transcript}<span role="status" class="sr-only">{pill.label}</span>{/if}
    <div class="ml-auto flex items-start justify-end gap-1.5 {compact ? 'shrink-0' : 'flex-wrap'}">
      {#if !transcript && controls}<SessionControls {scope} {live} onacted={() => (live = null)} />{/if}
      <MenuButton label={filtering ? $t('session.filterActive') : $t('session.filter')} title={$t('session.filterTitle')} icon="filter" iconOnly badge={filtering}>
        <input class="input sm w-full" type="search" placeholder={$t('session.filter')} aria-label={$t('session.filter')} bind:value={filters.text} />
        <div class="flex flex-col gap-1">
          <label class="field"><input type="checkbox" class="check" bind:checked={filters.tools} />{$t('session.tools')}</label>
          <label class="field"><input type="checkbox" class="check" bind:checked={filters.thinking} />{$t('session.thinking')}</label>
          <label class="field"><input type="checkbox" class="check" bind:checked={filters.subagents} />{$t('session.subagents')}</label>
        </div>
      </MenuButton>
      <MarkdownToggle surface="session" iconOnly />
      <button class="btn sm {follow ? 'sel' : ''}" aria-pressed={follow ? 'true' : 'false'} onclick={jump}>{$t('session.follow')}</button>
      {#if more}<button class="btn sm" onclick={() => log.loadOlder()}>{$t('session.loadOlder')}</button>{/if}
    </div>
  </div>
  {#if error !== null}<Banner msg={error} />{/if}
  <!-- The screen always renders: with no lines it shows the loading, empty or no-match message as one muted line. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable from the keyboard) -->
  <div
    bind:this={pane}
    onscroll={onScroll}
    onanimationend={(e) => {
      if (e.target === e.currentTarget) powering = false;
    }}
    role="log"
    aria-live="off"
    aria-label={$t('session.label')}
    tabindex="0"
    class="screen log-pane mono selectable px-2.5 pb-2.5 {LIVE_LAMPS.has(lamp) ? 'live' : ''} {powering ? 'powering' : ''} {compact ? 'text-[11px] leading-5' : 'text-[13px] leading-5'} {fill ? 'min-h-0 flex-1' : compact ? 'min-h-16 max-h-72' : 'min-h-16 max-h-[70vh]'} overscroll-contain"
  >
    {#if !entries.length}
      {#if error === null}
        {@const enabled = S.data?.daemons?.enabled === true}
        <p class="pt-2 font-sans text-sm text-muted">{#if loading}{$t('session.loading')}{:else if transcript}{$t('session.transcriptEmpty')}{:else if scope === INBOX_SCOPE}{enabled ? $t('session.emptyInboxEnabled') : $t('session.emptyInbox')}{:else if scope === OFFICE_SCOPE}{$t('session.emptyOffice')}{:else}{enabled ? $t('session.emptyEnabled') : $t('session.empty')}{/if}</p>
      {/if}
    {:else if !view.turns.length}<p class="pt-2 text-muted">{$t('session.noMatch')}</p>{/if}
    {#each view.turns as g (g.offset)}
      <section class="mb-2">
        <h3 class="label sticky top-0 z-10 bg-(--screen) pt-2 pb-1">{g.label}{#if g.at} <time datetime={g.at} title={g.at} class="font-normal tabular-nums">· {clock(g.at)}</time>{/if}</h3>
        <div class="flex flex-col gap-1">{#each g.items as it, i (i)}<LogItem {it} {compact} view={mdView.session} arrived={(o) => log.arrivedAt(o)} />{/each}</div>
      </section>
    {/each}
  </div>
  {#if closed}<div role="status" class="text-xs text-muted">{$t('session.closed')}</div>{/if}
</div>
