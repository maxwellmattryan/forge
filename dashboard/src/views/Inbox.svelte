<!-- Needs you: decisions only a human can make, PRs awaiting review, and queued requests. -->
<script lang="ts">
  import Empty from '../components/Empty.svelte';
  import InboxCard from '../components/InboxCard.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import PrChip from '../components/PrChip.svelte';
  import { safeUrl } from '../lib/markdown.ts';
  import { ago } from '../lib/util.ts';
  import type { ApiState } from '../lib/types.ts';
  import { inboxGroups } from '../lib/view.ts';
  import { openDrawer, req } from '../lib/app.svelte.ts';

  let { data }: { data: ApiState } = $props();
  const groups = $derived(inboxGroups(data.jobs));
  const reqs = $derived(data.requests ?? []);
</script>

<PageHeader title="Needs you">
  {#snippet sub()}Decisions only a human can make. Actions are queued for your orchestrator session.{/snippet}
</PageHeader>
{#if groups.urgent.length}
  <div class="flex flex-col gap-3">
    {#each groups.urgent as j (j.id)}<InboxCard job={j} />{/each}
  </div>
{:else}
  <Empty>Nothing is waiting on you.</Empty>
{/if}
{#if groups.prs.length}
  <h2 class="text-sm font-semibold mt-8 mb-3">Open PRs awaiting review</h2>
  <div class="card overflow-x-auto">
    <table class="tbl">
      <tbody>
        {#each groups.prs as j (j.id)}
          {@const u = safeUrl(j.pr?.url)}
          <tr>
            <td><button class="font-medium text-left hover:text-accent" onclick={() => openDrawer(j.id)}>{j.title}</button></td>
            <td><PrChip pr={j.pr} /></td>
            <td class="text-muted">{j.pr?.unresolvedThreads ? `${j.pr.unresolvedThreads} unresolved thread(s)` : 'no open threads'}{j.pr?.behindBy ? ` · ${j.pr.behindBy} behind` : ''}</td>
            <td class="text-right whitespace-nowrap">{#if u}<a class="btn" href={u} target="_blank" rel="noopener">Open PR</a>{/if} <button class="btn" onclick={() => req({ type: 'rework', job: j.id, fixedText: 'Address the PR feedback' })}>Address feedback</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
{#if reqs.length}
  <h2 class="text-sm font-semibold mt-8 mb-3">Queued requests</h2>
  <div class="card overflow-x-auto">
    <table class="tbl">
      <tbody>
        {#each reqs as r (r.id)}
          <tr>
            <td class="font-mono text-xs">{r.type}</td>
            <td>{r.job ?? ''}</td>
            <td class="text-muted">{r.text ?? ''}</td>
            <td class="text-muted whitespace-nowrap">{r.status === 'in-progress' ? `handling (${String(r.session ?? '').slice(0, 8)})` : 'queued'}</td>
            <td class="text-muted whitespace-nowrap">{ago(r.createdAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
