<!-- The Connection popover's body: what the last /api/state poll said, both API versions, when data last arrived, the
     error when offline or outdated, and Retry now. The error text names the server's reply and renders as text. -->
<script lang="ts">
  import Icon from '../../ui/Icon.svelte';
  import { S, refresh } from '../../../lib/core/app.svelte.ts';
  import { ticker } from '../../../lib/core/clock.svelte.ts';
  import { API_VERSION } from '../../../lib/core/types.ts';
  import { ago } from '../../../lib/core/util.ts';
  import type { ConnectionState } from '../../../lib/shell/statusbar.ts';
  import { t } from '../../../lib/text/locale.ts';

  let { status }: { status: ConnectionState } = $props();
  let pending = $state(false);

  // Never disabled while it runs: a disabled button would drop keyboard focus to the body.
  async function retry(): Promise<void> {
    if (pending) return;
    pending = true;
    await refresh();
    pending = false;
  }
</script>

<div class="flex flex-col gap-3">
  <p class="text-sm text-fg">
    {#if status === 'connecting'}{$t('statusbar.conn.connectingText')}{:else if status === 'offline'}{$t('statusbar.conn.offlineText')}{:else if status === 'outdated'}{$t('statusbar.conn.outdatedText')}{:else}{$t('statusbar.conn.liveText')}{/if}
  </p>
  <div class="mono muted flex flex-col gap-0.5">
    {#if S.data}<div>{$t('statusbar.conn.server', { forge: S.data.forgeVersion, api: S.data.apiVersion })}</div>{/if}
    <div>{$t('statusbar.conn.client', { api: API_VERSION })}</div>
    <div>{S.polledAt ? $t('statusbar.conn.last', { ago: ago(S.polledAt, ticker.now) }) : $t('statusbar.conn.never')}</div>
  </div>
  {#if (status === 'offline' || status === 'outdated') && S.error}<p class="text-sm text-bad break-words">{S.error}</p>{/if}
  <div><button class="btn sm" aria-busy={pending} onclick={retry}><Icon name="refresh" />{$t('statusbar.conn.retry')}</button></div>
</div>
