<!-- Issues: the tracker's items with their triage readiness, and Start for unclaimed ones (needs-info included: starting one overrides triage). -->
<script lang="ts">
  import Banner from '../components/Banner.svelte';
  import Chip from '../components/Chip.svelte';
  import Empty from '../components/Empty.svelte';
  import Icon from '../components/Icon.svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import { readiness } from '../lib/backlog.ts';
  import { safeUrl } from '../lib/markdown.ts';
  import { S, openDrawer, refreshBacklog, req } from '../lib/app.svelte.ts';
  import { t } from '../lib/locale.ts';

  const b = $derived(S.backlog);
  const hash = (ref: string): string => (/^\d+$/.test(ref) ? '#' : '');
</script>

<PageHeader title={$t('issues.title')}>
  {#snippet sub()}{#if b}{$t('issues.from')} <Icon name={S.data?.config?.tracker === 'github' ? 'github' : 'tracker'} /><b>{b.tracker}</b> {$t('issues.tracker')}{:else}{$t('common.loading')}{/if}{/snippet}
  {#snippet right()}<button class="btn" onclick={refreshBacklog}><Icon name="refresh" />{$t('issues.refresh')}</button><button class="btn primary" onclick={() => req({ type: 'next' })}>{$t('common.runNext')}</button>{/snippet}
</PageHeader>
{#if b}
  {#if b.error}<Banner msg={b.error} />{/if}
  {#if !b.items?.length}
    <Empty>{$t('issues.empty')}</Empty>
  {:else}
    <div class="plate flat"><div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>{$t('issues.ref')}</th><th>{$t('issues.itemTitle')}</th><th>{$t('issues.status')}</th><th>{$t('issues.readiness')}</th><th>{$t('issues.priority')}</th><th>{$t('issues.claimedBy')}</th><th></th></tr></thead>
        <tbody>
          {#each b.items as i, n (n)}
            {@const u = safeUrl(i.url)}
            <tr>
              <td class="font-mono text-xs">{#if u}<a href={u} target="_blank" rel="noopener" class="hover:text-gleam">{hash(i.ref)}{i.ref}</a>{:else}{i.ref}{/if}</td>
              <td>{i.title}<div class="flex flex-wrap gap-1 mt-1">{#each i.labels ?? [] as l, k (k)}<Chip tone="muted" text={l} />{/each}</div></td>
              <td>{i.status ?? '—'}</td>
              <td>
                {#if readiness(i) === 'needs-info'}
                  <Chip tone="warn" text={$t('issues.needsInfo')} />
                  {#if i.triage?.missing?.length}<div class="text-xs text-muted mt-1">{$t('issues.missingLabel')} {#each i.triage.missing as k, m (k)}{#if m}{', '}{/if}{#if k === 'outcome'}{$t('issues.missing.outcome')}{:else if k === 'acceptance'}{$t('issues.missing.acceptance')}{:else if k === 'scope'}{$t('issues.missing.scope')}{:else if k === 'duplicate'}{$t('issues.missing.duplicate')}{:else if k === 'hidden-text'}{$t('issues.missing.hiddenText')}{/if}{/each}</div>{/if}
                {:else if readiness(i) === 'ready'}
                  <Chip tone="ok" text={$t('issues.ready')} />
                {:else}—{/if}
              </td>
              <td>{i.priority ?? '—'}</td>
              <td class="text-muted">{#if i.claimedBy}{@const by = i.claimedBy}<button class="hover:text-gleam" onclick={() => openDrawer(by)}>{by}</button>{:else}—{/if}</td>
              <td class="r">{#if !i.claimedBy && !['done', 'dropped'].includes(i.status ?? '')}<button class="btn" onclick={() => req({ type: 'run', ref: i.ref })}>{$t('issues.start')}</button>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div></div>
  {/if}
{/if}
