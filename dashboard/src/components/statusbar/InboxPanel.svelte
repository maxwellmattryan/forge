<!-- The Inbox popover's body: the inbox session's pill and details, then every pending permission prompt in the pool,
     answered right here. The pill title is session output, untrusted, and renders as text. -->
<script lang="ts">
  import PermissionPrompts from '../PermissionPrompts.svelte';
  import { TONE_CLASS } from '../../lib/util.ts';
  import type { Pill } from '../../lib/daemon.ts';
  import { pendingPrompts } from '../../lib/permissions.ts';
  import { S } from '../../lib/app.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let { inbox }: { inbox: Pill } = $props();
  // The same source PermissionPrompts reads, so the empty line shows exactly when it renders nothing.
  const prompts = $derived(pendingPrompts(S.data?.daemons ?? null).length);
</script>

<div class="flex flex-col gap-3">
  <div class="flex flex-col items-start gap-1.5">
    <span class="chip sm {TONE_CLASS[inbox.tone]}">{$t('daemon.inbox', { label: inbox.label })}</span>
    <p class="mono muted whitespace-pre-line break-words">{inbox.title}</p>
  </div>
  <div class="border-t border-line pt-3">
    {#if prompts}<PermissionPrompts />{:else}<p class="text-sm text-muted">{$t('statusbar.inbox.noPrompts')}</p>{/if}
  </div>
</div>
