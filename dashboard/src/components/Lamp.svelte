<!-- A pilot lamp (src/lib/station.ts LampState): decorative, so aria-hidden; the pill or text beside it carries the meaning.
     `relit`: it was just remounted by a stage change, so it comes back from dark. -->
<script lang="ts">
  import type { LampState } from '../lib/station.ts';

  let { state, relit = false }: { state: LampState; relit?: boolean } = $props();
  // Whole literals, so Tailwind sees every class.
  const CLASS: Record<LampState, string> = {
    working: 'lamp working',
    waiting: 'lamp waiting',
    you: 'lamp you',
    done: 'lamp done',
    idle: 'lamp idle',
    fault: 'lamp fault',
  };
</script>

<span class="{CLASS[state]} {relit ? 'relight' : ''}" aria-hidden="true"></span>
