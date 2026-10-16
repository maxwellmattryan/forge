<!-- The Foreman popover's body. On: a short identity block (and, with the daemon off, how to start it), the office's
     permission prompts, then the office session's live thread, the same SessionLog the drawer's Log tab uses, filling the
     chat-sized popover so its log pane is the one scroller. Off: what the Foreman is and how to turn it on by hand.
     foreman.enabled is locked in Settings and forge config set, so nothing here writes config. Session output is untrusted
     and renders through SessionLog's own rules. -->
<script lang="ts">
  import PermissionPrompts from '../PermissionPrompts.svelte';
  import SessionLog from '../SessionLog.svelte';
  import { OFFICE_SCOPE } from '../../lib/types.ts';
  import type { ForemanIndicator } from '../../lib/statusbar.ts';
  import { t } from '../../lib/locale.ts';

  let { foreman }: { foreman: ForemanIndicator } = $props();

  /** The config names a message points at, rendered as code: the message keeps them as {placeholders}. */
  const CODE: Record<string, string> = { '{key}': 'foreman.enabled: true', '{daemonKey}': 'daemon.enabled: true', '{file}': '.forge/config.yml' };
  const parts = (text: string): string[] => text.split(/(\{key\}|\{daemonKey\}|\{file\})/);
</script>

{#snippet howTo(text: string)}
  {#each parts(text) as part, i (i)}{#if Object.hasOwn(CODE, part)}<code class="mono">{CODE[part]}</code>{:else}{part}{/if}{/each}
{/snippet}

{#if foreman.on}
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <div class="flex shrink-0 flex-col items-start gap-1.5">
      <span class="chip sm foreman">{$t('statusbar.foreman.tag')}</span>
      <p class="text-sm text-muted">{$t('statusbar.foreman.about')}</p>
      {#if !foreman.daemon}<p class="text-sm text-muted">{@render howTo($t('statusbar.foreman.daemonOffHow'))}</p>{/if}
    </div>
    {#if foreman.prompts}<div class="max-h-[40%] shrink-0 overflow-y-auto"><PermissionPrompts scope={OFFICE_SCOPE} /></div>{/if}
    <div class="flex min-h-0 flex-1 flex-col border-t border-line pt-3"><SessionLog scope={OFFICE_SCOPE} fill /></div>
  </div>
{:else}
  <div class="flex flex-col items-start gap-2">
    <span class="chip sm foreman off">{$t('statusbar.foreman.tag')}</span>
    <p class="text-sm">{$t('statusbar.foreman.about')}</p>
    <p class="text-sm text-muted">{$t('statusbar.foreman.offTitle')} {$t('statusbar.foreman.offBody')}</p>
    <p class="text-sm text-muted">{@render howTo($t('statusbar.foreman.offHow'))}</p>
  </div>
{/if}
