<!-- The Needs-you popover's body (the page it replaced): every pending permission prompt in the pool, answered right here,
     then decisions only a human can make (goal mandates' milestone drafts first, then jobs), PRs awaiting review, jobs
     parked on their dependencies (listed apart: they resume by themselves, but a human may unblock one), and queued
     requests (a job-less one names its mandate when it has one).
     Opening a job opens its pane, and StatusBar closes the popover. Titles, reasons and request text are untrusted and
     render as text; the PR link goes through safeUrl. -->
<script lang="ts">
  import DepChips from '../DepChips.svelte';
  import Icon from '../Icon.svelte';
  import InboxCard from '../InboxCard.svelte';
  import JobActions from '../JobActions.svelte';
  import PermissionPrompts from '../PermissionPrompts.svelte';
  import PrChip from '../PrChip.svelte';
  import RepoBudgetSection from '../RepoBudgetSection.svelte';
  import { showRepoSection } from '../../lib/repo-budget.ts';
  import { safeUrl } from '../../lib/markdown.ts';
  import { ago } from '../../lib/util.ts';
  import type { ApiState } from '../../lib/types.ts';
  import { cardRef } from '../../lib/board.ts';
  import { inboxGroups, requestSubject } from '../../lib/inbox.ts';
  import MilestoneDraftCard from '../MilestoneDraftCard.svelte';
  import { pendingPrompts } from '../../lib/permissions.ts';
  import { S, openDrawer, req } from '../../lib/app.svelte.ts';
  import { ticker } from '../../lib/clock.svelte.ts';
  import { keepFocus } from '../../lib/popover.svelte.ts';
  import { t } from '../../lib/locale.ts';

  let { data }: { data: ApiState } = $props();
  const groups = $derived(inboxGroups(data.jobs));
  const reqs = $derived(data.requests ?? []);
  // An older server sends no drafts.
  const drafts = $derived(data.drafts ?? []);
  // The same source PermissionPrompts reads, so the section renders exactly when it lists something.
  const prompts = $derived(pendingPrompts(S.data?.daemons ?? null).length);
  // An answered prompt or a decided milestone draft unmounts with its buttons: focus back on the popover, not the body.
  $effect(() => {
    void prompts;
    void drafts.length;
    keepFocus();
  });
</script>

<!-- plain: the popover's own surface, so the panel keeps its text off the grain wherever it renders. -->
<div class="plain flex flex-col gap-5">
  {#if prompts}<PermissionPrompts />{/if}
  {#if showRepoSection(data.budget)}<RepoBudgetSection {data} />{/if}
  <section class="flex flex-col gap-3" aria-labelledby="needs-urgent">
    <h3 id="needs-urgent" class="label">{$t('needs.urgent')}</h3>
    {#if groups.urgent.length || drafts.length}
      {#each drafts as d (d.mandate)}<MilestoneDraftCard gate={d} />{/each}
      {#each groups.urgent as j (j.id)}<InboxCard job={j} />{/each}
    {:else if prompts}
      <p class="text-sm text-muted">{$t('needs.noDecisions')}</p>
    {:else}
      <p class="text-sm text-muted">{$t('needs.empty')}</p>
    {/if}
  </section>
  {#if groups.prs.length}
    <section class="flex flex-col gap-2" aria-labelledby="needs-prs">
      <h3 id="needs-prs" class="label">{$t('inbox.prs')}</h3>
      <ul class="plate flat needs-list">
        {#each groups.prs as j (j.id)}
          {@const u = safeUrl(j.pr?.url)}
          <li class="needs-row">
            <button class="h card block w-full text-left break-words hover:text-gleam" onclick={() => openDrawer(j.id)}>{j.title}</button>
            <div class="flex flex-wrap items-center gap-2">
              <PrChip pr={j.pr} />
              <span class="text-muted">{j.pr?.unresolvedThreads ? $t('inbox.threads', { count: j.pr.unresolvedThreads }) : $t('inbox.noThreads')}{j.pr?.behindBy ? $t('inbox.behind', { count: j.pr.behindBy }) : ''}</span>
              {#if u}<a class="btn sm" href={u} target="_blank" rel="noopener"><Icon name="pull-request" />{$t('inbox.openPr')}</a>{/if}
              <button class="btn sm" onclick={() => req({ type: 'rework', job: j.id, fixedText: 'Address the PR feedback' })}>{$t('inbox.addressFeedback')}</button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if groups.parks.length}
    <section class="flex flex-col gap-2" aria-labelledby="needs-parks">
      <h3 id="needs-parks" class="label">{$t('inbox.parks')}</h3>
      <ul class="plate flat needs-list">
        {#each groups.parks as j (j.id)}
          {@const ref = cardRef(j) ?? j.id}
          <li class="needs-row">
            <div class="min-w-0">
              <button class="h card block w-full text-left break-words hover:text-gleam" onclick={() => openDrawer(j.id)}>{j.title}</button>
              <div class="mono muted text-[11px] truncate" title={ref}>{ref}</div>
            </div>
            <DepChips job={j} />
            <div class="flex flex-wrap items-center gap-2"><JobActions job={j} noteId="park-{j.id}" /></div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if reqs.length}
    <section class="flex flex-col gap-2" aria-labelledby="needs-queued">
      <h3 id="needs-queued" class="label">{$t('inbox.queued')}</h3>
      <ul class="plate flat needs-list">
        {#each reqs as r (r.id)}
          {@const subject = requestSubject(r)}
          <li class="needs-row gap-1">
            <div class="flex min-w-0 flex-wrap items-baseline gap-x-2"><span class="font-mono text-xs">{r.type}</span>{#if subject && 'job' in subject}<span class="min-w-0 truncate" title={subject.job}>{subject.job}</span>{:else if subject}<span class="min-w-0 truncate" title={subject.mandate}>{$t('inbox.mandate', { id: subject.mandate })}</span>{/if}</div>
            {#if r.text}<p class="text-muted break-words">{r.text}</p>{/if}
            <p class="text-muted text-xs">{r.status === 'in-progress' ? $t('inbox.handling', { session: String(r.session ?? '').slice(0, 8) }) : $t('inbox.queuedStatus')} · {ago(r.createdAt, ticker.now)}</p>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>
