<!-- The issue-link gate's answers: link one of the candidates Forge found (issue-candidates.json), another issue by ref,
     a new issue, or none. Candidate titles are tracker text and render as text; their links go through safeUrl. -->
<script lang="ts">
  import { api } from '../lib/util.ts';
  import { safeUrl } from '../lib/markdown.ts';
  import { cleanRef, parseCandidates, type Candidate } from '../lib/thread.ts';
  import { req } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  // `refId` keeps the ref field's id unique when the Needs-you card and the drawer show the same job.
  let { id, refId, note }: { id: string; refId: string; note: string } = $props();

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

  const link = (to: string): void => req({ type: 'approve', job: id, note, args: { link: to } });
</script>

<div class="flex flex-col gap-2">
  <p class="text-sm">{$t('issueLink.prompt')}</p>
  {#if candidates.length}
    <ul class="flex flex-col gap-1.5" aria-label={$t('issueLink.candidates')}>
      {#each candidates as c (c.ref)}
        {@const href = safeUrl(c.url)}
        <li class="sheet flex items-center gap-2 px-3 py-2 text-sm min-w-0">
          <span class="font-mono text-muted shrink-0 max-w-[40%] truncate">{c.ref}</span>
          {#if href}<a class="min-w-0 flex-1 truncate text-ink" {href} target="_blank" rel="noopener noreferrer" title={c.title}>{c.title}</a>{:else}<span class="min-w-0 flex-1 truncate" title={c.title}>{c.title}</span>{/if}
          <button class="btn sm shrink-0" aria-label={$t('issueLink.linkRef', { ref: c.ref })} onclick={() => link(c.ref)}>{$t('issueLink.link')}</button>
        </li>
      {/each}
    </ul>
  {:else if loaded}
    <p class="text-sm text-muted">{$t('issueLink.noMatches')}</p>
  {/if}
  <div class="flex flex-wrap items-center gap-2">
    <label for={refId} class="text-xs text-muted">{$t('issueLink.otherRef')}</label>
    <input id={refId} type="text" class="w-40" autocomplete="off" placeholder={$t('issueLink.otherPlaceholder')} bind:value={other} />
    <button class="btn sm" disabled={!otherRef} onclick={() => otherRef && link(otherRef)}>{$t('issueLink.link')}</button>
  </div>
  <div class="flex flex-wrap gap-2">
    <button class="btn primary" onclick={() => link('new')}>{$t('issueLink.create')}</button>
    <button class="btn" onclick={() => link('none')}>{$t('issueLink.none')}</button>
  </div>
</div>
