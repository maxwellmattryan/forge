<!-- Backlog: the tracker's ready items, with Start for unclaimed ones. -->
<script lang="ts">
  import Banner from '../components/Banner.svelte';
  import Empty from '../components/Empty.svelte';
  import Icon from '../components/Icon.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { safeUrl } from '../lib/markdown.ts';
  import { S, openDrawer, refreshBacklog, req } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  const b = $derived(S.backlog);
  const hash = (ref: string): string => (/^\d+$/.test(ref) ? '#' : '');
</script>

<PageHeader title={$t('backlog.title')}>
  {#snippet sub()}{#if b}{$t('backlog.from')} <Icon name={S.data?.config?.tracker === 'github' ? 'github' : 'tracker'} /><b>{b.tracker}</b> {$t('backlog.tracker')}{:else}{$t('common.loading')}{/if}{/snippet}
  {#snippet right()}<button class="btn" onclick={refreshBacklog}><Icon name="refresh" />{$t('backlog.refresh')}</button><button class="btn primary" onclick={() => req({ type: 'next' })}>{$t('common.runNext')}</button>{/snippet}
</PageHeader>
{#if b}
  {#if b.error}<Banner msg={b.error} />{/if}
  {#if !b.items?.length}
    <Empty>{$t('backlog.empty')}</Empty>
  {:else}
    <div class="plate flat"><div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>{$t('backlog.ref')}</th><th>{$t('backlog.itemTitle')}</th><th>{$t('backlog.status')}</th><th>{$t('backlog.priority')}</th><th>{$t('backlog.claimedBy')}</th><th></th></tr></thead>
        <tbody>
          {#each b.items as i, n (n)}
            {@const u = safeUrl(i.url)}
            <tr>
              <td class="font-mono text-xs">{#if u}<a href={u} target="_blank" rel="noopener" class="hover:text-gleam">{hash(i.ref)}{i.ref}</a>{:else}{i.ref}{/if}</td>
              <td>{i.title}<div class="flex flex-wrap gap-1 mt-1">{#each i.labels ?? [] as l, k (k)}<span class="chip muted">{l}</span>{/each}</div></td>
              <td>{i.status ?? '—'}</td>
              <td>{i.priority ?? '—'}</td>
              <td class="text-muted">{#if i.claimedBy}{@const by = i.claimedBy}<button class="hover:text-gleam" onclick={() => openDrawer(by)}>{by}</button>{:else}—{/if}</td>
              <td class="r">{#if !i.claimedBy && !['done', 'dropped'].includes(i.status ?? '')}<button class="btn" onclick={() => req({ type: 'run', ref: i.ref })}>{$t('backlog.start')}</button>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div></div>
  {/if}
{/if}
