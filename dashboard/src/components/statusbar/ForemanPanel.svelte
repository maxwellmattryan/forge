<!-- The Foreman popover's body. On: a short identity block (and, with the daemon off, how to start it), the permission
     prompts of the office and of each assistant foreman that has some, stacked in scope order and each named by the session
     that asked (the Select's label), then one session's live
     thread, the same SessionLog the drawer's Log tab uses, filling the chat-sized popover so its log pane is the one
     scroller. With assistant foremen, a Select above the log picks whose: the office's or an assistant's (the first by
     default, since gate work happens there). Off: what the Foreman is and how to turn it on by hand. foreman.enabled is
     locked in Settings and forge config set, so nothing here writes config. Both states end their identity block with
     Open chat, which lands on the Foreman page's Chats tab (chats don't need foreman.enabled) and closes the popover.
     Session output is untrusted and renders through SessionLog's own rules. -->
<script lang="ts">
  import Chip from '../Chip.svelte';
  import Icon from '../Icon.svelte';
  import PermissionPrompts from '../PermissionPrompts.svelte';
  import Select from '../Select.svelte';
  import SessionLog from '../SessionLog.svelte';
  import { OFFICE_SCOPE, assistantNumber } from '../../lib/types.ts';
  import type { SelectOption } from '../../lib/select.ts';
  import type { ForemanIndicator } from '../../lib/statusbar.ts';
  import { pendingPrompts } from '../../lib/permissions.ts';
  import { S } from '../../lib/app.svelte.ts';
  import { closePopover } from '../../lib/popover.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let { foreman }: { foreman: ForemanIndicator } = $props();

  const assistants = $derived(foreman.on ? foreman.assistants : []);
  const promptScopes = $derived([OFFICE_SCOPE, ...assistants].filter((s) => pendingPrompts(S.data?.daemons ?? null, s).length));
  const logOptions = $derived<SelectOption[]>([
    { value: OFFICE_SCOPE, label: $t('statusbar.foreman.officeLog') },
    ...assistants.map((a) => ({ value: a, label: $t('statusbar.foreman.assistant', { n: assistantNumber(a) }) })),
  ]);
  /** The log the human picked; null follows the default, the first assistant foreman (or the office with none). */
  let picked = $state<string | null>(null);
  const selected = $derived(picked !== null && logOptions.some((o) => o.value === picked) ? picked : (assistants[0] ?? OFFICE_SCOPE));

  /** The config names a message points at, rendered as code: the message keeps them as {placeholders}. */
  const CODE: Record<string, string> = { '{key}': 'foreman.enabled: true', '{daemonKey}': 'daemon.enabled: true', '{file}': '.forge/config.yml' };
  const parts = (text: string): string[] => text.split(/(\{key\}|\{daemonKey\}|\{file\})/);
</script>

{#snippet howTo(text: string)}
  {#each parts(text) as part, i (i)}{#if Object.hasOwn(CODE, part)}<code class="mono">{CODE[part]}</code>{:else}{part}{/if}{/each}
{/snippet}

<!-- The hash may already be the Foreman page's, so the click sets the tab itself rather than leaving it to the route. -->
{#snippet openChat()}
  {#if S.selected}
    <a
      class="btn sm"
      href="#/p/{S.selected}/foreman"
      onclick={() => {
        S.foremanPanel = 'chats';
        closePopover('navigate');
      }}><Icon name="foreman" />{$t('statusbar.foreman.openChat')}</a
    >
  {/if}
{/snippet}

{#if foreman.on}
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <div class="flex shrink-0 flex-col items-start gap-1.5">
      <Chip extra="sm foreman" text={$t('statusbar.foreman.tag')} />
      <p class="text-sm text-muted">{$t('statusbar.foreman.about')}</p>
      {#if !foreman.daemon}<p class="text-sm text-muted">{@render howTo($t('statusbar.foreman.daemonOffHow'))}</p>{/if}
      {@render openChat()}
    </div>
    {#if foreman.prompts}
      <div class="flex max-h-[40%] shrink-0 flex-col gap-2 overflow-y-auto">
        {#each promptScopes as scope (scope)}<PermissionPrompts {scope} name={logOptions.find((o) => o.value === scope)?.label} />{/each}
      </div>
    {/if}
    <div class="flex min-h-0 flex-1 flex-col gap-2 border-t border-line pt-3">
      {#if assistants.length}
        <Select class="self-start" label={$t('statusbar.foreman.logLabel')} value={selected} options={logOptions} onchange={(v) => (picked = v)} />
      {/if}
      {#key selected}<SessionLog scope={selected} fill />{/key}
    </div>
  </div>
{:else}
  <div class="flex flex-col items-start gap-2">
    <Chip extra="sm foreman off" text={$t('statusbar.foreman.tag')} />
    <p class="text-sm">{$t('statusbar.foreman.about')}</p>
    <p class="text-sm text-muted">{$t('statusbar.foreman.offTitle')} {$t('statusbar.foreman.offBody')}</p>
    <p class="text-sm text-muted">{@render howTo($t('statusbar.foreman.offHow'))}</p>
    {@render openChat()}
  </div>
{/if}
