<!-- The owning session's lease as a chip ("lease live · renewed 6s ago"), toned by its liveness; nothing without a lease.
     The board card shows it after the agent line (AgentActivity), the job drawer among its header badges. The age reads
     the shared ticker. -->
<script lang="ts">
  import Chip from './Chip.svelte';
  import { ownerLiveness } from '../lib/sessions/agent-activity.ts';
  import { ticker } from '../lib/core/clock.svelte.ts';
  import type { OwnerStatus } from '../lib/core/types.ts';
  import { t } from '../lib/text/locale.ts';

  let { owner }: { owner: OwnerStatus | null | undefined } = $props();
  const live = $derived(ownerLiveness(owner, ticker.now));
</script>

{#if live.tone}<Chip tone={live.tone} text={$t('activity.owner', { status: live.status ?? '', age: live.age ?? '' })} extra="shrink-0" />{/if}
