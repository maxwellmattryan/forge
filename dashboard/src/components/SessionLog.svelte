<!-- One session's structured log (a job's, or the inbox's in the daemon bar): status and Start/Stop, filters, and turns with
     tool calls and subagents, followed live. Every log string is untrusted session output and renders as text. -->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Banner from './Banner.svelte';
  import Chip from './Chip.svelte';
  import Empty from './Empty.svelte';
  import { TONE_CLASS, usd } from '../lib/util.ts';
  import { INBOX_SCOPE } from '../lib/types.ts';
  import type { DaemonSessionState } from '../lib/types.ts';
  import { buildSessionView, readFilters } from '../lib/session-log.ts';
  import type { Entry, Filters, Item } from '../lib/session-log.ts';
  import { createSessionLog } from '../lib/daemon-log.ts';
  import { mergeSessionState, postDaemon, sessionControls, sessionPill } from '../lib/daemon.ts';
  import { S, forgeToken, refresh } from '../lib/app.svelte.ts';
  import { pref } from '../lib/prefs.ts';
  import { toast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/locale.ts';

  let { scope, compact = false, active = true }: { scope: string; compact?: boolean; active?: boolean } = $props();

  // The stream's state frames are freshest; the 2 s /api/state poll covers the rest.
  let live = $state<Partial<DaemonSessionState> | null>(null);
  const polled = $derived(scope === INBOX_SCOPE ? (S.data?.daemons?.inbox ?? null) : (S.data?.daemons?.jobs?.[scope] ?? null));
  const session = $derived(live ?? polled);
  const poolWanted = $derived(S.data?.daemons?.wanted === true);
  let pending = $state(false);
  const pill = $derived(sessionPill(session));
  const controls = $derived(sessionControls(session, poolWanted, pending));

  let filters = $state<Filters>(readFilters(pref.get('sessionFilters', '')));
  $effect(() => pref.set('sessionFilters', JSON.stringify(filters)));

  // untrack: the log belongs to the scope it was created for; Drawer keys this component by job id.
  const log = untrack(() =>
    createSessionLog({
      scope,
      onState: (st) => (live = mergeSessionState(live, st)),
      onChange: () => {
        entries = log.entries.slice();
        more = log.more;
        closed = log.closed;
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
    untrack(() => log.sync(shown));
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
    follow = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 24;
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
</script>

<svelte:document onvisibilitychange={() => log.visibilityChanged()} />

{#snippet line(tone: string | null, tag: string, text: string)}
  <div class="flex items-start gap-2">{#if tone && TONE_CLASS[tone]}<Chip {tone} text={tag} extra="shrink-0" />{:else}<span class="chip shrink-0 text-muted">{tag}</span>{/if}<span class="min-w-0 whitespace-pre-wrap break-words">{text}</span></div>
{/snippet}

{#snippet result(r: NonNullable<Extract<Item, { kind: 'tool' }>['result']>)}
  <div class="mt-1">
    <div class="text-[10px] uppercase tracking-wide text-muted">{$t('session.result')}</div>
    <pre class="whitespace-pre-wrap break-words rounded bg-bg p-2 {r.isError ? 'text-bad' : ''}">{r.preview}</pre>
    {#if r.more}<details class="mt-1"><summary class="cursor-pointer text-muted">{$t('session.fullResult')}</summary><pre class="whitespace-pre-wrap break-words rounded bg-bg p-2 {r.isError ? 'text-bad' : ''}">{r.full}</pre></details>{/if}
  </div>
{/snippet}

{#snippet item(it: Item)}
  {#if it.kind === 'text'}
    {#if it.long}<details><summary class="cursor-pointer whitespace-pre-wrap break-words {it.tone === 'bad' ? 'text-bad' : it.tone ? 'text-muted' : ''}">{it.text.slice(0, 200)}…</summary><div class="whitespace-pre-wrap break-words">{it.text}</div></details>{:else}<div class="whitespace-pre-wrap break-words {it.tone === 'bad' ? 'text-bad' : it.tone ? 'text-muted' : ''}">{it.text}</div>{/if}
  {:else if it.kind === 'thinking'}
    <details class="text-muted"><summary class="cursor-pointer">{$t('session.thinkingItem')}</summary><div class="whitespace-pre-wrap break-words">{it.text}</div></details>
  {:else if it.kind === 'tool'}
    <details class="rounded border border-line/60 px-2 py-1 {it.tone === 'bad' ? 'border-bad/50' : ''}">
      <summary class="cursor-pointer break-all"><span class="text-accent">→ {it.name}</span> <span class="text-muted">{it.summary}</span>{#if it.result?.isError} <Chip tone="bad" text={$t('session.error')} />{/if}</summary>
      <div class="mt-1 text-[10px] uppercase tracking-wide text-muted">{$t('session.input')}</div>
      <pre class="whitespace-pre-wrap break-words rounded bg-bg p-2">{it.input}</pre>
      {#if it.result}{@render result(it.result)}{/if}
    </details>
  {:else if it.kind === 'subagent'}
    <details class="rounded border border-info/40 bg-info/5 px-2 py-1">
      <summary class="cursor-pointer break-all"><Chip tone={it.known ? 'info' : 'muted'} text={it.role} /> <span>{it.description}</span>{#if it.hidden} <span class="text-muted">{$t('session.hiddenLines', { count: it.hidden })}</span>{/if}{#if it.result?.isError} <Chip tone="bad" text={$t('session.error')} />{/if}</summary>
      {#if it.items.length}<div class="mt-1 flex flex-col gap-1 border-l border-info/40 pl-2">{#each it.items as child, i (i)}{@render item(child)}{/each}</div>{/if}
      {#if it.result}{@render result(it.result)}{/if}
    </details>
  {:else if it.kind === 'init'}
    {@render line('muted', 'init', [it.model, it.session].filter(Boolean).join(' · '))}
  {:else if it.kind === 'result'}
    {@render line(it.tone, 'result', it.text)}
  {:else if it.kind === 'supervisor'}
    {@render line(it.tone, 'daemon', it.text)}
  {:else}
    {@render line(it.tone, it.kind, it.text)}
  {/if}
{/snippet}

<div class="flex flex-col gap-2">
  <div class="flex flex-wrap items-center gap-2">
    <span class="chip {TONE_CLASS[pill.tone]}" title={pill.title}>{pill.label}</span>
    <span class="text-xs text-muted">{$t('session.turns', { count: view.totals.turns })}</span>
    {#if view.totals.results}<span class="text-xs text-muted" title={$t('session.costTitle')}>{$t('session.cost', { cost: usd(view.totals.costUsd) })}</span>{/if}
    <span class="flex-1"></span>
    <button class="btn text-xs" disabled={!controls.canStart} onclick={() => act('start')}>{$t('session.start')}</button>
    <button class="btn text-xs" disabled={!controls.canStop} onclick={() => act('stop')}>{$t('session.stop')}</button>
  </div>
  {#if session?.lastError}<div class="text-xs text-muted break-words">{session.lastError}</div>{/if}
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
    <input class="min-w-0 flex-1 basis-40 rounded-lg border border-line bg-raised px-2 py-1" type="search" placeholder={$t('session.filter')} aria-label={$t('session.filter')} bind:value={filters.text} />
    <label class="flex items-center gap-1"><input type="checkbox" bind:checked={filters.tools} />{$t('session.tools')}</label>
    <label class="flex items-center gap-1"><input type="checkbox" bind:checked={filters.thinking} />{$t('session.thinking')}</label>
    <label class="flex items-center gap-1"><input type="checkbox" bind:checked={filters.subagents} />{$t('session.subagents')}</label>
    <button class="btn text-xs" aria-pressed={follow ? 'true' : 'false'} onclick={jump}>{$t('session.follow')}</button>
    {#if more}<button class="btn text-xs" onclick={() => log.loadOlder()}>{$t('session.loadOlder')}</button>{/if}
  </div>
  {#if error !== null}
    <Banner msg={error} />
  {:else if loading && !entries.length}
    <div class="text-sm text-muted">{$t('session.loading')}</div>
  {:else if !entries.length}
    <Empty>{scope === INBOX_SCOPE ? $t('session.emptyInbox') : $t('session.empty')}</Empty>
  {/if}
  {#if entries.length}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable from the keyboard) -->
    <div bind:this={pane} onscroll={onScroll} role="log" aria-live="off" aria-label={$t('session.label')} tabindex="0" class="{compact ? 'max-h-72' : 'max-h-[70vh]'} overflow-y-auto rounded-lg bg-raised p-2 font-mono text-[11px] leading-5">
      {#if !view.turns.length}<div class="text-muted">{$t('session.noMatch')}</div>{/if}
      {#each view.turns as g (g.offset)}
        <section class="mb-2">
          <h3 class="sticky top-0 z-10 bg-raised py-0.5 text-[11px] font-semibold text-muted">{g.label}</h3>
          <div class="flex flex-col gap-1">{#each g.items as it, i (i)}{@render item(it)}{/each}</div>
        </section>
      {/each}
    </div>
  {/if}
  {#if closed}<div class="text-xs text-muted">{$t('session.closed')}</div>{/if}
</div>
