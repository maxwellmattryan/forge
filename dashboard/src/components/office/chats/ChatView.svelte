<!-- One open chat (ChatsPanel keys it by id): ChatHeader, the log, the chat session's permission prompts, and
     ChatComposer. The log is one chronological pane, oldest at the top, in the station's screen: owner messages tagged as
     yours (the gleam `you` tag, never the ember "a person is needed" tone), not-delivered notes in the warn tone, and the
     Foreman's replies as LogItem rows, with forge CLI calls tagged as CLI actions. Every block and every top-level reply
     item has its time and a Copy button named for what it copies. It follows the newest entry while the pane is at the
     bottom, with Jump to latest when scrolled up. The log itself is not announced; one sr-only status region says when the
     Foreman starts replying (the session goes busy) and when it has replied (back to idle). The data is createChatLog (src/lib/logs/chat-log.ts):
     paged from the start, then caught up on each `line` of the chat's session stream; its `state` frames, GET
     /api/chats/<id> on mount, after a prompt is answered and every 15 s while the session works, and a send's reply drive
     the session state. Owner text renders only through md() or as text; session lines follow LogItem's rules. -->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Banner from '../../ui/feedback/Banner.svelte';
  import Chip from '../../ui/Chip.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import LogItem from '../../logs/LogItem.svelte';
  import PermissionPrompts from '../../sessions/PermissionPrompts.svelte';
  import ChatComposer from './ChatComposer.svelte';
  import ChatHeader from './ChatHeader.svelte';
  import { createChatLog } from '../../../lib/logs/chat-log.ts';
  import { buildChatView, cliAction, copyText, fetchChat, type ChatBlock, type ChatEntry } from '../../../lib/office/chats.ts';
  import { mergeSessionState } from '../../../lib/sessions/daemon.ts';
  import { md } from '../../../lib/text/markdown.ts';
  import { renderable } from '../../../lib/text/md-view.ts';
  import { mdView } from '../../../lib/text/md-view.svelte.ts';
  import { atBottom, MAX_ENTRIES } from '../../../lib/logs/session-log.ts';
  import type { Item } from '../../../lib/logs/session-parse.ts';
  import { chatScope } from '../../../lib/core/types.ts';
  import type { Chat, ChatDetail, DaemonSessionState } from '../../../lib/core/types.ts';
  import { clock } from '../../../lib/core/util.ts';
  import { toast } from '../../../lib/ui/overlay/toast.svelte.ts';
  import { t } from '../../../lib/text/locale.ts';

  let {
    chat,
    onchanged,
  }: {
    /** The chat as the list has it; its id is a checked chat id. */
    chat: Chat;
    /** The chat changed (a rename, an archive, a send): the list reloads. */
    onchanged: () => void;
  } = $props();

  // untrack: this view belongs to the chat it mounted for; the panel keys it by id.
  const id = untrack(() => chat.id);
  const scope = chatScope(id);
  /** The newer of the list's copy and the one a rename or archive answered with. */
  let answered = $state<Chat | null>(null);
  const current = $derived(answered && answered.updatedAt >= chat.updatedAt ? answered : chat);
  const archived = $derived(current.state === 'archived');

  let session = $state<Partial<DaemonSessionState> | null>(null);
  let entries = $state.raw<readonly ChatEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let closed = $state(false);
  let trimmed = $state(false);
  const blocks = $derived(buildChatView(entries));

  const log = createChatLog({
    id,
    onState: (st) => (session = mergeSessionState(session, st)),
    onChange: () => {
      entries = log.entries.slice();
      loading = log.loading;
      error = log.error;
      closed = log.closed;
      trimmed = log.trimmed;
    },
  });

  let disposed = false;
  /** GET /api/chats/<id>: the chat and its session's state. A failure leaves both as they were. */
  async function reread(): Promise<void> {
    try {
      const d = await fetchChat(id);
      if (disposed) return;
      answered = d.chat;
      session = d.session;
    } catch {}
  }

  $effect(() => {
    untrack(() => {
      void reread();
      log.sync(true);
    });
  });
  onDestroy(() => {
    disposed = true;
    log.dispose();
  });

  // A state frame can be missed (a reconnect, a hidden tab): re-read while the session works. Starting is a wanted
  // session that is not up yet.
  const working = $derived(session?.status === 'busy' || session?.status === 'stopping' || (session?.status === 'off' && session.wanted === true));
  $effect(() => {
    if (!working) return;
    const h = setInterval(() => {
      if (document.visibilityState !== 'hidden') void reread();
    }, 15_000);
    return () => clearInterval(h);
  });

  // What the sr-only status region says: the Foreman is replying while its session is busy, and replied once it is idle
  // again. The log stays unannounced; this is the one cue a screen-reader user gets after Send.
  let announcement = $state('');
  let wasBusy = false;
  $effect(() => {
    const status = session?.status;
    untrack(() => {
      if (status === 'busy') {
        announcement = $t('foreman.chats.replying');
        wasBusy = true;
      } else if (status === 'idle' && wasBusy) {
        announcement = $t('foreman.chats.replied');
        wasBusy = false;
      } else if (status === 'off') {
        announcement = '';
        wasBusy = false;
      }
    });
  });

  function onVisibility(): void {
    log.visibilityChanged();
    if (document.visibilityState !== 'hidden') void reread();
  }

  function changed(c: Chat): void {
    answered = c;
    onchanged();
  }

  function sent(d: ChatDetail): void {
    answered = d.chat;
    session = d.session;
    log.refresh();
    onchanged();
  }

  /** The Copy button's name: a screen reader's list of buttons says what each one copies. */
  function copyLabel(x: ChatBlock | Item): string {
    switch (x.kind) {
      case 'owner':
        return $t('foreman.chats.copyYours');
      case 'note':
        return $t('foreman.chats.copyNote');
      case 'text':
        return $t('foreman.chats.copyReply');
      case 'tool':
        return cliAction(x) ? $t('foreman.chats.copyCli') : $t('foreman.chats.copyTool');
      default:
        return $t('foreman.chats.copyEntry');
    }
  }

  async function copy(x: ChatBlock | Item): Promise<void> {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(copyText(x));
      toast($t('foreman.chats.copied'));
    } catch (err) {
      toast($t('foreman.chats.copyFailed', { error: err instanceof Error ? err.message : String(err) }), true);
    }
  }

  // ---------- follow ----------
  let pane = $state<HTMLDivElement>();
  let follow = $state(true);
  $effect.pre(() => {
    void blocks;
    if (!pane || !follow) return;
    const p = pane;
    tick().then(() => (p.scrollTop = p.scrollHeight));
  });
  function onScroll(): void {
    if (pane) follow = atBottom(pane.scrollHeight, pane.scrollTop, pane.clientHeight);
  }
  function jump(): void {
    follow = true;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }

  let composer = $state<ChatComposer>();
  /** Focuses the composer (after New chat), once it renders. */
  export function focus(): void {
    composer?.focus();
  }

  const TRIM_CMD = $derived(`forge chat show ${id}`);
</script>

<svelte:document onvisibilitychange={onVisibility} />

{#snippet copyButton(x: ChatBlock | Item)}
  <IconButton icon="copy" label={copyLabel(x)} ghost onclick={() => copy(x)} />
{/snippet}

{#snippet when(at: string)}
  <time datetime={at} title={at} class="log-time">{clock(at)}</time>
{/snippet}

<section class="flex min-w-0 flex-col gap-3" aria-label={current.title ?? $t('foreman.chats.untitled')}>
  <div class="plate px-4 py-3"><ChatHeader chat={current} {session} onchanged={changed} /></div>
  <div role="status" class="sr-only">{announcement}</div>
  {#if error !== null}<Banner msg={$t('foreman.chats.logFailed', { error })} />{/if}
  <div class="station flex flex-col gap-2">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable from the keyboard) -->
    <div bind:this={pane} onscroll={onScroll} role="log" aria-live="off" aria-label={$t('foreman.chats.logLabel')} tabindex="0" class="screen log-pane mono selectable min-h-48 max-h-[65vh] overscroll-contain px-2.5 pb-2.5 text-[13px] leading-5">
      {#if trimmed}<p class="pt-2 font-sans text-xs text-muted">{#each $t('foreman.chats.trimmed', { max: MAX_ENTRIES }).split('{cmd}') as part, i (i)}{#if i}<code class="mono">{TRIM_CMD}</code>{/if}{part}{/each}</p>{/if}
      {#if !entries.length}
        {#if loading}<p class="pt-2 font-sans text-sm text-muted">{$t('common.loading')}</p>
        {:else if error === null}<p class="pt-2 font-sans text-sm text-muted">{$t('foreman.chats.logEmpty')}</p>{/if}
      {/if}
      {#each blocks as b (b.n)}
        {#if b.kind === 'owner'}
          <!-- The owner's message opens each exchange: a rule above it, and the `you` tag in the tag column. -->
          <div class="mt-2 flex items-start gap-1 border-t border-line-soft pt-2 first:mt-0 first:border-t-0">
            <div class="log-row min-w-0 flex-1 font-sans py-0.5">
              {@render when(b.at)}<span class="log-tag"><Chip tone="gleam" extra="max-w-full" text={$t('foreman.chats.you')} /></span>
              {#if renderable(b.text, mdView.chat)}<div class="log-body prose break-words text-fg [&>:first-child]:mt-0 [&>:last-child]:mb-0">{@html md(b.text)}</div>{:else}<div class="log-body whitespace-pre-wrap break-words text-fg">{b.text}</div>{/if}
            </div>
            {@render copyButton(b)}
          </div>
        {:else if b.kind === 'note'}
          <div class="flex items-start gap-1">
            <div class="log-row min-w-0 flex-1 py-0.5">
              {@render when(b.at)}<span class="log-tag"><Chip tone="warn" extra="max-w-full" text={$t('foreman.chats.undelivered')} /></span><span class="log-body whitespace-pre-wrap break-words text-warn">{b.reason}</span>
            </div>
            {@render copyButton(b)}
          </div>
        {:else}
          <div class="mt-1 flex flex-col gap-1">
            {#each b.items as it, i (i)}
              <div class="flex items-start gap-1">
                <div class="min-w-0 flex-1"><LogItem {it} view={mdView.chat} cli arrived={(n) => log.arrivedAt(n)} /></div>
                {@render copyButton(it)}
              </div>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
    {#if !follow}<button class="btn sm self-end" onclick={jump}>{$t('foreman.chats.jump')}</button>{/if}
    {#if closed}<div role="status" class="text-xs text-muted">{$t('session.closed')}</div>{/if}
  </div>
  <PermissionPrompts {scope} {session} name={$t('foreman.chats.thisChat')} onanswered={reread} />
  <ChatComposer bind:this={composer} {id} {archived} {session} onsent={sent} onfailed={() => log.refresh()} />
</section>
