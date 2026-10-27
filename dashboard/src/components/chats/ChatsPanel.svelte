<!-- The Foreman page's chats: the chat list beside the open chat (at lg and up; below, the list sits above it).
     The list is GET /api/chats: active chats, then the archived ones folded under their count, each in the server's
     order (newest updatedAt first), each row its title (or "Untitled chat") and how long ago it changed. New chat posts
     one, opens it and focuses its composer. The open chat is the per-project pref `chat`, kept while it is in the list
     (pickChat), and is mounted as {#key id}<ChatView>, so a switch remounts its log. The list loads on mount, after each
     create, rename, archive and send, and when the document becomes visible. A chat id that fails CHAT_ID is never
     listed, requested or opened. Titles are owner text and render as Svelte text. -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Banner from '../Banner.svelte';
  import Empty from '../Empty.svelte';
  import ChatView from './ChatView.svelte';
  import { createChat, isChatId, listChats, pickChat } from '../../lib/chats.ts';
  import { currentProject } from '../../lib/project.ts';
  import { pref } from '../../lib/prefs.ts';
  import type { Chat } from '../../lib/types.ts';
  import { ago } from '../../lib/util.ts';
  import { forgeToken } from '../../lib/app.svelte.ts';
  import { ticker } from '../../lib/clock.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let chats = $state.raw<Chat[] | null>(null);
  let loadError = $state<string | null>(null);
  let selected = $state<string | null>(null);
  let creating = $state(false);
  let view = $state<ChatView>();

  const active = $derived((chats ?? []).filter((c) => c.state === 'active'));
  const archived = $derived((chats ?? []).filter((c) => c.state === 'archived'));
  const open = $derived(chats?.find((c) => c.id === selected) ?? null);

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const absolute = (iso: string): string => new Date(iso).toLocaleString();

  /** GET /api/chats; the open chat stays while it is listed, else the saved one, the first active one or none. */
  async function load(): Promise<void> {
    const project = currentProject();
    try {
      const r = await listChats(forgeToken());
      if (currentProject() !== project) return;
      chats = (Array.isArray(r.chats) ? r.chats : []).filter((c) => isChatId(c.id));
      loadError = null;
      const next = pickChat(chats, selected ?? pref.get('chat', ''));
      if (next !== selected) select(next);
    } catch (e) {
      if (currentProject() === project) loadError = message(e);
    }
  }

  function select(id: string | null): void {
    selected = id;
    if (id !== null) pref.set('chat', id);
  }

  async function newChat(): Promise<void> {
    if (creating) return;
    creating = true;
    try {
      const { chat } = await createChat(forgeToken());
      await load();
      if (isChatId(chat?.id)) {
        select(chat.id);
        await tick();
        view?.focus();
      }
    } catch (e) {
      toast(message(e), true);
    } finally {
      creating = false;
    }
  }

  onMount(() => void load());
</script>

<svelte:document onvisibilitychange={() => document.visibilityState !== 'hidden' && void load()} />

{#snippet row(c: Chat)}
  <li>
    <button
      class="flex w-full min-w-0 flex-col items-start gap-0.5 border-l-2 px-3 py-2 text-left clickable focus-visible:-outline-offset-2 {c.id === selected ? 'border-gleam bg-raised' : 'border-transparent'}"
      aria-current={c.id === selected ? 'true' : undefined}
      onclick={() => select(c.id)}
    >
      <span class="w-full truncate text-sm {c.title ? 'text-fg' : 'text-muted'}" title={c.title ?? undefined}>{c.title ?? $t('foreman.chats.untitled')}</span>
      <time class="text-xs text-muted" datetime={c.updatedAt} title={absolute(c.updatedAt)}>{ago(c.updatedAt, ticker.now)}</time>
    </button>
  </li>
{/snippet}

{#snippet newButton(primary: boolean)}
  <button class="btn sm {primary ? 'primary' : ''}" disabled={creating} aria-busy={creating} onclick={newChat}>{$t('foreman.chats.new')}</button>
{/snippet}

{#if loadError}
  <div class="flex flex-wrap items-center gap-2">
    <div class="min-w-0 flex-1"><Banner msg={$t('foreman.chats.loadFailed', { error: loadError })} /></div>
    <button class="btn sm mb-4" onclick={load}>{$t('foreman.chats.retry')}</button>
  </div>
{/if}
{#if chats === null}
  {#if !loadError}<div class="plate w-fit px-3 py-1.5 text-sm text-muted">{$t('common.loading')}</div>{/if}
{:else if !chats.length}
  <Empty><p>{$t('foreman.chats.emptyTitle')}</p><p class="mt-1 text-xs">{$t('foreman.chats.emptyBody')}</p><div class="mt-3">{@render newButton(true)}</div></Empty>
{:else}
  <div class="flex flex-col gap-4 lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
    <nav class="plate flat flex min-w-0 flex-col" aria-label={$t('foreman.chats.list')}>
      <div class="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 class="h section">{$t('foreman.chats.list')}</h2>
        {@render newButton(true)}
      </div>
      <ul class="flex max-h-[40vh] flex-col overflow-y-auto lg:max-h-[70vh]">{#each active as c (c.id)}{@render row(c)}{/each}</ul>
      {#if archived.length}
        <details class="border-t border-line">
          <summary class="cursor-pointer px-3 py-2 text-sm text-muted">{$t('foreman.chats.archived', { count: archived.length })}</summary>
          <ul class="flex flex-col">{#each archived as c (c.id)}{@render row(c)}{/each}</ul>
        </details>
      {/if}
    </nav>
    <div class="min-w-0">
      {#if open}
        {#key open.id}<ChatView bind:this={view} chat={open} onchanged={load} />{/key}
      {:else}
        <p class="plate w-fit max-w-full px-3 py-1.5 text-sm text-muted">{$t('foreman.chats.pick')}</p>
      {/if}
    </div>
  </div>
{/if}
