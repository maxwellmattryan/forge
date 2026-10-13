<!-- Backlog: the tracker's ready items, with Start for unclaimed ones. -->
<script lang="ts">
  import Banner from '../components/Banner.svelte';
  import Empty from '../components/Empty.svelte';
  import Icon from '../components/Icon.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { safeUrl } from '../lib/markdown.ts';
  import { S, openDrawer, refreshBacklog, req } from '../lib/app.svelte.ts';

  const b = $derived(S.backlog);
  const hash = (ref: string): string => (/^\d+$/.test(ref) ? '#' : '');
</script>

<PageHeader title="Backlog">
  {#snippet sub()}{#if b}From the <b>{b.tracker}</b> tracker{:else}Loading…{/if}{/snippet}
  {#snippet right()}<button class="btn" onclick={refreshBacklog}><Icon name="refresh" />Refresh</button><button class="btn btn-primary" onclick={() => req({ type: 'next' })}>Run next</button>{/snippet}
</PageHeader>
{#if b}
  {#if b.error}<Banner msg={b.error} />{/if}
  {#if !b.items?.length}
    <Empty>The backlog is empty.</Empty>
  {:else}
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>Ref</th><th>Title</th><th>Status</th><th>Priority</th><th>Claimed by</th><th></th></tr></thead>
        <tbody>
          {#each b.items as i, n (n)}
            {@const u = safeUrl(i.url)}
            <tr>
              <td class="font-mono text-xs">{#if u}<a href={u} target="_blank" rel="noopener" class="hover:text-accent">{hash(i.ref)}{i.ref}</a>{:else}{i.ref}{/if}</td>
              <td>{i.title}<div class="flex flex-wrap gap-1 mt-1">{#each i.labels ?? [] as l, k (k)}<span class="chip bg-raised text-muted">{l}</span>{/each}</div></td>
              <td>{i.status ?? '—'}</td>
              <td>{i.priority ?? '—'}</td>
              <td class="text-muted">{#if i.claimedBy}{@const by = i.claimedBy}<button class="hover:text-accent" onclick={() => openDrawer(by)}>{by}</button>{:else}—{/if}</td>
              <td class="text-right">{#if !i.claimedBy && !['done', 'dropped'].includes(i.status ?? '')}<button class="btn" onclick={() => req({ type: 'run', ref: i.ref })}>Start</button>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}
