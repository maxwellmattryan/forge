<!-- The issue-link gate's answers: link one of the candidates Forge found (issue-candidates.json), another issue by ref,
     a new issue, or none. Candidate titles are tracker text and render as text; their links go through safeUrl.
     With `approving` (an unlinked spec gate) each button also approves the spec: same request, approve-and-link wording.
     Create issue is primary only in the drawer's action dock (`dock`); elsewhere every gate action is a secondary. -->
<script lang="ts">
  import { api } from '../lib/util.ts';
  import { safeUrl } from '../lib/markdown.ts';
  import { cleanRef, parseCandidates, type Candidate } from '../lib/thread.ts';
  import { req } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  // `refId` keeps the ref field's id unique when the Needs-you card and the drawer show the same job.
  // `note` is bound so a send clears the gate's note box along with the ref field.
  let { id, refId, note = $bindable(''), approving = false, dock = false }: { id: string; refId: string; note?: string; approving?: boolean; dock?: boolean } = $props();

  let candidates = $state<Candidate[]>([]);
  let loaded = $state(false);
  let other = $state('');
  const otherRef = $derived(cleanRef(other));

  // Missing or invalid JSON leaves only the manual controls.
  $effect(() => {
    const job = id;
    candidates = [];
    loaded = false;
    api<string>(`/api/jobs/${encodeURIComponent(job)}/file?path=${encodeURIComponent('issue-candidates.json')}`)
      .then((text) => {
        if (job === id) candidates = parseCandidates(typeof text === 'string' ? text : JSON.stringify(text));
      })
      .catch(() => {})
      .finally(() => (loaded = true));
  });

  // Both fields clear as soon as the request goes, and come back only if it failed and nothing new was typed.
  function link(to: string): void {
    const text = note;
    const ref = other;
    const sending = req({ type: 'approve', job: id, note: text, args: { link: to } });
    if (!sending) return;
    note = '';
    other = '';
    sending.then((ok) => {
      if (ok) return;
      if (note === '') note = text;
      if (other === '') other = ref;
    });
  }
</script>

<div class="flex flex-col gap-2">
  <p class="text-sm">{approving ? $t('issueLink.promptSpec') : $t('issueLink.prompt')}</p>
  {#if candidates.length}
    <ul class="flex flex-col gap-1.5" aria-label={$t('issueLink.candidates')}>
      {#each candidates as c (c.ref)}
        {@const href = safeUrl(c.url)}
        <li class="plate flex items-center gap-2 px-3 py-2 text-sm min-w-0">
          <span class="font-mono text-muted shrink-0 max-w-[40%] truncate">{c.ref}</span>
          {#if href}<a class="min-w-0 flex-1 truncate text-gleam" {href} target="_blank" rel="noopener noreferrer" title={c.title}>{c.title}</a>{:else}<span class="min-w-0 flex-1 truncate" title={c.title}>{c.title}</span>{/if}
          <button class="btn sm shrink-0" aria-label={approving ? $t('issueLink.approveLinkRef', { ref: c.ref }) : $t('issueLink.linkRef', { ref: c.ref })} onclick={() => link(c.ref)}>{approving ? $t('issueLink.approveLink') : $t('issueLink.link')}</button>
        </li>
      {/each}
    </ul>
  {:else if loaded}
    <p class="text-sm text-muted">{$t('issueLink.noMatches')}</p>
  {/if}
  <div class="flex flex-wrap items-center gap-2">
    <label for={refId} class="text-xs text-muted">{$t('issueLink.otherRef')}</label>
    <input id={refId} type="text" class="min-w-0 max-w-full grow basis-80" autocomplete="off" placeholder={$t('issueLink.otherPlaceholder')} bind:value={other} />
    <button class="btn" disabled={!otherRef} onclick={() => otherRef && link(otherRef)}>{approving ? $t('issueLink.approveLink') : $t('issueLink.link')}</button>
  </div>
  <div class="flex flex-wrap gap-2">
    <button class="btn {dock ? 'primary' : ''}" onclick={() => link('new')}>{approving ? $t('issueLink.approveCreate') : $t('issueLink.create')}</button>
    <button class="btn" onclick={() => link('none')}>{approving ? $t('issueLink.approveNone') : $t('issueLink.none')}</button>
  </div>
</div>
