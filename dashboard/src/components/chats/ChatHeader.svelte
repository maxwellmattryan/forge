<!-- The open chat's header (chats/ChatView.svelte): its title (or "Untitled chat"), its session's status pill, the chat
     Rendered/Raw toggle, and Rename and Archive. Rename swaps the title for an input (Enter or Save posts the trimmed
     title, an empty one as null; Escape or Cancel restores it; focus returns to Rename either way). Archive asks first,
     in place, then posts. An archived chat shows an archived chip and neither button. Focus never falls to the page: a
     saved rename returns it to Rename (a refused one to the input), a refused archive to the confirm button, and an
     archive that went through to the heading, since the buttons are gone. The title is owner text and renders as
     Svelte text. -->
<script lang="ts">
  import { tick } from 'svelte';
  import Chip from '../Chip.svelte';
  import MarkdownToggle from '../MarkdownToggle.svelte';
  import { archiveChat, renameChat } from '../../lib/chats.ts';
  import { sessionPill } from '../../lib/daemon.ts';
  import type { Chat, DaemonSessionState } from '../../lib/types.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let {
    chat,
    session,
    onchanged,
  }: {
    chat: Chat;
    session: Partial<DaemonSessionState> | null;
    /** The chat the server answered a rename or archive with. */
    onchanged: (chat: Chat) => void;
  } = $props();

  /** The server keeps a title to 120 characters, one line. */
  const TITLE_MAX = 120;
  const archived = $derived(chat.state === 'archived');
  const pill = $derived(sessionPill(session));

  let renaming = $state(false);
  let draft = $state('');
  let confirming = $state(false);
  let busy = $state(false);
  let renameButton = $state<HTMLButtonElement>();
  let archiveButton = $state<HTMLButtonElement>();
  let input = $state<HTMLInputElement>();
  let cancelButton = $state<HTMLButtonElement>();
  let confirmButton = $state<HTMLButtonElement>();
  let heading = $state<HTMLHeadingElement>();

  const fail = (err: unknown): void => toast(err instanceof Error ? err.message : String(err), true);

  async function startRename(): Promise<void> {
    draft = chat.title ?? '';
    renaming = true;
    await tick();
    input?.focus();
    input?.select();
  }

  async function endRename(): Promise<void> {
    renaming = false;
    await tick();
    renameButton?.focus();
  }

  // Focus moves after `busy` clears: a disabled control takes no focus, and disabling the focused one blurs it.
  async function save(): Promise<void> {
    if (busy) return;
    busy = true;
    let saved = false;
    try {
      onchanged((await renameChat(chat.id, draft)).chat);
      saved = true;
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
    if (saved) {
      await endRename();
    } else {
      await tick();
      input?.focus();
    }
  }

  async function openConfirm(): Promise<void> {
    confirming = true;
    await tick();
    cancelButton?.focus();
  }

  async function cancelConfirm(): Promise<void> {
    confirming = false;
    await tick();
    archiveButton?.focus();
  }

  async function archive(): Promise<void> {
    if (busy) return;
    busy = true;
    let done = false;
    try {
      onchanged((await archiveChat(chat.id)).chat);
      confirming = false;
      done = true;
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
    await tick();
    (done ? heading : confirmButton)?.focus();
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex flex-wrap items-center gap-x-2 gap-y-2">
    {#if renaming}
      <form
        class="flex min-w-0 flex-[1_1_16rem] flex-wrap items-center gap-2"
        onsubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          bind:this={input}
          bind:value={draft}
          type="text"
          class="min-w-0 flex-[1_1_12rem]"
          maxlength={TITLE_MAX}
          aria-label={$t('foreman.chats.titleLabel')}
          disabled={busy}
          onkeydown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            void endRename();
          }}
        />
        <button type="submit" class="btn sm primary" disabled={busy} aria-busy={busy}>{$t('foreman.chats.save')}</button>
        <button type="button" class="btn sm" disabled={busy} onclick={endRename}>{$t('foreman.chats.cancel')}</button>
      </form>
    {:else}
      <h2 bind:this={heading} tabindex="-1" class="h card min-w-0 flex-[1_1_12rem] break-words {chat.title ? '' : 'text-muted'}">{chat.title ?? $t('foreman.chats.untitled')}</h2>
    {/if}
    <!-- Two groups, so that on a phone the wrap falls between them (state and toggle, then the buttons) and not inside one. -->
    <div class="ml-auto flex flex-wrap items-center justify-end gap-1.5 max-sm:w-full max-sm:justify-start">
      <div class="flex flex-wrap items-center gap-1.5">
        {#if archived}<Chip tone="muted" text={$t('foreman.chats.archivedChip')} />{/if}
        <Chip tone={pill.tone} title={pill.title} text={pill.label} />
        <MarkdownToggle surface="chat" />
      </div>
      {#if !archived}
        <div class="flex items-center gap-1.5">
          {#if !renaming}<button bind:this={renameButton} class="btn sm" disabled={busy || confirming} onclick={startRename}>{$t('foreman.chats.rename')}</button>{/if}
          {#if !confirming}<button bind:this={archiveButton} class="btn sm" disabled={busy || renaming} onclick={openConfirm}>{$t('foreman.chats.archive')}</button>{/if}
        </div>
      {/if}
    </div>
  </div>
  {#if confirming && !archived}
    <div class="plain border border-line-soft flex flex-col gap-2 p-3">
      <p class="text-[13px]">{$t('foreman.chats.archiveConfirm')}</p>
      <div class="flex flex-wrap gap-2">
        <button bind:this={confirmButton} class="btn sm text-bad" disabled={busy} aria-busy={busy} onclick={archive}>{$t('foreman.chats.archive')}</button>
        <button bind:this={cancelButton} class="btn sm" disabled={busy} onclick={cancelConfirm}>{$t('foreman.chats.cancel')}</button>
      </div>
    </div>
  {/if}
</div>
