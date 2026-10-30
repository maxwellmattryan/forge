<!-- Issues: the tracker's items with their triage readiness, and Start for unclaimed ones (needs-info included: starting one
     overrides triage). A row opens its issue panel; the ref link, Claimed by and Start keep their own action. -->
<script lang="ts">
  import Banner from '../components/ui/feedback/Banner.svelte';
  import Chip from '../components/ui/Chip.svelte';
  import Empty from '../components/ui/feedback/Empty.svelte';
  import Icon from '../components/ui/Icon.svelte';
  import PageHeader from '../components/shell/PageHeader.svelte';
  import IssuesTableSkeleton from '../components/skeletons/project/IssuesTableSkeleton.svelte';
  import Skeleton from '../components/ui/feedback/Skeleton.svelte';
  import TriageMissing from '../components/drawer/TriageMissing.svelte';
  import { readiness } from '../lib/project/backlog.ts';
  import { canStart, refLabel } from '../lib/project/issue-view.ts';
  import { safeUrl } from '../lib/text/markdown.ts';
  import { S, openDrawer, openIssue, refreshBacklog, req } from '../lib/core/app.svelte.ts';
  import { t } from '../lib/text/locale.ts';

  const b = $derived(S.backlog);

  /** A click anywhere on the row: its title button takes focus first, so closing the panel hands focus back to it. */
  function rowOpen(e: MouseEvent & { currentTarget: HTMLTableRowElement }, ref: string): void {
    e.currentTarget.querySelector<HTMLButtonElement>('button[data-issue-open]')?.focus();
    void openIssue(ref);
  }
</script>

<PageHeader title={$t('issues.title')}>
  {#snippet sub()}{#if b}{$t('issues.from')} <Icon name={S.data?.config?.tracker === 'github' ? 'github' : 'tracker'} /><b>{b.tracker}</b> {$t('issues.tracker')}{:else}<Skeleton w="11rem" h="0.6875rem" class="inline-block" />{/if}{/snippet}
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
            <tr class="clickable" onclick={(e) => rowOpen(e, i.ref)}>
              <!-- stopPropagation on the row's own controls: each keeps its action and never opens the panel. -->
              <td class="font-mono text-xs">{#if u}<a href={u} target="_blank" rel="noopener" class="hover:text-gleam" onclick={(e) => e.stopPropagation()}>{refLabel(i.ref)}</a>{:else}{refLabel(i.ref)}{/if}</td>
              <!-- No handler of its own: its click (Enter and Space fire one too) bubbles to the row's rowOpen, which focuses the
                   button first, as Safari does not on a mouse click. -->
              <td><button data-issue-open class="text-left hover:text-gleam">{i.title}</button><div class="flex flex-wrap gap-1 mt-1">{#each i.labels ?? [] as l, k (k)}<Chip tone="muted" text={l} />{/each}</div></td>
              <td>{i.status ?? '—'}</td>
              <td>
                {#if readiness(i) === 'needs-info'}
                  <Chip tone="warn" text={$t('issues.needsInfo')} />
                  {#if i.triage?.missing?.length}<TriageMissing missing={i.triage.missing} />{/if}
                {:else if readiness(i) === 'ready'}
                  <Chip tone="ok" text={$t('issues.ready')} />
                {:else}—{/if}
              </td>
              <td>{i.priority ?? '—'}</td>
              <td class="text-muted">{#if i.claimedBy}{@const by = i.claimedBy}<button class="hover:text-gleam" onclick={(e) => { e.stopPropagation(); void openDrawer(by); }}>{by}</button>{:else}—{/if}</td>
              <td class="r">{#if canStart(i, null)}<button class="btn" onclick={(e) => { e.stopPropagation(); void req({ type: 'run', ref: i.ref }); }}>{$t('issues.start')}</button>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div></div>
  {/if}
{:else}
  <IssuesTableSkeleton />
{/if}
