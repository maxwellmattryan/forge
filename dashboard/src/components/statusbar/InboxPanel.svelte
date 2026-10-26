<!-- The Inbox popover's body: the inbox session, which handles requests that belong to no job. On: a caption and the
     session's pill, then, under a divider, the Inbox session log toggle (remembered under LOG_KEY) and the log itself. Off:
     the caption and a line saying the session runs inside the daemon, started from Workers. In both, a footer points at the
     Needs-you popover, where decisions and permission prompts wait; its button (StatusBar's openNeeds) replaces this
     popover with that one, anchored on the bell. Session output is untrusted and renders through SessionLog's own rules. -->
<script lang="ts">
  import Chip from '../Chip.svelte';
  import Icon from '../Icon.svelte';
  import SessionLog from '../SessionLog.svelte';
  import type { Pill, PoolModel } from '../../lib/daemon.ts';
  import { LOG_KEY } from '../../lib/daemon-log.ts';
  import { INBOX_SCOPE } from '../../lib/types.ts';
  import { t } from '../../lib/locale.ts';

  let { model, openNeeds }: { model: PoolModel | null; openNeeds: () => void } = $props();

  const readOpen = (): boolean => {
    try {
      return localStorage.getItem(LOG_KEY) === '1';
    } catch {
      return false;
    }
  };
  let inboxOpen = $state(readOpen());
  function toggleInbox(): void {
    inboxOpen = !inboxOpen;
    try {
      localStorage.setItem(LOG_KEY, inboxOpen ? '1' : '0');
    } catch {}
  }
</script>

{#snippet pill(p: Pill)}<Chip tone={p.tone} extra="sm shrink-0" title={p.title} text={p.label} />{/snippet}

<div class="flex flex-col gap-3">
  <div class="flex min-w-0 items-center gap-3">
    <span class="caption muted min-w-0 flex-1">{$t('statusbar.inbox.about')}</span>
    {#if model}{@render pill(model.inbox)}{/if}
  </div>
  {#if model}
    <div class="border-t border-line pt-3">
      <button class="btn sm" aria-expanded={inboxOpen ? 'true' : 'false'} onclick={toggleInbox}><Icon name="inbox" />{$t('statusbar.inbox.log')}</button>
      {#if inboxOpen}<div class="mt-3 border-t border-line pt-3"><SessionLog scope={INBOX_SCOPE} compact /></div>{/if}
    </div>
  {:else}
    <p class="text-sm text-muted">{$t('statusbar.inbox.off')}</p>
  {/if}
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
    <span class="caption muted min-w-0 flex-1">{$t('statusbar.inbox.needsNote')}</span>
    <button class="btn sm ghost" onclick={openNeeds}><Icon name="bell" />{$t('statusbar.inbox.openNeeds')}</button>
  </div>
</div>
