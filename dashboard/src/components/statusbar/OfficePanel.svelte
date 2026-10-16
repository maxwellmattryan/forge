<!-- The Office popover's body: the foreman's office session pill and details, what it does, then its session log with
     the same Start/Stop and permission-mode selector a job or the inbox has. Shown only while foreman.enabled. The pill
     title is session output, untrusted, and renders as text. -->
<script lang="ts">
  import SessionLog from '../SessionLog.svelte';
  import { TONE_CLASS } from '../../lib/util.ts';
  import { OFFICE_SCOPE } from '../../lib/types.ts';
  import type { Pill } from '../../lib/daemon.ts';
  import { t } from '../../lib/locale.ts';

  let { office }: { office: Pill } = $props();
</script>

<div class="flex flex-col gap-3">
  <div class="flex flex-col items-start gap-1.5">
    <span class="chip sm {TONE_CLASS[office.tone]}">{$t('statusbar.office.pill', { label: office.label })}</span>
    <p class="mono muted whitespace-pre-line break-words">{office.title}</p>
    <p class="text-sm text-muted">{$t('statusbar.office.about')}</p>
  </div>
  <div class="border-t border-line pt-3"><SessionLog scope={OFFICE_SCOPE} compact /></div>
</div>
