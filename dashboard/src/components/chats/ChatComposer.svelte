<!-- The open chat's composer (chats/ChatView.svelte): a text area and Send. Enter sends, Shift+Enter adds a newline, and
     Enter during IME composition never sends. Send posts the text as typed, and is disabled while the trimmed text is
     empty, the text is over CHAT_MESSAGE_MAX (a counter shows past 90%; an always-mounted status region announces once,
     when the text crosses the cap, not on every keystroke after), a send is in flight, or the Foreman is replying.
     A sent message clears the box and keeps focus; a refused one keeps the text and shows the server's error under it.
     In place of the box: a note while the daemon is disabled in config, a note with Start daemon while it is stopped, and
     the archived note for an archived chat. It exports focus(), which the panel calls after New chat. -->
<script lang="ts">
  import { sendChatMessage } from '../../lib/office/chats.ts';
  import { postDaemon } from '../../lib/sessions/daemon.ts';
  import { CHAT_MESSAGE_MAX } from '../../lib/core/types.ts';
  import type { ChatDetail, DaemonSessionState } from '../../lib/core/types.ts';
  import { S, refresh } from '../../lib/core/app.svelte.ts';
  import { toast } from '../../lib/ui/overlay/toast.svelte.ts';
  import { t } from '../../lib/text/locale.ts';

  let {
    id,
    archived,
    session,
    onsent,
    onfailed,
  }: {
    id: string;
    archived: boolean;
    session: Partial<DaemonSessionState> | null;
    onsent: (detail: ChatDetail) => void;
    /** A refused send: the server may have logged an undelivered note, so the log fetches anyway. */
    onfailed: () => void;
  } = $props();

  /** The counter shows from here on. */
  const COUNTER_FROM = Math.round(CHAT_MESSAGE_MAX * 0.9);
  const uid = $props.id();
  let text = $state('');
  let sending = $state(false);
  let error = $state<string | null>(null);
  let starting = $state(false);
  let box = $state<HTMLTextAreaElement>();

  const daemons = $derived(S.data?.daemons ?? null);
  const replying = $derived(session?.status === 'busy' || session?.status === 'stopping');
  const over = $derived(text.length > CHAT_MESSAGE_MAX);
  const canSend = $derived(text.trim() !== '' && !over && !sending && !replying);

  export function focus(): void {
    box?.focus();
  }

  async function send(): Promise<void> {
    if (!canSend) return;
    sending = true;
    try {
      const detail = await sendChatMessage(id, text);
      text = '';
      error = null;
      onsent(detail);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      onfailed();
    } finally {
      sending = false;
    }
    box?.focus();
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    void send();
  }

  async function startDaemon(): Promise<void> {
    starting = true;
    try {
      await postDaemon('start');
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      starting = false;
    }
  }

  /** The config names the disabled note points at, rendered as code: the message keeps them as {placeholders}. */
  const CODE: Record<string, string> = { '{daemonKey}': 'daemon.enabled: true', '{file}': '.forge/config.yml' };
  const parts = (s: string): string[] => s.split(/(\{daemonKey\}|\{file\})/);
</script>

{#if archived}
  <p class="plate px-3 py-2 text-sm text-muted">{$t('foreman.chats.archivedNote')}</p>
{:else if !S.data}
  <p class="plate w-fit px-3 py-1.5 text-sm text-muted">{$t('common.loading')}</p>
{:else if daemons?.enabled !== true}
  <p class="plate px-3 py-2 text-sm text-muted">{#each parts($t('foreman.chats.daemonDisabled')) as part, i (i)}{#if Object.hasOwn(CODE, part)}<code class="mono">{CODE[part]}</code>{:else}{part}{/if}{/each}</p>
{:else if daemons.wanted !== true}
  <div class="plate flex flex-wrap items-center gap-3 px-3 py-2">
    <p class="min-w-0 flex-1 text-sm text-muted">{$t('foreman.chats.daemonStopped')}</p>
    <button class="btn sm primary" disabled={starting} aria-busy={starting} onclick={startDaemon}>{$t('foreman.chats.startDaemon')}</button>
  </div>
{:else}
  <form
    class="plate flex flex-col gap-2 p-3"
    onsubmit={(e) => {
      e.preventDefault();
      void send();
    }}
  >
    <label for="{uid}-text" class="sr-only">{$t('foreman.chats.message')}</label>
    <textarea
      id="{uid}-text"
      bind:this={box}
      bind:value={text}
      rows="3"
      class="w-full resize-y"
      placeholder={$t('foreman.chats.placeholder')}
      aria-invalid={over || error !== null ? 'true' : undefined}
      aria-describedby={error !== null ? `${uid}-error` : undefined}
      {onkeydown}
    ></textarea>
    <div class="flex flex-wrap items-center justify-end gap-3">
      {#if text.length > COUNTER_FROM}<span class="num text-xs {over ? 'text-bad' : 'text-muted'}">{$t('foreman.chats.counter', { count: text.length, max: CHAT_MESSAGE_MAX })}</span>{/if}
      <span role="status" class="sr-only">{over ? $t('foreman.chats.tooLong', { max: CHAT_MESSAGE_MAX }) : ''}</span>
      <button type="submit" class="btn sm primary" disabled={!canSend} aria-busy={sending}>{replying ? $t('foreman.chats.replying') : $t('foreman.chats.send')}</button>
    </div>
    {#if error !== null}<p id="{uid}-error" role="alert" class="text-sm text-bad break-words">{error}</p>{/if}
  </form>
{/if}
