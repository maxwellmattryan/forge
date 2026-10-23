<!-- One session's structured log (a job's, or the inbox's in the status bar's Daemon popover): one compact control row
     (status facts, then the Permissions and Effort dropdowns, one Start/Stop icon toggle, the Filter button, the rendered/raw
     icon toggle, Follow and Load older; the filters sit in a MenuButton popover), and turns with tool calls
     and subagents, followed live. Every log string is untrusted session output: text and thinking bodies and a
     subagent's prompt and result render only through the escape-first md() (as text in Raw or above 20k characters); tool
     input, tool results and every other line render as text. With `transcript`, it follows a job's Claude Code transcript
     instead (an agent's, or an interactive owner's): read-only, with no status, Start/Stop, mode or effort controls.
     With `fill` (the drawer's Log tab, the Foreman popover), it takes its container's remaining height and its log pane is the one scroller,
     instead of capping the pane's height. The office's header also states its model (from the newest init line) and its
     effort, both read-only: the daemon passes no --model, and the office's effort follows runtime.effort. -->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Banner from './Banner.svelte';
  import Chip from './Chip.svelte';
  import EffortSelect from './EffortSelect.svelte';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import Empty from './Empty.svelte';
  import MarkdownToggle from './MarkdownToggle.svelte';
  import MenuButton from './MenuButton.svelte';
  import Select from './Select.svelte';
  import { md } from '../lib/markdown.ts';
  import { keepFocus } from '../lib/menu.ts';
  import type { SelectOption } from '../lib/select.ts';
  import { renderable } from '../lib/md-view.ts';
  import { mdView } from '../lib/md-view.svelte.ts';
  import { TONE_CLASS, clock, usd } from '../lib/util.ts';
  import { INBOX_SCOPE, OFFICE_SCOPE } from '../lib/types.ts';
  import type { DaemonSessionState } from '../lib/types.ts';
  import { atBottom, buildSessionView, filtersActive, latestInitModel, readFilters } from '../lib/session-log.ts';
  import { modelLabel } from '../lib/statusbar.ts';
  import { EFFORTS } from '../lib/types.ts';
  import type { Effort } from '../lib/types.ts';
  import type { Filters } from '../lib/session-log.ts';
  import type { Entry, Item } from '../lib/session-parse.ts';
  import { createSessionLog } from '../lib/daemon-log.ts';
  import { TINT, logSender } from '../lib/sender.ts';
  import type { SessionLogUrls } from '../lib/daemon-log.ts';
  import { promptRefreshKey } from '../lib/permissions.ts';
  import { PERMISSION_MODES, mergeSessionState, postDaemon, postDaemonMode, sessionControls, sessionMode, sessionPill, sessionToggle } from '../lib/daemon.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { pref } from '../lib/prefs.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  /** A transcript to follow in place of the daemon session: the job, the agent's role (null for the owner) and the banner text. */
  type Transcript = { job: string; agent: string | null; label: string };
  let { scope, compact = false, active = true, transcript = null, fill = false }: { scope: string; compact?: boolean; active?: boolean; transcript?: Transcript | null; fill?: boolean } = $props();

  /** The transcript routes: the page takes the token as a header, the stream (EventSource sends none) as a query parameter. */
  function transcriptUrls(tr: Transcript): SessionLogUrls {
    const base = `/api/jobs/${encodeURIComponent(tr.job)}/transcript`;
    const who: Record<string, string> = tr.agent === null ? {} : { agent: tr.agent };
    return {
      events: `${base}/events?${new URLSearchParams({ ...who, token: forgeToken() })}`,
      page: (before) => `${base}?${new URLSearchParams({ ...who, ...(before === undefined ? {} : { before: String(before) }) })}`,
      headers: { 'x-forge-token': forgeToken() },
    };
  }

  // The stream's state frames are freshest; the 2 s /api/state poll covers the rest.
  let live = $state<Partial<DaemonSessionState> | null>(null);
  const polled = $derived(scope === INBOX_SCOPE ? (S.data?.daemons?.inbox ?? null) : scope === OFFICE_SCOPE ? (S.data?.daemons?.office ?? null) : (S.data?.daemons?.jobs?.[scope] ?? null));
  const session = $derived(live ?? polled);
  const poolWanted = $derived(S.data?.daemons?.wanted === true);
  let pending = $state(false);
  const pill = $derived(sessionPill(session));
  const controls = $derived(sessionControls(session, poolWanted, pending));
  const toggle = $derived(sessionToggle(controls, session));
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
      },
    }),
  );
  let entries = $state.raw<Entry[]>([]);
  let more = $state(false);
  let closed = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  const view = $derived(buildSessionView(entries, filters, { partial: more }));
  let follow = $state(true);
  const effortName = $derived<Record<Effort, string>>({ low: $t('effort.levels.low'), medium: $t('effort.levels.medium'), high: $t('effort.levels.high'), xhigh: $t('effort.levels.xhigh'), max: $t('effort.levels.max') });
  const level = (v: unknown): Effort | null => EFFORTS.find((e) => e === v) ?? null;
  // The office's facts. The model is session output (the init line), shown as text.
  const officeModel = $derived.by(() => {
    if (scope !== OFFICE_SCOPE) return '';
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

  async function act(action: 'start' | 'stop', el: HTMLButtonElement): Promise<void> {
    const restore = keepFocus(el);
    pending = true;
    try {
      await postDaemon(action, forgeToken(), scope);
      live = null;
      refresh();
    } catch (err) {
      toast($t('session.failed', { action, error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      pending = false;
      await tick();
      restore();
    }
  }

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

<svelte:document onvisibilitychange={() => log.visibilityChanged()} />

<!-- Every line is a log-row (style.css): time, caret, tag, body, each in its own column whatever the line's kind, so the
     times, tags and bodies line up down the pane. A line that expands is a log-fold whose open content sits in the body
     column; the summary's one-line preview hides while it is open. -->
{#snippet when(at: string | null)}
  <time datetime={at ?? undefined} title={at ?? undefined} class="log-time">{clock(at)}</time>
{/snippet}

{#snippet caret()}
  <span class="log-caret"><Icon name="chevron-down" /></span>
{/snippet}

{#snippet chip(tone: string | null, tag: string, title: string = tag)}
  <span class="log-tag"><Chip tone={tone && TONE_CLASS[tone] ? tone : 'muted'} extra="max-w-full" {title}><span class="truncate">{tag}</span></Chip></span>
{/snippet}

{#snippet line(at: string | null, tone: string | null, tag: string, text: string)}
  <div class="log-row {TINT.cli} px-1.5 -mx-1.5 py-0.5">{@render when(at)}{@render chip(tone, tag)}<span class="log-body whitespace-pre-wrap break-words">{text}</span></div>
{/snippet}

{#snippet result(r: NonNullable<Extract<Item, { kind: 'tool' }>['result']>)}
  <div class="mt-1">
    <div class="label">{$t('session.result')}</div>
    <pre class="whitespace-pre-wrap break-words border border-line-soft p-2 {r.isError ? 'text-bad' : ''}">{r.preview}</pre>
    {#if r.more}<details class="mt-1"><summary class="text-muted">{$t('session.fullResult')}</summary><pre class="whitespace-pre-wrap break-words border border-line-soft p-2 {r.isError ? 'text-bad' : ''}">{r.full}</pre></details>{/if}
  </div>
{/snippet}

{#snippet item(it: Item)}
  {#if it.kind === 'text'}
    {@const prose = renderable(it.text, mdView.session)}
    {@const toneText = it.tone === 'bad' ? 'text-bad' : it.tone ? 'text-muted' : ''}
    {#if it.long}
      <details class="log-fold group font-sans {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5">
        <summary class="log-row">{@render when(it.at)}{@render caret()}<span class="log-body whitespace-pre-wrap break-words group-open:hidden {toneText}">{it.text.slice(0, 200)}…</span></summary>
        <div class="log-row"><div class="log-body">{#if prose}<div class="{compact ? 'prose compact' : 'prose'} break-words [&>:first-child]:mt-0 {toneText}">{@html md(it.text)}</div>{:else}<div class="whitespace-pre-wrap break-words {toneText}">{it.text}</div>{/if}</div></div>
      </details>
    {:else}
      <div class="log-row font-sans {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5">{@render when(it.at)}{#if prose}<div class="log-body {compact ? 'prose compact' : 'prose'} break-words [&>:first-child]:mt-0 [&>:last-child]:mb-0 {toneText}">{@html md(it.text)}</div>{:else}<div class="log-body whitespace-pre-wrap break-words {toneText}">{it.text}</div>{/if}</div>
    {/if}
  {:else if it.kind === 'thinking'}
    <details class="log-fold group text-muted {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5">
      <summary class="log-row">{@render when(it.at)}{@render caret()}<span class="log-tag"><span>{$t('session.thinkingItem')}</span></span><span class="log-body truncate italic group-open:hidden">{it.text.trim().split('\n', 1)[0]}</span></summary>
      <div class="log-row"><div class="log-body">{#if renderable(it.text, mdView.session)}<div class="{compact ? 'prose compact' : 'prose'} font-sans break-words [&>:first-child]:mt-0">{@html md(it.text)}</div>{:else}<div class="whitespace-pre-wrap break-words">{it.text}</div>{/if}</div></div>
    </details>
  {:else if it.kind === 'tool'}
    <details class="log-fold {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5">
      <summary class="log-row">{@render when(it.at)}{@render caret()}<span class="log-tag" title={it.name}><span class={it.result?.isError ? 'text-bad' : 'text-gleam'}>{it.name}</span></span><span class="log-body flex items-baseline gap-2"><span class="min-w-0 truncate" title={it.summary}>{it.summary}</span>{#if it.task?.text}<span class="min-w-0 shrink-[3] truncate text-muted" title={it.task.text}>{it.task.text}</span>{/if}{#if it.result?.isError}<Chip tone="bad" text={$t('session.error')} extra="shrink-0" />{/if}</span></summary>
      <div class="log-row pb-1"><div class="log-body">
        <div class="label mt-1">{$t('session.input')}</div>
        <pre class="whitespace-pre-wrap break-words border border-line-soft p-2">{it.input}</pre>
        {#if it.result}{@render result(it.result)}{/if}
      </div></div>
    </details>
  {:else if it.kind === 'subagent'}
    <details class="log-fold {TINT[logSender(it.kind)]} px-1.5 -mx-1.5 py-0.5">
      <!-- A Forge role drops its plugin prefix so it fits the tag column; the chip's title keeps the full name. -->
      <summary class="log-row">{@render when(it.at)}{@render caret()}{@render chip(it.known ? 'info' : 'muted', it.role.replace(/^forge:/, ''), it.role)}<span class="log-body flex items-baseline gap-2"><span class="min-w-0 truncate" title={it.description}>{it.description}</span>{#if it.task?.text}<span class="min-w-0 shrink-[3] truncate text-muted" title={it.task.text}>{it.task.text}</span>{/if}{#if it.hidden}<span class="shrink-0 text-muted">{$t('session.hiddenLines', { count: it.hidden })}</span>{/if}{#if it.result?.isError}<Chip tone="bad" text={$t('session.error')} extra="shrink-0" />{/if}</span></summary>
      <div class="log-row pb-1">
        {#if it.prompt}
          <details class="log-body mt-1">
            <summary class="text-muted">{$t('session.prompt')}</summary>
            {#if renderable(it.prompt, mdView.session)}<div class="prose compact break-words border border-line-soft p-2">{@html md(it.prompt)}</div>{:else}<pre class="whitespace-pre-wrap break-words border border-line-soft p-2">{it.prompt}</pre>{/if}
          </details>
        {/if}
        {#if it.items.length}<div class="log-nest mt-1 flex flex-col gap-1 border-l border-info/40 pl-2">{#each it.items as child, i (i)}{@render item(child)}{/each}</div>{/if}
        {#if it.result}
          {#if renderable(it.result.full, mdView.session)}
            <div class="log-body mt-1"><div class="label">{$t('session.result')}</div><div class="prose compact break-words border border-line-soft p-2 {it.result.isError ? 'text-bad' : ''}">{@html md(it.result.full)}</div></div>
          {:else}<div class="log-body">{@render result(it.result)}</div>{/if}
        {/if}
      </div>
    </details>
  {:else if it.kind === 'init'}
    {@render line(it.at, 'muted', 'init', [it.model, it.session].filter(Boolean).join(' · '))}
  {:else if it.kind === 'result'}
    {@render line(it.at, it.tone, 'result', it.text)}
  {:else if it.kind === 'supervisor'}
    {@render line(it.at, it.tone, 'supervisor', it.text)}
  {:else if it.kind === 'task'}
    {@render line(it.at, it.tone, it.role || 'task', it.text)}
  {:else}
    {@render line(it.at, it.tone, it.kind, it.text)}
  {/if}
{/snippet}

<div class="flex flex-col gap-2 {fill ? 'min-h-0 flex-1' : ''}">
  <!-- One row that wraps: the facts on the left, the controls pushed right as one group, so on a phone the group wraps
       under the facts as a whole before its own buttons wrap. -->
  <div class="flex flex-wrap items-center gap-x-1.5 gap-y-2">
    {#if transcript}
      <span role="note" class="plain min-w-0 break-all px-2 py-1 text-xs text-muted">{transcript.label}</span>
    {:else}
      <Chip role="status" tone={pill.tone} extra="sm" title={pill.title} text={pill.label} />
      <span class="text-xs text-muted">{$t('session.turns', { count: view.totals.turns })}</span>
      {#if view.totals.results}<span class="text-xs text-muted" title={$t('session.costTitle')}>{$t('session.cost', { cost: usd(view.totals.costUsd) })}</span>{/if}
      {#if scope === OFFICE_SCOPE}
        <span class="text-xs text-muted">{$t('session.model', { model: officeModel })}</span>
        <span class="text-xs text-muted" title={$t('session.effortHint')}>{$t('session.effort', { effort: officeEffort })}</span>
      {/if}
    {/if}
    <div class="ml-auto flex flex-wrap items-center justify-end gap-1.5">
      {#if !transcript}
        <!-- The Select stays enabled while its entries can't change, so it still opens and the hints stay readable. -->
        <Select variant="button" icon="shield" align="end" label={$t('session.modeLabel')} value={shownMode} text={modeName[shownMode] ?? shownMode} options={modeOptions} onchange={setMode} />
        {#if scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE}<EffortSelect job={scope} />{/if}
        <IconButton icon={toggle.action === 'start' ? 'play' : 'stop'} label={toggle.action === 'start' ? $t('session.start') : $t('session.stop')} hint={toggle.action === 'start' ? $t('session.startHint') : null} disabled={!toggle.enabled} onclick={(e) => act(toggle.action, e.currentTarget)} />
      {/if}
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
  {#if !transcript}
    {#if session?.lastError}<div role="status" class="text-xs text-bad break-words">{session.lastError}</div>{/if}
    {#if mode.live !== null}<div role="status" class="text-xs text-muted">{$t('session.modeSwitching', { mode: modeName[mode.live] ?? mode.live })}</div>{/if}
    {#if mode.chosen === 'auto'}<div class="text-xs text-warn">{$t('session.modes.autoWarning')}</div>{/if}
  {/if}
  {#if error !== null}
    <Banner msg={error} />
  {:else if loading && !entries.length}
    <div class="text-sm text-muted {fill ? 'min-h-0 flex-1' : ''}">{$t('session.loading')}</div>
  {:else if !entries.length}
    {@const enabled = S.data?.daemons?.enabled === true}
    <Empty>{#if transcript}{$t('session.transcriptEmpty')}{:else if scope === INBOX_SCOPE}{enabled ? $t('session.emptyInboxEnabled') : $t('session.emptyInbox')}{:else if scope === OFFICE_SCOPE}{$t('session.emptyOffice')}{:else}{enabled ? $t('session.emptyEnabled') : $t('session.empty')}{/if}</Empty>
  {/if}
  {#if entries.length}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable from the keyboard) -->
    <div bind:this={pane} onscroll={onScroll} role="log" aria-live="off" aria-label={$t('session.label')} tabindex="0" class="log-pane plate flat mono selectable px-2.5 pb-2.5 {compact ? 'text-[11px] leading-5' : 'text-[13px] leading-5'} {fill ? 'min-h-0 flex-1' : compact ? 'max-h-72' : 'max-h-[70vh]'} overflow-y-auto overscroll-contain">
      {#if !view.turns.length}<div class="text-muted">{$t('session.noMatch')}</div>{/if}
      {#each view.turns as g (g.offset)}
        <section class="mb-2">
          <h3 class="label sticky top-0 z-10 bg-panel pt-2 pb-1">{g.label}{#if g.at} <time datetime={g.at} title={g.at} class="font-normal tabular-nums">· {clock(g.at)}</time>{/if}</h3>
          <div class="flex flex-col gap-1">{#each g.items as it, i (i)}{@render item(it)}{/each}</div>
        </section>
      {/each}
    </div>
  {/if}
  {#if closed}<div role="status" class="text-xs text-muted">{$t('session.closed')}</div>{/if}
</div>
