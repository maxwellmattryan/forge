<!-- One session's structured log (a job's, or the inbox's in the status bar's Daemon popover): status and Start/Stop, filters, and turns with
     tool calls and subagents, followed live. Every log string is untrusted session output: text and thinking bodies and a
     subagent's prompt and result render only through the escape-first md() (as text in Raw or above 20k characters); tool
     input, tool results and every other line render as text. With `transcript`, it follows a job's Claude Code transcript
     instead (an agent's, or an interactive owner's): read-only, with no status, Start/Stop, mode or effort controls. -->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Banner from './Banner.svelte';
  import Chip from './Chip.svelte';
  import EffortSelect from './EffortSelect.svelte';
  import Icon from './Icon.svelte';
  import Empty from './Empty.svelte';
  import MarkdownToggle from './MarkdownToggle.svelte';
  import { md } from '../lib/markdown.ts';
  import { renderable } from '../lib/md-view.ts';
  import { mdView } from '../lib/md-view.svelte.ts';
  import { TONE_CLASS, clock, usd } from '../lib/util.ts';
  import { INBOX_SCOPE, OFFICE_SCOPE } from '../lib/types.ts';
  import type { DaemonSessionState } from '../lib/types.ts';
  import { atBottom, buildSessionView, readFilters } from '../lib/session-log.ts';
  import type { Entry, Filters, Item } from '../lib/session-log.ts';
  import { createSessionLog } from '../lib/daemon-log.ts';
  import type { SessionLogUrls } from '../lib/daemon-log.ts';
  import { promptRefreshKey } from '../lib/permissions.ts';
  import { PERMISSION_MODES, mergeSessionState, postDaemon, postDaemonMode, sessionControls, sessionMode, sessionPill } from '../lib/daemon.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { pref } from '../lib/prefs.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  /** A transcript to follow in place of the daemon session: the job, the agent's role (null for the owner) and the banner text. */
  type Transcript = { job: string; agent: string | null; label: string };
  let { scope, compact = false, active = true, transcript = null }: { scope: string; compact?: boolean; active?: boolean; transcript?: Transcript | null } = $props();

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
  // The choice lives in the pool, so it shows (and applies at the next spawn) even while no child runs.
  const mode = $derived(sessionMode(S.data?.daemons ?? null, scope, session));
  /** Shown until the next /api/state carries the new choice, so the select doesn't jump back meanwhile. */
  let picked = $state<string | null>(null);
  const modeName = $derived<Record<string, string>>({ default: $t('session.modes.default'), auto: $t('session.modes.auto'), dontAsk: $t('session.modes.dontAsk') });
  const modeHint = $derived<Record<string, string>>({ default: $t('session.modes.defaultHint'), auto: $t('session.modes.autoHint'), dontAsk: $t('session.modes.dontAskHint') });

  let filters = $state<Filters>(readFilters(pref.get('sessionFilters', '')));
  $effect(() => pref.set('sessionFilters', JSON.stringify(filters)));

  // The stream sees a new or answered prompt before the poll does, and PermissionPrompts (the drawer's dock, the
  // Inbox popover) reads the poll: re-poll once per prompt-id set the poll doesn't have yet. Not $state: nothing renders it.
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

  async function act(action: 'start' | 'stop'): Promise<void> {
    pending = true;
    try {
      await postDaemon(action, forgeToken(), scope);
      live = null;
      refresh();
    } catch (err) {
      toast($t('session.failed', { action, error: err instanceof Error ? err.message : String(err) }), true);
    } finally {
      pending = false;
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

{#snippet when(at: string | null)}
  <time datetime={at ?? undefined} title={at ?? undefined} class="inline-block w-[8ch] shrink-0 text-muted tabular-nums">{clock(at)}</time>
{/snippet}

{#snippet line(at: string | null, tone: string | null, tag: string, text: string)}
  <div class="flex items-start gap-2">{@render when(at)}{#if tone && TONE_CLASS[tone]}<Chip {tone} text={tag} extra="shrink-0" />{:else}<span class="chip muted shrink-0">{tag}</span>{/if}<span class="min-w-0 whitespace-pre-wrap break-words">{text}</span></div>
{/snippet}

{#snippet result(r: NonNullable<Extract<Item, { kind: 'tool' }>['result']>)}
  <div class="mt-1">
    <div class="label text-[9px]">{$t('session.result')}</div>
    <pre class="whitespace-pre-wrap break-words border border-line-soft p-2 {r.isError ? 'text-bad' : ''}">{r.preview}</pre>
    {#if r.more}<details class="mt-1"><summary class="cursor-pointer text-muted">{$t('session.fullResult')}</summary><pre class="whitespace-pre-wrap break-words border border-line-soft p-2 {r.isError ? 'text-bad' : ''}">{r.full}</pre></details>{/if}
  </div>
{/snippet}

{#snippet item(it: Item)}
  {#if it.kind === 'text'}
    {@const prose = renderable(it.text, mdView.session)}
    <div class="flex items-start gap-2">{@render when(it.at)}{#if it.long}<details class="min-w-0"><summary class="cursor-pointer whitespace-pre-wrap break-words {it.tone === 'bad' ? 'text-bad' : it.tone ? 'text-muted' : ''}">{it.text.slice(0, 200)}…</summary>{#if prose}<div class="prose compact break-words">{@html md(it.text)}</div>{:else}<div class="whitespace-pre-wrap break-words">{it.text}</div>{/if}</details>{:else if prose}<div class="prose compact min-w-0 break-words {it.tone === 'bad' ? 'text-bad' : it.tone ? 'text-muted' : ''}">{@html md(it.text)}</div>{:else}<div class="min-w-0 whitespace-pre-wrap break-words {it.tone === 'bad' ? 'text-bad' : it.tone ? 'text-muted' : ''}">{it.text}</div>{/if}</div>
  {:else if it.kind === 'thinking'}
    <details class="text-muted"><summary class="cursor-pointer">{@render when(it.at)}{$t('session.thinkingItem')}</summary>{#if renderable(it.text, mdView.session)}<div class="prose compact break-words">{@html md(it.text)}</div>{:else}<div class="whitespace-pre-wrap break-words">{it.text}</div>{/if}</details>
  {:else if it.kind === 'tool'}
    <details class="border px-2 py-1 {it.tone === 'bad' ? 'border-bad' : 'border-line-soft'}">
      <summary class="cursor-pointer break-all">{@render when(it.at)}<span class="text-gleam">→ {it.name}</span> <span class="text-muted">{it.summary}</span>{#if it.task?.text} <span class="text-muted">· {it.task.text}</span>{/if}{#if it.result?.isError} <Chip tone="bad" text={$t('session.error')} />{/if}</summary>
      <div class="label mt-1 text-[9px]">{$t('session.input')}</div>
      <pre class="whitespace-pre-wrap break-words border border-line-soft p-2">{it.input}</pre>
      {#if it.result}{@render result(it.result)}{/if}
    </details>
  {:else if it.kind === 'subagent'}
    <details class="border border-info px-2 py-1">
      <summary class="cursor-pointer break-all">{@render when(it.at)}<Chip tone={it.known ? 'info' : 'muted'} text={it.role} /> <span>{it.description}</span>{#if it.task?.text} <span class="text-muted">· {it.task.text}</span>{/if}{#if it.hidden} <span class="text-muted">{$t('session.hiddenLines', { count: it.hidden })}</span>{/if}{#if it.result?.isError} <Chip tone="bad" text={$t('session.error')} />{/if}</summary>
      {#if it.prompt}
        <details class="mt-1">
          <summary class="cursor-pointer text-muted">{$t('session.prompt')}</summary>
          {#if renderable(it.prompt, mdView.session)}<div class="prose compact break-words border border-line-soft p-2">{@html md(it.prompt)}</div>{:else}<pre class="whitespace-pre-wrap break-words border border-line-soft p-2">{it.prompt}</pre>{/if}
        </details>
      {/if}
      {#if it.items.length}<div class="mt-1 flex flex-col gap-1 border-l border-info/40 pl-2">{#each it.items as child, i (i)}{@render item(child)}{/each}</div>{/if}
      {#if it.result}
        {#if renderable(it.result.full, mdView.session)}
          <div class="mt-1"><div class="label text-[9px]">{$t('session.result')}</div><div class="prose compact break-words border border-line-soft p-2 {it.result.isError ? 'text-bad' : ''}">{@html md(it.result.full)}</div></div>
        {:else}{@render result(it.result)}{/if}
      {/if}
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

<div class="flex flex-col gap-2">
  {#if transcript}
  <div class="flex flex-wrap items-center gap-2">
    <span role="note" class="plain min-w-0 break-all px-2 py-1 text-xs text-muted">{transcript.label}</span>
  </div>
  {:else}
  <div class="flex flex-wrap items-center gap-2">
    <span role="status" class="chip sm {TONE_CLASS[pill.tone]}" title={pill.title}>{pill.label}</span>
    <span class="text-xs text-muted">{$t('session.turns', { count: view.totals.turns })}</span>
    {#if view.totals.results}<span class="text-xs text-muted" title={$t('session.costTitle')}>{$t('session.cost', { cost: usd(view.totals.costUsd) })}</span>{/if}
    <span class="flex-1"></span>
    <label class="flex items-center gap-1.5 text-xs text-muted" title={modeHint[picked ?? mode.chosen] ?? ''}>
      {$t('session.modeLabel')}
      <select class="input sm" value={picked ?? mode.chosen} disabled={pending || S.data?.daemons?.enabled !== true} onchange={(e) => setMode(e.currentTarget.value)}>
        {#each PERMISSION_MODES as m (m)}<option value={m}>{modeName[m]}</option>{/each}
        {#if !PERMISSION_MODES.some((m) => m === mode.chosen)}<option value={mode.chosen} disabled>{mode.chosen}</option>{/if}
      </select>
    </label>
    {#if scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE}<EffortSelect job={scope} />{/if}
    {#if scope === INBOX_SCOPE}
      <button class="btn sm" disabled={!controls.canStart} title={$t('session.startHint')} onclick={() => act('start')}><Icon name="play" />{$t('session.startInbox')}</button>
      <button class="btn sm" disabled={!controls.canStop} onclick={() => act('stop')}><Icon name="stop" />{$t('session.stopInbox')}</button>
    {:else if scope === OFFICE_SCOPE}
      <button class="btn sm" disabled={!controls.canStart} title={$t('session.startHint')} onclick={() => act('start')}><Icon name="play" />{$t('session.startOffice')}</button>
      <button class="btn sm" disabled={!controls.canStop} onclick={() => act('stop')}><Icon name="stop" />{$t('session.stopOffice')}</button>
    {:else}
      <button class="btn sm" disabled={!controls.canStart} title={$t('session.startHint')} aria-label={$t('session.startJob')} onclick={() => act('start')}><Icon name="play" />{$t('session.start')}</button>
      <button class="btn sm" disabled={!controls.canStop} aria-label={$t('session.stopJob')} onclick={() => act('stop')}><Icon name="stop" />{$t('session.stop')}</button>
    {/if}
  </div>
  {#if session?.lastError}<div role="status" class="text-xs text-bad break-words">{session.lastError}</div>{/if}
  {#if mode.live !== null}<div role="status" class="text-xs text-muted">{$t('session.modeSwitching', { mode: modeName[mode.live] ?? mode.live })}</div>{/if}
  {#if mode.chosen === 'auto'}<div class="text-xs text-warn">{$t('session.modes.autoWarning')}</div>{/if}
  {/if}
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
    <input class="input sm min-w-0 flex-1 basis-40" type="search" placeholder={$t('session.filter')} aria-label={$t('session.filter')} bind:value={filters.text} />
    <label class="field"><input type="checkbox" class="check" bind:checked={filters.tools} />{$t('session.tools')}</label>
    <label class="field"><input type="checkbox" class="check" bind:checked={filters.thinking} />{$t('session.thinking')}</label>
    <label class="field"><input type="checkbox" class="check" bind:checked={filters.subagents} />{$t('session.subagents')}</label>
    <MarkdownToggle surface="session" />
    <button class="btn sm {follow ? 'sel' : ''}" aria-pressed={follow ? 'true' : 'false'} onclick={jump}>{$t('session.follow')}</button>
    {#if more}<button class="btn sm" onclick={() => log.loadOlder()}>{$t('session.loadOlder')}</button>{/if}
  </div>
  {#if error !== null}
    <Banner msg={error} />
  {:else if loading && !entries.length}
    <div class="text-sm text-muted">{$t('session.loading')}</div>
  {:else if !entries.length}
    {@const enabled = S.data?.daemons?.enabled === true}
    <Empty>{#if transcript}{$t('session.transcriptEmpty')}{:else if scope === INBOX_SCOPE}{enabled ? $t('session.emptyInboxEnabled') : $t('session.emptyInbox')}{:else if scope === OFFICE_SCOPE}{$t('session.emptyOffice')}{:else}{enabled ? $t('session.emptyEnabled') : $t('session.empty')}{/if}</Empty>
  {/if}
  {#if entries.length}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable from the keyboard) -->
    <div bind:this={pane} onscroll={onScroll} role="log" aria-live="off" aria-label={$t('session.label')} tabindex="0" class="plate flat mono px-2.5 pb-2.5 text-[11px] leading-5 {compact ? 'max-h-72' : 'max-h-[70vh]'} overflow-y-auto">
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
