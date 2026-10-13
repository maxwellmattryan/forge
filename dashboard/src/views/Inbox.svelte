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
  import { t } from '../lib/locale.ts';

  let { data }: { data: ApiState } = $props();
  const groups = $derived(inboxGroups(data.jobs));
  const reqs = $derived(data.requests ?? []);
</script>

<PageHeader title={$t('inbox.title')}>
  {#snippet sub()}{$t('inbox.sub')}{/snippet}
</PageHeader>
{#if groups.urgent.length}
  <div class="flex flex-col gap-3">
    {#each groups.urgent as j (j.id)}<InboxCard job={j} />{/each}
  </div>
{:else}
  <Empty>{$t('inbox.empty')}</Empty>
{/if}
{#if groups.prs.length}
  <h2 class="text-sm font-semibold mt-8 mb-3">{$t('inbox.prs')}</h2>
  <div class="card overflow-x-auto">
    <table class="tbl">
      <tbody>
        {#each groups.prs as j (j.id)}
          {@const u = safeUrl(j.pr?.url)}
          <tr>
            <td><button class="font-medium text-left hover:text-accent" onclick={() => openDrawer(j.id)}>{j.title}</button></td>
            <td><PrChip pr={j.pr} /></td>
            <td class="text-muted">{j.pr?.unresolvedThreads ? $t('inbox.threads', { count: j.pr.unresolvedThreads }) : $t('inbox.noThreads')}{j.pr?.behindBy ? $t('inbox.behind', { count: j.pr.behindBy }) : ''}</td>
            <td class="text-right whitespace-nowrap">{#if u}<a class="btn" href={u} target="_blank" rel="noopener">{$t('inbox.openPr')}</a>{/if} <button class="btn" onclick={() => req({ type: 'rework', job: j.id, fixedText: 'Address the PR feedback' })}>{$t('inbox.addressFeedback')}</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
{#if reqs.length}
  <h2 class="text-sm font-semibold mt-8 mb-3">{$t('inbox.queued')}</h2>
  <div class="card overflow-x-auto">
    <table class="tbl">
      <tbody>
        {#each reqs as r (r.id)}
          <tr>
            <td class="font-mono text-xs">{r.type}</td>
            <td>{r.job ?? ''}</td>
            <td class="text-muted">{r.text ?? ''}</td>
            <td class="text-muted whitespace-nowrap">{r.status === 'in-progress' ? $t('inbox.handling', { session: String(r.session ?? '').slice(0, 8) }) : $t('inbox.queuedStatus')}</td>
            <td class="text-muted whitespace-nowrap">{ago(r.createdAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
