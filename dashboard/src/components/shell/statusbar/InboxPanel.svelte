<!-- The Inbox popover's body: the inbox session, which handles requests that belong to no job. On: the session's log
     (controls included) and nothing else. Off: a line saying the session runs inside the daemon, started from Workers.
     Session output is untrusted and renders through SessionLog's own rules. -->
<script lang="ts">
  import SessionLog from '../../logs/SessionLog.svelte';
  import type { PoolModel } from '../../../lib/sessions/daemon.ts';
  import { INBOX_SCOPE } from '../../../lib/core/types.ts';
  import { t } from '../../../lib/text/locale.ts';

  let { model }: { model: PoolModel | null } = $props();
</script>

{#if model}
  <SessionLog scope={INBOX_SCOPE} compact />
{:else}
  <p class="text-sm text-muted">{$t('statusbar.inbox.off')}</p>
{/if}
