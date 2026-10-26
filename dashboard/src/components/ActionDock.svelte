<!-- The job drawer's action dock: this job's permission prompts, Resume and the gate's actions, pinned under the
     scrolling body. It lives outside the Files / Timeline / Thread tabs so a one-click decision never needs a scroll or
     a tab switch, and renders nothing when the job needs no one. Prompt text is untrusted and PermissionPrompts renders
     it as plain text. -->
<script lang="ts">
  import JobActions from './JobActions.svelte';
  import PermissionPrompts from './PermissionPrompts.svelte';
  import { dockModel } from '../lib/dock.ts';
  import { decisionInFlight } from '../lib/decision.ts';
  import { ago } from '../lib/util.ts';
  import { S, req } from '../lib/app.svelte.ts';
  import type { JobDetail } from '../lib/types.ts';
  import { t } from '../lib/locale.ts';

  let { job }: { job: JobDetail['job'] } = $props();
  const m = $derived(dockModel(job, S.data?.daemons ?? null));
  // A decision in flight (its status line is JobActions'; Resume keeps its toast): Resume waits for it rather than racing it.
  const flight = $derived(decisionInFlight(job.id, S.sent[job.id], S.data?.requests));
</script>

{#if m.show}
  <section aria-labelledby="dock-heading-{job.id}" class="shrink-0 border-t border-line bg-panel max-h-[45dvh] overflow-y-auto overscroll-contain px-5 py-4 md:px-6 flex flex-col gap-3">
    <h3 id="dock-heading-{job.id}" class="label callout">{$t('dock.label')}</h3>
    <PermissionPrompts scope={job.id} />
    {#if m.resume.show}
      {@const r = m.resume}
      {@const o = job.ownerStatus}
      {@const values = { session: o?.session ?? '', since: ago(o?.since), renewed: ago(o?.renewedAt), expired: ago(o?.expiresAt) }}
      <div class="flex flex-wrap items-center gap-2">
        <button class="btn primary" disabled={!r.enabled || !!flight} aria-describedby={r.note ? `dock-owner-note-${job.id}` : undefined} onclick={() => req({ type: 'resume', job: job.id })}>{$t('drawer.resume')}</button>
        {#if r.note}<span id="dock-owner-note-{job.id}" class="min-w-0 text-sm text-muted wrap-anywhere">{r.note === 'live' ? $t('drawer.ownerLive', values) : $t('drawer.ownerExpired', values)}</span>{/if}
      </div>
    {/if}
    {#if m.actionable}{#key job.id}<JobActions {job} noteId="dock-note-{job.id}" />{/key}{/if}
  </section>
{/if}
