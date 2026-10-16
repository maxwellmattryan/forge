<!-- The Inbox popover's body: the inbox session's pill and details, then every pending permission prompt in the pool,
     answered right here, then the Inbox log toggle (remembered under LOG_KEY). The pill title is session output,
     untrusted, and renders as text. -->
<script lang="ts">
  import Icon from '../Icon.svelte';
  import PermissionPrompts from '../PermissionPrompts.svelte';
  import SessionLog from '../SessionLog.svelte';
  import { TONE_CLASS } from '../../lib/util.ts';
  import { INBOX_SCOPE } from '../../lib/types.ts';
  import type { Pill } from '../../lib/daemon.ts';
  import { LOG_KEY } from '../../lib/daemon-log.ts';
  import { pendingPrompts } from '../../lib/permissions.ts';
  import { S } from '../../lib/app.svelte.ts';
  import { keepFocus } from '../../lib/popover.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let { inbox }: { inbox: Pill } = $props();
  // The same source PermissionPrompts reads, so the empty line shows exactly when it renders nothing.
  const prompts = $derived(pendingPrompts(S.data?.daemons ?? null).length);
  // An answered prompt unmounts with its buttons: focus back on the popover, not the body.
  $effect(() => {
    void prompts;
    keepFocus();
  });

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

<div class="flex flex-col gap-3">
  <div class="flex flex-col items-start gap-1.5">
    <span class="chip sm {TONE_CLASS[inbox.tone]}">{$t('daemon.inbox', { label: inbox.label })}</span>
    <p class="mono muted whitespace-pre-line break-words">{inbox.title}</p>
  </div>
  <div class="border-t border-line pt-3">
    {#if prompts}<PermissionPrompts />{:else}<p class="text-sm text-muted">{$t('statusbar.inbox.noPrompts')}</p>{/if}
  </div>
  <div class="border-t border-line pt-3">
    <button class="btn sm" aria-expanded={inboxOpen ? 'true' : 'false'} onclick={toggleInbox}><Icon name="inbox" />{$t('statusbar.daemon.inboxLog')}</button>
    {#if inboxOpen}<div class="mt-3 border-t border-line pt-3"><SessionLog scope={INBOX_SCOPE} compact /></div>{/if}
  </div>
</div>
