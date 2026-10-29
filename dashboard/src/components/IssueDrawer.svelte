<!-- The issue panel, inside the drawer's shell (DrawerShell.svelte, shared with the job panel): an Issues item's text and
     facts beside the Forge work on it. The header and the Forge section render at once from the backlog row and
     /api/state (polled every 2 s, so the holding job's card stays live); the description and comments come from
     GET /api/backlog/item, fetched on open and on Back. Issue text is outside text: it renders only through md(). -->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import Banner from './Banner.svelte';
  import Chip from './Chip.svelte';
  import CloseButton from './CloseButton.svelte';
  import Icon from './Icon.svelte';
  import JobCard from './JobCard.svelte';
  import PrChip from './PrChip.svelte';
  import Skeleton from './Skeleton.svelte';
  import StateChip from './StateChip.svelte';
  import TriageMissing from './TriageMissing.svelte';
  import { S, closeDrawer, openDrawer, req } from '../lib/core/app.svelte.ts';
  import { readiness } from '../lib/project/backlog.ts';
  import { ticker } from '../lib/core/clock.svelte.ts';
  import { DEFAULT_DRAWER_TAB } from '../lib/jobs/drawer.ts';
  import { canStart, issueJobs, issuePanel, refLabel } from '../lib/project/issue-view.ts';
  import { STAGE_LABEL } from '../lib/core/labels.ts';
  import { t } from '../lib/text/locale.ts';
  import { md, safeUrl } from '../lib/text/markdown.ts';
  import { ago, usd } from '../lib/core/util.ts';

  /** The shell's: the issue title takes focus through it on open. */
  let { focusTitle }: { focusTitle: Attachment<HTMLElement> } = $props();

  // Closed, the panel keeps its last ref, so it slides out with its content.
  const ref = $derived(S.drawer.issue ?? S.issueView?.ref ?? null);
  const item = $derived(ref === null ? undefined : S.backlog?.items?.find((i) => i.ref === ref));
  const loaded = $derived(S.issueView && S.issueView.ref === ref ? S.issueView : null);
  const view = $derived(loaded?.data?.view ?? null);
  const error = $derived(loaded?.error ?? loaded?.data?.error ?? null);
  const loading = $derived(!loaded || (!loaded.data && !loaded.error));
  const title = $derived(item?.title || view?.title || (ref ? refLabel(ref) : ''));
  const github = $derived(S.data?.config?.tracker === 'github');
  const url = $derived(safeUrl(item?.url ?? view?.url));
  const related = $derived(ref === null ? [] : issueJobs(S.data?.jobs ?? [], S.data?.config?.tracker ?? '', { ref, url: item?.url ?? view?.url ?? null }));
  const forge = $derived(issuePanel({ claimedBy: item?.claimedBy ?? null }, related));
  const ready = $derived(item ? readiness(item) : 'untriaged');
  const startable = $derived(item ? canStart(item, forge.held) : false);
  const labels = $derived(item?.labels?.length ? item.labels : (view?.labels ?? []));
  const assignees = $derived(item?.assignees?.length ? item.assignees : (view?.assignees ?? []));
  // Not `state`: that name would read `$state` as a store.
  const issueState = $derived(view?.state ?? null);

  /** A job's panel, with Back to this issue. */
  const openJob = (id: string): void => void openDrawer(id, null, DEFAULT_DRAWER_TAB, ref);
  /** The row's Start: the next /api/state poll that shows a job naming the ref turns the section into its card. */
  const start = (): void => {
    if (ref !== null) void req({ type: 'run', ref });
  };

  // Another issue starts at the top; a 2 s poll keeps the ref, so it never moves the scroll.
  let scroller = $state<HTMLDivElement>();
  $effect(() => {
    void ref;
    untrack(() => {
      if (scroller) scroller.scrollTop = 0;
    });
  });
</script>

{#snippet fact(k: string, v: string)}
  <div><div class="label">{k}</div><div class="mono text-[13px] break-all selectable">{v}</div></div>
{/snippet}

{#if ref !== null}
  <div class="shrink-0 p-5 md:p-6 pb-3 md:pb-4 flex flex-col gap-2 border-b border-line">
    <div class="flex items-start justify-between gap-3"><h2 {@attach focusTitle} tabindex="-1" class="h sheet-title min-w-0 break-words">{title}</h2><CloseButton size="sm" label={$t('drawer.close')} onclick={closeDrawer} /></div>
    <!-- One wrapping row: the ref, the issue's state, its readiness and its labels. -->
    <div class="flex min-w-0 flex-wrap items-center gap-1.5">
      {#if url}<a class="mono text-[13px] text-gleam hover:underline mr-1" href={url} target="_blank" rel="noopener">{#if github}<Icon name="github" class="sm mr-1 inline-block align-[-2px]" />{/if}{refLabel(ref)}</a>{:else}<span class="mono text-[13px] muted mr-1 break-all">{refLabel(ref)}</span>{/if}
      {#if issueState === 'open'}<Chip tone="ok" text={$t('issues.view.state.open')} />{:else if issueState === 'closed'}<Chip tone="muted" text={$t('issues.view.state.closed')} />{:else if issueState && issueState !== item?.status}<Chip tone="muted" text={issueState} />{/if}
      {#if ready === 'needs-info'}<Chip tone="warn" text={$t('issues.needsInfo')} />{:else if ready === 'ready'}<Chip tone="ok" text={$t('issues.ready')} />{/if}
      {#each labels as l, k (k)}<Chip tone="muted" text={l} />{/each}
    </div>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable from the keyboard) -->
  <div bind:this={scroller} role="region" aria-label={title} tabindex="0" class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 md:p-6 flex flex-col gap-5 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-line-strong focus-visible:-outline-offset-2">
    <section class="plate p-4 flex flex-col gap-3">
      <h3 class="label">{$t('issues.view.forge')}</h3>
      {#if forge.held}
        {@const held = forge.held}
        <JobCard job={held} onopen={() => openJob(held.id)} />
        <div class="flex flex-wrap items-center justify-between gap-2"><span class="caption muted num">{$t('issues.view.costSoFar', { cost: usd(held.usage?.estCostUsd) })}</span><button class="btn sm" onclick={() => openJob(held.id)}>{$t('issues.view.openJob')}</button></div>
      {:else if forge.elsewhere}
        <p class="text-sm">{$t('issues.view.elsewhere', { by: forge.elsewhere })}</p>
      {:else if startable}
        <div class="flex flex-wrap items-center gap-3">
          <button class="btn primary" onclick={start}>{$t('issues.start')}</button>
          {#if ready === 'needs-info'}<span class="caption muted">{$t('issues.view.override')}</span>{/if}
        </div>
        {#if ready === 'needs-info' && item?.triage?.missing?.length}<TriageMissing missing={item.triage.missing} />{/if}
      {:else}
        <p class="text-sm muted">{item?.status ?? '—'}</p>
      {/if}
      {#if forge.earlier.length}
        <div class="flex flex-col gap-1">
          <h4 class="label">{$t('issues.view.earlier')}</h4>
          <ul class="flex flex-col">
            {#each forge.earlier as j (j.id)}
              <li class="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 border-b border-line last:border-b-0"><button class="min-w-0 text-left text-sm break-words hover:text-gleam" onclick={() => openJob(j.id)}>{j.title}</button><StateChip job={j} /><span class="label">{STAGE_LABEL[j.stage] ?? j.stage}</span><PrChip pr={j.pr} /></li>
            {/each}
          </ul>
        </div>
      {/if}
    </section>
    {#if loading}
      <section class="flex flex-col gap-2"><h3 class="label">{$t('issues.view.description')}</h3><Skeleton w="92%" /><Skeleton w="80%" /><Skeleton w="64%" /></section>
      <section class="flex flex-col gap-2"><h3 class="label">{$t('issues.view.comments')}</h3><Skeleton w="70%" /><Skeleton w="55%" /></section>
    {:else if error}
      <Banner msg={error} />
    {:else if !view}
      <p class="text-sm muted">{$t('issues.view.noView')}</p>
    {:else}
      <section class="flex flex-col gap-2">
        <h3 class="label">{$t('issues.view.description')}</h3>
        {#if view.body.trim()}<div class="prose">{@html md(view.body)}</div>{:else}<p class="text-sm muted">{$t('issues.view.noBody')}</p>{/if}
      </section>
      <section class="flex flex-col gap-2">
        <h3 class="label">{$t('issues.view.comments')}</h3>
        {#each view.comments as c, n (n)}
          <article class="flex flex-col gap-1 border-b border-line pb-3 last:border-b-0"><div class="caption"><b class="mono">{c.author ?? '—'}</b> <span class="muted">{ago(c.at, ticker.now)}</span></div><div class="prose">{@html md(c.body)}</div></article>
        {:else}
          <p class="text-sm muted">{$t('issues.view.noComments')}</p>
        {/each}
        {#if view.hiddenComments > 0}<p class="caption muted">{$t('issues.view.hiddenComments', { count: view.hiddenComments })}</p>{/if}
      </section>
    {/if}
    <section class="flex flex-col gap-2">
      <h3 class="label">{$t('issues.view.details')}</h3>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        {@render fact($t('issues.status'), item?.status ?? '—')}{@render fact($t('issues.priority'), item?.priority ?? '—')}{@render fact($t('issues.view.assignees'), assignees.join(', ') || '—')}
        {@render fact($t('issues.view.milestone'), view?.milestone ?? '—')}{@render fact($t('issues.view.author'), view?.author ?? '—')}{@render fact($t('issues.view.created'), ago(view?.createdAt, ticker.now))}
        {@render fact($t('issues.view.updated'), ago(view?.updatedAt, ticker.now))}{@render fact($t('issues.view.triaged'), item?.triage?.at ? ago(item.triage.at, ticker.now) : $t('issues.view.never'))}
      </div>
    </section>
  </div>
{/if}
